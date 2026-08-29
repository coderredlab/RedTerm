export type TerminalMouseAction = "press" | "release" | "move";

interface TerminalMouseEvent {
  action: TerminalMouseAction;
  button: number;
  col: number;
  row: number;
  sgr: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: number;
}

export interface TerminalMouseCellInput {
  clientX: number;
  clientY: number;
  viewportLeft: number;
  viewportTop: number;
  horizontalPadding: number;
  charWidth: number;
  charHeight: number;
  cols: number;
  rows: number;
}

export function terminalMouseCellFromPoint(input: TerminalMouseCellInput): {
  row: number;
  col: number;
} {
  const maxCol = Math.max(0, Math.trunc(input.cols) - 1);
  const maxRow = Math.max(0, Math.trunc(input.rows) - 1);
  const col = Math.floor(
    (input.clientX - input.viewportLeft - input.horizontalPadding) /
      Math.max(1, input.charWidth),
  );
  const row = Math.floor(
    (input.clientY - input.viewportTop) / Math.max(1, input.charHeight),
  );
  return {
    col: Math.max(0, Math.min(maxCol, col)),
    row: Math.max(0, Math.min(maxRow, row)),
  };
}

const encoder = new TextEncoder();

export function encodeTerminalMouseEvent(event: TerminalMouseEvent): Uint8Array {
  const repeat = Math.max(1, Math.trunc(event.repeat ?? 1));
  const col = Math.max(1, Math.trunc(event.col) + 1);
  const row = Math.max(1, Math.trunc(event.row) + 1);
  const modifierCode =
    (event.shiftKey ? 4 : 0) +
    (event.altKey || event.metaKey ? 8 : 0) +
    (event.ctrlKey ? 16 : 0);
  const code =
    (event.action === "move" ? event.button + 32 : event.button) +
    modifierCode;

  if (event.sgr) {
    const suffix = event.action === "release" ? "m" : "M";
    return encoder.encode(`\x1b[<${code};${col};${row}${suffix}`.repeat(repeat));
  }

  const legacyCode = event.action === "release" ? 3 + modifierCode : code;
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
