<script lang="ts">
  import { THEMES } from "$lib/styles/themes";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { modalFocus } from "./modal-focus";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  const SHORTCUTS: Array<{ keys: string; action: string }> = [
    { keys: "Ctrl/Cmd+T", action: "New connection" },
    { keys: "Ctrl/Cmd+Shift+C", action: "Copy selection" },
    { keys: "Cmd/Ctrl+V", action: "Paste (native)" },
    { keys: "Ctrl/Cmd+W", action: "Close pane" },
    { keys: "Ctrl/Cmd+Shift+W", action: "Close tab" },
    { keys: "Ctrl/Cmd+Tab", action: "Next tab" },
    { keys: "Ctrl/Cmd+Shift+Tab", action: "Previous tab" },
    { keys: "Ctrl + PageUp / PageDown", action: "Previous / next tab" },
    { keys: "Ctrl/Cmd+1…9", action: "Select tab by number" },
    { keys: "Ctrl/Cmd+\\", action: "Split right" },
    { keys: "Ctrl/Cmd+Shift+\\", action: "Split down" },
    { keys: "Ctrl+Alt+Arrows", action: "Move pane focus" },
    { keys: "Ctrl/Cmd+,", action: "Settings" },
  ];

  function stepFontSize(delta: number) {
    settingsStore.setFontSize(settingsStore.fontSize + delta);
  }

  type ThemeGroup = "dark" | "light";

  function linearChannel(channel: number): number {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  }

  function isLightTheme(background: string): boolean {
    const value = Number.parseInt(background.slice(1), 16);
    const luminance =
      0.2126 * linearChannel((value >> 16) & 0xff) +
      0.7152 * linearChannel((value >> 8) & 0xff) +
      0.0722 * linearChannel(value & 0xff);
    return luminance > 0.5;
  }

  const THEME_GROUPS = {
    dark: THEMES.filter((theme) => !isLightTheme(theme.colors.terminalBg)),
    light: THEMES.filter((theme) => isLightTheme(theme.colors.terminalBg)),
  } satisfies Record<ThemeGroup, typeof THEMES>;

  function groupForTheme(themeId: string): ThemeGroup {
    return THEME_GROUPS.light.some((theme) => theme.id === themeId)
      ? "light"
      : "dark";
  }

  let themeGroup = $state<ThemeGroup>(groupForTheme(settingsStore.theme));

  $effect(() => {
    if (open) {
      themeGroup = groupForTheme(settingsStore.theme);
    }
  });
</script>

{#if open}
  <div
    class="settings-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    use:modalFocus={{ onClose }}
  >
    <div class="settings-backdrop" onclick={onClose} aria-hidden="true"></div>
    <div class="settings-modal">
      <header class="settings-header">
        <h2>Settings</h2>
        <button
          class="settings-close"
          title="Close settings"
          aria-label="Close settings"
          onclick={onClose}
          data-modal-initial-focus
        >×</button>
      </header>

      <div class="settings-body">
        <section class="settings-section">
          <div class="section-label">Terminal font size</div>
          <div class="font-stepper">
            <button
              title="Decrease font size"
              aria-label="Decrease font size"
              onclick={() => stepFontSize(-1)}
            >−</button>
            <span class="font-value">{settingsStore.fontSize}px</span>
            <button
              title="Increase font size"
              aria-label="Increase font size"
              onclick={() => stepFontSize(1)}
            >+</button>
          </div>
        </section>

        <section class="settings-section">
          <div class="theme-heading">
            <div class="section-label">Theme</div>
            <div class="theme-filter" role="group" aria-label="Theme appearance">
              <button
                class:active={themeGroup === "dark"}
                aria-pressed={themeGroup === "dark"}
                onclick={() => (themeGroup = "dark")}
              >Dark</button>
              <button
                class:active={themeGroup === "light"}
                aria-pressed={themeGroup === "light"}
                onclick={() => (themeGroup = "light")}
              >Light</button>
            </div>
          </div>
          <div class="theme-grid">
            {#each THEME_GROUPS[themeGroup] as theme (theme.id)}
              <button
                class="theme-card"
                class:active={settingsStore.theme === theme.id}
                aria-pressed={settingsStore.theme === theme.id}
                onclick={() => settingsStore.setTheme(theme.id)}
              >
                <div class="theme-swatches">
                  <div
                    class="swatch"
                    style:background={theme.colors.terminalBg}
                  ></div>
                  <div
                    class="swatch"
                    style:background={theme.colors.accentPrimary}
                  ></div>
                  <div
                    class="swatch"
                    style:background={theme.colors.terminalFg}
                  ></div>
                  <div
                    class="swatch"
                    style:background={theme.colors.statusSuccess}
                  ></div>
                </div>
                <div class="theme-name">{theme.name}</div>
              </button>
            {/each}
          </div>
        </section>

        <section class="settings-section">
          <div class="section-label">Keyboard shortcuts</div>
          <div class="shortcut-list">
            {#each SHORTCUTS as shortcut (shortcut.keys)}
              <div class="shortcut-row">
                <kbd>{shortcut.keys}</kbd>
                <span>{shortcut.action}</span>
              </div>
            {/each}
          </div>
          <p class="shortcut-note">
            On Linux and Windows, Ctrl+T / Ctrl+W / Ctrl+\\ keep their shell
            meaning while a terminal has focus.
          </p>
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
  }

  .settings-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
  }

  .settings-modal {
    position: relative;
    width: min(640px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 64px));
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-primary);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
    overflow: hidden;
    animation: settings-in 140ms ease;
  }

  @keyframes settings-in {
    from {
      opacity: 0;
      transform: scale(0.98) translateY(6px);
    }
  }

  .settings-header {
    height: 52px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px 0 18px;
    border-bottom: 1px solid var(--border-primary);
  }

  h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .settings-close {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .settings-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .settings-body {
    min-height: 0;
    overflow-y: auto;
    padding: 18px;
  }

  .settings-section + .settings-section {
    margin-top: 22px;
  }

  .section-label {
    margin-bottom: 10px;
    color: var(--text-muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .font-stepper {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    padding: 4px 6px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
  }

  .font-stepper button {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 16px;
    cursor: pointer;
  }

  .font-stepper button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .font-value {
    min-width: 44px;
    text-align: center;
    color: var(--text-primary);
    font-size: 12px;
  }

  .theme-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
  }

  .theme-heading .section-label {
    margin-bottom: 0;
  }

  .theme-filter {
    display: flex;
    padding: 2px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-secondary);
  }

  .theme-filter button {
    min-width: 58px;
    height: 26px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
  }

  .theme-filter button:hover {
    color: var(--text-primary);
  }

  .theme-filter button.active {
    background: var(--bg-tertiary);
    color: var(--accent-primary);
  }

  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
    gap: 10px;
  }

  .theme-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-secondary);
    cursor: pointer;
  }

  .theme-card:hover {
    border-color: var(--accent-muted);
  }

  .theme-card.active {
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 1px var(--accent-primary);
  }

  .theme-swatches {
    display: flex;
    gap: 4px;
  }

  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  .theme-name {
    color: var(--text-secondary);
    font-size: 11px;
    text-align: left;
  }

  .theme-card.active .theme-name {
    color: var(--text-primary);
  }

  .shortcut-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 6px 10px;
    border: 1px solid var(--border-secondary);
    border-radius: 3px;
  }

  .shortcut-row kbd {
    color: var(--accent-primary);
    font-family: inherit;
    font-size: 11px;
    white-space: nowrap;
  }

  .shortcut-row span {
    color: var(--text-secondary);
    font-size: 11px;
    text-align: right;
  }

  .shortcut-note {
    margin: 10px 0 0;
    color: var(--text-muted);
    font-size: 10px;
  }
</style>
