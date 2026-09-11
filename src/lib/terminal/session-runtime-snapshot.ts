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

// 지연 local 스냅샷 쓰기. 여러 로컬 세션이 같은 프레임에 저장할 수 있으므로
// 세션별로 독립 보관하고, Terminal 인스턴스를 넘어 취소될 수 있게 모듈이 소유한다.
const pendingLocalWrites = new Map<string, { generation: number; run: () => void }>();
let localWriteGeneration = 0;

export function scheduleLocalSnapshotWrite(sessionId: string, run: () => void): number {
  localWriteGeneration += 1;
  const generation = localWriteGeneration;
  pendingLocalWrites.set(sessionId, { generation, run });
  return generation;
}

export function invalidateLocalSnapshotWrite(sessionId: string): void {
  pendingLocalWrites.delete(sessionId);
}

/** 예약 시점의 세대가 일치하는 경우에만 예약 쓰기를 꺼내 반환한다. */
export function takeLocalSnapshotWrite(sessionId: string, generation: number): (() => void) | null {
  const entry = pendingLocalWrites.get(sessionId);
  if (!entry || entry.generation !== generation) return null;
  pendingLocalWrites.delete(sessionId);
  return entry.run;
}
