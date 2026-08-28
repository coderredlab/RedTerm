const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const UNSAFE_PASTE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

export const MAX_TERMINAL_PASTE_CHARS = 1_000_000;

export function formatTerminalPaste(text: string, bracketedPasteMode: boolean): string {
  if (!text) return "";
  if (text.length > MAX_TERMINAL_PASTE_CHARS) {
    throw new Error("Pasted text exceeds 1,000,000 characters");
  }
  if (!bracketedPasteMode && /[\r\n]/.test(text)) {
    throw new Error("Multiline paste requires bracketed paste mode");
  }

  const sanitized = text
    .replaceAll(BRACKETED_PASTE_START, "")
    .replaceAll(BRACKETED_PASTE_END, "")
    .replace(UNSAFE_PASTE_CONTROLS, "");
  if (bracketedPasteMode) {
    return `${BRACKETED_PASTE_START}${sanitized}${BRACKETED_PASTE_END}`;
  }
  return sanitized.replace(/\r\n|\n|\r/g, "\r");
}
