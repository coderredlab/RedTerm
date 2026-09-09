// @ts-nocheck
import { expect, test } from "bun:test";
import { resolveRecovery } from "./reconcile";

test("local workspaces survive runtime changes without SSH credential recovery", async () => {
  const target = {
    kind: "local" as const,
    sessionId: "local-session",
    runtimeInstanceId: "runtime-1",
    auth: { username: "local", method: { type: "password" as const, password: "" } },
  };
  expect(await resolveRecovery(target, "runtime-2")).toBe("disconnect");
  expect(await resolveRecovery(target, "runtime-1")).toBe("keep");
  expect(await resolveRecovery({ ...target, sessionId: null }, "runtime-2")).toBe("keep");
});
