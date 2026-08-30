
<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import Terminal from "$lib/terminal/Terminal.svelte";
  import ExtraKeysBar from "$lib/components/ExtraKeysBar.svelte";
  import VoiceInputPopup from "$lib/components/VoiceInputPopup.svelte";
  import { createVoiceInputController } from "$lib/voice/voice-input-controller";
  import ConnectionDialog from "$lib/components/ConnectionDialog.svelte";
  import ConnectionList from "$lib/components/ConnectionList.svelte";
  import SettingsScreen from "$lib/components/SettingsScreen.svelte";
  import { cancelVoiceInput, checkVoiceInputPermissions, listenVoiceInput, listVoiceInputLanguages, requestVoiceInputPermissions, setKeyboardVisible, sshDisconnect, sshWrite, startVoiceInput, stopVoiceInput } from "$lib/tauri/commands";
  import {
    cleanupUnreferencedManagedKeys,
    retryPendingManagedKeyCleanup,
    transientManagedKeyIds,
  } from "$lib/managed-key-lifecycle";
  import { loadRuntimeInstanceId, resolveRecovery } from "$lib/session/reconcile";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import { connectionsStore } from "$lib/stores/connections.svelte";
  import { terminalModesStore } from "$lib/stores/terminal-modes.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import type { SavedConnection } from "$lib/tauri/commands";

  let showDialog = $state(false);
  let showSettings = $state(false);
  let editingConnection = $state<SavedConnection | undefined>(undefined);
  let terminalRefs = $state<Record<string, Terminal | undefined>>({});
  let editingPane = $state<{ tabId: string; paneId: string } | undefined>(undefined);
  // Show connection list when no tabs or when + button is pressed
  let showConnectionListManual = $state(false);
  let showConnectionList = $derived(tabsStore.tabs.length === 0 || showConnectionListManual);
  let prevTabCount = $state(tabsStore.tabs.length);
  let appElement: HTMLDivElement;
  let runtimeInstanceId = $state<string | null>(null);
  let sessionsReconciled = $state(false);
  let keyboardVisible = $state(false);
  let editPaneRequestGeneration = 0;

  const voiceInputController = createVoiceInputController({
    getActiveSessionId: () => tabsStore.activeTab?.sessionId,
    writeSsh: (sessionId, data) => sshWrite(sessionId, data),
    bridge: {
      checkPermissions: checkVoiceInputPermissions,
      requestPermissions: requestVoiceInputPermissions,
      listLanguages: listVoiceInputLanguages,
      start: startVoiceInput,
      stop: stopVoiceInput,
      cancel: cancelVoiceInput,
      listen: listenVoiceInput,
    },
  });
  // Hide connection list when a new tab is added
  $effect(() => {
    const currentCount = tabsStore.tabs.length;
    if (currentCount > prevTabCount && showConnectionListManual) {
      showConnectionListManual = false;
    }
    prevTabCount = currentCount;
  });

  function syncAppToViewport() {
    if (!window.visualViewport || !appElement) return;
    const h = Math.round(window.visualViewport.height);
    appElement.style.height = `${h}px`;
    getActiveTerminal()?.resize();

    // viewport가 화면의 85% 이상이면 키보드가 내려간 것 (뒤로가기 등)
    if (keyboardVisible && h >= window.screen.height * 0.85) {
      keyboardVisible = false;
      const input = document.querySelector('.terminal-container.active textarea.hidden-input') as HTMLTextAreaElement | null;
      if (input) input.setAttribute('inputmode', 'none');
      getActiveTerminal()?.focus();
    }
  }

  function preventNonTerminalPinchZoom(event: TouchEvent) {
    if (event.touches.length < 2) return;
    if (event.target instanceof Element && event.target.closest('.terminal-screen')) return;
    event.preventDefault();
  }

  onMount(() => {
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncAppToViewport);
      syncAppToViewport();
    }
    window.addEventListener('resize', syncAppToViewport);
    appElement.addEventListener('touchstart', preventNonTerminalPinchZoom, { passive: false });
    appElement.addEventListener('touchmove', preventNonTerminalPinchZoom, { passive: false });

    void reconcilePersistedSessions();
    void retryPendingManagedKeyCleanup();
  });

  onDestroy(() => {
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', syncAppToViewport);
    }
    window.removeEventListener('resize', syncAppToViewport);
    appElement.removeEventListener('touchstart', preventNonTerminalPinchZoom);
    appElement.removeEventListener('touchmove', preventNonTerminalPinchZoom);
    if (appElement) {
      appElement.style.height = '';
    }
  });

  function handleAddTab() {
    editPaneRequestGeneration += 1;
    // Show connection list instead of dialog
    showConnectionListManual = true;
  }
  function handleSelectTab(tabId: string) {
    editPaneRequestGeneration += 1;
    tabsStore.setActiveTab(tabId);
  }
  function handleOpenSettings() {
    editPaneRequestGeneration += 1;
    showSettings = true;
  }


  function handleCloseDialog() {
    editPaneRequestGeneration += 1;
    showDialog = false;
    editingConnection = undefined;
    editingPane = undefined;
  }

  function handleEdit(connection: SavedConnection) {
    editPaneRequestGeneration += 1;
    editingConnection = connection;
    editingPane = undefined;
    showDialog = true;
  }

  function handleNewConnection() {
    editPaneRequestGeneration += 1;
    editingConnection = undefined;
    editingPane = undefined;
    showDialog = true;
  }

  async function handleEditFailedConnection(tabId: string) {
    const requestGeneration = ++editPaneRequestGeneration;
    const tab = tabsStore.getTab(tabId);
    const paneId = tab?.activePaneId ?? tab?.panes[0]?.id;
    if (!paneId) return;
    let pane = tabsStore.getPane(tabId, paneId);
    if (!pane || pane.kind === "local") return;
    if (pane.connection.connectionId && !connectionsStore.loaded) {
      const loaded = await connectionsStore.load();
      if (requestGeneration !== editPaneRequestGeneration) return;

      pane = tabsStore.getPane(tabId, paneId);
      if (!pane || pane.kind === "local") return;
      if (pane.connected || pane.sessionId) return;
      if (!loaded && !connectionsStore.loaded) {
        showConnectionListManual = true;
        return;
      }
    }
    if (
      requestGeneration !== editPaneRequestGeneration ||
      tabsStore.activeTabId !== tabId
    ) return;

    editingConnection = pane.connection.connectionId && connectionsStore.loaded
      ? connectionsStore.connections.find(
          (connection) => connection.id === pane.connection.connectionId
        )
      : undefined;
    editingPane = { tabId, paneId };
    showDialog = true;
  }

  async function reconcilePersistedSessions() {
    runtimeInstanceId = await loadRuntimeInstanceId();
    if (runtimeInstanceId === null) {
      sessionsReconciled = true;
      return;
    }

    for (const tab of [...tabsStore.tabs]) {
      const verdict = await resolveRecovery(tab, runtimeInstanceId);
      if (verdict === "keep") continue;
      if (verdict === "remove") {
        const keyIds = transientManagedKeyIds(tab.panes);
        tabsStore.removeTab(tab.id);
        await cleanupUnreferencedManagedKeys(keyIds);
        continue;
      }
      tabsStore.setDisconnected(tab.id);
    }

    sessionsReconciled = true;
  }

  function handleConnected(tabId: string, sessionId: string) {
    editPaneRequestGeneration += 1;
    tabsStore.setConnected(tabId, sessionId, runtimeInstanceId);
  }

  function handleDisconnected(tabId: string) {
    tabsStore.setDisconnected(tabId);
  }

  function handleRetryConnection() {
    editPaneRequestGeneration += 1;
  }

  function handleTitleChanged(tabId: string, title: string) {
    const tab = tabsStore.getTab(tabId);
    const paneId = tab?.activePaneId ?? tab?.panes[0]?.id;
    if (paneId) tabsStore.setPaneTitle(tabId, paneId, title);
  }

  async function handleCloseTab(tabId: string) {
    const terminal = terminalRefs[tabId];
    const tab = tabsStore.getTab(tabId);
    const keyIds = transientManagedKeyIds(tab?.panes ?? []);
    if (terminal?.disconnect) {
      try {
        await terminal.disconnect();
      } catch (e) {
        console.error("Tab disconnect error:", e);
      }
    } else if (tab?.sessionId) {
      terminalModesStore.clearSession(tab.sessionId);
      try {
        await sshDisconnect(tab.sessionId);
      } catch (e) {
        console.error("Fallback tab disconnect error:", e);
      }
    }
    tabsStore.removeTab(tabId);
    await cleanupUnreferencedManagedKeys(keyIds);
    delete terminalRefs[tabId];
  }

  function getActiveTerminal() {
    const activeTabId = tabsStore.activeTabId;
    return activeTabId ? terminalRefs[activeTabId] : undefined;
  }

  async function handleToggleKeyboard() {
    const input = document.querySelector('.terminal-container.active textarea.hidden-input') as HTMLTextAreaElement | null;
    if (!input) return;

    if (keyboardVisible) {
      keyboardVisible = false;
      input.setAttribute('inputmode', 'none');
      try { await setKeyboardVisible(false); } catch {}
      syncAppToViewport();
      getActiveTerminal()?.focus();
    } else {
      keyboardVisible = true;
      getActiveTerminal()?.blur();
      await tick();
      input.setAttribute('inputmode', 'text');
      await tick();
      input.focus();
    }
  }
</script>

<div class="app" bind:this={appElement}>
  <div style:order={settingsStore.tabBarPosition === "bottom" ? 1 : 0}>
    <TabBar
      onAddTab={handleAddTab}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      onOpenSettings={handleOpenSettings}
    />
  </div>

  <main class="main-content" style:order="0">
    {#if tabsStore.tabs.length === 0}
      <ConnectionList
        onEdit={handleEdit}
        onNewConnection={handleNewConnection}
      />
    {:else if !sessionsReconciled}
      <div class="session-restore-loader">Checking session state...</div>
    {:else}
      {#each tabsStore.tabs as tab (tab.id)}
        <div
          class="terminal-container"
          class:active={tab.id === tabsStore.activeTabId}
        >
          {#key tab.panes[0]?.connection}
          <Terminal
            host={tab.host}
            port={tab.port}
            auth={tab.auth}
            existingSessionId={tab.sessionId}
            connectionId={tab.connectionId}
            startupScript={tab.startupScript}
            startupScriptReadyText={tab.startupScriptReadyText}
            interactive={!showConnectionList && !showDialog && !showSettings && tab.id === tabsStore.activeTabId}
            onConnected={(sessionId) => handleConnected(tab.id, sessionId)}
            onDisconnected={() => handleDisconnected(tab.id)}
            onRetryConnection={handleRetryConnection}
            onEditConnection={tab.panes[0]?.kind === "local"
              ? undefined
              : () => void handleEditFailedConnection(tab.id)}
            onCloseTab={() => void handleCloseTab(tab.id)}
            bind:this={terminalRefs[tab.id]}
            onTitleChange={(title) => handleTitleChanged(tab.id, title)}
          />
          {/key}
        </div>
      {/each}

      {#if showConnectionList}
        <div class="connection-list-overlay">
          <button
            type="button"
            class="connection-list-back"
            onclick={() => (showConnectionListManual = false)}
          >Back to terminal</button>
          <ConnectionList
            onEdit={handleEdit}
            onNewConnection={handleNewConnection}
          />
        </div>
      {/if}
    {/if}

    {#if showSettings}
      <SettingsScreen onClose={() => showSettings = false} />
    {/if}
  </main>

  {#if tabsStore.activeTab && !showConnectionList && !showDialog && !showSettings}
    <div style:order={settingsStore.tabBarPosition === "bottom" ? 2 : 2}>
      <ExtraKeysBar
        onToggleKeyboard={handleToggleKeyboard}
        voiceInputController={voiceInputController}
      />
    </div>
  {/if}

  <VoiceInputPopup controller={voiceInputController} />

  <ConnectionDialog
    open={showDialog}
    editConnection={editingConnection}
    editPane={editingPane}
    onClose={handleCloseDialog}
  />
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html, body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
      Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    overscroll-behavior: none;
  }

  .app {
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    height: 100vh;
    height: 100dvh;
    width: 100vw;
    overflow: hidden;
    overscroll-behavior: none;
    /* Safe area for notch/status bar */
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }

  .main-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
    isolation: isolate;
  }

  .terminal-container {
    position: absolute;
    inset: 0;
    display: none;
  }

  .terminal-container.active {
    display: block;
  }

  .connection-list-overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
  }

  .connection-list-back {
    align-self: flex-start;
    margin: 12px 16px 0;
    padding: 8px 12px;
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font: inherit;
  }

  .connection-list-overlay :global(.connection-list) {
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    background: var(--bg-primary);
  }

  .session-restore-loader {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    background: var(--bg-primary);
    z-index: 2;
  }
</style>
