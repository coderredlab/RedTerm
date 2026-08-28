
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import ConnectionDialog from "$lib/components/ConnectionDialog.svelte";
  import ConnectionList from "$lib/components/ConnectionList.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import { terminalModesStore } from "$lib/stores/terminal-modes.svelte";
  import type { SavedConnection } from "$lib/tauri/commands";
  import {
    getRuntimeInstanceId,
    sshDisconnect,
    sshSessionExists,
  } from "$lib/tauri/commands";
  import Terminal from "$lib/terminal/Terminal.svelte";

  let showDialog = $state(false);
  let editingConnection = $state<SavedConnection | undefined>(undefined);
  let terminalRefs = $state<Record<string, Terminal | undefined>>({});
  let runtimeInstanceId = $state<string | null>(null);
  let sessionsReconciled = $state(false);

  onMount(() => {
    window.addEventListener("resize", resizeActiveTerminal);
    void reconcilePersistedSessions();
  });

  onDestroy(() => {
    window.removeEventListener("resize", resizeActiveTerminal);
  });

  function resizeActiveTerminal() {
    terminalRefs[tabsStore.activeTabId ?? ""]?.resize();
  }

  function handleNewConnection() {
    editingConnection = undefined;
    showDialog = true;
  }

  function handleEdit(connection: SavedConnection) {
    editingConnection = connection;
    showDialog = true;
  }

  function handleCloseDialog() {
    showDialog = false;
    editingConnection = undefined;
  }

  function handleConnected(tabId: string, sessionId: string) {
    tabsStore.setConnected(tabId, sessionId, runtimeInstanceId);
  }

  function handleDisconnected(tabId: string) {
    tabsStore.setDisconnected(tabId);
  }

  async function reconcilePersistedSessions() {
    try {
      runtimeInstanceId = await getRuntimeInstanceId();
    } catch (error) {
      console.error("Failed to load runtime instance id:", error);
      sessionsReconciled = true;
      return;
    }

    for (const tab of [...tabsStore.tabs]) {
      if (!tab.sessionId) continue;

      const sameRuntime = tab.runtimeInstanceId === runtimeInstanceId;
      const sessionAlive = sameRuntime
        ? await sshSessionExists(tab.sessionId).catch(() => false)
        : false;

      if (sessionAlive) continue;

      if (tab.auth.method.type === "password" && !tab.canRestorePassword) {
        tabsStore.removeTab(tab.id);
        continue;
      }

      tabsStore.setDisconnected(tab.id);
    }

    sessionsReconciled = true;
  }

  async function handleCloseTab(event: MouseEvent, tabId: string) {
    event.stopPropagation();

    const terminal = terminalRefs[tabId];
    const tab = tabsStore.getTab(tabId);
    if (terminal?.disconnect) {
      try {
        await terminal.disconnect();
      } catch (error) {
        console.error("Tab disconnect error:", error);
      }
    } else if (tab?.sessionId) {
      terminalModesStore.clearSession(tab.sessionId);
      try {
        await sshDisconnect(tab.sessionId);
      } catch (error) {
        console.error("Fallback tab disconnect error:", error);
      }
    }

    tabsStore.removeTab(tabId);
    delete terminalRefs[tabId];
  }
</script>

<svelte:head>
  <title>RedTerm Desktop</title>
</svelte:head>

<div class="desktop-app">
  <aside class="connections-panel">
    <div class="product-mark">
      <div class="product-glyph" aria-hidden="true">&gt;_</div>
      <div>
        <div class="product-name">RedTerm</div>
        <div class="product-edition">Desktop workspace</div>
      </div>
    </div>

    <ConnectionList onEdit={handleEdit} onNewConnection={handleNewConnection} />
  </aside>

  <section class="workspace">
    <header class="workspace-bar">
      <div class="tabs" role="tablist" aria-label="Terminal sessions">
        {#each tabsStore.tabs as tab (tab.id)}
          <button
            class="session-tab"
            class:active={tab.id === tabsStore.activeTabId}
            role="tab"
            aria-selected={tab.id === tabsStore.activeTabId}
            onclick={() => tabsStore.setActiveTab(tab.id)}
          >
            <span class="connection-state" class:connected={tab.connected}></span>
            <span class="session-title">{tab.title}</span>
            <span
              class="close-tab"
              role="button"
              tabindex="0"
              aria-label={`Close ${tab.title}`}
              onclick={(event) => void handleCloseTab(event, tab.id)}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void handleCloseTab(event as unknown as MouseEvent, tab.id);
                }
              }}
            >×</span>
          </button>
        {/each}
      </div>

      <button class="new-session" onclick={handleNewConnection}>
        <span aria-hidden="true">+</span>
        New connection
      </button>
    </header>

    <main class="terminal-workspace">
      {#if tabsStore.tabs.length === 0}
        <div class="empty-workspace">
          <div class="empty-rule"></div>
          <p class="empty-kicker">REMOTE WORKSPACE</p>
          <h1>Start with a server.</h1>
          <p class="empty-copy">
            Choose a saved connection from the left, or add a new SSH connection.
          </p>
          <button class="empty-action" onclick={handleNewConnection}>New connection</button>
        </div>
      {:else if !sessionsReconciled}
        <div class="session-restore-loader">Checking session state…</div>
      {:else}
        {#each tabsStore.tabs as tab (tab.id)}
          <div
            class="terminal-container"
            class:active={tab.id === tabsStore.activeTabId}
          >
            <Terminal
              host={tab.host}
              port={tab.port}
              auth={tab.auth}
              existingSessionId={tab.sessionId}
              connectionId={tab.connectionId}
              startupScript={tab.startupScript}
              startupScriptReadyText={tab.startupScriptReadyText}
              interactive={!showDialog && tab.id === tabsStore.activeTabId}
              onConnected={(sessionId) => handleConnected(tab.id, sessionId)}
              onDisconnected={() => handleDisconnected(tab.id)}
              bind:this={terminalRefs[tab.id]}
            />
          </div>
        {/each}
      {/if}
    </main>
  </section>

  <ConnectionDialog
    open={showDialog}
    editConnection={editingConnection}
    onClose={handleCloseDialog}
  />
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html, body) {
    margin: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  :global(body) {
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
  }

  .desktop-app {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    min-width: 760px;
    min-height: 520px;
    overflow: hidden;
    background: var(--bg-primary);
  }

  .connections-panel {
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border-primary);
    background: color-mix(in srgb, var(--bg-secondary) 78%, var(--bg-primary));
  }

  .product-mark {
    height: 68px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 18px;
    border-bottom: 1px solid var(--border-primary);
  }

  .product-glyph {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border: 1px solid var(--accent-primary);
    color: var(--accent-primary);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: -1px;
  }

  .product-name {
    color: var(--text-primary);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .product-edition {
    margin-top: 3px;
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .connections-panel :global(.connection-list) {
    min-height: 0;
    background: transparent;
  }

  .workspace {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--terminal-bg);
  }

  .workspace-bar {
    height: 45px;
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border-primary);
    background: var(--bg-primary);
  }

  .tabs {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: stretch;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .session-tab {
    min-width: 150px;
    max-width: 230px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 14px;
    border: 0;
    border-right: 1px solid var(--border-primary);
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .session-tab:hover {
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .session-tab.active {
    border-bottom-color: var(--accent-primary);
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .connection-state {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-muted);
  }

  .connection-state.connected {
    background: var(--status-success);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-success) 13%, transparent);
  }

  .session-title {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .close-tab {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 3px;
    color: var(--text-muted);
    font-size: 16px;
    line-height: 1;
  }

  .close-tab:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .new-session {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 16px;
    border: 0;
    border-left: 1px solid var(--border-primary);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .new-session span {
    color: var(--accent-primary);
    font-size: 17px;
  }

  .new-session:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .terminal-workspace {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .terminal-container {
    position: absolute;
    inset: 0;
    display: none;
  }

  .terminal-container.active {
    display: block;
  }

  .empty-workspace,
  .session-restore-loader {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    padding: clamp(48px, 8vw, 112px);
    background:
      linear-gradient(var(--border-primary) 1px, transparent 1px),
      linear-gradient(90deg, var(--border-primary) 1px, transparent 1px),
      var(--terminal-bg);
    background-size: 48px 48px;
  }

  .empty-workspace::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, var(--terminal-bg) 0%, transparent 58%);
    pointer-events: none;
  }

  .empty-workspace > * {
    position: relative;
  }

  .empty-rule {
    width: 44px;
    height: 3px;
    margin-bottom: 22px;
    background: var(--accent-primary);
  }

  .empty-kicker {
    margin: 0 0 12px;
    color: var(--accent-primary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.18em;
  }

  h1 {
    margin: 0;
    color: var(--terminal-fg);
    font-size: clamp(32px, 4vw, 58px);
    font-weight: 500;
    letter-spacing: -0.055em;
  }

  .empty-copy {
    max-width: 480px;
    margin: 18px 0 30px;
    color: var(--text-secondary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.65;
  }

  .empty-action {
    padding: 11px 17px;
    border: 1px solid var(--accent-primary);
    border-radius: 3px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
  }

  .empty-action:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .session-restore-loader {
    align-items: center;
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
