<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    extraKeysRow1,
    extraKeysRow2,
    getArrowKeyCode,
    type ExtraKey,
  } from "$lib/utils/key-mapper";
  import { terminalModesStore } from "$lib/stores/terminal-modes.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import { modifiersStore } from "$lib/stores/modifiers.svelte";
  import type { VoiceInputController } from "$lib/voice/voice-input-controller";
  import {
    MAX_CLIPBOARD_IMAGE_BYTES,
    sshUploadClipboardImage,
    sshWrite,
  } from "$lib/tauri/commands";

  interface Props {
    onToggleKeyboard?: () => void;
    voiceInputController: VoiceInputController;
  }

  let { onToggleKeyboard, voiceInputController }: Props = $props();

  const encoder = new TextEncoder();
  const LONG_PRESS_DELAY_MS = 350;
  const LONG_PRESS_REPEAT_MS = 80;
  const STATUS_MESSAGE_DURATION_MS = 1800;
  const backspaceKey: ExtraKey = { label: "⌫", code: "\x7f", repeatable: true };
  let repeatDelayTimer: number | null = null;
  let repeatInterval: number | null = null;
  let repeatingKey: ExtraKey | null = null;
  let imageInput: HTMLInputElement;
  let imageUploadBusy = $state(false);
  let statusMessage = $state("");
  let statusTimer: number | null = null;


  function sendKey(code: string) {
    const activeTab = tabsStore.activeTab;
    if (activeTab?.sessionId) {
      sshWrite(activeTab.sessionId, encoder.encode(code)).catch(console.error);
    }
  }

  function isActive(key: ExtraKey): boolean {
    if (key.label === "CTRL") return modifiersStore.ctrlActive;
    if (key.label === "ALT") return modifiersStore.altActive;
    return false;
  }

  function resolveArrowKeyCode(label: string, sessionId: string | null | undefined, code: string): string {
    if (!sessionId) return code;
    const appCursorMode = terminalModesStore.isAppCursorMode(sessionId);

    if (label === "↑") return getArrowKeyCode("up", appCursorMode);
    if (label === "↓") return getArrowKeyCode("down", appCursorMode);
    if (label === "←") return getArrowKeyCode("left", appCursorMode);
    if (label === "→") return getArrowKeyCode("right", appCursorMode);
    return code;
  }

  function canRepeat(key: ExtraKey): boolean {
    return key.label !== "CTRL" && key.label !== "ALT";
  }

  function handleKeyPress(key: ExtraKey) {
    // Handle modifiers - 토글만
    if (key.label === "CTRL") {
      modifiersStore.toggleCtrl();
      return;
    }

    if (key.label === "ALT") {
      modifiersStore.toggleAlt();
      return;
    }

    // Get the key code
    const rawCode = typeof key.code === "function" ? key.code() : key.code;
    const activeTab = tabsStore.activeTab;
    const code = resolveArrowKeyCode(key.label, activeTab?.sessionId, rawCode);

    // ExtraKeysBar 키는 modifier 적용 안 함 (ESC, TAB, 방향키 등은 그대로 전송)
    if (code) {
      sendKey(code);
    }
  }

  function clearRepeatTimers() {
    if (repeatDelayTimer) {
      clearTimeout(repeatDelayTimer);
      repeatDelayTimer = null;
    }
    if (repeatInterval) {
      clearInterval(repeatInterval);
      repeatInterval = null;
    }
    repeatingKey = null;
  }

  function clearStatusTimer() {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
  }

  function showStatus(message: string) {
    statusMessage = message;
    clearStatusTimer();
    statusTimer = window.setTimeout(() => {
      statusMessage = "";
      statusTimer = null;
    }, STATUS_MESSAGE_DURATION_MS);
  }

  function openVoiceInput() {
    void voiceInputController.open().catch((error) => {
      console.error("[ExtraKeysBar] voice input failed:", error);
      showStatus(error instanceof Error ? error.message : String(error));
    });
  }
  function openImagePicker() {
    if (imageUploadBusy) return;
    imageInput?.click();
  }

  async function handleImageChange(e: Event) {
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    target.value = "";

    if (!file) return;

    const activeTab = tabsStore.activeTab;
    if (!activeTab?.sessionId) {
      showStatus("No active session");
      return;
    }
    const targetSessionId = activeTab.sessionId;

    if (file.size > MAX_CLIPBOARD_IMAGE_BYTES) {
      showStatus("Image upload failed: Clipboard image exceeds 10 MiB");
      return;
    }

    imageUploadBusy = true;
    showStatus("Uploading image...");

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const uploadResult = await sshUploadClipboardImage(targetSessionId, bytes);
      sshWrite(targetSessionId, encoder.encode(uploadResult.remote_path)).catch(console.error);
      showStatus("Image path received");
    } catch (error) {
      console.error("[ExtraKeysBar] image upload failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Image upload failed: ${message}`);
    } finally {
      imageUploadBusy = false;
    }
  }

  function handlePointerDown(key: ExtraKey, e: PointerEvent) {
    e.preventDefault();
    clearRepeatTimers();
    handleKeyPress(key);

    if (!canRepeat(key)) return;

    repeatingKey = key;
    try {
      (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    repeatDelayTimer = window.setTimeout(() => {
      if (!repeatingKey) return;
      handleKeyPress(repeatingKey);
      repeatInterval = window.setInterval(() => {
        if (!repeatingKey) return;
        handleKeyPress(repeatingKey);
      }, LONG_PRESS_REPEAT_MS);
    }, LONG_PRESS_DELAY_MS);
  }

  function handlePointerEnd() {
    clearRepeatTimers();
  }

  onDestroy(() => {
    clearRepeatTimers();
    clearStatusTimer();
    if (voiceInputController.state.open) {
      void voiceInputController.cancel();
    }
  });
</script>

<div class="extra-keys-bar">
  <input
    bind:this={imageInput}
    class="image-input"
    type="file"
    accept="image/*"
    onchange={handleImageChange}
  />

  <div class="keys-row">

    {#each extraKeysRow1 as key}
      <button
        class="key-btn"
        class:active={isActive(key)}
        tabindex="-1"
        onpointerdown={(e) => handlePointerDown(key, e)}
        onpointerup={handlePointerEnd}
        onpointercancel={handlePointerEnd}
        onlostpointercapture={handlePointerEnd}
      >
        {key.label}
      </button>
    {/each}

    <button
      class="key-btn utility-btn"
      type="button"
      tabindex="-1"
      aria-label="Voice input"
      title="Voice input"
      onpointerdown={(e) => { e.preventDefault(); openVoiceInput(); }}
    >
      <svg class="utility-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 12.5C11.6569 12.5 13 11.1569 13 9.5V5.5C13 3.84315 11.6569 2.5 10 2.5C8.34315 2.5 7 3.84315 7 5.5V9.5C7 11.1569 8.34315 12.5 10 12.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M4.75 9.25C4.75 12.1495 7.10051 14.5 10 14.5C12.8995 14.5 15.25 12.1495 15.25 9.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M10 14.5V17.5M7.5 17.5H12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>

    <button
      class="key-btn utility-btn"
      class:busy={imageUploadBusy}
      type="button"
      tabindex="-1"
      aria-label="Upload image"
      title="Upload image"
      disabled={imageUploadBusy}
      onclick={openImagePicker}
      >
        <svg class="utility-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M4 5.5H12.25C12.6478 5.5 13.0294 5.65804 13.3107 5.93934L15.0607 7.68934C15.342 7.97064 15.5 8.35218 15.5 8.75V14.5C15.5 15.0523 15.0523 15.5 14.5 15.5H4C3.44772 15.5 3 15.0523 3 14.5V6.5C3 5.94772 3.44772 5.5 4 5.5Z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M13 5.75V8H15.25"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M5.75 13L7.75 11L9.5 12.75L11 11.25"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M11.5 13L13 11.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="8.25" cy="8.5" r="0.75" fill="currentColor" />
      </svg>
    </button>
  </div>

  <div class="keys-row">

    {#each extraKeysRow2 as key}
      <button
        class="key-btn"
        tabindex="-1"
        onpointerdown={(e) => handlePointerDown(key, e)}
        onpointerup={handlePointerEnd}
        onpointercancel={handlePointerEnd}
        onlostpointercapture={handlePointerEnd}
      >
        {key.label}
      </button>
    {/each}

    <button
      class="key-btn"
      tabindex="-1"
      onpointerdown={(e) => handlePointerDown(backspaceKey, e)}
      onpointerup={handlePointerEnd}
      onpointercancel={handlePointerEnd}
      onlostpointercapture={handlePointerEnd}
      aria-label="Backspace"
      title="Backspace"
    >
      ⌫
    </button>

    <button
      class="key-btn utility-btn"
      type="button"
      tabindex="-1"
      aria-label="Toggle keyboard"
      title="Toggle keyboard"
      onpointerdown={(e) => { e.preventDefault(); onToggleKeyboard?.(); }}
    >
      <svg class="utility-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M4 6H16C16.8284 6 17.5 6.67157 17.5 7.5V13C17.5 13.8284 16.8284 14.5 16 14.5H4C3.17157 14.5 2.5 13.8284 2.5 13V7.5C2.5 6.67157 3.17157 6 4 6Z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M5.5 9.25H5.51M8 9.25H8.01M10.5 9.25H10.51M13 9.25H13.01M15.5 9.25H15.51M6.75 11.75H13.25"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>

  {#if statusMessage}
    <div class="status-message">{statusMessage}</div>
  {/if}

</div>

<style>
  .image-input {
    display: none;
  }

  .extra-keys-bar {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    gap: 4px;
    position: relative;
    z-index: 20;
    padding: 4px;
    background: var(--bg-primary);
    border-top: 1px solid var(--border-primary);
    user-select: none;
    -webkit-user-select: none;
    overscroll-behavior: none;
  }

  .keys-row {
    display: flex;
    align-items: stretch;
    gap: 4px;
  }

  .key-btn {
    flex: 1;
    min-width: 0;
    padding: var(--extrakeys-btn-padding, 10px 4px);
    background: var(--bg-secondary);
    border: none;
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    touch-action: manipulation;
    transition: background-color 0.1s;
    outline: none;
    -webkit-tap-highlight-color: transparent;
  }

  .key-btn:active {
    background: var(--bg-tertiary);
  }

  .key-btn.active {
    background: var(--accent-primary);
    color: var(--bg-primary);
  }

  .utility-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    min-width: 0;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .utility-icon {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
  }

  .utility-btn.busy {
    opacity: 0.75;
    cursor: progress;
  }

  .status-message {
    min-height: 16px;
    padding: 0 2px;
    color: var(--text-secondary, #bfa8a8);
    font-size: 11px;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 400px) {
    .key-btn {
      padding: var(--extrakeys-btn-padding-sm, 8px 2px);
      font-size: 10px;
    }

    .utility-icon {
      width: 16px;
      height: 16px;
    }
  }
</style>
