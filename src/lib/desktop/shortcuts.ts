export interface DesktopShortcutHandlers {
  newConnection(): void;
  closePane(): void;
  closeTab(): void;
  nextTab(): void;
  previousTab(): void;
  selectTab(index: number): void;
  splitRight(): void;
  splitDown(): void;
  moveFocus(direction: "left" | "right" | "up" | "down"): void;
  openSettings(): void;
  copySelection(): void;
  pasteFromClipboard(): void;
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

/**
 * Match desktop shortcuts on a capture-phase keydown. Returns true when the
 * event was consumed and the caller must preventDefault + stopPropagation so
 * terminal key handling never sees it.
 *
 * `terminalTarget` reports that the key was pressed while a terminal had
 * focus. Combos that shells consume (Ctrl+T/W/\\ on Linux and Windows) are
 * then left for the terminal instead of being stolen by the app shell.
 */
export function handleDesktopShortcuts(
  event: KeyboardEvent,
  handlers: DesktopShortcutHandlers,
  isEnabled: () => boolean,
  terminalTarget = false
): boolean {
  if (!isEnabled()) return false;

  const isMac = isMacPlatform();
  const mod = isMac ? event.metaKey : event.ctrlKey;
  // Non-shell-reserved combos also accept the other modifier on macOS so
  // Ctrl+Tab / Ctrl+1..9 keep working alongside the Cmd variants.
  const modLike = event.ctrlKey || event.metaKey;
  const terminalClipboardModifier = event.ctrlKey || (isMac && event.metaKey);
  const alt = event.altKey;
  const shift = event.shiftKey;
  const key = event.key;
  // Shells consume Ctrl+T/W/\ on Linux and Windows; leave those (and their
  // shifted variants, which the app also uses) for the terminal when the key
  // was pressed inside one.
  const shellReserved =
    !isMac &&
    terminalTarget &&
    !shift &&
    (key === "t" || key === "T" || key === "w" || key === "W" || key === "\\");

  if (shellReserved) return false;

  // Copy selection: the Shift variant keeps plain Ctrl/Cmd+C for the shell.
  if (terminalTarget && terminalClipboardModifier && shift && (key === "c" || key === "C")) {
    handlers.copySelection();
    return true;
  }

  // Paste: the Shift variant keeps plain Ctrl/Cmd+V for the shell.
  if (terminalTarget && terminalClipboardModifier && shift && (key === "v" || key === "V")) {
    handlers.pasteFromClipboard();
    return true;
  }

  // New connection: the Shift-less Ctrl/Cmd+T stays with the shell, so the
  // app shortcut uses the Shift variant there.
  if (mod && !shift && !alt && (key === "t" || key === "T")) {
    handlers.newConnection();
    return true;
  }

  if (mod && (key === "w" || key === "W")) {
    if (shift) {
      handlers.closeTab();
    } else {
      handlers.closePane();
    }
    return true;
  }

  if (modLike && !alt && key === "Tab") {
    if (shift) {
      handlers.previousTab();
    } else {
      handlers.nextTab();
    }
    return true;
  }

  if (modLike && key === "PageUp" && !alt && !shift) {
    handlers.previousTab();
    return true;
  }

  if (modLike && key === "PageDown" && !alt && !shift) {
    handlers.nextTab();
    return true;
  }

  if (modLike && !alt && !shift && /^[1-9]$/.test(key)) {
    handlers.selectTab(Number(key) - 1);
    return true;
  }

  if (mod && key === "\\") {
    if (shift) {
      handlers.splitDown();
    } else {
      handlers.splitRight();
    }
    return true;
  }

  if (event.ctrlKey && alt && !shift && !event.metaKey) {
    if (key === "ArrowLeft") {
      handlers.moveFocus("left");
      return true;
    }
    if (key === "ArrowRight") {
      handlers.moveFocus("right");
      return true;
    }
    if (key === "ArrowUp") {
      handlers.moveFocus("up");
      return true;
    }
    if (key === "ArrowDown") {
      handlers.moveFocus("down");
      return true;
    }
  }

  if (modLike && !alt && !shift && key === ",") {
    handlers.openSettings();
    return true;
  }

  return false;
}
