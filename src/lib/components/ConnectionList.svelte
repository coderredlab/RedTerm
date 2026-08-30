<script lang="ts">
  import { onMount } from "svelte";
  import { connectionsStore } from "$lib/stores/connections.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import type { AuthConfig, SavedConnection } from "$lib/tauri/commands";

  interface Props {
    onEdit?: (connection: SavedConnection) => void;
    onNewConnection?: () => void;
    onOpenLocal?: () => void;
    showNewActions?: boolean;
  }

  let { onEdit, onNewConnection, onOpenLocal, showNewActions = true }: Props = $props();

  let deletingId = $state<string | null>(null);

  async function loadConnectionList() {
    await connectionsStore.load();
  }

  onMount(() => {
    void loadConnectionList();
  });

  function handleQuickConnect(connection: SavedConnection) {
    if (connection.key_id) {
      const auth: AuthConfig = {
        username: connection.username,
        method: { type: "key", key_id: connection.key_id },
      };
      tabsStore.addTab(
        connection.host,
        connection.port,
        auth,
        connection.id,
        false,
        connection.startup_script,
        connection.startup_script_ready_text,
        connection.key_name,
        true,
        false
      );
      return;
    }

    if (connection.has_saved_password) {
      const auth: AuthConfig = {
        username: connection.username,
        method: { type: "stored_password", connection_id: connection.id },
      };
      tabsStore.addTab(
        connection.host,
        connection.port,
        auth,
        connection.id,
        true,
        connection.startup_script,
        connection.startup_script_ready_text,
        undefined,
        true,
        true
      );
      return;
    }

    onEdit?.(connection);
  }

  async function handleDelete(connection: SavedConnection) {
    if (!confirm(`Delete "${connection.name}"?`)) return;

    deletingId = connection.id;
    try {
      await connectionsStore.delete(connection.id);
    } catch {
      // The store exposes the backend error for the inline alert below.
    } finally {
      deletingId = null;
    }
  }
</script>

<div class="connection-list">
  <div class="header">
    <h3>Connections</h3>
    {#if showNewActions}
      <button class="btn-new" onclick={onNewConnection}>
        + New
      </button>
    {/if}
  </div>
  {#if onOpenLocal}
    <button class="local-entry" onclick={onOpenLocal}>
      <span class="local-entry-glyph" aria-hidden="true">&gt;_</span>
      <span class="local-entry-text">
        <span class="local-entry-name">Local Shell</span>
        <span class="local-entry-sub">This machine</span>
      </span>
    </button>
  {/if}
  {#if connectionsStore.error}
    <div class="connection-error" role="alert">
      <strong>{connectionsStore.errorContext === "delete"
        ? "Couldn’t delete connection."
        : connectionsStore.errorContext === "save"
          ? "Couldn’t save connection."
          : "Couldn’t load saved connections."}</strong>
      <span>{connectionsStore.error}</span>
      <button type="button" onclick={() => void loadConnectionList()}>Reload</button>
    </div>
  {/if}
  {#if connectionsStore.loading}
    <div class="loading">Loading…</div>
  {:else if connectionsStore.connections.length === 0 && !connectionsStore.error}
    <div class="empty">
      <p>No saved connections</p>
      {#if showNewActions}
        <button class="btn-primary" onclick={onNewConnection}>
          Add Connection
        </button>
      {/if}
    </div>
  {:else if connectionsStore.connections.length > 0}
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
              disabled={deletingId === connection.id}
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

  .local-entry {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 10px 4px;
    padding: 10px 12px;
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .local-entry:hover {
    border-color: var(--accent-muted);
    color: var(--text-primary);
  }

  .local-entry-glyph {
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border: 1px solid var(--status-success);
    border-radius: 4px;
    color: var(--status-success);
    font-size: 10px;
    font-weight: 700;
    flex: 0 0 auto;
  }

  .local-entry-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .local-entry-name {
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 700;
  }

  .local-entry-sub {
    color: var(--text-secondary);
    font-size: 11px;
  }

  .connection-error {
    flex: 0 0 auto;
    display: grid;
    gap: 7px;
    margin: 8px 10px 4px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--status-error) 58%, var(--border-primary));
    border-radius: 6px;
    background: color-mix(in srgb, var(--status-error) 10%, var(--bg-secondary));
  }

  .connection-error strong {
    color: var(--status-error);
    font-size: 12px;
  }

  .connection-error span {
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .connection-error button {
    justify-self: start;
    padding: 6px 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .connection-error button:hover {
    border-color: var(--accent-muted);
  }

  .loading,
  .empty {
    padding: 32px;
    text-align: center;
    color: var(--text-muted);
  }

  .empty p {
    margin: 0;
  }

  .btn-primary {
    margin-top: 16px;
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
