// @ts-nocheck
import { beforeEach, describe, expect, test } from "bun:test";

import { createVoiceInputController, type VoiceInputEvent } from "./voice-input-controller";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("voice input popup contract", () => {
  let writes: Array<{ sessionId: string; text: string }>;
  let bridgeCalls: string[];
  let voiceEvent: ((event: VoiceInputEvent) => void) | undefined;

  function makeController(
    activeSessionId: string | null = "session-1",
    sendFailure: () => boolean = () => false,
  ) {
    writes = [];
    bridgeCalls = [];
    voiceEvent = undefined;

    return createVoiceInputController({
      getActiveSessionId: () => activeSessionId,
      writeSsh: async (sessionId: string, data: Uint8Array) => {
        if (sendFailure()) throw new Error("SSH session closed");
        writes.push({ sessionId, text: decode(data) });
      },
      bridge: {
        checkPermissions: async () => ({ microphone: "granted" }),
        requestPermissions: async () => ({ microphone: "granted" }),
        listLanguages: async () => [
          { tag: "ko-KR", label: "Korean" },
          { tag: "en-US", label: "English" },
        ],
        start: async (tag: string) => bridgeCalls.push(`start:${tag}`),
        stop: async () => bridgeCalls.push("stop"),
        cancel: async () => bridgeCalls.push("cancel"),
        listen: async (callback) => {
          voiceEvent = callback;
          return () => bridgeCalls.push("unlisten");
        },
      },
    });
  }

  beforeEach(() => {
    writes = [];
    bridgeCalls = [];
    voiceEvent = undefined;
  });

  test("partial/final events update popup text but do not write SSH before send", async () => {
    const controller = makeController();

    await controller.open();
    voiceEvent?.({ kind: "partial", transcript: "hello" });
    expect(controller.displayText).toBe("hello");
    expect(writes).toEqual([]);

    voiceEvent?.({ kind: "final", transcript: "hello there" });
    expect(controller.displayText).toBe("hello there");
    expect(writes).toEqual([]);
  });

  test("onChange notifies voice-event state changes until unsubscribe", async () => {
    const controller = makeController();
    let calls = 0;

    await controller.open();
    const unsubscribe = controller.onChange(() => {
      calls += 1;
    });

    voiceEvent?.({ kind: "partial", transcript: "hello" });
    expect(controller.displayText).toBe("hello");
    expect(calls).toBe(1);

    unsubscribe();
    voiceEvent?.({ kind: "final", transcript: "hello there" });
    expect(controller.displayText).toBe("hello there");
    expect(calls).toBe(1);
  });

  test("send writes visible text exactly once and closes", async () => {
    const controller = makeController();

    await controller.open();
    voiceEvent?.({ kind: "final", transcript: "ls -la" });
    await controller.send();
    await controller.send();

    expect(writes).toEqual([{ sessionId: "session-1", text: "ls -la" }]);
    expect(bridgeCalls).toContain("stop");
    expect(bridgeCalls).toContain("unlisten");
    expect(controller.state.open).toBe(false);
  });

  test("rejected SSH voice send stops capture, keeps text, and permits a later retry", async () => {
    let disconnected = true;
    const controller = makeController("session-1", () => disconnected);
    await controller.open();
    voiceEvent?.({ kind: "final", transcript: "dictated command" });

    await controller.send();
    expect(bridgeCalls).toEqual(["start:ko-KR", "stop", "unlisten"]);
    expect(controller.state.open).toBe(true);
    expect(controller.state.status).toBe("error");
    expect(controller.state.errorMessage).toBe("Unable to send voice text: SSH session closed");
    expect(controller.displayText).toBe("dictated command");
    expect(writes).toEqual([]);
    expect(controller.canRotateLanguage).toBe(false);
    await controller.rotateLanguage();
    expect(bridgeCalls).toEqual(["start:ko-KR", "stop", "unlisten"]);
    expect(controller.displayText).toBe("dictated command");

    disconnected = false;
    await controller.send();
    expect(writes).toEqual([{ sessionId: "session-1", text: "dictated command" }]);
    expect(controller.state.open).toBe(false);
  });

  test("cancel discards recognized text without writing SSH", async () => {
    const controller = makeController();

    await controller.open();
    voiceEvent?.({ kind: "final", transcript: "rm -rf /tmp/nope" });
    await controller.cancel();

    expect(writes).toEqual([]);
    expect(bridgeCalls).toContain("cancel");
    expect(bridgeCalls).toContain("unlisten");
    expect(controller.state.open).toBe(false);
    expect(controller.state.transcript).toBe("");
    expect(controller.state.partialTranscript).toBe("");
  });

  test("language rotation cancels current recognizer, drops partial, preserves final text, and restarts", async () => {
    const controller = makeController();

    await controller.open();
    voiceEvent?.({ kind: "final", transcript: "hello " });
    voiceEvent?.({ kind: "partial", transcript: "wor" });

    await controller.rotateLanguage();

    expect(controller.state.activeLanguageIndex).toBe(1);
    expect(controller.state.languages[controller.state.activeLanguageIndex].tag).toBe("en-US");
    expect(controller.state.transcript).toBe("hello ");
    expect(controller.state.partialTranscript).toBe("");
    expect(bridgeCalls).toEqual(["start:ko-KR", "cancel", "start:en-US"]);
    voiceEvent?.({ kind: "final", transcript: "again" });
    expect(controller.displayText).toBe("hello again");
  });

  test("native start failure surfaces in popup instead of staying listening", async () => {
    const calls: string[] = [];
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        checkPermissions: async () => ({ microphone: "granted" }),
        requestPermissions: async () => ({ microphone: "granted" }),
        listLanguages: async () => [{ tag: "ko-KR", label: "Korean" }],
        start: async () => {
          calls.push("start");
          throw new Error("Voice recognition is not available on this device");
        },
        stop: async () => calls.push("stop"),
        cancel: async () => calls.push("cancel"),
        listen: async () => {
          calls.push("listen");
          return () => calls.push("unlisten");
        },
      },
    });

    await controller.open();

    expect(controller.state.open).toBe(true);
    expect(controller.state.status).toBe("error");
    expect(controller.state.errorMessage).toBe("Voice recognition is not available on this device");
    expect(calls).toEqual(["listen", "start", "cancel", "unlisten"]);
  });

  test("permission denial surfaces the English microphone requirement copy", async () => {
    const calls: string[] = [];
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        checkPermissions: async () => ({ microphone: "denied" }),
        requestPermissions: async () => ({ microphone: "denied" }),
        listLanguages: async () => [{ tag: "ko-KR", label: "Korean" }],
        start: async () => calls.push("start"),
        stop: async () => calls.push("stop"),
        cancel: async () => calls.push("cancel"),
        listen: async () => {
          calls.push("listen");
          return () => calls.push("unlisten");
        },
      },
    });

    await controller.open();

    expect(controller.state.status).toBe("error");
    expect(controller.state.errorMessage).toBe("Microphone permission is required");
    expect(calls).toEqual(["listen", "cancel", "unlisten"]);
  });

  test("unknown native start failure surfaces the English start fallback copy", async () => {
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        checkPermissions: async () => ({ microphone: "granted" }),
        requestPermissions: async () => ({ microphone: "granted" }),
        listLanguages: async () => [{ tag: "ko-KR", label: "Korean" }],
        start: async () => {
          throw {};
        },
        stop: async () => undefined,
        cancel: async () => undefined,
        listen: async () => () => undefined,
      },
    });

    await controller.open();

    expect(controller.state.status).toBe("error");
    expect(controller.state.errorMessage).toBe("Unable to start voice recognition");
  });

  test("empty native language list uses the English default language label", async () => {
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        checkPermissions: async () => ({ microphone: "granted" }),
        requestPermissions: async () => ({ microphone: "granted" }),
        listLanguages: async () => [],
        start: async () => undefined,
        stop: async () => undefined,
        cancel: async () => undefined,
        listen: async () => () => undefined,
      },
    });

    await controller.open();

    expect(controller.activeLanguage).toEqual({ tag: "", label: "Default language" });
  });

  test("voice error event without native message surfaces the English event fallback copy", async () => {
    const controller = makeController();

    await controller.open();
    voiceEvent?.({ kind: "error" });

    expect(controller.state.status).toBe("error");
    expect(controller.state.errorMessage).toBe("Voice recognition error");
  });

  test("send is disabled when there is no active session", async () => {
    const controller = makeController(null);

    await controller.open();
    voiceEvent?.({ kind: "final", transcript: "pwd" });
    await controller.send();

    expect(writes).toEqual([]);
    expect(controller.state.open).toBe(true);
    expect(controller.state.errorMessage).toBe("No active SSH session");
  });
  test("recognition controls become visible spaces before preview and the SSH write", async () => {
    const controller = makeController();
    await controller.open();
    voiceEvent?.({ kind: "partial", transcript: "pwd\r\n\u001b[31m\u009b" });
    expect(controller.displayText).toBe("pwd   [31m ");
    expect(writes).toEqual([]);

    voiceEvent?.({ kind: "final", transcript: "echo hello\nworld\u2028" });
    expect(controller.displayText).toBe("echo hello world ");
    await controller.send();
    expect(writes).toEqual([{ sessionId: "session-1", text: "echo hello world " }]);
  });

  test("send rejects control characters injected into visible state instead of sending hidden PTY input", async () => {
    const controller = makeController();
    await controller.open();
    controller.state.transcript = "pwd\rnext";
    await controller.send();
    expect(writes).toEqual([]);
    expect(controller.state.errorMessage).toBe("Voice text contains unsupported control characters");
  });

  test("Cancel during permission check prevents a late microphone start", async () => {
    const entered = deferred<void>();
    const permission = deferred<{ microphone: string }>();
    const calls: string[] = [];
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        listen: async () => () => calls.push("unlisten"),
        checkPermissions: () => { entered.resolve(); return permission.promise; },
        requestPermissions: async () => ({ microphone: "granted" }),
        listLanguages: async () => [{ tag: "en-US", label: "English" }],
        start: async () => calls.push("start"),
        stop: async () => calls.push("stop"),
        cancel: async () => calls.push("cancel"),
      },
    });

    const observed: string[] = [];
    controller.onChange(() => observed.push(controller.state.status));
    const opening = controller.open();
    await entered.promise;
    expect(observed).toEqual(["preparing"]);
    await controller.cancel();
    permission.resolve({ microphone: "granted" });
    await opening;
    expect(controller.state.open).toBe(false);
    expect(controller.state.status).toBe("idle");
    expect(calls).toEqual(["cancel", "unlisten"]);
  });

  test("reopen cannot rotate into a stale language before permission is granted", async () => {
    const waitingForPermission = deferred<void>();
    const permission = deferred<{ microphone: string }>();
    const calls: string[] = [];
    let checks = 0;
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        listen: async () => () => calls.push("unlisten"),
        checkPermissions: () => {
          if (++checks === 1) return Promise.resolve({ microphone: "granted" });
          waitingForPermission.resolve();
          return permission.promise;
        },
        requestPermissions: async () => ({ microphone: "denied" }),
        listLanguages: async () => [
          { tag: "en-US", label: "English" },
          { tag: "ko-KR", label: "Korean" },
        ],
        start: async (tag) => calls.push("start:" + tag),
        stop: async () => calls.push("stop"),
        cancel: async () => calls.push("cancel"),
      },
    });

    await controller.open();
    expect(controller.canRotateLanguage).toBe(true);
    await controller.cancel();
    const reopened = controller.open();
    await waitingForPermission.promise;
    expect(controller.state.languages).toEqual([]);
    expect(controller.canRotateLanguage).toBe(false);
    await controller.rotateLanguage();
    permission.resolve({ microphone: "denied" });
    await reopened;
    expect(calls.filter((call) => call.startsWith("start:"))).toEqual(["start:en-US"]);
    expect(controller.state.status).toBe("error");
    expect(controller.state.errorMessage).toBe("Microphone permission is required");
  });

  test("a delayed microphone start is cancelled before a new popup starts listening", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const calls: string[] = [];
    const callbacks: Array<(event: VoiceInputEvent) => void> = [];
    let starts = 0;
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        listen: async (callback) => { callbacks.push(callback); return () => calls.push("unlisten"); },
        checkPermissions: async () => ({ microphone: "granted" }),
        requestPermissions: async () => ({ microphone: "granted" }),
        listLanguages: async () => [{ tag: "en-US", label: "English" }],
        start: async () => {
          calls.push("start");
          if (++starts === 1) { started.resolve(); await release.promise; }
        },
        stop: async () => calls.push("stop"),
        cancel: async () => calls.push("cancel"),
      },
    });

    const first = controller.open();
    await started.promise;
    const cancelling = controller.cancel();
    const reopened = controller.open();
    release.resolve();
    await Promise.all([first, cancelling, reopened]);
    expect(calls).toEqual(["start", "cancel", "unlisten", "start"]);
    callbacks[0]({ kind: "final", transcript: "stale" });
    callbacks[1]({ kind: "final", transcript: "current" });
    expect(controller.displayText).toBe("current");
    expect(controller.state.open).toBe(true);
  });

  test("Cancel during language rotation prevents the queued restart", async () => {
    const rotating = deferred<void>();
    const release = deferred<void>();
    const calls: string[] = [];
    let cancels = 0;
    const controller = createVoiceInputController({
      getActiveSessionId: () => "session-1",
      writeSsh: async () => undefined,
      bridge: {
        listen: async () => () => calls.push("unlisten"),
        checkPermissions: async () => ({ microphone: "granted" }),
        requestPermissions: async () => ({ microphone: "granted" }),
        listLanguages: async () => [
          { tag: "en-US", label: "English" },
          { tag: "ko-KR", label: "Korean" },
        ],
        start: async (tag) => calls.push("start:" + tag),
        stop: async () => calls.push("stop"),
        cancel: async () => {
          calls.push("cancel");
          if (++cancels === 1) { rotating.resolve(); await release.promise; }
        },
      },
    });

    await controller.open();
    const rotation = controller.rotateLanguage();
    await rotating.promise;
    const cancelling = controller.cancel();
    release.resolve();
    await Promise.all([rotation, cancelling]);
    expect(calls).toEqual(["start:en-US", "cancel", "cancel", "unlisten"]);
    expect(controller.state.open).toBe(false);
  });
});
