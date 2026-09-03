<script lang="ts">
  import { modalFocus } from "./modal-focus";

  interface Props {
    open: boolean;
    title: string;
    label: string;
    confirmLabel: string;
    initialValue?: string;
    onCancel: () => void;
    onConfirm: (name: string) => void;
  }

  let { open, title, label, confirmLabel, initialValue = "", onCancel, onConfirm }: Props =
    $props();

  let name = $state("");
  let error = $state("");

  $effect(() => {
    if (open) {
      name = initialValue;
      error = "";
    }
  });

  function confirmName() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      error = "Enter a name.";
      return;
    }
    onConfirm(trimmed);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    confirmName();
  }
</script>

{#if open}
  <div
    class="name-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="name-dialog-title"
    aria-describedby="name-dialog-label"
    tabindex="-1"
    use:modalFocus={{ onClose: onCancel }}
  >
    <div class="name-backdrop" onclick={onCancel} aria-hidden="true"></div>
    <section class="name-dialog">
      <div class="accent-rule" aria-hidden="true"></div>
      <div class="name-content">
        <h2 id="name-dialog-title">{title}</h2>
        <form class="name-form" onsubmit={submit}>
          <label class="name-label" for="explorer-entry-name">{label}</label>
          <input
            id="explorer-entry-name"
            type="text"
            autocomplete="off"
            spellcheck="false"
            bind:value={name}
            data-modal-initial-focus
            oninput={() => (error = "")}
          />
          {#if error}
            <p class="name-error" role="alert">{error}</p>
          {/if}
        </form>
      </div>
      <footer class="name-actions">
        <button type="button" class="name-cancel" onclick={onCancel}>Cancel</button>
        <button type="button" class="name-confirm" onclick={confirmName}>{confirmLabel}</button>
      </footer>
    </section>
  </div>
{/if}

<style>
  .name-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
  }

  .name-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
  }

  .name-dialog {
    position: relative;
    width: min(360px, calc(100vw - 48px));
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
  }

  .accent-rule {
    height: 3px;
    background: var(--accent-primary);
  }

  .name-content {
    padding: 16px 18px 4px;
  }

  .name-content h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .name-label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .name-form input {
    width: 100%;
    padding: 8px 10px;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    outline: none;
  }

  .name-form input:focus {
    border-color: var(--accent-primary);
  }

  .name-error {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--status-error);
  }

  .name-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 18px 16px;
  }

  .name-cancel,
  .name-confirm {
    padding: 7px 14px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }

  .name-cancel {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .name-confirm {
    background: var(--accent-primary);
    color: #ffffff;
  }
</style>
