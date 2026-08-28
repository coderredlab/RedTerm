<script lang="ts">
  import { onMount, tick } from "svelte";
  import ConnectionDialog from "$lib/components/ConnectionDialog.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import type { SavedConnection } from "$lib/tauri/commands";
  import {
    loadRuntimeInstanceId,
    resolveRecovery,
  } from "$lib/session/reconcile";
  import Terminal from "$lib/terminal/Terminal.svelte";
  import { handleDesktopShortcuts } from "./shortcuts";
  import Sidebar from "./workspace/Sidebar.svelte";
  import PaneView from "./workspace/PaneView.svelte";
  import TabStrip from "./workspace/TabStrip.svelte";
  import SettingsModal from "./workspace/SettingsModal.svelte";
  import { desktopPrefsStore } from "./workspace/desktop-prefs.svelte";
  import {
    dragTargets,
    tabDrag,
    type DropZone,
  } from "./workspace/drag-state.svelte";
  import { setWorkspaceApi, type WorkspaceApi } from "./workspace/workspace-context";

  let showDialog = $state(false);
  let settingsOpen = $state(false);
  let editingConnection = $state<SavedConnection | undefined>(undefined);
  let runtimeInstanceId = $state<string | null>(null);
  let sessionsReconciled = $state(false);
  let workspaceEl: HTMLElement | null = $state(null);

  const terminals = new Map<string, Terminal>();

  const sidebarColumn = $derived(
    desktopPrefsStore.prefs.sidebarCollapsed
      ? "48px"
      : `${desktopPrefsStore.prefs.sidebarWidth}px`
  );

  $effect(() => {
    dragTargets.workspace = workspaceEl;
    return () => {
      if (dragTargets.workspace === workspaceEl) {
        dragTargets.workspace = null;
      }
    };
  });

  onMount(() => {
    void reconcilePersistedSessions();
  });

  async function disconnectTerminal(paneId: string) {
    const terminal = terminals.get(paneId);
    if (!terminal?.disconnect) return;
    try {
      await terminal.disconnect();
    } catch (error) {
      console.error("Pane disconnect error:", error);
    }
  }

  async function reconcilePersistedSessions() {
    runtimeInstanceId = await loadRuntimeInstanceId();
    if (runtimeInstanceId === null) {
      sessionsReconciled = true;
      return;
    }

    for (const tab of [...tabsStore.tabs]) {
      for (const pane of [...tab.panes]) {
        const verdict = await resolveRecovery(
          {
            sessionId: pane.sessionId,
            runtimeInstanceId: pane.runtimeInstanceId,
            auth: pane.connection.auth,
            canRestorePassword: pane.connection.canRestorePassword,
          },
          runtimeInstanceId
        );
        if (verdict === "keep") continue;
        if (verdict === "remove") {
          tabsStore.closePane(tab.id, pane.id);
          continue;
        }
        tabsStore.setPaneDisconnected(tab.id, pane.id);
      }
    }

    sessionsReconciled = true;
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

  async function closeTabById(tabId: string) {
    const tab = tabsStore.getTab(tabId);
    if (!tab) return;
    for (const pane of tab.panes) {
      await disconnectTerminal(pane.id);
    }
    tabsStore.removeTab(tabId);
  }

  function closeActivePane() {
    const tab = tabsStore.activeTab;
    if (!tab) return;
    const paneId = tab.activePaneId ?? tab.panes[0]?.id;
    if (paneId) void workspaceApi.closePane(tab.id, paneId);
  }

  function closeActiveTab() {
    const tabId = tabsStore.activeTabId;
    if (tabId) void closeTabById(tabId);
  }

  function cycleTab(delta: number) {
    const count = tabsStore.tabs.length;
    if (count < 2) return;
    const index = tabsStore.tabs.findIndex(
      (tab) => tab.id === tabsStore.activeTabId
    );
    const next = tabsStore.tabs[(index + delta + count) % count]!;
    tabsStore.setActiveTab(next.id);
  }

  function selectTabByIndex(index: number) {
    const tab = tabsStore.tabs[index];
    if (tab) {
      tabsStore.setActiveTab(tab.id);
    }
  }

  function splitActivePane(dir: "row" | "col") {
    const tab = tabsStore.activeTab;
    const paneId = tab?.activePaneId ?? tab?.panes[0]?.id;
    if (tab && paneId) {
      tabsStore.splitPane(tab.id, paneId, dir);
    }
  }

  function moveFocus(direction: "left" | "right" | "up" | "down") {
    const tab = tabsStore.activeTab;
    const activePaneId = tab?.activePaneId;
    if (!tab || !activePaneId || !workspaceEl) return;
    const container = workspaceEl.querySelector(".tab-container.active");
    if (!container) return;

    const current = container.querySelector<HTMLElement>(
      `[data-pane-id="${activePaneId}"]`
    );
    if (!current) return;
    const cur = current.getBoundingClientRect();
    const curCX = cur.left + cur.width / 2;
    const curCY = cur.top + cur.height / 2;

    let bestId: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    container.querySelectorAll<HTMLElement>("[data-pane-id]").forEach((el) => {
      const id = el.dataset.paneId;
      if (!id || id === activePaneId) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (direction === "left" && cx >= curCX) return;
      if (direction === "right" && cx <= curCX) return;
      if (direction === "up" && cy >= curCY) return;
      if (direction === "down" && cy <= curCY) return;

      const gapX =
        direction === "left"
          ? cur.left - rect.right
          : direction === "right"
            ? rect.left - cur.right
            : 0;
      const gapY =
        direction === "up"
          ? cur.top - rect.bottom
          : direction === "down"
            ? rect.top - cur.bottom
            : 0;
      const primary = Math.max(gapX, gapY);
      const cross =
        direction === "left" || direction === "right"
          ? Math.abs(cy - curCY)
          : Math.abs(cx - curCX);
      const score = primary + cross * 0.01;
      if (score < bestScore) {
        bestScore = score;
        bestId = id;
      }
    });

    if (bestId) {
      tabsStore.setActivePane(tab.id, bestId);
    }
  }

  async function handleTabDropIntoWorkspace(
    sourceTabId: string,
    zone: DropZone
  ) {
    const targetTabId = tabsStore.activeTabId;
    if (!targetTabId || targetTabId === sourceTabId) return;
    const source = tabsStore.getTab(sourceTabId);
    if (!source) return;

    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const side = zone === "left" || zone === "top" ? "before" : "after";

    const movedPaneIds = source.panes.map((pane) => pane.id);
    for (const paneId of movedPaneIds) {
      tabsStore.setPreserveSessionOnMove(sourceTabId, paneId, true);
    }
    await tick();
    tabsStore.mergeTab(sourceTabId, targetTabId, dir, side);
    await tick();
    for (const paneId of movedPaneIds) {
      tabsStore.setPreserveSessionOnMove(targetTabId, paneId, false);
    }
  }

  async function handlePaneDrop(tabId: string, paneId: string) {
    const zone = tabDrag.dropZone;
    if (!zone || !workspaceEl) return;
    const hit = document.elementFromPoint(
      tabDrag.pointerX,
      tabDrag.pointerY
    )?.closest<HTMLElement>("[data-pane-id]");
    const targetPaneId = hit?.dataset.paneId;
    if (!targetPaneId || targetPaneId === paneId) return;

    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const side = zone === "left" || zone === "top" ? "before" : "after";

    tabsStore.setPreserveSessionOnMove(tabId, paneId, true);
    await tick();
    tabsStore.movePaneWithinTab(tabId, paneId, targetPaneId, dir, side);
    await tick();
    tabsStore.setPreserveSessionOnMove(tabId, paneId, false);
  }

  const workspaceApi: WorkspaceApi = {
    registerTerminal(paneId, terminal) {
      terminals.set(paneId, terminal as Terminal);
    },
    unregisterTerminal(paneId) {
      terminals.delete(paneId);
    },
    paneConnected(tabId, paneId, sessionId) {
      tabsStore.setPaneConnected(tabId, paneId, sessionId, runtimeInstanceId);
    },
    paneDisconnected(tabId, paneId) {
      tabsStore.setPaneDisconnected(tabId, paneId);
    },
    closePane(tabId, paneId) {
      void (async () => {
        await disconnectTerminal(paneId);
        tabsStore.closePane(tabId, paneId);
      })();
    },
    splitPane(tabId, paneId, dir) {
      tabsStore.splitPane(tabId, paneId, dir);
    },
    activatePane(tabId, paneId) {
      tabsStore.setActivePane(tabId, paneId);
    },
    paneDragDropped(tabId, paneId) {
      void handlePaneDrop(tabId, paneId);
    },
  };
  setWorkspaceApi(workspaceApi);

  function onKeydownCapture(event: KeyboardEvent) {
    const consumed = handleDesktopShortcuts(
      event,
      {
        newConnection: handleNewConnection,
        closePane: closeActivePane,
        closeTab: closeActiveTab,
        nextTab: () => cycleTab(1),
        previousTab: () => cycleTab(-1),
        selectTab: selectTabByIndex,
        splitRight: () => splitActivePane("row"),
        splitDown: () => splitActivePane("col"),
        moveFocus,
        openSettings: () => {
          settingsOpen = true;
        },
      },
      () => !showDialog && !settingsOpen && sessionsReconciled
    );
    if (consumed) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
</script>

<svelte:window onkeydowncapture={onKeydownCapture} />

<svelte:head>
  <title>RedTerm Desktop</title>
</svelte:head>

<div
  class="desktop-app"
  style:grid-template-columns="{sidebarColumn} minmax(0, 1fr)"
>
  <Sidebar
    collapsed={desktopPrefsStore.prefs.sidebarCollapsed}
    width={desktopPrefsStore.prefs.sidebarWidth}
    onToggleCollapsed={() => desktopPrefsStore.toggleSidebar()}
    onWidthChange={(width) => desktopPrefsStore.setSidebarWidth(width)}
    onEdit={handleEdit}
    onNewConnection={handleNewConnection}
  />

  <section class="workspace">
    <TabStrip
      onNewConnection={handleNewConnection}
      onCloseTab={(tabId) => void closeTabById(tabId)}
      onOpenSettings={() => {
        settingsOpen = true;
      }}
      onToggleSidebar={() => desktopPrefsStore.toggleSidebar()}
      sidebarCollapsed={desktopPrefsStore.prefs.sidebarCollapsed}
      onDropToWorkspace={(sourceTabId, zone) =>
        void handleTabDropIntoWorkspace(sourceTabId, zone)}
    />

    <main class="terminal-workspace" bind:this={workspaceEl}>
      {#if tabsStore.tabs.length === 0}
        <div class="empty-workspace">
          <div class="empty-rule"></div>
          <p class="empty-kicker">REMOTE WORKSPACE</p>
          <h1>Start with a server.</h1>
          <p class="empty-copy">
            Choose a saved connection from the left, or add a new SSH connection.
            Drag tabs onto the workspace to split the view across servers.
          </p>
          <button class="empty-action" onclick={handleNewConnection}>
            New connection
          </button>
        </div>
      {:else if !sessionsReconciled}
        <div class="session-restore-loader">Checking session state…</div>
      {:else}
        {#each tabsStore.tabs as tab (tab.id)}
          <div
            class="tab-container"
            class:active={tab.id === tabsStore.activeTabId}
          >
            <PaneView
              tabId={tab.id}
              node={tab.layout}
              interactive={!showDialog &&
                !settingsOpen &&
                tab.id === tabsStore.activeTabId}
              activePaneId={tab.activePaneId}
            />
          </div>
        {/each}

        {#if tabDrag.active && tabDrag.dropZone}
          <div class="drop-overlay" aria-hidden="true">
            <div class="drop-zone" class:lit={tabDrag.dropZone === "left"}></div>
            <div class="drop-zone" class:lit={tabDrag.dropZone === "right"}></div>
            <div class="drop-zone" class:lit={tabDrag.dropZone === "top"}></div>
            <div class="drop-zone" class:lit={tabDrag.dropZone === "bottom"}></div>
          </div>
        {/if}
      {/if}
    </main>
  </section>

  <ConnectionDialog
    open={showDialog}
    editConnection={editingConnection}
    onClose={handleCloseDialog}
  />

  <SettingsModal open={settingsOpen} onClose={() => (settingsOpen = false)} />

  {#if tabDrag.active}
    <div
      class="drag-ghost"
      style:left="{tabDrag.pointerX + 14}px"
      style:top="{tabDrag.pointerY + 12}px"
    >
      {tabDrag.title}
    </div>
  {/if}
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
    /* Widen the shared ConnectionDialog for desktop. */
    --dialog-max-width: 560px;
  }

  .workspace {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--terminal-bg);
  }

  .terminal-workspace {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .tab-container {
    position: absolute;
    inset: 0;
    display: none;
  }

  .tab-container.active {
    display: block;
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;
  }

  .drop-zone {
    position: absolute;
    background: color-mix(in srgb, var(--accent-primary) 6%, transparent);
    opacity: 0;
    transition: opacity 80ms ease;
  }

  .drop-zone:nth-child(1) {
    left: 0;
    top: 0;
    width: 50%;
    height: 100%;
  }

  .drop-zone:nth-child(2) {
    right: 0;
    top: 0;
    width: 50%;
    height: 100%;
  }

  .drop-zone:nth-child(3) {
    left: 0;
    top: 0;
    width: 100%;
    height: 50%;
  }

  .drop-zone:nth-child(4) {
    left: 0;
    bottom: 0;
    width: 100%;
    height: 50%;
  }

  .drop-zone.lit {
    opacity: 1;
    border: 2px solid var(--accent-primary);
  }

  .drag-ghost {
    position: fixed;
    z-index: 100;
    max-width: 220px;
    padding: 5px 12px;
    border: 1px solid var(--accent-primary);
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
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
