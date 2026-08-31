// @ts-nocheck
import { describe, expect, test } from "bun:test";

import {
  handleDesktopShortcuts,
  isTerminalShortcutTarget,
  type DesktopShortcutHandlers,
} from "./shortcuts";

function keyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: "",
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
function withShortcutTargets<T>(
  run: (targets: { body: EventTarget; outside: EventTarget }) => T,
): T {
  const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Element");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  class ShortcutTarget extends EventTarget {
    closest(): null {
      return null;
    }
  }
  const body = new ShortcutTarget();
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: ShortcutTarget,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body },
  });
  try {
    return run({ body, outside: new ShortcutTarget() });
  } finally {
    if (elementDescriptor) Object.defineProperty(globalThis, "Element", elementDescriptor);
    else delete globalThis.Element;
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
  }
}

describe("handleDesktopShortcuts", () => {
  test("copies a terminal selection with Control+Shift+C on Windows", () => {
    withNavigatorPlatform("Win32", () => {
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
  });

  test("copies with Meta+Shift+C on macOS", () => {
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

  test("uses physical C and V keys with localized input sources", () => {
    for (const { platform, modifier } of [
      { platform: "MacIntel", modifier: { metaKey: true } },
      { platform: "Win32", modifier: { ctrlKey: true } },
      { platform: "Linux x86_64", modifier: { ctrlKey: true } },
    ]) {
      withNavigatorPlatform(platform, () => {
        for (const { code, key, expected } of [
          { code: "KeyC", key: "ㅊ", expected: "copySelection" },
          { code: "KeyV", key: "ㅍ", expected: "pasteFromClipboard" },
        ]) {
          const calls: string[] = [];
          const consumed = handleDesktopShortcuts(
            keyboardEvent({ code, key, shiftKey: true, ...modifier }),
            handlers(calls),
            () => true,
            true,
          );

          expect(consumed).toBe(true);
          expect(calls).toEqual([expected]);
        }
      });
    }
  });

  test("copies an active selection after selection mode blurs terminal input", () => {
    withNavigatorPlatform("MacIntel", () => {
      const calls: string[] = [];
      const terminalTarget = isTerminalShortcutTarget(null, true);

      const consumed = handleDesktopShortcuts(
        keyboardEvent({ code: "KeyC", key: "ㅊ", metaKey: true, shiftKey: true }),
        handlers(calls),
        () => true,
        terminalTarget,
      );

      expect(terminalTarget).toBe(true);
      expect(consumed).toBe(true);
      expect(calls).toEqual(["copySelection"]);
    });
  });

  test("does not treat an unfocused terminal without a selection as a shortcut target", () => {
    expect(isTerminalShortcutTarget(null, false)).toBe(false);
  });
  test("keeps selection shortcuts on body after terminal input blur", () => {
    withShortcutTargets(({ body }) => {
      expect(isTerminalShortcutTarget(body, true)).toBe(true);
    });
  });

  test("does not route clipboard shortcuts from non-terminal surfaces", () => {
    withNavigatorPlatform("MacIntel", () => {
      withShortcutTargets(({ outside }) => {
        expect(isTerminalShortcutTarget(outside, true)).toBe(false);

        for (const { code, key } of [
          { code: "KeyC", key: "c" },
          { code: "KeyV", key: "v" },
        ]) {
          const calls: string[] = [];
          const consumed = handleDesktopShortcuts(
            keyboardEvent({ code, key, metaKey: true, shiftKey: true }),
            handlers(calls),
            () => true,
            isTerminalShortcutTarget(outside, true),
          );
          expect(consumed).toBe(false);
          expect(calls).toEqual([]);
        }
      });
    });
  });

  test("leaves Control+Shift+C to the terminal on macOS", () => {
    withNavigatorPlatform("MacIntel", () => {
      const calls: string[] = [];

      const consumed = handleDesktopShortcuts(
        keyboardEvent({ key: "c", ctrlKey: true, shiftKey: true }),
        handlers(calls),
        () => true,
        true,
      );

      expect(consumed).toBe(false);
      expect(calls).toEqual([]);
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

  test("pastes with Control+Shift+V on Windows", () => {
    withNavigatorPlatform("Win32", () => {
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
  });

  test("pastes with Meta+Shift+V on macOS", () => {
    withNavigatorPlatform("MacIntel", () => {
      const calls: string[] = [];

      const consumed = handleDesktopShortcuts(
        keyboardEvent({ key: "v", metaKey: true, shiftKey: true }),
        handlers(calls),
        () => true,
        true,
      );

      expect(consumed).toBe(true);
      expect(calls).toEqual(["pasteFromClipboard"]);
    });
  });

  test("leaves Control+Shift+V to the terminal on macOS", () => {
    withNavigatorPlatform("MacIntel", () => {
      const calls: string[] = [];

      const consumed = handleDesktopShortcuts(
        keyboardEvent({ key: "v", ctrlKey: true, shiftKey: true }),
        handlers(calls),
        () => true,
        true,
      );

      expect(consumed).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  test("leaves Meta+Shift+C and V to the terminal on Windows", () => {
    withNavigatorPlatform("Win32", () => {
      for (const key of ["c", "v"]) {
        const calls: string[] = [];
        const consumed = handleDesktopShortcuts(
          keyboardEvent({ key, metaKey: true, shiftKey: true }),
          handlers(calls),
          () => true,
          true,
        );

        expect(consumed).toBe(false);
        expect(calls).toEqual([]);
      }
    });
  });

  test("rejects mixed and Alt clipboard modifier chords", () => {
    for (const { platform, modifiers } of [
      { platform: "MacIntel", modifiers: { metaKey: true, ctrlKey: true } },
      { platform: "MacIntel", modifiers: { metaKey: true, altKey: true } },
      { platform: "Win32", modifiers: { ctrlKey: true, metaKey: true } },
      { platform: "Win32", modifiers: { ctrlKey: true, altKey: true } },
      { platform: "Linux x86_64", modifiers: { ctrlKey: true, metaKey: true } },
      { platform: "Linux x86_64", modifiers: { ctrlKey: true, altKey: true } },
    ]) {
      withNavigatorPlatform(platform, () => {
        for (const { code, key } of [
          { code: "KeyC", key: "c" },
          { code: "KeyV", key: "v" },
        ]) {
          const calls: string[] = [];
          const consumed = handleDesktopShortcuts(
            keyboardEvent({ code, key, shiftKey: true, ...modifiers }),
            handlers(calls),
            () => true,
            true,
          );

          expect(consumed).toBe(false);
          expect(calls).toEqual([]);
        }
      });
    }
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
