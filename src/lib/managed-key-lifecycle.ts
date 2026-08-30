import { connectionsStore } from "$lib/stores/connections.svelte";
import { tabsStore, type Pane } from "$lib/stores/tabs.svelte";
import {
  acknowledgeUploadedSshKey,
  deleteUploadedSshKey,
  loadConnections,
  listPendingUploadedSshKeys,
  type SavedConnection,
} from "$lib/tauri/commands";

const PENDING_CLEANUP_STORAGE_KEY = "redterm.pending-key-cleanup.v1";
let cleanupQueue: Promise<void> = Promise.resolve();
let cleanupTokenCounter = 0;
const retainedCleanupKeys = new Map<string, number>();

function nextCleanupToken(): string {
  cleanupTokenCounter += 1;
  return Date.now().toString() + ":" + cleanupTokenCounter.toString();
}

function readPendingCleanup(): Map<string, string> {
  if (typeof localStorage === "undefined") return new Map();
  try {
    const stored = JSON.parse(
      localStorage.getItem(PENDING_CLEANUP_STORAGE_KEY) ?? "{}"
    );
    if (Array.isArray(stored)) {
      return new Map(
        stored
          .filter((value): value is string => typeof value === "string")
          .map((keyId) => [keyId, "legacy"] as const)
      );
    }
    if (!stored || typeof stored !== "object") return new Map();
    return new Map(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return new Map();
  }
}

function writePendingCleanup(pending: ReadonlyMap<string, string>) {
  if (typeof localStorage === "undefined") return;
  if (pending.size === 0) {
    localStorage.removeItem(PENDING_CLEANUP_STORAGE_KEY);
    return;
  }
  localStorage.setItem(
    PENDING_CLEANUP_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(pending))
  );
}

function paneUsesManagedKey(keyId: string): boolean {
  return tabsStore.tabs.some((tab) =>
    tab.panes.some((pane) => {
      const method = pane.connection.auth.method;
      return method.type === "key" && method.key_id === keyId;
    })
  );
}

function detachStaleManagedKeyReferences(
  keyId: string,
  savedConnections: readonly SavedConnection[]
) {
  const savedById = new Map(
    savedConnections.map((connection) => [connection.id, connection])
  );
  const staleConnectionIds = new Set<string>();
  for (const tab of tabsStore.tabs) {
    for (const pane of tab.panes) {
      const method = pane.connection.auth.method;
      const connectionId = pane.connection.connectionId;
      if (
        connectionId &&
        pane.connection.saveConnection !== false &&
        method.type === "key" &&
        method.key_id === keyId &&
        savedById.get(connectionId)?.key_id !== keyId
      ) {
        staleConnectionIds.add(connectionId);
      }
    }
  }
  for (const connectionId of staleConnectionIds) {
    tabsStore.detachManagedKeyReferences(connectionId, keyId);
  }
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
  const candidates = readPendingCleanup();
  if (candidates.size === 0) return;

  const savedConnections = await currentSavedConnections();
  if (!savedConnections) return;

  const completed = new Set<string>();
  for (const keyId of candidates.keys()) {
    if (retainedCleanupKeys.has(keyId)) continue;

    detachStaleManagedKeyReferences(keyId, savedConnections);
    const usedBySavedConnection = savedConnections.some(
      (connection) => connection.key_id === keyId
    );
    if (paneUsesManagedKey(keyId) || usedBySavedConnection) {
      try {
        await acknowledgeUploadedSshKey(keyId);
        completed.add(keyId);
      } catch (error) {
        console.error("Failed to acknowledge referenced SSH key:", error);
      }
      continue;
    }

    try {
      await deleteUploadedSshKey(keyId);
      completed.add(keyId);
    } catch (error) {
      console.error("Failed to delete unreferenced SSH key:", error);
    }
  }

  const pending = readPendingCleanup();
  for (const keyId of completed) {
    if (pending.get(keyId) === candidates.get(keyId)) pending.delete(keyId);
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

export function stageManagedKeyCleanup(keyIds: readonly string[]): void {
  const pending = readPendingCleanup();
  for (const keyId of keyIds) pending.set(keyId, nextCleanupToken());
  writePendingCleanup(pending);
}

export function retainPendingManagedKey(keyId: string): () => void {
  stageManagedKeyCleanup([keyId]);
  retainedCleanupKeys.set(keyId, (retainedCleanupKeys.get(keyId) ?? 0) + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (retainedCleanupKeys.get(keyId) ?? 1) - 1;
    if (remaining > 0) retainedCleanupKeys.set(keyId, remaining);
    else retainedCleanupKeys.delete(keyId);
  };
}

export function cleanupUnreferencedManagedKeys(
  keyIds: readonly string[]
): Promise<void> {
  stageManagedKeyCleanup(keyIds);
  return enqueueCleanup(flushPendingCleanup);
}

export function retryPendingManagedKeyCleanup(): Promise<void> {
  return enqueueCleanup(async () => {
    try {
      stageManagedKeyCleanup(await listPendingUploadedSshKeys());
    } catch (error) {
      console.error("Failed to list pending SSH key uploads:", error);
    }
    await flushPendingCleanup();
  });
}
