import type { Cell } from "./ansi-parser";
import { cutsQueryScheme, DISPLAYED_TARGET, paneSchemeOwner, TERMINAL_URL_TOKEN_SEPARATOR, WEB_SCHEME } from "./terminal-url-syntax";

export interface TerminalCodeBlock {
  first: number; last: number; end: number; lastEnd: number; uri: string;
}

// OMP indents the Markdown fences by one cell, but prints literal code flush
// left at the Markdown content width. Herdr reserves one more column when
// the pane runs to the right edge of the terminal instead of a visible wall.
export function findTerminalCodeBlock(
  rows: Cell[][], row: number, left: number, right: number, viewportGutter: boolean, allowSingleRow = false,
): TerminalCodeBlock | undefined {
  const width = right - left;
  const limit = Math.min(32, Math.floor(4096 / width));
  if (width < 12 || limit < 2 || rows[row]?.[left]?.char === " ") return;
  const fence = (cells: Cell[] | undefined, opening: boolean): boolean => {
    if (!cells || cells.length < right || cells[left].char !== " " ||
      cells[left + 1].char !== "`" || cells[left + 2].char !== "`" || cells[left + 3].char !== "`") return false;
    let col = left + 4;
    if (opening) while (col < right && /^[\w+#.-]$/.test(cells[col].char)) col++;
    while (col < right && cells[col].char === " ") col++;
    return col === right;
  };
  let first = row, last = row;
  while (first > 0 && rows[first - 1][left]?.char !== " " && row - first + 1 < limit) first--;
  if (!fence(rows[first - 1], true)) return;
  // Only a standalone web address uses this layout, not arbitrary code or a
  // Markdown example containing several commands.
  const head = rows[first];
  if (!/^[hH]$/.test(head[left]?.char)) return;
  while (last + 1 < rows.length && rows[last + 1][left]?.char !== " " && last - first + 1 < limit) last++;
  if ((!allowSingleRow && first === last) || !fence(rows[last + 1], false)) return;
  const end = right - 2 - (viewportGutter ? 1 : 0);
  let lastEnd = end, uri = "";
  const boundaries: number[] = [];
  for (let y = first; y <= last; y++) {
    const cells = rows[y];
    if (cells.length < right) return;
    let stop = right;
    while (stop > left && cells[stop - 1].char === " ") stop--;
    // A spare content column is a real line break, not part of the gutter.
    if (stop <= left || stop > end || (y < last && stop !== end)) return;
    let fragment = "";
    for (let x = left; x < stop; x++) {
      const ch = cells[x].char;
      if (TERMINAL_URL_TOKEN_SEPARATOR.test(ch) || uri.length + fragment.length + ch.length > 4096) return;
      fragment += ch;
    }
    if (y === first) {
      if (!/^https?:\/\/[^/\\?#]+[/#?]/i.test(fragment)) return;
    } else {
      boundaries.push(uri.length);
    }
    uri += fragment;
    lastEnd = stop;
  }
  for (const at of boundaries) {
    const next = uri.slice(at), target = DISPLAYED_TARGET.exec(next);
    if (!target || cutsQueryScheme(uri, at, uri.length)) continue;
    if (target[0] !== target[1]) return; // An independently displayed Markdown/parenthesized target.
    const prefix = uri.slice(0, at);
    if (WEB_SCHEME.test(next) && paneSchemeOwner(prefix, next) === "outer") continue;
    // A slash after the host in a URI-valued field is its path, not a new file.
    const field = prefix.slice(Math.max(prefix.lastIndexOf("?"), prefix.lastIndexOf("&")) + 1);
    if (prefix.includes("?") && /(?:=|%20|\+)https?:\/\/[^&#?]*$/i.test(field) &&
      (target[1] === "/" || /^[\w.-]+:\d+(?:[/?#&]|$)/.test(next))) continue;
    return;
  }
  return { first, last, end, lastEnd, uri };
}

/** Cells that establish the link, including its gutters between fragments
 * but only the first real delimiter after the final fragment or a fence. */
export function terminalCodeBlockRowEnd(
  row: Cell[], y: number, left: number, right: number, block: { first: number; last: number; lastEnd: number },
): number {
  if (y === block.last) return Math.min(block.lastEnd + 1, right);
  if (y >= block.first && y < block.last) return right;
  let end = left + 4;
  while (end < right && row[end].char !== " ") end++;
  return Math.min(end + 1, right);
}
