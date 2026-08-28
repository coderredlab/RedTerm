// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from "bun:test";

const invokeMock = mock(async () => undefined);
const tauriListenMock = mock(async () => () => undefined);

mock.module("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
mock.module("@tauri-apps/api/event", () => ({ listen: tauriListenMock }));

// Static import would evaluate before Bun mock.module registrations, so this test intentionally loads commands after mocks.
const commands = await import("./commands");

function installFakeWindow() {
  const target = new EventTarget();
  globalThis.window = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    CustomEvent,
  };
}

describe("voice input Tauri command wrappers", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    tauriListenMock.mockClear();
    installFakeWindow();
  });

  test("startVoiceInput passes selected languageTag to Rust command", async () => {
    await commands.startVoiceInput("ko-KR");

    expect(invokeMock).toHaveBeenCalledWith("start_voice_input", { languageTag: "ko-KR" });
  });

  test("permission wrapper returns microphone state payload", async () => {
    invokeMock.mockResolvedValueOnce({ microphone: "prompt-with-rationale" });

    await expect(commands.checkVoiceInputPermissions()).resolves.toEqual({
      microphone: "prompt-with-rationale",
    });
    expect(invokeMock).toHaveBeenCalledWith("check_voice_input_permissions");
  });

  test("requestVoiceInputPermissions returns microphone state payload from Rust command", async () => {
    invokeMock.mockResolvedValueOnce({ microphone: "granted" });

    await expect(commands.requestVoiceInputPermissions()).resolves.toEqual({ microphone: "granted" });
    expect(invokeMock).toHaveBeenCalledWith("request_voice_input_permissions");
  });

  test("listVoiceInputLanguages returns Android language payload from Rust command", async () => {
    invokeMock.mockResolvedValueOnce([
      { tag: "ko-KR", label: "Korean" },
      { tag: "en-US", label: "English" },
    ]);

    await expect(commands.listVoiceInputLanguages()).resolves.toEqual([
      { tag: "ko-KR", label: "Korean" },
      { tag: "en-US", label: "English" },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("list_voice_input_languages");
  });

  test("stopVoiceInput and cancelVoiceInput dispatch separate recognizer lifecycle commands", async () => {
    await commands.stopVoiceInput();
    await commands.cancelVoiceInput();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "stop_voice_input");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "cancel_voice_input");
  });

  test("listenVoiceInput subscribes redterm:voice-input window events and unlisten removes the listener", async () => {
    const received = [];
    const unlisten = await commands.listenVoiceInput((event) => received.push(event));

    window.dispatchEvent(
      new CustomEvent("redterm:voice-input", {
        detail: { kind: "partial", transcript: "hello" },
      })
    );
    expect(received).toEqual([{ kind: "partial", transcript: "hello" }]);
    expect(tauriListenMock).not.toHaveBeenCalled();

    unlisten();
    window.dispatchEvent(
      new CustomEvent("redterm:voice-input", {
        detail: { kind: "final", transcript: "ignored text" },
      })
    );
    expect(received).toHaveLength(1);
  });
});
