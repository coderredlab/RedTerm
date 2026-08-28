<script lang="ts">
  import ConnectionList from "$lib/components/ConnectionList.svelte";
  import type { SavedConnection } from "$lib/tauri/commands";
  import {
    desktopPrefsStore,
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
  } from "./desktop-prefs.svelte";

  interface Props {
    collapsed: boolean;
    width: number;
    onToggleCollapsed: () => void;
    onWidthChange: (width: number) => void;
    onEdit: (connection: SavedConnection) => void;
    onNewConnection: () => void;
  }

  let {
    collapsed,
    width,
    onToggleCollapsed,
    onWidthChange,
    onEdit,
    onNewConnection,
  }: Props = $props();

  let panelEl: HTMLElement | null = $state(null);

  function startResize(event: PointerEvent) {
    if (event.button !== 0 || !panelEl) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta)
      );
      onWidthChange(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }
</script>

<aside
  class="connections-panel"
  class:collapsed
  style:width="{collapsed ? 48 : width}px"
  bind:this={panelEl}
>
  {#if collapsed}
    <button
      class="rail-expand"
      title="Show sidebar"
      aria-label="Show sidebar"
      onclick={onToggleCollapsed}
    >
      <span aria-hidden="true">»</span>
    </button>
  {:else}
    <div class="product-mark">
      <div class="product-glyph" aria-hidden="true">&gt;_</div>
      <div>
        <div class="product-name">RedTerm</div>
        <div class="product-edition">Desktop workspace</div>
      </div>
      <button
        class="panel-collapse"
        title="Hide sidebar"
        aria-label="Hide sidebar"
        onclick={onToggleCollapsed}
      >
        <span aria-hidden="true">«</span>
      </button>
    </div>

    <ConnectionList onEdit={onEdit} onNewConnection={onNewConnection} />
  {/if}

  {#if !collapsed}
    <div
      class="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      onpointerdown={startResize}
    ></div>
  {/if}
</aside>

<style>
  .connections-panel {
    position: relative;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border-primary);
    background: color-mix(in srgb, var(--bg-secondary) 78%, var(--bg-primary));
  }

  .connections-panel.collapsed {
    align-items: center;
  }

  .product-mark {
    height: 68px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 10px 0 18px;
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
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .product-mark > div:nth-child(2) {
    min-width: 0;
    flex: 1;
  }

  .panel-collapse {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .panel-collapse:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .rail-expand {
    margin-top: 14px;
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 14px;
    cursor: pointer;
  }

  .rail-expand:hover {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .connections-panel :global(.connection-list) {
    min-height: 0;
    flex: 1;
    background: transparent;
  }

  .panel-resizer {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
  }

  .panel-resizer:hover {
    background: color-mix(in srgb, var(--accent-primary) 35%, transparent);
  }
</style>
