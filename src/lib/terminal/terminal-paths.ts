import type { Cell } from "./ansi-parser";

export interface TerminalPathMatch {
  path: string;
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
      if (uri.protocol !== "file:" || uri.username || uri.password || uri.port || uri.search || uri.hash) return null;
      // The authority never selects a host. Browsing stays bound to the clicked session.
      path = decodeURIComponent(uri.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch { return null; }
  } else {
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return null;
    path = path.replace(/:\d+(?::\d+)?$/, "");
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
    if (!/^file:/i.test(explicit.uri)) return null;
    const path = resolveTerminalPath(explicit.uri);
    if (!path) return null;
    const same = (col: number) => row[col]?.hyperlink?.uri === explicit.uri && row[col]?.hyperlink?.id === explicit.id;
    let startCol = point.col, endCol = point.col;
    while (startCol > 0 && same(startCol - 1)) startCol--;
    while (endCol + 1 < row.length && same(endCol + 1)) endCol++;
    if (row.slice(startCol, endCol + 1).some(cell => cell.style.hidden)) return null;
    return { path, startCol, endCol };
  }
  let text = "";
  const columns: number[] = [];
  row.forEach((cell, col) => {
    for (let i = 0; i < cell.char.length; i++) columns.push(col);
    text += cell.char;
  });
  // Quoted paths may contain spaces. Unquoted paths stop at whitespace/prose delimiters.
  const tokens = /"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s<>"'`]+/g;
  for (const match of text.matchAll(tokens)) {
    let candidate = match[0];
    let offset = match.index!;
    if (/^["'`]/.test(candidate)) { candidate = candidate.slice(1, -1); offset++; }
    else {
      const leading = candidate.match(/^[([{]+/)?.[0].length ?? 0;
      candidate = candidate.slice(leading).replace(/[,;]+$/, "");
      const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      while (pairs[candidate.at(-1)!]) {
        const close = candidate.at(-1)!;
        const count = (char: string) => [...candidate].filter(value => value === char).length;
        if (count(close) <= count(pairs[close])) break;
        candidate = candidate.slice(0, -1);
      }
      offset += leading;
    }
    const path = resolveTerminalPath(candidate, cwdUri);
    if (!path) continue;
    const startCol = columns[offset];
    let endCol = columns[offset + candidate.length - 1];
    if (startCol === undefined || endCol === undefined) continue;
    while (endCol + 1 < row.length && row[endCol + 1].char === "") endCol++;
    // A visual-row fragment cannot identify a wrapped path reliably.
    if (endCol === row.length - 1 && buffer[point.row + 1]?.[0]?.char.trim()) continue;
    if (point.col < startCol || point.col > endCol) continue;
    if (row.slice(startCol, endCol + 1).some(cell => cell.style.hidden || cell.hyperlink)) return null;
    return { path, startCol, endCol };
  }
  return null;
}
