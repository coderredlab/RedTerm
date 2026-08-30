import { connectionsStore } from "$lib/stores/connections.svelte";
import { tabsStore, type Pane } from "$lib/stores/tabs.svelte";
import {
  deleteUploadedSshKey,
  loadConnections,
  type SavedConnection,
} from "$lib/tauri/commands";

const PENDING_CLEANUP_STORAGE_KEY = "redterm.pending-key-cleanup.v1";
let cleanupQueue: Promise<void> = Promise.resolve();

function readPendingCleanup(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const stored = JSON.parse(
      localStorage.getItem(PENDING_CLEANUP_STORAGE_KEY) ?? "[]"
    );
    return new Set(
      Array.isArray(stored)
        ? stored.filter((value): value is string => typeof value === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

function writePendingCleanup(keyIds: ReadonlySet<string>) {
  if (typeof localStorage === "undefined") return;
  if (keyIds.size === 0) {
    localStorage.removeItem(PENDING_CLEANUP_STORAGE_KEY);
    return;
  }
  localStorage.setItem(PENDING_CLEANUP_STORAGE_KEY, JSON.stringify([...keyIds]));
}

function paneUsesManagedKey(keyId: string): boolean {
  return tabsStore.tabs.some((tab) =>
    tab.panes.some((pane) => {
      const method = pane.connection.auth.method;
      return method.type === "key" && method.key_id === keyId;
    })
  );
}

async function currentSavedConnections(): Promise<SavedConnection[] | null> {
  if (connectionsStore.loaded) return connectionsStore.connections;
  try {
    return await loadConnections();
  } catch {
    return null;
  }
}

async function flushPendingCleanup(): Promise<void> {
  const pending = readPendingCleanup();
  if (pending.size === 0) return;

  const savedConnections = await currentSavedConnections();
  if (!savedConnections) return;

  for (const keyId of pending) {
    const usedBySavedConnection = savedConnections.some(
      (connection) => connection.key_id === keyId
    );
    if (paneUsesManagedKey(keyId) || usedBySavedConnection) {
      pending.delete(keyId);
      continue;
    }

    try {
      await deleteUploadedSshKey(keyId);
      pending.delete(keyId);
    } catch (error) {
      console.error("Failed to delete unreferenced SSH key:", error);
    }
  }

  writePendingCleanup(pending);
}

function enqueueCleanup(operation: () => Promise<void>): Promise<void> {
  const queued = cleanupQueue.then(operation, operation);
  cleanupQueue = queued.catch(() => undefined);
  return queued;
}

export function transientManagedKeyIds(panes: readonly Pane[]): string[] {
  const keyIds = new Set<string>();

  for (const pane of panes) {
    const method = pane.connection.auth.method;
    const isTransient =
      pane.connection.saveConnection === false || !pane.connection.connectionId;
    if (isTransient && method.type === "key") {
      keyIds.add(method.key_id);
    }
  }

  return [...keyIds];
}

export function cleanupUnreferencedManagedKeys(
  keyIds: readonly string[]
): Promise<void> {
  return enqueueCleanup(async () => {
    const pending = readPendingCleanup();
    for (const keyId of keyIds) pending.add(keyId);
    writePendingCleanup(pending);
    await flushPendingCleanup();
  });
}

export function retryPendingManagedKeyCleanup(): Promise<void> {
  return enqueueCleanup(flushPendingCleanup);
}
