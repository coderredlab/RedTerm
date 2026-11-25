import { hasReflowIncomingContent, hasReflowOutgoingContent, hasUnprovenPathCells, isReflowContinuation, isReflowTail, isTerminalPathDividerColumn, isUnprovenSnapshotRow, pathContinuationLeadingMargin, reflowContinuationEnd, sliceTerminalPathRow, terminalPaneHorizontalRule as horizontalRule, type Cell } from "./ansi-parser";

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
  cutBottom = false,
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
    if (!after) return cutBottom ? null : undefined;
    const known = isReflowContinuation(before, after);
    if (targetRow - point.row >= 32 || isUnprovenSnapshotRow(after) ||
      (before.length !== after.length && !known) ||
      (!known && (hasReflowOutgoingContent(before) || hasReflowIncomingContent(after)))) return null;
    const gaps = terminalLinkContinuationGaps(before, after, panePadding);
    targetRow++;
    targetCol = gaps >= 0 ? gaps & CONTINUATION_MARGIN_MASK : 0;
    if (hasUnprovenPathCells(after, 0, targetCol)) return null;
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
    if (hasUnprovenPathCells(current, targetRow === point.row ? start : 0, targetCol)) return null;
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
  const openerCol = targetCol;
  targetCol++;
  const targetLine = buffer[targetRow];
  while (targetCol < targetLine.length && targetLine[targetCol].char === " ") {
    if (targetLine[targetCol].style.hidden || targetLine[targetCol].hyperlink) return null;
    targetCol++;
  }
  if (hasUnprovenPathCells(targetLine, openerCol, targetCol)) return null;
  if (targetCol === targetLine.length) {
    const gaps = advanceRow();
    if (gaps === undefined || gaps === null || gaps < 0) return null;
  }
  const match = findTarget({ row: targetRow, col: targetCol });
  return match ? { ...match, startCol: start, endCol: end } : null;
}

export interface TerminalLinkPane {
  hasDivider: boolean;
  endsAtViewportRight: boolean;
  cutTop: boolean;
  cutBottom: boolean;
  cutTopStarts?: number[];
  cutBottomEnds?: number[];
}

/** At a split/merge, sidebar text beyond a former divider does not delimit a token. */
export function touchesTerminalPaneCut(
  pane: TerminalLinkPane | undefined, row: Cell[], col: number, incoming: boolean,
): boolean {
  if (incoming) {
    if (!pane?.cutTop) return false;
    let left = 0;
    if (pane.cutTopStarts) {
      for (const start of pane.cutTopStarts) {
        if (start === col + 1) return true; // The token starts on the former wall.
        if (start > col) break;
        left = start;
      }
    }
    let sawSpace = false;
    for (let x = col - 1; x >= left; x--) {
      const cell = row[x];
      if (!cell.style.hidden && cell.char !== " " && sawSpace) return false;
      if (cell.style.hidden || cell.hyperlink) return true;
      if (cell.char === " ") sawSpace = true;
      else if (/[\s<>"'`]/u.test(cell.char)) return false;
    }
  } else {
    if (!pane?.cutBottom) return false;
    let right = row.length;
    if (pane.cutBottomEnds) {
      for (const end of pane.cutBottomEnds) {
        if (end === col) return true;
        if (end > col) { right = end; break; }
      }
    }
    if (col + 1 < right && row[col + 1].char === "") {
      const tail = row[++col];
      if (tail.style.hidden || tail.hyperlink) return true;
    }
    for (let x = col + 1; x < right; x++) {
      const cell = row[x];
      if (cell.style.hidden || cell.hyperlink) return true;
      if (cell.char !== " " || x - col > 2) return false;
    }
  }
  return true;
}

const PANE_CELLS = 4096;

/** Keep the neighboring sidebar/gutter outside both URL and file-path targets. */
export function findInTerminalLinkPane<T extends TerminalTextMatch>(
  buffer: Cell[][], point: TerminalTextPoint,
  findInRows: (rows: Cell[][], point: TerminalTextPoint, pane?: TerminalLinkPane) => T | null,
): T | null {
  const row = buffer[point.row];
  if (!row?.[point.col]) return null;
  const divider = (y: number, x: number) => isTerminalPathDividerColumn(buffer, y, x);
  if (divider(point.row, point.col)) return null;
  let left = point.col, right = point.col + 1;
  while (left > 0 && !divider(point.row, left - 1)) {
    if (right - left >= PANE_CELLS) return null;
    left--;
  }
  while (right < row.length && !divider(point.row, right)) {
    if (right - left >= PANE_CELLS) return null;
    right++;
  }
  const hasDivider = left > 0 || right < row.length;
  if (horizontalRule(buffer, point.row, left, right) !== undefined) {
    const previous = buffer[point.row - 1], next = buffer[point.row + 1];
    if (hasDivider || (!(previous && isReflowContinuation(previous, row)) &&
      !(next && isReflowContinuation(row, next)))) return null;
  }
  const pane: TerminalLinkPane = { hasDivider, endsAtViewportRight: right === row.length, cutTop: false, cutBottom: false };

  const samePane = (y: number, end: number) => {
    const line = buffer[y];
    if (end - left > PANE_CELLS || line.length < end ||
      (left > 0 && !divider(y, left - 1)) ||
      (right < row.length ? !divider(y, right) : hasDivider && line.length !== row.length)) return false;
    // The outer walls may still be there even though this row splits the pane.
    for (let col = left; col < end; col++) if (divider(y, col)) return false;
    return true;
  };
  const cutMayContinue = (y: number, incoming: boolean, retainedEnd: number) => {
    const line = buffer[y];
    if (line.length <= left) return true;
    // A merged pane can start earlier or end later; a split pane can end
    // inside our old rectangle. Ignore panes separated by an unchanged wall.
    let start = left, end = Math.min(retainedEnd, line.length);
    let cuts: number[] | undefined;
    for (let col = start; col < end; col++) {
      if (divider(y, col)) (cuts ??= []).push(col - left + (incoming ? 1 : 0));
    }
    if (incoming) pane.cutTopStarts = cuts;
    else pane.cutBottomEnds = cuts;
    while (start > 0 && !divider(y, start - 1)) {
      if (end - start >= PANE_CELLS) return true;
      start--;
    }
    while (end < line.length && !divider(y, end)) {
      if (end - start >= PANE_CELLS) return true;
      end++;
    }
    let lastInk = -Infinity;
    for (let col = start; col <= end; col++) {
      const wall = col === end || divider(y, col);
      // At most two trailing spaces can be compositor padding.
      if (incoming && (wall || col === retainedEnd) && lastInk >= col - 3) return true;
      if (wall) { lastInk = -Infinity; continue; }
      const cell = line[col];
      if (cell.char !== " " || cell.style.hidden || cell.hyperlink) {
        if (!incoming) return true;
        lastInk = col;
      }
    }
    return false;
  };
  const extent = (step: -1 | 1) => {
    let y = point.row, scanned = 0;
    for (let count = 0; ; count++) {
      const next = y + step, line = buffer[next];
      if (!line) break;
      const end = hasDivider ? right : line.length;
      const retainedEnd = hasDivider ? right : buffer[y].length;
      let rule = hasDivider || end === retainedEnd ? horizontalRule(buffer, next, left, end) : undefined;
      // A borderless row of box glyphs can also be literal soft-wrapped text.
      if (rule !== undefined && !hasDivider &&
        (step < 0 ? isReflowContinuation(line, buffer[y]) : isReflowContinuation(buffer[y], line))) rule = undefined;
      if (rule === true) break;
      if (rule === false || count === 33 || scanned >= PANE_CELLS || !samePane(next, end)) {
        const cut = rule === false || cutMayContinue(next, step < 0, retainedEnd);
        if (step < 0) pane.cutTop = cut;
        else pane.cutBottom = cut;
        break;
      }
      scanned += end - left;
      y = next;
    }
    return y;
  };
  const top = extent(-1), bottom = extent(1);
  if (!hasDivider && top === 0 && bottom + 1 === buffer.length) return findInRows(buffer, point);
  const rows = buffer.slice(top, bottom + 1);
  if (hasDivider) {
    for (let y = 0; y < rows.length; y++) rows[y] = sliceTerminalPathRow(rows[y], left, right);
  }
  const match = findInRows(rows, { row: point.row - top, col: point.col - left }, pane);
  return match && left ? { ...match, startCol: match.startCol + left, endCol: match.endCol + left } : match;
}
