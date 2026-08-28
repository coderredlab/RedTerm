import type { Cell } from "./ansi-parser";

export interface TerminalSelectionRange {
  start: { row: number; col: number };
  end: { row: number; col: number };
}

export function extractTerminalSelection(
  buffer: Cell[][],
  range: TerminalSelectionRange
): string {
  const lines: string[] = [];
  for (let rowIndex = range.start.row; rowIndex <= range.end.row && rowIndex < buffer.length; rowIndex++) {
    const row = buffer[rowIndex];
    const startColumn = rowIndex === range.start.row ? range.start.col : 0;
    const endColumn = rowIndex === range.end.row ? range.end.col + 1 : row.length;
    let line = "";

    for (let column = startColumn; column < endColumn && column < row.length; column++) {
      const cell = row[column];
      if (cell.char === "") continue;
      line += cell.style.hidden ? " " : cell.char;
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
