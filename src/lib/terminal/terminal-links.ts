import type { Cell } from "./ansi-parser";

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
const URL_CONTINUATION_PATTERN = /^[A-Za-z0-9/?#%&=._~:+-]/;
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

function mapRowTextToColumns(row: Cell[]): { text: string; columns: number[] } {
  let text = "";
  const columns: number[] = [];
  for (let col = 0; col < row.length; col++) {
    const value = row[col].char;
    if (value === "") continue;
    for (let offset = 0; offset < value.length; offset++) columns.push(col);
    text += value;
  }
  return { text, columns };
}
function includeWideContinuation(row: Cell[], col: number): number {
  while (col + 1 < row.length && row[col + 1].char === "") col++;
  return col;
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


  const { text, columns } = mapRowTextToColumns(row);
  URL_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index === undefined) continue;

    const url = trimUrlCandidate(match[0]);
    if (!url) continue;

    const startCol = columns[match.index];
    const candidateEndOffset = columns[match.index + match[0].length - 1];
    const endOffset = columns[match.index + url.length - 1];
    if (startCol === undefined || candidateEndOffset === undefined || endOffset === undefined) continue;
    const candidateEndCol = includeWideContinuation(row, candidateEndOffset);
    const endCol = includeWideContinuation(row, endOffset);

    const nextRow = buffer[point.row + 1];
    if (candidateEndCol >= row.length - 1 && nextRow) {
      const { text: nextText } = mapRowTextToColumns(nextRow);
      if (URL_CONTINUATION_PATTERN.test(nextText[0] ?? "")) continue;
    }

    if (point.col >= startCol && point.col <= endCol) {
      if (row.slice(startCol, endCol + 1).some((cell) => cell.style.hidden)) return null;
      const safeUrl = validateTerminalUrl(url);
      return safeUrl ? { url: safeUrl.url, startCol, endCol } : null;
    }
  }

  return null;
}
