<script lang="ts">
  import { onMount } from "svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { deleteKnownHost, listKnownHosts, type KnownHostEntry } from "$lib/tauri/commands";
  import { THEMES } from "$lib/styles/themes";

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let knownHosts = $state<KnownHostEntry[]>([]);
  let knownHostsLoading = $state(false);
  let knownHostsError = $state<string | null>(null);
  let deletingKnownHostKey = $state<string | null>(null);
  let pendingDeleteKnownHostKey = $state<string | null>(null);

  function knownHostKey(entry: KnownHostEntry): string {
    return `${entry.host}:${entry.port}:${entry.fingerprint}`;
  }

  async function loadKnownHosts() {
    knownHostsLoading = true;
    knownHostsError = null;
    try {
      knownHosts = await listKnownHosts();
    } catch (error) {
      knownHostsError = error instanceof Error ? error.message : String(error);
    } finally {
      knownHostsLoading = false;
    }
  }

  async function removeKnownHost(entry: KnownHostEntry) {
    const key = knownHostKey(entry);
    deletingKnownHostKey = key;
    knownHostsError = null;
    try {
      await deleteKnownHost(entry.host, entry.port);
      knownHosts = knownHosts.filter((knownHost) => knownHostKey(knownHost) !== key);
      pendingDeleteKnownHostKey = null;
    } catch (error) {
      knownHostsError = error instanceof Error ? error.message : String(error);
    } finally {
      deletingKnownHostKey = null;
    }
  }

  onMount(() => {
    void loadKnownHosts();
  });
</script>

<div class="settings-screen">
  <div class="settings-header">
    <button class="back-btn" onclick={onClose} aria-label="Back">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M13 4L7 10L13 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <span class="header-title">Settings</span>
    <span class="header-spacer"></span>
  </div>

  <div class="settings-body">
    <div class="section">
      <div class="section-label">Terminal</div>
      <div class="section-card">
        <div class="setting-row">
          <span class="setting-label">Font Size</span>
          <div class="stepper">
            <button
              class="stepper-btn"
              onclick={() => settingsStore.setFontSize(settingsStore.fontSize - 1)}
              disabled={settingsStore.fontSize <= 8}
            >-</button>
            <span class="stepper-value">{settingsStore.fontSize}</span>
            <button
              class="stepper-btn"
              onclick={() => settingsStore.setFontSize(settingsStore.fontSize + 1)}
              disabled={settingsStore.fontSize >= 24}
            >+</button>
          </div>
        </div>

        <div class="setting-divider"></div>

        <div class="setting-row">
          <span class="setting-label">Keep Screen On</span>
          <button
            class="toggle"
            class:active={settingsStore.keepScreenOn}
            onclick={() => settingsStore.setKeepScreenOn(!settingsStore.keepScreenOn)}
            role="switch"
            aria-checked={settingsStore.keepScreenOn}
            aria-label="Keep Screen On"
          >
            <span class="toggle-knob"></span>
          </button>
        </div>

        <div class="setting-divider"></div>

        <div class="setting-row">
          <span class="setting-label">Extra Keys Height</span>
          <div class="stepper">
            <button
              class="stepper-btn"
              onclick={() => settingsStore.setExtraKeysHeight(settingsStore.extraKeysHeight - 2)}
              disabled={settingsStore.extraKeysHeight <= 4}
            >-</button>
            <span class="stepper-value">{settingsStore.extraKeysHeight}</span>
            <button
              class="stepper-btn"
              onclick={() => settingsStore.setExtraKeysHeight(settingsStore.extraKeysHeight + 2)}
              disabled={settingsStore.extraKeysHeight >= 20}
            >+</button>
          </div>
        </div>
        <div class="setting-divider"></div>

        <div class="setting-row">
          <span class="setting-label">Tab Bar Position</span>
          <div class="segment-control">
            <button
              class="segment-btn"
              class:active={settingsStore.tabBarPosition === "top"}
              onclick={() => settingsStore.setTabBarPosition("top")}
            >Top</button>
            <button
              class="segment-btn"
              class:active={settingsStore.tabBarPosition === "bottom"}
              onclick={() => settingsStore.setTabBarPosition("bottom")}
            >Bottom</button>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-label">Known Hosts</div>
      <div class="section-card">
        {#if knownHostsLoading}
          <div class="setting-row muted-row">Loading trusted hosts…</div>
        {:else if knownHostsError}
          <div class="known-host-error">
            <span>{knownHostsError}</span>
            <button type="button" onclick={() => void loadKnownHosts()}>Retry</button>
          </div>
        {:else if knownHosts.length === 0}
          <div class="setting-row muted-row">No trusted hosts yet.</div>
        {:else}
          {#each knownHosts as entry, index (knownHostKey(entry))}
            {#if index > 0}
              <div class="setting-divider"></div>
            {/if}
            <div class="known-host-item">
              <div class="known-host-main">
                <div class="known-host-title">
                  <span>{entry.host}:{entry.port}</span>
                  <span class="known-host-algorithm">{entry.algorithm}</span>
                </div>
                <code class="known-host-fingerprint">{entry.fingerprint}</code>
              </div>
              {#if pendingDeleteKnownHostKey === knownHostKey(entry)}
                <div class="known-host-confirm">
                  <span>Remove this trusted host key?</span>
                  <button
                    type="button"
                    class="known-host-btn ghost"
                    onclick={() => pendingDeleteKnownHostKey = null}
                    disabled={deletingKnownHostKey === knownHostKey(entry)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="known-host-btn danger"
                    onclick={() => void removeKnownHost(entry)}
                    disabled={deletingKnownHostKey === knownHostKey(entry)}
                  >
                    {deletingKnownHostKey === knownHostKey(entry) ? "Removing…" : "Remove"}
                  </button>
                </div>
              {:else}
                <button
                  type="button"
                  class="known-host-remove"
                  onclick={() => pendingDeleteKnownHostKey = knownHostKey(entry)}
                >
                  Remove
                </button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <div class="section">
      <div class="section-label">Theme</div>
      <div class="theme-grid">
        {#each THEMES as theme (theme.id)}
          <button
            class="theme-card"
            class:active={settingsStore.theme === theme.id}
            onclick={() => settingsStore.setTheme(theme.id)}
          >
            <div class="theme-swatches">
              <div class="swatch" style:background={theme.colors.terminalBg}></div>
              <div class="swatch" style:background={theme.colors.accentPrimary}></div>
              <div class="swatch" style:background={theme.colors.terminalFg}></div>
              <div class="swatch" style:background={theme.colors.statusSuccess}></div>
            </div>
            <div class="theme-name">{theme.name}</div>
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .settings-screen {
    position: absolute;
    inset: 0;
    z-index: 50;
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .settings-header {
    display: flex;
    align-items: center;
    height: 48px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-primary);
    flex-shrink: 0;
  }

  .back-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .back-btn:hover {
    background: var(--bg-secondary);
    color: var(--accent-primary);
  }

  .header-title {
    flex: 1;
    text-align: center;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .header-spacer {
    width: 32px;
  }

  .settings-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .section {
    margin-bottom: 24px;
  }

  .section-label {
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
    padding-left: 4px;
  }

  .section-card {
    background: var(--bg-secondary);
    border-radius: 8px;
    overflow: hidden;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
  }

  .setting-label {
    font-size: 14px;
    color: var(--text-primary);
  }

  .setting-divider {
    height: 1px;
    background: var(--border-secondary);
    margin: 0 16px;
  }

  .muted-row {
    color: var(--text-muted);
    font-size: 13px;
  }

  .known-host-error {
    display: grid;
    gap: 10px;
    padding: 14px 16px;
    color: var(--status-error);
    font-size: 13px;
  }

  .known-host-error button {
    justify-self: start;
    border: none;
    border-radius: 999px;
    padding: 7px 12px;
    color: var(--bg-primary);
    background: var(--status-error);
    font-size: 12px;
    font-weight: 700;
  }

  .known-host-item {
    display: grid;
    gap: 12px;
    padding: 14px 16px;
  }

  .known-host-main {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .known-host-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--text-primary);
    font-size: 14px;
    min-width: 0;
  }

  .known-host-title > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .known-host-algorithm {
    flex-shrink: 0;
    padding: 4px 7px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    font-size: 11px;
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
  }

  .known-host-fingerprint {
    display: block;
    padding: 9px 10px;
    border-radius: 10px;
    color: var(--terminal-fg);
    background: color-mix(in srgb, var(--terminal-bg) 82%, var(--bg-primary));
    border: 1px solid var(--border-secondary);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 12px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .known-host-remove {
    justify-self: start;
    border: none;
    border-radius: 999px;
    padding: 7px 12px;
    color: var(--status-error);
    background: color-mix(in srgb, var(--status-error) 12%, transparent);
    font-size: 12px;
    font-weight: 700;
  }

  .known-host-confirm {
    display: grid;
    gap: 8px;
    padding: 10px;
    border-radius: 12px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-tertiary) 82%, transparent);
    font-size: 12px;
  }

  .known-host-btn {
    border: none;
    border-radius: 999px;
    padding: 7px 12px;
    font-size: 12px;
    font-weight: 700;
  }

  .known-host-btn.ghost {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .known-host-btn.danger {
    color: var(--bg-primary);
    background: var(--status-error);
  }

  .known-host-btn:disabled,
  .known-host-remove:disabled,
  .known-host-error button:disabled {
    opacity: 0.56;
  }

  .stepper {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .stepper-btn {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: var(--bg-tertiary);
    border: none;
    color: var(--accent-primary);
    font-size: 16px;
    font-weight: bold;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .stepper-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .stepper-btn:not(:disabled):hover {
    background: var(--bg-hover);
  }

  .stepper-value {
    font-size: 16px;
    font-weight: 600;
    min-width: 24px;
    text-align: center;
    color: var(--text-primary);
  }

  .theme-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .theme-card {
    background: var(--bg-secondary);
    border-radius: 8px;
    padding: 12px;
    border: 2px solid transparent;
    cursor: pointer;
    text-align: left;
  }

  .theme-card.active {
    border-color: var(--accent-primary);
  }

  .theme-swatches {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }

  .swatch {
    width: 16px;
    height: 16px;
    border-radius: 4px;
  }

  .theme-name {
    font-size: 12px;
    color: var(--text-primary);
  }

  .segment-control {
    display: flex;
    gap: 0;
    background: var(--bg-tertiary);
    border-radius: 6px;
    overflow: hidden;
  }

  .segment-btn {
    padding: 6px 14px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }

  .segment-btn.active {
    background: var(--accent-primary);
    color: white;
  }

  .toggle {
    width: 44px;
    height: 24px;
    border-radius: 12px;
    background: var(--bg-tertiary);
    border: none;
    cursor: pointer;
    position: relative;
    transition: background 0.2s;
    padding: 0;
  }

  .toggle.active {
    background: var(--accent-primary);
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: white;
    transition: transform 0.2s;
  }

  .toggle.active .toggle-knob {
    transform: translateX(20px);
  }
</style>
