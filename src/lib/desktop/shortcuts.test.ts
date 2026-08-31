// @ts-nocheck
import { describe, expect, test } from "bun:test";

import {
  handleDesktopShortcuts,
  type DesktopShortcutHandlers,
} from "./shortcuts";

function keyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

function handlers(calls: string[]): DesktopShortcutHandlers {
  return {
    newConnection: () => calls.push("newConnection"),
    closePane: () => calls.push("closePane"),
    closeTab: () => calls.push("closeTab"),
    nextTab: () => calls.push("nextTab"),
    previousTab: () => calls.push("previousTab"),
    selectTab: (index) => calls.push(`selectTab:${index}`),
    splitRight: () => calls.push("splitRight"),
    splitDown: () => calls.push("splitDown"),
    moveFocus: (direction) => calls.push(`moveFocus:${direction}`),
    openSettings: () => calls.push("openSettings"),
    copySelection: () => calls.push("copySelection"),
    pasteFromClipboard: () => calls.push("pasteFromClipboard"),
  };
}

function withNavigatorPlatform<T>(platform: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "platform", descriptor);
    else delete navigator.platform;
  }
}

describe("handleDesktopShortcuts", () => {
  test("copies a terminal selection with Control+Shift+C", () => {
    const calls: string[] = [];

    const consumed = handleDesktopShortcuts(
      keyboardEvent({ key: "c", ctrlKey: true, shiftKey: true }),
      handlers(calls),
      () => true,
      true,
    );

    expect(consumed).toBe(true);
    expect(calls).toEqual(["copySelection"]);
  });

  test("keeps Meta+Shift+C as a macOS terminal copy shortcut", () => {
    withNavigatorPlatform("MacIntel", () => {
      const calls: string[] = [];

      const consumed = handleDesktopShortcuts(
        keyboardEvent({ key: "C", metaKey: true, shiftKey: true }),
        handlers(calls),
        () => true,
        true,
      );

      expect(consumed).toBe(true);
      expect(calls).toEqual(["copySelection"]);
    });
  });

  test("leaves Meta+Shift+C to the terminal outside macOS", () => {
    withNavigatorPlatform("Linux x86_64", () => {
      const calls: string[] = [];

      const consumed = handleDesktopShortcuts(
        keyboardEvent({ key: "c", metaKey: true, shiftKey: true }),
        handlers(calls),
        () => true,
        true,
      );

      expect(consumed).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  test("pastes into a terminal with Control+Shift+V", () => {
    const calls: string[] = [];

    const consumed = handleDesktopShortcuts(
      keyboardEvent({ key: "v", ctrlKey: true, shiftKey: true }),
      handlers(calls),
      () => true,
      true,
    );

    expect(consumed).toBe(true);
    expect(calls).toEqual(["pasteFromClipboard"]);
  });

  test("does not steal copy outside a terminal", () => {
    const calls: string[] = [];

    const consumed = handleDesktopShortcuts(
      keyboardEvent({ key: "c", ctrlKey: true, shiftKey: true }),
      handlers(calls),
      () => true,
      false,
    );

    expect(consumed).toBe(false);
    expect(calls).toEqual([]);
  });
});
