/** Tracks terminal-local blocking modals so the desktop shell can pause app shortcuts while one is open. */
function createTerminalModalGate() {
  let openModals = 0;
  return {
    get open() {
      return openModals > 0;
    },
    enter(): void {
      openModals += 1;
    },
    exit(): void {
      openModals = Math.max(0, openModals - 1);
    },
  };
}

export const terminalModalGate = createTerminalModalGate();
