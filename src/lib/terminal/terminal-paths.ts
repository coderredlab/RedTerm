import { hasReflowIncomingContent, hasReflowOutgoingContent, isReflowContinuation, isUnprovenSnapshotRow, printedDirectoryUri, type Cell } from "./ansi-parser";
import { CONTINUATION_MARGIN_BITS, CONTINUATION_MARGIN_MASK, findInTerminalLinkPane, findRenderedTerminalLabel, terminalLinkContinuationGaps } from "./terminal-rendered-links";

export interface TerminalPathMatch {
  path: string;
  /** Rendered boundary candidates require filesystem verification; null means no alternate target. */
  alternativePath?: string | null;
  /** Other possible targets at rendered row boundaries. */
  intermediatePaths?: string[];
  choiceReason?: "source-location" | "relative-path" | "rendered-label";
  startCol: number;
  endCol: number;
}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;

function leadingSpaces(row: Cell[]): number {
  let count = 0;
  while (count < row.length && row[count].char === " ") count++;
  return count;
}

/** Resolve only explicit paths; never evaluate shell syntax or environment variables. */
export function resolveTerminalPath(candidate: string, cwdUri: string | null = null): string | null {
  if (!candidate || candidate.length > 4096 || UNSAFE.test(candidate)) return null;
  let path = candidate;
  if (/^file:/i.test(path)) {
    try {
      // URL parsing removes dot segments, which can change filesystem meaning
      // across symlinks. Reject those before URL normalization can hide them.
      if (decodeURIComponent(path).split(/[\\/]/).includes("..")) return null;
      const uri = new URL(path);
      if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost") ||
        uri.username || uri.password || uri.port || uri.search || uri.hash) return null;
      // A remote OSC 7/OSC 8 authority must not be interpreted in the outer session.
      path = decodeURIComponent(uri.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch { return null; }
  } else {
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return null;
  }
  if (!path || UNSAFE.test(path)) return null;
  if (/^[A-Za-z]:[\\/]/.test(path)) path = path.replace(/\\/g, "/");
  if (ABSOLUTE.test(path) || path === "~" || path.startsWith("~/")) return path;
  if (!path.includes("/") || !cwdUri) return null;
  const cwd = resolveTerminalPath(cwdUri);
  if (!cwd || !ABSOLUTE.test(cwd)) return null;
  return `${cwd.replace(/\/$/, "")}/${path}`;
}

function unresolvedRelativePath(candidate: string): string | null {
  return candidate.length <= 4096 && candidate.includes("/") &&
    !ABSOLUTE.test(candidate) && !candidate.startsWith("~") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(candidate) &&
    !candidate.split(/[\\/]/).includes("..") && !UNSAFE.test(candidate)
    ? candidate : null;
}

/** Infer a fixed display pane, never treating its neighboring sidebar as path text. */
export function findPathAtCell(
  buffer: Cell[][], point: { row: number; col: number }, cwdUri: string | null = null,
): TerminalPathMatch | null {
  if (buffer[point.row]?.[point.col]?.hyperlink) return findPathInRows(buffer, point, cwdUri);
  return findInTerminalLinkPane(buffer, point, (rows, localPoint, panePadding) => {
    const rendered = findRenderedTerminalLabel(rows, localPoint, panePadding,
      target => findPathInRows(rows, target, cwdUri, panePadding));
    const match = rendered === undefined ? findPathInRows(rows, localPoint, cwdUri, panePadding) : rendered;
    if (!match) return null;
    if (rendered || panePadding) {
      return { ...match, alternativePath: match.alternativePath ?? null,
        choiceReason: rendered
          ? match.choiceReason === "relative-path" ? "relative-path" : "rendered-label"
          : match.choiceReason ?? "rendered-label" };
    }
    return match;
  });
}

function findPathInRows(
  buffer: Cell[][],
  point: { row: number; col: number },
  cwdUri: string | null = null,
  panePadding = false,
): TerminalPathMatch | null {
  const row = buffer[point.row];
  if (!row || point.col < 0 || !row[point.col]) return null;
  const explicit = row[point.col].hyperlink;
  if (explicit) {
    // OSC 8 targets are paths, not rendered text: do not infer a wrap from their label.
    // OMP emits raw absolute hrefs as well as file: URLs.
    const same = (y: number, x: number) => buffer[y]?.[x]?.hyperlink?.uri === explicit.uri &&
      buffer[y][x].hyperlink?.id === explicit.id;
    let firstRow = point.row, firstCol = point.col, lastRow = point.row, lastCol = point.col;
    let spanCells = 1;
    while (firstRow > 0 || firstCol > 0) {
      const y = firstCol > 0 ? firstRow : firstRow - 1;
      const x = firstCol > 0 ? firstCol - 1 : buffer[y].length - 1;
      if (!same(y, x)) break;
      if (++spanCells > 4096) return null;
      firstRow = y; firstCol = x;
    }
    while (lastRow + 1 < buffer.length || lastCol + 1 < buffer[lastRow].length) {
      const y = lastCol + 1 < buffer[lastRow].length ? lastRow : lastRow + 1;
      const x = y === lastRow ? lastCol + 1 : 0;
      if (!same(y, x)) break;
      if (++spanCells > 4096) return null;
      lastRow = y; lastCol = x;
    }
    let printedCwd: string | null = null;
    let consistentCwd = true;
    for (let y = firstRow; y <= lastRow; y++) {
      const from = y === firstRow ? firstCol : 0;
      const to = y === lastRow ? lastCol : buffer[y].length - 1;
      for (let x = from; x <= to; x++) {
        const cell = buffer[y][x];
        if (cell.style.hidden) return null;
        if (!cell.char.trim()) continue;
        const cwd = printedDirectoryUri(cell);
        if (!cwd || (printedCwd && cwd !== printedCwd)) consistentCwd = false;
        if (cwd) printedCwd = cwd;
      }
    }
    const relative = unresolvedRelativePath(explicit.uri);
    const resolvedRelative = relative && consistentCwd
      ? resolveTerminalPath(relative, printedCwd) : null;
    const path = /^file:/i.test(explicit.uri)
      ? resolveTerminalPath(explicit.uri)
      : ABSOLUTE.test(explicit.uri) && explicit.uri.length <= 4096 && !UNSAFE.test(explicit.uri)
        ? /^[A-Za-z]:[\\/]/.test(explicit.uri) ? explicit.uri.replace(/\\/g, "/") : explicit.uri
        : resolvedRelative ?? relative;
    if (!path) return null;
    const startCol = firstRow === point.row ? firstCol : 0;
    const endCol = lastRow === point.row ? lastCol : row.length - 1;
    return { path, startCol, endCol,
      ...(relative && !resolvedRelative
        ? { alternativePath: null, choiceReason: "relative-path" as const } : {}) };
  }
  // Stored snapshots have no wrap ancestry. Rendered plain text with
  // surviving original cells is non-actionable; OSC 8 above is explicit.
  if (isUnprovenSnapshotRow(row)) return null;
  // Nested Markdown lists retain their indentation across TUI-internal wraps.
  // Pack trailing and leading margin counts; -1 means no continuation.
  const continuationGaps = (before: Cell[], after: Cell[], ignoreHyperlinks = false) =>
    terminalLinkContinuationGaps(before, after, panePadding, ignoreHyperlinks);
  let first = point.row;
  let last = point.row;
  let length = row.length;
  while (first > 0 && length + buffer[first - 1].length <= 4096 &&
    continuationGaps(buffer[first - 1], buffer[first]) >= 0) {
    first--;
    length += buffer[first].length;
  }
  while (last + 1 < buffer.length && length + buffer[last + 1].length <= 4096 &&
    continuationGaps(buffer[last], buffer[last + 1]) >= 0) {
    last++;
    length += buffer[last].length;
  }
  for (let line = first; line <= last; line++) {
    if (isUnprovenSnapshotRow(buffer[line])) return null;
  }
  let text = "";
  const columns: number[] = [];
  const printedCwds: (string | null)[] = [];
  const rowStarts: number[] = [];
  let clickOffset = -1;
  for (let line = first; line <= last; line++) {
    rowStarts.push(text.length);
    const leading = line === first ? 0 : continuationGaps(buffer[line - 1], buffer[line]) & CONTINUATION_MARGIN_MASK;
    const trailing = line === last ? 0 : continuationGaps(buffer[line], buffer[line + 1]) >> CONTINUATION_MARGIN_BITS;
    buffer[line].forEach((cell, col) => {
      if (col < leading || col >= buffer[line].length - trailing) return;
      if (line === point.row && col === point.col) {
        // A wide glyph's trailing cell has no text of its own, but is clickable.
        clickOffset = cell.char ? text.length :
          col > 0 && buffer[line][col - 1].char
            ? text.length - buffer[line][col - 1].char.length : -1;
      }
      for (let i = 0; i < cell.char.length; i++) {
        columns.push(col);
        printedCwds.push(printedDirectoryUri(cell));
      }
      text += cell.char;
    });
  }
  rowStarts.push(text.length);
  if (text.length > 4096) return null;
  const printedCwd = (start: number, end: number): string | null => {
    if (!cwdUri) return null;
    let directory: string | null = null;
    for (let index = start; index < end; index++) {
      if (!text[index].trim()) continue;
      const cellDirectory = printedCwds[index];
      if (!cellDirectory || (directory && directory !== cellDirectory)) return null;
      directory = cellDirectory;
    }
    return directory;
  };
  const trimPlainPathSuffix = (value: string) => {
    let candidate = value.replace(/[,;]+$/, "");
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    while (pairs[candidate.at(-1)!]) {
      const close = candidate.at(-1)!;
      const count = (char: string) => [...candidate].filter(part => part === char).length;
      if (count(close) <= count(pairs[close])) break;
      candidate = candidate.slice(0, -1);
    }
    return candidate;
  };
  // Quoted paths may contain spaces. Unquoted paths stop at whitespace/prose delimiters.
  const tokens = /"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s<>"'`]+/g;
  for (const match of text.matchAll(tokens)) {
    let candidate = match[0];
    let offset = match.index!;
    const quoted = /^["'`]/.test(candidate);
    if (quoted) { candidate = candidate.slice(1, -1); offset++; }
    else {
      const leading = candidate.match(/^[([{]+/)?.[0].length ?? 0;
      candidate = trimPlainPathSuffix(candidate.slice(leading));
      offset += leading;
    }
    const endOffset = offset + candidate.length;
    if (clickOffset < offset || clickOffset >= endOffset) continue;
    if (!quoted) {
      // The fallback token regex can see a fragment inside an unterminated
      // quoted path when a wrap could not be reconstructed. Do not open it.
      let openQuote = "";
      for (let i = 0; i < offset; i++) {
        const char = text[i];
        if (!openQuote && (char === '"' || char === "'" || char === "`")) openQuote = char;
        else if (char === openQuote) openQuote = "";
      }
      if (openQuote) continue;
      if (first > 0 && offset <= 1) {
        // If a quoted filename could not be joined, its next-row fragment
        // must not be mistaken for a fresh standalone path.
        let previousQuote = "";
        for (const cell of buffer[first - 1]) {
          for (const char of cell.char) {
            if (!previousQuote && (char === '"' || char === "'" || char === "`")) previousQuote = char;
            else if (char === previousQuote) previousQuote = "";
          }
        }
        if (previousQuote) continue;
      }
    }
    // A bounded scan must not offer a seemingly complete first/last fragment.
    // The last cell can be a skipped-looking right margin, not part of the token.
    const before = first > 0 ? continuationGaps(buffer[first - 1], buffer[first]) : -1;
    const after = last + 1 < buffer.length ? continuationGaps(buffer[last], buffer[last + 1]) : -1;
    if ((before >= 0 && /^[ ([{"'`]*$/.test(text.slice(0, offset))) ||
        (after >= 0 && /^[)\]},;."'`]* ?$/.test(text.slice(endOffset)))) continue;
    const resolvedPath = resolveTerminalPath(candidate, printedCwd(offset, endOffset));
    const wholePath = resolvedPath ?? unresolvedRelativePath(candidate);
    const requiresLookup = !resolvedPath && wholePath !== null;
    const firstTokenRow = rowStarts.findIndex((start, index) =>
      index < rowStarts.length - 1 && offset < rowStarts[index + 1]);
    const lastTokenRow = rowStarts.findIndex((start, index) =>
      index < rowStarts.length - 1 &&
        (quoted ? match.index! + match[0].length : endOffset) <= rowStarts[index + 1]);
    // A hyperlink may start or end in the next visual row. If it prevents
    // joining, a boundary fragment is not a safe standalone path either.
    const tokenLastLine = first + lastTokenRow;
    const tokenLastRow = buffer[tokenLastLine];
    let rightCol = tokenLastRow.length - 1;
    while (rightCol > 0 && tokenLastRow[rightCol].char === " ") rightCol--;
    if (tokenLastRow[rightCol]?.char === "") rightCol--;
    if (columns[match.index! + match[0].length - 1] === rightCol &&
      tokenLastLine + 1 < buffer.length &&
      continuationGaps(tokenLastRow, buffer[tokenLastLine + 1]) < 0 &&
      continuationGaps(tokenLastRow, buffer[tokenLastLine + 1], true) >= 0) continue;
    if (hasReflowOutgoingContent(tokenLastRow) &&
      (tokenLastLine + 1 >= buffer.length ||
        !isReflowContinuation(tokenLastRow, buffer[tokenLastLine + 1]) ||
        continuationGaps(tokenLastRow, buffer[tokenLastLine + 1]) < 0)) continue;
    if (columns[match.index! + match[0].length - 1] === rightCol &&
      tokenLastLine + 1 < buffer.length &&
      isUnprovenSnapshotRow(buffer[tokenLastLine + 1]) &&
      (continuationGaps(tokenLastRow, buffer[tokenLastLine + 1], true) >= 0 ||
        rightCol >= tokenLastRow.length - 2)) continue;
    const tokenFirstLine = first + firstTokenRow;
    const tokenFirstRow = buffer[tokenFirstLine];
    const leftCol = leadingSpaces(tokenFirstRow);
    if (columns[match.index!] === leftCol && tokenFirstLine > 0 &&
      continuationGaps(buffer[tokenFirstLine - 1], tokenFirstRow) < 0 &&
      continuationGaps(buffer[tokenFirstLine - 1], tokenFirstRow, true) >= 0) continue;
    if (columns[match.index!] === leftCol && tokenFirstLine > 0 &&
      isUnprovenSnapshotRow(buffer[tokenFirstLine - 1])) continue;
    if (tokenFirstLine > 0 && hasReflowOutgoingContent(buffer[tokenFirstLine - 1]) &&
      !isReflowContinuation(buffer[tokenFirstLine - 1], tokenFirstRow)) continue;
    if (hasReflowIncomingContent(tokenFirstRow) &&
      (tokenFirstLine === 0 ||
        !isReflowContinuation(buffer[tokenFirstLine - 1], tokenFirstRow) ||
        continuationGaps(buffer[tokenFirstLine - 1], tokenFirstRow) < 0)) continue;
    const crossesRows = firstTokenRow !== lastTokenRow;
    if (crossesRows && quoted) {
      // A space at a visual edge could be a real quoted filename character
      // or the TUI's margin. Never silently drop that character.
      let ambiguousSpace = false;
      for (let line = first + firstTokenRow; line < first + lastTokenRow; line++) {
        if (continuationGaps(buffer[line], buffer[line + 1]) !== 0) ambiguousSpace = true;
      }
      if (ambiguousSpace) return null;
    }
    for (let line = first; line <= last; line++) {
      const start = Math.max(quoted ? match.index! : offset, rowStarts[line - first]);
      const end = Math.min(quoted ? match.index! + match[0].length : endOffset,
        rowStarts[line - first + 1]);
      // A skipped margin must not hide part of a path or a different link.
      const leading = line === first ? 0 : continuationGaps(buffer[line - 1], buffer[line]) & CONTINUATION_MARGIN_MASK;
      const trailing = line === last ? 0 : continuationGaps(buffer[line], buffer[line + 1]) >> CONTINUATION_MARGIN_BITS;
      for (let col = 0; col < leading; col++) {
        if (buffer[line][col].style.hidden || buffer[line][col].hyperlink) return null;
      }
      if (trailing) {
        for (let col = buffer[line].length - trailing; col < buffer[line].length; col++) {
          const cell = buffer[line][col];
          if (cell.char !== " " || cell.style.hidden || cell.hyperlink) return null;
        }
      }
      if (line < last && buffer[line].at(-1)?.char === "" &&
        (buffer[line].at(-1)!.style.hidden || buffer[line].at(-1)!.hyperlink)) return null;
      if (start >= end) continue;
      if (buffer[line].slice(columns[start], columns[end - 1] + 1)
        .some(cell => cell.style.hidden || cell.hyperlink)) return null;
    }
    const pointStart = rowStarts[point.row - first];
    const pointEnd = rowStarts[point.row - first + 1];
    const startCol = columns[Math.max(offset, pointStart)];
    let endCol = columns[Math.min(endOffset, pointEnd) - 1];
    if (startCol === undefined || endCol === undefined) continue;
    while (endCol + 1 < row.length && row[endCol + 1].char === "") endCol++;
    if (!crossesRows) {
      if (!wholePath) continue;
      const withoutLine = /:\d+(?::\d+)?$/.test(candidate)
        ? resolveTerminalPath(candidate.replace(/:\d+(?::\d+)?$/, ""),
          printedCwd(offset, endOffset)) ??
          (requiresLookup ? unresolvedRelativePath(candidate.replace(/:\d+(?::\d+)?$/, "")) : null)
        : null;
      return { path: wholePath, startCol, endCol,
        ...(requiresLookup ? { alternativePath: withoutLine, choiceReason: "relative-path" as const }
          : withoutLine && withoutLine !== wholePath
            ? { alternativePath: withoutLine, choiceReason: "source-location" as const }
            : {}) };
    }
    const firstRowEnd = rowStarts[firstTokenRow + 1];
    const firstRowText = text.slice(offset, firstRowEnd);
    const alternativePath = resolveTerminalPath(
      quoted ? firstRowText : trimPlainPathSuffix(firstRowText),
      printedCwd(offset, firstRowEnd)) ??
      (requiresLookup ? unresolvedRelativePath(quoted ? firstRowText : trimPlainPathSuffix(firstRowText)) : null);
    // Hard newlines and TUI-internal wraps look identical. Preserve every
    // plausible starting/stopping row rather than just maximal joins.
    if (lastTokenRow - firstTokenRow > 32) return null;
    const clickTokenRow = point.row - first;
    const candidates: string[] = [];
    let tooManyCandidates = false;
    const addCandidate = (start: number, end: number) => {
      const rawText = text.slice(start, end);
      const raw = quoted ? rawText : trimPlainPathSuffix(rawText);
      const withoutLine = raw.replace(/:\d+(?::\d+)?$/, "");
      for (const variant of withoutLine === raw ? [raw] : [raw, withoutLine]) {
        const resolved = resolveTerminalPath(variant, printedCwd(start, end)) ??
          (requiresLookup ? unresolvedRelativePath(variant) : null);
        if (resolved && resolved !== alternativePath && resolved !== wholePath &&
          !candidates.includes(resolved)) {
          if (candidates.length === 32) tooManyCandidates = true;
          else candidates.push(resolved);
        }
      }
    };
    addCandidate(offset, endOffset);
    for (let line = firstTokenRow + 1; line < lastTokenRow && !tooManyCandidates; line++) {
      if (line >= clickTokenRow) addCandidate(offset, rowStarts[line + 1]);
    }
    for (let start = firstTokenRow + 1; start <= clickTokenRow && !tooManyCandidates; start++) {
      const rowStart = rowStarts[start];
      const wrapperLength = text.slice(rowStart, endOffset).match(/^[([{]+/)?.[0].length ?? 0;
      const startOffset = rowStart + wrapperLength;
      const suffix = text.slice(startOffset, endOffset);
      if (!resolveTerminalPath(suffix, printedCwd(startOffset, endOffset)) &&
        !(requiresLookup && unresolvedRelativePath(suffix))) continue;
      for (let endRow = clickTokenRow; endRow <= lastTokenRow && !tooManyCandidates; endRow++) {
        const end = endRow === lastTokenRow ? endOffset : rowStarts[endRow + 1];
        addCandidate(startOffset, end);
      }
    }
    if (tooManyCandidates) return null;
    let path = wholePath ?? candidates.shift();
    if (requiresLookup) {
      const absoluteIndex = candidates.findIndex(value => ABSOLUTE.test(value) || value.startsWith("~/"));
      if (absoluteIndex >= 0) {
        path = candidates.splice(absoluteIndex, 1)[0];
        if (wholePath) {
          if (candidates.length === 32) return null;
          candidates.unshift(wholePath);
        }
      }
    }
    if (!path) continue;
    return { path, startCol, endCol, alternativePath,
      ...(requiresLookup ? { choiceReason: "relative-path" as const } : {}),
      ...(candidates.length ? { intermediatePaths: candidates } : {}) };
  }
  return null;
}
