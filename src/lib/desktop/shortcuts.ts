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
}

/**
 * Match desktop shortcuts on a capture-phase keydown. Returns true when the
 * event was consumed and the caller must preventDefault + stopPropagation so
 * terminal key handling never sees it.
 */
export function handleDesktopShortcuts(
  event: KeyboardEvent,
  handlers: DesktopShortcutHandlers,
  isEnabled: () => boolean
): boolean {
  if (!isEnabled()) return false;

  const mod = event.ctrlKey || event.metaKey;
  const alt = event.altKey;
  const shift = event.shiftKey;
  const key = event.key;

  if (mod && !alt && (key === "t" || key === "T")) {
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

  if (mod && key === "Tab") {
    if (shift) {
      handlers.previousTab();
    } else {
      handlers.nextTab();
    }
    return true;
  }

  if (event.ctrlKey && !event.metaKey && key === "PageUp" && !alt && !shift) {
    handlers.previousTab();
    return true;
  }

  if (event.ctrlKey && !event.metaKey && key === "PageDown" && !alt && !shift) {
    handlers.nextTab();
    return true;
  }

  if (mod && !alt && !shift && /^[1-9]$/.test(key)) {
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

  if (mod && !alt && !shift && key === ",") {
    handlers.openSettings();
    return true;
  }

  return false;
}
