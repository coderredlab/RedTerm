// @ts-nocheck
import { expect, test } from "bun:test";
import { AnsiParser, terminalPaneHorizontalRule } from "./ansi-parser";
import { findUrlAtCell } from "./terminal-links";

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
