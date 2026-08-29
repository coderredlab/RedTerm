<script lang="ts">
  import type {
    VoiceInputController,
    VoiceInputStatus,
  } from "$lib/voice/voice-input-controller";

  interface Props {
    controller: VoiceInputController;
  }

  let { controller }: Props = $props();

  const statusLabel: Record<VoiceInputStatus, string> = {
    idle: "Idle",
    preparing: "Preparing…",
    listening: "Listening…",
    partial: "Listening…",
    final: "Recognized",
    error: "Error",
  };

  let renderRevision = $state(0);

  const view = $derived.by(() => {
    renderRevision;
    const state = controller.state;

    return {
      open: state.open,
      status: state.status,
      statusText: statusLabel[state.status],
      displayText: controller.displayText,
      errorMessage: state.errorMessage,
      activeLanguageLabel: controller.activeLanguage?.label ?? "Default language",
      languageCount: state.languages.length,
      canSend: controller.canSend,
    };
  });

  $effect(() => {
    const unsubscribe = controller.onChange(() => {
      renderRevision += 1;
    });

    return unsubscribe;
  });
</script>

{#if view.open}
  <div class="voice-backdrop" role="presentation">
    <div class="voice-popup" role="dialog" aria-modal="true" aria-label="Voice input">
      <header class="voice-header">
        <strong>Voice input</strong>
        <span class="language-chip">Current: {view.activeLanguageLabel}</span>
      </header>

      <div class="voice-status">{view.statusText}</div>

      <div class="voice-transcript" aria-live="polite">
        {#if view.displayText}
          {view.displayText}
        {:else if view.errorMessage}
          {view.errorMessage}
        {:else}
          Listening for speech...
        {/if}
      </div>

      {#if view.errorMessage}
        <div class="voice-error">{view.errorMessage}</div>
      {/if}

      <footer class="voice-actions">
        <button
          type="button"
          class="voice-btn"
          onclick={() => void controller.rotateLanguage()}
          disabled={view.languageCount <= 1}
        >
          Switch language
        </button>
        <div class="spacer"></div>
        <button type="button" class="voice-btn" onclick={() => void controller.cancel()}>Cancel</button>
        <button
          type="button"
          class="voice-btn primary"
          onclick={() => void controller.send()}
          disabled={!view.canSend}
        >
          Send
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .voice-backdrop {
    position: absolute;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 16px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.35);
  }

  .voice-popup {
    width: min(560px, 100%);
    border: 1px solid var(--border-primary);
    border-radius: 14px;
    background: var(--bg-primary);
    color: var(--text-primary);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
    padding: 14px;
  }

  .voice-header,
  .voice-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .language-chip {
    margin-left: auto;
    padding: 4px 8px;
    border-radius: 999px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 12px;
  }

  .voice-status {
    margin-top: 10px;
    color: var(--text-secondary);
    font-size: 12px;
  }

  .voice-transcript {
    min-height: 88px;
    margin-top: 8px;
    padding: 12px;
    border-radius: 10px;
    background: var(--bg-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
  }

  .voice-error {
    margin-top: 8px;
    color: var(--status-error, #ff6b6b);
    font-size: 12px;
  }

  .voice-actions {
    margin-top: 12px;
  }

  .spacer {
    flex: 1;
  }

  .voice-btn {
    border: none;
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-weight: 600;
  }

  .voice-btn:disabled {
    opacity: 0.45;
  }

  .voice-btn.primary {
    background: var(--accent-primary);
    color: var(--bg-primary);
  }
</style>
