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
  test("maps Control+Backspace to word erase on Windows and Linux", () => {
    const modifiers = { ...noModifiers, ctrlKey: true };
    expect(getBackspaceKeyCode(modifiers, "Win32")).toBe("");
    expect(getBackspaceKeyCode(modifiers, "Linux x86_64")).toBe("");
  });

  test("maps Command+Backspace to word erase on macOS", () => {
    expect(
      getBackspaceKeyCode({ ...noModifiers, metaKey: true }, "MacIntel"),
    ).toBe("");
  });

  test("does not use the opposite platform modifier for word erase", () => {
    expect(
      getBackspaceKeyCode({ ...noModifiers, ctrlKey: true }, "MacIntel"),
    ).toBe(KeyCodes.BACKSPACE);
    expect(
      getBackspaceKeyCode({ ...noModifiers, metaKey: true }, "Win32"),
    ).toBe(KeyCodes.BACKSPACE);
  });

  test("keeps plain Backspace as DEL", () => {
    expect(getBackspaceKeyCode(noModifiers, "MacIntel")).toBe(KeyCodes.BACKSPACE);
  });

  test("does not override Backspace combined with other modifiers", () => {
    expect(
      getBackspaceKeyCode(
        { ...noModifiers, metaKey: true, altKey: true },
        "MacIntel",
      ),
    ).toBe(KeyCodes.BACKSPACE);
    expect(
      getBackspaceKeyCode(
        { ...noModifiers, ctrlKey: true, metaKey: true },
        "Win32",
      ),
    ).toBe(KeyCodes.BACKSPACE);
    expect(
      getBackspaceKeyCode(
        { ...noModifiers, ctrlKey: true, shiftKey: true },
        "Linux x86_64",
      ),
    ).toBe(KeyCodes.BACKSPACE);
  });
});
