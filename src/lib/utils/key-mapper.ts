// ANSI escape sequences for special keys
export const KeyCodes = {
  // Navigation
  ESC: "\x1b",
  TAB: "\t",
  ENTER: "\r",
  BACKSPACE: "\x7f",
  DELETE: "\x1b[3~",

  // Arrow keys
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
  APP_UP: "\x1bOA",
  APP_DOWN: "\x1bOB",
  APP_RIGHT: "\x1bOC",
  APP_LEFT: "\x1bOD",

  // Page navigation
  HOME: "\x1b[H",
  END: "\x1b[F",
  PAGE_UP: "\x1b[5~",
  PAGE_DOWN: "\x1b[6~",
  INSERT: "\x1b[2~",

  // Function keys
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
} as const;

export type ArrowDirection = "up" | "down" | "left" | "right";

export function getArrowKeyCode(direction: ArrowDirection, applicationMode: boolean): string {
  if (applicationMode) {
    if (direction === "up") return KeyCodes.APP_UP;
    if (direction === "down") return KeyCodes.APP_DOWN;
    if (direction === "left") return KeyCodes.APP_LEFT;
    return KeyCodes.APP_RIGHT;
  }

  if (direction === "up") return KeyCodes.UP;
  if (direction === "down") return KeyCodes.DOWN;
  if (direction === "left") return KeyCodes.LEFT;
  return KeyCodes.RIGHT;
}

// Ctrl key combinations (Ctrl+A = 0x01, Ctrl+Z = 0x1A)
export function ctrlKey(char: string): string {
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) {
    // A-Z
    return String.fromCharCode(code - 64);
  }
  return "";
}

// Alt key combinations (ESC + char)
export function altKey(char: string): string {
  return "\x1b" + char;
}

export interface ExtraKey {
  label: string;
  code: string | (() => string);
  width?: number; // Grid columns, default 1
  repeatable?: boolean; // Can repeat when long-pressed
}

export const extraKeysRow1: ExtraKey[] = [
  { label: "ESC", code: KeyCodes.ESC },
  { label: "HOME", code: KeyCodes.HOME },
  { label: "CTRL", code: "", width: 1 }, // Modifier, handled specially
  { label: "ALT", code: "", width: 1 }, // Modifier, handled specially
  { label: "PGUP", code: KeyCodes.PAGE_UP },
  { label: "↑", code: KeyCodes.UP, repeatable: true },
  { label: "PGDN", code: KeyCodes.PAGE_DOWN },
  { label: "/", code: "/" },
];

export const extraKeysRow2: ExtraKey[] = [
  { label: "TAB", code: KeyCodes.TAB },
  { label: "END", code: KeyCodes.END },
  { label: "INS", code: KeyCodes.INSERT },
  { label: "DEL", code: KeyCodes.DELETE },
  { label: "←", code: KeyCodes.LEFT, repeatable: true },
  { label: "↓", code: KeyCodes.DOWN, repeatable: true },
  { label: "→", code: KeyCodes.RIGHT, repeatable: true },
  { label: "ENTER", code: KeyCodes.ENTER },
];

export const functionKeys: ExtraKey[] = [
  { label: "F1", code: KeyCodes.F1 },
  { label: "F2", code: KeyCodes.F2 },
  { label: "F3", code: KeyCodes.F3 },
  { label: "F4", code: KeyCodes.F4 },
  { label: "F5", code: KeyCodes.F5 },
  { label: "F6", code: KeyCodes.F6 },
  { label: "F7", code: KeyCodes.F7 },
  { label: "F8", code: KeyCodes.F8 },
  { label: "F9", code: KeyCodes.F9 },
  { label: "F10", code: KeyCodes.F10 },
  { label: "F11", code: KeyCodes.F11 },
  { label: "F12", code: KeyCodes.F12 },
];

// Quick Ctrl combinations
export const ctrlKeys: ExtraKey[] = [
  { label: "C", code: () => ctrlKey("C") }, // Interrupt
  { label: "D", code: () => ctrlKey("D") }, // EOF
  { label: "Z", code: () => ctrlKey("Z") }, // Suspend
  { label: "L", code: () => ctrlKey("L") }, // Clear
  { label: "A", code: () => ctrlKey("A") }, // Beginning
  { label: "E", code: () => ctrlKey("E") }, // End
  { label: "R", code: () => ctrlKey("R") }, // Search
  { label: "U", code: () => ctrlKey("U") }, // Kill line
];
