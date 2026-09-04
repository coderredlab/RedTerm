<script lang="ts">
  import { modalFocus } from "./modal-focus";

  interface Props {
    open: boolean;
    version: string | null;
    downloaded: number;
    total: number | null;
  }

  let { open, version, downloaded, total }: Props = $props();

  let percent = $derived(
    total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0
  );

  let statusText = $derived(
    total
      ? `Downloading update… ${percent}%`
      : `Downloading update… ${(downloaded / (1024 * 1024)).toFixed(1)} MB downloaded`
  );
</script>

{#if open}
  <div
    class="update-progress-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="update-progress-title"
    aria-describedby="update-progress-status"
    tabindex="-1"
    use:modalFocus={{ onClose: () => {} }}
  >
    <div class="update-progress-backdrop" aria-hidden="true"></div>
    <section class="update-progress-dialog" aria-busy="true">
      <div class="accent-rule" aria-hidden="true"></div>
      <div class="dialog-content">
        <div class="dialog-heading">
          <div class="dialog-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 4v11" />
              <path d="m7 11 5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
          </div>
          <div>
            <div class="dialog-kicker">APPLICATION</div>
            <h2 id="update-progress-title">Downloading update</h2>
          </div>
        </div>

        <p class="dialog-message">
          {version
            ? `RedTerm Desktop ${version} is being downloaded.`
            : "The update is being downloaded."}
        </p>
        <div
          class="update-progress"
          role="progressbar"
          aria-label="Downloading update"
          aria-valuemin="0"
          aria-valuemax={total ? 100 : undefined}
          aria-valuenow={total ? percent : undefined}
        >
          <div class="update-progress-fill" style:width="{percent}%"></div>
        </div>
        <p id="update-progress-status" class="dialog-detail" role="status">{statusText}</p>
        <p class="dialog-detail">RedTerm will prompt you when the update is ready.</p>
      </div>
    </section>
  </div>
{/if}

<style>
  .update-progress-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .update-progress-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(4, 3, 5, 0.64);
    backdrop-filter: blur(5px);
  }

  .update-progress-dialog {
    position: relative;
    width: min(440px, calc(100vw - 48px));
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-primary);
    box-shadow: 0 22px 64px rgba(0, 0, 0, 0.52);
    overflow: hidden;
    animation: update-progress-in 140ms ease-out;
  }

  .accent-rule {
    height: 3px;
    background: var(--accent-primary);
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

  .update-progress {
    height: 4px;
    margin-top: 16px;
    border-radius: 2px;
    background: var(--bg-tertiary);
    overflow: hidden;
  }

  .update-progress-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--accent-primary);
  }

  .dialog-detail {
    margin: 8px 0 0;
    color: var(--text-muted);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 11px;
    line-height: 1.5;
  }

  @keyframes update-progress-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .update-progress-dialog {
      animation: none;
    }
  }
</style>
