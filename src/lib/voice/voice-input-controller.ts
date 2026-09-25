export const VOICE_INPUT_EVENT = "redterm:voice-input";

export type VoiceInputStatus = "idle" | "preparing" | "listening" | "partial" | "final" | "error";

export type VoicePermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale";

export interface VoiceInputLanguage {
  tag: string;
  label: string;
}

export interface VoiceInputEvent {
  kind: "partial" | "final" | "error" | "started" | "ended";
  transcript?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface VoiceInputState {
  open: boolean;
  status: VoiceInputStatus;
  languages: VoiceInputLanguage[];
  activeLanguageIndex: number;
  transcript: string;
  partialTranscript: string;
  errorMessage: string | null;
}

export interface VoiceInputBridge {
  checkPermissions(): Promise<{ microphone?: VoicePermissionState }>;
  requestPermissions(): Promise<{ microphone?: VoicePermissionState }>;
  listLanguages(): Promise<VoiceInputLanguage[]>;
  start(languageTag: string): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  listen(callback: (event: VoiceInputEvent) => void): Promise<() => void>;
}

export interface VoiceInputControllerDeps {
  getActiveSessionId(): string | null | undefined;
  writeSsh(sessionId: string, data: Uint8Array): Promise<void>;
  bridge: VoiceInputBridge;
}

export interface VoiceInputController {
  readonly state: VoiceInputState;
  readonly displayText: string;
  readonly activeLanguage: VoiceInputLanguage | null;
  readonly canSend: boolean;
  readonly canRotateLanguage: boolean;
  onChange(listener: () => void): () => void;
  open(): Promise<void>;
  send(): Promise<void>;
  cancel(): Promise<void>;
  rotateLanguage(): Promise<void>;
  handleVoiceEvent(event: VoiceInputEvent): void;
}

const encoder = new TextEncoder();
const DEFAULT_LANGUAGE: VoiceInputLanguage = { tag: "", label: "Default language" };
const PTY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function safeVoiceText(text: string): string {
  return text.replace(PTY_CONTROL_CHARACTERS, " ");
}

function createInitialState(): VoiceInputState {
  return {
    open: false,
    status: "idle",
    languages: [],
    activeLanguageIndex: 0,
    transcript: "",
    partialTranscript: "",
    errorMessage: null,
  };
}

function currentLanguage(state: VoiceInputState): VoiceInputLanguage | null {
  return state.languages[state.activeLanguageIndex] ?? null;
}

function visibleText(state: VoiceInputState): string {
  return `${state.transcript}${state.partialTranscript}`;
}

function voiceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unable to start voice recognition";
}

export function createVoiceInputController(deps: VoiceInputControllerDeps): VoiceInputController {
  const state = createInitialState();
  const listeners = new Set<() => void>();
  let unlisten: (() => void) | null = null;
  let sendCompleted = false;
  let generation = 0;
  let listenerGeneration = 0;
  let nativeOperation: Promise<void> = Promise.resolve();

  function isCurrent(epoch: number): boolean {
    return generation === epoch && state.open;
  }

  function runNative(action: () => Promise<void>): Promise<void> {
    const running = nativeOperation.then(action);
    nativeOperation = running.catch(() => undefined);
    return running;
  }
  function notify() {
    listeners.forEach((listener) => listener());
  }

  async function cleanup(kind: "stop" | "cancel") {
    ++listenerGeneration;
    const listener = unlisten;
    unlisten = null;
    await runNative(async () => {
      if (kind === "stop") {
        await deps.bridge.stop().catch(() => undefined);
      } else {
        await deps.bridge.cancel().catch(() => undefined);
      }
    });
    listener?.();
  }

  async function surfaceVoiceError(error: unknown, epoch: number) {
    await cleanup("cancel");
    if (!isCurrent(epoch)) return;
    state.status = "error";
    state.partialTranscript = "";
    state.errorMessage = voiceErrorMessage(error);
    notify();
  }

  async function ensurePermission(epoch: number): Promise<boolean> {
    const current = await deps.bridge.checkPermissions();
    if (!isCurrent(epoch)) return false;
    if (current.microphone === "granted") return true;

    const requested = await deps.bridge.requestPermissions();
    if (!isCurrent(epoch)) return false;
    if (requested.microphone === "granted") return true;

    state.status = "error";
    state.errorMessage = "Microphone permission is required";
    notify();
    return false;
  }

  async function startCurrentLanguage(epoch: number) {
    if (!isCurrent(epoch)) return;
    const language = currentLanguage(state) ?? DEFAULT_LANGUAGE;
    state.status = "listening";
    notify();
    try {
      await runNative(async () => {
        if (isCurrent(epoch)) await deps.bridge.start(language.tag);
      });
    } catch (error) {
      if (isCurrent(epoch)) await surfaceVoiceError(error, epoch);
    }
  }

  const controller: VoiceInputController = {
    get state() {
      return state;
    },
    get displayText() {
      return visibleText(state);
    },
    get activeLanguage() {
      return currentLanguage(state);
    },
    get canSend() {
      return state.open && visibleText(state).length > 0 && Boolean(deps.getActiveSessionId());
    },
    get canRotateLanguage() {
      return state.open && state.status !== "preparing" && unlisten !== null
        && !sendCompleted && state.languages.length > 1;
    },

    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open() {
      if (state.open) return;
      const epoch = ++generation;
      const listenerEpoch = ++listenerGeneration;
      sendCompleted = false;
      state.open = true;
      state.status = "preparing";
      state.languages = [];
      state.activeLanguageIndex = 0;
      state.transcript = "";
      state.partialTranscript = "";
      state.errorMessage = null;
      notify();

      try {
        const listener = await deps.bridge.listen((event) => {
          if (listenerGeneration === listenerEpoch && state.open) controller.handleVoiceEvent(event);
        });
        if (!isCurrent(epoch)) {
          listener();
          return;
        }
        unlisten = listener;

        if (!(await ensurePermission(epoch))) {
          if (isCurrent(epoch)) await cleanup("cancel");
          return;
        }

        const languages = await deps.bridge.listLanguages();
        if (!isCurrent(epoch)) return;
        state.languages = languages.length > 0 ? languages : [DEFAULT_LANGUAGE];
        state.activeLanguageIndex = 0;
        notify();
        await startCurrentLanguage(epoch);
      } catch (error) {
        if (isCurrent(epoch)) await surfaceVoiceError(error, epoch);
      }
    },

    async send() {
      if (!state.open || sendCompleted) return;
      const epoch = generation;
      const sessionId = deps.getActiveSessionId();
      const text = visibleText(state);
      if (!sessionId) {
        state.status = "error";
        state.errorMessage = "No active SSH session";
        notify();
        return;
      }
      if (!text) return;
      if (text !== safeVoiceText(text)) {
        state.status = "error";
        state.errorMessage = "Voice text contains unsupported control characters";
        notify();
        return;
      }

      sendCompleted = true;
      try {
        await deps.writeSsh(sessionId, encoder.encode(text));
      } catch (error) {
        if (isCurrent(epoch)) {
          sendCompleted = false;
          state.status = "error";
          state.errorMessage = `Unable to send voice text: ${voiceErrorMessage(error)}`;
        }
        return;
      } finally {
        if (isCurrent(epoch)) {
          await cleanup("stop");
          notify();
        }
      }
      if (!isCurrent(epoch)) return;
      ++generation;
      state.open = false;
      state.status = "idle";
      notify();
    },

    async cancel() {
      ++generation;
      state.open = false;
      state.status = "idle";
      state.transcript = "";
      state.partialTranscript = "";
      state.errorMessage = null;
      notify();
      await cleanup("cancel");
    },

    async rotateLanguage() {
      if (!controller.canRotateLanguage) return;
      const epoch = ++generation;
      await runNative(() => deps.bridge.cancel().catch(() => undefined));
      if (!isCurrent(epoch)) return;
      state.partialTranscript = "";
      state.activeLanguageIndex = (state.activeLanguageIndex + 1) % state.languages.length;
      notify();
      await startCurrentLanguage(epoch);
    },

    handleVoiceEvent(event: VoiceInputEvent) {
      if (!state.open) return;
      if (event.kind === "started") {
        state.status = "listening";
        state.errorMessage = null;
        notify();
        return;
      }
      if (event.kind === "partial") {
        state.status = "partial";
        state.partialTranscript = safeVoiceText(event.transcript ?? "");
        notify();
        return;
      }
      if (event.kind === "final") {
        state.status = "final";
        state.transcript += safeVoiceText(event.transcript ?? state.partialTranscript);
        state.partialTranscript = "";
        notify();
        return;
      }
      if (event.kind === "ended") {
        if (state.status !== "final" && state.status !== "partial") {
          state.status = "idle";
        }
        notify();
        return;
      }
      if (event.kind === "error") {
        state.status = "error";
        state.partialTranscript = "";
        state.errorMessage = event.errorMessage ?? "Voice recognition error";
        notify();
      }
    },
  };

  return controller;
}
