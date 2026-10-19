import { hasReflowIncomingContent, hasReflowOutgoingContent, isReflowContinuation, isReflowTail, isTerminalPathDividerColumn, isUnprovenSnapshotRow, pathContinuationLeadingMargin, reflowContinuationEnd, sliceTerminalPathRow, type Cell } from "./ansi-parser";

export interface TerminalTextPoint { row: number; col: number }
export interface TerminalTextMatch { startCol: number; endCol: number }
export const CONTINUATION_MARGIN_BITS = 12;
export const CONTINUATION_MARGIN_MASK = (1 << CONTINUATION_MARGIN_BITS) - 1;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function terminalLinkContinuationGaps(
  before: Cell[], after: Cell[], panePadding: boolean, ignoreHyperlinks = false,
): number {
  const known = isReflowContinuation(before, after);
  const leading = pathContinuationLeadingMargin(before, after);
  if (leading < 0) return -1;
  const herdrTail = isReflowTail(before) && !known &&
    leading > 0 && !!after[leading]?.char.trim() &&
    !isUnprovenSnapshotRow(before);
  if (isReflowTail(before) && !known && !herdrTail) return -1;
  if (!ignoreHyperlinks && before.length !== after.length && !known && !herdrTail) return -1;
  const continuationEnd = reflowContinuationEnd(before, after);
  let trailing = 0;
  if (continuationEnd !== null) trailing = before.length - continuationEnd;
  else if (herdrTail) {
    while (trailing < before.length && before[before.length - trailing - 1]?.char === " ") trailing++;
  } else if (panePadding || leading > 1) {
    while (trailing < 2 && before[before.length - trailing - 1]?.char === " ") trailing++;
  } else if (before.at(-1)?.char === " " && before.at(-2)?.char.trim()) trailing = 1;
  const lastContent = before[before.length - 1 - trailing];
  const wideEnd = lastContent?.char === "" && before.at(-2 - trailing)?.char.trim();
  const end = before[before.length - 1 - trailing - (wideEnd ? 1 : 0)];
  if (!end?.char.trim() || (!ignoreHyperlinks && end.hyperlink)) return -1;
  if (leading > CONTINUATION_MARGIN_MASK || trailing > CONTINUATION_MARGIN_MASK) return -1;
  if (!ignoreHyperlinks) {
    for (let col = 0; col < leading; col++) if (after[col].hyperlink) return -1;
  }
  return after[leading]?.char.trim() && (ignoreHyperlinks || !after[leading]?.hyperlink)
    ? (trailing << CONTINUATION_MARGIN_BITS) | leading : -1;
}

/** An underlined rendered label may name the parenthesized target immediately after it. */
export function findRenderedTerminalLabel<T extends TerminalTextMatch>(
  buffer: Cell[][], point: TerminalTextPoint, panePadding: boolean,
  findTarget: (point: TerminalTextPoint) => T | null,
): T | null | undefined {
  const row = buffer[point.row];
  const isLabelCell = (cell: Cell | undefined) => cell?.style.underline &&
    !cell.style.hidden && !cell.hyperlink && !UNSAFE.test(cell.char);
  if (!isLabelCell(row?.[point.col])) return undefined;
  if (isUnprovenSnapshotRow(row)) return null;
  let start = point.col, end = point.col;
  while (start > 0 && isLabelCell(row[start - 1])) start--;
  while (end + 1 < row.length && isLabelCell(row[end + 1])) end++;
  let targetRow = point.row, targetCol = end + 1, scanned = end - start + 1;
  const advanceRow = (): number | null | undefined => {
    const before = buffer[targetRow], after = buffer[targetRow + 1];
    if (!after) return undefined;
    const known = isReflowContinuation(before, after);
    if (targetRow - point.row >= 32 || isUnprovenSnapshotRow(after) ||
      (before.length !== after.length && !known) ||
      (!known && (hasReflowOutgoingContent(before) || hasReflowIncomingContent(after)))) return null;
    const gaps = terminalLinkContinuationGaps(before, after, panePadding);
    targetRow++;
    targetCol = gaps >= 0 ? gaps & CONTINUATION_MARGIN_MASK : 0;
    for (let col = 0; col < targetCol; col++) {
      if (after[col].style.hidden || after[col].hyperlink) return null;
    }
    return gaps;
  };
  while (true) {
    const current = buffer[targetRow];
    let labelOnRow = targetRow === point.row;
    while (targetCol < current.length && isLabelCell(current[targetCol])) {
      if (current[targetCol].char.trim()) labelOnRow = true;
      targetCol++;
      if (++scanned > 4096) return null;
    }
    while (targetCol < current.length && current[targetCol].char === " ") {
      if (current[targetCol].style.hidden || current[targetCol].hyperlink) return null;
      targetCol++;
      if (++scanned > 4096) return null;
    }
    if (targetCol < current.length) break;
    if (!labelOnRow) return undefined;
    const gaps = advanceRow();
    if (gaps === undefined) return undefined;
    if (gaps === null) return null;
    if (isLabelCell(buffer[targetRow][targetCol]) && gaps < 0) return undefined;
  }
  const opener = buffer[targetRow]?.[targetCol];
  if (opener?.char !== "(") return undefined;
  if (opener.style.hidden || opener.hyperlink) return null;
  targetCol++;
  const targetLine = buffer[targetRow];
  while (targetCol < targetLine.length && targetLine[targetCol].char === " ") {
    if (targetLine[targetCol].style.hidden || targetLine[targetCol].hyperlink) return null;
    targetCol++;
  }
  if (targetCol === targetLine.length) {
    const gaps = advanceRow();
    if (gaps === undefined || gaps === null || gaps < 0) return null;
  }
  const match = findTarget({ row: targetRow, col: targetCol });
  return match ? { ...match, startCol: start, endCol: end } : null;
}

/** Keep the neighboring sidebar/gutter outside both URL and file-path targets. */
export function findInTerminalLinkPane<T extends TerminalTextMatch>(
  buffer: Cell[][], point: TerminalTextPoint,
  findInRows: (rows: Cell[][], point: TerminalTextPoint, panePadding: boolean) => T | null,
): T | null {
  const row = buffer[point.row];
  if (!row?.[point.col]) return null;
  const divider = (line: Cell[] | undefined, col: number) => {
    const cell = line?.[col];
    return !!cell && /^[│┃║▕]$/.test(cell.char) && !cell.style.hidden && !cell.hyperlink;
  };
  const continuousDivider = (col: number) => isTerminalPathDividerColumn(buffer, point.row, col);
  if (continuousDivider(point.col)) return null;
  let left = 0, right = row.length;
  for (let col = point.col - 1; col >= 0; col--) {
    if (continuousDivider(col)) { left = col + 1; break; }
  }
  for (let col = point.col + 1; col < row.length; col++) {
    if (continuousDivider(col)) { right = col; break; }
  }
  if (left === 0 && right === row.length) return findInRows(buffer, point, false);
  const withinPane = (line: Cell[]) => line.length >= right &&
    (left === 0 || divider(line, left - 1)) &&
    (right === row.length ? line.length === row.length : divider(line, right));
  const reach = Math.min(33, Math.ceil(4096 / Math.max(1, right - left)) + 1);
  let top = point.row, bottom = point.row;
  while (top > 0 && point.row - top < reach && withinPane(buffer[top - 1])) top--;
  while (bottom + 1 < buffer.length && bottom - point.row < reach && withinPane(buffer[bottom + 1])) bottom++;
  const pane = buffer.slice(top, bottom + 1).map(line => sliceTerminalPathRow(line, left, right));
  const match = findInRows(pane, { row: point.row - top, col: point.col - left }, true);
  return match ? { ...match, startCol: match.startCol + left, endCol: match.endCol + left } : null;
}
