// @ts-nocheck
import { expect, test } from "bun:test";
import { AnsiParser, DEFAULT_STYLE } from "./ansi-parser";
import { findPathAtCell, resolveTerminalPath } from "./terminal-paths";

const row = (text: string) => [[...text].map(char => ({ char, style: DEFAULT_STYLE }))];
test("detects absolute, home, Windows and quoted paths with source line suffixes", () => {
  for (const [text, path] of [
    ["at /home/me/src/main.ts:12:4", "/home/me/src/main.ts"],
    ["open ~/Projects/RedTerm", "~/Projects/RedTerm"],
    [String.raw`at C:\Users\me\main.rs:7`, "C:/Users/me/main.rs"],
    ['open "/home/me/My Project/file.ts"', "/home/me/My Project/file.ts"],
  ]) {
    expect(findPathAtCell(row(text), { row: 0, col: 10 })?.path).toBe(path);
  }
  expect(findPathAtCell(row("at /home/me/file.ts"), { row: 0, col: 0 })).toBeNull();
});
test("requires reported cwd for relative paths and never uses a web URL as a file path", () => {
  expect(resolveTerminalPath("src/main.ts")).toBeNull();
  expect(resolveTerminalPath("src/main.ts", "file:///home/me/project")).toBe("/home/me/project/src/main.ts");
  expect(resolveTerminalPath("https://example.com/a/b", "file:///home/me")).toBeNull();
  expect(resolveTerminalPath("ordinary-word", "file:///home/me")).toBeNull();
  expect(resolveTerminalPath("file:///home/me/%00bad")).toBeNull();
  expect(resolveTerminalPath("file:///home/me/a?b")).toBeNull();
});
test("uses OSC 8 file target behind its label and rejects hidden or non-file links", () => {
  const parser = new AnsiParser(60, 2);
  parser.write("\x1b]8;;file:///home/me/My%20Project/file.ts\x1b\\source\x1b]8;;\x1b\\");
  expect(findPathAtCell(parser.getBuffer(), { row: 0, col: 2 })?.path).toBe("/home/me/My Project/file.ts");
  const hidden = row("/home/me/file.ts");
  hidden[0][3].style = { ...DEFAULT_STYLE, hidden: true };
  expect(findPathAtCell(hidden, { row: 0, col: 4 })).toBeNull();
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
