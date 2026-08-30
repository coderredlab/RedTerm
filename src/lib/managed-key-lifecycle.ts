import { connectionsStore } from "$lib/stores/connections.svelte";
import { tabsStore, type Pane } from "$lib/stores/tabs.svelte";
import { deleteUploadedSshKey } from "$lib/tauri/commands";

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

export async function cleanupUnreferencedManagedKeys(
  keyIds: readonly string[]
): Promise<void> {
  for (const keyId of new Set(keyIds)) {
    const usedByPane = tabsStore.tabs.some((tab) =>
      tab.panes.some((pane) => {
        const method = pane.connection.auth.method;
        return method.type === "key" && method.key_id === keyId;
      })
    );
    const usedBySavedConnection = connectionsStore.connections.some(
      (connection) => connection.key_id === keyId
    );
    if (usedByPane || usedBySavedConnection) continue;

    try {
      await deleteUploadedSshKey(keyId);
    } catch (error) {
      console.error("Failed to delete unreferenced SSH key:", error);
    }
  }
}
