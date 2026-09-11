<script module lang="ts">
  let paneDocumentViewModule: Promise<typeof import("./PaneDocumentView.svelte")> | undefined;

  function loadPaneDocumentView() {
    return paneDocumentViewModule ??= import("./PaneDocumentView.svelte");
  }
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import Terminal from "$lib/terminal/Terminal.svelte";
  import { tabsStore, type PaneNode } from "$lib/stores/tabs.svelte";
  import {
    paneTargetFromPoint,
    resetTabDrag,
    tabDrag,
  } from "./drag-state.svelte";
  import { getWorkspaceApi } from "./workspace-context";
  import Self from "./PaneView.svelte";

  interface Props {
    tabId: string;
    node: PaneNode;
    /** True when this tab is visible in the workspace. */
    visible: boolean;
    /** True when this tab is active and no overlay is open. */
    interactive: boolean;
    activePaneId: string | null;
  }

  let { tabId, node, visible, interactive, activePaneId }: Props = $props();

  const workspace = getWorkspaceApi();
  let splitEl: HTMLDivElement | null = $state(null);
  let liveRatio = $state(0.5);
  let terminalRefs = $state<Record<string, Terminal | undefined>>({});
  let resizePointerId: number | null = null;
  let cancelPaneDrag: (() => void) | null = null;
  let suppressPaneClick = false;
  onDestroy(() => cancelPaneDrag?.());

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

  function startPaneDrag(event: PointerEvent, paneId: string, title: string, wholePane = false) {
    const header = event.currentTarget as HTMLElement | null;
    if (event.button !== 0 || !header || !interactive || tabDrag.active) return;
    cancelPaneDrag?.();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let armed = false;
    let settled = false;
    const capturedPointerId = event.pointerId;
    const updateTarget = (x: number, y: number) => {
      tabDrag.pointerX = x;
      tabDrag.pointerY = y;
      const target = tabsStore.activeTabId === tabId ? paneTargetFromPoint(tabId, x, y) : null;
      const sameLeaf = node.type === "leaf" && target !== null && node.paneIds.includes(target.paneId);
      tabDrag.paneTarget = sameLeaf && (wholePane ||
        (target?.zone === "merge" && target.insertIndex === null) ||
        (target?.zone !== "merge" && node.type === "leaf" && node.paneIds.length === 1)) ? null : target;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== capturedPointerId || settled) return;
      if (!armed && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
      armed = true;
      tabDrag.active = true;
      tabDrag.kind = "pane";
      tabDrag.tabId = tabId;
      tabDrag.paneId = paneId;
      tabDrag.wholePane = wholePane;
      tabDrag.title = title;
      updateTarget(moveEvent.clientX, moveEvent.clientY);
    };
    const finish = (drop: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finishUp, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", cancel);
      header.removeEventListener("lostpointercapture", cancel);
      if (header.hasPointerCapture(capturedPointerId)) header.releasePointerCapture(capturedPointerId);
      cancelPaneDrag = null;
      if (armed) {
        suppressPaneClick = true;
        setTimeout(() => { suppressPaneClick = false; }, 0);
        if (drop) workspace.paneDragDropped(tabId, paneId);
      }
      resetTabDrag();
    };
    const finishUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== capturedPointerId) return;
      if (armed) updateTarget(upEvent.clientX, upEvent.clientY);
      finish(true);
    };
    const cancel = () => finish(false);
    const keydown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(false);
      }
    };
    cancelPaneDrag = cancel;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finishUp, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", cancel);
    header.addEventListener("lostpointercapture", cancel);
    header.setPointerCapture(capturedPointerId);
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
      <Self {tabId} node={node.children[0]} {visible} {interactive} {activePaneId} />
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
      <Self {tabId} node={node.children[1]} {visible} {interactive} {activePaneId} />
    </div>
  </div>
{:else}
  {@const pane = tabsStore.getPane(tabId, node.paneId)}
  {@const focused = interactive && activePaneId === node.paneId}
  {@const dropTarget = tabDrag.active && tabDrag.kind === "pane" && tabDrag.paneTarget?.tabId === tabId && tabDrag.paneTarget.paneId === node.paneId ? tabDrag.paneTarget : null}
  {#if pane}
      <section
        class="pane"
        class:focused
        data-pane-id={node.paneId}
        data-workspace-tab-id={tabId}
      >
        <header class="pane-header">
          <button
            class="pane-action pane-drag-handle"
            title="Drag pane to move or merge"
            aria-label="Drag pane to move or merge"
            onpointerdown={(event) => startPaneDrag(event, node.paneId, `Pane: ${pane.title}`, true)}
          >
            <svg viewBox="0 0 12 16" aria-hidden="true">
              <circle cx="4" cy="4" r="1" /><circle cx="8" cy="4" r="1" />
              <circle cx="4" cy="8" r="1" /><circle cx="8" cy="8" r="1" />
              <circle cx="4" cy="12" r="1" /><circle cx="8" cy="12" r="1" />
            </svg>
          </button>
          <div class="pane-tabs" role="tablist" aria-label="Pane tabs">
            {#each node.paneIds as paneId, index (paneId)}
              {@const tabPane = tabsStore.getPane(tabId, paneId)}
              {#if tabPane}
                <div
                  class="terminal-tab"
                  class:drop-before={dropTarget?.insertIndex === index}
                  class:drop-after={dropTarget?.insertIndex === node.paneIds.length && index === node.paneIds.length - 1}
                  data-pane-tab-id={paneId}
                  class:active={node.activeItem.kind === "terminal" && node.activeItem.id === paneId}
                >
                  <button
                    class="terminal-tab-main"
                    role="tab"
                    aria-selected={node.activeItem.kind === "terminal" && node.activeItem.id === paneId}
                    title={tabPane.title}
                    onpointerdown={(event) => startPaneDrag(event, paneId, tabPane.title)}
                    onclick={() => { if (!suppressPaneClick) workspace.activatePane(tabId, paneId); }}
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
                    onclick={() => workspace.closeDocument(tabId, document.id)}
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
                    disconnectOnDestroy={() => !tabsStore.tabs.some((tab) =>
                      tab.panes.some((pane) => pane.id === terminalPaneId && pane.preserveSessionOnMove))}
                    kind={terminalPane.kind ?? "ssh"}
                    onConnected={(sessionId) =>
                      workspace.paneConnected(tabId, terminalPaneId, sessionId)}
                    onRevealPath={(path) => workspace.revealPath(tabId, terminalPaneId, path)}
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
          {#each node.documentIds as documentId (documentId)}
            {@const document = tabsStore.getDocument(tabId, documentId)}
            {@const selected = node.activeItem.kind === "document" && node.activeItem.id === documentId}
            <!-- Tab selection must not discard editor state, media playback, or cache leases. -->
            {#if document}
              <div
                class="pane-document"
                class:active={selected}
                aria-hidden={!visible || !selected}
                inert={!visible || !selected}
                onpointerdowncapture={() => {
                  if (!focused) workspace.activateDocument(tabId, document.id);
                }}
                onfocusin={() => {
                  if (!focused) workspace.activateDocument(tabId, document.id);
                }}
              >
                {#await loadPaneDocumentView() then { default: PaneDocumentView }}
                  <PaneDocumentView
                    {tabId}
                    {document}
                    visible={visible && selected}
                    active={focused && selected}
                  />
                {/await}
              </div>
            {/if}
          {/each}
        </div>
        {#if dropTarget && dropTarget.insertIndex === null}
          <div class="pane-drop-preview" class:left={dropTarget.zone === "left"} class:right={dropTarget.zone === "right"}
            class:top={dropTarget.zone === "top"} class:bottom={dropTarget.zone === "bottom"} aria-hidden="true">
            <span>{dropTarget.zone === "merge" ? (tabDrag.wholePane ? "Merge panes" : "Move tab here") : "Split here"}</span>
          </div>
        {/if}
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
    position: relative;
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
    position: relative;
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

  .pane-drag-handle { width: 20px; cursor: grab; touch-action: none; }
  .pane-drag-handle:active, .terminal-tab-main:active { cursor: grabbing; }
  .pane-drag-handle svg { width: 12px; height: 16px; fill: currentColor; }
  .terminal-tab-main { touch-action: none; }
  .terminal-tab.drop-before::before, .terminal-tab.drop-after::after {
    content: "";
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent-primary);
    z-index: 2;
    pointer-events: none;
  }
  .terminal-tab.drop-before::before { left: 0; }
  .terminal-tab.drop-after::after { right: 0; }
  .pane-drop-preview {
    position: absolute;
    inset: 30px 0 0;
    z-index: 20;
    pointer-events: none;
    display: grid;
    place-items: center;
    border: 2px solid var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
  }
  .pane-drop-preview.left { right: 50%; }
  .pane-drop-preview.right { left: 50%; }
  .pane-drop-preview.top { bottom: calc(50% - 15px); }
  .pane-drop-preview.bottom { top: calc(50% + 15px); }
  .pane-drop-preview span {
    padding: 6px 10px;
    border: 1px solid var(--accent-primary);
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 11px;
    font-weight: 600;
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


  .pane-terminal,
  .pane-document {
    display: none;
  }

  .pane-terminal.active,
  .pane-document.active {
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
