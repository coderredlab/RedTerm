// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { DEFAULT_STYLE, type Cell } from "./ansi-parser";
import { extractTerminalSelection } from "./terminal-selection";

function cell(char: string, hidden = false): Cell {
  return {
    char,
    style: { ...DEFAULT_STYLE, hidden },
  };
}

describe("extractTerminalSelection", () => {
  test("replaces concealed cells with visible spaces", () => {
    const buffer = [[
      cell("e"),
      cell("c"),
      cell("h"),
      cell("o"),
      cell("r", true),
      cell("m", true),
      cell("-"),
      cell("o"),
      cell("k"),
    ]];

    const text = extractTerminalSelection(buffer, {
      start: { row: 0, col: 0 },
      end: { row: 0, col: 8 },
    });

    expect(text).toBe("echo  -ok");
    expect(text).not.toContain("rm");
  });

  test("preserves line boundaries and skips wide-character placeholders", () => {
    const buffer = [
      [cell("A"), cell(""), cell("B")],
      [cell("C"), cell("D")],
    ];

    expect(extractTerminalSelection(buffer, {
      start: { row: 0, col: 0 },
      end: { row: 1, col: 1 },
    })).toBe("AB\nCD");
  });
});
