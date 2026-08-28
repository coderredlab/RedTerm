// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { formatTerminalPaste, MAX_TERMINAL_PASTE_CHARS } from "./terminal-paste";

describe("formatTerminalPaste", () => {
  test("wraps multiline text when bracketed paste mode is active", () => {
    expect(formatTerminalPaste("echo one\necho two", true)).toBe(
      "\x1b[200~echo one\necho two\x1b[201~"
    );
  });

  test("rejects multiline text outside bracketed paste mode", () => {
    expect(() =>
      formatTerminalPaste("one\r\ntwo\nthree\rfour", false)
    ).toThrow("Multiline paste requires bracketed paste mode");
  });

  test("returns an empty payload for empty clipboard text", () => {
    expect(formatTerminalPaste("", true)).toBe("");
  });

  test("removes injected bracket terminators and unsafe controls", () => {
    const text = `safe\x1b[201~\nrm -rf /tmp/example\x1b[200~\x00`;
    const formatted = formatTerminalPaste(text, true);

    expect(formatted).toBe(
      "\x1b[200~safe\nrm -rf /tmp/example\x1b[201~"
    );
    expect(formatted.match(/\x1b\[200~/g)).toHaveLength(1);
    expect(formatted.match(/\x1b\[201~/g)).toHaveLength(1);
  });

  test("rejects clipboard text above the fixed character budget", () => {
    expect(() =>
      formatTerminalPaste("x".repeat(MAX_TERMINAL_PASTE_CHARS + 1), true)
    ).toThrow("Pasted text exceeds 1,000,000 characters");
  });

});
