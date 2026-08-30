import type { TerminalSnapshot } from "./ansi-parser";

const runtimeSnapshots = new Map<string, TerminalSnapshot>();

export function storeRuntimeSessionSnapshot(sessionId: string, snapshot: TerminalSnapshot): void {
  runtimeSnapshots.set(sessionId, snapshot);
}

export function takeRuntimeSessionSnapshot(sessionId: string): TerminalSnapshot | null {
  const snapshot = runtimeSnapshots.get(sessionId) ?? null;
  runtimeSnapshots.delete(sessionId);
  return snapshot;
}

export function clearRuntimeSessionSnapshot(sessionId: string): void {
  runtimeSnapshots.delete(sessionId);
}
