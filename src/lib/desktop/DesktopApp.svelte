<script lang="ts">
  import { onMount, tick } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import ConnectionDialog from "$lib/components/ConnectionDialog.svelte";
  import { tabsStore, type Pane, type PaneNode } from "$lib/stores/tabs.svelte";
  import { connectionsStore } from "$lib/stores/connections.svelte";
  import {
    confirmAction,
    exitApplication,
    listenAppExitRequested,
    localShellDisconnect,
    showWarning,
    sshDisconnect,
    type SavedConnection,
  } from "$lib/tauri/commands";
  import {
    loadRuntimeInstanceId,
    resolveRecovery,
  } from "$lib/session/reconcile";
  import {
    cleanupUnreferencedManagedKeys,
    retryPendingManagedKeyCleanup,
    transientManagedKeyIds,
  } from "$lib/managed-key-lifecycle";
  import Terminal from "$lib/terminal/Terminal.svelte";
  import { handleDesktopShortcuts, isTerminalShortcutTarget } from "./shortcuts";
  import Sidebar from "./workspace/Sidebar.svelte";
  import PaneView from "./workspace/PaneView.svelte";
  import TabStrip from "./workspace/TabStrip.svelte";
  import SettingsModal from "./workspace/SettingsModal.svelte";
  import { desktopPrefsStore } from "./workspace/desktop-prefs.svelte";
  import {
    dragTargets,
    tabDrag,
    zoneFromPoint,
    type DropZone,
  } from "./workspace/drag-state.svelte";
  import { setWorkspaceApi, type WorkspaceApi } from "./workspace/workspace-context";

  let showDialog = $state(false);
  let settingsOpen = $state(false);
  let editingConnection = $state<SavedConnection | undefined>(undefined);
  let editingPane = $state<{ tabId: string; paneId: string } | undefined>(undefined);
  let runtimeInstanceId = $state<string | null>(null);
  let sessionsReconciled = $state(false);
  let workspaceEl: HTMLElement | null = $state(null);
  let editPaneRequestGeneration = 0;
  let connectionsViewRequest = $state(0);

  const terminals = new Map<string, Terminal>();
  const confirmingTabIds = new Set<string>();
  const confirmingPaneIds = new Set<string>();
  const closingTabIds = new Set<string>();
  const closingPaneIds = new Set<string>();

  function tabIsClosing(tabId: string): boolean {
    return (
      confirmingTabIds.has(tabId) ||
      closingTabIds.has(tabId) ||
      (tabsStore.getTab(tabId)?.panes.some((pane) =>
        confirmingPaneIds.has(pane.id) || closingPaneIds.has(pane.id)
      ) ?? false)
    );
  }

  function paneIsClosing(tabId: string, paneId: string): boolean {
    return confirmingPaneIds.has(paneId) || closingPaneIds.has(paneId) || tabIsClosing(tabId);
  }
  let windowCloseConfirmed = false;
  let windowCloseConfirmationPending = false;

  function paneShowsDocument(node: PaneNode, paneId: string): boolean {
    if (node.type === "leaf") {
      return node.paneIds.includes(paneId) && node.activeItem.kind === "document";
    }
    return (
      paneShowsDocument(node.children[0], paneId) ||
      paneShowsDocument(node.children[1], paneId)
    );
  }

  const sidebarColumn = $derived(
    desktopPrefsStore.prefs.sidebarCollapsed
      ? "0px"
      : `${desktopPrefsStore.prefs.sidebarWidth}px`
  );

  const activePane = $derived(tabsStore.getActivePane());
  const explorerKind = $derived<"ssh" | "local" | null>(
    activePane ? (activePane.kind ?? "ssh") : null
  );
  const activeSessionId = $derived(
    explorerKind === "local" ? null : (activePane?.sessionId ?? null)
  );
  const explorerId = $derived(activePane?.id ?? null);

  $effect(() => {
    dragTargets.workspace = workspaceEl;
    return () => {
      if (dragTargets.workspace === workspaceEl) {
        dragTargets.workspace = null;
      }
    };
  });

  // Keep keyboard focus on the focused pane's terminal. Tab clicks, pane
  // clicks, shortcuts, and overlay dismissal all funnel through here so the
  // focus never stays stranded on chrome (tab strip buttons, dialogs).
  $effect(() => {
    const tab = tabsStore.activeTab;
    const paneId = tab?.activePaneId ?? tab?.panes[0]?.id;
    const overlayFree =
      !showDialog && !settingsOpen && sessionsReconciled;
    if (
      !tab ||
      !paneId ||
      !overlayFree ||
      paneShowsDocument(tab.layout, paneId)
    ) return;

    void (async () => {
      // Let newly mounted panes register their terminal first.
      await tick();
      const currentPaneId =
        tabsStore.activeTab?.activePaneId ?? tabsStore.activeTab?.panes[0]?.id;
      if (currentPaneId !== paneId) return;
      terminals.get(paneId)?.focus();
    })();
  });

  onMount(() => {
    void reconcilePersistedSessions();
    void retryPendingManagedKeyCleanup();

    let disposed = false;
    let unlistenAppExitRequested: (() => void) | undefined;
    let unlistenCloseRequested: (() => void) | undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (windowCloseConfirmed) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    if ("__TAURI_INTERNALS__" in window) {
      void listenAppExitRequested(() => {
        void confirmAndCloseApplication(exitApplication);
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenAppExitRequested = unlisten;
        })
        .catch((error) => console.error("Application exit listener error:", error));

      void getCurrentWindow()
        .onCloseRequested((event) => {
          if (windowCloseConfirmed) return;
          event.preventDefault();
          void confirmAndCloseApplication(() => getCurrentWindow().destroy());
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenCloseRequested = unlisten;
        })
        .catch((error) => console.error("Window close listener error:", error));
    }

    return () => {
      disposed = true;
      unlistenAppExitRequested?.();
      unlistenCloseRequested?.();
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  });

  async function disconnectTerminal(paneId: string) {
    const terminal = terminals.get(paneId);
    const pane = tabsStore.tabs
      .flatMap((tab) => tab.panes)
      .find((candidate) => candidate.id === paneId);
    try {
      if (terminal?.disconnect) {
        await terminal.disconnect(pane?.sessionId ?? undefined);
      } else if (pane?.sessionId) {
        if (pane.kind === "local") await localShellDisconnect(pane.sessionId);
        else await sshDisconnect(pane.sessionId);
      }
    } catch (error) {
      console.error("Pane disconnect error:", error);
    }
  }

  function findPaneLocation(
    paneId: string
  ): { tabId: string; pane: Pane } | undefined {
    for (const tab of tabsStore.tabs) {
      const pane = tab.panes.find((candidate) => candidate.id === paneId);
      if (pane) return { tabId: tab.id, pane };
    }
    return undefined;
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
          let removedPane: Pane | null = null;
          await serializeLayoutSnapshotOperation(async () => {
            const current = findPaneLocation(pane.id);
            if (!current || current.pane.sessionId !== pane.sessionId) return;
            removedPane = await tabsStore.closePane(current.tabId, pane.id);
          });
          const keyIds = transientManagedKeyIds(removedPane ? [removedPane] : []);
          await cleanupUnreferencedManagedKeys(keyIds);
          continue;
        }
        await serializeLayoutSnapshotOperation(async () => {
          const current = findPaneLocation(pane.id);
          if (!current || current.pane.sessionId !== pane.sessionId) return;
          tabsStore.setPaneDisconnected(current.tabId, pane.id);
        });
      }
    }

    sessionsReconciled = true;
  }
  function handleNewConnection() {
    editPaneRequestGeneration += 1;
    editingConnection = undefined;
    editingPane = undefined;
    showDialog = true;
  }

  function handleEdit(connection: SavedConnection) {
    editPaneRequestGeneration += 1;
    editingConnection = connection;
    editingPane = undefined;
    showDialog = true;
  }

  async function handleEditPaneConnection(tabId: string, paneId: string) {
    if (paneIsClosing(tabId, paneId)) return;
    const requestGeneration = ++editPaneRequestGeneration;
    let pane = tabsStore.getPane(tabId, paneId);
    if (!pane || pane.kind === "local") return;
    if (pane.connection.connectionId && !connectionsStore.loaded) {
      const loaded = await connectionsStore.load();
      if (requestGeneration !== editPaneRequestGeneration) return;

      pane = tabsStore.getPane(tabId, paneId);
      if (!pane || pane.kind === "local") return;
      if (pane.connected || pane.sessionId) return;
      if (!loaded && !connectionsStore.loaded) {
        connectionsViewRequest += 1;
        if (desktopPrefsStore.prefs.sidebarCollapsed) {
          desktopPrefsStore.toggleSidebar();
        }
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

  function handleCloseDialog() {
    editPaneRequestGeneration += 1;
    showDialog = false;
    editingConnection = undefined;
    editingPane = undefined;
  }


  function handleOpenSettings() {
    editPaneRequestGeneration += 1;
    settingsOpen = true;
  }

  async function confirmAndCloseApplication(closeApplication: () => Promise<void>) {
    if (windowCloseConfirmed || windowCloseConfirmationPending) return;
    windowCloseConfirmationPending = true;
    try {
      if (!await confirmCloseApplication()) return;
      windowCloseConfirmed = true;
      await closeApplication();
    } catch (error) {
      windowCloseConfirmed = false;
      console.error("Application close error:", error);
    } finally {
      windowCloseConfirmationPending = false;
    }
  }

  async function confirmCloseApplication(): Promise<boolean> {
    const savingDocuments = tabsStore.tabs.flatMap((tab) =>
      tab.documents.filter((document) => document.saveState === "saving")
    );
    if (savingDocuments.length > 0) {
      const label =
        savingDocuments.length === 1
          ? `"${savingDocuments[0]!.name}"`
          : `${savingDocuments.length} documents`;
      await showWarning(`Please wait for ${label} to finish saving before closing RedTerm.`);
      return false;
    }
    const dirtyDocuments = tabsStore.tabs.flatMap((tab) =>
      tab.documents.filter((document) => document.dirty)
    );
    if (dirtyDocuments.length === 0) return confirmAction("Close RedTerm?");
    const label =
      dirtyDocuments.length === 1
        ? `"${dirtyDocuments[0]!.name}"`
        : `${dirtyDocuments.length} documents`;
    return confirmAction(
      `Discard unsaved changes in ${label} and close RedTerm?`
    );
  }

  async function confirmCloseDocuments(tabId: string, sourcePaneId?: string): Promise<boolean> {
    const documents = (tabsStore.getTab(tabId)?.documents ?? []).filter(
      (document) =>
        sourcePaneId === undefined || document.sourcePaneId === sourcePaneId
    );
    const savingDocuments = documents.filter(
      (document) => document.saveState === "saving"
    );
    if (savingDocuments.length > 0) {
      const label =
        savingDocuments.length === 1
          ? `"${savingDocuments[0]!.name}"`
          : `${savingDocuments.length} documents`;
      await showWarning(`Please wait for ${label} to finish saving before closing.`);
      return false;
    }
    const dirtyDocuments = documents.filter((document) => document.dirty);
    if (dirtyDocuments.length === 0) {
      return confirmAction(sourcePaneId === undefined ? "Close this tab?" : "Close this pane?");
    }
    const label =
      dirtyDocuments.length === 1
        ? `"${dirtyDocuments[0]!.name}"`
        : `${dirtyDocuments.length} documents`;
    return confirmAction(`Discard unsaved changes in ${label}?`);
  }
  async function closeTabById(tabId: string) {
    const tab = tabsStore.getTab(tabId);
    if (!tab || tabIsClosing(tabId)) return;
    confirmingTabIds.add(tabId);
    try {
      if (!await confirmCloseDocuments(tabId)) return;
    } finally {
      confirmingTabIds.delete(tabId);
    }
    const paneIds = tab.panes.map((pane) => pane.id);
    closingTabIds.add(tabId);
    for (const paneId of paneIds) closingPaneIds.add(paneId);
    try {
      tabsStore.closeDocuments(tabId);
      const removedPanes: Pane[] = [];
      await serializeLayoutSnapshotOperation(async () => {
        for (const paneId of paneIds) {
          await disconnectTerminal(paneId);
          const current = findPaneLocation(paneId);
          if (!current) continue;
          const removedPane = await tabsStore.closePane(current.tabId, paneId);
          if (removedPane) removedPanes.push(removedPane);
        }
      });
      await cleanupUnreferencedManagedKeys(
        transientManagedKeyIds(removedPanes)
      );
    } finally {
      closingTabIds.delete(tabId);
      for (const paneId of paneIds) closingPaneIds.delete(paneId);
    }
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

  function handleSelectTab(tabId: string) {
    editPaneRequestGeneration += 1;
    tabsStore.setActiveTab(tabId);
  }

  function cycleTab(delta: number) {
    const count = tabsStore.tabs.length;
    if (count < 2) return;
    const index = tabsStore.tabs.findIndex(
      (tab) => tab.id === tabsStore.activeTabId
    );
    const next = tabsStore.tabs[(index + delta + count) % count]!;
    handleSelectTab(next.id);
  }
  function selectTabByIndex(index: number) {
    const tab = tabsStore.tabs[index];
    if (tab) {
      handleSelectTab(tab.id);
    }
  }

  let layoutSnapshotOperation: Promise<void> = Promise.resolve();

  function serializeLayoutSnapshotOperation(operation: () => Promise<void>): Promise<void> {
    const next = layoutSnapshotOperation.then(operation, operation);
    layoutSnapshotOperation = next.catch(() => {});
    return next;
  }

  async function storeTabSnapshots(tabIds: string[]) {
    const paneIds = new Set(
      tabIds.flatMap((tabId) => tabsStore.getTab(tabId)?.panes.map((pane) => pane.id) ?? [])
    );
    await Promise.all(
      [...paneIds].map(
        (paneId) => terminals.get(paneId)?.storeSnapshot() ?? Promise.resolve()
      )
    );
  }

  async function splitPaneWithSnapshot(
    tabId: string,
    paneId: string,
    dir: "row" | "col"
  ): Promise<void> {
    if (paneIsClosing(tabId, paneId)) return;
    return serializeLayoutSnapshotOperation(async () => {
      await storeTabSnapshots([tabId]);
      if (paneIsClosing(tabId, paneId)) return;
      await tick();
      await tabsStore.splitPane(tabId, paneId, dir);
      for (const pane of tabsStore.getTab(tabId)?.panes ?? []) {
        terminals.get(pane.id)?.syncSize();
      }
    });
  }

  async function addPaneTabWithSnapshot(
    tabId: string,
    paneId: string
  ): Promise<void> {
    if (paneIsClosing(tabId, paneId)) return;
    return serializeLayoutSnapshotOperation(async () => {
      await storeTabSnapshots([tabId]);
      if (paneIsClosing(tabId, paneId)) return;
      await tick();
      await tabsStore.addPaneTab(tabId, paneId);
      for (const pane of tabsStore.getTab(tabId)?.panes ?? []) {
        terminals.get(pane.id)?.syncSize();
      }
    });
  }

  function splitActivePane(dir: "row" | "col") {
    const tab = tabsStore.activeTab;
    const paneId = tab?.activePaneId ?? tab?.panes[0]?.id;
    if (tab && paneId) {
      void splitPaneWithSnapshot(tab.id, paneId, dir);
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
    if (tabIsClosing(sourceTabId)) return;
    const targetTabId = tabsStore.activeTabId;
    if (!targetTabId || targetTabId === sourceTabId) return;
    if (tabIsClosing(targetTabId)) return;
    const source = tabsStore.getTab(sourceTabId);
    if (!source) return;

    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const side = zone === "left" || zone === "top" ? "before" : "after";
    if (tabIsClosing(sourceTabId) || tabIsClosing(targetTabId)) return;
    await serializeLayoutSnapshotOperation(async () => {
      await storeTabSnapshots([sourceTabId, targetTabId]);
      if (tabIsClosing(sourceTabId) || tabIsClosing(targetTabId)) return;
      await tick();
      await tabsStore.mergeTab(sourceTabId, targetTabId, dir, side);
      for (const pane of tabsStore.getTab(targetTabId)?.panes ?? []) {
        terminals.get(pane.id)?.syncSize();
      }
    });
  }

  async function handlePaneDrop(tabId: string, paneId: string) {
    if (paneIsClosing(tabId, paneId)) return;
    if (!workspaceEl) return;
    const hit = document.elementFromPoint(
      tabDrag.pointerX,
      tabDrag.pointerY
    )?.closest<HTMLElement>("[data-pane-id]");
    const targetPaneId = hit?.dataset.paneId;
    if (!targetPaneId || targetPaneId === paneId) return;
    if (paneIsClosing(tabId, targetPaneId)) return;

    // Direction comes from the hovered pane's own rect so the split happens
    // where the pointer actually is, not relative to the whole workspace.
    const zone =
      zoneFromPoint(hit!.getBoundingClientRect(), tabDrag.pointerX, tabDrag.pointerY) ??
      tabDrag.dropZone;
    if (!zone) return;

    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const side = zone === "left" || zone === "top" ? "before" : "after";

    await serializeLayoutSnapshotOperation(async () => {
      await storeTabSnapshots([tabId]);
      await tick();
      if (paneIsClosing(tabId, paneId) || paneIsClosing(tabId, targetPaneId)) return;
      await tabsStore.movePaneWithinTab(tabId, paneId, targetPaneId, dir, side);
      for (const pane of tabsStore.getTab(tabId)?.panes ?? []) {
        terminals.get(pane.id)?.syncSize();
      }
    });
  }

  const workspaceApi: WorkspaceApi = {
    registerTerminal(paneId, terminal) {
      terminals.set(paneId, terminal as Terminal);
    },
    unregisterTerminal(paneId, terminal) {
      if (terminals.get(paneId) === terminal) {
        terminals.delete(paneId);
      }
    },
    paneConnected(tabId, paneId, sessionId) {
      editPaneRequestGeneration += 1;
      tabsStore.setPaneConnected(tabId, paneId, sessionId, runtimeInstanceId);
    },
    paneDisconnected(tabId, paneId) {
      tabsStore.setPaneDisconnected(tabId, paneId);
    },
    paneRetrying() {
      editPaneRequestGeneration += 1;
    },
    editPaneConnection(tabId, paneId) {
      void handleEditPaneConnection(tabId, paneId);
    },
    closeTab(tabId) {
      void closeTabById(tabId);
    },
    closePane(_tabId, paneId) {
      if (paneIsClosing(_tabId, paneId)) return;
      confirmingPaneIds.add(paneId);
      void (async () => {
        try {
          if (!await confirmCloseDocuments(_tabId, paneId)) return;
          closingPaneIds.add(paneId);
          tabsStore.closeDocuments(_tabId, paneId);
          await serializeLayoutSnapshotOperation(async () => {
            const initial = findPaneLocation(paneId);
            if (!initial) return;
            await storeTabSnapshots([initial.tabId]);
            await disconnectTerminal(paneId);
            const current = findPaneLocation(paneId);
            if (!current) return;
            const removedPane = await tabsStore.closePane(current.tabId, paneId);
            const keyIds = transientManagedKeyIds(removedPane ? [removedPane] : []);
            await cleanupUnreferencedManagedKeys(keyIds);
            await tick();
            for (const pane of tabsStore.getTab(current.tabId)?.panes ?? []) {
              terminals.get(pane.id)?.syncSize();
            }
          });
        } finally {
          confirmingPaneIds.delete(paneId);
          closingPaneIds.delete(paneId);
        }
      })();
    },
    splitPane(tabId, paneId, dir) {
      void splitPaneWithSnapshot(tabId, paneId, dir);
    },
    addPaneTab(tabId, paneId) {
      void addPaneTabWithSnapshot(tabId, paneId);
    },
    activatePane(tabId, paneId) {
      void tabsStore.setActivePane(tabId, paneId).then(() => {
        terminals.get(paneId)?.syncSize();
      });
    },
    activateDocument(tabId, documentId) {
      void tabsStore.setActiveDocument(tabId, documentId);
    },
    paneDragDropped(tabId, paneId) {
      void handlePaneDrop(tabId, paneId);
    },
  };
  setWorkspaceApi(workspaceApi);

  function activeTerminal(): Terminal | null {
    const tab = tabsStore.activeTab;
    const paneId = tab?.activePaneId ?? tab?.panes[0]?.id;
    if (!tab || !paneId || paneShowsDocument(tab.layout, paneId)) return null;
    return terminals.get(paneId) ?? null;
  }

  function copyActiveSelection() {
    activeTerminal()?.copySelection();
  }

  function pasteFromClipboardToActivePane() {
    const terminal = activeTerminal();
    if (terminal) void terminal.pasteFromClipboard();
  }

  function onKeydownCapture(event: KeyboardEvent) {
    const terminalTarget = isTerminalShortcutTarget(
      event.target,
      activeTerminal()?.hasSelection() ?? false,
    );
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
        copySelection: copyActiveSelection,
        pasteFromClipboard: () => void pasteFromClipboardToActivePane(),
        openSettings: handleOpenSettings,
      },
      () => !showDialog && !settingsOpen && sessionsReconciled,
      terminalTarget
    );
    if (consumed) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
</script>

<svelte:window
  onkeydowncapture={onKeydownCapture}
  onpagehide={() => desktopPrefsStore.flushPendingPersist()}
/>

<svelte:head>
  <title>RedTerm Desktop</title>
</svelte:head>

<div
  class="desktop-app"
  style:grid-template-columns="{sidebarColumn} minmax(0, 1fr)"
>
  <Sidebar
    width={desktopPrefsStore.prefs.sidebarWidth}
    collapsed={desktopPrefsStore.prefs.sidebarCollapsed}
    activeSessionId={activeSessionId}
    explorerKind={explorerKind}
    explorerId={explorerId}
    connectionsViewRequest={connectionsViewRequest}
    onWidthChange={(width) => desktopPrefsStore.setSidebarWidth(width)}
    onEdit={handleEdit}
    onNewConnection={handleNewConnection}
    onOpenLocal={() => void tabsStore.addLocalTab()}
    onPreview={(entry) => {
      const tab = tabsStore.activeTab;
      const paneId = tab?.activePaneId ?? tab?.panes[0]?.id;
      if (tab && paneId && !paneIsClosing(tab.id, paneId)) {
        void tabsStore.openDocument(tab.id, paneId, entry);
      }
    }}
  />

  <section class="workspace">
    <TabStrip
      onSelectTab={handleSelectTab}
      onCloseTab={(tabId) => void closeTabById(tabId)}
      onOpenSettings={handleOpenSettings}
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
          <div class="empty-actions">
            <button class="empty-action" onclick={handleNewConnection}>
              New connection
            </button>
            <button class="empty-action secondary" onclick={() => void tabsStore.addLocalTab()}>
              Open local shell
            </button>
          </div>
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
              interactive={
                !showDialog &&
                !settingsOpen &&
                tab.id === tabsStore.activeTabId}
              activePaneId={tab.activePaneId}
            />
          </div>
        {/each}

        {#if tabDrag.active && tabDrag.dropZone && tabDrag.kind === "tab" && tabDrag.tabId !== tabsStore.activeTabId}
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
    editPane={editingPane}
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
    /* Pin the row height so tall sidebar content (file list) scrolls
       inside its own flex column instead of growing the row. */
    grid-template-rows: minmax(0, 1fr);
    min-width: 760px;
    min-height: 520px;
    overflow: hidden;
    background: var(--bg-primary);
    /* Widen the shared ConnectionDialog for desktop. */
    --dialog-max-width: 560px;
  }

  .workspace {
    grid-column: 2;
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
    text-wrap: balance;
  }

  .empty-copy {
    max-width: 480px;
    margin: 18px 0 30px;
    color: var(--text-secondary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.65;
    text-wrap: pretty;
  }

  .empty-actions {
    display: flex;
    align-items: center;
    gap: 12px;
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
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .empty-action:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .empty-action.secondary {
    background: transparent;
    color: var(--accent-primary);
  }

  .empty-action.secondary:hover {
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
    color: var(--accent-hover);
  }

  .session-restore-loader {
    align-items: center;
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
