// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test";

import type { AuthConfig } from "../tauri/commands";

const STORAGE_KEY = "redterm.tabs.v1";
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
      STORAGE_KEY,
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
                key_path: "/keys/prod_ed25519",
                passphrase: "stale-runtime-passphrase",
              },
            },
            sessionId: null,
            connected: true,
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
              key_path: "/keys/prod_ed25519",
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
        key_path: "/keys/prod_ed25519",
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
              key_path: "/keys/prod_ed25519",
            },
          },
          sessionId: null,
          connected: false,
        }),
      ]);
      expect(persisted.activeTabId).toBe(tabId);
      expect(persisted.tabs[0].auth.method).not.toHaveProperty("passphrase");
    } finally {
      tabsStore.removeTab(tabId);
    }
  });
});
