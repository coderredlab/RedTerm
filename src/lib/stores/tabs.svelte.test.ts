// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test";

import type { AuthConfig } from "../tauri/commands";

const STORAGE_KEY = "redterm.tabs.v2";
const LEGACY_STORAGE_KEY = "redterm.tabs.v1";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalSvelteState = Object.getOwnPropertyDescriptor(globalThis, "$state");

class MemoryStorage {
  #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  clear(): void {
    this.#items.clear();
  }
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete globalThis[name];
  }
}

function installBrowserStorage(storage: MemoryStorage) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "$state", {
    configurable: true,
    value: <T>(value: T) => value,
  });
}

afterEach(() => {
  restoreGlobal("window", originalWindow);
  restoreGlobal("localStorage", originalLocalStorage);
  restoreGlobal("$state", originalSvelteState);
});

describe("tabs store persistence", () => {
  test("restores key-auth tabs without a stale runtime passphrase", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        tabs: [
          {
            id: "tab-stale-passphrase",
            title: "prod.example.com",
            host: "prod.example.com",
            port: 2222,
            auth: {
              username: "deploy",
              method: {
                type: "key",
                key_id: "key-1",
                passphrase: "stale-runtime-passphrase",
              },
            },
            sessionId: null,
            connected: true,
          },
          {
            id: "tab-legacy-key-path",
            title: "legacy.example.com",
            host: "legacy.example.com",
            port: 22,
            auth: {
              username: "deploy",
              method: {
                type: "key",
                key_path: "/legacy/id_ed25519",
              },
            },
            sessionId: null,
            connected: false,
          },
        ],
        activeTabId: "tab-stale-passphrase",
      })
    );

    // Dynamic import is intentional: tabsStore is constructed at module evaluation,
    // so Bun needs the localStorage and Svelte rune shim installed before import.
    const { tabsStore } = await import("./tabs.svelte");

    try {
      expect(tabsStore.tabs).toEqual([
        expect.objectContaining({
          id: "tab-stale-passphrase",
          host: "prod.example.com",
          port: 2222,
          auth: {
            username: "deploy",
            method: {
              type: "key",
              key_id: "key-1",
            },
          },
          sessionId: null,
          connected: false,
        }),
      ]);
      expect(tabsStore.activeTabId).toBe("tab-stale-passphrase");
      expect(tabsStore.tabs[0].auth.method).not.toHaveProperty("passphrase");
    } finally {
      tabsStore.removeTab("tab-stale-passphrase");
    }
  });

  test("persists key-auth tabs opened with a runtime passphrase without storing the passphrase", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);

    // Dynamic import is intentional: tabsStore is constructed at module evaluation,
    // so Bun needs the localStorage and Svelte rune shim installed before import.
    const { tabsStore } = await import("./tabs.svelte");
    const auth = {
      username: "deploy",
      method: {
        type: "key",
        key_id: "key-1",
        passphrase: "runtime-only-passphrase",
      },
    } satisfies AuthConfig;

    const tabId = tabsStore.addTab("prod.example.com", 2222, auth);

    try {
      const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");

      expect(persisted.tabs).toEqual([
        expect.objectContaining({
          id: tabId,
          host: "prod.example.com",
          port: 2222,
          auth: {
            username: "deploy",
            method: {
              type: "key",
              key_id: "key-1",
            },
          },
          sessionId: null,
          connected: false,
          panes: [
            expect.objectContaining({
              connected: false,
              sessionId: null,
              connection: expect.objectContaining({
                host: "prod.example.com",
                port: 2222,
                auth: {
                  username: "deploy",
                  method: {
                    type: "key",
                    key_id: "key-1",
                  },
                },
              }),
            }),
          ],
        }),
      ]);
      expect(persisted.activeTabId).toBe(tabId);
      expect(persisted.tabs[0].auth.method).not.toHaveProperty("passphrase");
      expect(persisted.tabs[0].panes[0].connection.auth.method).not.toHaveProperty(
        "passphrase"
      );
      expect(JSON.stringify(persisted)).not.toContain("runtime-only-passphrase");
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("persists saved-password tabs as native credential references", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    // Dynamic import is required because the store captures browser globals during module evaluation.
    const { tabsStore } = await import("./tabs.svelte");
    const auth = {
      username: "deploy",
      method: {
        type: "password",
        password: ["runtime", "only", "password"].join("-"),
      },
    } satisfies AuthConfig;

    const tabId = tabsStore.addTab(
      "prod.example.com",
      2222,
      auth,
      "connection-1",
      true
    );

    try {
      const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      expect(persisted.tabs[0]).toEqual(
        expect.objectContaining({
          id: tabId,
          auth: {
            username: "deploy",
            method: {
              type: "stored_password",
              connection_id: "connection-1",
            },
          },
          panes: [
            expect.objectContaining({
              connection: expect.objectContaining({
                auth: {
                  username: "deploy",
                  method: {
                    type: "stored_password",
                    connection_id: "connection-1",
                  },
                },
              }),
            }),
          ],
        })
      );
      expect(JSON.stringify(persisted)).not.toContain(
        ["runtime", "only", "password"].join("-")
      );
    } finally {
      tabsStore.removeTab(tabId);
    }
  });
  test("persists an OSC title on the pane and active tab", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    const { tabsStore } = await import("./tabs.svelte");
    const auth = {
      username: "deploy",
      method: { type: "key", key_id: "key-1" },
    } satisfies AuthConfig;
    const tabId = tabsStore.addTab("prod.example.com", 22, auth);

    try {
      const tab = tabsStore.tabs.find((candidate) => candidate.id === tabId)!;
      tabsStore.setPaneTitle(tabId, tab.activePaneId, "  remote shell  ");

      expect(tab.panes[0].title).toBe("remote shell");
      expect(tab.title).toBe("remote shell");
      const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      expect(persisted.tabs[0].title).toBe("remote shell");
      expect(persisted.tabs[0].panes[0].title).toBe("remote shell");
      tabsStore.setPaneTitle(tabId, tab.activePaneId, `${"a".repeat(127)}😀`);
      expect(tab.panes[0].title).toBe("a".repeat(127));
      expect(tab.panes[0].title.isWellFormed()).toBe(true);

    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("restores a persisted OSC pane title on module reload", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      activeTabId: "tab-osc-title",
      tabs: [{
        id: "tab-osc-title",
        title: "remote shell",
        activePaneId: "pane-osc-title",
        panes: [{
          id: "pane-osc-title",
          title: "remote shell",
          sessionId: null,
          connected: false,
          connection: {
            host: "prod.example.com",
            port: 22,
            auth: {
              username: "deploy",
              method: { type: "key", key_id: "key-1" },
            },
          },
        }],
        layout: { type: "leaf", paneId: "pane-osc-title" },
      }],
    }));

    const { tabsStore } = await import("./tabs.svelte.ts?osc-title-restore");

    try {
      expect(tabsStore.tabs[0].panes[0].title).toBe("remote shell");
      expect(tabsStore.tabs[0].title).toBe("remote shell");
    } finally {
      tabsStore.removeTab("tab-osc-title");
    }
  });

  test("replaces a failed pane connection in place", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "old.example.com",
      22,
      { username: "old-user", method: { type: "password", password: "old" } },
      "connection-old"
    );

    try {
      const paneId = tabsStore.getTab(tabId)!.activePaneId!;
      tabsStore.setPaneConnected(tabId, paneId, "stale-session");
      tabsStore.updatePaneConnection(tabId, paneId, {
        host: "new.example.com",
        port: 2202,
        auth: { username: "new-user", method: { type: "key", key_id: "key-new" } },
        connectionId: "connection-new",
        keyName: "id_ed25519",
        saveConnection: false,
        savePassword: false,
      });

      const tab = tabsStore.getTab(tabId)!;
      expect(tab.panes).toHaveLength(1);
      expect(tab.panes[0]).toMatchObject({
        id: paneId,
        title: "new-user@new.example.com",
        sessionId: null,
        connected: false,
        connection: {
          host: "new.example.com",
          port: 2202,
          connectionId: "connection-new",
          keyName: "id_ed25519",
          saveConnection: false,
          savePassword: false,
        },
      });
      expect(tab).toMatchObject({
        id: tabId,
        host: "new.example.com",
        port: 2202,
        connectionId: "connection-new",
        sessionId: null,
        connected: false,
      });
      const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      expect(persisted.tabs[0].panes[0].connection).toMatchObject({
        host: "new.example.com",
        keyName: "id_ed25519",
        saveConnection: false,
        savePassword: false,
      });
      expect(JSON.stringify(persisted)).not.toContain("stale-session");
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

});
