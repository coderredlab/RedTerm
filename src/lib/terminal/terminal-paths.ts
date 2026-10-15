import { hasReflowIncomingContent, hasReflowOutgoingContent, isReflowContinuation, isReflowTail, isUnprovenSnapshotRow, printedDirectoryUri, reflowContinuationEnd, type Cell } from "./ansi-parser";

export interface TerminalPathMatch {
  path: string;
  /** Present only for a textual path spanning rows: the first-row standalone choice, if valid. */
  alternativePath?: string | null;
  /** Other valid targets ending or starting at an ambiguous visual row. */
  intermediatePaths?: string[];
  choiceReason?: "source-location";
  startCol: number;
  endCol: number;
}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;

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

export function findPathAtCell(
  buffer: Cell[][],
  point: { row: number; col: number },
  cwdUri: string | null = null,
): TerminalPathMatch | null {
  const row = buffer[point.row];
  if (!row || point.col < 0 || !row[point.col]) return null;
  const explicit = row[point.col].hyperlink;
  if (explicit) {
    // OSC 8 targets are paths, not rendered text: do not infer a wrap from their label.
    // OMP emits raw absolute hrefs as well as file: URLs.
    const path = /^file:/i.test(explicit.uri)
      ? resolveTerminalPath(explicit.uri)
      : ABSOLUTE.test(explicit.uri) && explicit.uri.length <= 4096 && !UNSAFE.test(explicit.uri)
        ? /^[A-Za-z]:[\\/]/.test(explicit.uri) ? explicit.uri.replace(/\\/g, "/") : explicit.uri
        : null;
    if (!path) return null;
    const same = (col: number) => row[col]?.hyperlink?.uri === explicit.uri && row[col]?.hyperlink?.id === explicit.id;
    let startCol = point.col, endCol = point.col;
    while (startCol > 0 && same(startCol - 1)) startCol--;
    while (endCol + 1 < row.length && same(endCol + 1)) endCol++;
    if (row.slice(startCol, endCol + 1).some(cell => cell.style.hidden)) return null;
    return { path, startCol, endCol };
  }
  // Stored snapshots have no wrap ancestry. Rendered plain text with
  // surviving original cells is non-actionable; OSC 8 above is explicit.
  if (isUnprovenSnapshotRow(row)) return null;
  // A nested TUI can wrap inside the outer terminal with one padding cell
  // on the right and one indentation cell on the next row (Herdr does this).
  // Encode trailing/leading margins in bits 1/0; -1 means no continuation.
  const continuationGaps = (before: Cell[], after: Cell[], ignoreHyperlinks = false) => {
    const known = isReflowContinuation(before, after);
    const herdrTail = isReflowTail(before) && !known &&
      after[0]?.char === " " && !!after[1]?.char.trim() &&
      !isUnprovenSnapshotRow(before);
    if (isReflowTail(before) && !known && !herdrTail) return -1;
    // A reflow tail can still be the first half of a TUI-internal hard wrap.
    // Its indented next row is ambiguous and must be shown as a choice.
    if (!ignoreHyperlinks && before.length !== after.length && !known && !herdrTail) return -1;
    const continuationEnd = reflowContinuationEnd(before, after);
    let trailing = 0;
    if (continuationEnd !== null) trailing = before.length - continuationEnd;
    else if (herdrTail) {
      while (trailing < before.length && before[before.length - trailing - 1]?.char === " ") trailing++;
    } else if (before.at(-1)?.char === " " && before.at(-2)?.char.trim()) trailing = 1;
    // A wide glyph's final-column placeholder occupies the cell, not a margin.
    const lastContent = before[before.length - 1 - trailing];
    const wideEnd = lastContent?.char === "" && before.at(-2 - trailing)?.char.trim();
    const end = before[before.length - 1 - trailing - (wideEnd ? 1 : 0)];
    if (!end?.char.trim() || (!ignoreHyperlinks && end.hyperlink)) return -1;
    const leading = after[0]?.char === " " && after[1]?.char.trim() ? 1 : 0;
    return after[leading]?.char.trim() &&
      (ignoreHyperlinks || (!after[leading]?.hyperlink && (!leading || !after[0]?.hyperlink)))
      ? (trailing << 1) | leading : -1;
  };
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
    const leading = line === first ? 0 : continuationGaps(buffer[line - 1], buffer[line]) & 1;
    const trailing = line === last ? 0 : continuationGaps(buffer[line], buffer[line + 1]) >> 1;
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
    const wholePath = resolveTerminalPath(candidate, printedCwd(offset, endOffset));
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
    const leftCol = tokenFirstRow[0]?.char === " " && tokenFirstRow[1]?.char.trim() ? 1 : 0;
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
      const leading = line === first ? 0 : continuationGaps(buffer[line - 1], buffer[line]) & 1;
      const trailing = line === last ? 0 : continuationGaps(buffer[line], buffer[line + 1]) >> 1;
      if (leading && (buffer[line][0].style.hidden || buffer[line][0].hyperlink)) return null;
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
          printedCwd(offset, endOffset))
        : null;
      return { path: wholePath, startCol, endCol,
        ...(withoutLine && withoutLine !== wholePath
          ? { alternativePath: withoutLine, choiceReason: "source-location" as const }
          : {}) };
    }
    const firstRowEnd = rowStarts[firstTokenRow + 1];
    const firstRowText = text.slice(offset, firstRowEnd);
    const alternativePath = resolveTerminalPath(
      quoted ? firstRowText : trimPlainPathSuffix(firstRowText),
      printedCwd(offset, firstRowEnd));
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
        const resolved = resolveTerminalPath(variant, printedCwd(start, end));
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
      if (!/^(?:\/|~\/|file:|[A-Za-z]:[\\/])/.test(suffix) &&
        !(printedCwd(startOffset, endOffset) && /^[^\s/]+\/[^\s]/.test(suffix))) continue;
      for (let endRow = clickTokenRow; endRow <= lastTokenRow && !tooManyCandidates; endRow++) {
        const end = endRow === lastTokenRow ? endOffset : rowStarts[endRow + 1];
        addCandidate(startOffset, end);
      }
    }
    if (tooManyCandidates) return null;
    const path = wholePath ?? candidates.shift();
    if (!path) continue;
    return { path, startCol, endCol, alternativePath,
      ...(candidates.length ? { intermediatePaths: candidates } : {}) };
  }
  return null;
}
