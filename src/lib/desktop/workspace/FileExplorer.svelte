<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import {
    listenDownloadProgress,
    chooseDownloadSavePath,
    sanitizeDownloadDialogFileName,
    localCreateDir,
    localCreateFile,
    localDownloadToDir,
    localHomeDir,
    localListDir,
    localRemovePath,
    previewCacheAcquire,
    previewCacheRelease,
    sftpCreateDir,
    sftpCreateFile,
    sftpDownloadToDir,
    sftpHomeDir,
    sftpListDir,
    sftpRemovePath,
    type SftpDirEntry,
  } from "$lib/tauri/commands";
  import {
    formatBytes,
    formatTimestamp,
    previewKindOf,
  } from "./file-kinds";
  import {
    breadcrumbSegments,
    isRootPath,
    isValidExplorerEntryName,
    joinPath,
    parentPath,
  } from "./explorer-path";
  import { sortExplorerEntries } from "./explorer-sort";
  import { desktopPrefsStore } from "./desktop-prefs.svelte";
  import CloseConfirmationModal from "./CloseConfirmationModal.svelte";
  import ExplorerNameDialog from "./ExplorerNameDialog.svelte";

  interface Props {
    kind: "ssh" | "local" | null;
    sessionId: string | null;
    initialPath: string | null;
    onPathChange: (path: string) => void;
    onPreview: (entry: { name: string; path: string; size: number }) => void;
    cachedLocalPathFor: (path: string) => string | null;
  }

  let {
    kind,
    sessionId,
    initialPath,
    onPathChange,
    onPreview,
    cachedLocalPathFor,
  }: Props = $props();

  let path = $state("/");
  let entries = $state<SftpDirEntry[] | null>(null);
  let loading = $state(false);
  let errorMessage = $state("");
  let loadToken = 0;
  let homePath = $state<string | null>(null);
  let statusMessage = $state("");
  let downloadingPaths = $state<string[]>([]);
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let downloads = $state<Record<string, { transferred: number; total: number | null }>>({});
  let breadcrumbViewport: HTMLDivElement | undefined;
  let destroyed = false;
  const canBrowse = $derived(kind === "local" || Boolean(sessionId));
  // Local browsing is scoped to home: no navigation above it.
  const atLocalHome = $derived(kind === "local" && homePath !== null && path === homePath);
  const sort = $derived(desktopPrefsStore.prefs.explorerSort);
  const sortedEntries = $derived(entries === null ? null : sortExplorerEntries(entries, sort));

  let contextMenu = $state<{ x: number; y: number; entry: SftpDirEntry | null } | null>(null);
  let deleteTarget = $state<SftpDirEntry | null>(null);
  let nameDialog = $state<{ mode: "file" | "folder" } | null>(null);

  const menuPosition = $derived.by(() => {
    if (contextMenu === null) return null;
    return {
      left: Math.max(4, Math.min(contextMenu.x, window.innerWidth - 172)),
      top: Math.max(4, Math.min(contextMenu.y, window.innerHeight - 120)),
    };
  });

  $effect(() => {
    if (contextMenu === null) return;
    const close = () => (contextMenu = null);
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeydown);
    };
  });

  function toggleSort(key: "name" | "date") {
    const direction =
      sort.key === key
        ? sort.direction === "asc"
          ? "desc"
          : "asc"
        : key === "date"
          ? "desc"
          : "asc";
    desktopPrefsStore.setExplorerSort({ key, direction });
  }

  function openEntryContextMenu(event: MouseEvent, entry: SftpDirEntry) {
    event.preventDefault();
    event.stopPropagation();
    contextMenu = { x: event.clientX, y: event.clientY, entry };
  }

  function openBackgroundContextMenu(event: MouseEvent) {
    event.preventDefault();
    contextMenu = { x: event.clientX, y: event.clientY, entry: null };
  }

  function startCreate(mode: "file" | "folder") {
    closeContextMenu();
    nameDialog = { mode };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  async function createEntry(mode: "file" | "folder", name: string) {
    nameDialog = null;
    if (!canBrowse) return;
    if (!isValidExplorerEntryName(name)) {
      showStatus("That name cannot be used.");
      return;
    }
    const target = joinPath(path, name);
    try {
      if (kind === "local") {
        if (mode === "folder") await localCreateDir(target);
        else await localCreateFile(target);
      } else if (mode === "folder") {
        await sftpCreateDir(sessionId!, target);
      } else {
        await sftpCreateFile(sessionId!, target);
      }
      showStatus(`Created ${name}`);
    } catch (error) {
      showStatus(`Create failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await navigate(path);
  }

  async function removeEntry() {
    const entry = deleteTarget;
    deleteTarget = null;
    if (!entry || !canBrowse) return;
    const target = joinPath(path, entry.name);
    try {
      if (kind === "local") await localRemovePath(target);
      else await sftpRemovePath(sessionId!, target);
      showStatus(`Deleted ${entry.name}`);
    } catch (error) {
      showStatus(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await navigate(path);
  }

  onDestroy(() => {
    destroyed = true;
    loadToken += 1;
  });

  $effect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenDownloadProgress((event) => {
      downloads[event.path] = {
        transferred: event.transferred,
        total: event.total,
      };
      if (event.total !== null && event.transferred >= event.total) {
        const target = event.path;
        setTimeout(() => {
          delete downloads[target];
        }, 1500);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  });

  $effect(() => {
    path;
    const viewport = breadcrumbViewport;
    if (!viewport) return;

    const scrollToEnd = () => {
      viewport.scrollLeft = viewport.scrollWidth;
    };
    scrollToEnd();

    const observer = new ResizeObserver(scrollToEnd);
    observer.observe(viewport);
    return () => observer.disconnect();
  });

  function showStatus(message: string) {
    statusMessage = message;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusMessage = "";
    }, 6000);
  }

  function baseName(target: string): string {
    const parts = target.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? target;
  }

  $effect(() => {
    // Restart browsing whenever the active session changes, restoring this pane's path.
    if (!canBrowse) {
      loadToken += 1;
      entries = null;
      errorMessage = "";
      loading = false;
      path = "/";
      homePath = null;
      return;
    }
    homePath = null;
    void openHome(untrack(() => initialPath));
  });

  async function openHome(restoredPath: string | null = null) {
    const token = ++loadToken;
    loading = true;
    errorMessage = "";
    try {
      const home =
        kind === "local"
          ? await localHomeDir()
          : sessionId
            ? await sftpHomeDir(sessionId)
            : "/";
      if (destroyed || token !== loadToken) return;
      homePath = home || "/";
      const target =
        restoredPath &&
        (kind !== "local" ||
          restoredPath === homePath ||
          restoredPath.startsWith(`${homePath}/`))
          ? restoredPath
          : homePath;
      await navigate(target);
    } catch (error) {
      if (destroyed || token !== loadToken) return;
      if (kind === "local") {
        homePath = null;
        loading = false;
        errorMessage = "Home directory could not be resolved.";
      } else {
        homePath = "/";
        await navigate("/");
      }
    }
  }

  async function navigate(target: string) {
    if (destroyed || !canBrowse) return;
    const token = ++loadToken;
    loading = true;
    errorMessage = "";
    try {
      const result =
        kind === "local"
          ? await localListDir(target)
          : await sftpListDir(sessionId!, target);
      if (destroyed || token !== loadToken) return;
      entries = result;
      path = target;
      onPathChange(target);
    } catch (error) {
      if (destroyed || token !== loadToken) return;
      entries = null;
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (!destroyed && token === loadToken) {
        loading = false;
      }
    }
  }

  async function downloadEntry(entry: SftpDirEntry) {
    const target = joinPath(path, entry.name);
    if (!canBrowse || downloadingPaths.includes(target)) return;
    // Open a save dialog pre-filled with the file name before transferring.
    let saveTarget: string | null = null;
    try {
      saveTarget = await chooseDownloadSavePath(sanitizeDownloadDialogFileName(entry.name));
    } catch {
      saveTarget = null;
    }
    if (!saveTarget) return;
    if (downloadingPaths.includes(target)) return;
    downloadingPaths = [...downloadingPaths, target];
    downloads[target] = { transferred: 0, total: entry.size || null };
    let leasedCachedPath: string | null = null;
    try {
      const cachedLocalPath =
        kind === "ssh" ? cachedLocalPathFor(target) : null;
      if (cachedLocalPath && await previewCacheAcquire(cachedLocalPath)) {
        leasedCachedPath = cachedLocalPath;
      }
      const saved = leasedCachedPath
        ? await localDownloadToDir(leasedCachedPath, saveTarget)
        : kind === "local"
          ? await localDownloadToDir(target, saveTarget)
          : await sftpDownloadToDir(sessionId!, target, saveTarget);
      showStatus(`Saved to ${saved.local_path}`);
    } catch (error) {
      showStatus(
        `Download failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (leasedCachedPath) {
        void previewCacheRelease(leasedCachedPath).catch((error) => {
          console.error("[FileExplorer] failed to release preview cache:", error);
        });
      }
      downloadingPaths = downloadingPaths.filter((candidate) => candidate !== target);
      setTimeout(() => {
        delete downloads[target];
      }, 1500);
    }
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
      disabled={loading || !canBrowse}
      onclick={() => void openHome()}
    >⌂</button>
    <button
      class="path-btn"
      title="Parent directory"
      aria-label="Parent directory"
      disabled={loading || isRootPath(path) || atLocalHome}
      onclick={() => void navigate(parentPath(path))}
    >↑</button>
    <div class="path-breadcrumbs" bind:this={breadcrumbViewport}>
      {#each breadcrumbSegments(path) as segment (segment.path)}
        {#if kind !== "local" || homePath === null || segment.path === homePath || segment.path.startsWith(`${homePath}/`)}
          <button
            class="path-segment"
            onclick={() => void navigate(segment.path)}
          >{segment.label}</button>
        {/if}
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

  <div class="sort-bar" role="group" aria-label="Sort entries">
    <button
      class="sort-btn"
      class:active={sort.key === "name"}
      title="Sort by name"
      onclick={() => toggleSort("name")}
    >
      Name{sort.key === "name" ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
    </button>
    <button
      class="sort-btn"
      class:active={sort.key === "date"}
      title="Sort by date"
      onclick={() => toggleSort("date")}
    >
      Date{sort.key === "date" ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
    </button>
  </div>
  {#if statusMessage}
    <div class="explorer-toast" role="status">{statusMessage}</div>
  {/if}

  {#each Object.entries(downloads) as [target, progress] (target)}
    <div class="download-progress">
      <div class="download-progress-info">
        <span class="download-progress-name">{baseName(target)}</span>
        <span class="download-progress-bytes">
          {formatBytes(progress.transferred)}{progress.total !== null
            ? ` / ${formatBytes(progress.total)}`
            : ""}
        </span>
      </div>
      <div class="download-track">
        <div
          class="download-fill"
          class:indeterminate={progress.total === null}
          style:width={progress.total !== null && progress.total > 0
            ? `${Math.min(100, (progress.transferred / progress.total) * 100)}%`
            : "100%"}
        ></div>
      </div>
    </div>
  {/each}

  <div class="entry-list" role="list" oncontextmenu={openBackgroundContextMenu}>
    {#if !canBrowse}
      <div class="explorer-status">Connect to a server to browse files.</div>
    {:else if loading}
      <div class="explorer-status">Loading…</div>
    {:else if errorMessage}
      <div class="explorer-status explorer-error">{errorMessage}</div>
    {:else if entries !== null}
      {#if !isRootPath(path) && !atLocalHome}
        <button
          class="entry dir"
          onclick={() => void navigate(parentPath(path))}
        >
          <span class="entry-icon" aria-hidden="true">◂</span>
          <span class="entry-name">..</span>
        </button>
      {/if}
      {#each sortedEntries as entry (entry.name)}
        <div
          class="entry"
          class:dir={entry.is_dir}
          role="listitem"
          oncontextmenu={(event) => openEntryContextMenu(event, entry)}
        >
          <button
            class="entry-main"
            aria-label={entry.name}
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
            <span class="entry-meta">
              <span class="entry-size">
                {entry.is_dir ? "" : formatBytes(entry.size)}
              </span>
              <span class="entry-mtime">
                {entry.is_dir ? "" : formatTimestamp(entry.mtime)}
              </span>
            </span>
          </button>
          {#if !entry.is_dir}
            <button
              class="entry-download"
              class:busy={downloadingPaths.includes(joinPath(path, entry.name))}
              title={
                downloadingPaths.includes(joinPath(path, entry.name))
                  ? "Downloading…"
                  : "Choose a folder and download"
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

  {#if contextMenu !== null && menuPosition !== null}
    <div
      class="entry-context-menu"
      role="menu"
      style:left="{menuPosition.left}px"
      style:top="{menuPosition.top}px"
    >
      {#if contextMenu.entry !== null && !contextMenu.entry.is_dir && !downloadingPaths.includes(joinPath(path, contextMenu.entry.name))}
        <button
          type="button"
          role="menuitem"
          onclick={() => {
            const entry = contextMenu?.entry ?? null;
            closeContextMenu();
            if (entry) void downloadEntry(entry);
          }}
        >Download</button>
      {/if}
      <button type="button" role="menuitem" onclick={() => startCreate("file")}>New file</button>
      <button type="button" role="menuitem" onclick={() => startCreate("folder")}>New folder</button>
      {#if contextMenu.entry !== null}
        <button
          type="button"
          role="menuitem"
          class="danger"
          onclick={() => {
            const entry = contextMenu?.entry ?? null;
            closeContextMenu();
            deleteTarget = entry;
          }}
        >Delete</button>
      {/if}
    </div>
  {/if}

  <ExplorerNameDialog
    open={nameDialog !== null}
    title={nameDialog?.mode === "folder" ? "New folder" : "New file"}
    label="Name"
    confirmLabel={nameDialog?.mode === "folder" ? "Create folder" : "Create file"}
    onCancel={() => (nameDialog = null)}
    onConfirm={(value) => void createEntry(nameDialog?.mode ?? "file", value)}
  />

  <CloseConfirmationModal
    open={deleteTarget !== null}
    title="Delete"
    message={deleteTarget !== null ? `Delete "${deleteTarget.name}"?` : ""}
    detail={
      deleteTarget?.is_dir
        ? "Everything inside this folder will also be deleted. This cannot be undone."
        : "This cannot be undone."
    }
    confirmLabel="Delete"
    destructive={true}
    onCancel={() => (deleteTarget = null)}
    onConfirm={() => void removeEntry()}
  />
</div>

<style>
  .file-explorer {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
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

  .download-progress {
    flex: 0 0 auto;
    margin: 4px 8px 0;
    padding: 6px 10px;
    border: 1px solid var(--border-secondary);
    border-radius: 3px;
    background: var(--bg-tertiary);
  }

  .download-progress-info {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 4px;
  }

  .download-progress-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: 10px;
  }

  .download-progress-bytes {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: 10px;
  }

  .download-track {
    height: 4px;
    border-radius: 2px;
    background: var(--bg-primary);
    overflow: hidden;
  }

  .download-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--accent-primary);
    transition: width 150ms ease;
  }

  .download-fill.indeterminate {
    animation: indeterminate 1.2s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(100%);
    }
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
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms ease;
    content-visibility: auto;
    contain-intrinsic-size: auto 22px;
  }

  .entry-main {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    padding: 0;
  }

  .entry:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .entry-main:focus-visible {
    outline: 1px solid var(--accent-primary);
    outline-offset: -1px;
    border-radius: 3px;
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

  .entry-meta {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .entry-size,
  .entry-mtime {
    color: var(--text-muted);
    font-size: 10px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  @container (max-width: 250px) {
    .entry-mtime {
      display: none;
    }
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

  .sort-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border-secondary);
  }

  .sort-btn {
    padding: 3px 7px;
    font-size: 10px;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    white-space: nowrap;
  }

  .sort-btn:hover {
    color: var(--text-primary);
  }

  .sort-btn.active {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .entry-context-menu {
    position: fixed;
    z-index: 80;
    min-width: 140px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
  }

  .entry-context-menu button {
    padding: 7px 10px;
    text-align: left;
    font-size: 12px;
    color: var(--text-primary);
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
  }

  .entry-context-menu button:hover {
    background: var(--bg-tertiary);
  }

  .entry-context-menu button.danger {
    color: var(--status-error);
  }
</style>
