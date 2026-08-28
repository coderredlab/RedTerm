const appCursorBySession = $state<Record<string, boolean>>({});

function setAppCursorMode(sessionId: string, enabled: boolean) {
  appCursorBySession[sessionId] = enabled;
}

function isAppCursorMode(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return appCursorBySession[sessionId] ?? false;
}

function clearSession(sessionId: string | null | undefined) {
  if (!sessionId) return;
  delete appCursorBySession[sessionId];
}

export const terminalModesStore = {
  get appCursorBySession() {
    return appCursorBySession;
  },
  setAppCursorMode,
  isAppCursorMode,
  clearSession,
};
