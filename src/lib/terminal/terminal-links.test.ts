// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { DEFAULT_STYLE, type Cell } from "./ansi-parser";
import { findUrlAtCell } from "./terminal-links";

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

});
