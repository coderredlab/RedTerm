import type { AuthConfig } from "$lib/tauri/commands";
import { getRuntimeInstanceId, sshSessionExists } from "$lib/tauri/commands";

export type SessionRecoveryVerdict = "keep" | "remove" | "disconnect";

/** Minimal persisted-session shape shared by tabs (mobile) and panes (desktop). */
export interface RecoveryTarget {
  sessionId: string | null;
  kind?: "ssh" | "local";
  runtimeInstanceId?: string | null;
  auth: AuthConfig;
  canRestorePassword?: boolean;
}

export async function loadRuntimeInstanceId(): Promise<string | null> {
  try {
    return await getRuntimeInstanceId();
  } catch (error) {
    console.error("Failed to load runtime instance id:", error);
    return null;
  }
}

/**
 * Decide what happens to a persisted session after an app restart: keep it
 * when the session is still alive in this runtime, drop unrestorable plain
 * password targets, or mark the rest disconnected for a fresh reconnect.
 */
export async function resolveRecovery(
  target: RecoveryTarget,
  runtimeInstanceId: string | null
): Promise<SessionRecoveryVerdict> {
  if (!target.sessionId) return "keep";

  const sameRuntime = target.runtimeInstanceId === runtimeInstanceId;
  // Local attachment checks its own PTY. Across app runtimes the process is
  // gone, but its workspace entry must survive and start a fresh shell.
  if (target.kind === "local") return sameRuntime ? "keep" : "disconnect";
  const sessionAlive = sameRuntime
    ? await sshSessionExists(target.sessionId).catch(() => false)
    : false;

  if (sessionAlive) return "keep";

  if (
    target.auth.method.type === "password" &&
    !target.canRestorePassword
  ) {
    return "remove";
  }

  return "disconnect";
}
