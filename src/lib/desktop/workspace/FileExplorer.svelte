<script lang="ts">
  import {
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

  $effect(() => {
    // Restart browsing whenever the active session changes.
    sessionId;
    path = "/";
    void navigate("/");
  });

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
      class="path-up"
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
      class="path-refresh"
      title="Refresh"
      aria-label="Refresh"
      disabled={loading}
      onclick={() => void navigate(path)}
    >⟳</button>
  </div>

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
        <button
          class="entry"
          class:dir={entry.is_dir}
          onclick={() =>
            entry.is_dir
              ? void navigate(joinPath(path, entry.name))
              : onPreview({
                  name: entry.name,
                  path: joinPath(path, entry.name),
                  size: entry.size,
                })}
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
        </button>
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

  .path-up,
  .path-refresh {
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

  .path-up:disabled,
  .path-refresh:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .path-up:hover:not(:disabled),
  .path-refresh:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
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
    grid-template-columns: 18px minmax(0, 1fr) auto auto;
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

  .explorer-status {
    padding: 16px 8px;
    color: var(--text-muted);
    font-size: 11px;
  }

  .explorer-error {
    color: var(--status-error);
  }
</style>
