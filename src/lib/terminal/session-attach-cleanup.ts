interface FailedSessionAttachCleanup {
  sessionId: string;
  unlistenData?: (() => void) | null;
  unlistenExit?: (() => void) | null;
  clearMode: (sessionId: string) => void;
  clearSnapshot: (sessionId: string) => void;
  disconnect: (sessionId: string) => Promise<void>;
}

export async function cleanupFailedSessionAttach({
  sessionId,
  unlistenData,
  unlistenExit,
  clearMode,
  clearSnapshot,
  disconnect,
}: FailedSessionAttachCleanup): Promise<unknown | null> {
  let firstError: unknown | null = null;
  for (const cleanup of [unlistenData, unlistenExit]) {
    if (!cleanup) continue;
    try {
      cleanup();
    } catch (error) {
      firstError ??= error;
    }
  }

  clearMode(sessionId);
  clearSnapshot(sessionId);
  try {
    await disconnect(sessionId);
  } catch (error) {
    firstError ??= error;
  }

  return firstError;
}
