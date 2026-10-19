import { hasCompleteReflowIncomingContent, hasReflowIncomingContent, hasReflowOutgoingContent, isReflowContinuation, isUnprovenSnapshotRow, reflowContinuationEnd, type Cell } from "./ansi-parser";
import { CONTINUATION_MARGIN_BITS, CONTINUATION_MARGIN_MASK, findInTerminalLinkPane, findRenderedTerminalLabel, terminalLinkContinuationGaps } from "./terminal-rendered-links";

export interface TerminalUrlMatch {
  url: string;
  startCol: number;
  endCol: number;
}

export interface SafeTerminalUrl {
  url: string;
  origin: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PROSE_PUNCTUATION: Record<string, true> = {
  ".": true,
  ",": true,
  ";": true,
  ":": true,
  "!": true,
  "?": true,
};
const CLOSING_DELIMITERS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};
const UNSAFE_URL_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;


function countChar(value: string, target: string): number {
  let count = 0;
  for (const char of value) {
    if (char === target) count += 1;
  }
  return count;
}

function hasUnmatchedClosingDelimiter(value: string, closing: string): boolean {
  const opening = CLOSING_DELIMITERS[closing];
  return !!opening && countChar(value, closing) > countChar(value, opening);
}

function trimUrlCandidate(candidate: string): string {
  let end = candidate.length;

  while (end > 0) {
    const lastChar = candidate[end - 1];
    const currentValue = candidate.slice(0, end);

    if (TRAILING_PROSE_PUNCTUATION[lastChar]) {
      end -= 1;
      continue;
    }

    if (hasUnmatchedClosingDelimiter(currentValue, lastChar)) {
      end -= 1;
      continue;
    }

    break;
  }

  return candidate.slice(0, end);
}

export function validateTerminalUrl(candidate: string): SafeTerminalUrl | null {
  if (UNSAFE_URL_CONTROLS.test(candidate)) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  return {
    url: parsed.href,
    origin: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
  };
}

function findUrlInRows(
  buffer: Cell[][], point: { row: number; col: number }, panePadding: boolean,
): TerminalUrlMatch | null {
  const row = buffer[point.row];
  if (!row?.[point.col] || row.length > 4096 || isUnprovenSnapshotRow(row)) return null;
  const gaps = (before: Cell[], after: Cell[], ignoreHyperlinks = false) => {
    const contentEnd = reflowContinuationEnd(before, after);
    if (contentEnd !== null) {
      // Proven terminal wraps retain literal whitespace, unlike TUI pane margins.
      return hasCompleteReflowIncomingContent(after)
        ? (before.length - contentEnd) << CONTINUATION_MARGIN_BITS : -1;
    }
    return terminalLinkContinuationGaps(before, after, panePadding, ignoreHyperlinks);
  };
  let pointTextEnd = 0;
  for (let col = 0; col <= point.col; col++) pointTextEnd += row[col].char.length;
  let first = point.row, last = point.row, length = row.length;
  while (first > 0 && length + buffer[first - 1].length <= 4096 &&
    point.row - first + 1 < 32 && gaps(buffer[first - 1], buffer[first]) >= 0) {
    // A visible token start is enough; preceding prose must not consume the budget.
    const boundary = buffer[first].map(cell => cell.char).join("").search(/\s\(?https?:\/\//i);
    if (boundary >= 0 && (first < point.row || boundary < pointTextEnd)) break;
    first--;
    length += buffer[first].length;
  }
  while (last + 1 < buffer.length && length + buffer[last + 1].length <= 4096 &&
    last - first + 1 < 32 && gaps(buffer[last], buffer[last + 1]) >= 0) {
    last++;
    length += buffer[last].length;
  }
  let text = "", clickOffset = -1;
  const columns: number[] = [], rowStarts: number[] = [];
  for (let line = first; line <= last; line++) {
    rowStarts.push(text.length);
    const leading = line === first ? 0 : gaps(buffer[line - 1], buffer[line]) & CONTINUATION_MARGIN_MASK;
    const trailing = line === last ? 0 : gaps(buffer[line], buffer[line + 1]) >> CONTINUATION_MARGIN_BITS;
    for (let col = leading; col < buffer[line].length - trailing; col++) {
      const cell = buffer[line][col];
      if (line === point.row && col === point.col) {
        clickOffset = cell.char ? text.length :
          col > 0 && buffer[line][col - 1].char ? text.length - buffer[line][col - 1].char.length : -1;
      }
      for (let offset = 0; offset < cell.char.length; offset++) columns.push(col);
      text += cell.char;
    }
  }
  rowStarts.push(text.length);
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const offset = match.index!;
    let candidate = match[0];
    if (clickOffset < offset || clickOffset >= offset + candidate.length) continue;
    let literalWhitespaceEnd = false;
    let renderedTarget: boolean | undefined;
    for (let line = first; line < last; line++) {
      const boundary = rowStarts[line - first + 1];
      if (boundary <= offset || boundary >= offset + candidate.length ||
        isReflowContinuation(buffer[line], buffer[line + 1])) continue;
      if (renderedTarget === undefined) {
        renderedTarget = false;
        if (text[offset - 1] === "(") {
          const rootRow = first + rowStarts.findIndex((_, index) => offset < rowStarts[index + 1]);
          for (let labelRow = Math.max(0, rootRow - 1); labelRow <= rootRow && !renderedTarget; labelRow++) {
            const label = buffer[labelRow];
            for (let col = 0; col < label.length && !renderedTarget; col++) {
              const cell = label[col], previous = label[col - 1];
              if (!cell.style.underline || cell.style.hidden || cell.hyperlink ||
                (previous?.style.underline && !previous.style.hidden && !previous.hyperlink)) continue;
              renderedTarget = !!findRenderedTerminalLabel(buffer, { row: labelRow, col }, panePadding,
                target => target.row === rootRow && target.col === columns[offset]
                  ? { startCol: target.col, endCol: target.col } : null);
            }
          }
        }
      }
      if (renderedTarget) continue;
      // Only a verified rendered label justifies removing hard-newline margins.
      const spacing = gaps(buffer[line], buffer[line + 1]);
      if (spacing <= 0) return null;
      const leading = spacing & CONTINUATION_MARGIN_MASK;
      for (let col = 0; col < leading; col++) {
        const cell = buffer[line + 1][col];
        if (cell.style.hidden || cell.hyperlink) return null;
      }
      candidate = candidate.slice(0, boundary - offset);
      URL_PATTERN.lastIndex = boundary;
      literalWhitespaceEnd = true;
      break;
    }
    let unsafeDelimiter = false;
    // A rendered `(URL)` terminates at its outer delimiter, not the following row.
    if (text[offset - 1] === "(") {
      const openerRow = first + rowStarts.findIndex((_, index) => offset - 1 < rowStarts[index + 1]);
      const opener = buffer[openerRow][columns[offset - 1]];
      unsafeDelimiter = opener.style.hidden || !!opener.hyperlink;
      let depth = 0;
      for (let index = 0; index < candidate.length; index++) {
        if (candidate[index] === "(") depth++;
        else if (candidate[index] === ")" && depth-- === 0) {
          const delimiterOffset = offset + index;
          const delimiterRow = first + rowStarts.findIndex((_, line) => delimiterOffset < rowStarts[line + 1]);
          const delimiter = buffer[delimiterRow][columns[delimiterOffset]];
          unsafeDelimiter ||= delimiter.style.hidden || !!delimiter.hyperlink;
          candidate = candidate.slice(0, index);
          break;
        }
      }
    }
    const url = trimUrlCandidate(candidate);
    const end = offset + url.length;
    if (!url || clickOffset < offset || clickOffset >= end) continue;
    if (unsafeDelimiter) return null;
    const firstLine = first + rowStarts.findIndex((_, index) => offset < rowStarts[index + 1]);
    const lastLine = first + rowStarts.findIndex((_, index) => end <= rowStarts[index + 1]);
    // Never offer a prefix/suffix after truncation, lost ancestry, or a blocked OSC 8 span.
    const before = firstLine > 0 ? gaps(buffer[firstLine - 1], buffer[firstLine], true) : -1;
    const after = lastLine + 1 < buffer.length ? gaps(buffer[lastLine], buffer[lastLine + 1], true) : -1;
    const lineEnd = rowStarts[lastLine - first + 1];
    const preceding = offset > rowStarts[firstLine - first] ? buffer[firstLine][columns[offset - 1]] : undefined;
    const literalWhitespaceStart = preceding?.char === " " && !preceding.style.hidden && !preceding.hyperlink;
    if ((!literalWhitespaceStart && firstLine === first && before >= 0 && /^[ ([{"'`]*$/.test(text.slice(0, offset))) ||
      (!literalWhitespaceEnd && lastLine === last && after >= 0 && /^ *$/.test(text.slice(offset + candidate.length, lineEnd)))) return null;
    if (hasReflowIncomingContent(buffer[firstLine]) &&
      (firstLine === 0 || !isReflowContinuation(buffer[firstLine - 1], buffer[firstLine]) ||
        gaps(buffer[firstLine - 1], buffer[firstLine]) < 0)) return null;
    if (hasReflowOutgoingContent(buffer[lastLine]) &&
      (lastLine + 1 === buffer.length || !isReflowContinuation(buffer[lastLine], buffer[lastLine + 1]) ||
        gaps(buffer[lastLine], buffer[lastLine + 1]) < 0)) return null;
    for (let line = firstLine; line <= lastLine; line++) {
      const current = buffer[line];
      if (isUnprovenSnapshotRow(current)) return null;
      const leading = line === first ? 0 : gaps(buffer[line - 1], current) & CONTINUATION_MARGIN_MASK;
      const trailing = line === last ? 0 : gaps(current, buffer[line + 1]) >> CONTINUATION_MARGIN_BITS;
      for (let col = 0; col < leading; col++) {
        if (current[col].style.hidden || current[col].hyperlink) return null;
      }
      for (let col = current.length - trailing; col < current.length; col++) {
        if (current[col].style.hidden || current[col].hyperlink || current[col].char !== " ") return null;
      }
      const from = Math.max(offset, rowStarts[line - first]);
      const to = Math.min(end, rowStarts[line - first + 1]);
      for (let col = columns[from]; col <= columns[to - 1]; col++) {
        if (current[col].style.hidden || current[col].hyperlink) return null;
      }
    }
    const pointStart = rowStarts[point.row - first], pointEnd = rowStarts[point.row - first + 1];
    const startCol = columns[Math.max(offset, pointStart)];
    let endCol = columns[Math.min(end, pointEnd) - 1];
    while (endCol + 1 < row.length && row[endCol + 1].char === "") endCol++;
    const safeUrl = validateTerminalUrl(url);
    return safeUrl ? { url: safeUrl.url, startCol, endCol } : null;
  }
  return null;
}


export function findUrlAtCell(
  buffer: Cell[][],
  point: { row: number; col: number },
): TerminalUrlMatch | null {
  const row = buffer[point.row];
  if (!row || point.col < 0) return null;
  const explicit = row[point.col]?.hyperlink;
  if (explicit) {
    const sameLink = (col: number) => {
      const hyperlink = row[col]?.hyperlink;
      return hyperlink?.uri === explicit.uri && hyperlink.id === explicit.id;
    };
    let startCol = point.col;
    let endCol = point.col;
    while (startCol > 0 && sameLink(startCol - 1)) startCol--;
    while (endCol + 1 < row.length && sameLink(endCol + 1)) endCol++;
    if (row.slice(startCol, endCol + 1).some((cell) => cell.style.hidden)) return null;
    const safeUrl = validateTerminalUrl(explicit.uri);
    return safeUrl ? { url: safeUrl.url, startCol, endCol } : null;
  }

  return findInTerminalLinkPane(buffer, point, (rows, localPoint, panePadding) => {
    const rendered = findRenderedTerminalLabel(rows, localPoint, panePadding,
      target => findUrlInRows(rows, target, panePadding));
    return rendered === undefined ? findUrlInRows(rows, localPoint, panePadding) : rendered;
  });
}
