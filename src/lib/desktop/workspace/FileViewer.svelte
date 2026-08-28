<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { untrack } from "svelte";
  import DOMPurify from "dompurify";
  import hljs from "highlight.js/lib/common";
  import { marked } from "marked";
  import {
    MAX_SFTP_DOWNLOAD_BYTES,
    MAX_SFTP_READ_BYTES,
    sftpDownloadFile,
    sftpReadFile,
  } from "$lib/tauri/commands";
  import {
    highlightLanguageOf,
    mimeOf,
    previewKindOf,
    formatBytes,
    type FilePreviewKind,
  } from "./file-kinds";

  export interface PreviewEntry {
    name: string;
    path: string;
    size: number;
  }

  interface Props {
    entry: PreviewEntry | null;
    sessionId: string | null;
    onClose: () => void;
  }

  let { entry, sessionId, onClose }: Props = $props();

  let loadState = $state<"idle" | "loading" | "ready" | "error">("idle");
  let errorMessage = $state("");
  let textContent = $state<string | null>(null);
  let renderedMarkdown = $state("");
  let mediaUrl = $state("");
  let codeEl: HTMLElement | null = $state(null);
  let loadToken = 0;
  // Frozen at open so switching the active tab does not re-target the
  // preview at another server's path.
  let boundSessionId = $state<string | null>(null);

  const kind = $derived(entry ? previewKindOf(entry.name) : "unknown" as FilePreviewKind);
  const language = $derived(entry ? highlightLanguageOf(entry.name) : null);
  const needsExplicitDownload = $derived(
    entry !== null &&
      (kind === "audio" ||
        kind === "video" ||
        (kind === "image" && entry.size > MAX_SFTP_READ_BYTES))
  );
  const lineCount = $derived(
    textContent === null ? 0 : textContent.split("\n").length
  );

  $effect(() => {
    if (!entry) return;
    const current = entry;
    // Only entry re-opens the preview; the session is captured (frozen)
    // inside openEntry so switching tabs does not re-target the path.
    untrack(() => void openEntry(current));
  });

  $effect(() => {
    if (codeEl && textContent !== null && (kind === "code" || kind === "text")) {
      hljs.highlightElement(codeEl);
    }
  });

  function reset() {
    loadState = "idle";
    errorMessage = "";
    textContent = null;
    renderedMarkdown = "";
    mediaUrl = "";
    codeEl = null;
  }

  async function openEntry(target: PreviewEntry) {
    const token = ++loadToken;
    boundSessionId = sessionId;
    reset();
    if (kind === "unknown") {
      // Nothing sensible to render inline; skip the fetch entirely.
      loadState = "ready";
      return;
    }
    if (needsExplicitDownload) {
      loadState = "idle";
      return;
    }
    if (!sessionId) {
      loadState = "error";
      errorMessage = "No active SSH session.";
      return;
    }
    loadState = "loading";
    await loadInline(target, token);
  }

  async function loadInline(target: PreviewEntry, token: number) {
    try {
      const content = await sftpReadFile(boundSessionId!, target.path);
      if (token !== loadToken) return;
      const dataUrl = `data:text/plain;charset=utf-8;base64,${content.content_base64}`;
      const response = await fetch(dataUrl);
      const decoded = await response.text();
      if (token !== loadToken) return;

      if (kind === "markdown") {
        const parsed = await marked.parse(decoded);
        if (token !== loadToken) return;
        renderedMarkdown = DOMPurify.sanitize(parsed);
      } else if (kind === "image") {
        mediaUrl = `data:${mimeOf(target.name)};base64,${content.content_base64}`;
      } else {
        textContent = decoded;
      }
      loadState = "ready";
    } catch (error) {
      if (token !== loadToken) return;
      loadState = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function loadViaDownload() {
    if (!entry) return;
    const token = ++loadToken;
    if (!boundSessionId) {
      loadState = "error";
      errorMessage = "No active SSH session.";
      return;
    }
    loadState = "loading";
    try {
      const downloaded = await sftpDownloadFile(boundSessionId, entry.path);
      if (token !== loadToken) return;
      mediaUrl = convertFileSrc(downloaded.local_path);
      loadState = "ready";
    } catch (error) {
      if (token !== loadToken) return;
      loadState = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={entry ? handleKeydown : undefined} />

{#if entry}
  <div class="viewer-overlay" role="dialog" aria-modal="true" aria-label={entry.name}>
    <div class="viewer-backdrop" onclick={onClose} aria-hidden="true"></div>
    <div class="viewer-modal">
      <header class="viewer-header">
        <div class="viewer-meta">
          <span class="viewer-name">{entry.name}</span>
          <span class="viewer-size">{formatBytes(entry.size)}</span>
        </div>
        <button
          class="viewer-close"
          title="Close preview"
          aria-label="Close preview"
          onclick={onClose}
        >×</button>
      </header>

      <div class="viewer-body">
        {#if loadState === "loading"}
          <div class="viewer-status">Loading preview…</div>
        {:else if loadState === "idle"}
          <div class="viewer-download-prompt">
            <p class="download-title">
              {kind === "audio" ? "Audio file" : kind === "video" ? "Video file" : "Large image"}
            </p>
            <p class="download-copy">
              {formatBytes(entry.size)} — download starts when you press play.
            </p>
            <button class="download-button" onclick={() => void loadViaDownload()}>
              {kind === "audio" || kind === "video" ? "Load & play" : "Load image"}
            </button>
          </div>
        {:else if loadState === "error"}
          <div class="viewer-status viewer-error">{errorMessage}</div>
        {:else if loadState === "ready"}
          {#if kind === "markdown" && renderedMarkdown}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- content is sanitized with DOMPurify -->
            <div class="markdown-body">{@html renderedMarkdown}</div>
          {:else if kind === "image" && mediaUrl}
            <img class="image-preview" src={mediaUrl} alt={entry.name} />
          {:else if kind === "audio" && mediaUrl}
            <div class="media-wrap">
              <audio controls src={mediaUrl}></audio>
            </div>
          {:else if kind === "video" && mediaUrl}
            <div class="media-wrap">
              <!-- svelte-ignore a11y_media_has_caption -- remote arbitrary media has no caption track -->
              <video controls src={mediaUrl}></video>
            </div>
          {:else if (kind === "code" || kind === "text") && textContent !== null}
            <div class="code-wrap">
              {#if lineCount > 0}
                <div class="line-gutter" aria-hidden="true">
                  {#each Array(lineCount) as _, index}
                    <span>{index + 1}</span>
                  {/each}
                </div>
              {/if}
              <pre class="code-block"><code
                  bind:this={codeEl}
                  class:hljs={true}
                  class={language ? `language-${language}` : ""}
                >{textContent}</code></pre>
            </div>
          {:else}
            <div class="viewer-status">No preview available for this file type.</div>
          {/if}
        {/if}
      </div>

      {#if needsExplicitDownload && loadState !== "ready"}
        <footer class="viewer-footer">
          Files over {formatBytes(MAX_SFTP_READ_BYTES)} stream to a local cache
          (limit {formatBytes(MAX_SFTP_DOWNLOAD_BYTES)}) before playback.
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .viewer-overlay {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
  }

  .viewer-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
  }

  .viewer-modal {
    position: relative;
    width: min(960px, calc(100vw - 64px));
    height: min(720px, calc(100vh - 64px));
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-primary);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .viewer-header {
    height: 46px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--border-primary);
  }

  .viewer-meta {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .viewer-name {
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .viewer-size {
    color: var(--text-muted);
    font-size: 11px;
    flex: 0 0 auto;
  }

  .viewer-close {
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .viewer-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .viewer-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }

  .viewer-status {
    margin: auto;
    color: var(--text-muted);
    font-size: 12px;
    padding: 24px;
  }

  .viewer-error {
    color: var(--status-error);
  }

  .viewer-download-prompt {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding: 24px;
  }

  .download-title {
    margin: 0;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 700;
  }

  .download-copy {
    margin: 0 0 6px;
    color: var(--text-secondary);
    font-size: 12px;
  }

  .download-button {
    padding: 10px 18px;
    border: 1px solid var(--accent-primary);
    border-radius: 3px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .download-button:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .viewer-footer {
    flex: 0 0 auto;
    padding: 8px 16px;
    border-top: 1px solid var(--border-secondary);
    color: var(--text-muted);
    font-size: 10px;
  }

  .image-preview {
    display: block;
    max-width: 100%;
    max-height: 100%;
    margin: auto;
    object-fit: contain;
  }

  .media-wrap {
    margin: auto;
    width: 100%;
    display: flex;
    justify-content: center;
    padding: 24px;
  }

  .media-wrap audio {
    width: min(480px, 100%);
  }

  .media-wrap video {
    width: min(760px, 100%);
    max-height: 70vh;
  }

  .markdown-body {
    max-width: 760px;
    width: 100%;
    margin: 0 auto;
    padding: 24px 32px;
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.65;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3) {
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-secondary);
    padding-bottom: 6px;
  }

  .markdown-body :global(a) {
    color: var(--accent-primary);
  }

  .markdown-body :global(code) {
    padding: 2px 5px;
    border-radius: 3px;
    background: var(--bg-tertiary);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 12px;
  }

  .markdown-body :global(pre code) {
    display: block;
    padding: 12px;
    overflow-x: auto;
  }

  .markdown-body :global(table) {
    border-collapse: collapse;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--border-primary);
    padding: 6px 10px;
  }

  .code-wrap {
    display: flex;
    min-width: max-content;
    min-height: 0;
  }

  .line-gutter {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    padding: 12px 8px;
    border-right: 1px solid var(--border-secondary);
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 12px;
    line-height: 1.5;
    text-align: right;
    user-select: none;
    position: sticky;
    left: 0;
  }

  .code-block {
    margin: 0;
    padding: 12px 16px;
    background: var(--terminal-bg);
    color: var(--terminal-fg);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 12px;
    line-height: 1.5;
    overflow-x: auto;
  }

  .code-block code {
    white-space: pre;
  }
</style>
