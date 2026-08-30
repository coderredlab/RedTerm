import {
  loadConnections,
  saveConnection,
  deleteConnection,
  type SavedConnection,
} from "$lib/tauri/commands";

function createConnectionsStore() {
  let connections = $state<SavedConnection[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let loaded = $state(false);

  return {
    get connections() {
      return connections;
    },

    get loading() {
      return loading;
    },

    get error() {
      return error;
    },

    get loaded() {
      return loaded;
    },

    async load(): Promise<boolean> {
      loading = true;
      error = null;
      loaded = false;
      try {
        connections = await loadConnections();
        loaded = true;
        return true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        return false;
      } finally {
        loading = false;
      }
    },

    async save(connection: SavedConnection, password?: string) {
      error = null;
      try {
        await saveConnection(connection, password);
        // Reload to get updated list
        await this.load();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },

    async delete(id: string) {
      error = null;
      try {
        await deleteConnection(id);
        // Reload to get updated list
        await this.load();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
  };
}

export const connectionsStore = createConnectionsStore();
