export type TerminalMouseAction = "press" | "release" | "move";

interface TerminalMouseEvent {
  action: TerminalMouseAction;
  button: number;
  col: number;
  row: number;
  sgr: boolean;
  repeat?: number;
}

const encoder = new TextEncoder();

export function encodeTerminalMouseEvent(event: TerminalMouseEvent): Uint8Array {
  const repeat = Math.max(1, Math.trunc(event.repeat ?? 1));
  const col = Math.max(1, Math.trunc(event.col) + 1);
  const row = Math.max(1, Math.trunc(event.row) + 1);
  const code = event.action === "move" ? event.button + 32 : event.button;

  if (event.sgr) {
    const suffix = event.action === "release" ? "m" : "M";
    return encoder.encode(`\x1b[<${code};${col};${row}${suffix}`.repeat(repeat));
  }

  const legacyCode = event.action === "release" ? 3 : code;
  const legacyCol = Math.min(223, col);
  const legacyRow = Math.min(223, row);
  const sequence = Uint8Array.of(
    0x1b,
    0x5b,
    0x4d,
    32 + legacyCode,
    32 + legacyCol,
    32 + legacyRow,
  );
  if (repeat === 1) return sequence;

  const repeated = new Uint8Array(sequence.length * repeat);
  for (let offset = 0; offset < repeated.length; offset += sequence.length) {
    repeated.set(sequence, offset);
  }
  return repeated;
}
