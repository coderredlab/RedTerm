// @ts-nocheck
import { describe, expect, test } from "bun:test";

import {
  encodeKittyInputText,
  encodeKittyKeyboardEvent,
  encodeKittyTextEvent,
  KITTY_KEYBOARD_FLAGS,
  resolveKittyLayoutKey,
  resolveKittyUnshiftedKey,
  type KittyKeyboardEvent,
} from "./kitty-keyboard";

const plainKey = (key: string, code = ""): KittyKeyboardEvent => ({ key, code });

describe("Kitty keyboard event encoding", () => {
  test("leaves ordinary text to the input event in disambiguation mode", () => {
    expect(
      encodeKittyKeyboardEvent(plainKey("a", "KeyA"), KITTY_KEYBOARD_FLAGS.DISAMBIGUATE),
    ).toBeNull();
  });

  test("disambiguates control text keys with CSI u", () => {
    expect(
      encodeKittyKeyboardEvent(
        { ...plainKey("i", "KeyI"), ctrlKey: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x1b[105;5u");
  });

  test("reports control-key repeat and release events without all-key mode", () => {
    const key = { ...plainKey("i", "KeyI"), ctrlKey: true };
    expect(
      encodeKittyKeyboardEvent(key, KITTY_KEYBOARD_FLAGS.REPORT_EVENTS, "repeat"),
    ).toBe("\x1b[105;5:2u");
    expect(
      encodeKittyKeyboardEvent(key, KITTY_KEYBOARD_FLAGS.REPORT_EVENTS, "release"),
    ).toBe("\x1b[105;5:3u");
    expect(
      encodeKittyKeyboardEvent(
        plainKey("Control", "ControlLeft"),
        KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
      ),
    ).toBeNull();
  });

  test("reports shifted and base-layout alternate keys", () => {
    expect(
      encodeKittyKeyboardEvent(
        { key: "С", code: "KeyC", shiftKey: true, ctrlKey: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE | KITTY_KEYBOARD_FLAGS.REPORT_ALTERNATE_KEYS,
      ),
    ).toBe("\x1b[1089:1057:99;6u");
  });

  test("uses canonical CSI forms for navigation keys and event types", () => {
    const arrow = plainKey("ArrowUp", "ArrowUp");
    expect(encodeKittyKeyboardEvent(arrow, KITTY_KEYBOARD_FLAGS.DISAMBIGUATE)).toBe("\x1b[A");
    expect(
      encodeKittyKeyboardEvent(
        { ...arrow, repeat: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
      ),
    ).toBe("\x1b[1;1:2A");
    expect(
      encodeKittyKeyboardEvent(
        arrow,
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBe("\x1b[1;1:3A");
  });

  test("reports all text keys with associated text", () => {
    expect(
      encodeKittyKeyboardEvent(
        { key: "A", code: "KeyA", shiftKey: true },
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ALTERNATE_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT,
      ),
    ).toBe("\x1b[97:65;2;65u");
  });

  test("encodes pure IME text when associated text reporting is active", () => {
    expect(
      encodeKittyTextEvent(
        "한글",
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS | KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT,
      ),
    ).toBe("\x1b[0;1;54620:44544u");
    expect(encodeKittyTextEvent("한글", KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS)).toBeNull();
  });

  test("maps extended function, keypad, and modifier keys", () => {
    expect(
      encodeKittyKeyboardEvent(plainKey("F13", "F13"), KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS),
    ).toBe("\x1b[57376u");
    expect(
      encodeKittyKeyboardEvent(
        plainKey("ArrowLeft", "Numpad4"),
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x1b[57417u");
    expect(
      encodeKittyKeyboardEvent(
        plainKey("Control", "ControlLeft"),
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBe("\x1b[57442;1:3u");
  });

  test("includes lock modifiers when the browser exposes them", () => {
    expect(
      encodeKittyKeyboardEvent(
        {
          ...plainKey("a", "KeyA"),
          getModifierState: (key) => key === "CapsLock" || key === "NumLock",
        },
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS,
      ),
    ).toBe("\x1b[97;193u");
  });

  test("keeps unmodified recoverable keys on the legacy path", () => {
    expect(
      encodeKittyKeyboardEvent(plainKey("Enter", "Enter"), KITTY_KEYBOARD_FLAGS.DISAMBIGUATE),
    ).toBe("\r");
    expect(
      encodeKittyKeyboardEvent(
        plainKey("Backspace", "Backspace"),
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x7f");
    expect(
      encodeKittyKeyboardEvent(plainKey("Tab", "Tab"), KITTY_KEYBOARD_FLAGS.DISAMBIGUATE),
    ).toBe("\t");
  });

  test("encodes modified recoverable keys in disambiguation mode", () => {
    expect(
      encodeKittyKeyboardEvent(
        { ...plainKey("Enter", "Enter"), altKey: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x1b[13;3u");
    expect(
      encodeKittyKeyboardEvent(
        { ...plainKey("Backspace", "Backspace"), ctrlKey: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x1b[127;5u");
    expect(
      encodeKittyKeyboardEvent(
        { ...plainKey("Tab", "Tab"), shiftKey: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x1b[9;2u");
  });

  test("reports modified recoverable-key releases", () => {
    expect(
      encodeKittyKeyboardEvent(
        { ...plainKey("Enter", "Enter"), altKey: true },
        KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBe("\x1b[13;3:3u");
    expect(
      encodeKittyKeyboardEvent(
        plainKey("Enter", "Enter"),
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBeNull();
  });

  test("uses dedicated keypad codes for non-text actions", () => {
    const key = plainKey("1", "Numpad1");
    expect(
      encodeKittyKeyboardEvent(
        { ...key, ctrlKey: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x1b[57400;5u");
    expect(
      encodeKittyKeyboardEvent(
        { ...key, altKey: true },
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE,
      ),
    ).toBe("\x1b[57400;3u");
    expect(
      encodeKittyKeyboardEvent(
        key,
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBe("\x1b[57400;1:3u");
    expect(
      encodeKittyKeyboardEvent(
        key,
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "repeat",
      ),
    ).toBeNull();
  });

  test("keeps legacy keypad identity in event-reporting-only mode", () => {
    const key = plainKey("1", "Numpad1");
    expect(
      encodeKittyKeyboardEvent(
        { ...key, ctrlKey: true },
        KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
      ),
    ).toBe("\x1b[49;5u");
    expect(
      encodeKittyKeyboardEvent(
        key,
        KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBe("\x1b[49;1:3u");
  });

  test("leaves text-producing numpad keys on the text path", () => {
    const key = plainKey("1", "Numpad1");
    expect(encodeKittyKeyboardEvent(key, KITTY_KEYBOARD_FLAGS.DISAMBIGUATE)).toBeNull();
    expect(encodeKittyKeyboardEvent(key, KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS)).toBe(
      "\x1b[57400u",
    );
    expect(
      encodeKittyKeyboardEvent(
        key,
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT,
      ),
    ).toBe("\x1b[57400;1;49u");
  });

  test("reports text-key release after its control modifier is released", () => {
    expect(
      encodeKittyKeyboardEvent(
        plainKey("a", "KeyA"),
        KITTY_KEYBOARD_FLAGS.DISAMBIGUATE | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBe("\x1b[97;1:3u");
  });

  test("keeps current and base layouts separate for shifted keys", () => {
    expect(
      encodeKittyKeyboardEvent(
        { key: "2", code: "Digit2", shiftKey: true, unshiftedKey: "é" },
        KITTY_KEYBOARD_FLAGS.REPORT_ALTERNATE_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT,
      ),
    ).toBe("\x1b[233:50:50;2;50u");
  });

  test("distinguishes AltGraph from the right Alt key", () => {
    expect(
      encodeKittyKeyboardEvent(
        plainKey("AltGraph", "AltRight"),
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS,
      ),
    ).toBe("\x1b[57453u");
  });

  test("encodes Ctrl+Shift+Tab canonically in disambiguation mode", () => {
    const key = { ...plainKey("Tab", "Tab"), shiftKey: true, ctrlKey: true };
    expect(encodeKittyKeyboardEvent(key, KITTY_KEYBOARD_FLAGS.DISAMBIGUATE)).toBe(
      "\x1b[9;6u",
    );
    expect(
      encodeKittyKeyboardEvent(key, KITTY_KEYBOARD_FLAGS.DISAMBIGUATE, "release"),
    ).toBeNull();
  });

  test("reports lock-key presses only in all-key mode", () => {
    for (const key of ["CapsLock", "NumLock", "ScrollLock"]) {
      expect(
        encodeKittyKeyboardEvent(plainKey(key, key), KITTY_KEYBOARD_FLAGS.DISAMBIGUATE),
      ).toBeNull();
      expect(
        encodeKittyKeyboardEvent(plainKey(key, key), KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS),
      ).not.toBeNull();
    }
  });

  test("resolves the active native layout from shifted key text", () => {
    const layouts = [
      { unshifted: "2", shifted: "@" },
      { unshifted: "é", shifted: "2" },
    ];
    expect(resolveKittyUnshiftedKey({ key: "2", shiftKey: true }, layouts)).toBe("é");
    expect(resolveKittyUnshiftedKey({ key: "é" }, layouts)).toBe("é");
  });

  test("uses the unshifted layout value while Caps Lock changes event text", () => {
    expect(
      resolveKittyUnshiftedKey(
        { key: "A" },
        [{ unshifted: "a", shifted: "A" }],
      ),
    ).toBe("a");
  });

  test("includes AltGraph text and resolves its native layout level", () => {
    const altGraph = (modifier: string) => modifier === "AltGraph";
    expect(
      encodeKittyKeyboardEvent(
        {
          key: "@",
          code: "KeyQ",
          ctrlKey: true,
          altKey: true,
          unshiftedKey: "q",
          getModifierState: altGraph,
        },
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT,
      ),
    ).toBe("\x1b[113;7;64u");
    expect(
      resolveKittyUnshiftedKey(
        { key: "@", getModifierState: altGraph },
        [
          { unshifted: "q", shifted: "Q" },
          { unshifted: "q", shifted: "Q", alt_gr: "@" },
        ],
      ),
    ).toBe("q");
  });

  test("includes associated text only when Alt produces text", () => {
    const flags =
      KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
      KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT;
    expect(
      encodeKittyKeyboardEvent(
        { key: "a", code: "KeyA", altKey: true },
        flags,
      ),
    ).toBe("\x1b[97;3u");
    expect(
      encodeKittyKeyboardEvent(
        { key: "å", code: "KeyA", altKey: true, unshiftedKey: "a" },
        flags,
      ),
    ).toBe("\x1b[97;3;229u");
  });

  test("resolves printable XKB levels beyond Shift+AltGraph", () => {
    expect(
      resolveKittyUnshiftedKey(
        { key: "º" },
        [
          { unshifted: "q", shifted: "Q" },
          { unshifted: "q", shifted: "Q", other: ["º"] },
        ],
      ),
    ).toBe("q");
  });

  test("reports dead keys from their unshifted layout value", () => {
    const deadQuote = { key: "Dead", code: "Quote", unshiftedKey: "'" };
    expect(
      encodeKittyKeyboardEvent(deadQuote, KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS),
    ).toBe("\x1b[39u");
    expect(
      encodeKittyKeyboardEvent(
        deadQuote,
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS | KITTY_KEYBOARD_FLAGS.REPORT_EVENTS,
        "release",
      ),
    ).toBe("\x1b[39;1:3u");
  });

  test("uses active-layout values for shifted JIS keys", () => {
    expect(
      encodeKittyKeyboardEvent(
        { key: "|", code: "IntlYen", shiftKey: true, unshiftedKey: "¥" },
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ALTERNATE_KEYS,
      ),
    ).toBe("\x1b[165:124;2u");
  });

  test("suppresses IME text when all-key mode omits associated text", () => {
    expect(encodeKittyInputText("漢", KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS)).toBe("");
    expect(
      encodeKittyInputText(
        "漢",
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT,
      ),
    ).toBe("\x1b[0;1;28450u");
    expect(encodeKittyInputText("漢", 0)).toBe("漢");
    expect(encodeKittyInputText("漢", KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT)).toBe("漢");
  });

  test("uses shifted-only layout text for alternate key reporting", () => {
    const selectedLayout = { unshifted: "2", shifted: "@", other: ["€"] };
    expect(
      resolveKittyLayoutKey(
        { key: "€", shiftKey: true },
        [
          { unshifted: "2", shifted: "#" },
          selectedLayout,
        ],
      ),
    ).toBe(selectedLayout);
    expect(
      encodeKittyKeyboardEvent(
        {
          key: "€",
          code: "Digit2",
          shiftKey: true,
          altKey: true,
          unshiftedKey: "2",
          shiftedKey: "@",
        },
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ALTERNATE_KEYS,
      ),
    ).toBe("\x1b[50:64;4u");
    expect(
      encodeKittyKeyboardEvent(
        {
          key: "a",
          code: "KeyA",
          shiftKey: true,
          unshiftedKey: "a",
          shiftedKey: "A",
          getModifierState: (key) => key === "CapsLock",
        },
        KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS |
          KITTY_KEYBOARD_FLAGS.REPORT_ALTERNATE_KEYS,
      ),
    ).toBe("\x1b[97:65;66u");
  });
});
