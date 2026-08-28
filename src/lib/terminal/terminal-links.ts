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

export function findUrlAtCell(
  buffer: Cell[][],
  point: { row: number; col: number },
): TerminalUrlMatch | null {
  const row = buffer[point.row];
  if (!row || point.col < 0) return null;

  const text = row.map((cell) => cell.char || " ").join("");
  URL_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index === undefined) continue;

    const url = trimUrlCandidate(match[0]);
    if (!url) continue;

    const startCol = match.index;
    const candidateEndCol = startCol + match[0].length - 1;
    const endCol = startCol + url.length - 1;
    const nextRow = buffer[point.row + 1];
    if (candidateEndCol >= row.length - 1 && nextRow) {
      const nextText = nextRow.map((cell) => cell.char || " ").join("");
      if (URL_CONTINUATION_PATTERN.test(nextText[0] ?? "")) continue;
    }

    if (point.col >= startCol && point.col <= endCol) {
      if (row.slice(startCol, endCol + 1).some((cell) => cell.style.hidden)) {
        return null;
      }
      const safeUrl = validateTerminalUrl(url);
      return safeUrl ? { url: safeUrl.url, startCol, endCol } : null;
    }
  }

  return null;
}
