import { hasCompleteReflowIncomingContent, hasReflowIncomingContent, hasReflowOutgoingContent, hasRetainedPlainUrlBreak, hasUnprovenPathCells, isReflowContinuation, isUnprovenSnapshotRow, reflowContinuationEnd, TERMINAL_URL_TOKEN_SEPARATOR as TOKEN_SEPARATOR, type Cell } from "./ansi-parser";
import { CONTINUATION_MARGIN_BITS, CONTINUATION_MARGIN_MASK, findInTerminalLinkPane, findRenderedTerminalLabel, terminalLinkContinuationGaps, touchesTerminalPaneCut, type TerminalLinkPane } from "./terminal-rendered-links";
import { isUrlListDelimiter, paneSchemeOwner, WEB_SCHEME } from "./terminal-url-syntax";

export interface TerminalUrlMatch {
  url: string;
  startCol: number;
  endCol: number;
}

export interface SafeTerminalUrl {
  url: string;
  origin: string;
}

const URL_START = /https?:\/\//gi;
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

// A displayed destination on a new hard row is not query syntax belonging to
// the previous row. Bare web schemes need a separate ownership decision.
const DISPLAYED_TARGET = /^(?:!?\[[^\]\r\n]*\]\(|[([{]+)?([a-z][a-z\d+.-]*:(?:\/\/)?|(?:~|\.\.?)?\/)/i;

// A suffix such as `p://host` or `/host` can look like a new URI/path when
// this very boundary bisects the scheme of an explicit query value.
function cutsQueryScheme(text: string, at: number, end: number): boolean {
  const left = Math.max(0, at - 7); // Longest partial `https://` on either side.
  const scheme = /https?:\/\//i.exec(text.slice(left, Math.min(end, at + 7)));
  if (!scheme) return false;
  const start = left + scheme.index;
  return start < at && start + scheme[0].length > at &&
    (text[start - 1] === "=" || text[start - 1] === "+" || text.slice(Math.max(0, start - 3), start) === "%20");
}

// A bare word after a URL could just be the next status line. Only infer a
// plain pane wrap when the continuation participates in visible query syntax.
// Do not count the query of a subsequent, independently displayed URL as proof.
function queryEvidenceEnd(uri: string): number {
  const query = uri.search(/[?#]/);
  if (query < 0 || uri[query] !== "?") return -1;
  // Do not count a nested URI's own query or fragment as outer field syntax.
  const stop = uri.slice(query + 1).search(/[?#]/);
  const fields = stop < 0 ? uri.slice(query) : uri.slice(query, query + 1 + stop);
  const field = /[?&][\w~.-]+=([^&]*)/y;
  const valueSyntax = /%[\da-f]{2}|[\w~.-]\+(?=[\w~.-])/gi;
  let end = -1;
  while (field.lastIndex < fields.length) {
    const match = field.exec(fields);
    if (!match) return -1;
    const value = match[1];
    // Plain values may be encoded words or lists of HTTP(S) URIs. A slash
    // or colon in an unrelated filename/scheme does not prove a query wrap.
    const nested = /(?:^|%20|\+)https?:\/\//i.exec(value);
    if (!/^(?:[\w~.+-]|%[\da-f]{2})*$/i.test(nested ? value.slice(0, nested.index) : value)) return -1;
    const valueStart = query + field.lastIndex - value.length;
    end = valueStart;
    while (valueSyntax.exec(value)) end = valueStart + valueSyntax.lastIndex;
  }
  return end;
}

function hasRenderedUrlLabel(buffer: Cell[][], row: number, col: number, pane?: TerminalLinkPane): boolean {
  for (let y = Math.max(0, row - 1); y <= row; y++) {
    const cells = buffer[y];
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x], previous = cells[x - 1];
      if (!cell.style.underline || cell.style.hidden || cell.hyperlink ||
        (previous?.style.underline && !previous.style.hidden && !previous.hyperlink)) continue;
      if (findRenderedTerminalLabel(buffer, { row: y, col: x }, pane?.hasDivider === true, target =>
        target.row === row && target.col === col ? { startCol: col, endCol: col } : null, pane?.cutBottom)) return true;
    }
  }
  return false;
}

function visibleRange(row: Cell[], start: number, end: number, plainUrl: boolean, spacesOnly = false, newOwner?: Cell): boolean {
  if (start >= end) return true;
  if (isUnprovenSnapshotRow(row) || hasUnprovenPathCells(row, start, end, plainUrl, newOwner)) return false;
  for (let col = start; col < end; col++) {
    const cell = row[col];
    if (cell.style.hidden || cell.hyperlink || (spacesOnly && cell.char !== " ")) return false;
  }
  return true;
}

function findUrlInRows(
  buffer: Cell[][], point: { row: number; col: number }, pane?: TerminalLinkPane, fromLabel = false,
): TerminalUrlMatch | null {
  const panePadding = pane?.hasDivider === true;
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
  let textEndCol = point.col + 1;
  let first = point.row, last = point.row, length = row.length;
  while (first > 0 && length + buffer[first - 1].length <= 4096 &&
    point.row - first + 1 < 32) {
    const spacing = gaps(buffer[first - 1], buffer[first]);
    if (spacing < 0) break;
    // A literal token separator makes earlier rows irrelevant. Trim only the
    // geometric margins here, not a real space inside a soft-wrapped token.
    const margin = spacing & CONTINUATION_MARGIN_MASK;
    let separated = false;
    for (let col = margin; col < textEndCol; col++) {
      if (TOKEN_SEPARATOR.test(buffer[first][col].char)) { separated = true; break; }
    }
    if (separated) break;
    textEndCol = buffer[first - 1].length - (spacing >> CONTINUATION_MARGIN_BITS);
    first--;
    length += buffer[first].length;
  }
  const priorGap = first > 0 ? gaps(buffer[first - 1], buffer[first], true) : -1;
  while (last + 1 < buffer.length && length + buffer[last + 1].length <= 4096 &&
    last - first + 1 < 32 && gaps(buffer[last], buffer[last + 1]) >= 0) {
    last++;
    length += buffer[last].length;
  }
  let text = "", clickOffset = -1;
  const columns: number[] = [], rowStarts: number[] = [], joins: number[] = [];
  for (let line = first; line <= last; line++) {
    rowStarts.push(text.length);
    const leading = line === first ? 0 : joins[line - first - 1] & CONTINUATION_MARGIN_MASK;
    const spacing = line === last ? 0 : gaps(buffer[line], buffer[line + 1]);
    if (line < last) joins.push(spacing);
    const trailing = spacing >> CONTINUATION_MARGIN_BITS;
    const cells = buffer[line];
    for (let col = leading; col < cells.length - trailing; col++) {
      const cell = cells[col];
      if (text.length + cell.char.length > 4096) return null;
      if (line === point.row && col === point.col) {
        clickOffset = cell.char ? text.length :
          col > 0 && buffer[line][col - 1].char ? text.length - buffer[line][col - 1].char.length : -1;
      }
      for (let offset = 0; offset < cell.char.length; offset++) columns.push(col);
      text += cell.char;
    }
  }
  rowStarts.push(text.length);
  if (clickOffset < 0 || TOKEN_SEPARATOR.test(text[clickOffset])) return null;
  let start = clickOffset, limit = clickOffset + 1;
  while (start > 0 && !TOKEN_SEPARATOR.test(text[start - 1])) start--;
  while (limit < text.length && !TOKEN_SEPARATOR.test(text[limit])) limit++;
  const rowAt = (index: number) => rowStarts.findIndex((_, line) => index < rowStarts[line + 1]);
  const visibleText = (from: number, to: number, newOwner?: Cell): boolean => {
    if (from >= to) return true;
    for (let i = rowAt(from); i >= 0 && rowStarts[i] < to; i++) {
      const cells = buffer[first + i];
      const left = columns[Math.max(from, rowStarts[i])];
      let right = columns[Math.min(to, rowStarts[i + 1]) - 1] + 1;
      while (right < cells.length && cells[right].char === "") right++;
      if (!visibleRange(cells, left, right, !renderedTarget, false, newOwner)) return false;
    }
    return true;
  };
  const firstScheme = (from: number): number => {
    URL_START.lastIndex = from;
    const match = URL_START.exec(text);
    return match && match.index < limit ? match.index : -1;
  };
  let offset = fromLabel ? clickOffset : firstScheme(start);
  if (offset < 0 || (fromLabel && !WEB_SCHEME.test(text.slice(offset, offset + 8)))) return null;
  const initialStart = start, initialOffset = offset;
  let renderedTarget = fromLabel, opener = -1, close = -1, afterClosedTarget = false;
  // A visible `( URL )` belongs to this target, not to the next row's
  // heuristic. Partition on its balanced closer before interpreting wraps.
  const delimitTarget = (): boolean => {
    while (offset >= 0) {
      opener = offset - 1;
      while (opener >= 0 && text[opener] === " ") opener--;
      if (text[opener] !== "(") opener = -1;
      renderedTarget = fromLabel || (opener >= 0 && hasRenderedUrlLabel(buffer, first + rowAt(offset), columns[offset], pane));
      close = -1;
      if (opener < 0 && !fromLabel) return true;
      if (opener >= 0 && !visibleText(opener, offset)) return false;
      let depth = 0;
      for (let pos = offset; pos < limit; pos++) {
        if (text[pos] !== "(" && text[pos] !== ")") continue;
        if (!visibleText(pos, pos + 1)) return false;
        if (text[pos] === "(") depth++;
        else if (depth-- === 0) { close = pos; break; }
      }
      if (close < 0) return true;
      if (clickOffset < close) { limit = close; return true; }
      if (fromLabel || clickOffset === close) return false;
      const following = firstScheme(close + 1);
      if (following < 0 || !rowStarts.some((boundary, i) => i > 0 && boundary > close && boundary <= following &&
        !isReflowContinuation(buffer[first + i - 1], buffer[first + i]))) return false;
      start = close + 1;
      afterClosedTarget = true;
      offset = following;
    }
    return false;
  };
  if (!delimitTarget()) return null;
  let rightGutter = 2;
  if (panePadding && !renderedTarget) {
    // A visible inked column cannot be common padding, even when that ink
    // belongs to an unrelated OSC 8 link. Concealed/stale ink is not proof.
    for (let line = first; line <= last && rightGutter; line++) {
      const cells = buffer[line];
      if (isUnprovenSnapshotRow(cells)) continue;
      for (let n = 0; n < rightGutter && n < cells.length; n++) {
        const col = cells.length - 1 - n, head = cells[col].char === "" ? col - 1 : col;
        if (head >= 0 && cells[head].char.trim() && !cells[head].style.hidden && !cells[col].style.hidden &&
          !hasUnprovenPathCells(cells, head, col + 1, true)) rightGutter = n;
      }
    }
  }
  const physicalBreak = (line: number, spacing: number): boolean => {
    const before = buffer[line], after = buffer[line + 1];
    if (renderedTarget || isReflowContinuation(before, after)) return false;
    const leading = spacing & CONTINUATION_MARGIN_MASK;
    return hasRetainedPlainUrlBreak(before, after) || (panePadding && spacing >= 0 &&
      (spacing >> CONTINUATION_MARGIN_BITS) > Math.min(rightGutter, Math.max(1, leading)));
  };
  const visibleMargins = (line: number, spacing: number): boolean =>
    spacing < 0 || (visibleRange(buffer[line], buffer[line].length - (spacing >> CONTINUATION_MARGIN_BITS), buffer[line].length, !renderedTarget, true) &&
      visibleRange(buffer[line + 1], 0, spacing & CONTINUATION_MARGIN_MASK, !renderedTarget, true));
  let separatedStart = first > 0 && physicalBreak(first - 1, priorGap);
  let separatedEnd = false, uncertain = separatedStart && !visibleMargins(first - 1, priorGap);
  // A clipped prefix can own a later row-initial scheme, even if no part of
  // the outer scheme is left. Carry that uncertainty until a visible break.
  if (!separatedStart && initialStart < rowStarts[1]) {
    if (first === 0) {
      uncertain = touchesTerminalPaneCut(pane, buffer[0], columns[Math.min(initialOffset, rowStarts[1] - 1)], true);
    } else if (priorGap >= 0 && initialStart <= (priorGap & CONTINUATION_MARGIN_MASK) &&
      (panePadding || isReflowContinuation(buffer[first - 1], buffer[first]))) {
      uncertain = true;
    }
  }
  if (initialStart > 0 && !visibleText(initialStart - 1, initialStart)) uncertain = true;
  if (afterClosedTarget && !uncertain) separatedStart = true;
  // Partition the clicked token before using any query evidence. A bad or
  // ambiguous pair cannot disable a later, independently separated target.
  let nestedValueJoins = 0;
  for (let i = 0; !renderedTarget && i < joins.length; i++) {
    const at = rowStarts[i + 1], line = first + i, spacing = joins[i];
    if (at < start || at >= limit || isReflowContinuation(buffer[line], buffer[line + 1])) continue;
    let split = physicalBreak(line, spacing);
    if (at === start && !split) continue;
    let valid = visibleMargins(line, spacing);
    let nonWebTarget = false;
    if (!split && panePadding) {
      const next = text.slice(at, rowStarts[i + 2]);
      const web = WEB_SCHEME.exec(next);
      if (web) {
        // A list delimiter separates this link even if the preceding pair
        // was ambiguous. An unknown head is not itself a usable outer URI.
        if (isUrlListDelimiter(text[at - 1])) {
          split = true;
          valid &&= spacing > 0 && visibleText(at - 1, at + web[0].length);
        } else if (!uncertain && offset >= 0 && offset < at) {
          const owner = paneSchemeOwner(text.slice(offset, at), next.slice(0, limit - at));
          if (owner === "unknown") { uncertain = true; continue; }
          if (owner === "outer") { nestedValueJoins |= 1 << i; continue; }
          split = true;
          const newOwner = clickOffset >= at ? buffer[line + 1][columns[at]] : undefined;
          valid &&= spacing > 0 && visibleText(offset, at, newOwner) && visibleText(at, at + web[0].length);
        } else continue;
      } else {
        const target = DISPLAYED_TARGET.exec(next);
        if (target) {
          if (cutsQueryScheme(text, at, limit)) continue;
          nonWebTarget = !WEB_SCHEME.test(target[1]);
          if (target[0] === target[1] && nonWebTarget && target[1].endsWith(":")) {
            // The apparent scheme may be the rest of host:port inside a redirect.
            const prefix = offset < at && offset >= 0 ? text.slice(offset, at) : "";
            if (/(?:=|\+|%20)https?:\/\/[\w.-]*$/i.test(prefix) &&
              /^[\w.-]+:\d+(?:[/?#&]|$)/.test(next)) continue;
            if (prefix.includes("?") && !/^\w[\w.+-]*:\s/.test(next)) { uncertain = true; continue; }
          }
          // A bare path at this position might be the rest of a URI-valued
          // field. Neither its path escapes nor its first slash settle that.
          const attached = target[0] === target[1] && offset >= 0 && offset < at &&
            (target[1] === "/" ? text.slice(offset, at).includes("?") :
              paneSchemeOwner(text.slice(offset, at), target[0]) !== "separate");
          if (attached) { uncertain = true; continue; }
          split = true;
          valid &&= spacing > 0 && visibleText(at, at + target[0].length);
        }
      }
    }
    if (!split && !uncertain && offset >= 0 && offset < at && (!panePadding || !text.slice(offset, at).includes("?"))) {
      // Without a query (or without a pane), only a real terminal soft wrap
      // can extend the URL. Preserve ordinary visibly spaced hard newlines.
      split = true;
      valid &&= spacing > 0;
    }
    if (!split) continue;
    if (at > clickOffset) {
      separatedEnd = true;
      limit = at;
      uncertain ||= !valid;
      break;
    }
    separatedStart = true;
    start = at;
    uncertain = !valid || nonWebTarget;
    offset = firstScheme(start);
    if (!uncertain && offset >= 0 && !delimitTarget()) return null;
  }
  if (uncertain || offset < 0 || clickOffset < offset || offset >= limit) return null;
  const root = rowAt(offset);
  const firstLine = first + root;
  const candidate = text.slice(offset, limit);
  const authority = panePadding && /^ *$/.test(text.slice(rowStarts[root], offset))
    ? /^https?:\/\/[^/\\?#]+[/#?]/i.exec(candidate) : null;
  const query = candidate.indexOf("?");
  let evidenceEnd: number | undefined, paneSpacing: number | undefined;
  for (let i = root; !renderedTarget && i < joins.length; i++) {
    const at = rowStarts[i + 1] - offset;
    if (at >= candidate.length) break;
    if (isReflowContinuation(buffer[first + i], buffer[first + i + 1])) continue;
    if (!authority || authority[0].length > at || query < 0 || query >= at ||
      (paneSpacing !== undefined && paneSpacing !== joins[i])) return null;
    evidenceEnd ??= queryEvidenceEnd(candidate);
    if (evidenceEnd < 0 || (evidenceEnd <= at && !(nestedValueJoins & (1 << i)))) return null;
    paneSpacing = joins[i];
  }
  const closedParenthesis = close === limit;
  const url = trimUrlCandidate(candidate);
  const end = offset + url.length, stop = offset + candidate.length;
  if (!url || clickOffset >= end || !visibleText(offset, stop)) return null;
  const tail = rowAt(stop - 1), lastLine = first + tail;
  if (!closedParenthesis && last === buffer.length - 1 && stop > rowStarts[last - first] &&
    touchesTerminalPaneCut(pane, buffer[last], columns[stop - 1], false)) return null;
  if (!closedParenthesis && !separatedEnd && stop < text.length && TOKEN_SEPARATOR.test(text[stop]) &&
    !visibleText(stop, stop + 1)) return null;
  // A window edge or a blocked OSC 8 span is not a terminator. The same
  // physical break that partitions retained rows also terminates at the limit.
  const literalStart = offset > rowStarts[root] && TOKEN_SEPARATOR.test(text[offset - 1]) &&
    visibleText(offset - 1, offset);
  if (root === 0 && priorGap >= 0 && !separatedStart && !literalStart &&
    /^[ ([{"'`]*$/.test(text.slice(0, offset))) return null;
  if (lastLine === last && last + 1 < buffer.length && !separatedEnd && !closedParenthesis &&
    /^ *$/.test(text.slice(stop, rowStarts[tail + 1]))) {
    const after = gaps(buffer[last], buffer[last + 1], true);
    if (after >= 0 && (!physicalBreak(last, after) || !visibleMargins(last, after))) return null;
  }
  if (hasReflowIncomingContent(buffer[firstLine]) &&
    (firstLine === 0 || !isReflowContinuation(buffer[firstLine - 1], buffer[firstLine]) ||
      gaps(buffer[firstLine - 1], buffer[firstLine]) < 0)) return null;
  if (hasReflowOutgoingContent(buffer[lastLine]) &&
    (lastLine + 1 === buffer.length || !isReflowContinuation(buffer[lastLine], buffer[lastLine + 1]) ||
      gaps(buffer[lastLine], buffer[lastLine + 1]) < 0)) return null;
  const syntaxStart = opener >= 0 ? rowAt(opener) : root;
  const syntaxEnd = closedParenthesis ? rowAt(stop) : tail;
  for (let i = syntaxStart; i < syntaxEnd; i++) {
    if (!visibleMargins(first + i, joins[i])) return null;
  }
  const pointStart = rowStarts[point.row - first], pointEnd = rowStarts[point.row - first + 1];
  const startCol = columns[Math.max(offset, pointStart)];
  let endCol = columns[Math.min(end, pointEnd) - 1];
  while (endCol + 1 < row.length && row[endCol + 1].char === "") endCol++;
  const safeUrl = validateTerminalUrl(url);
  return safeUrl ? { url: safeUrl.url, startCol, endCol } : null;
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

  return findInTerminalLinkPane(buffer, point, (rows, localPoint, pane) => {
    const rendered = findRenderedTerminalLabel(rows, localPoint, pane?.hasDivider === true,
      target => findUrlInRows(rows, target, pane, true), pane?.cutBottom);
    return rendered === undefined ? findUrlInRows(rows, localPoint, pane) : rendered;
  });
}
