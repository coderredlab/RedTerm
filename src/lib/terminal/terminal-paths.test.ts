// @ts-nocheck
import { expect, test } from "bun:test";
import { AnsiParser, DEFAULT_STYLE } from "./ansi-parser";
import { findPathAtCell, resolveTerminalPath } from "./terminal-paths";

const row = (text: string) => [[...text].map(char => ({ char, style: DEFAULT_STYLE }))];
test("keeps literal colon-number filenames distinct from source-line references", () => {
  for (const [text, path, alternative] of [
    ["at /home/me/src/main.ts:12:4", "/home/me/src/main.ts:12:4", "/home/me/src/main.ts"],
    [String.raw`at C:\Users\me\main.rs:7`, "C:/Users/me/main.rs:7", "C:/Users/me/main.rs"],
    ['open "/tmp/report:12"', "/tmp/report:12", "/tmp/report"],
  ]) {
    const match = findPathAtCell(row(text), { row: 0, col: 10 });
    expect(match?.path).toBe(path);
    expect(match?.alternativePath).toBe(alternative);
  }
  expect(findPathAtCell(row("open ~/Projects/RedTerm"), { row: 0, col: 10 })?.path)
    .toBe("~/Projects/RedTerm");
  expect(findPathAtCell(row('open "/home/me/My Project/file.ts"'), { row: 0, col: 10 })?.path)
    .toBe("/home/me/My Project/file.ts");
  expect(findPathAtCell(row("at /home/me/file.ts"), { row: 0, col: 0 })).toBeNull();
  expect(findPathAtCell(row("at /tmp/report.txt"), { row: 0, col: 8 }))
    .not.toHaveProperty("alternativePath");
});
test("requires reported cwd for relative paths and never uses a web URL as a file path", () => {
  expect(resolveTerminalPath("src/main.ts")).toBeNull();
  expect(resolveTerminalPath("src/main.ts", "file:///home/me/project")).toBe("/home/me/project/src/main.ts");
  expect(resolveTerminalPath("https://example.com/a/b", "file:///home/me")).toBeNull();
  expect(resolveTerminalPath("ordinary-word", "file:///home/me")).toBeNull();
  expect(resolveTerminalPath("file:///home/me/%00bad")).toBeNull();
  expect(resolveTerminalPath("file:///home/me/a?b")).toBeNull();
});
test("rejects remote file URI authorities as outer-session filesystem paths", () => {
  expect(resolveTerminalPath("file://remote.example/home/user/project")).toBeNull();
  expect(resolveTerminalPath("src/config", "file://remote.example/home/user/project")).toBeNull();
  expect(resolveTerminalPath("file://localhost/tmp/local")).toBe("/tmp/local");
});
test("uses OSC 8 file and absolute targets even when labels span rows", () => {
  for (const uri of ["file:///home/me/My%20Project/file.ts", "/home/me/My Project/file.ts"]) {
    const parser = new AnsiParser(8, 4);
    parser.write(`\x1b]8;;${uri}\x1b\\long label crossing rows\x1b]8;;\x1b\\`);
    const buffer = parser.getBuffer();
    for (const point of [{ row: 0, col: 2 }, { row: 1, col: 2 }]) {
      const match = findPathAtCell(buffer, point);
      expect(match?.path).toBe("/home/me/My Project/file.ts");
      expect(match).not.toHaveProperty("alternativePath");
    }
  }
  const raw = new AnsiParser(30, 2);
  raw.write("\x1b]8;;/tmp/report.txt:12\x1b\\open\x1b]8;;\x1b\\");
  expect(findPathAtCell(raw.getBuffer(), { row: 0, col: 1 })?.path).toBe("/tmp/report.txt:12");
  for (const uri of ["https://example.com/a/b", "data:text/plain,abc"]) {
    const parser = new AnsiParser(60, 2);
    parser.write(`\x1b]8;;${uri}\x1b\\source\x1b]8;;\x1b\\`);
    expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 2 })).toBeNull();
  }
  const hidden = row("/home/me/file.ts");
  hidden[0][3].style = { ...DEFAULT_STYLE, hidden: true };
  expect(findPathAtCell(hidden, { row: 0, col: 4 })).toBeNull();
});

test("preserves candidate boundaries for plain paths spanning terminal rows", () => {
  const path = "/home/coderred/Projects/coderred-video/exports/shorts/tech/202610/rea-reverse-engineer-anything-easy-shorts/rea-reverse-engineer-anything-easy-shorts.mp4";
  const parser = new AnsiParser(100, 5);
  parser.write(`(${path})`);
  const buffer = parser.getBuffer();
  for (const point of [{ row: 0, col: 30 }, { row: 1, col: 10 }]) {
    const match = findPathAtCell(buffer, point);
    expect(match?.path).toBe(path);
    expect(match).toHaveProperty("alternativePath");
  }
  const narrow = new AnsiParser(40, 8);
  narrow.write(`(${path})`);
  for (const point of [{ row: 0, col: 10 }, { row: 2, col: 10 }, { row: 3, col: 10 }]) {
    const match = findPathAtCell(narrow.getBuffer(), point);
    expect(match?.path).toBe(path);
    expect(match).toHaveProperty("alternativePath");
  }
  narrow.getBuffer()[2][10].style = { ...DEFAULT_STYLE, hidden: true };
  expect(findPathAtCell(narrow.getBuffer(), { row: 0, col: 10 })).toBeNull();
});

test("a wrapped source-location path offers the literal filename and base file", () => {
  const parser = new AnsiParser(16, 4);
  const base = "/tmp/long/path/file.ts";
  parser.write(`${base}:12:4`);
  for (const point of [{ row: 0, col: 5 }, { row: 1, col: 5 }]) {
    const match = findPathAtCell(parser.getBuffer(), point);
    expect(match?.path).toBe(`${base}:12:4`);
    expect([match?.alternativePath, ...(match?.intermediatePaths ?? [])]).toContain(base);
  }
});

test("never silently joins distinct Herdr rows or removes quoted spaces", () => {
  // Herdr's 130-column viewport has one visible margin at either side.
  const parser = new AnsiParser(130, 4);
  parser.write(` ${"x".repeat(115)} /tmp/foo.txt \r\n -log`);
  const first = findPathAtCell(parser.getBuffer(), { row: 0, col: 122 });
  expect(first?.path).toBe("/tmp/foo.txt-log");
  expect(first?.alternativePath).toBe("/tmp/foo.txt");
  const second = findPathAtCell(parser.getBuffer(), { row: 1, col: 3 });
  expect(second?.path).toBe("/tmp/foo.txt-log");
  expect(second?.alternativePath).toBe("/tmp/foo.txt");
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 0 })).toBeNull();
  const punctuation = new AnsiParser(32, 3);
  punctuation.write(` ${"x".repeat(15)} (/tmp/foo.txt) \r\n -log`);
  const ambiguousPunctuation = findPathAtCell(punctuation.getBuffer(), { row: 0, col: 21 });
  expect(ambiguousPunctuation?.path).toBe("/tmp/foo.txt)-log");
  expect(ambiguousPunctuation?.alternativePath).toBe("/tmp/foo.txt");

  // A right-edge blank might be a filename space or a TUI margin.
  const quoted = new AnsiParser(130, 4);
  quoted.write(` ${"x".repeat(121)}"/tmp/a \r\n b.txt"`);
  expect(findPathAtCell(quoted.getBuffer(), { row: 0, col: 125 })).toBeNull();
  expect(findPathAtCell(quoted.getBuffer(), { row: 1, col: 3 })).toBeNull();
  expect(findPathAtCell(row('open "/tmp/a b.txt"'), { row: 0, col: 10 })?.path).toBe("/tmp/a b.txt");
  const softWrap = new AnsiParser(8, 3);
  softWrap.write('"/tmp/a b.txt"');
  expect(findPathAtCell(softWrap.getBuffer(), { row: 0, col: 3 })).toBeNull();
  const brokenQuote = new AnsiParser(8, 3);
  brokenQuote.write('"/tmp/a /tmp/b"');
  expect(findPathAtCell(brokenQuote.getBuffer(), { row: 1, col: 3 })).toBeNull();

  const obscured = parser.getBuffer().map(line => line.map(cell => ({ ...cell })));
  obscured[1][0].style = { ...DEFAULT_STYLE, hidden: true };
  expect(findPathAtCell(obscured, { row: 0, col: 122 })).toBeNull();
  const linkedMargin = parser.getBuffer().map(line => line.map(cell => ({ ...cell })));
  linkedMargin[0][129].hyperlink = { uri: "/tmp/other" };
  expect(findPathAtCell(linkedMargin, { row: 1, col: 3 })).toBeNull();
});

test("refuses a bounded partial path even when the last cell is a margin", () => {
  const parser = new AnsiParser(2100, 4);
  parser.write(` ${"x".repeat(2085)} /tmp/foo.txt \r\n -log`);
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 2090 })).toBeNull();
});

test("clicking the second cell of a wide glyph keeps the single-row path", () => {
  const parser = new AnsiParser(40, 2);
  parser.write("/tmp/界.txt");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 6 })).toEqual({
    path: "/tmp/界.txt", startCol: 0, endCol: 10,
  });
});

test("never opens a path cut off by a linked next-row suffix", () => {
  const parser = new AnsiParser(8, 3);
  parser.write("/tmp/foo\x1b]8;;https://example.com\x1b\\bar\x1b]8;;\x1b\\");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 1 })).toBeNull();
});

test("reflowed scrollback rows with different widths retain alternative targets", () => {
  const path = `/tmp/${"a".repeat(32)}`;
  const parser = new AnsiParser(30, 3);
  parser.write(`${path}\r\n${"X".repeat(30)}\r\n${"Y".repeat(30)}`);
  parser.resize(16, 3);
  const buffer = parser.getFullBuffer();
  expect(buffer[0].length).toBe(30);
  expect(buffer[1].length).toBe(7);
  for (const point of [{ row: 0, col: 3 }, { row: 1, col: 3 }]) {
    const match = findPathAtCell(buffer, point);
    expect(match?.path).toBe(path);
    expect(match).toHaveProperty("alternativePath");
  }
});

test("unknown unequal row widths cannot silently reveal an edge fragment", () => {
  const rows = [row("/tmp/foo")[0], row("bar        ")[0]];
  expect(findPathAtCell(rows, { row: 0, col: 3 })).toBeNull();
});

test("repeated resizing preserves a path whose first row is pulled back from scrollback", () => {
  const path = `/tmp/${"a".repeat(32)}`;
  const parser = new AnsiParser(30, 3);
  parser.write(`${path}\r\n${"X".repeat(30)}\r\n${"Y".repeat(30)}`);
  parser.resize(40, 4);
  for (const point of [{ row: 0, col: 3 }, { row: 1, col: 3 }]) {
    const match = findPathAtCell(parser.getFullBuffer(), point);
    expect(match?.path).toBe(path);
    expect(match).toHaveProperty("alternativePath");
  }
  const restored = new AnsiParser(40, 4);
  restored.restoreSnapshot(parser.createSnapshot());
  // A stored snapshot does not encode reflow ancestry. Never open the
  // truncated first row as though it were the complete file name.
  expect(findPathAtCell(restored.getFullBuffer(), { row: 0, col: 3 })).toBeNull();
  expect(findPathAtCell(restored.getFullBuffer(), { row: 1, col: 3 })).toBeNull();
  restored.resize(41, 4);
  expect(findPathAtCell(restored.getFullBuffer(), { row: 0, col: 3 })).toBeNull();
  const shifted = new AnsiParser(40, 4);
  shifted.restoreSnapshot(parser.createSnapshot());
  shifted.write("\x1b[H\x1b[@");
  expect(findPathAtCell(shifted.getFullBuffer(), { row: 0, col: 4 })).toBeNull();
  parser.resize(30, 4);
  expect(findPathAtCell(parser.getFullBuffer(), { row: 0, col: 3 })?.path).toBe(path);
});

test("live output on an empty restored row remains clickable", () => {
  const restored = new AnsiParser(16, 2);
  restored.restoreSnapshot(new AnsiParser(16, 2).createSnapshot());
  restored.write("/tmp/foo\r\nnext");
  expect(findPathAtCell(restored.getBuffer(), { row: 0, col: 3 })?.path).toBe("/tmp/foo");
});

test("clearing a restored row removes obsolete wrap uncertainty", () => {
  const source = new AnsiParser(16, 2);
  source.write("old output");
  const restored = new AnsiParser(16, 2);
  restored.restoreSnapshot(source.createSnapshot());
  restored.write("\x1b[H\x1b[K/tmp/foo\r\nnext");
  expect(findPathAtCell(restored.getBuffer(), { row: 0, col: 3 })?.path).toBe("/tmp/foo");
});

test("overwriting restored text removes only its surviving wrap uncertainty", () => {
  const source = new AnsiParser(16, 2);
  source.write("old");
  const restored = new AnsiParser(16, 2);
  restored.restoreSnapshot(source.createSnapshot());
  restored.write("\r/tmp/foo\r\nnext");
  expect(findPathAtCell(restored.getBuffer(), { row: 0, col: 3 })?.path).toBe("/tmp/foo");
});

test("resizing after a wrapped path scrolls preserves its padded boundary", () => {
  const path = `/tmp/${"a".repeat(32)}`;
  const parser = new AnsiParser(30, 4);
  parser.write(path);
  parser.resize(16, 4);
  parser.write("\r\n\r\n\r\n");
  parser.resize(15, 4);
  const buffer = parser.getFullBuffer();
  const first = buffer.findIndex(line => line.map(cell => cell.char).join("").startsWith("/tmp/"));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(findPathAtCell(buffer, { row: first, col: 3 })?.path).toBe(path);
});

test("restoring a clipped path never opens its prefix as another file", () => {
  const source = new AnsiParser(20, 2);
  source.write("/tmp/fooABCXYZ");
  const restored = new AnsiParser(8, 2);
  restored.restoreSnapshot(source.createSnapshot());
  expect(findPathAtCell(restored.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("a narrowed Herdr path can continue past its reflow tail", () => {
  const parser = new AnsiParser(16, 4);
  parser.write(" /tmp/fooooooo \r\n obar\r\n 12345678901234\r\n 12345678901234");
  parser.resize(12, 4);
  const match = findPathAtCell(parser.getFullBuffer(), { row: 0, col: 3 });
  expect([match?.path, ...(match?.intermediatePaths ?? [])]).toContain("/tmp/foooooooobar");
  expect(match).toHaveProperty("alternativePath");
});

test("a third adjacent TUI row leaves the two-row path selectable", () => {
  const parser = new AnsiParser(24, 4);
  parser.write(` ${"x".repeat(13)} /tmp/foo \r\n ${"b".repeat(22)} \r\n baz`);
  const match = findPathAtCell(parser.getBuffer(), { row: 0, col: 19 });
  expect(match?.intermediatePaths).toContain(`/tmp/foo${"b".repeat(22)}`);
  expect(match?.alternativePath).toBe("/tmp/foo");
});


test("rewriting a reflow tail cannot leave its old boundary attached", () => {
  const parser = new AnsiParser(20, 2);
  parser.write("old");
  parser.resize(16, 2);
  parser.write("\r/tmp/aaaaaaaaaaa\r\nbar");
  const match = findPathAtCell(parser.getBuffer(), { row: 0, col: 3 });
  expect(match?.path).toBe("/tmp/aaaaaaaaaaabar");
  expect(match).toHaveProperty("alternativePath");
});

test("a path beginning after an ambiguous earlier row remains selectable", () => {
  const parser = new AnsiParser(24, 3);
  parser.write(` ${"prior-content".padEnd(22, "x")} \r\n /tmp/foo`);
  const match = findPathAtCell(parser.getBuffer(), { row: 1, col: 4 });
  expect(match?.path).toBe("/tmp/foo");
  expect(match).toHaveProperty("alternativePath");
});

test("an absolute path in a wrapper after an unrelated row stays selectable", () => {
  const parser = new AnsiParser(24, 3);
  parser.write(` ${"prior-content".padEnd(22, "x")} \r\n (/tmp/foo)`);
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 5 })?.path).toBe("/tmp/foo");
});

test("redrawing a reflowed row invalidates its old padding boundary", () => {
  const parser = new AnsiParser(8, 4);
  parser.write("/tmp/fooBAR");
  parser.resize(16, 4);
  parser.write("\x1b[Hx /tmp/abcdefgh \r\n ij");
  const match = findPathAtCell(parser.getBuffer(), { row: 0, col: 5 });
  expect(match?.path).toBe("/tmp/abcdefghij");
  expect(match).toHaveProperty("alternativePath");
});

test("alternate-screen roundtrip cannot turn a padded prefix into a link", () => {
  const path = `/tmp/${"a".repeat(32)}`;
  const parser = new AnsiParser(30, 3);
  parser.write(`${path}\r\n${"X".repeat(30)}\r\n${"Y".repeat(30)}`);
  parser.resize(40, 4);
  parser.write("\x1b[?1049h\x1b[?1049l");
  expect(findPathAtCell(parser.getFullBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("ordinary live shell paths remain clickable after leaving a TUI", () => {
  const parser = new AnsiParser(30, 3);
  parser.write("/tmp/live.txt");
  parser.write("\x1b[?1049h\x1b[?1049l");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })?.path).toBe("/tmp/live.txt");
});

test("palette repaint cannot make restored path fragments actionable", () => {
  const source = new AnsiParser(30, 3);
  source.write(`\x1b[31m/tmp/${"a".repeat(32)}\r\n${"X".repeat(30)}\r\n${"Y".repeat(30)}`);
  source.resize(40, 4);
  const restored = new AnsiParser(40, 4);
  restored.restoreSnapshot(source.createSnapshot());
  restored.write("\x1b]4;1;rgb:12/34/56\x07");
  expect(findPathAtCell(restored.getFullBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("leaving a TUI keeps fresh text separate from old snapshot cells", () => {
  const source = new AnsiParser(30, 3);
  source.write("OLD");
  const restored = new AnsiParser(30, 3);
  restored.restoreSnapshot(source.createSnapshot());
  restored.write("\x1b[1;8H/tmp/foo\x1b[?1049h\x1b[?1049l\x1b[1;1HNEW");
  expect(findPathAtCell(restored.getBuffer(), { row: 0, col: 10 })?.path).toBe("/tmp/foo");
});

test("narrowing inside a TUI cannot reveal a truncated saved shell path", () => {
  const parser = new AnsiParser(30, 3);
  parser.write(`/tmp/${"a".repeat(20)}`);
  parser.write("\x1b[?1049h");
  parser.resize(10, 3);
  parser.write("\x1b[?1049l");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("widening inside a TUI cannot reveal a former first-row fragment", () => {
  const parser = new AnsiParser(10, 3);
  parser.write("/tmp/aaaaa\r\nbbb");
  parser.write("\x1b[?1049h");
  parser.resize(20, 3);
  parser.write("\x1b[?1049l");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("dropping saved TUI continuation marks the final retained content row", () => {
  const parser = new AnsiParser(20, 4);
  parser.write("/tmp/fooooooo\r\nobar\x1b[1;1H");
  parser.write("\x1b[?1049h");
  parser.resize(20, 2);
  parser.write("\x1b[?1049l");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("widening a live pane cannot directly open a former edge fragment", () => {
  const parser = new AnsiParser(10, 3);
  parser.write("/tmp/aaaaa\r\nbbb");
  parser.resize(20, 3);
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("height clipping cannot reveal a discarded continuation's prefix", () => {
  const parser = new AnsiParser(10, 3);
  parser.write("/tmp/aaaaa\r\nbbb\x1b[A");
  parser.resize(10, 1);
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("scrollback eviction cannot expose a wrapped suffix as a root path", () => {
  const parser = new AnsiParser(8, 1);
  parser.setMaxScrollback(1);
  parser.write("/foo/bar/baz\r\nx");
  const buffer = parser.getFullBuffer();
  const suffix = buffer.findIndex(line => line.map(cell => cell.char).join("").startsWith("/baz"));
  expect(suffix).toBeGreaterThanOrEqual(0);
  expect(findPathAtCell(buffer, { row: suffix, col: 2 })).toBeNull();
});

test("redrawing a known reflow successor restores its standalone relative choice", () => {
  const parser = new AnsiParser(8, 3);
  parser.write("/oldpathlong");
  parser.resize(12, 3);
  parser.write("\x1b]7;file:///cwd\x07");
  parser.write("\x1b[2;1H\x1b[Kfoo/bar");
  const match = findPathAtCell(parser.getBuffer(), { row: 1, col: 1 }, "file:///cwd");
  expect([match?.path, match?.alternativePath, ...(match?.intermediatePaths ?? [])])
    .toContain("/cwd/foo/bar");
});

test("a relative path retains the OSC 7 directory from its printed cells", () => {
  const parser = new AnsiParser(40, 2);
  parser.write("\x1b]7;file:///tmp/a\x07src/file.ts");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 },
    parser.getCurrentDirectoryUri())?.path).toBe("/tmp/a/src/file.ts");
  parser.write("\x1b]7;file:///tmp/b\x07");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 },
    parser.getCurrentDirectoryUri())?.path).toBe("/tmp/a/src/file.ts");
  parser.write("\r\x1b[2Ksrc/file.ts");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 },
    parser.getCurrentDirectoryUri())?.path).toBe("/tmp/b/src/file.ts");
});

test("a relative path from conflicting printed directories requires workspace lookup", () => {
  const parser = new AnsiParser(40, 2);
  parser.write("\x1b]7;file:///tmp/a\x07src/");
  parser.write("\x1b]7;file:///tmp/b\x07file.ts");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 },
    parser.getCurrentDirectoryUri())).toMatchObject({
      path: "src/file.ts", alternativePath: null, choiceReason: "relative-path",
    });
});

test("clearing a former continuation cannot open its old prefix", () => {
  const parser = new AnsiParser(8, 2);
  parser.write("/tmp/fooBAR");
  parser.write("\r\x1b[2K");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("partly erasing a reflow source cannot open its surviving prefix", () => {
  const parser = new AnsiParser(8, 2);
  parser.write("/tmp/fooBAR");
  parser.write("\x1b[1;7H\x1b[K");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("erasing a soft-wrap predecessor cannot expose its root-looking suffix", () => {
  const parser = new AnsiParser(8, 2);
  parser.write("/foo/bar/baz\x1b[1;1H\x1b[2K");
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 2 })).toBeNull();
});

test("a fully replaced suffix is no longer bound to its old predecessor", () => {
  const parser = new AnsiParser(8, 2);
  parser.write("/foo/bar/baz\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K/new");
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 2 })?.path).toBe("/new");
});

test("alternate-screen restoration cannot revive a partly erased wrap prefix", () => {
  const parser = new AnsiParser(8, 2);
  parser.write("/tmp/fooBAR\x1b[1;7H\x1b[K");
  parser.write("\x1b[?1049h\x1b[?1049l");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("alternate-screen restoration cannot revive an orphaned wrap suffix", () => {
  const parser = new AnsiParser(8, 2);
  parser.write("/foo/bar/baz\x1b[1;1H\x1b[2K");
  parser.write("\x1b[?1049h\x1b[?1049l");
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 2 })).toBeNull();
});

test("narrowing with scrollback clipping does not reveal a root-looking suffix", () => {
  const parser = new AnsiParser(40, 1);
  parser.setMaxScrollback(1);
  parser.write(`/${"a".repeat(23)}/baz${"b".repeat(8)}`);
  parser.resize(8, 1);
  expect(findPathAtCell(parser.getFullBuffer(), { row: 0, col: 2 })).toBeNull();
});

test("erasing either side of a hard-wrapped path never opens its fragment", () => {
  const suffix = new AnsiParser(8, 2);
  suffix.write("/foo/bar\r\n/baz\x1b[1;1H\x1b[2K");
  expect(findPathAtCell(suffix.getBuffer(), { row: 1, col: 2 })).toBeNull();

  const prefix = new AnsiParser(8, 2);
  prefix.write("/tmp/foo\r\nBAR\x1b[2;1H\x1b[2K");
  expect(findPathAtCell(prefix.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("deleting the first hard-wrap row cannot open its surviving suffix", () => {
  const parser = new AnsiParser(8, 3);
  parser.write("/foo/bar\r\n/baz\x1b[1;1H\x1b[M");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 2 })).toBeNull();
});

test("partial erasure of a hard-wrap source cannot expose its prefix", () => {
  const parser = new AnsiParser(8, 2);
  parser.write("/tmp/foo\r\nBAR\x1b[1;7H\x1b[K");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("region scrolling cannot expose a hard-wrapped suffix", () => {
  const parser = new AnsiParser(8, 3);
  parser.write("/foo/bar\r\n/baz\x1b[1;2r\x1b[S");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 2 })).toBeNull();
});

test("character erasures and shifts cannot expose a detached hard-wrap prefix", () => {
  for (const command of ["K", "8X", "8P", "8@"]) {
    const parser = new AnsiParser(8, 2);
    parser.write(`/tmp/foo\r\nBAR\x1b[2;1H\x1b[${command}`);
    expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
  }
  const parser = new AnsiParser(8, 2);
  parser.write("/foo/bar\r\n/baz\x1b[1;8H\x1b[1K");
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 2 })).toBeNull();
});

test("downward row shifts cannot expose a detached hard-wrap prefix", () => {
  for (const command of ["L", "T"]) {
    const parser = new AnsiParser(8, 3);
    parser.write(`x\r\n/tmp/foo\r\nBAR\x1b[1;1H\x1b[${command}`);
    expect(findPathAtCell(parser.getBuffer(), { row: 2, col: 3 })).toBeNull();
  }
});

test("display erase preserves hard-wrap uncertainty at its retained boundaries", () => {
  const suffix = new AnsiParser(8, 2);
  suffix.write("/foo/bar\r\n /baz\x1b[2;1H\x1b[1J");
  expect(findPathAtCell(suffix.getBuffer(), { row: 1, col: 3 })).toBeNull();

  const prefix = new AnsiParser(8, 1);
  prefix.write("/tmp/foo\r\nBAR\x1b[2J");
  expect(findPathAtCell(prefix.getFullBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("zero scrollback never reveals a dropped wrap's suffix", () => {
  const parser = new AnsiParser(8, 1);
  parser.setMaxScrollback(0);
  parser.write("/foo/bar/baz");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 2 })).toBeNull();
});
test("alternate-screen restoration preserves unknown zero-scrollback ancestry", () => {
  const parser = new AnsiParser(8, 1);
  parser.setMaxScrollback(0);
  parser.write("/foo/bar/baz");
  parser.write("\x1b[?1049h\x1b[?1049l");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 2 })).toBeNull();
});
test("a full-row erase retires lost-predecessor uncertainty", () => {
  const parser = new AnsiParser(8, 1);
  parser.setMaxScrollback(0);
  parser.write("/foo/bar/baz\r\x1b[2K/tmp/new");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })?.path).toBe("/tmp/new");
});



test("widening cannot directly open a wide glyph at the old edge", () => {
  const parser = new AnsiParser(8, 3);
  parser.write("/tmp/a界\r\nb");
  parser.resize(12, 3);
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("wide glyph occupying the last column does not open a truncated path", () => {
  const parser = new AnsiParser(8, 3);
  parser.write("/tmp/a界b");
  for (const point of [{ row: 0, col: 7 }, { row: 1, col: 0 }]) {
    const match = findPathAtCell(parser.getBuffer(), point);
    expect(match?.path).toBe("/tmp/a界b");
    expect(match).toHaveProperty("alternativePath");
  }
  const obscured = parser.getBuffer().map(line => line.map(cell => ({ ...cell })));
  obscured[0][7].style = { ...DEFAULT_STYLE, hidden: true };
  expect(findPathAtCell(obscured, { row: 1, col: 0 })).toBeNull();
});


test("does not normalize parent components across filesystem symlinks in file URIs", () => {
  for (const uri of [
    "file:///home/me/alias/../target.txt",
    "file:///home/me/alias/%2e%2e/target.txt",
    "file:///home/me/alias%2f..%2ftarget.txt",
  ]) expect(resolveTerminalPath(uri)).toBeNull();
  // Plain paths retain the component so the explorer can report it as unsupported.
  expect(resolveTerminalPath("/home/me/alias/../target.txt")).toBe("/home/me/alias/../target.txt");
});

test("joins composed-pane paths despite sidebars and both compositor margins", () => {
  const path = "/home/me/exports/shorts/tech/202610/artex-agent-explained.mp4";
  for (const padding of [1, 2]) {
    const parser = new AnsiParser(70, 6);
    parser.write("\x1b[?7l");
    for (let row = 0; row < 6; row++) {
      parser.write(`\x1b[${row + 1};1H${" ".repeat(15)}│`);
    }
    const width = 70 - 16;
    const split = width - 2 - padding;
    parser.write("\x1b[1;17H \x1b[4mOpen video\x1b[0m");
    parser.write(`\x1b[2;1H/sidebar/path\x1b[2;17H (${path.slice(0, split)}${" ".repeat(padding)}`);
    parser.write(`\x1b[3;17H ${path.slice(split)})`);
    for (const point of [{ row: 0, col: 22 }, { row: 1, col: 22 }, { row: 2, col: 21 }]) {
      const match = findPathAtCell(parser.getBuffer(), point);
      expect(match?.path).toBe(path);
      expect(match).toHaveProperty("alternativePath");
    }
    expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 15 })).toBeNull();
  }
});

test("relative displayed paths without OSC 7 require automatic workspace lookup", () => {
  const parser = new AnsiParser(80, 4);
  parser.write("exports/shorts/video.mp4");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 5 }))
    .toMatchObject({ path: "exports/shorts/video.mp4", alternativePath: null,
      choiceReason: "relative-path" });
});

test("underlined labels identify their adjacent displayed target for verification", () => {
  const parser = new AnsiParser(100, 4);
  parser.write("\x1b[4mOpen video\x1b[0m (/home/me/video.mp4)\r\n");
  parser.write("\x1b[4mYouTube copy\x1b[0m (exports/shorts/youtube-shorts.md)");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 }))
    .toMatchObject({ path: "/home/me/video.mp4", alternativePath: null,
      choiceReason: "rendered-label", startCol: 0, endCol: 9 });
  expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 4 }))
    .toMatchObject({ path: "exports/shorts/youtube-shorts.md",
      choiceReason: "relative-path", startCol: 0, endCol: 11 });
});

test("relative OSC 8 targets without a printed cwd require explicit resolution", () => {
  const parser = new AnsiParser(60, 2);
  parser.write("\x1b]8;;exports/video.mp4\x1b\\Open video\x1b]8;;\x1b\\");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toMatchObject({
    path: "exports/video.mp4", alternativePath: null, choiceReason: "relative-path",
  });
});

test("pane clipping retains snapshot uncertainty instead of reopening old fragments", () => {
  const source = new AnsiParser(40, 4);
  source.write("\x1b[?7l");
  for (let y = 0; y < 4; y++) source.write(`\x1b[${y + 1};1H     │`);
  source.write("\x1b[2;7H /home/me/exports/a-very-long-file\r\n");
  const restored = new AnsiParser(40, 4);
  restored.restoreSnapshot(source.createSnapshot());
  expect(findPathAtCell(restored.getBuffer(), { row: 1, col: 12 })).toBeNull();
});

test("composed panes never hide an OSC 8 or hidden right-margin cell", () => {
  for (const linked of [false, true]) {
    const parser = new AnsiParser(40, 4);
    parser.write("\x1b[?7l");
    for (let y = 0; y < 4; y++) parser.write(`\x1b[${y + 1};1H     │`);
    parser.write(`\x1b[2;7H /tmp/${"a".repeat(26)}  \x1b[3;7H tail`);
    const margin = parser.getBuffer()[1][39];
    parser.getBuffer()[1][39] = linked
      ? { ...margin, hyperlink: { uri: "https://example.com", id: "other" } }
      : { ...margin, style: { ...DEFAULT_STYLE, hidden: true } };
    expect(findPathAtCell(parser.getBuffer(), { row: 1, col: 12 })).toBeNull();
  }
});

test("unsupported explicit hyperlinks never fall through to an adjacent path", () => {
  const parser = new AnsiParser(80, 4);
  parser.write("\x1b]8;;javascript:bad\x1b\\\x1b[4mOpen video\x1b[0m\x1b]8;;\x1b\\ (/tmp/video.mp4)");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toBeNull();
});

test("all relative OSC 8 label cells must agree on a printed working directory", () => {
  for (const width of [80, 6]) {
    for (const initial of ["", "\x1b]7;file:///tmp/a\x07"]) {
      const parser = new AnsiParser(width, 3);
      parser.write(`${initial}\x1b]8;;exports/video.mp4\x1b\\Open\x1b]7;file:///tmp/b\x07 video\x1b]8;;\x1b\\`);
      for (const index of [1, 6]) {
        expect(findPathAtCell(parser.getBuffer(), { row: Math.floor(index / width), col: index % width }))
          .toMatchObject({ path: "exports/video.mp4", alternativePath: null, choiceReason: "relative-path" });
      }
    }
  }
});

test("a path-looking underlined label refers to its adjacent displayed target", () => {
  const parser = new AnsiParser(80, 3);
  parser.write("\x1b[4m/tmp/label.mp4\x1b[0m (/tmp/target.mp4)");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 5 })).toMatchObject({
    path: "/tmp/target.mp4", alternativePath: null, choiceReason: "rendered-label",
  });
});

test("pane detection does not truncate a wider scrollback filename after narrowing", () => {
  const parser = new AnsiParser(80, 1);
  parser.write(`${"     │".padEnd(80)}\r\n     │ /tmp/${"a".repeat(66)}  \r\n     │ tail.txt`);
  parser.resize(40, 1);
  const match = findPathAtCell(parser.getFullBuffer(), { row: 2, col: 9 });
  expect([match?.path, match?.alternativePath, ...(match?.intermediatePaths ?? [])])
    .not.toContain(`/tmp/${"a".repeat(28)}tail.txt`);
});

test("a rejected adjacent target never falls back to opening its path-looking label", () => {
  const parser = new AnsiParser(80, 3);
  parser.write("\x1b[4m/tmp/label.mp4\x1b[0m (javascript:bad)");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 5 })).toBeNull();
});

test("wrapped rendered labels locate their target from every label row", () => {
  const parser = new AnsiParser(20, 5);
  parser.write("\x1b[4mA very long video label\x1b[0m (/tmp/video.mp4)");
  for (const point of [{ row: 0, col: 3 }, { row: 1, col: 1 }]) {
    expect(findPathAtCell(parser.getBuffer(), point)).toMatchObject({
      path: "/tmp/video.mp4", choiceReason: "rendered-label",
    });
  }
});

test("an opening parenthesis at the row edge still leads to its full target", () => {
  const parser = new AnsiParser(20, 4);
  parser.write("\x1b[4mOpen exported file\x1b[0m (/tmp/video.mp4)");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 3 })).toMatchObject({
    path: "/tmp/video.mp4", choiceReason: "rendered-label",
  });
});

test("relative suffix alternatives survive an unknown cwd at a rendered boundary", () => {
  const parser = new AnsiParser(16, 4);
  parser.write(`${"x".repeat(15)} \r\n src/file.ts`);
  const match = findPathAtCell(parser.getBuffer(), { row: 1, col: 5 });
  expect(match?.choiceReason).toBe("relative-path");
  expect([match?.path, match?.alternativePath, ...(match?.intermediatePaths ?? [])])
    .toContain("src/file.ts");
});

test("wrapped rendered labels do not bridge obscured or snapshot continuation rows", () => {
  for (const obstruction of ["hidden", "hyperlink", "snapshot"]) {
    const parser = new AnsiParser(20, 5);
    parser.write("\x1b[4mA very long video label\x1b[0m (/tmp/video.mp4)");
    const buffer = parser.getBuffer();
    if (obstruction === "snapshot") {
      const restored = new AnsiParser(20, 5);
      restored.restoreSnapshot(parser.createSnapshot());
      buffer[1] = restored.getBuffer()[1];
    } else {
      const cell = buffer[1][0];
      buffer[1][0] = obstruction === "hidden"
        ? { ...cell, style: { ...cell.style, hidden: true } }
        : { ...cell, hyperlink: { uri: "https://example.com", id: "other" } };
    }
    expect(findPathAtCell(buffer, { row: 0, col: 3 })).toBeNull();
  }
});

test("recognizes file URIs across matching Markdown continuation indentation", () => {
  const path = "/home/me/exports/apple-homeview-family-screen-explained-shorts/apple-homeview-family-screen-explained-shorts.mp4";
  const uri = `file://${path}`;
  for (const indentation of [2, 3, 4]) {
    const padding = " ".repeat(indentation);
    const split = 80 - indentation - 2;
    const parser = new AnsiParser(80, 5);
    parser.write(`\x1b[?7l${padding}\x1b[4mOpen video\x1b[0m\r\n${padding}(${uri.slice(0, split)} \r\n${padding}${uri.slice(split)})`);
    for (const point of [
      { row: 0, col: indentation + 2 },
      { row: 1, col: indentation + 8 },
      { row: 2, col: indentation + 4 },
    ]) expect(findPathAtCell(parser.getBuffer(), point)?.path).toBe(path);
  }
});

test("indented continuations cannot hide a linked or concealed middle margin cell", () => {
  const path = `/tmp/${"a".repeat(90)}.mp4`;
  for (const linked of [false, true]) {
    const parser = new AnsiParser(80, 4);
    parser.write(`\x1b[?7l   (${path.slice(0, 75)} \r\n   ${path.slice(75)})`);
    const buffer = parser.getBuffer();
    const margin = buffer[1][1];
    buffer[1][1] = linked
      ? { ...margin, hyperlink: { uri: "https://example.com", id: "other" } }
      : { ...margin, style: { ...margin.style, hidden: true } };
    expect(findPathAtCell(buffer, { row: 0, col: 12 })).toBeNull();
    expect(findPathAtCell(buffer, { row: 1, col: 6 })).toBeNull();
  }
});

test("Markdown indentation survives real pane clipping and both right margins", () => {
  const path = "/home/me/exports/family-screen-explained-shorts/family-screen-explained-shorts.mp4";
  const uri = `file://${path}`;
  for (const margin of [1, 2]) {
    const parser = new AnsiParser(104, 5);
    parser.write("\x1b[?7l");
    for (let line = 1; line <= 5; line++) {
      parser.write(`\x1b[${line};1H/sidebar/file\x1b[${line};16H│\x1b[${line};97H│`);
    }
    const split = 80 - 4 - margin;
    parser.write(`\x1b[1;17H   \x1b[4mOpen video\x1b[0m`);
    parser.write(`\x1b[2;17H   (${uri.slice(0, split)}${" ".repeat(margin)}`);
    parser.write(`\x1b[3;17H   ${uri.slice(split)})`);
    for (const point of [{ row: 0, col: 21 }, { row: 1, col: 30 }, { row: 2, col: 25 }]) {
      expect(findPathAtCell(parser.getBuffer(), point)?.path).toBe(path);
    }
  }
});

test("mutating an indented continuation cannot expose its surviving prefix", () => {
  for (const command of ["2K", "M", "J"]) {
    const parser = new AnsiParser(16, 3);
    parser.write("   /tmp/fooABCD \r\n   /baz");
    expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 6 })?.path).toBe("/tmp/fooABCD/baz");
    parser.write(`\x1b[2;1H\x1b[${command}`);
    expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 6 })).toBeNull();
  }
});

test("evicting an indented predecessor cannot expose its surviving suffix", () => {
  const parser = new AnsiParser(16, 1);
  parser.write("   /tmp/fooABCD \r\n   /baz");
  parser.setMaxScrollback(0);
  expect(findPathAtCell(parser.getFullBuffer(), { row: 0, col: 5 })).toBeNull();
});

test("erasing a composed continuation with two right margins invalidates its prefix", () => {
  const parser = new AnsiParser(17, 3);
  parser.write("\x1b[?7l│   /tmp/xxxxxx  \r\n│   /baz\r\n│");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 7 })?.path).toBe("/tmp/xxxxxx/baz");
  parser.write("\x1b[2;2H\x1b[K");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 7 })).toBeNull();
});

test("ordinary trailing whitespace does not create a two-margin pane boundary", () => {
  const parser = new AnsiParser(16, 3);
  parser.write("   /tmp/fooABC  \r\n   unrelated");
  parser.write("\x1b[2;1H\x1b[2K");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 6 })?.path).toBe("/tmp/fooABC");
});

test("pane-local mutation guards ignore differing sidebar indentation", () => {
  for (const mutation of ["\x1b[2;7H\x1b[K", "\x1b[1;1H\x1b[M"]) {
    const parser = new AnsiParser(22, 4);
    parser.write("\x1b[?7lX    │   /tmp/fooABCD \r\n     │   /baz\r\n     │\r\n     │");
    expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 12 })?.path).toBe("/tmp/fooABCD/baz");
    parser.write(mutation);
    expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 12 })).toBeNull();
  }
});

test("pane-local eviction retains lost ancestry despite changing sidebar content", () => {
  const parser = new AnsiParser(22, 1);
  parser.write("\x1b[?7lX    │   /tmp/fooABCD \r\n     │   /baz");
  parser.setMaxScrollback(0);
  expect(findPathAtCell(parser.getFullBuffer(), { row: 0, col: 11 })).toBeNull();
});

test("sidebar-only erasure leaves the untouched composed file link actionable", () => {
  for (const sidebar of [["X    ", "     ", "     "], ["abcde", "vwxyz", "alpha"]]) {
    for (const mutation of ["\x1b[1;1H\x1b[5X", "\x1b[1;5H\x1b[1K", "\x1b[1;5H\x1b[1J"]) {
      const parser = new AnsiParser(22, 3);
      parser.write(`\x1b[?7l${sidebar[0]}│   /tmp/fooABCD \r\n${sidebar[1]}│   /baz\r\n${sidebar[2]}│`);
      parser.write(mutation);
      expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 12 })?.path).toBe("/tmp/fooABCD/baz");
    }
  }
});

test("uncertainty in one pane survives a later mutation in another pane", () => {
  const parser = new AnsiParser(33, 3);
  parser.write(`\x1b[?7l /tmp/leftABCDE │ /tmp/rightABCD \r\n${" tail".padEnd(16)}│${" tail".padEnd(16)}\r\n${" ".repeat(16)}│`);
  parser.write("\x1b[2;1H\x1b[16X");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 5 })).toBeNull();
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 23 })?.path).toBe("/tmp/rightABCDtail");
  parser.write("\x1b[2;18H\x1b[16X");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 5 })).toBeNull();
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 23 })).toBeNull();
});
