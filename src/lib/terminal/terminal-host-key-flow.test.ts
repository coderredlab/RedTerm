// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { completeHostKeyTrustBeforeConnect } from "./terminal-host-key-flow";

describe("terminal host-key trust flow", () => {
  test("clears the host-key prompt after trust succeeds before connect can request a key passphrase", async () => {
    const events: string[] = [];
    let pendingHostKeyChallenge: { fingerprint: string } | null = { fingerprint: "SHA256:presented-key" };
    let passphrasePromptOpenedWithHostKeyPromptStillVisible = false;

    const sessionId = await completeHostKeyTrustBeforeConnect({
      trustHostKey: async () => {
        events.push("trust-host-key");
      },
      clearHostKeyPrompt: () => {
        events.push("clear-host-key-prompt");
        pendingHostKeyChallenge = null;
      },
      connect: async () => {
        events.push("connect");
        passphrasePromptOpenedWithHostKeyPromptStillVisible = pendingHostKeyChallenge !== null;
        return "session-after-passphrase-prompt";
      },
    });

    expect(sessionId).toBe("session-after-passphrase-prompt");
    expect(passphrasePromptOpenedWithHostKeyPromptStillVisible).toBe(false);
    expect(events).toEqual(["trust-host-key", "clear-host-key-prompt", "connect"]);
  });
});
