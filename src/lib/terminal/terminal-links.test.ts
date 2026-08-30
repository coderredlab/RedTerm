// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { AnsiParser, DEFAULT_STYLE, type Cell } from "./ansi-parser";
import { findUrlAtCell, validateTerminalUrl } from "./terminal-links";

function bufferFromRows(...texts: string[]): Cell[][] {
  return texts.map((text) =>
    [...text].map((char) => ({ char, style: DEFAULT_STYLE }))
  );
}

describe("findUrlAtCell", () => {
  test("returns the full https URL with path, query, hash, and inclusive columns when clicked inside it", () => {
    const url = "https://example.com/docs/page?term=redterm&sort=asc#section-2";
    const text = `open ${url} now`;
    const startCol = text.indexOf(url);

    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: startCol + 12 })).toEqual({
      url,
      startCol,
      endCol: startCol + url.length - 1,
    });
  });

  test("trims prose punctuation from the URL and does not treat those trailing cells as clickable", () => {
    const url = "https://example.com/releases?tag=v1.5.1#notes";
    const text = `see (${url}).`;
    const startCol = text.indexOf(url);
    const endCol = startCol + url.length - 1;

    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: startCol + 8 })).toEqual({
      url,
      startCol,
      endCol,
    });
    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: endCol + 1 })).toBeNull();
    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: endCol + 2 })).toBeNull();
  });

  test("returns null when the clicked cell is outside the URL on the visual row", () => {
    const url = "https://example.com/path";
    const text = `prefix ${url} suffix`;
    const startCol = text.indexOf(url);
    const endCol = startCol + url.length - 1;

    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: startCol - 1 })).toBeNull();
    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: endCol + 1 })).toBeNull();
    expect(findUrlAtCell(bufferFromRows(text, "same column has no link"), { row: 1, col: startCol + 4 })).toBeNull();
  });

  test("ignores ftp and javascript schemes", () => {
    for (const { text, col } of [
      { text: "download ftp://example.com/archive.tar.gz", col: "download ftp://".length + 4 },
      { text: "run javascript:alert(1)", col: "run javascript:".length + 1 },
    ]) {
      expect(findUrlAtCell(bufferFromRows(text), { row: 0, col })).toBeNull();
    }
  });
  test("returns null for a row-ending URL candidate when the next row continues with URL-safe text", () => {
    const firstRow = "https://example.com/very-";
    const buffer = bufferFromRows(firstRow, "long/path");

    expect(findUrlAtCell(buffer, { row: 0, col: firstRow.indexOf("example") })).toBeNull();
  });

  test("returns null for a row-ending URL candidate when trimmed punctuation hides a continuation", () => {
    const firstRow = "https://example.com/search?";
    const buffer = bufferFromRows(firstRow, "q=red");

    expect(findUrlAtCell(buffer, { row: 0, col: firstRow.indexOf("example") })).toBeNull();
  });


  test("does not make URLs with hidden cells clickable", () => {
    const url = "https://example.com/path";
    const buffer = bufferFromRows(url);
    buffer[0]["https://".length + 2].style = { ...DEFAULT_STYLE, hidden: true };

    expect(findUrlAtCell(buffer, { row: 0, col: 10 })).toBeNull();
  });
  test("uses an OSC 8 hyperlink across its contiguous cell range", () => {
    const buffer = bufferFromRows("click plain");
    for (let col = 0; col < 5; col++) {
      buffer[0][col].hyperlink = { uri: "https://example.com/docs", id: "docs" };
    }

    expect(findUrlAtCell(buffer, { row: 0, col: 2 })).toEqual({
      url: "https://example.com/docs",
      startCol: 0,
      endCol: 4,
    });
    expect(findUrlAtCell(buffer, { row: 0, col: 6 })).toBeNull();
    buffer[0][0].hyperlink = { uri: "javascript:alert(1)" };
    expect(findUrlAtCell(buffer, { row: 0, col: 0 })).toBeNull();
  });

  test("maps UTF-16 match offsets back to terminal cell columns", () => {
    const url = "https://example.com";
    const buffer = bufferFromRows(`😀${url}`);

    expect(findUrlAtCell(buffer, { row: 0, col: 1 })).toEqual({
      url: "https://example.com/",
      startCol: 1,
      endCol: url.length,
    });
    expect(findUrlAtCell(buffer, { row: 0, col: url.length + 1 })).toBeNull();
  });
  test("keeps wide characters and their continuation cells inside one URL", () => {
    const parser = new AnsiParser(80, 3);
    const url = "https://example.com/경로";
    parser.write(url);
    const endCol = "https://example.com/".length + 3;

    const expected = {
      url: new URL(url).href,
      startCol: 0,
      endCol,
    };
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })).toEqual(expected);
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: endCol })).toEqual(expected);
  });


});

describe("validateTerminalUrl", () => {
  test("normalizes safe HTTP origins for confirmation and opening", () => {
    expect(validateTerminalUrl("HTTPS://EXAMPLE.COM:443/path?q=1")).toEqual({
      url: "https://example.com/path?q=1",
      origin: "example.com",
    });
    expect(validateTerminalUrl("http://example.com:8080/")).toEqual({
      url: "http://example.com:8080/",
      origin: "example.com:8080",
    });
  });

  test("rejects userinfo and bidirectional control characters", () => {
    expect(validateTerminalUrl("https://trusted.example@evil.example/")).toBeNull();
    expect(validateTerminalUrl("https://evil.example/\u202etrusted.example")).toBeNull();
  });
});
