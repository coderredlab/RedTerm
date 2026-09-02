<script lang="ts">
  import { modalFocus } from "./modal-focus";

  interface Props {
    open: boolean;
    title: string;
    message: string;
    detail: string;
    confirmLabel: string;
    destructive: boolean;
    onCancel: () => void;
    onConfirm: () => void;
  }

  let {
    open,
    title,
    message,
    detail,
    confirmLabel,
    destructive,
    onCancel,
    onConfirm,
  }: Props = $props();
</script>

{#if open}
  <div
    class="close-overlay"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="close-dialog-title"
    aria-describedby="close-dialog-message close-dialog-detail"
    tabindex="-1"
    use:modalFocus={{ onClose: onCancel }}
  >
    <div class="close-backdrop" onclick={onCancel} aria-hidden="true"></div>
    <section class="close-dialog" class:destructive>
      <div class="accent-rule" aria-hidden="true"></div>
      <div class="dialog-content">
        <div class="dialog-heading">
          <div class="dialog-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3v9" />
              <path d="M6.3 5.9a8 8 0 1 0 11.4 0" />
            </svg>
          </div>
          <div>
            <div class="dialog-kicker">APPLICATION</div>
            <h2 id="close-dialog-title">{title}</h2>
          </div>
        </div>

        <p id="close-dialog-message" class="dialog-message">{message}</p>
        <p id="close-dialog-detail" class="dialog-detail">{detail}</p>
      </div>

      <footer class="dialog-actions">
        <button class="dialog-button secondary" onclick={onCancel} data-modal-initial-focus>
          Cancel
        </button>
        <button class="dialog-button primary" class:destructive onclick={onConfirm}>
          {confirmLabel}
        </button>
      </footer>
    </section>
  </div>
{/if}

<style>
  .close-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .close-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(4, 3, 5, 0.64);
    backdrop-filter: blur(5px);
  }

  .close-dialog {
    position: relative;
    width: min(440px, calc(100vw - 48px));
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-primary);
    box-shadow: 0 22px 64px rgba(0, 0, 0, 0.52);
    overflow: hidden;
    animation: close-dialog-in 140ms ease-out;
  }

  .accent-rule {
    height: 3px;
    background: var(--accent-primary);
  }

  .close-dialog.destructive .accent-rule {
    background: var(--status-error);
  }

  .dialog-content {
    padding: 24px 24px 22px;
  }

  .dialog-heading {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .dialog-icon {
    width: 42px;
    height: 42px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--border-primary));
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-secondary));
    color: var(--accent-primary);
  }

  .close-dialog.destructive .dialog-icon {
    border-color: color-mix(in srgb, var(--status-error) 45%, var(--border-primary));
    background: color-mix(in srgb, var(--status-error) 10%, var(--bg-secondary));
    color: var(--status-error);
  }

  .dialog-icon svg {
    width: 21px;
    height: 21px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }

  .dialog-kicker {
    margin-bottom: 5px;
    color: var(--text-muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.18em;
  }

  h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .dialog-message {
    margin: 20px 0 0;
    color: var(--text-secondary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.55;
  }

  .dialog-detail {
    margin: 8px 0 0;
    color: var(--text-muted);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 11px;
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-primary);
    background: var(--bg-secondary);
  }

  .dialog-button {
    min-width: 92px;
    height: 34px;
    padding: 0 14px;
    border: 1px solid var(--border-primary);
    border-radius: 3px;
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
  }

  .dialog-button.secondary {
    background: transparent;
    color: var(--text-secondary);
  }

  .dialog-button.secondary:hover {
    border-color: var(--text-muted);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .dialog-button.primary {
    border-color: var(--accent-primary);
    background: var(--accent-primary);
    color: var(--bg-primary);
  }

  .dialog-button.primary.destructive {
    border-color: var(--status-error);
    background: var(--status-error);
    color: var(--bg-primary);
  }

  .dialog-button.primary:hover {
    filter: brightness(1.08);
  }

  .dialog-button:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }

  .dialog-button.primary.destructive:focus-visible {
    outline-color: var(--status-error);
  }

  @keyframes close-dialog-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .close-dialog {
      animation: none;
    }
  }
</style>
