// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { cleanupFailedSessionAttach } from "./session-attach-cleanup";

describe("cleanupFailedSessionAttach", () => {
  test("releases listeners, local state, and the backend session", async () => {
    const calls: string[] = [];

    const error = await cleanupFailedSessionAttach({
      sessionId: "session-1",
      unlistenData: () => calls.push("data"),
      unlistenExit: () => calls.push("exit"),
      clearMode: (sessionId) => calls.push(`mode:${sessionId}`),
      clearSnapshot: (sessionId) => calls.push(`snapshot:${sessionId}`),
      disconnect: async (sessionId) => {
        calls.push(`disconnect:${sessionId}`);
      },
    });

    expect(error).toBeNull();
    expect(calls).toEqual([
      "data",
      "exit",
      "mode:session-1",
      "snapshot:session-1",
      "disconnect:session-1",
    ]);
  });

  test("continues every cleanup step after an earlier failure", async () => {
    const calls: string[] = [];
    const listenerError = new Error("listener cleanup failed");

    const error = await cleanupFailedSessionAttach({
      sessionId: "session-2",
      unlistenData: () => {
        calls.push("data");
        throw listenerError;
      },
      unlistenExit: () => calls.push("exit"),
      clearMode: () => calls.push("mode"),
      clearSnapshot: () => calls.push("snapshot"),
      disconnect: async () => {
        calls.push("disconnect");
        throw new Error("disconnect failed");
      },
    });

    expect(error).toBe(listenerError);
    expect(calls).toEqual(["data", "exit", "mode", "snapshot", "disconnect"]);
  });
});
