/** Desktop-only layout preferences, persisted separately from app settings. */
export interface DesktopPrefs {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
}

const STORAGE_KEY = "redterm.desktop.v1";
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return 280;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function loadPrefs(): DesktopPrefs {
  if (!canUseStorage()) {
    return { sidebarCollapsed: false, sidebarWidth: 280 };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sidebarCollapsed: false, sidebarWidth: 280 };
    const parsed = JSON.parse(raw) as Partial<DesktopPrefs>;
    return {
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      sidebarWidth: clampWidth(parsed.sidebarWidth as number),
    };
  } catch {
    return { sidebarCollapsed: false, sidebarWidth: 280 };
  }
}

function persistPrefs(prefs: DesktopPrefs) {
  if (!canUseStorage()) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function createDesktopPrefs() {
  let prefs = $state<DesktopPrefs>(loadPrefs());

  return {
    get prefs() {
      return prefs;
    },
    toggleSidebar() {
      prefs = { ...prefs, sidebarCollapsed: !prefs.sidebarCollapsed };
      persistPrefs(prefs);
    },
    setSidebarWidth(width: number) {
      const clamped = clampWidth(width);
      if (clamped === prefs.sidebarWidth) return;
      prefs = { ...prefs, sidebarWidth: clamped };
      persistPrefs(prefs);
    },
  };
}

export const desktopPrefsStore = createDesktopPrefs();
export { MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH };
