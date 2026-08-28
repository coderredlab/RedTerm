<script lang="ts">
  import {
    sftpDownloadToDownloads,
    sftpHomeDir,
    sftpListDir,
    type SftpDirEntry,
  } from "$lib/tauri/commands";
  import {
    formatBytes,
    formatTimestamp,
    previewKindOf,
  } from "./file-kinds";

  interface Props {
    sessionId: string | null;
    onPreview: (entry: { name: string; path: string; size: number }) => void;
  }

  let { sessionId, onPreview }: Props = $props();

  let path = $state("/");
  let entries = $state<SftpDirEntry[] | null>(null);
  let loading = $state(false);
  let errorMessage = $state("");
  let loadToken = 0;
  let homePath = $state<string | null>(null);
  let statusMessage = $state("");
  let downloadingPaths = $state<string[]>([]);
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  function showStatus(message: string) {
    statusMessage = message;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusMessage = "";
    }, 6000);
  }

  $effect(() => {
    // Restart browsing whenever the active session changes; start at home.
    if (!sessionId) {
      loadToken += 1;
      entries = null;
      errorMessage = "";
      loading = false;
      path = "/";
      homePath = null;
      return;
    }
    homePath = null;
    void openHome();
  });

  async function openHome() {
    if (!sessionId) return;
    const token = ++loadToken;
    loading = true;
    errorMessage = "";
    try {
      const home = await sftpHomeDir(sessionId);
      if (token !== loadToken) return;
      homePath = home || "/";
      await navigate(homePath);
    } catch (error) {
      if (token !== loadToken) return;
      homePath = "/";
      await navigate("/");
    }
  }

  async function navigate(target: string) {
    if (!sessionId) return;
    const token = ++loadToken;
    loading = true;
    errorMessage = "";
    try {
      const result = await sftpListDir(sessionId, target);
      if (token !== loadToken) return;
      entries = result;
      path = target;
    } catch (error) {
      if (token !== loadToken) return;
      entries = null;
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === loadToken) {
        loading = false;
      }
    }
  }

  async function downloadEntry(entry: SftpDirEntry) {
    const target = joinPath(path, entry.name);
    if (!sessionId || downloadingPaths.includes(target)) return;
    downloadingPaths = [...downloadingPaths, target];
    try {
      const saved = await sftpDownloadToDownloads(sessionId, target);
      showStatus(`Saved to ${saved.local_path}`);
    } catch (error) {
      showStatus(
        `Download failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      downloadingPaths = downloadingPaths.filter((candidate) => candidate !== target);
    }
  }

  function parentPath(current: string): string {
    if (current === "/") return "/";
    const trimmed = current.replace(/\/+$/, "");
    const cut = trimmed.lastIndexOf("/");
    return cut <= 0 ? "/" : trimmed.slice(0, cut);
  }

  function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
  }

  function breadcrumbSegments(current: string): Array<{ label: string; path: string }> {
    const segments = [{ label: "/", path: "/" }];
    let accumulated = "";
    for (const part of current.split("/").filter(Boolean)) {
      accumulated += `/${part}`;
      segments.push({ label: part, path: accumulated });
    }
    return segments;
  }

  function fileIconOf(name: string, isDir: boolean): string {
    if (isDir) return "▸";
    const kind = previewKindOf(name);
    if (kind === "image") return "▣";
    if (kind === "audio") return "♪";
    if (kind === "video") return "▶";
    if (kind === "markdown" || kind === "code" || kind === "text") return "≡";
    return "·";
  }
</script>

<div class="file-explorer">
  <div class="path-bar">
    <button
      class="path-btn"
      title="Home"
      aria-label="Home directory"
      disabled={loading || !sessionId}
      onclick={() => void openHome()}
    >⌂</button>
    <button
      class="path-btn"
      title="Parent directory"
      aria-label="Parent directory"
      disabled={loading || path === "/"}
      onclick={() => void navigate(parentPath(path))}
    >↑</button>
    <div class="path-breadcrumbs">
      {#each breadcrumbSegments(path) as segment (segment.path)}
        <button
          class="path-segment"
          onclick={() => void navigate(segment.path)}
        >{segment.label}</button>
      {/each}
    </div>
    <button
      class="path-btn"
      title="Refresh"
      aria-label="Refresh"
      disabled={loading}
      onclick={() => void navigate(path)}
    >⟳</button>
  </div>

  {#if statusMessage}
    <div class="explorer-toast" role="status">{statusMessage}</div>
  {/if}

  <div class="entry-list">
    {#if !sessionId}
      <div class="explorer-status">Connect to a server to browse files.</div>
    {:else if loading}
      <div class="explorer-status">Loading…</div>
    {:else if errorMessage}
      <div class="explorer-status explorer-error">{errorMessage}</div>
    {:else if entries !== null}
      {#if path !== "/"}
        <button
          class="entry dir"
          onclick={() => void navigate(parentPath(path))}
        >
          <span class="entry-icon" aria-hidden="true">◂</span>
          <span class="entry-name">..</span>
        </button>
      {/if}
      {#each entries as entry (entry.name)}
        <div
          class="entry"
          class:dir={entry.is_dir}
          role="button"
          tabindex="0"
          onclick={() =>
            entry.is_dir
              ? void navigate(joinPath(path, entry.name))
              : onPreview({
                  name: entry.name,
                  path: joinPath(path, entry.name),
                  size: entry.size,
                })}
          onkeydown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (entry.is_dir) {
                void navigate(joinPath(path, entry.name));
              } else {
                onPreview({
                  name: entry.name,
                  path: joinPath(path, entry.name),
                  size: entry.size,
                });
              }
            }
          }}
        >
          <span class="entry-icon" aria-hidden="true">
            {fileIconOf(entry.name, entry.is_dir)}
          </span>
          <span class="entry-name" title={entry.name}>{entry.name}</span>
          <span class="entry-size">
            {entry.is_dir ? "" : formatBytes(entry.size)}
          </span>
          <span class="entry-mtime">
            {entry.is_dir ? "" : formatTimestamp(entry.mtime)}
          </span>
          {#if !entry.is_dir}
            <button
              class="entry-download"
              class:busy={downloadingPaths.includes(joinPath(path, entry.name))}
              title={
                downloadingPaths.includes(joinPath(path, entry.name))
                  ? "Downloading…"
                  : "Download to local Downloads folder"
              }
              aria-label={`Download ${entry.name}`}
              onclick={(event) => {
                event.stopPropagation();
                void downloadEntry(entry);
              }}
            >⭳</button>
          {/if}
        </div>
      {:else}
        <div class="explorer-status">Empty directory.</div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .file-explorer {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .path-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-secondary);
  }

  .path-btn {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .path-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .path-btn:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .explorer-toast {
    flex: 0 0 auto;
    margin: 4px 8px 0;
    padding: 5px 10px;
    border: 1px solid var(--border-secondary);
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path-breadcrumbs {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .path-breadcrumbs::-webkit-scrollbar {
    display: none;
  }

  .path-segment {
    border: 0;
    padding: 2px 5px;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 11px;
    white-space: nowrap;
    cursor: pointer;
  }

  .path-segment:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .entry-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
  }

  .entry {
    width: 100%;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }

  .entry:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .entry:focus-visible {
    outline: 1px solid var(--accent-primary);
  }

  .entry.dir .entry-name {
    color: var(--accent-primary);
    font-weight: 700;
  }

  .entry-icon {
    text-align: center;
    flex: 0 0 auto;
  }

  .entry-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-size,
  .entry-mtime {
    color: var(--text-muted);
    font-size: 10px;
    white-space: nowrap;
  }

  .entry-mtime {
    min-width: 96px;
    text-align: right;
  }

  .entry-download {
    width: 22px;
    height: 20px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 100ms ease;
  }

  .entry:hover .entry-download,
  .entry-download:focus-visible,
  .entry-download.busy {
    opacity: 1;
  }

  .entry-download:hover {
    background: var(--bg-tertiary);
    color: var(--accent-primary);
  }

  .entry-download.busy {
    color: var(--accent-primary);
    cursor: progress;
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }

  .explorer-status {
    padding: 16px 8px;
    color: var(--text-muted);
    font-size: 11px;
  }

  .explorer-error {
    color: var(--status-error);
  }
</style>
