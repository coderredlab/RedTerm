<script lang="ts">
  import ConnectionList from "$lib/components/ConnectionList.svelte";
  import type { SavedConnection } from "$lib/tauri/commands";
  import FileExplorer from "./FileExplorer.svelte";
  import {
    desktopPrefsStore,
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
  } from "./desktop-prefs.svelte";

  interface Props {
    width: number;
    activeSessionId: string | null;
    explorerKind: "ssh" | "local" | null;
    onWidthChange: (width: number) => void;
    onEdit: (connection: SavedConnection) => void;
    onNewConnection: () => void;
    onOpenLocal: () => void;
    onPreview: (entry: { name: string; path: string; size: number }) => void;
  }

  let {
    width,
    activeSessionId,
    explorerKind,
    onWidthChange,
    onEdit,
    onNewConnection,
    onOpenLocal,
    onPreview,
  }: Props = $props();

  let view = $state<"connections" | "files">("connections");

  let panelEl: HTMLElement | null = $state(null);

  function startResize(event: PointerEvent) {
    const handle = event.currentTarget as HTMLElement | null;
    if (event.button !== 0 || !handle) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let settled = false;
    const capturedPointerId = event.pointerId;
    const windowUp = (e: PointerEvent) => {
      if (e.pointerId !== capturedPointerId) return;
      finish(false);
    };
    const windowCancel = (e: PointerEvent) => {
      if (e.pointerId !== capturedPointerId) return;
      finish(true);
    };
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta)
      );
      onWidthChange(next);
    };
    const finish = (restore: boolean) => {
      if (settled) return;
      settled = true;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finishUp);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("pointerup", windowUp, true);
      window.removeEventListener("pointercancel", windowCancel, true);
      if (restore) {
        onWidthChange(startWidth);
      }
    };
    const finishUp = () => finish(false);
    const cancel = () => finish(true);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finishUp);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("pointerup", windowUp, true);
    window.addEventListener("pointercancel", windowCancel, true);
    handle.setPointerCapture(event.pointerId);
  }

</script>

<aside
  class="connections-panel"
  style:width="{width}px"
  bind:this={panelEl}
>
  <div class="product-mark">
    <div class="product-glyph" aria-hidden="true">&gt;_</div>
    <div>
      <div class="product-name">RedTerm</div>
      <div class="product-edition">Desktop workspace</div>
    </div>
  </div>

  <div class="view-toggle">
    <button
      class="view-tab"
      class:active={view === "connections"}
      aria-pressed={view === "connections"}
      onclick={() => (view = "connections")}
    >
      Connections
    </button>
    <button
      class="view-tab"
      class:active={view === "files"}
      aria-pressed={view === "files"}
      onclick={() => (view = "files")}
    >
      Files
    </button>
  </div>

  {#if view === "connections"}
    <ConnectionList onEdit={onEdit} {onNewConnection} {onOpenLocal} />
  {:else if explorerKind}
    <FileExplorer kind={explorerKind} sessionId={activeSessionId} {onPreview} />
  {:else}
    <div class="files-empty">
      <strong>No session available</strong>
      <span>Connect a session to browse remote files.</span>
    </div>
  {/if}

  <input
    type="range"
    class="panel-resizer"
    aria-label="Resize sidebar"
    aria-orientation="vertical"
    min={MIN_SIDEBAR_WIDTH}
    max={MAX_SIDEBAR_WIDTH}
    step="10"
    value={Math.round(width)}
    oninput={(event) => onWidthChange(event.currentTarget.valueAsNumber)}
    onpointerdown={startResize}
  />
</aside>

<style>
  .connections-panel {
    position: relative;
    min-width: 0;
    min-height: 0;
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
    flex: 0 0 auto;
  }

  .product-name {
    color: var(--text-primary);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .product-edition {
    margin-top: 3px;
    color: var(--text-secondary);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .product-mark > div:nth-child(2) {
    min-width: 0;
    flex: 1;
  }

  .view-toggle {
    flex: 0 0 auto;
    display: flex;
    gap: 2px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-secondary);
  }

  .view-tab {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }

  .view-tab:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .view-tab.active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }


  .connections-panel :global(.connection-list) {
    min-height: 0;
    flex: 1;
    background: transparent;
  }

  .files-empty {
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--text-secondary);
    text-align: center;
  }

  .files-empty strong {
    color: var(--text-primary);
    font-size: 12px;
  }

  .files-empty span {
    font-size: 11px;
    line-height: 1.5;
  }

  .panel-resizer {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    padding: 0;
    border: 0;
    appearance: none;
    background: transparent;
    cursor: col-resize;
    z-index: 5;
  }

  .panel-resizer::-webkit-slider-thumb {
    width: 6px;
    height: 48px;
    appearance: none;
    background: transparent;
    cursor: col-resize;
  }

  .panel-resizer:hover,
  .panel-resizer:focus-visible {
    background: color-mix(in srgb, var(--accent-primary) 35%, transparent);
  }
</style>
