<script lang="ts">
  import Terminal from "$lib/terminal/Terminal.svelte";
  import { tabsStore, type PaneNode } from "$lib/stores/tabs.svelte";
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
  let term: Terminal | null = $state(null);
  let resizePointerId: number | null = null;

  $effect(() => {
    if (node.type === "split") {
      liveRatio = node.ratio;
    }
  });

  $effect(() => {
    if (node.type !== "leaf" || !term) return;
    const paneId = node.paneId;
    workspace.registerTerminal(paneId, term);
    return () => {
      workspace.unregisterTerminal(paneId);
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
    {#key node.paneId}
      <section
        class="pane"
        class:focused
        data-pane-id={node.paneId}
        onpointerdowncapture={() => workspace.activatePane(tabId, node.paneId)}
      >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header
        class="pane-header"
        onpointerdown={(event) => startPaneDrag(event, node.paneId, pane.title)}
      >
        <span
          class="pane-state"
          class:connected={pane.connected}
          aria-hidden="true"
        ></span>
        <span class="pane-title">{pane.title}</span>
        <button
          class="pane-action"
          title="Split right"
          aria-label="Split right"
          onpointerdown={(event) => event.stopPropagation()}
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
          onpointerdown={(event) => event.stopPropagation()}
          onclick={() => workspace.splitPane(tabId, node.paneId, "col")}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <rect x="1" y="2" width="12" height="10" rx="1" />
            <line x1="1" y1="7" x2="13" y2="7" />
          </svg>
        </button>
        <button
          class="pane-action pane-close"
          title="Close pane"
          aria-label="Close pane"
          onpointerdown={(event) => event.stopPropagation()}
          onclick={() => workspace.closePane(tabId, node.paneId)}
        >
          ×
        </button>
      </header>
      <div class="pane-terminal">
        {#key pane.connection}
        <Terminal
          host={pane.connection.host}
          port={pane.connection.port}
          auth={pane.connection.auth}
          existingSessionId={pane.sessionId}
          connectionId={pane.connection.connectionId}
          startupScript={pane.connection.startupScript}
          startupScriptReadyText={pane.connection.startupScriptReadyText}
          interactive={focused}
          refocusOnBlur={activePaneId === node.paneId}
          disconnectOnDestroy={!pane.preserveSessionOnMove}
          kind={pane.kind ?? "ssh"}
          onConnected={(sessionId) =>
            workspace.paneConnected(tabId, node.paneId, sessionId)}
          onEditConnection={pane.kind === "local"
            ? undefined
            : () => workspace.editPaneConnection(tabId, node.paneId)}
          onCloseTab={() => workspace.closeTab(tabId)}
          onDisconnected={() => workspace.paneDisconnected(tabId, node.paneId)}
          bind:this={term}
          onTitleChange={(title) => tabsStore.setPaneTitle(tabId, node.paneId, title)}
        />
        {/key}
      </div>
      </section>
    {/key}
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
    color: var(--text-primary);
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
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 12px;
    border-bottom: 1px solid var(--border-primary);
    background: color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-primary));
    color: var(--text-muted);
    user-select: none;
    cursor: grab;
  }

  .pane-header:active {
    cursor: grabbing;
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

  .pane-close {
    font-size: 16px;
  }

  .pane-terminal {
    position: relative;
    flex: 1;
    min-height: 0;
  }
</style>
