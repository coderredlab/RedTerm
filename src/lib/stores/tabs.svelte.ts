import type { AuthConfig } from "$lib/tauri/commands";

export interface Tab {
  id: string;
  title: string;
  host: string;
  port: number;
  auth: AuthConfig;
  connectionId?: string;
  canRestorePassword?: boolean;
  startupScript?: string;
  startupScriptReadyText?: string;
  sessionId: string | null;
  runtimeInstanceId?: string | null;
  connected: boolean;
}

interface PersistedTabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

const STORAGE_KEY = "redterm.tabs.v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function makePersistableAuth(
  auth: AuthConfig,
  connectionId?: string,
  canRestorePassword = false
): AuthConfig {
  if (auth.method.type === "key") {
    return {
      username: auth.username,
      method: { type: "key", key_id: auth.method.key_id },
    };
  }
  if (auth.method.type === "stored_password") {
    return auth;
  }
  if (connectionId && canRestorePassword) {
    return {
      username: auth.username,
      method: { type: "stored_password", connection_id: connectionId },
    };
  }
  return {
    username: auth.username,
    method: { type: "password", password: "" },
  };
}

function canPersistTab(tab: Tab): boolean {
  if (tab.auth.method.type === "key") {
    return true;
  }
  if (tab.auth.method.type === "stored_password") {
    return Boolean(tab.connectionId);
  }
  return Boolean(tab.sessionId || (tab.connectionId && tab.canRestorePassword));
}

function loadPersistedState(): PersistedTabsState {
  if (!canUseStorage()) return { tabs: [], activeTabId: null };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeTabId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedTabsState>;
    const rawTabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];

    const tabs: Tab[] = rawTabs
      .filter(
        (tab): tab is Tab =>
          Boolean(tab?.id && tab?.host && tab?.port && tab?.auth) &&
          (
            (tab.auth.method.type === "key" && Boolean(tab.auth.method.key_id)) ||
            (
              tab.auth.method.type === "stored_password" &&
              Boolean(
                tab.connectionId &&
                tab.auth.method.connection_id === tab.connectionId
              )
            ) ||
            Boolean(
              tab.sessionId ||
              (tab.connectionId && tab.canRestorePassword)
            )
          )
      )
      .map((tab) => {
        const { keyPassphraseExplicitEmpty: _keyPassphraseExplicitEmpty, ...persistedTab } =
          tab as Tab & { keyPassphraseExplicitEmpty?: boolean };
        return {
          ...persistedTab,
          auth: makePersistableAuth(
            tab.auth,
            tab.connectionId,
            tab.canRestorePassword
          ),
          sessionId: typeof tab.sessionId === "string" ? tab.sessionId : null,
          connected: false,
        };
      });

    const activeTabId =
      typeof parsed.activeTabId === "string" && tabs.some((t) => t.id === parsed.activeTabId)
        ? parsed.activeTabId
        : tabs[0]?.id ?? null;

    return { tabs, activeTabId };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

function persistState(tabs: Tab[], activeTabId: string | null) {
  if (!canUseStorage()) return;

  const persistableTabs = tabs
    .filter((tab) => canPersistTab(tab))
    .map((tab) => ({
      ...tab,
      auth: makePersistableAuth(
        tab.auth,
        tab.connectionId,
        tab.canRestorePassword
      ),
      sessionId: tab.sessionId,
      connected: false,
    }));

  const persistableActiveTabId =
    activeTabId && persistableTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : persistableTabs[0]?.id ?? null;

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      tabs: persistableTabs,
      activeTabId: persistableActiveTabId,
    })
  );
}

function createTabsStore() {
  const initialState = loadPersistedState();
  let tabs = $state<Tab[]>(initialState.tabs);
  let activeTabId = $state<string | null>(initialState.activeTabId);

  function generateId(): string {
    return crypto.randomUUID();
  }

  return {
    get tabs() {
      return tabs;
    },

    get activeTabId() {
      return activeTabId;
    },

    get activeTab(): Tab | undefined {
      return tabs.find((t) => t.id === activeTabId);
    },

    getTab(id: string): Tab | undefined {
      return tabs.find((t) => t.id === id);
    },

    addTab(
      host: string,
      port: number,
      auth: AuthConfig,
      connectionId?: string,
      canRestorePassword = false,
      startupScript?: string,
      startupScriptReadyText?: string
    ): string {
      const id = generateId();
      const title = `${auth.username}@${host}`;

      const newTab: Tab = {
        id,
        title,
        host,
        port,
        auth,
        connectionId,
        canRestorePassword,
        startupScript,
        startupScriptReadyText,
        sessionId: null,
        connected: false,
      };

      tabs = [...tabs, newTab];
      activeTabId = id;
      persistState(tabs, activeTabId);

      return id;
    },

    removeTab(id: string) {
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return;

      tabs = tabs.filter((t) => t.id !== id);

      // Switch to another tab if needed
      if (activeTabId === id) {
        if (tabs.length > 0) {
          const newIndex = Math.min(index, tabs.length - 1);
          activeTabId = tabs[newIndex].id;
        } else {
          activeTabId = null;
        }
      }

      persistState(tabs, activeTabId);
    },

    setActiveTab(id: string) {
      if (tabs.some((t) => t.id === id)) {
        activeTabId = id;
        persistState(tabs, activeTabId);
      }
    },

    updateTab(id: string, updates: Partial<Tab>) {
      tabs = tabs.map((t) => (t.id === id ? { ...t, ...updates } : t));
      persistState(tabs, activeTabId);
    },

    setConnected(id: string, sessionId: string, runtimeInstanceId?: string | null) {
      tabs = tabs.map((t) =>
        t.id === id ? { ...t, sessionId, runtimeInstanceId: runtimeInstanceId ?? null, connected: true } : t
      );
      persistState(tabs, activeTabId);
    },

    setDisconnected(id: string) {
      tabs = tabs.map((t) =>
        t.id === id ? { ...t, sessionId: null, runtimeInstanceId: null, connected: false } : t
      );
      persistState(tabs, activeTabId);
    },
  };
}

export const tabsStore = createTabsStore();
