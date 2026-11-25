// @ts-nocheck
import { expect, test } from "bun:test";
import { AnsiParser, type Cell } from "./ansi-parser";
import { findUrlAtCell } from "./terminal-links";

const scopes = ["documents.readonly", "spreadsheets.readonly", "presentations.readonly",
  "calendar.events.readonly", "tasks.readonly", "userinfo.profile"];
const reportedUrl = "https://example.com/?test=redterm-1.7.40&scope=" +
  scopes.map(scope => `https://api.example.com/auth/${scope}`).join("%20") +
  "&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&response_type=code" +
  "&client_id=redterm-wrap-test&prompt=select_account&end=REDTERM_OK_1740";

// Zero-based coordinates from the OMP/Herdr outer screen, not the inner PTY.
const left = 26, firstBodyRow = 18, height = 36, gutter = 3;
const pos = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`;

function fragments(cols: number) {
  const width = cols - left - gutter;
  return Array.from({ length: Math.ceil(reportedUrl.length / width) }, (_, i) =>
    reportedUrl.slice(i * width, (i + 1) * width));
}

function fencedScreen(cols: number, lines: string[], { explicit = "", sidebarUrl = "" } = {}) {
  const parser = new AnsiParser(cols, height);
  parser.write("\x1b[?1049h\x1b[?7l\x1b[?2026h");
  for (let row = 0; row < height; row++) {
    const i = row - firstBodyRow;
    const ticks = i === -1 ? "```text" : i === lines.length ? "```" : "";
    const text = ticks ? ` ${ticks}` : lines[i] ?? "";
    const sidebar = i === -1 ? " new                 menu" : i === 0 ?
      (sidebarUrl ? sidebarUrl.padStart(left - 1) : "─".repeat(left - 1)) : i === 1 ? " agents           grouped" : "";
    const ink = ticks ? ` \x1b[38;2;42;48;56m${ticks}\x1b[0m` : explicit && text ?
      `\x1b]8;;${explicit}\x1b\\${text}\x1b]8;;\x1b\\` : text;
    parser.write(pos(row, 0) + sidebar.padEnd(left - 1) + "\x1b[38;2;30;30;46m│\x1b[0m" +
      ink + " ".repeat(cols - left - text.length));
  }
  parser.write("\x1b[?2026l");
  return parser;
}

function expectRow(cells: Cell[][], row: number, text: string, url: string | null, startCol = left) {
  const endCol = startCol + text.length - 1;
  for (const col of [startCol, startCol + Math.floor(text.length / 2), endCol]) {
    const match = findUrlAtCell(cells, { row, col });
    if (url === null) expect(match?.url ?? null).toBeNull();
    else expect(match).toMatchObject({ url, startCol, endCol });
  }
}

function expectFencedUrl(cells: Cell[][], lines: string[], url: string | null) {
  lines.forEach((line, i) => {
    const row = firstBodyRow + i;
    expectRow(cells, row, line, url);
    for (const col of [left - 1, left + line.length]) {
      expect(findUrlAtCell(cells, { row, col })?.url ?? null).toBeNull();
    }
  });
  for (const row of [firstBodyRow - 1, firstBodyRow + lines.length]) {
    expect(findUrlAtCell(cells, { row, col: left + 1 })?.url ?? null).toBeNull();
  }
}

// The two captured widths, followed by two cuts inside the second nested scheme.
// At 127 columns even the last fragment exactly fills the content area.
for (const [cols, secondStart, tailLength] of [
  [175, "y%20https://", 52], [149, "/auth/spreadsheets", 10],
  [127, "ttps://", 98], [130, "s://", 86],
] as const) {
  test(`opens all 490 characters from every fenced fragment at ${cols} columns (row starts ${secondStart})`, () => {
    const lines = fragments(cols);
    expect(reportedUrl).toHaveLength(490);
    expect(lines[1].startsWith(secondStart)).toBe(true);
    expect(lines.at(-1)).toHaveLength(tailLength);
    if (cols === 149) expect(lines.at(-1)).toBe("RM_OK_1740");
    expectFencedUrl(fencedScreen(cols, lines).getBuffer(), lines, reportedUrl);
  });
}

test("uses the OSC 8 destination instead of the printed fenced URL, without bypassing URL validation", () => {
  const lines = fragments(149), target = "https://destination.example/consent?source=osc8";
  for (const [explicit, expected] of [[target, target], ["https://user@destination.example/", null]] as const) {
    expectFencedUrl(fencedScreen(149, lines, { explicit }).getBuffer(), lines, expected);
  }
});

test("keeps a neighboring fenced URL and a URL in the sidebar independently clickable", () => {
  const first = "https://one.example/read?name=first%20entry".padEnd(120, "x");
  const second = "https://two.example/notes", sidebarUrl = "https://side.test/log";
  const cells = fencedScreen(149, [first, second], { sidebarUrl }).getBuffer();
  expectRow(cells, firstBodyRow, first, first);
  expectRow(cells, firstBodyRow + 1, second, second);
  expectRow(cells, firstBodyRow, sidebarUrl, sidebarUrl, left - 1 - sidebarUrl.length);
});

test("keeps a spare content column before another URL or an apparent host suffix", () => {
  const field = "&return_to=";
  const redirect = "https://one.example/?scope=read".padEnd(119 - field.length, "x") + field;
  const other = "https://two.example/callback?state=ok".padEnd(120, "y");
  const host = "https://" + "api.".repeat(25) + "example.com";
  for (const [first, firstUrl, next, nextUrl] of [
    [redirect, redirect, other, other], [host, host + "/", ".other.example/path".padEnd(120, "z"), null],
  ] as const) {
    // The second row uses column 145; the first leaves it blank, in addition to the three compositor spaces.
    const cells = fencedScreen(149, [first, next]).getBuffer();
    expectRow(cells, firstBodyRow, first, firstUrl);
    expect(findUrlAtCell(cells, { row: firstBodyRow, col: 145 })?.url ?? null).toBeNull();
    expectRow(cells, firstBodyRow + 1, next, nextUrl);
  }
});

test("does not offer a truncated or embedded URL from a cropped fenced frame", () => {
  const lines = fragments(149), parser = fencedScreen(149, lines);
  const croppedCols = 140; // Removes visible URL cells, not just compositor padding.
  parser.resize(croppedCols, height);
  const cells = parser.getBuffer();
  lines.forEach((line, i) => expectRow(cells, firstBodyRow + i, line.slice(0, croppedCols - left), null));
});

test("retains the original hard newline when resizing a fence discards its spare columns", () => {
  const url = "https://a.test/?x=1", n = url.length;
  const parser = new AnsiParser(n + 10, 6);
  parser.write("\x1b[?1049h\x1b[?7l" + [" ```text", url, "&state=old", " ```"]
    .map((line, y) => pos(y, 0) + line).join(""));
  parser.resize(n + 1, 6);
  parser.resize(n + 2, 6);
  expect(findUrlAtCell(parser.getBuffer(), { row: 1, col: 8 })?.url).toBe(url);
  expect(findUrlAtCell(parser.getBuffer(), { row: 2, col: 2 })?.url ?? null).toBeNull();
});

test("does not claim a separately displayed Markdown destination or Windows file in the fence", () => {
  const first = "https://a.test/".padEnd(146, "x");
  const link = "https://b.test/doc";
  for (const [line, col, expected] of [[`[go](${link})`, 14, link], [String.raw`C:\notes.txt`, 5, null]] as const) {
    const cells = fencedScreen(175, [first, line]).getBuffer();
    expectRow(cells, firstBodyRow, first, first);
    expect(findUrlAtCell(cells, { row: firstBodyRow + 1, col: left + col })?.url ?? null).toBe(expected);
  }
  const wrapped = fencedScreen(175, [first, "[" + "x".repeat(145), `](${link})`]).getBuffer();
  expectRow(wrapped, firstBodyRow, first, first);
  expect(findUrlAtCell(wrapped, { row: firstBodyRow + 2, col: left + 11 })?.url).toBe(link);
});

test("a separate linked space beyond the end of the fenced URL keeps its own destination", () => {
  const lines = fragments(175), parser = fencedScreen(175, lines);
  const last = firstBodyRow + lines.length - 1, other = "https://other.example/";
  parser.write(pos(last, 160) + `\x1b]8;;${other}\x1b\\ \x1b]8;;\x1b\\`);
  const rows = parser.getBuffer();
  expectFencedUrl(rows, lines, reportedUrl);
  expect(findUrlAtCell(rows, { row: last, col: 160 })?.url).toBe(other);
});
