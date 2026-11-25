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

function fencedScreen(cols: number, lines: string[], { explicit = "", sidebarUrl = "", language = "text", thumbFrom = -1 } = {}) {
  const parser = new AnsiParser(cols, height);
  parser.write("\x1b[?1049h\x1b[?7l\x1b[?2026h");
  for (let row = 0; row < height; row++) {
    const i = row - firstBodyRow;
    const ticks = i === -1 ? "```" + language : i === lines.length ? "```" : "";
    const text = ticks ? ` ${ticks}` : lines[i] ?? "";
    const sidebar = i === -1 ? " new                 menu" : i === 0 ?
      (sidebarUrl ? sidebarUrl.padStart(left - 1) : "─".repeat(left - 1)) : i === 1 ? " agents           grouped" : "";
    const ink = ticks ? ` \x1b[38;2;42;48;56m${ticks}\x1b[0m` : explicit && text ?
      `\x1b]8;;${explicit}\x1b\\${text}\x1b]8;;\x1b\\` : text;
    const rail = thumbFrom < 0 ? " " : row < thumbFrom ? "▕" : "▐";
    parser.write(pos(row, 0) + sidebar.padEnd(left - 1) + "\x1b[38;2;30;30;46m│\x1b[0m" +
      ink + " ".repeat(cols - left - text.length - 1) + rail);
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

test("opens the completed link on the same frame that appends its last bytes", () => {
  const cols = 149, lines = fragments(cols), partial = lines.slice();
  const tail = lines.length - 1;
  partial[tail] = lines[tail].slice(0, 2);
  const parser = fencedScreen(cols, partial, { language: "" });
  // No repaint of the header, earlier fragments, or closing fence.
  parser.write("\x1b[?2026h" + pos(firstBodyRow + tail, left + partial[tail].length) +
    lines[tail].slice(2) + "\x1b[?2026l");
  expectFencedUrl(parser.getBuffer(), lines, reportedUrl);
});

test("an append cannot turn padding or text after a real space into URL content", () => {
  const cols = 149, lines = fragments(cols), tail = lines.length - 1;
  for (const suffix of ["x /other", "x".repeat(cols - left - gutter - lines[tail].length + 1)]) {
    const parser = fencedScreen(cols, lines, { language: "" });
    parser.write("\x1b[?2026h" + pos(firstBodyRow + tail, left + lines[tail].length) + suffix + "\x1b[?2026l");
    for (let i = 0; i < lines.length; i++) expectRow(parser.getBuffer(), firstBodyRow + i, lines[i], null);
  }
});

for (const cols of [149, 175]) {
  test(`first completed output opens beside the live scrollbar at ${cols} columns`, () => {
    const width = cols - left - gutter, lines = fragments(cols);
    const partial = reportedUrl.slice(0, 477).match(new RegExp(`.{1,${width}}`, "g"))!;
    const parser = fencedScreen(cols, partial, { language: "", thumbFrom: firstBodyRow - 2 });
    // Herdr reissues the body without repainting the opening fence. At 149
    // columns the suffix also overwrites the old floor and needs a new one.
    parser.write("\x1b[?2026h" + lines.map((line, i) => pos(firstBodyRow + i, left) + line).join("") +
      (lines.length === partial.length ? "" : pos(firstBodyRow + lines.length, left + 1) + "```") + "\x1b[?2026l");
    expectFencedUrl(parser.getBuffer(), lines, reportedUrl);
    // Only the scrollbar moves; the address must remain usable across its thumb and track.
    parser.write("\x1b[?2026h" + Array.from({ length: 5 }, (_, i) =>
      pos(firstBodyRow - 2 + i, cols - 1) + "▕").join("") + "\x1b[?2026l");
    expectFencedUrl(parser.getBuffer(), lines, reportedUrl);
    expect(findUrlAtCell(parser.getBuffer(), { row: firstBodyRow, col: cols - 1 })).toBeNull();
  });
}

test("a growing reply moves up over its old text before the compositor finishes the new tail", () => {
  const cols = 149, width = cols - left - gutter, prefix = reportedUrl.slice(0, 116);
  const uri = reportedUrl.slice(0, 163), tail = uri.slice(width);
  const p = fencedScreen(cols, [prefix], { language: "", thumbFrom: firstBodyRow - 3 });
  p.write("\x1b[?2026h" + pos(firstBodyRow - 2, left + 1) + "```" +
    pos(firstBodyRow - 1, left) + uri.slice(0, width) +
    // The compositor doesn't re-send the identical 'a' and 'e' at these two
    // positions in the old first row. The surrounding newly printed run does move.
    pos(firstBodyRow, left) + tail.slice(0, 10) + pos(firstBodyRow, left + 11) + tail.slice(11, 14) +
    pos(firstBodyRow, left + 15) + tail.slice(15) + " ".repeat(prefix.length - tail.length) + "\x1b[?2026l");
  expectRow(p.getBuffer(), firstBodyRow - 1, uri.slice(0, width), uri);
  expectRow(p.getBuffer(), firstBodyRow, tail, uri);
});

test("a previously damaged body cannot be repaired just by appending a suffix", () => {
  const cols = 149, lines = fragments(cols), last = lines.length - 1;
  const p = fencedScreen(cols, lines, { language: "", thumbFrom: firstBodyRow - 2 });
  p.write(pos(firstBodyRow + 1, left + 3) + "Z");
  p.write("\x1b[?2026h" + pos(firstBodyRow + last, left + lines[last].length) + "&next=1\x1b[?2026l");
  for (let i = 0; i < lines.length; i++) expectRow(p.getBuffer(), firstBodyRow + i, lines[i], null);
});

test("a freshly drawn opening fence cannot join a rewritten host to an untouched old URL tail", () => {
  const p = new AnsiParser(48, 9), head = "https://old.example/?q=".padEnd(46, "a");
  p.write("\x1b[?1049h\x1b[?7l" + pos(3, 0) + head + pos(4, 0) + "&report=previous" + pos(5, 0) + " ```");
  p.write("\x1b[?2026h" + pos(2, 1) + "```" + pos(3, 8) + "new" + "\x1b[?2026l");
  expectRow(p.getBuffer(), 3, head, null, 0);
  expectRow(p.getBuffer(), 4, "&report=previous", null, 0);
});

test("extending a second address cannot legitimize a first address rewritten in the same frame", () => {
  const old = "https://old.example/page", second = "https://archive.example/issue/1";
  const joinedHead = "https://new.example/?docs=https://a.test/pp%20", p = new AnsiParser(48, 9);
  p.write("\x1b[?1049h\x1b[?7l" + pos(2, 0) + " ```" + pos(3, 0) + old + pos(4, 0) + second + pos(5, 0) + " ```");
  expectRow(p.getBuffer(), 3, old, old, 0);
  expectRow(p.getBuffer(), 4, second, second, 0);
  p.write("\x1b[?2026h" + pos(3, 0) + joinedHead + pos(4, second.length) + "2" + "\x1b[?2026l");
  expectRow(p.getBuffer(), 3, joinedHead, null, 0);
  expectRow(p.getBuffer(), 4, second + "2", null, 0);
});

test("a new pane wall cannot retroactively join two previously separate destinations", () => {
  const head = "https://new.example/?docs=https://a.test/pp%20", second = "https://archive.example/issue/1";
  const p = new AnsiParser(60, 9), text = [" ```", head, second, " ```"];
  p.write("\x1b[?1049h\x1b[?7l" + text.map((line, i) =>
    pos(i + 2, 0) + line.padEnd(48) + (i === 1 ? " " : "│") + `  status${i}`).join(""));
  expectRow(p.getBuffer(), 3, head, head, 0);
  expectRow(p.getBuffer(), 4, second, second, 0);
  p.write("\x1b[?2026h" + pos(3, 48) + "│" + pos(4, second.length) + "2" + "\x1b[?2026l");
  expectRow(p.getBuffer(), 3, head, null, 0);
  expectRow(p.getBuffer(), 4, second + "2", null, 0);
});

test("snapshotting a repaint after stale autowrap leaves an unrelated visible address clickable", () => {
  const p = new AnsiParser(48, 9), url = "https://example.org/help";
  p.write("\x1b[?1049h" + pos(6, 0) + "`" + pos(1, 0) + "x".repeat(48) + "abcdef" +
    pos(1, 0) + " ".repeat(48) + pos(2, 0) + "status: " + url);
  expectRow(p.getBuffer(), 2, url, url, 8);
  p.write("\x1b[?2026h" + pos(2, 0) + "S" + "\x1b[?2026l");
  expectRow(p.getBuffer(), 2, url, url, 8);
});

test("unconnected half blocks do not turn a neighboring literal glyph into a pane wall", () => {
  const p = new AnsiParser(48, 8), url = "https://example.org/".padEnd(46, "z");
  p.write("\x1b[?1049h\x1b[?7l" + pos(2, 0) + url + " │" + pos(3, 47) + "▐" + pos(4, 47) + "▐");
  expectRow(p.getBuffer(), 2, url, url, 0);
});

test("right-aligned URLs can end in a literal half block alongside other box-drawing glyphs", () => {
  const prefix = "https://en.wiktionary.org/wiki/", url = prefix + "▐", p = new AnsiParser(url.length + 3, 8);
  p.write("\x1b[?1049h\x1b[?7l" + ["│", "▕", "▐"].map((ch, i) =>
    pos(i + 1, 0) + `${"ABC"[i]}: ${prefix}${ch}`).join(""));
  expectRow(p.getBuffer(), 3, url, new URL(url).href, 3);
});

test("a scrollbar starting below a link cannot take the last glyph of its title", () => {
  const url = "https://en.wiktionary.org/wiki/│", p = new AnsiParser(url.length, 8);
  p.write("\x1b[?1049h\x1b[?7l" + pos(1, 0) + url + pos(2, url.length - 1) + "▕" + pos(3, url.length - 1) + "▐");
  expectRow(p.getBuffer(), 1, url, new URL(url).href, 0);
});

test("half blocks in a soft-wrapped URL are literal characters, not a scrollbar", () => {
  const width = 32, p = new AnsiParser(width, 8);
  const url = "https://example.com/doc".padEnd(width - 1, "a") + "▐" +
    ("b".repeat(width - 1) + "▐").repeat(2) + "?end=ok";
  p.write(" ".repeat(width - 1) + "▕\r\n" + url);
  for (let row = 1; row <= 3; row++) {
    expect(findUrlAtCell(p.getBuffer(), { row, col: width - 1 })?.url).toBe(new URL(url).href);
  }
});

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
