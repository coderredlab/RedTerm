const appCursorBySession = $state<Record<string, boolean>>({});
const kittyKeyboardFlagsBySession = $state<Record<string, number>>({});

function setAppCursorMode(sessionId: string, enabled: boolean) {
  appCursorBySession[sessionId] = enabled;
}

function isAppCursorMode(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return appCursorBySession[sessionId] ?? false;
}

function setKittyKeyboardFlags(sessionId: string, flags: number) {
  kittyKeyboardFlagsBySession[sessionId] = flags;
}

function getKittyKeyboardFlags(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  return kittyKeyboardFlagsBySession[sessionId] ?? 0;
}

function clearSession(sessionId: string | null | undefined) {
  if (!sessionId) return;
  delete appCursorBySession[sessionId];
  delete kittyKeyboardFlagsBySession[sessionId];
}

export const terminalModesStore = {
  get appCursorBySession() {
    return appCursorBySession;
  },
  get kittyKeyboardFlagsBySession() {
    return kittyKeyboardFlagsBySession;
  },
  setAppCursorMode,
  isAppCursorMode,
  setKittyKeyboardFlags,
  getKittyKeyboardFlags,
  clearSession,
};
