<script lang="ts">
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import {
    dragTargets,
    resetTabDrag,
    tabDrag,
    zoneFromPoint,
    type DropZone,
  } from "./drag-state.svelte";

  interface Props {
    onNewConnection: () => void;
    onCloseTab: (tabId: string) => void;
    onOpenSettings: () => void;
    onToggleSidebar: () => void;
    sidebarCollapsed: boolean;
    onDropToWorkspace: (sourceTabId: string, zone: DropZone) => void;
  }

  let {
    onNewConnection,
    onCloseTab,
    onOpenSettings,
    onToggleSidebar,
    sidebarCollapsed,
    onDropToWorkspace,
  }: Props = $props();

  let stripEl: HTMLDivElement | null = $state(null);
  let suppressClick = false;

  let dragArmed = false;
  let dragTabId: string | null = null;
  let startX = 0;
  let startY = 0;

  function findTabIndex(id: string): number {
    return tabsStore.tabs.findIndex((tab) => tab.id === id);
  }

  function computeInsertIndex(pointerX: number): number {
    if (!stripEl) return 0;
    const buttons = Array.from(
      stripEl.querySelectorAll<HTMLElement>("[data-tab-id]")
    );
    let index = 0;
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (pointerX > rect.left + rect.width / 2) {
        index += 1;
      }
    }
    return index;
  }

  function beginDrag(event: PointerEvent, tabId: string) {
    const tabEl = event.currentTarget as HTMLElement | null;
    if (event.button !== 0 || !tabEl) return;
    dragArmed = true;
    dragTabId = tabId;
    startX = event.clientX;
    startY = event.clientY;

    const onMove = (moveEvent: PointerEvent) => {
      if (
        !dragArmed ||
        !dragTabId ||
        (!tabDrag.active &&
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) <
            5)
      ) {
        return;
      }
      tabDrag.active = true;
      tabDrag.kind = "tab";
      tabDrag.tabId = dragTabId;
      tabDrag.paneId = null;
      const tab = tabsStore.getTab(dragTabId);
      tabDrag.title = tab?.title ?? "";
      tabDrag.pointerX = moveEvent.clientX;
      tabDrag.pointerY = moveEvent.clientY;

      const stripRect = stripEl?.getBoundingClientRect();
      const workspaceRect = dragTargets.workspace?.getBoundingClientRect();
      const overStrip =
        stripRect &&
        moveEvent.clientY >= stripRect.top &&
        moveEvent.clientY <= stripRect.bottom;
      if (overStrip) {
        tabDrag.overTabStrip = true;
        tabDrag.dropZone = null;
        tabDrag.insertIndex = computeInsertIndex(moveEvent.clientX);
      } else {
        tabDrag.overTabStrip = false;
        tabDrag.insertIndex = null;
        tabDrag.dropZone = workspaceRect
          ? zoneFromPoint(workspaceRect, moveEvent.clientX, moveEvent.clientY)
          : null;
      }
    };

    const finish = (drop: boolean) => {
      tabEl.removeEventListener("pointermove", onMove);
      tabEl.removeEventListener("pointerup", finishUp);
      tabEl.removeEventListener("pointercancel", cancel);
      if (tabDrag.active && dragTabId) {
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 0);
        if (drop && tabDrag.overTabStrip && tabDrag.insertIndex !== null) {
          const sourceIndex = findTabIndex(dragTabId!);
          let target = tabDrag.insertIndex;
          if (target > sourceIndex) target -= 1;
          if (target !== sourceIndex) {
            tabsStore.moveTab(dragTabId!, target);
          }
        } else if (drop && tabDrag.dropZone && dragTargets.workspace) {
          onDropToWorkspace(dragTabId!, tabDrag.dropZone);
        }
      }
      dragArmed = false;
      dragTabId = null;
      resetTabDrag();
    };
    const finishUp = () => finish(true);
    const cancel = () => finish(false);

    tabEl.addEventListener("pointermove", onMove);
    tabEl.addEventListener("pointerup", finishUp, { once: true });
    tabEl.addEventListener("pointercancel", cancel, { once: true });
    tabEl.setPointerCapture(event.pointerId);
  }

  function activate(tabId: string) {
    if (suppressClick) return;
    tabsStore.setActiveTab(tabId);
  }
</script>

<div class="tabstrip" bind:this={stripEl}>
  <button
    class="strip-action sidebar-toggle"
    title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
    aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
    onclick={onToggleSidebar}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" />
    </svg>
  </button>

  <div class="tabs" role="tablist" aria-label="Terminal sessions">
    {#each tabsStore.tabs as tab, index (tab.id)}
      <div
        class="session-tab"
        class:active={tab.id === tabsStore.activeTabId}
        class:drop-before={tabDrag.active &&
          tabDrag.overTabStrip &&
          tabDrag.insertIndex === index}
        data-tab-id={tab.id}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === tabsStore.activeTabId}
        onpointerdown={(event) => beginDrag(event, tab.id)}
        onclick={() => activate(tab.id)}
        onauxclick={(event) => {
          if (event.button === 1) onCloseTab(tab.id);
        }}
        onkeydown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate(tab.id);
          }
        }}
      >
        <span
          class="connection-state"
          class:connected={tab.connected}
          aria-hidden="true"
        ></span>
        <span class="session-title">{tab.title}</span>
        <button
          class="close-tab"
          tabindex="-1"
          aria-label={`Close ${tab.title}`}
          onpointerdown={(event) => event.stopPropagation()}
          onclick={(event) => {
            event.stopPropagation();
            onCloseTab(tab.id);
          }}
        >×</button>
      </div>
    {/each}
    {#if tabDrag.active && tabDrag.overTabStrip && tabDrag.insertIndex === tabsStore.tabs.length}
      <span class="insert-marker" aria-hidden="true"></span>
    {/if}
  </div>

  <button class="new-session" onclick={onNewConnection}>
    <span aria-hidden="true">+</span>
    New connection
  </button>

  <button
    class="strip-action"
    title="Settings"
    aria-label="Settings"
    onclick={onOpenSettings}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.4" />
      <path
        d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4"
      />
    </svg>
  </button>
</div>

<style>
  .tabstrip {
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
    position: relative;
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
    position: relative;
    user-select: none;
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

  .session-tab.drop-before::before {
    content: "";
    position: absolute;
    left: -2px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent-primary);
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
    box-shadow: 0 0 0 3px
      color-mix(in srgb, var(--status-success) 13%, transparent);
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
    cursor: pointer;
  }

  .close-tab:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .insert-marker {
    width: 3px;
    flex: 0 0 auto;
    margin: 6px 1px;
    border-radius: 2px;
    background: var(--accent-primary);
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

  .strip-action {
    flex: 0 0 auto;
    width: 44px;
    display: grid;
    place-items: center;
    border: 0;
    border-left: 1px solid var(--border-primary);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .strip-action.sidebar-toggle {
    border-left: 0;
    border-right: 1px solid var(--border-primary);
    width: 40px;
  }

  .strip-action:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .strip-action svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
</style>
