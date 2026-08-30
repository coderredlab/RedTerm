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
  let loadGeneration = 0;

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
      const generation = ++loadGeneration;
      loading = true;
      error = null;
      loaded = false;
      try {
        const nextConnections = await loadConnections();
        if (generation !== loadGeneration) return false;
        connections = nextConnections;
        loaded = true;
        return true;
      } catch (e) {
        if (generation === loadGeneration) {
          error = e instanceof Error ? e.message : String(e);
        }
        return false;
      } finally {
        if (generation === loadGeneration) loading = false;
      }
    },

    async save(connection: SavedConnection, password?: string): Promise<boolean> {
      error = null;
      try {
        await saveConnection(connection, password);
        const index = connections.findIndex((candidate) => candidate.id === connection.id);
        connections = index === -1
          ? [...connections, connection]
          : connections.map((candidate) =>
              candidate.id === connection.id ? connection : candidate
            );
        return await this.load();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },

    async delete(id: string): Promise<boolean> {
      error = null;
      try {
        await deleteConnection(id);
        connections = connections.filter((connection) => connection.id !== id);
        return await this.load();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
  };
}

export const connectionsStore = createConnectionsStore();
