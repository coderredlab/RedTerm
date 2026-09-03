/** Desktop-only layout preferences, persisted separately from app settings. */
import {
  DEFAULT_EXPLORER_SORT,
  normalizeExplorerSort,
  type ExplorerSort,
} from "./explorer-sort";

export interface DesktopPrefs {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  explorerSort: ExplorerSort;
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
    return { sidebarCollapsed: false, sidebarWidth: 280, explorerSort: DEFAULT_EXPLORER_SORT };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { sidebarCollapsed: false, sidebarWidth: 280, explorerSort: DEFAULT_EXPLORER_SORT };
    }
    const parsed = JSON.parse(raw) as Partial<DesktopPrefs>;
    return {
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      sidebarWidth: clampWidth(parsed.sidebarWidth as number),
      explorerSort: normalizeExplorerSort(parsed.explorerSort),
    };
  } catch {
    return { sidebarCollapsed: false, sidebarWidth: 280, explorerSort: DEFAULT_EXPLORER_SORT };
  }
}

function persistPrefs(prefs: DesktopPrefs) {
  if (!canUseStorage()) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced persist: sidebar resize updates this on every pointermove. */
function schedulePersist(prefs: DesktopPrefs) {
  if (!canUseStorage()) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, 250);
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
      schedulePersist(prefs);
    },
    setExplorerSort(sort: ExplorerSort) {
      if (
        prefs.explorerSort.key === sort.key &&
        prefs.explorerSort.direction === sort.direction
      ) {
        return;
      }
      prefs = { ...prefs, explorerSort: sort };
      schedulePersist(prefs);
    },
    /** Write any debounced change immediately (pagehide teardown). */
    flushPendingPersist() {
      if (persistTimer === null) return;
      clearTimeout(persistTimer);
      persistTimer = null;
      persistPrefs(prefs);
    },
  };
}

export const desktopPrefsStore = createDesktopPrefs();
export { MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH };
