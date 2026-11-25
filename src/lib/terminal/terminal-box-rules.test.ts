// @ts-nocheck
import { expect, test } from "bun:test";
import { AnsiParser, hasUnprovenPathCells, terminalPaneHorizontalRule } from "./ansi-parser";
import { findUrlAtCell } from "./terminal-links";
import { findPathAtCell } from "./terminal-paths";

const sidebar = "side│", wall = sidebar.length, width = 44, right = wall + width + 3;
const header = "├── Étape 2 ".padEnd(width + 3, "─") + "┤";
const floor = "╰" + "─".repeat(width + 2) + "╯";
const sync = "\x1b[?2026h", present = "\x1b[?2026l";
const position = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`;
const body = (s: string) => `│ ${s.padEnd(width)} │`;

function card(rows: string[]) {
  const parser = new AnsiParser(right + 2, rows.length);
  parser.write("\x1b[?1049h\x1b[?7l" + sync);
  rows.forEach((s, y) => parser.write(position(y, 0) + sidebar + s));
  parser.write(present);
  return parser;
}

test("titled rules terminate only their exact pane, on either side of its contents", () => {
  const a = "https://first.example.test/doc", b = "https://last.example.test/doc";
  // Each Hangul glyph takes two columns; unrelated sidebar ink is outside the cap.
  const wideTitle = "├── 구역 2 ".padEnd(width + 1, "─") + "┤";
  const rows = card([header, body(a), body(""), body(b.padStart(width)), wideTitle]).getBuffer();
  expect(findUrlAtCell(rows, { row: 1, col: wall + 8 })?.url).toBe(a);
  expect(findUrlAtCell(rows, { row: 3, col: right - 4 })?.url).toBe(b);
  for (const y of [0, 4]) {
    expect(terminalPaneHorizontalRule(rows, y, wall + 1, right)).toBe(true);
    expect(terminalPaneHorizontalRule(rows, y, wall + 4, right)).not.toBe(true);
  }
});

test("clipped caps, stray text, concealed cells and OSC 8 never prove a titled boundary", () => {
  const url = "https://inner.example.test/doc";
  for (const border of [
    header.replace("├", "X"), header.replace("┤", " "), header.replace("├", "┤"),
    header.replace("── Étape", "──XÉtape"), header.replace("Étape", "A─B C"),
    header.replace("── Étape", "──\x1b[8m \x1b[28mÉtape"),
    header.replace("Étape", "\x1b]8;;https://other.example.test/\x1b\\Étape\x1b]8;;\x1b\\"),
    header.replace("┤", "\x1b[8m┤\x1b[28m"),
  ]) {
    const rows = card([border, body(url), body(""), body(""), floor]).getBuffer();
    expect(terminalPaneHorizontalRule(rows, 0, wall + 1, right)).not.toBe(true);
    expect(findUrlAtCell(rows, { row: 1, col: wall + 8 })).toBeNull();
  }
});

test("a partly refreshed snapshot or a soft-wrapped rule-shaped row is not a separator", () => {
  const lines = [header, body("first"), body("next"), body("last")];
  const saved = card(lines), restored = new AnsiParser(right + 2, lines.length);
  restored.restoreSnapshot(saved.createSnapshot());
  restored.write(position(0, wall + 4) + "Étape 2");
  expect(terminalPaneHorizontalRule(restored.getBuffer(), 0, wall + 1, right)).toBe(false);

  const wrapped = new AnsiParser(right + 1, lines.length);
  wrapped.write(sidebar + header + "x"); // DECAWM, not a cursor-positioned box row.
  lines.slice(1).forEach((s, y) => wrapped.write(position(y + 1, 0) + sidebar + s));
  expect(terminalPaneHorizontalRule(wrapped.getBuffer(), 0, wall + 1, right)).toBe(false);
});

function expandCard(skipIdenticalCell = false) {
  const parts = ['"https://id.example.test/auth?scope='.padEnd(width, "a"),
    "b".repeat(width - 3) + "%20", "c".repeat(width), '&client_id=test&prompt=choose+account"'];
  const url = parts.join("").slice(1, -1);
  const p = card(["", body("code"), body("display"), body("read"), header,
    body(`field: "${url.slice(0, 18)}…"`), floor, "  build done", " Prior text.", "", " Unrelated text.", ""]);
  // The walls and contents are separate cursor writes. Opening the old floor
  // exposes an intermediate layout where the new URL seems to wrap into Prior.
  p.write(sync + position(5, wall + 2) + "field:".padEnd(width));
  parts.forEach((part, i) => {
    const line = 6 + i;
    p.write(position(line, wall) + "│" + position(line, wall + 1) + " ");
    // The old 'b' of 'build done' is visually identical, even if never printed.
    if (i === 1 && skipIdenticalCell) p.write(position(line, wall + 3) + part.slice(1) + " │");
    else p.write(part.padEnd(width) + " │");
  });
  const hits = parts.map((_, i) => ({ row: 6 + i, col: wall + 6 }));
  return { p, hits, url, first: parts[0] };
}

test("a complete card expansion owns its newly painted rows, including coincident old glyphs", () => {
  const { p, hits, url, first } = expandCard();
  p.write(position(10, wall) + floor + present);
  for (const hit of hits) expect(findUrlAtCell(p.getBuffer(), hit)?.url).toBe(url);

  // Reprinting identical ink in the next frame cannot launder a partial edit.
  p.write(sync + position(6, wall + 2) + first + position(7, wall + 5) + "Z" + present);
  for (const hit of hits) expect(findUrlAtCell(p.getBuffer(), hit)).toBeNull();
});

test("an incomplete or interrupted frame does not release its pending URL cells", () => {
  for (const draw of ["gap", "missing floor", "missing cap", "interrupted", "not presented"]) {
    const { p, hits } = expandCard(draw === "gap");
    if (draw === "interrupted") p.write(position(2, wall + 2) + "\x1b[X");
    if (draw !== "missing floor") p.write(position(10, wall) + (draw === "missing cap" ? floor.slice(0, -1) : floor));
    if (draw !== "not presented") p.write(present);
    for (const hit of hits) expect(findUrlAtCell(p.getBuffer(), hit)).toBeNull();
  }
});

test("one synchronized erase/reprint cannot promote the old owner's nested URL", () => {
  const root = "https://accounts.test/authorize?return_to=", inner = "https://app.test/cb&state=ok";
  const side = "/aside.txt".padEnd(16) + "│ ", p = new AnsiParser(side.length + root.length + 2, 4);
  p.write("\x1b[?1049h\x1b[?7l");
  ["", root, inner, ""].forEach((s, y) => p.write(position(y, 0) + side + s.padEnd(root.length) + " ▕"));
  const hit = { row: 2, col: side.length + 4 };
  expect(findUrlAtCell(p.getBuffer(), hit)?.url).toBe(root + inner);
  p.write(sync + position(2, side.length) + " ".repeat(inner.length) + position(2, side.length) + inner +
    position(1, side.length) + " ".repeat(root.length) + present);
  expect(findUrlAtCell(p.getBuffer(), hit)).toBeNull();
});

const sideUrl = "https://left.test/?q=", pane = sideUrl.length + 1, codeWidth = 42;
const behind = "https://service.example/report?dest=https://data.example/abc&cursor=" + "q".repeat(46) + "&end=done";
const pieces = behind.match(new RegExp(`.{1,${codeWidth}}`, "g"))!;
const first = 4, closer = first + pieces.length, columns = pane + codeWidth + 3;
const coverLeft = pane + 12, coverRight = pane + 30;

function overlayRows(covered: boolean) {
  return Array.from({ length: closer + 3 }, (_, y) => {
    const side = y === first ? sideUrl : covered && y === first + 1 ? "https://old.test/doc" : "";
    const text = y === first - 1 ? " ```text" : y === closer ? " ```" : pieces[y - first] ?? "";
    const row = (side.padEnd(pane - 1) + "│" + text).padEnd(columns);
    if (!covered) return row;
    const cap = y === 0 ? "┌┐" : y === closer + 2 ? "└┘" : "││";
    const inside = cap === "││" ? " settings".padEnd(coverRight - coverLeft - 1) : "─".repeat(coverRight - coverLeft - 1);
    return row.slice(0, coverLeft) + cap[0] + inside + cap[1] + row.slice(coverRight + 1);
  });
}

function paintRows(parser: AnsiParser, lines: string[], gap = false) {
  parser.write(sync);
  lines.forEach((line, y) => {
    const hole = pane + 3; // Was, and remains, the same letter outside the overlay.
    parser.write(position(y, 0) + (gap && y === first ? line.slice(0, hole) + position(y, hole + 1) + line.slice(hole + 1) : line));
  });
}

function overlayScreen(covered: boolean, lines = overlayRows(covered)) {
  const p = new AnsiParser(columns, lines.length);
  p.write("\x1b[?1049h\x1b[?7l");
  paintRows(p, lines);
  p.write(present);
  return p;
}

test("a presented full redraw retires the removed overlay's guards only in the newly uncovered fenced target", () => {
  const p = overlayScreen(true);
  paintRows(p, overlayRows(false));
  p.write(present);
  const rows = p.getBuffer();
  for (let y = first - 1; y <= closer; y++) {
    for (const plainUrl of [false, true]) expect(hasUnprovenPathCells(rows[y], pane, columns, plainUrl)).toBe(false);
  }
  // The neighboring pane was also fully painted, but its old URL suffix was removed.
  expect(hasUnprovenPathCells(rows[first], 0, sideUrl.length, true)).toBe(true);
});

test("a skipped cell, absent presentation, prior damage or changed exposed text cannot authorize an uncovered target", () => {
  for (const mutation of ["gap", "not presented", "prior damage", "exposed edit"]) {
    const p = overlayScreen(true), fresh = overlayRows(false);
    if (mutation === "prior damage") {
      const old = fresh[first + 1][pane + 2];
      p.write(position(first + 1, pane + 2) + "Z" + position(first + 1, pane + 2) + old);
      expect(hasUnprovenPathCells(p.getBuffer()[first], pane, coverLeft, true)).toBe(true);
    }
    if (mutation === "exposed edit") {
      const y = first + 1, x = pane + 2;
      fresh[y] = fresh[y].slice(0, x) + "Z" + fresh[y].slice(x + 1);
    }
    paintRows(p, fresh, mutation === "gap");
    if (mutation !== "not presented") p.write(present);
    expect(pieces.some((_, i) => hasUnprovenPathCells(p.getBuffer()[first + i], pane, columns, true))).toBe(true);
  }
});

test("edits to a fenced URL's body or its fence retain ownership across the three-cell gutter", () => {
  for (const edit of [
    position(first + 1, pane + 5) + "Z", position(first + 1, pane) + "\x1b[2X",
    position(first + 1, pane + codeWidth + 1) + "X",
    position(first + 1, 0) + "\x1b[M", position(closer, pane + 1) + " ",
  ]) {
    const p = overlayScreen(false);
    p.write(edit);
    expect(hasUnprovenPathCells(p.getBuffer()[first], pane, columns, true)).toBe(true);
    expect(hasUnprovenPathCells(p.getBuffer()[first], 0, sideUrl.length, true)).toBe(false);
  }
});

test("only a genuine wide tail outside the URL can interrupt an aligned overlay wall", () => {
  for (const [row, glyph, expected] of [[first - 2, "둘", behind], [first - 2, " ", null], [first + 1, "둘", null]] as const) {
    const old = overlayRows(true);
    // A wide character occupies both the exterior column and the wall. A
    // single blank replacing the wall supplies no such two-cell evidence.
    old[row] = old[row].slice(0, coverLeft - (glyph === "둘" ? 1 : 0)) + glyph + old[row].slice(coverLeft + 1);
    const p = overlayScreen(true, old);
    paintRows(p, overlayRows(false));
    p.write(present);
    for (let y = first; y < closer; y++) expect(findUrlAtCell(p.getBuffer(), { row: y, col: pane + 2 })?.url ?? null).toBe(expected);
  }
});

test("erasing spare cells beyond a fence or final delimiter leaves the full URL actionable", () => {
  const p = overlayScreen(false);
  for (const [row, col] of [[first - 1, pane + 12], [closer - 1, pane + pieces.at(-1)!.length + 1], [closer, pane + 6]]) {
    p.write(position(row, col) + "\x1b[3X");
    expect(findUrlAtCell(p.getBuffer(), { row: first, col: pane + 2 })?.url).toBe(behind);
  }
});

test("a lost fence cannot turn a URL's surviving absolute-path suffix into a file target", () => {
  const root = "https://a.test/?dest=https://b.test", suffix = "/tmp/report.txt";
  for (const edit of [position(0, 1) + " ", position(3, 12) + "X", position(2, 22) + "X",
    position(3, 10) + "\x1b]8;;https://other.test/\x1b\\ \x1b]8;;\x1b\\X"]) {
    const p = new AnsiParser(root.length + 2, 4);
    p.write("\x1b[?7l" + [" ```text", root, suffix, " ```"].join("\r\n"));
    const point = { row: 2, col: 4 };
    expect(findUrlAtCell(p.getBuffer(), point)?.url).toBe(root + suffix);
    p.write(edit);
    expect(findUrlAtCell(p.getBuffer(), { row: 1, col: 8 })?.url ?? null).toBeNull();
    expect(findUrlAtCell(p.getBuffer(), point)?.url ?? null).toBeNull();
    expect(findPathAtCell(p.getBuffer(), point)).toBeNull();
  }
});

test("all display erase modes expose the current visible rows to scrollback hit testing", () => {
  for (const [mode, line] of [[0, 0], [1, 2], [2, 1]]) {
    const p = new AnsiParser(48, 3);
    p.write("history\r\nfirst\r\nhttps://erased.example/doc\r\nlast");
    const point = { row: 2, col: 10 };
    expect(findUrlAtCell(p.getFullBuffer(), point)?.url).toBe("https://erased.example/doc");
    p.write(position(line, mode === 1 ? 47 : 0) + `\x1b[${mode}J`);
    const full = p.getFullBuffer();
    for (let y = 0; y < 3; y++) expect(full[y + 1]).toBe(p.getBuffer()[y]);
    expect(findUrlAtCell(full, point)).toBeNull();
  }
});

test("erase-to-end inspects bounded history only, including a code block that crosses into the viewport", () => {
  class HistoryParser extends AnsiParser {
    fullReads = 0;
    getFullBuffer() { this.fullReads++; return super.getFullBuffer(); }
  }
  const root = "https://a.test/?dest=https://b.test", p = new HistoryParser(root.length + 2, 3);
  p.write("\x1b[?7l");
  for (let y = 0; y < 128; y++) p.write("log\r\n\x1b[K");
  expect(p.fullReads).toBe(0);
  const suffix = "/tmp/report.txt";
  p.write([" ```text", root, suffix, " ```"].join("\r\n"));
  const before = p.getFullBuffer();
  expect(findUrlAtCell(before, { row: before.length - 2, col: 4 })?.url).toBe(root + suffix);
  p.write("\r\n"); // The new scroll invalidates the cached array, not the fenced target.
  const beforeErase = p.fullReads;
  p.write(position(0, 0) + "\x1b[K");
  expect(p.fullReads).toBe(beforeErase);
  const full = p.getFullBuffer();
  expect(findUrlAtCell(full, { row: full.length - 4, col: 7 })?.url ?? null).toBeNull();
});
