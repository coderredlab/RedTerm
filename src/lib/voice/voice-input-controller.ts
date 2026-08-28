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
  onChange(listener: () => void): () => void;
  open(): Promise<void>;
  send(): Promise<void>;
  cancel(): Promise<void>;
  rotateLanguage(): Promise<void>;
  handleVoiceEvent(event: VoiceInputEvent): void;
}

const encoder = new TextEncoder();
const DEFAULT_LANGUAGE: VoiceInputLanguage = { tag: "", label: "Default language" };

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

  function notify() {
    listeners.forEach((listener) => listener());
  }

  async function cleanup(kind: "stop" | "cancel") {
    if (kind === "stop") {
      await deps.bridge.stop().catch(() => undefined);
    } else {
      await deps.bridge.cancel().catch(() => undefined);
    }
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  async function surfaceVoiceError(error: unknown) {
    await cleanup("cancel");
    state.status = "error";
    state.partialTranscript = "";
    state.errorMessage = voiceErrorMessage(error);
    notify();
  }

  async function ensurePermission(): Promise<boolean> {
    const current = await deps.bridge.checkPermissions();
    if (current.microphone === "granted") return true;

    const requested = await deps.bridge.requestPermissions();
    if (requested.microphone === "granted") return true;

    state.status = "error";
    state.errorMessage = "Microphone permission is required";
    notify();
    return false;
  }

  async function startCurrentLanguage() {
    const language = currentLanguage(state) ?? DEFAULT_LANGUAGE;
    state.status = "listening";
    notify();
    try {
      await deps.bridge.start(language.tag);
    } catch (error) {
      await surfaceVoiceError(error);
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

    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open() {
      sendCompleted = false;
      state.open = true;
      state.status = "preparing";
      state.transcript = "";
      state.partialTranscript = "";
      state.errorMessage = null;
      notify();

      try {
        unlisten?.();
        unlisten = null;
        unlisten = await deps.bridge.listen((event) => controller.handleVoiceEvent(event));

        if (!(await ensurePermission())) {
          await cleanup("cancel");
          return;
        }

        const languages = await deps.bridge.listLanguages();
        state.languages = languages.length > 0 ? languages : [DEFAULT_LANGUAGE];
        state.activeLanguageIndex = 0;
        notify();
        await startCurrentLanguage();
      } catch (error) {
        await surfaceVoiceError(error);
      }
    },

    async send() {
      if (sendCompleted) return;
      const sessionId = deps.getActiveSessionId();
      const text = visibleText(state);
      if (!sessionId) {
        state.status = "error";
        state.errorMessage = "No active SSH session";
        notify();
        return;
      }
      if (!text) return;

      sendCompleted = true;
      await deps.writeSsh(sessionId, encoder.encode(text));
      await cleanup("stop");
      state.open = false;
      state.status = "idle";
      notify();
    },

    async cancel() {
      await cleanup("cancel");
      state.open = false;
      state.status = "idle";
      state.transcript = "";
      state.partialTranscript = "";
      state.errorMessage = null;
      notify();
    },

    async rotateLanguage() {
      if (state.languages.length <= 1) return;
      await deps.bridge.cancel().catch(() => undefined);
      state.partialTranscript = "";
      state.activeLanguageIndex = (state.activeLanguageIndex + 1) % state.languages.length;
      notify();
      await startCurrentLanguage();
    },

    handleVoiceEvent(event: VoiceInputEvent) {
      if (event.kind === "started") {
        state.status = "listening";
        state.errorMessage = null;
        notify();
        return;
      }
      if (event.kind === "partial") {
        state.status = "partial";
        state.partialTranscript = event.transcript ?? "";
        notify();
        return;
      }
      if (event.kind === "final") {
        state.status = "final";
        state.transcript += event.transcript ?? state.partialTranscript;
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
