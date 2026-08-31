import { getBackspaceKeyCode } from "$lib/utils/key-mapper";

export const KITTY_KEYBOARD_FLAGS = {
  DISAMBIGUATE: 1,
  REPORT_EVENTS: 2,
  REPORT_ALTERNATE_KEYS: 4,
  REPORT_ALL_KEYS: 8,
  REPORT_ASSOCIATED_TEXT: 16,
} as const;

export const KITTY_KEYBOARD_SUPPORTED_FLAGS = 31;
export const KITTY_KEYBOARD_STACK_LIMIT = 64;

export type KittyKeyboardEventType = "press" | "repeat" | "release";

export interface KittyKeyboardEvent {
  key: string;
  code?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  getModifierState?: (key: string) => boolean;
  text?: string;
  unshiftedKey?: string;
  shiftedKey?: string;
}

export interface KittyKeyboardLayoutEntry {
  unshifted: string;
  shifted?: string | null;
  alt_gr?: string | null;
  shifted_alt_gr?: string | null;
  other?: readonly string[];
}

export function resolveKittyLayoutKey(
  event: Pick<KittyKeyboardEvent, "key" | "shiftKey" | "getModifierState">,
  candidates: readonly KittyKeyboardLayoutEntry[],
): KittyKeyboardLayoutEntry | undefined {
  const altGraph = event.getModifierState?.("AltGraph") ?? false;
  const altGraphMatch = altGraph
    ? candidates.find((entry) =>
        event.shiftKey ? entry.shifted_alt_gr === event.key : entry.alt_gr === event.key
      )
    : undefined;
  const primaryMatch = candidates.find((entry) =>
    event.shiftKey ? entry.shifted === event.key : entry.unshifted === event.key
  );
  const secondaryMatch = candidates.find((entry) =>
    event.shiftKey ? entry.unshifted === event.key : entry.shifted === event.key
  );
  const otherAltGraphMatch = candidates.find((entry) =>
    event.shiftKey ? entry.alt_gr === event.key : entry.shifted_alt_gr === event.key
  );
  const otherLevelMatch = candidates.find((entry) => entry.other?.includes(event.key));
  return altGraphMatch
    ?? primaryMatch
    ?? secondaryMatch
    ?? otherAltGraphMatch
    ?? otherLevelMatch
    ?? (candidates.length === 1 ? candidates[0] : undefined);
}

export function resolveKittyUnshiftedKey(
  event: Pick<KittyKeyboardEvent, "key" | "shiftKey" | "getModifierState">,
  candidates: readonly KittyKeyboardLayoutEntry[],
): string | undefined {
  return resolveKittyLayoutKey(event, candidates)?.unshifted;
}

type CsiKey = {
  parameter: number;
  final: string;
  omitPlainParameter?: boolean;
};

type KeyDescription =
  | { kind: "unicode"; codePoint: number; textKey: boolean }
  | { kind: "csi"; key: CsiKey; textKey: false };

const CSI = "\x1b[";
const UNICODE_MAX = 0x10ffff;

const CSI_KEYS: Record<string, CsiKey> = {
  Insert: { parameter: 2, final: "~" },
  Delete: { parameter: 3, final: "~" },
  PageUp: { parameter: 5, final: "~" },
  PageDown: { parameter: 6, final: "~" },
  ArrowUp: { parameter: 1, final: "A", omitPlainParameter: true },
  ArrowDown: { parameter: 1, final: "B", omitPlainParameter: true },
  ArrowRight: { parameter: 1, final: "C", omitPlainParameter: true },
  ArrowLeft: { parameter: 1, final: "D", omitPlainParameter: true },
  Home: { parameter: 1, final: "H", omitPlainParameter: true },
  End: { parameter: 1, final: "F", omitPlainParameter: true },
  F1: { parameter: 1, final: "P", omitPlainParameter: true },
  F2: { parameter: 1, final: "Q", omitPlainParameter: true },
  F3: { parameter: 13, final: "~" },
  F4: { parameter: 1, final: "S", omitPlainParameter: true },
  F5: { parameter: 15, final: "~" },
  F6: { parameter: 17, final: "~" },
  F7: { parameter: 18, final: "~" },
  F8: { parameter: 19, final: "~" },
  F9: { parameter: 20, final: "~" },
  F10: { parameter: 21, final: "~" },
  F11: { parameter: 23, final: "~" },
  F12: { parameter: 24, final: "~" },
};

const FUNCTIONAL_CODE_POINTS: Record<string, number> = {
  CapsLock: 57358,
  ScrollLock: 57359,
  NumLock: 57360,
  PrintScreen: 57361,
  Pause: 57362,
  ContextMenu: 57363,
  MediaPlay: 57428,
  MediaPause: 57429,
  MediaPlayPause: 57430,
  MediaReverse: 57431,
  MediaStop: 57432,
  MediaFastForward: 57433,
  MediaRewind: 57434,
  MediaTrackNext: 57435,
  MediaTrackPrevious: 57436,
  MediaRecord: 57437,
  AudioVolumeDown: 57438,
  AudioVolumeUp: 57439,
  AudioVolumeMute: 57440,
};

const MODIFIER_CODE_POINTS: Record<string, number> = {
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450,
};

const LOCK_KEY_CODES: Record<string, true> = {
  CapsLock: true,
  NumLock: true,
  ScrollLock: true,
};

const NUMPAD_CODE_POINTS: Record<string, number> = {
  Numpad0: 57399,
  Numpad1: 57400,
  Numpad2: 57401,
  Numpad3: 57402,
  Numpad4: 57403,
  Numpad5: 57404,
  Numpad6: 57405,
  Numpad7: 57406,
  Numpad8: 57407,
  Numpad9: 57408,
  NumpadDecimal: 57409,
  NumpadDivide: 57410,
  NumpadMultiply: 57411,
  NumpadSubtract: 57412,
  NumpadAdd: 57413,
  NumpadEnter: 57414,
  NumpadEqual: 57415,
  NumpadComma: 57416,
};

const NUMPAD_NAVIGATION_CODE_POINTS: Record<string, number> = {
  ArrowLeft: 57417,
  ArrowRight: 57418,
  ArrowUp: 57419,
  ArrowDown: 57420,
  PageUp: 57421,
  PageDown: 57422,
  Home: 57423,
  End: 57424,
  Insert: 57425,
  Delete: 57426,
  Clear: 57427,
};

const BASE_LAYOUT_KEYS: Record<string, string> = {
  Space: " ",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

function isSinglePrintableCodePoint(value: string): boolean {
  const codePoint = value.codePointAt(0);
  return (
    codePoint !== undefined &&
    codePoint >= 0x20 &&
    codePoint !== 0x7f &&
    !(codePoint >= 0x80 && codePoint <= 0x9f) &&
    String.fromCodePoint(codePoint) === value
  );
}

function baseLayoutCharacter(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("Key") && code.length === 4) return code[3].toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code[5];
  return BASE_LAYOUT_KEYS[code] ?? null;
}

function unshiftedCodePoint(event: KittyKeyboardEvent): number | null {
  const { key, unshiftedKey } = event;
  if (unshiftedKey && isSinglePrintableCodePoint(unshiftedKey)) {
    return unshiftedKey.codePointAt(0) ?? null;
  }
  if (!isSinglePrintableCodePoint(key)) return null;

  const lower = key.toLowerCase();
  if (isSinglePrintableCodePoint(lower) && lower !== key) return lower.codePointAt(0) ?? null;

  if (event.shiftKey) {
    const base = baseLayoutCharacter(event.code);
    if (base) return base.codePointAt(0) ?? null;
  }
  return key.codePointAt(0) ?? null;
}

function numpadCodePoint(
  event: KittyKeyboardEvent,
  reportAll: boolean,
  disambiguate: boolean,
  eventType: KittyKeyboardEventType,
): number | null {
  const code = event.code ?? "";
  const producesText =
    eventType !== "release" &&
    isSinglePrintableCodePoint(event.key) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey;
  const preserveKeypadIdentity = reportAll || disambiguate;
  if (
    !code.startsWith("Numpad") ||
    !preserveKeypadIdentity ||
    (producesText && !reportAll)
  ) {
    return null;
  }
  const navigation = NUMPAD_NAVIGATION_CODE_POINTS[event.key];
  return navigation ?? NUMPAD_CODE_POINTS[code] ?? null;
}

function functionalCodePoint(
  event: KittyKeyboardEvent,
  reportAll: boolean,
  disambiguate: boolean,
  eventType: KittyKeyboardEventType,
): number | null {
  if (event.key === "AltGraph") return 57453;

  const code = event.code ?? "";
  const modifier = MODIFIER_CODE_POINTS[code];
  if (modifier !== undefined) return modifier;

  const numpad = numpadCodePoint(event, reportAll, disambiguate, eventType);
  if (numpad !== null) return numpad;

  const functionMatch = /^F(\d{1,2})$/.exec(event.key);
  if (functionMatch) {
    const number = Number.parseInt(functionMatch[1], 10);
    if (number >= 13 && number <= 35) return 57363 + number;
  }

  return FUNCTIONAL_CODE_POINTS[event.key] ?? FUNCTIONAL_CODE_POINTS[code] ?? null;
}

function describeKey(
  event: KittyKeyboardEvent,
  reportAll: boolean,
  disambiguate: boolean,
  eventType: KittyKeyboardEventType,
): KeyDescription | null {
  const functional = functionalCodePoint(event, reportAll, disambiguate, eventType);
  if (functional !== null) return { kind: "unicode", codePoint: functional, textKey: false };

  if (event.key === "Escape") return { kind: "unicode", codePoint: 27, textKey: false };
  if (event.key === "Enter") return { kind: "unicode", codePoint: 13, textKey: false };
  if (event.key === "Tab") return { kind: "unicode", codePoint: 9, textKey: false };
  if (event.key === "Backspace") return { kind: "unicode", codePoint: 127, textKey: false };

  const csiKey = CSI_KEYS[event.key];
  if (csiKey) return { kind: "csi", key: csiKey, textKey: false };

  const codePoint = unshiftedCodePoint(event);
  return codePoint === null ? null : { kind: "unicode", codePoint, textKey: true };
}

function modifierBits(event: KittyKeyboardEvent): number {
  return (
    (event.shiftKey ? 1 : 0) |
    (event.altKey ? 2 : 0) |
    (event.ctrlKey ? 4 : 0) |
    (event.metaKey ? 8 : 0) |
    (event.getModifierState?.("CapsLock") ? 64 : 0) |
    (event.getModifierState?.("NumLock") ? 128 : 0)
  );
}

function eventTypeNumber(eventType: KittyKeyboardEventType): number {
  if (eventType === "repeat") return 2;
  if (eventType === "release") return 3;
  return 1;
}

function associatedText(event: KittyKeyboardEvent, eventType: KittyKeyboardEventType): string | null {
  if (eventType === "release") return null;
  if (event.text !== undefined) return encodeTextCodePoints(event.text);
  if (event.metaKey || !isSinglePrintableCodePoint(event.key)) return null;

  const altGraph = event.getModifierState?.("AltGraph") ?? false;
  const plainLayoutKey = event.shiftKey ? event.shiftedKey : event.unshiftedKey;
  const alternateLayoutText =
    event.altKey && plainLayoutKey !== undefined && plainLayoutKey !== event.key;
  if (event.ctrlKey && !altGraph && !alternateLayoutText) return null;
  if (event.altKey && !altGraph && !alternateLayoutText) return null;
  return encodeTextCodePoints(event.key);
}

function encodeTextCodePoints(text: string): string | null {
  if (!text) return null;
  let encoded = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f) ||
      codePoint > UNICODE_MAX
    ) {
      return null;
    }
    encoded += encoded ? `:${codePoint}` : String(codePoint);
  }
  return encoded || null;
}

function unicodeKeyField(event: KittyKeyboardEvent, codePoint: number, reportAlternateKeys: boolean): string {
  if (!reportAlternateKeys || !isSinglePrintableCodePoint(event.key)) return String(codePoint);

  const shiftedCharacter = event.shiftKey ? event.shiftedKey ?? event.key : null;
  const shifted = shiftedCharacter?.codePointAt(0) ?? null;
  const baseCharacter = baseLayoutCharacter(event.code);
  const base = baseCharacter?.codePointAt(0) ?? null;
  const usefulShifted = shifted !== null && shifted !== codePoint ? shifted : null;
  const usefulBase = base !== null && base !== codePoint ? base : null;
  if (usefulShifted === null && usefulBase === null) return String(codePoint);
  if (usefulBase === null) return `${codePoint}:${usefulShifted}`;
  return `${codePoint}:${usefulShifted ?? ""}:${usefulBase}`;
}

function encodeUnicodeKey(
  event: KittyKeyboardEvent,
  codePoint: number,
  flags: number,
  eventType: KittyKeyboardEventType,
  includeText: boolean,
): string {
  const keyField = unicodeKeyField(
    event,
    codePoint,
    (flags & KITTY_KEYBOARD_FLAGS.REPORT_ALTERNATE_KEYS) !== 0,
  );
  const modifiers = modifierBits(event) + 1;
  const reportEvents = (flags & KITTY_KEYBOARD_FLAGS.REPORT_EVENTS) !== 0;
  const type = reportEvents ? eventTypeNumber(eventType) : 1;
  const text = includeText ? associatedText(event, eventType) : null;
  const needsModifierField = modifiers !== 1 || type !== 1 || text !== null;

  let parameters = keyField;
  if (needsModifierField) {
    parameters += `;${modifiers}`;
    if (type !== 1) parameters += `:${type}`;
  }
  if (text !== null) parameters += `;${text}`;
  return `${CSI}${parameters}u`;
}

function encodeCsiKey(
  event: KittyKeyboardEvent,
  key: CsiKey,
  flags: number,
  eventType: KittyKeyboardEventType,
): string {
  const modifiers = modifierBits(event) + 1;
  const reportEvents = (flags & KITTY_KEYBOARD_FLAGS.REPORT_EVENTS) !== 0;
  const type = reportEvents ? eventTypeNumber(eventType) : 1;
  if (modifiers === 1 && type === 1 && key.omitPlainParameter) return `${CSI}${key.final}`;

  let parameters = String(key.parameter);
  if (modifiers !== 1 || type !== 1) {
    parameters += `;${modifiers}`;
    if (type !== 1) parameters += `:${type}`;
  }
  return `${CSI}${parameters}${key.final}`;
}

function encodeLegacyControl(event: KittyKeyboardEvent): string {
  const altPrefix = event.altKey ? "\x1b" : "";
  if (event.key === "Enter") return `${altPrefix}\r`;
  if (event.key === "Backspace") return `${altPrefix}${event.ctrlKey ? "\x08" : "\x7f"}`;
  if (event.key === "Tab") {
    const tab = event.shiftKey && !event.altKey && !event.ctrlKey ? `${CSI}Z` : "\t";
    return `${altPrefix}${tab}`;
  }
  return "";
}

export function encodeKittyKeyboardEvent(
  event: KittyKeyboardEvent,
  rawFlags: number,
  explicitEventType?: KittyKeyboardEventType,
): string | null {
  const flags = rawFlags & KITTY_KEYBOARD_SUPPORTED_FLAGS;
  if (flags === 0) return null;

  const eventType = explicitEventType ?? (event.repeat ? "repeat" : "press");
  const reportEvents = (flags & KITTY_KEYBOARD_FLAGS.REPORT_EVENTS) !== 0;
  const reportAll = (flags & KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS) !== 0;
  const disambiguate = (flags & KITTY_KEYBOARD_FLAGS.DISAMBIGUATE) !== 0;
  const description = describeKey(event, reportAll, disambiguate, eventType);
  if (!description) return null;

  const isModifierKey =
    event.key === "AltGraph" ||
    (event.code !== undefined &&
      (MODIFIER_CODE_POINTS[event.code] !== undefined || LOCK_KEY_CODES[event.code] === true));
  if (isModifierKey && !reportAll) return null;

  const isLegacyControl =
    event.key === "Enter" || event.key === "Tab" || event.key === "Backspace";
  const hasNonLockModifier = Boolean(
    event.shiftKey || event.altKey || event.ctrlKey || event.metaKey,
  );
  const reportModifiedLegacy =
    hasNonLockModifier && (disambiguate || reportEvents);
  if (isLegacyControl && !reportAll && !reportModifiedLegacy) {
    if (eventType === "release") return null;
    return encodeLegacyControl(event);
  }

  const hasCtrlOrAlt = Boolean(event.ctrlKey || event.altKey);

  const shouldEncode =
    reportAll ||
    (description.textKey
      ? (eventType === "release" && reportEvents) ||
        ((disambiguate || reportEvents) && hasCtrlOrAlt)
      : disambiguate || reportEvents);
  if (!shouldEncode) return null;
  if (eventType === "release" && !reportEvents) return null;

  if (description.kind === "csi") {
    return encodeCsiKey(event, description.key, flags, eventType);
  }

  const includeText =
    reportAll && (flags & KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT) !== 0;
  return encodeUnicodeKey(event, description.codePoint, flags, eventType, includeText);
}
export function encodeTerminalKeyboardEvent(
  event: KittyKeyboardEvent,
  platform: string,
  rawFlags: number,
  explicitEventType?: KittyKeyboardEventType,
): string | null {
  const eventType = explicitEventType ?? (event.repeat ? "repeat" : "press");
  if (event.key === "Backspace") {
    if (eventType === "release") return null;
    return getBackspaceKeyCode(
      {
        ctrlKey: Boolean(event.ctrlKey),
        altKey: Boolean(event.altKey),
        metaKey: Boolean(event.metaKey),
        shiftKey: Boolean(event.shiftKey),
      },
      platform,
    );
  }
  return encodeKittyKeyboardEvent(event, rawFlags, eventType);
}

export function encodeKittyTextEvent(text: string, rawFlags: number): string | null {
  const flags = rawFlags & KITTY_KEYBOARD_SUPPORTED_FLAGS;
  if (
    (flags & KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS) === 0 ||
    (flags & KITTY_KEYBOARD_FLAGS.REPORT_ASSOCIATED_TEXT) === 0
  ) {
    return null;
  }
  const encodedText = encodeTextCodePoints(text);
  return encodedText === null ? null : `${CSI}0;1;${encodedText}u`;
}

export function encodeKittyInputText(text: string, rawFlags: number): string {
  const kittyText = encodeKittyTextEvent(text, rawFlags);
  if (kittyText !== null) return kittyText;
  const flags = rawFlags & KITTY_KEYBOARD_SUPPORTED_FLAGS;
  return (flags & KITTY_KEYBOARD_FLAGS.REPORT_ALL_KEYS) !== 0 ? "" : text;
}
