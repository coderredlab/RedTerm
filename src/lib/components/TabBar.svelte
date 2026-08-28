<script lang="ts">
  import { tabsStore } from "$lib/stores/tabs.svelte";

  interface Props {
    onAddTab?: () => void;
    onCloseTab?: (id: string) => void | Promise<void>;
    onOpenSettings?: () => void;
  }

  let { onAddTab, onCloseTab, onOpenSettings }: Props = $props();

  function handleTabClick(id: string) {
    tabsStore.setActiveTab(id);
  }

  function handleCloseTab(e: MouseEvent, id: string) {
    e.stopPropagation();
    if (onCloseTab) {
      void onCloseTab(id);
      return;
    }
    tabsStore.removeTab(id);
  }
</script>

<div class="tab-bar">
  <div class="tabs-container">
    {#each tabsStore.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === tabsStore.activeTabId}
        role="tab"
        tabindex="0"
        onclick={() => handleTabClick(tab.id)}
        onkeydown={(e) => e.key === "Enter" && handleTabClick(tab.id)}
      >
        <span class="tab-status" class:connected={tab.connected}></span>
        <span class="tab-title">{tab.title}</span>
        <button class="tab-close" onclick={(e) => handleCloseTab(e, tab.id)}>
          &times;
        </button>
      </div>
    {/each}
  </div>

  <button class="add-tab-btn" onclick={onAddTab}>
    +
  </button>
  <button class="settings-btn" onclick={onOpenSettings} aria-label="Settings" title="Settings">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M6.5 1L7.1 3.1C7.5 3.2 7.9 3.4 8.3 3.6L10.2 2.6L11.4 3.8L10.4 5.7C10.6 6.1 10.8 6.5 10.9 6.9L13 7.5V9.2L10.9 9.8C10.8 10.2 10.6 10.6 10.4 11L11.4 12.9L10.2 14.1L8.3 13.1C7.9 13.3 7.5 13.5 7.1 13.6L6.5 15.7H4.8L4.2 13.6C3.8 13.5 3.4 13.3 3 13.1L1.1 14.1L-0.1 12.9L0.9 11C0.7 10.6 0.5 10.2 0.4 9.8L-1.7 9.2V7.5L0.4 6.9C0.5 6.5 0.7 6.1 0.9 5.7L-0.1 3.8L1.1 2.6L3 3.6C3.4 3.4 3.8 3.2 4.2 3.1L4.8 1H6.5Z" transform="translate(2.35 0.15)" stroke="currentColor" stroke-width="1.2" fill="none"/>
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
    </svg>
  </button>
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    position: relative;
    z-index: 20;
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border-primary);
    height: 40px;
    padding: 0 4px;
    overflow: hidden;
  }

  .tabs-container {
    display: flex;
    flex: 1;
    overflow-x: auto;
    gap: 2px;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .tabs-container::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: var(--bg-primary);
    border: none;
    border-radius: 6px 6px 0 0;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    min-width: 100px;
    max-width: 180px;
    transition: background-color 0.15s;
  }

  .tab:hover {
    background: var(--bg-secondary);
  }

  .tab.active {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .tab-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .tab-status.connected {
    background: var(--status-success);
  }

  .tab-title {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .tab-close {
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .tab-close:hover {
    background: var(--bg-tertiary);
    color: var(--status-error);
  }

  .add-tab-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 20px;
    cursor: pointer;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .add-tab-btn:hover {
    background: var(--bg-secondary);
    color: var(--accent-primary);
  }

  .settings-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: 4px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .settings-btn:hover {
    background: var(--bg-secondary);
    color: var(--accent-primary);
  }
</style>
