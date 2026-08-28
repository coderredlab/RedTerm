<script lang="ts">
  import { onMount } from "svelte";
  import { connectionsStore } from "$lib/stores/connections.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import type { AuthConfig, SavedConnection } from "$lib/tauri/commands";

  interface Props {
    onEdit?: (connection: SavedConnection) => void;
    onNewConnection?: () => void;
  }

  let { onEdit, onNewConnection }: Props = $props();

  onMount(() => {
    connectionsStore.load();
  });

  function handleQuickConnect(connection: SavedConnection) {
    if (connection.key_id) {
      const auth: AuthConfig = {
        username: connection.username,
        method: { type: "key", key_id: connection.key_id },
      };
      tabsStore.addTab(connection.host, connection.port, auth, connection.id, false, connection.startup_script, connection.startup_script_ready_text);
      return;
    }

    if (connection.has_saved_password) {
      const auth: AuthConfig = {
        username: connection.username,
        method: { type: "stored_password", connection_id: connection.id },
      };
      tabsStore.addTab(connection.host, connection.port, auth, connection.id, true, connection.startup_script, connection.startup_script_ready_text);
      return;
    }

    onEdit?.(connection);
  }

  async function handleDelete(connection: SavedConnection) {
    if (confirm(`Delete "${connection.name}"?`)) {
      await connectionsStore.delete(connection.id);
    }
  }
</script>

<div class="connection-list">
  <div class="header">
    <h3>Saved Connections</h3>
    <button class="btn-new" onclick={onNewConnection}>
      + New
    </button>
  </div>

  {#if connectionsStore.loading}
    <div class="loading">Loading...</div>
  {:else if connectionsStore.connections.length === 0}
    <div class="empty">
      <p>No saved connections</p>
      <button class="btn-primary" onclick={onNewConnection}>
        Add Connection
      </button>
    </div>
  {:else}
    <div class="connections">
      {#each connectionsStore.connections as connection (connection.id)}
        <div class="connection-item">
          <button
            class="connection-main"
            onclick={() => handleQuickConnect(connection)}
          >
            <div class="connection-name">{connection.name}</div>
            <div class="connection-details">
              {connection.username}@{connection.host}:{connection.port}
              {#if connection.has_saved_password}
                <span class="password-saved" title="Password saved">🔐</span>
              {/if}
              {#if connection.key_id}
                <span class="key-auth" title="SSH Key">🔑</span>
              {/if}
            </div>
          </button>

          <div class="connection-actions">
            <button
              class="btn-icon"
              title="Edit"
              onclick={() => onEdit?.(connection)}
            >
              ✎
            </button>
            <button
              class="btn-icon delete"
              title="Delete"
              onclick={() => handleDelete(connection)}
            >
              ✕
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .connection-list {
    background: var(--bg-primary);
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--border-primary);
  }

  h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 16px;
  }

  .btn-new {
    padding: 8px 16px;
    background: var(--accent-primary);
    border: none;
    border-radius: 6px;
    color: var(--bg-primary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-new:hover {
    background: var(--accent-hover);
  }

  .loading,
  .empty {
    padding: 32px;
    text-align: center;
    color: var(--text-muted);
  }

  .empty p {
    margin-bottom: 16px;
  }

  .btn-primary {
    padding: 12px 24px;
    background: var(--accent-primary);
    border: none;
    border-radius: 6px;
    color: var(--bg-primary);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }

  .connections {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .connection-item {
    display: flex;
    align-items: center;
    background: var(--bg-secondary);
    border-radius: 8px;
    margin-bottom: 8px;
    overflow: hidden;
  }

  .connection-main {
    flex: 1;
    padding: 12px 16px;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .connection-main:hover {
    background: var(--bg-tertiary);
  }

  .connection-name {
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 4px;
  }

  .connection-details {
    color: var(--text-muted);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .password-saved,
  .key-auth {
    font-size: 10px;
  }

  .connection-actions {
    display: flex;
    padding: 0 8px;
    gap: 4px;
  }

  .btn-icon {
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    border-radius: 4px;
  }

  .btn-icon:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .btn-icon.delete:hover {
    color: var(--status-error);
  }
</style>
