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

  test("keeps same-server terminal tabs in one pane leaf", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "prod.example.com",
      22,
      { username: "deploy", method: { type: "key", key_id: "key-1" } }
    );

    try {
      const firstPaneId = tabsStore.getTab(tabId)!.activePaneId!;
      tabsStore.setPaneConnected(tabId, firstPaneId, "session-one");
      const secondPaneId = await tabsStore.addPaneTab(tabId, firstPaneId);

      expect(secondPaneId).not.toBeNull();
      expect(tabsStore.getTab(tabId)).toMatchObject({
        activePaneId: secondPaneId,
        layout: {
          type: "leaf",
          paneId: secondPaneId,
          paneIds: [firstPaneId, secondPaneId],
        },
      });
      expect(tabsStore.getPane(tabId, firstPaneId)?.sessionId).toBe("session-one");

      await tabsStore.setActivePane(tabId, firstPaneId);
      expect(tabsStore.getTab(tabId)).toMatchObject({
        activePaneId: firstPaneId,
        layout: { paneId: firstPaneId, paneIds: [firstPaneId, secondPaneId] },
      });

      const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      expect(persisted.tabs[0].layout).toEqual({
        type: "leaf",
        paneId: firstPaneId,
        paneIds: [firstPaneId, secondPaneId],
        documentIds: [],
        activeItem: { kind: "terminal", id: firstPaneId },
      });

      await tabsStore.closePane(tabId, secondPaneId!);
      expect(tabsStore.getTab(tabId)?.layout).toEqual({
        type: "leaf",
        paneId: firstPaneId,
        paneIds: [firstPaneId],
        documentIds: [],
        activeItem: { kind: "terminal", id: firstPaneId },
      });
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("opens documents in a pane without persisting remote paths", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "prod.example.com",
      22,
      { username: "deploy", method: { type: "key", key_id: "key-1" } }
    );

    try {
      const paneId = tabsStore.getTab(tabId)!.activePaneId!;
      const documentId = await tabsStore.openDocument(tabId, paneId, {
        name: "app.ts",
        path: "/srv/private/app.ts",
        size: 128,
      });

      expect(documentId).not.toBeNull();
      expect(tabsStore.getTab(tabId)).toMatchObject({
        activePaneId: paneId,
        documents: [{
          id: documentId,
          sourcePaneId: paneId,
          name: "app.ts",
          path: "/srv/private/app.ts",
          dirty: false,
        }],
        layout: {
          documentIds: [documentId],
          activeItem: { kind: "document", id: documentId },
        },
      });

      tabsStore.setPaneConnected(tabId, paneId, "session-one");
      tabsStore.setDocumentLoaded(
        tabId,
        documentId!,
        "const value = 1;\r\n",
        true
      );
      tabsStore.setDocumentContent(
        tabId,
        documentId!,
        "const value = 2;\r\n"
      );
      expect(tabsStore.getDocument(tabId, documentId!)).toMatchObject({
        sourceSessionId: "session-one",
        sourceHost: "prod.example.com",
        content: "const value = 2;\r\n",
        savedContent: "const value = 1;\r\n",
        hasUtf8Bom: true,
        dirty: true,
      });

      tabsStore.setPaneDisconnected(tabId, paneId);
      tabsStore.updatePaneConnection(tabId, paneId, {
        host: "other.example.com",
        port: 22,
        auth: { username: "deploy", method: { type: "key", key_id: "key-1" } },
      });
      tabsStore.setPaneConnected(tabId, paneId, "session-other");
      expect(tabsStore.getDocument(tabId, documentId!)?.sourceSessionId).toBeNull();

      const retargetedDocumentId = await tabsStore.openDocument(tabId, paneId, {
        name: "app.ts",
        path: "/srv/private/app.ts",
        size: 128,
      });
      expect(retargetedDocumentId).not.toBe(documentId);
      expect(tabsStore.getDocument(tabId, retargetedDocumentId!)).toMatchObject({
        sourceSessionId: "session-other",
        sourceHost: "other.example.com",
        path: "/srv/private/app.ts",
      });

      const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      expect(persisted.tabs[0].documents).toEqual([]);
      expect(persisted.tabs[0].layout.documentIds).toEqual([]);
      expect(JSON.stringify(persisted)).not.toContain("/srv/private/app.ts");
      expect(JSON.stringify(persisted)).not.toContain("const value");

      await tabsStore.closeDocument(tabId, documentId!);
      await tabsStore.closeDocument(tabId, retargetedDocumentId!);
      expect(tabsStore.getTab(tabId)?.documents).toEqual([]);
      expect(tabsStore.getTab(tabId)?.layout).toMatchObject({
        documentIds: [],
        activeItem: { kind: "terminal", id: paneId },
      });
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("reuses a document opened from another split pane", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "preview.example.com",
      22,
      { username: "deploy", method: { type: "password", password: "" } }
    );

    try {
      const sourcePaneId = tabsStore.getTab(tabId)!.activePaneId!;
      const documentId = await tabsStore.openDocument(tabId, sourcePaneId, {
        name: "README.md",
        path: "/srv/README.md",
        size: 64,
      });
      tabsStore.setDocumentCachedLocalPath(
        tabId,
        documentId!,
        "/tmp/redterm-preview.mp4"
      );
      const secondPaneId = await tabsStore.splitPane(tabId, sourcePaneId, "row");

      const reopenedDocumentId = await tabsStore.openDocument(
        tabId,
        secondPaneId!,
        { name: "README.md", path: "/srv/README.md", size: 64 }
      );

      expect(reopenedDocumentId).toBe(documentId);
      expect(tabsStore.getTab(tabId)?.documents).toHaveLength(1);
      expect(
        tabsStore.getCachedDocumentPath(
          tabId,
          secondPaneId!,
          "/srv/README.md"
        )
      ).toBe("/tmp/redterm-preview.mp4");
      expect(tabsStore.getTab(tabId)).toMatchObject({
        activePaneId: sourcePaneId,
        layout: {
          type: "split",
          dir: "row",
          children: [
            {
              paneIds: [sourcePaneId],
              documentIds: [documentId],
              activeItem: { kind: "document", id: documentId },
            },
            {
              paneIds: [secondPaneId],
              documentIds: [],
              activeItem: { kind: "terminal", id: secondPaneId },
            },
          ],
        },
      });
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("reattaches a reused document when its original pane is disconnected", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "preview.example.com",
      22,
      { username: "deploy", method: { type: "password", password: "" } }
    );

    try {
      const firstPaneId = tabsStore.getTab(tabId)!.activePaneId!;
      tabsStore.setPaneConnected(tabId, firstPaneId, "session-one");
      const documentId = await tabsStore.openDocument(tabId, firstPaneId, {
        name: "README.md",
        path: "/srv/README.md",
        size: 64,
      });
      tabsStore.setDocumentLoaded(tabId, documentId!, "saved", false);
      tabsStore.setDocumentContent(tabId, documentId!, "unsaved");
      tabsStore.setDocumentCachedLocalPath(tabId, documentId!, "/tmp/readme-cache");
      const secondPaneId = await tabsStore.splitPane(tabId, firstPaneId, "row");
      tabsStore.setPaneConnected(tabId, secondPaneId!, "session-two");
      tabsStore.setPaneDisconnected(tabId, firstPaneId);

      const reopenedDocumentId = await tabsStore.openDocument(
        tabId,
        secondPaneId!,
        { name: "README.md", path: "/srv/README.md", size: 64 }
      );

      expect(reopenedDocumentId).toBe(documentId);
      expect(tabsStore.getTab(tabId)?.documents).toHaveLength(1);
      expect(tabsStore.getDocument(tabId, documentId!)).toMatchObject({
        sourcePaneId: secondPaneId,
        sourceSessionId: "session-two",
        content: "unsaved",
        savedContent: "saved",
        dirty: true,
        cachedLocalPath: "/tmp/readme-cache",
      });
      expect(tabsStore.getTab(tabId)).toMatchObject({
        activePaneId: secondPaneId,
        layout: {
          type: "split",
          children: [
            {
              paneIds: [firstPaneId],
              documentIds: [],
              activeItem: { kind: "terminal", id: firstPaneId },
            },
            {
              paneIds: [secondPaneId],
              documentIds: [documentId],
              activeItem: { kind: "document", id: documentId },
            },
          ],
        },
      });
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("keeps a pane's documents attached when moving the pane", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "move.example.com",
      22,
      { username: "deploy", method: { type: "password", password: "" } }
    );

    try {
      const paneId = tabsStore.getTab(tabId)!.activePaneId!;
      const targetPaneId = await tabsStore.splitPane(tabId, paneId, "row");
      const documentId = await tabsStore.openDocument(tabId, paneId, {
        name: "move.ts",
        path: "/srv/move.ts",
        size: 64,
      });

      await tabsStore.movePaneWithinTab(
        tabId,
        paneId,
        targetPaneId!,
        "col",
        "before"
      );

      expect(tabsStore.getTab(tabId)?.layout).toMatchObject({
        type: "split",
        dir: "col",
        children: [
          { paneIds: [paneId], documentIds: [documentId] },
          { paneIds: [targetPaneId], documentIds: [] },
        ],
      });
      expect(tabsStore.getDocument(tabId, documentId!)).toMatchObject({
        sourcePaneId: paneId,
        path: "/srv/move.ts",
      });
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("aligns a leaf with the remaining active document after close", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "align.example.com",
      22,
      { username: "deploy", method: { type: "password", password: "" } }
    );

    try {
      const firstPaneId = tabsStore.getTab(tabId)!.activePaneId!;
      const secondPaneId = await tabsStore.addPaneTab(tabId, firstPaneId);
      const firstDocumentId = await tabsStore.openDocument(tabId, firstPaneId, {
        name: "first.txt",
        path: "/srv/first.txt",
        size: 16,
      });
      const secondDocumentId = await tabsStore.openDocument(tabId, secondPaneId!, {
        name: "second.txt",
        path: "/srv/second.txt",
        size: 16,
      });

      await tabsStore.closeDocument(tabId, firstDocumentId!);

      expect(tabsStore.getTab(tabId)).toMatchObject({
        activePaneId: secondPaneId,
        layout: {
          paneId: secondPaneId,
          activeItem: { kind: "document", id: secondDocumentId },
          documentIds: [secondDocumentId],
        },
      });
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("moves open documents when merging their source tab", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const sourceTabId = tabsStore.addTab(
      "source.example.com",
      22,
      { username: "source", method: { type: "password", password: "" } }
    );
    const targetTabId = tabsStore.addTab(
      "target.example.com",
      22,
      { username: "target", method: { type: "password", password: "" } }
    );

    try {
      const sourcePaneId = tabsStore.getTab(sourceTabId)!.activePaneId!;
      const documentId = await tabsStore.openDocument(sourceTabId, sourcePaneId, {
        name: "merged.md",
        path: "/srv/merged.md",
        size: 32,
      });
      tabsStore.setDocumentLoaded(sourceTabId, documentId!, "before", false);
      tabsStore.setDocumentContent(sourceTabId, documentId!, "after");
      tabsStore.setDocumentSaveStarted(sourceTabId, documentId!);
      const activeSourcePaneId = await tabsStore.addPaneTab(sourceTabId, sourcePaneId);

      await tabsStore.mergeTab(sourceTabId, targetTabId, "row", "before");

      expect(tabsStore.getTab(sourceTabId)).toBeUndefined();
      expect(tabsStore.getDocument(targetTabId, documentId!)).toMatchObject({
        sourcePaneId,
        path: "/srv/merged.md",
        content: "after",
        savedContent: "before",
        saveState: "saving",
      });
      expect(JSON.stringify(tabsStore.getTab(targetTabId)?.layout)).toContain(
        documentId!
      );
      expect(tabsStore.getTab(targetTabId)?.activePaneId).toBe(activeSourcePaneId);
      tabsStore.setDocumentSaved(sourceTabId, documentId!, "after");
      expect(tabsStore.getDocument(targetTabId, documentId!)).toMatchObject({
        dirty: false,
        savedContent: "after",
        saveState: "saved",
      });
    } finally {
      tabsStore.removeTab(sourceTabId);
      tabsStore.removeTab(targetTabId);
    }
  });

  test("deduplicates the same target path while preserving unsaved source content", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const auth = { username: "deploy", method: { type: "password" as const, password: "" } };
    const sourceTabId = tabsStore.addTab("merge.example.com", 22, auth);
    const targetTabId = tabsStore.addTab("merge.example.com", 22, auth);

    try {
      const sourcePaneId = tabsStore.getTab(sourceTabId)!.activePaneId!;
      const targetPaneId = tabsStore.getTab(targetTabId)!.activePaneId!;
      tabsStore.setPaneConnected(sourceTabId, sourcePaneId, "source-session");
      tabsStore.setPaneConnected(targetTabId, targetPaneId, "target-session");
      const sourceDocumentId = await tabsStore.openDocument(sourceTabId, sourcePaneId, {
        name: "shared.txt",
        path: "/srv/shared.txt",
        size: 32,
      });
      const targetDocumentId = await tabsStore.openDocument(targetTabId, targetPaneId, {
        name: "shared.txt",
        path: "/srv/shared.txt",
        size: 32,
      });
      tabsStore.setDocumentLoaded(sourceTabId, sourceDocumentId!, "base", false);
      tabsStore.setDocumentContent(sourceTabId, sourceDocumentId!, "source edit");
      tabsStore.setDocumentLoaded(targetTabId, targetDocumentId!, "base", false);
      tabsStore.setDocumentCachedLocalPath(
        targetTabId,
        targetDocumentId!,
        "/tmp/shared-cache"
      );

      const result = await tabsStore.mergeTab(sourceTabId, targetTabId, "row", "before");

      expect(result).toEqual({ status: "merged" });
      expect(tabsStore.getTab(sourceTabId)).toBeUndefined();
      expect(tabsStore.getTab(targetTabId)?.documents).toHaveLength(1);
      expect(tabsStore.getDocument(targetTabId, sourceDocumentId!)).toMatchObject({
        sourcePaneId,
        sourceSessionId: "source-session",
        content: "source edit",
        savedContent: "base",
        dirty: true,
        cachedLocalPath: "/tmp/shared-cache",
      });
      expect(tabsStore.getDocument(targetTabId, targetDocumentId!)).toBeUndefined();
      const layout = JSON.stringify(tabsStore.getTab(targetTabId)?.layout);
      expect(layout).toContain(sourceDocumentId!);
      expect(layout).not.toContain(targetDocumentId!);
    } finally {
      tabsStore.removeTab(sourceTabId);
      tabsStore.removeTab(targetTabId);
    }
  });

  test("rejects a tab merge with divergent unsaved copies of the same file", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const auth = { username: "deploy", method: { type: "password" as const, password: "" } };
    const sourceTabId = tabsStore.addTab("merge.example.com", 22, auth);
    const targetTabId = tabsStore.addTab("merge.example.com", 22, auth);

    try {
      const sourcePaneId = tabsStore.getTab(sourceTabId)!.activePaneId!;
      const targetPaneId = tabsStore.getTab(targetTabId)!.activePaneId!;
      const sourceDocumentId = await tabsStore.openDocument(sourceTabId, sourcePaneId, {
        name: "shared.txt",
        path: "/srv/shared.txt",
        size: 32,
      });
      const targetDocumentId = await tabsStore.openDocument(targetTabId, targetPaneId, {
        name: "shared.txt",
        path: "/srv/shared.txt",
        size: 32,
      });
      tabsStore.setDocumentLoaded(sourceTabId, sourceDocumentId!, "base", false);
      tabsStore.setDocumentContent(sourceTabId, sourceDocumentId!, "source edit");
      tabsStore.setDocumentLoaded(targetTabId, targetDocumentId!, "base", false);
      tabsStore.setDocumentContent(targetTabId, targetDocumentId!, "target edit");

      const result = await tabsStore.mergeTab(sourceTabId, targetTabId, "row", "before");

      expect(result).toEqual({ status: "conflict", path: "/srv/shared.txt" });
      expect(tabsStore.getTab(sourceTabId)?.documents).toHaveLength(1);
      expect(tabsStore.getTab(targetTabId)?.documents).toHaveLength(1);
      expect(tabsStore.getDocument(sourceTabId, sourceDocumentId!)).toMatchObject({
        content: "source edit",
        dirty: true,
      });
      expect(tabsStore.getDocument(targetTabId, targetDocumentId!)).toMatchObject({
        content: "target edit",
        dirty: true,
      });
    } finally {
      tabsStore.removeTab(sourceTabId);
      tabsStore.removeTab(targetTabId);
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

  test("keeps live shared key sessions bound to their original target", async () => {
    const storage = new MemoryStorage();
    installBrowserStorage(storage);
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "shared.example.com",
      22,
      { username: "deploy", method: { type: "key", key_id: "key-old" } },
      "connection-shared",
      false,
      undefined,
      undefined,
      "id_old",
      true,
      false
    );
    const otherTabId = tabsStore.addTab(
      "shared.example.com",
      22,
      { username: "deploy", method: { type: "key", key_id: "key-old" } },
      "connection-other",
      false,
      undefined,
      undefined,
      "id_old",
      true,
      false
    );

    const idleTabId = tabsStore.addTab(
      "shared.example.com",
      22,
      { username: "deploy", method: { type: "key", key_id: "key-old" } },
      "connection-shared",
      false,
      undefined,
      undefined,
      "id_old",
      true,
      false
    );
    const idleConnectionRef = tabsStore.getTab(idleTabId)!.panes[0]!.connection;

    try {
      const firstPaneId = tabsStore.getTab(tabId)!.activePaneId!;
      const secondPaneId = await tabsStore.splitPane(tabId, firstPaneId, "row");
      expect(secondPaneId).not.toBeNull();
      tabsStore.setPaneConnected(tabId, firstPaneId, "session-one");
      tabsStore.setPaneConnected(tabId, secondPaneId!, "session-two");
      const connectionRefs = tabsStore
        .getTab(tabId)!
        .panes.map((pane) => pane.connection);

      tabsStore.replaceManagedKeyReferences("key-old", {
        host: "new.example.com",
        port: 2222,
        auth: {
          username: "operator",
          method: { type: "key", key_id: "key-new", passphrase: "runtime-only" },
        },
        connectionId: "connection-shared",
        keyName: "id_new",
        canRestorePassword: false,
        saveConnection: true,
        savePassword: false,
      });

      const panes = tabsStore.getTab(tabId)!.panes;
      expect(panes[0]!.connection).toBe(connectionRefs[0]);
      expect(panes[1]!.connection).toBe(connectionRefs[1]);
      expect(panes.map((pane) => pane.connection.auth.method)).toEqual([
        { type: "key", key_id: "key-old" },
        { type: "key", key_id: "key-old" },
      ]);
      expect(panes.map((pane) => pane.sessionId)).toEqual([
        "session-one",
        "session-two",
      ]);
      expect(panes.every((pane) => pane.connection.keyName === "id_old")).toBe(true);
      expect(panes.map((pane) => pane.connection.host)).toEqual([
        "shared.example.com",
        "shared.example.com",
      ]);
      expect(panes.map((pane) => pane.connection.port)).toEqual([22, 22]);
      expect(panes.map((pane) => pane.connection.auth.username)).toEqual([
        "deploy",
        "deploy",
      ]);
      expect(panes.every((pane) => pane.connection.connectionId === undefined)).toBe(true);
      expect(panes.every((pane) => pane.connection.saveConnection === false)).toBe(true);
      const idlePane = tabsStore.getTab(idleTabId)!.panes[0]!;
      expect(idlePane.connection).not.toBe(idleConnectionRef);
      expect(idlePane.sessionId).toBeNull();
      expect(idlePane.connection).toMatchObject({
        host: "new.example.com",
        port: 2222,
        connectionId: "connection-shared",
        keyName: "id_new",
        auth: {
          username: "operator",
          method: { type: "key", key_id: "key-new", passphrase: "runtime-only" },
        },
      });

      const otherPane = tabsStore.getTab(otherTabId)!.panes[0]!;
      expect(otherPane.connection.connectionId).toBe("connection-other");
      expect(otherPane.connection.host).toBe("shared.example.com");
      expect(otherPane.connection.auth.method).toEqual({
        type: "key",
        key_id: "key-old",
      });

      const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      expect(JSON.stringify(persisted)).not.toContain("runtime-only");
      expect(
        persisted.tabs[0].panes.every(
          (pane: { connection: { auth: { method: { key_id?: string } } } }) =>
            pane.connection.auth.method.key_id === "key-old"
        )
      ).toBe(true);
      expect(
        persisted.tabs[0].panes.every(
          (pane: { connection: { host: string; connectionId?: string } }) =>
            pane.connection.host === "shared.example.com" &&
            pane.connection.connectionId === undefined
        )
      ).toBe(true);
    } finally {
      tabsStore.removeTab(tabId);
      tabsStore.removeTab(otherTabId);
      tabsStore.removeTab(idleTabId);
    }
  });
  test("detaches panes while preserving managed key authentication", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const tabId = tabsStore.addTab(
      "shared.example.com",
      22,
      { username: "deploy", method: { type: "key", key_id: "key-live" } },
      "connection-deleted",
      false,
      undefined,
      undefined,
      "id_ed25519",
      true,
      false
    );

    try {
      tabsStore.detachSavedConnection("connection-deleted");

      const connection = tabsStore.getTab(tabId)!.panes[0]!.connection;
      expect(connection.connectionId).toBeUndefined();
      expect(connection.saveConnection).toBe(false);
      expect(connection.savePassword).toBe(false);
      expect(connection.canRestorePassword).toBe(false);
      expect(connection.auth.method).toEqual({ type: "key", key_id: "key-live" });
    } finally {
      tabsStore.removeTab(tabId);
    }
  });

  test("does not merge panes from a source tab closed before the queued mutation", async () => {
    installBrowserStorage(new MemoryStorage());
    const { tabsStore } = await import("./tabs.svelte");
    const sourceTabId = tabsStore.addTab(
      "source.example.com",
      22,
      { username: "source", method: { type: "password", password: "" } }
    );
    const targetTabId = tabsStore.addTab(
      "target.example.com",
      22,
      { username: "target", method: { type: "password", password: "" } }
    );

    try {
      const sourcePane = tabsStore.getTab(sourceTabId)!.panes[0]!;
      tabsStore.setPaneConnected(sourceTabId, sourcePane.id, "session-race");

      const merge = tabsStore.mergeTab(
        sourceTabId,
        targetTabId,
        "row",
        "before"
      );
      tabsStore.removeTab(sourceTabId);
      await merge;

      expect(tabsStore.getTab(targetTabId)!.panes).toHaveLength(1);
      expect(
        tabsStore.getTab(targetTabId)!.panes.some(
          (pane) => pane.sessionId === "session-race"
        )
      ).toBe(false);
    } finally {
      tabsStore.removeTab(sourceTabId);
      tabsStore.removeTab(targetTabId);
    }
  });

});
