<script lang="ts">
  import Terminal from "$lib/terminal/Terminal.svelte";
  import {
    tabsStore,
    type PaneDocument,
    type PaneNode,
  } from "$lib/stores/tabs.svelte";
  import {
    dragTargets,
    resetTabDrag,
    tabDrag,
    zoneFromPoint,
  } from "./drag-state.svelte";
  import { getWorkspaceApi } from "./workspace-context";
  import Self from "./PaneView.svelte";

  interface Props {
    tabId: string;
    node: PaneNode;
    /** True when this tab is the active tab and no overlay is open. */
    interactive: boolean;
    activePaneId: string | null;
  }

  let { tabId, node, interactive, activePaneId }: Props = $props();

  const workspace = getWorkspaceApi();
  let splitEl: HTMLDivElement | null = $state(null);
  let liveRatio = $state(0.5);
  let terminalRefs = $state<Record<string, Terminal | undefined>>({});
  let resizePointerId: number | null = null;

  $effect(() => {
    if (node.type === "split") {
      liveRatio = node.ratio;
    }
  });

  $effect(() => {
    if (node.type !== "leaf") return;
    const registered = node.paneIds.flatMap((paneId) => {
      const terminal = terminalRefs[paneId];
      return terminal ? [{ paneId, terminal }] : [];
    });
    for (const { paneId, terminal } of registered) {
      workspace.registerTerminal(paneId, terminal);
    }
    return () => {
      for (const { paneId, terminal } of registered) {
        workspace.unregisterTerminal(paneId, terminal);
      }
    };
  });

  function startResize(event: PointerEvent) {
    const divider = event.currentTarget as HTMLElement | null;
    if (
      node.type !== "split" ||
      !splitEl ||
      event.button !== 0 ||
      !divider ||
      resizePointerId !== null
    ) return;

    event.preventDefault();
    const rect = splitEl.getBoundingClientRect();
    const dividerSize = node.dir === "row" ? divider.offsetWidth : divider.offsetHeight;
    const availableSize = Math.max(
      1,
      (node.dir === "row" ? rect.width : rect.height) - dividerSize,
    );
    liveRatio = node.ratio;

    let settled = false;
    const capturedPointerId = event.pointerId;
    resizePointerId = capturedPointerId;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== capturedPointerId) return;
      const offset =
        node.dir === "row"
          ? moveEvent.clientX - rect.left - dividerSize / 2
          : moveEvent.clientY - rect.top - dividerSize / 2;
      liveRatio = Math.min(0.9, Math.max(0.1, offset / availableSize));
    };
    const teardown = (commit: boolean) => {
      if (settled) return;
      settled = true;
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", cancel);
      window.removeEventListener("pointerup", windowUp, true);
      window.removeEventListener("pointercancel", windowCancel, true);
      if (divider.hasPointerCapture(capturedPointerId)) {
        divider.releasePointerCapture(capturedPointerId);
      }
      resizePointerId = null;
      tabsStore.updateSplitRatio(tabId, node.id, commit ? liveRatio : node.ratio);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId === capturedPointerId) teardown(true);
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === capturedPointerId) teardown(false);
    };
    const windowUp = (upEvent: PointerEvent) => finish(upEvent);
    const windowCancel = (cancelEvent: PointerEvent) => cancel(cancelEvent);

    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", cancel);
    window.addEventListener("pointerup", windowUp, true);
    window.addEventListener("pointercancel", windowCancel, true);
    divider.setPointerCapture(capturedPointerId);
  }

  function startPaneDrag(event: PointerEvent, paneId: string, title: string) {
    const header = event.currentTarget as HTMLElement | null;
    if (event.button !== 0 || !header) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let armed = false;
    let settled = false;
    const capturedPointerId = event.pointerId;
    const windowUp = (e: PointerEvent) => {
      if (e.pointerId !== capturedPointerId) return;
      finish(true);
    };
    const windowCancel = (e: PointerEvent) => {
      if (e.pointerId !== capturedPointerId) return;
      finish(false);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (
        !armed &&
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5
      ) {
        return;
      }
      armed = true;
      tabDrag.active = true;
      tabDrag.kind = "pane";
      tabDrag.tabId = tabId;
      tabDrag.paneId = paneId;
      tabDrag.title = title;
      tabDrag.pointerX = moveEvent.clientX;
      tabDrag.pointerY = moveEvent.clientY;
      const rect = dragTargets.workspace?.getBoundingClientRect();
      tabDrag.dropZone = rect
        ? zoneFromPoint(rect, moveEvent.clientX, moveEvent.clientY)
        : null;
    };
    const finish = (drop: boolean) => {
      if (settled) return;
      settled = true;
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", finishUp);
      header.removeEventListener("pointercancel", cancel);
      // Window-level backstop in case the header unmounts mid-gesture.
      window.removeEventListener("pointerup", windowUp, true);
      window.removeEventListener("pointercancel", windowCancel, true);
      if (armed && drop) {
        workspace.paneDragDropped(tabId, paneId);
      }
      resetTabDrag();
    };
    const finishUp = () => finish(true);
    const cancel = () => finish(false);
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", finishUp);
    header.addEventListener("pointercancel", cancel);
    window.addEventListener("pointerup", windowUp, true);
    window.addEventListener("pointercancel", windowCancel, true);
    header.setPointerCapture(event.pointerId);
  }

  function closeDocument(document: PaneDocument) {
    if (document.saveState === "saving") {
      window.alert(`Please wait for "${document.name}" to finish saving before closing it.`);
      return;
    }
    if (
      document.dirty &&
      !window.confirm(`Discard unsaved changes to "${document.name}"?`)
    ) {
      return;
    }
    void tabsStore.closeDocument(tabId, document.id);
  }
</script>

{#if node.type === "split"}
  <div
    class="split"
    class:row={node.dir === "row"}
    class:col={node.dir === "col"}
    bind:this={splitEl}
  >
    <div class="split-child" style:flex-grow={liveRatio}>
      <Self {tabId} node={node.children[0]} {interactive} {activePaneId} />
    </div>
    <div
      class="divider"
      class:row={node.dir === "row"}
      class:col={node.dir === "col"}
      role="separator"
      aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
      onpointerdown={startResize}
    ></div>
    <div class="split-child" style:flex-grow={1 - liveRatio}>
      <Self {tabId} node={node.children[1]} {interactive} {activePaneId} />
    </div>
  </div>
{:else}
  {@const pane = tabsStore.getPane(tabId, node.paneId)}
  {@const focused = interactive && activePaneId === node.paneId}
  {#if pane}
      <section
        class="pane"
        class:focused
        data-pane-id={node.paneId}
      >
        <header class="pane-header">
          <div class="pane-tabs" role="tablist" aria-label="Pane tabs">
            {#each node.paneIds as paneId}
              {@const tabPane = tabsStore.getPane(tabId, paneId)}
              {#if tabPane}
                <div
                  class="terminal-tab"
                  class:active={node.activeItem.kind === "terminal" && node.activeItem.id === paneId}
                >
                  <button
                    class="terminal-tab-main"
                    role="tab"
                    aria-selected={node.activeItem.kind === "terminal" && node.activeItem.id === paneId}
                    title={tabPane.title}
                    onpointerdown={(event) => startPaneDrag(event, paneId, tabPane.title)}
                    onclick={() => workspace.activatePane(tabId, paneId)}
                  >
                    <span
                      class="pane-state"
                      class:connected={tabPane.connected}
                      aria-hidden="true"
                    ></span>
                    <span class="pane-title">{tabPane.title}</span>
                  </button>
                  <button
                    class="terminal-tab-close"
                    title="Close terminal tab"
                    aria-label={`Close ${tabPane.title}`}
                    onpointerdown={(event) => event.stopPropagation()}
                    onclick={() => workspace.closePane(tabId, paneId)}
                  >×</button>
                </div>
              {/if}
            {/each}
            {#each node.documentIds as documentId}
              {@const document = tabsStore.getDocument(tabId, documentId)}
              {#if document}
                <div
                  class="terminal-tab document-tab"
                  class:active={node.activeItem.kind === "document" && node.activeItem.id === documentId}
                >
                  <button
                    class="terminal-tab-main"
                    role="tab"
                    aria-selected={node.activeItem.kind === "document" && node.activeItem.id === documentId}
                    title={document.path}
                    onclick={() => workspace.activateDocument(tabId, documentId)}
                  >
                    <span class="document-icon" aria-hidden="true">F</span>
                    <span class="pane-title">{document.name}</span>
                    {#if document.dirty}
                      <span class="dirty-indicator" aria-label="Unsaved changes"></span>
                    {/if}
                  </button>
                  <button
                    class="terminal-tab-close"
                    title="Close document tab"
                    aria-label={`Close ${document.name}`}
                    disabled={document.saveState === "saving"}
                    onclick={() => closeDocument(document)}
                  >×</button>
                </div>
              {/if}
            {/each}
          </div>
          <div class="pane-tools">
            <button
              class="pane-action"
              title="New terminal tab"
              aria-label="New terminal tab"
              onclick={() => workspace.addPaneTab(tabId, node.paneId)}
            >+</button>
            <button
              class="pane-action"
              title="Split right"
              aria-label="Split right"
              onclick={() => workspace.splitPane(tabId, node.paneId, "row")}
            >
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <rect x="1" y="2" width="12" height="10" rx="1" />
                <line x1="7" y1="2" x2="7" y2="12" />
              </svg>
            </button>
            <button
              class="pane-action"
              title="Split down"
              aria-label="Split down"
              onclick={() => workspace.splitPane(tabId, node.paneId, "col")}
            >
              <svg viewBox="0 0 14 14" aria-hidden="true">
                <rect x="1" y="2" width="12" height="10" rx="1" />
                <line x1="1" y1="7" x2="13" y2="7" />
              </svg>
            </button>
          </div>
        </header>
        <div class="pane-content">
          {#each node.paneIds as terminalPaneId (terminalPaneId)}
            {@const terminalPane = tabsStore.getPane(tabId, terminalPaneId)}
            {#if terminalPane}
              <div
                class="pane-terminal"
                class:active={node.activeItem.kind === "terminal" && node.activeItem.id === terminalPaneId}
                aria-hidden={node.activeItem.kind !== "terminal" || node.activeItem.id !== terminalPaneId}
                onpointerdowncapture={() => workspace.activatePane(tabId, terminalPaneId)}
              >
                {#key terminalPane.connection}
                  <Terminal
                    host={terminalPane.connection.host}
                    port={terminalPane.connection.port}
                    auth={terminalPane.connection.auth}
                    existingSessionId={terminalPane.sessionId}
                    connectionId={terminalPane.connection.connectionId}
                    startupScript={terminalPane.connection.startupScript}
                    startupScriptReadyText={terminalPane.connection.startupScriptReadyText}
                    interactive={focused && node.activeItem.kind === "terminal" && node.activeItem.id === terminalPaneId}
                    refocusOnBlur={focused && node.activeItem.kind === "terminal" && node.activeItem.id === terminalPaneId}
                    disconnectOnDestroy={!terminalPane.preserveSessionOnMove}
                    kind={terminalPane.kind ?? "ssh"}
                    onConnected={(sessionId) =>
                      workspace.paneConnected(tabId, terminalPaneId, sessionId)}
                    onRetryConnection={() => workspace.paneRetrying(tabId, terminalPaneId)}
                    onEditConnection={terminalPane.kind === "local"
                      ? undefined
                      : () => workspace.editPaneConnection(tabId, terminalPaneId)}
                    onCloseTab={() => workspace.closePane(tabId, terminalPaneId)}
                    onDisconnected={() => workspace.paneDisconnected(tabId, terminalPaneId)}
                    bind:this={terminalRefs[terminalPaneId]}
                    onTitleChange={(title) => tabsStore.setPaneTitle(tabId, terminalPaneId, title)}
                  />
                {/key}
              </div>
            {/if}
          {/each}
          {#if node.activeItem.kind === "document"}
            {@const activeDocument = tabsStore.getDocument(tabId, node.activeItem.id)}
            {#if activeDocument}
              <div
                class="pane-document"
                onpointerdowncapture={() => {
                  if (!focused) workspace.activateDocument(tabId, activeDocument.id);
                }}
                onfocusin={() => {
                  if (!focused) workspace.activateDocument(tabId, activeDocument.id);
                }}
              >
                {#await import("./PaneDocumentView.svelte") then { default: PaneDocumentView }}
                  {#key activeDocument.id}
                    <PaneDocumentView
                      {tabId}
                      document={activeDocument}
                      active={focused}
                    />
                  {/key}
                {/await}
              </div>
            {/if}
          {/if}
        </div>
      </section>
  {/if}
{/if}

<style>
  .split {
    display: flex;
    min-height: 0;
    min-width: 0;
    width: 100%;
    height: 100%;
  }

  .split.row {
    flex-direction: row;
  }

  .split.col {
    flex-direction: column;
  }

  .split-child {
    flex-basis: 0;
    flex-shrink: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .divider {
    flex: 0 0 auto;
    background: var(--border-primary);
    z-index: 2;
  }

  .divider.row {
    width: 4px;
    cursor: col-resize;
  }

  .divider.col {
    height: 4px;
    cursor: row-resize;
  }

  .divider:hover,
  .divider:active {
    background: var(--accent-primary);
  }

  .pane {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--terminal-bg);
  }

  .pane.focused .pane-header {
    border-bottom-color: color-mix(
      in srgb,
      var(--accent-primary) 55%,
      var(--border-primary)
    );
  }

  .pane-header {
    height: 30px;
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    gap: 4px;
    padding: 0 4px;
    border-bottom: 1px solid var(--border-primary);
    background: color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-primary));
    color: var(--text-muted);
    user-select: none;
  }

  .pane-tabs {
    min-width: 0;
    flex: 1;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .terminal-tab {
    min-width: 112px;
    max-width: 220px;
    flex: 0 1 180px;
    display: flex;
    align-items: stretch;
    border-left: 1px solid transparent;
    border-right: 1px solid var(--border-primary);
  }

  .terminal-tab.active {
    border-left-color: var(--border-primary);
    background: var(--terminal-bg);
    color: var(--text-primary);
  }

  .terminal-tab-main,
  .terminal-tab-close {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .terminal-tab-main {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 4px 0 10px;
    cursor: grab;
  }

  .terminal-tab-close {
    width: 24px;
    flex: 0 0 24px;
    opacity: 0;
    font-size: 15px;
  }

  .terminal-tab:hover .terminal-tab-close,
  .terminal-tab.active .terminal-tab-close {
    opacity: 1;
  }

  .terminal-tab-close:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
  }

  .pane-tools {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }

  .pane-state {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-muted);
  }

  .pane-state.connected {
    background: var(--status-success);
    box-shadow: 0 0 0 3px
      color-mix(in srgb, var(--status-success) 13%, transparent);
  }

  .pane-title {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }

  .pane-action {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .pane-action:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .pane-action svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
  }


  .document-icon {
    width: 14px;
    height: 16px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    border: 1px solid currentColor;
    border-radius: 2px;
    font-size: 8px;
  }

  .dirty-indicator {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--accent-primary);
  }

  .pane-content,
  .pane-terminal {
    position: relative;
    flex: 1;
    width: 100%;
    min-height: 0;
    min-width: 0;
  }


  .pane-terminal {
    display: none;
  }

  .pane-terminal.active {
    display: block;
  }

  .pane-document {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .pane-content {
    display: flex;
  }
</style>
