// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { getBackspaceKeyCode, KeyCodes } from "./key-mapper";

const noModifiers = {
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("getBackspaceKeyCode", () => {
  test("maps Ctrl+Backspace to the shell word-erase control character", () => {
    expect(getBackspaceKeyCode({ ...noModifiers, ctrlKey: true })).toBe("\x17");
  });

  test("keeps plain Backspace as DEL", () => {
    expect(getBackspaceKeyCode(noModifiers)).toBe(KeyCodes.BACKSPACE);
  });

  test("does not override Backspace combined with other modifiers", () => {
    expect(getBackspaceKeyCode({ ...noModifiers, ctrlKey: true, altKey: true })).toBe(
      KeyCodes.BACKSPACE,
    );
    expect(getBackspaceKeyCode({ ...noModifiers, ctrlKey: true, metaKey: true })).toBe(
      KeyCodes.BACKSPACE,
    );
    expect(getBackspaceKeyCode({ ...noModifiers, ctrlKey: true, shiftKey: true })).toBe(
      KeyCodes.BACKSPACE,
    );
  });
});
