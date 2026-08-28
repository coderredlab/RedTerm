// @ts-nocheck
import { beforeEach, describe, expect, test } from "bun:test";

import { createVoiceInputController, type VoiceInputEvent } from "./voice-input-controller";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("voice input popup contract", () => {
  let writes: Array<{ sessionId: string; text: string }>;
  let bridgeCalls: string[];
  let voiceEvent: ((event: VoiceInputEvent) => void) | undefined;

  function makeController(activeSessionId: string | null = "session-1") {
    writes = [];
    bridgeCalls = [];
    voiceEvent = undefined;

    return createVoiceInputController({
      getActiveSessionId: () => activeSessionId,
      writeSsh: async (sessionId: string, data: Uint8Array) => {
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
});
