<script lang="ts">
  import { onMount } from "svelte";

  import { settingsStore, terminalFontStack } from "$lib/stores/settings.svelte";
  import { isLightTheme, THEMES } from "$lib/styles/themes";
  import { getAppVersion, listSystemFonts } from "$lib/tauri/commands";
  import { desktopUpdateStore } from "./desktop-update.svelte";
  import { modalFocus } from "./modal-focus";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();
  let appVersion = $state("");
  let systemFonts = $state<string[]>([]);
  let fontListStatus = $state<"idle" | "loading" | "ready" | "error">("idle");
  let fontPickerElement = $state<HTMLDivElement>();
  let fontTriggerElement = $state<HTMLButtonElement>();
  let fontListElement = $state<HTMLDivElement>();
  let fontMenuOpen = $state(false);
  let highlightedFontIndex = $state(0);
  let fontTypeahead = "";
  let fontTypeaheadTimer: ReturnType<typeof setTimeout> | null = null;

  const SCROLLBACK_OPTIONS = [
    { value: 1000, label: "1k" },
    { value: 5000, label: "5k" },
    { value: 10000, label: "10k" },
    { value: 20000, label: "20k" },
    { value: 50000, label: "50k" },
  ];

  type SettingsSection = "terminal" | "appearance" | "notifications" | "shortcuts" | "updates";

  const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
    { id: "terminal", label: "Terminal" },
    { id: "appearance", label: "Appearance" },
    { id: "notifications", label: "Notifications" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "updates", label: "Updates" },
  ];

  let activeSection = $state<SettingsSection>("terminal");
  let fontOptions = $derived([
    "",
    ...(fontListStatus !== "ready" &&
    settingsStore.terminalFontFamily &&
    !systemFonts.includes(settingsStore.terminalFontFamily)
      ? [settingsStore.terminalFontFamily]
      : []),
    ...systemFonts,
  ]);

  onMount(() => {
    void getAppVersion().then((version) => {
      appVersion = version;
    });

    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (
        fontMenuOpen &&
        event.target instanceof Node &&
        !fontPickerElement?.contains(event.target)
      ) {
        fontMenuOpen = false;
      }
    };

    const handleDocumentKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !fontMenuOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeFontMenu(true);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeydown, true);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeydown, true);
      if (fontTypeaheadTimer !== null) clearTimeout(fontTypeaheadTimer);
    };
  });

  const SHORTCUTS: Array<{ keys: string; action: string }> = [
    { keys: "Ctrl/Cmd+T", action: "New connection" },
    { keys: "Ctrl/Cmd+Shift+C", action: "Copy selection" },
    { keys: "Ctrl/Cmd+Shift+V", action: "Paste from clipboard" },
    { keys: "Ctrl/Cmd+W", action: "Close active document or pane" },
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

  function fontLabel(fontFamily: string): string {
    return fontFamily || "RedTerm Default";
  }

  function fontOptionId(index: number): string {
    return `terminal-font-option-${index}`;
  }

  function scrollHighlightedFontIntoView() {
    requestAnimationFrame(() => {
      document
        .getElementById(fontOptionId(highlightedFontIndex))
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  function moveFontHighlight(delta: number) {
    if (fontOptions.length === 0) return;
    highlightedFontIndex =
      (highlightedFontIndex + delta + fontOptions.length) % fontOptions.length;
    scrollHighlightedFontIntoView();
  }

  function openFontMenu(initialDelta = 0) {
    const selectedIndex = fontOptions.indexOf(settingsStore.terminalFontFamily);
    highlightedFontIndex = Math.max(0, selectedIndex);
    if (initialDelta !== 0) moveFontHighlight(initialDelta);
    fontMenuOpen = true;
    requestAnimationFrame(() => {
      fontListElement?.focus();
      scrollHighlightedFontIntoView();
    });
  }

  function closeFontMenu(restoreFocus = false) {
    fontMenuOpen = false;
    fontTypeahead = "";
    if (fontTypeaheadTimer !== null) {
      clearTimeout(fontTypeaheadTimer);
      fontTypeaheadTimer = null;
    }
    if (restoreFocus) requestAnimationFrame(() => fontTriggerElement?.focus());
  }

  function toggleFontMenu() {
    if (fontMenuOpen) {
      closeFontMenu(true);
    } else {
      openFontMenu();
    }
  }

  function selectFontFamily(fontFamily: string) {
    settingsStore.setTerminalFontFamily(fontFamily);
    closeFontMenu(true);
  }

  function handleFontTriggerKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openFontMenu(event.key === "ArrowDown" ? 1 : -1);
    }
  }

  function handleFontListKeydown(event: KeyboardEvent) {
    if (event.key === "Tab") {
      closeFontMenu();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFontMenu(true);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFontHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      highlightedFontIndex = event.key === "Home" ? 0 : fontOptions.length - 1;
      scrollHighlightedFontIntoView();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const fontFamily = fontOptions[highlightedFontIndex];
      if (fontFamily !== undefined) selectFontFamily(fontFamily);
      return;
    }

    if (
      event.key.length !== 1 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) return;

    fontTypeahead += event.key.toLocaleLowerCase();
    if (fontTypeaheadTimer !== null) clearTimeout(fontTypeaheadTimer);
    fontTypeaheadTimer = setTimeout(() => {
      fontTypeahead = "";
      fontTypeaheadTimer = null;
    }, 700);

    const matchingIndex = fontOptions.findIndex((fontFamily) =>
      fontLabel(fontFamily).toLocaleLowerCase().startsWith(fontTypeahead),
    );
    if (matchingIndex >= 0) {
      highlightedFontIndex = matchingIndex;
      scrollHighlightedFontIntoView();
    }
  }

  function filterMonospacedFonts(fontFamilies: string[]): string[] {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return [];

    return fontFamilies.filter((fontFamily) => {
      const escapedFontFamily = fontFamily
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"');
      context.font = `16px "${escapedFontFamily}"`;
      const narrowWidth = context.measureText("iiiiiiii").width;
      const wideWidth = context.measureText("MMMMMMMM").width;
      return Math.abs(narrowWidth - wideWidth) < 0.5;
    });
  }

  async function loadFonts() {
    fontListStatus = "loading";
    try {
      const fontFamilies = await listSystemFonts();
      await document.fonts.ready;
      systemFonts = filterMonospacedFonts(fontFamilies);
      fontListStatus = "ready";
      if (
        settingsStore.terminalFontFamily &&
        !systemFonts.includes(settingsStore.terminalFontFamily)
      ) {
        settingsStore.setTerminalFontFamily("");
      }
    } catch {
      fontListStatus = "error";
    }
  }

  type ThemeGroup = "dark" | "light";

  const THEME_GROUPS = {
    dark: THEMES.filter((theme) => !isLightTheme(theme)),
    light: THEMES.filter(isLightTheme),
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

  $effect(() => {
    if (open && fontListStatus === "idle") {
      void loadFonts();
    } else if (!open && fontListStatus === "error") {
      fontListStatus = "idle";
    }
  });

  $effect(() => {
    if (!open && fontMenuOpen) closeFontMenu();
  });

  let updatePhase = $derived(desktopUpdateStore.phase);

  let updateProgressPercent = $derived.by(() => {
    if (updatePhase.kind !== "downloading" || !updatePhase.total) return 0;
    return Math.min(
      100,
      Math.round((updatePhase.downloaded / updatePhase.total) * 100),
    );
  });

  let updateStatusText = $derived.by(() => {
    switch (updatePhase.kind) {
      case "idle":
        return "Desktop updates are delivered through GitHub Releases.";
      case "checking":
        return "Checking for updates…";
      case "upToDate":
        return appVersion
          ? `RedTerm ${appVersion} is up to date.`
          : "RedTerm is up to date.";
      case "available":
        return `Version ${updatePhase.update.version} is available.`;
      case "downloading":
        return updatePhase.total
          ? `Downloading update… ${updateProgressPercent}%`
          : `Downloading update… ${(updatePhase.downloaded / (1024 * 1024)).toFixed(1)} MB downloaded`;
      case "ready":
        return `Version ${updatePhase.update.version} is installed. Restart RedTerm to finish the update.`;
      case "error":
        return updatePhase.message;
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

      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings sections">
          {#each SETTINGS_SECTIONS as section (section.id)}
            <button
              type="button"
              class="settings-nav-item"
              class:active={activeSection === section.id}
              aria-current={activeSection === section.id}
              onclick={() => (activeSection = section.id)}
            >{section.label}</button>
          {/each}
        </nav>

        <div class="settings-body">
        {#if activeSection === "terminal"}
        <section class="settings-section">
          <div class="section-label">Terminal typography</div>
          <div class="font-controls">
            <div class="font-family-field">
              <span class="control-label" id="terminal-font-family-label">Font family</span>
              <div class="font-picker" bind:this={fontPickerElement}>
                <button
                  bind:this={fontTriggerElement}
                  type="button"
                  class="font-select-trigger"
                  class:open={fontMenuOpen}
                  aria-labelledby="terminal-font-family-label terminal-font-family-value"
                  aria-haspopup="listbox"
                  aria-expanded={fontMenuOpen}
                  aria-controls="terminal-font-family-list"
                  style:font-family={terminalFontStack(settingsStore.terminalFontFamily)}
                  onclick={toggleFontMenu}
                  onkeydown={handleFontTriggerKeydown}
                >
                  <span id="terminal-font-family-value" class="font-select-value">
                    {fontLabel(settingsStore.terminalFontFamily)}
                  </span>
                  <svg
                    class="font-select-chevron"
                    class:open={fontMenuOpen}
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path d="M3 4.5 6 7.5 9 4.5"></path>
                  </svg>
                </button>

                {#if fontMenuOpen}
                  <div
                    bind:this={fontListElement}
                    id="terminal-font-family-list"
                    class="font-select-list"
                    role="listbox"
                    aria-labelledby="terminal-font-family-label"
                    aria-activedescendant={fontOptionId(highlightedFontIndex)}
                    tabindex="0"
                    onkeydown={handleFontListKeydown}
                  >
                    {#each fontOptions as fontFamily, index (fontFamily)}
                      <button
                        id={fontOptionId(index)}
                        type="button"
                        class="font-select-option"
                        class:highlighted={highlightedFontIndex === index}
                        class:selected={settingsStore.terminalFontFamily === fontFamily}
                        role="option"
                        aria-selected={settingsStore.terminalFontFamily === fontFamily}
                        tabindex="-1"
                        style:font-family={terminalFontStack(fontFamily)}
                        onpointerenter={() => (highlightedFontIndex = index)}
                        onclick={() => selectFontFamily(fontFamily)}
                      >
                        <span>{fontLabel(fontFamily)}</span>
                        {#if settingsStore.terminalFontFamily === fontFamily}
                          <svg
                            class="font-select-check"
                            width="13"
                            height="13"
                            viewBox="0 0 13 13"
                            aria-hidden="true"
                          >
                            <path d="m2.5 6.8 2.3 2.3 5.7-5.7"></path>
                          </svg>
                        {/if}
                      </button>
                    {/each}

                    {#if fontListStatus === "loading"}
                      <div class="font-select-status" role="status">
                        Loading installed fonts…
                      </div>
                    {:else if fontListStatus === "error"}
                      <div class="font-select-status error" role="status">
                        System fonts could not be loaded.
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
              <span class="control-hint" class:error={fontListStatus === "error"}>
                {#if fontListStatus === "loading"}
                  Loading installed monospaced fonts…
                {:else if fontListStatus === "error"}
                  System fonts could not be loaded.
                {:else}
                  Installed monospaced fonts from this computer.
                {/if}
              </span>
            </div>

            <div class="font-size-field">
              <span class="control-label">Font size</span>
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
            </div>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-label">Scrollback</div>
          <div class="scrollback-field">
            <span class="control-label" id="scrollback-size-label">Buffer size</span>
            <div class="theme-filter" role="group" aria-labelledby="scrollback-size-label">
              {#each SCROLLBACK_OPTIONS as option (option.value)}
                <button
                  type="button"
                  class:active={settingsStore.scrollbackLines === option.value}
                  aria-pressed={settingsStore.scrollbackLines === option.value}
                  onclick={() => settingsStore.setScrollbackLines(option.value)}
                >{option.label}</button>
              {/each}
            </div>
            <span class="control-hint">Terminal lines kept above the viewport.</span>
          </div>
        </section>
        {:else if activeSection === "appearance"}

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
        {:else if activeSection === "notifications"}
        <section class="settings-section">
          <div class="section-label">Notifications</div>
          <div class="toggle-row">
            <div class="toggle-copy">
              <span class="control-label" id="bell-notifications-label">Terminal bell notifications</span>
              <span class="control-hint">Show a system notification when a background session rings the terminal bell.</span>
            </div>
            <button
              type="button"
              class="toggle"
              class:active={settingsStore.bellNotifications}
              role="switch"
              aria-checked={settingsStore.bellNotifications}
              aria-labelledby="bell-notifications-label"
              onclick={() => settingsStore.setBellNotifications(!settingsStore.bellNotifications)}
            ><span class="toggle-knob"></span></button>
          </div>
        </section>
        {:else if activeSection === "shortcuts"}

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
        {:else if activeSection === "updates"}

        <section class="settings-section">
          <div class="section-label">Updates</div>
          <div class="toggle-row">
            <div class="toggle-copy">
              <span class="control-label" id="auto-update-label">Check for updates automatically</span>
              <span class="control-hint">Look for a new version when RedTerm starts. You can always check manually below.</span>
            </div>
            <button
              type="button"
              class="toggle"
              class:active={settingsStore.updateCheckOnStartup}
              role="switch"
              aria-checked={settingsStore.updateCheckOnStartup}
              aria-labelledby="auto-update-label"
              onclick={() => settingsStore.setUpdateCheckOnStartup(!settingsStore.updateCheckOnStartup)}
            ><span class="toggle-knob"></span></button>
          </div>
          <div class="update-controls">
            <p
              class="update-status"
              class:error={updatePhase.kind === "error"}
              role="status"
            >
              {updateStatusText}
            </p>
            {#if updatePhase.kind === "downloading"}
              <div
                class="update-progress"
                role="progressbar"
                aria-label="Downloading update"
                aria-valuemin="0"
                aria-valuemax={updatePhase.total ? 100 : undefined}
                aria-valuenow={updatePhase.total ? updateProgressPercent : undefined}
              >
                <div
                  class="update-progress-fill"
                  style:width="{updateProgressPercent}%"
                ></div>
              </div>
            {:else if updatePhase.kind === "available"}
              <button
                type="button"
                class="update-button"
                onclick={() => void desktopUpdateStore.install()}
              >Download and install</button>
            {:else if updatePhase.kind === "ready"}
              <button
                type="button"
                class="update-button"
                onclick={() => void desktopUpdateStore.restart()}
              >Restart RedTerm</button>
            {:else if updatePhase.kind !== "checking"}
              <button
                type="button"
                class="update-button"
                onclick={() => void desktopUpdateStore.check()}
              >{updatePhase.kind === "error" ? "Retry" : "Check for updates"}</button>
            {/if}
          </div>
        </section>
        {/if}
      </div>
      </div>

      <footer class="settings-footer">
        <span class="settings-product">RedTerm</span>
        {#if appVersion}
          <span class="settings-version" aria-live="polite">
            Version {appVersion}
          </span>
        {/if}
      </footer>
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
    width: min(760px, calc(100vw - 48px));
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

  .settings-layout {
    min-height: 0;
    flex: 1 1 auto;
    display: flex;
    align-items: stretch;
  }

  .settings-nav {
    flex: 0 0 148px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 14px 8px;
    border-right: 1px solid var(--border-primary);
    background: var(--bg-secondary);
  }

  .settings-nav-item {
    height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .settings-nav-item:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .settings-nav-item.active {
    background: var(--bg-tertiary);
    color: var(--accent-primary);
  }

  .settings-body {
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 18px;
  }

  .settings-footer {
    height: 38px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 18px;
    border-top: 1px solid var(--border-primary);
    color: var(--text-muted);
    font-size: 10px;
  }

  .settings-product {
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .settings-version {
    font-variant-numeric: tabular-nums;
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

  .font-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 16px;
  }

  .font-family-field,
  .font-size-field,
  .scrollback-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .control-label {
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 600;
  }

  .font-picker {
    position: relative;
    min-width: 0;
  }

  .font-select-trigger {
    width: 100%;
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    outline: none;
    transition: border-color 100ms ease, background 100ms ease, box-shadow 100ms ease;
  }

  .font-select-trigger:hover {
    border-color: var(--border-secondary);
    background: var(--bg-tertiary);
  }

  .font-select-trigger:focus-visible,
  .font-select-trigger.open {
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 18%, transparent);
  }

  .font-select-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .font-select-chevron {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--text-muted);
    transition: transform 100ms ease;
  }

  .font-select-chevron.open {
    transform: rotate(180deg);
  }

  .font-select-list {
    position: absolute;
    z-index: 6;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    max-height: 246px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-primary);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.38);
    outline: none;
    animation: font-list-in 90ms ease-out;
  }

  @keyframes font-list-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }

  .font-select-option {
    width: 100%;
    min-height: 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 8px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.35;
    text-align: left;
    cursor: pointer;
  }

  .font-select-option.highlighted {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .font-select-option.selected {
    color: var(--accent-primary);
  }

  .font-select-check {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .font-select-status {
    padding: 9px 8px 7px;
    border-top: 1px solid var(--border-primary);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 10px;
  }

  .font-select-status.error {
    color: var(--status-error);
  }

  .control-hint {
    min-height: 14px;
    color: var(--text-muted);
    font-size: 10px;
    line-height: 1.4;
  }

  .control-hint.error {
    color: var(--status-error);
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
  .update-controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .update-status {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
  }

  .update-status.error {
    color: var(--status-error);
  }

  .update-progress {
    height: 4px;
    border-radius: 2px;
    background: var(--bg-tertiary);
    overflow: hidden;
  }

  .update-progress-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--accent-primary);
    transition: width 200ms ease;
  }

  .update-button {
    align-self: flex-start;
    padding: 6px 14px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .update-button:hover {
    background: var(--bg-secondary);
  }

  .update-button:active {
    background: var(--accent-muted);
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

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .toggle-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .toggle {
    position: relative;
    flex: 0 0 auto;
    width: 40px;
    height: 22px;
    border: none;
    border-radius: 11px;
    padding: 0;
    background: var(--bg-tertiary);
    cursor: pointer;
    transition: background 120ms ease;
  }

  .toggle.active {
    background: var(--accent-primary);
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--text-primary);
    transition: transform 120ms ease;
  }

  .toggle.active .toggle-knob {
    transform: translateX(18px);
  }
</style>
