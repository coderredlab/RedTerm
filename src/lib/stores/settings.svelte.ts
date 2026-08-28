import { getThemeById, applyThemeCssVars, THEMES } from "$lib/styles/themes";
import { setKeepScreenOn as setKeepScreenOnNative } from "$lib/tauri/commands";

const STORAGE_KEY = "redterm.settings.v1";

export type TabBarPosition = "top" | "bottom";

export interface SettingsData {
  fontSize: number;
  theme: string;
  extraKeysHeight: number;
  keepScreenOn: boolean;
  tabBarPosition: TabBarPosition;
}

const DEFAULTS: SettingsData = {
  fontSize: 14,
  theme: "coder-red",
  extraKeysHeight: 10,
  keepScreenOn: false,
  tabBarPosition: "top",
};

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function loadFromStorage(): SettingsData {
  if (!canUseStorage()) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      fontSize: clamp(parsed.fontSize ?? DEFAULTS.fontSize, 8, 24),
      theme: getThemeById(parsed.theme) ? parsed.theme : DEFAULTS.theme,
      extraKeysHeight: clamp(parsed.extraKeysHeight ?? DEFAULTS.extraKeysHeight, 4, 20),
      keepScreenOn: typeof parsed.keepScreenOn === "boolean" ? parsed.keepScreenOn : DEFAULTS.keepScreenOn,
      tabBarPosition: parsed.tabBarPosition === "bottom" ? "bottom" : "top",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveToStorage(data: SettingsData): void {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // storage full — ignore
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function createSettingsStore() {
  let fontSize = $state(DEFAULTS.fontSize);
  let theme = $state(DEFAULTS.theme);
  let extraKeysHeight = $state(DEFAULTS.extraKeysHeight);
  let keepScreenOn = $state(DEFAULTS.keepScreenOn);
  let tabBarPosition = $state<TabBarPosition>(DEFAULTS.tabBarPosition);

  function load() {
    const data = loadFromStorage();
    fontSize = data.fontSize;
    theme = data.theme;
    extraKeysHeight = data.extraKeysHeight;
    keepScreenOn = data.keepScreenOn;
    tabBarPosition = data.tabBarPosition;
  }

  function persist() {
    saveToStorage({ fontSize, theme, extraKeysHeight, keepScreenOn, tabBarPosition });
  }

  return {
    get fontSize() { return fontSize; },
    get theme() { return theme; },
    get extraKeysHeight() { return extraKeysHeight; },
    get keepScreenOn() { return keepScreenOn; },
    get tabBarPosition() { return tabBarPosition; },

    load,

    setFontSize(v: number) {
      fontSize = clamp(v, 8, 24);
      persist();
    },

    setTheme(id: string) {
      if (!getThemeById(id)) return;
      theme = id;
      const def = getThemeById(id)!;
      applyThemeCssVars(def);
      persist();
    },

    setExtraKeysHeight(v: number) {
      extraKeysHeight = clamp(v, 4, 20);
      document.documentElement.style.setProperty(
        "--extrakeys-btn-padding",
        `${extraKeysHeight}px 4px`,
      );
      persist();
    },

    setKeepScreenOn(v: boolean) {
      keepScreenOn = v;
      setKeepScreenOnNative(v).catch(() => {});
      persist();
    },

    setTabBarPosition(v: TabBarPosition) {
      tabBarPosition = v;
      persist();
    },

    applyAll() {
      load();
      const def = getThemeById(theme) ?? THEMES[0];
      applyThemeCssVars(def);
      document.documentElement.style.setProperty(
        "--extrakeys-btn-padding",
        `${extraKeysHeight}px 4px`,
      );
      if (keepScreenOn) {
        setKeepScreenOnNative(true).catch(() => {});
      }
    },
  };
}

export const settingsStore = createSettingsStore();
