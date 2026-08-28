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
    if (node.type !== "split" || !splitEl || event.button !== 0) return;
    event.preventDefault();
    const rect = splitEl.getBoundingClientRect();
    liveRatio = node.ratio;

    const onMove = (moveEvent: PointerEvent) => {
      const raw =
        node.dir === "row"
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height;
      liveRatio = Math.min(0.9, Math.max(0.1, raw));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      tabsStore.updateSplitRatio(tabId, node.id, liveRatio);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startPaneDrag(event: PointerEvent, paneId: string, title: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let armed = false;

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
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      if (armed) {
        workspace.paneDragDropped(tabId, paneId);
      }
      resetTabDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }
</script>

{#if node.type === "split"}
  <div
    class="split"
    class:row={node.dir === "row"}
    class:col={node.dir === "col"}
    bind:this={splitEl}
  >
    <div class="split-child" style:flex-basis="{liveRatio * 100}%">
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
    <div class="split-child" style:flex-basis="{(1 - liveRatio) * 100}%">
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
          onConnected={(sessionId) =>
            workspace.paneConnected(tabId, node.paneId, sessionId)}
          onDisconnected={() => workspace.paneDisconnected(tabId, node.paneId)}
          bind:this={term}
        />
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
    flex-grow: 0;
    flex-shrink: 0;
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
    width: 24px;
    height: 22px;
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
