<script module lang="ts">
  import type { SftpDownloadedFile } from "$lib/tauri/commands";

  interface PendingDocumentDownload {
    sourceKey: string;
    promise: Promise<SftpDownloadedFile>;
  }

  const pendingDocumentDownloads = new Map<string, PendingDocumentDownload>();
  const freshlyDownloadedDocumentPaths = new Map<string, string>();

  function getPendingDocumentDownload(
    documentId: string,
    sourceKey: string,
    start: () => Promise<SftpDownloadedFile>
  ): PendingDocumentDownload {
    const existing = pendingDocumentDownloads.get(documentId);
    if (existing?.sourceKey === sourceKey) return existing;
    const request = { sourceKey, promise: start() };
    pendingDocumentDownloads.set(documentId, request);
    return request;
  }
</script>

<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
  import { languages } from "@codemirror/language-data";
  import { Compartment, EditorState } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { tags } from "@lezer/highlight";
  import { basicSetup } from "codemirror";
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import { classifyMarkdownLink } from "./markdown-links";
  import { confirmAction } from "$lib/tauri/commands";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { onDestroy, untrack } from "svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { tabsStore, type PaneDocument } from "$lib/stores/tabs.svelte";
  import { getThemeById, isLightTheme, THEMES } from "$lib/styles/themes";
  import {
    MAX_SFTP_DOWNLOAD_BYTES,
    MAX_SFTP_READ_BYTES,
    chooseDownloadSavePath,
    splitSavePath,
    localDownloadFile,
    localDownloadToDir,
    localReadFile,
    previewCacheAcquire,
    previewCacheRelease,
    localWriteFile,
    sftpDownloadFile,
    sftpDownloadToDir,
    sftpReadFile,
    sftpWriteFile,
  } from "$lib/tauri/commands";
  import {
    formatBytes,
    mimeOf,
    previewKindOf,
    type FilePreviewKind,
  } from "./file-kinds";

  interface Props {
    tabId: string;
    document: PaneDocument;
    visible: boolean;
    active: boolean;
  }

  let { tabId, document, visible, active }: Props = $props();

  let loadState = $state<"loading" | "ready" | "idle" | "error">("loading");
  let errorMessage = $state("");
  let actionError = $state("");
  let currentContent = $state(untrack(() => document.content ?? ""));
  let renderedMarkdown = $state("");
  let mediaUrl = $state("");
  let editorHost: HTMLDivElement | null = $state(null);
  let editorView = $state.raw<EditorView | null>(null);
  const editorThemeCompartment = new Compartment();
  let appliedEditorDarkTheme: boolean | null = null;
  let mode = $state<"edit" | "preview">("edit");
  let downloading = $state(false);
  let downloadedHint = $state(false);
  let loadToken = 0;
  let markdownToken = 0;
  let markdownLinkOpening = false;

  /** Middle-click / auxclick must not navigate the addressless webview either. */
  function blockMarkdownAuxiliaryClick(event: MouseEvent) {
    const clicked = event.target instanceof Element ? event.target.closest("a") : null;
    if (!clicked) return;
    const href = clicked.getAttribute("href");
    if (href === null || href.startsWith("#")) return;
    event.preventDefault();
  }

  async function handleMarkdownLinkClick(event: MouseEvent) {
    const clicked = event.target instanceof Element ? event.target.closest("a") : null;
    if (!clicked) return;
    const href = clicked.getAttribute("href");
    if (href === null) return;
    const decision = classifyMarkdownLink(href);
    if (decision.action === "anchor") return;
    event.preventDefault();
    if (decision.action !== "open-external" || markdownLinkOpening) return;
    markdownLinkOpening = true;
    try {
      if (
        await confirmAction(
          `Open this link in your default browser?\n\n${decision.url}\n\nThe link came from a remote document.`
        )
      ) {
        await openUrl(decision.url);
      }
    } catch (error) {
      console.error("[PaneDocumentView] failed to open markdown link:", error);
    } finally {
      markdownLinkOpening = false;
    }
  }
  let editorToken = 0;
  let leasedMediaPath = "";
  let recoverableCachedMedia = false;
  let cachedPathChangeAction: "load-document" | "load-media" | "ignore" | null = null;

  const boundKind = untrack(() => document.sourceKind);
  const boundPath = untrack(() => document.path);
  let fileKind = $state<FilePreviewKind>(
    untrack(() => previewKindOf(document.name))
  );
  const editable = $derived(
    fileKind === "code" || fileKind === "text" || fileKind === "markdown"
  );
  const editorUsesDarkTheme = $derived(
    !isLightTheme(getThemeById(settingsStore.theme) ?? THEMES[0]!)
  );
  const needsExplicitDownload = $derived(
    fileKind === "audio" ||
    fileKind === "video" ||
    (fileKind === "image" && document.size > MAX_SFTP_READ_BYTES)
  );
  const markdownTags = [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "code", "ul", "ol", "li", "strong", "em",
    "del", "a", "img", "table", "thead", "tbody", "tr", "th", "td"
  ];
  const markdownAttributes = [
    "href", "title", "src", "alt", "colspan", "rowspan"
  ];

  function lineSeparatorOf(content: string): "\r\n" | "\r" | "\n" {
    let sawCrLf = false;
    let sawCr = false;
    let sawLf = false;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === "\r") {
        if (content[index + 1] === "\n") {
          sawCrLf = true;
          index += 1;
        } else {
          sawCr = true;
        }
      } else if (content[index] === "\n") {
        sawLf = true;
      }
    }
    if (sawCrLf && !sawCr && !sawLf) return "\r\n";
    if (sawCr && !sawCrLf && !sawLf) return "\r";
    return "\n";
  }

  function decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function releaseMediaLease() {
    const localPath = leasedMediaPath;
    leasedMediaPath = "";
    if (!localPath) return;
    void previewCacheRelease(localPath).catch((error) => {
      console.error("[PaneDocumentView] failed to release preview cache:", error);
    });
  }

  function revokeMediaUrl() {
    releaseMediaLease();
    recoverableCachedMedia = false;
    if (mediaUrl.startsWith("blob:")) URL.revokeObjectURL(mediaUrl);
    mediaUrl = "";
  }

  async function acquireMediaPath(localPath: string, token: number, recoverOnError: boolean): Promise<boolean> {
    const available = await previewCacheAcquire(localPath);
    if (token !== loadToken) {
      if (available) {
        void previewCacheRelease(localPath).catch((error) => {
          console.error("[PaneDocumentView] failed to release preview cache:", error);
        });
      }
      return false;
    }
    if (!available) return false;
    leasedMediaPath = localPath;
    recoverableCachedMedia = recoverOnError;
    mediaUrl = convertFileSrc(localPath);
    loadState = "ready";
    return true;
  }

  async function readInline() {
    return boundKind === "local"
      ? localReadFile(boundPath)
      : sftpReadFile(document.sourceSessionId!, boundPath);
  }

  async function downloadToCache(): Promise<boolean> {
    const sourceSessionId = boundKind === "ssh" ? document.sourceSessionId : null;
    const sourceKey = `${boundKind}\0${sourceSessionId ?? ""}\0${boundPath}`;
    const request = getPendingDocumentDownload(
      document.id,
      sourceKey,
      () => boundKind === "local"
        ? localDownloadFile(boundPath)
        : sftpDownloadFile(sourceSessionId!, boundPath)
    );
    try {
      const downloaded = await request.promise;
      if (pendingDocumentDownloads.get(document.id) !== request) return false;
      const currentTab = tabsStore.tabs.find((candidate) =>
        candidate.documents.some((candidateDocument) => candidateDocument.id === document.id)
      );
      const current = currentTab?.documents.find(
        (candidate) => candidate.id === document.id
      );
      if (
        !currentTab ||
        !current ||
        current.sourceKind !== boundKind ||
        current.path !== boundPath ||
        (boundKind === "ssh" && current.sourceSessionId !== sourceSessionId) ||
        current.cachedLocalPath !== null
      ) return false;
      freshlyDownloadedDocumentPaths.set(document.id, downloaded.local_path);
      tabsStore.setDocumentCachedLocalPath(
        currentTab.id,
        document.id,
        downloaded.local_path
      );
      return true;
    } finally {
      if (pendingDocumentDownloads.get(document.id) === request) {
        pendingDocumentDownloads.delete(document.id);
      }
    }
  }

  async function loadDocument() {
    const token = ++loadToken;
    loadState = "loading";
    errorMessage = "";
    revokeMediaUrl();

    if (
      (editable || fileKind === "unknown") &&
      document.content !== null &&
      document.savedContent !== null
    ) {
      if (fileKind === "unknown") fileKind = "text";
      currentContent = document.content;
      loadState = "ready";
      return;
    }
    const cachedPath = document.cachedLocalPath;
    if (cachedPath && (fileKind === "pdf" || needsExplicitDownload)) {
      try {
        const freshlyDownloaded =
          freshlyDownloadedDocumentPaths.get(document.id) === cachedPath;
        if (freshlyDownloaded) freshlyDownloadedDocumentPaths.delete(document.id);
        const available = await acquireMediaPath(
          cachedPath,
          token,
          !freshlyDownloaded
        );
        if (token !== loadToken) return;
        if (available) return;
        tabsStore.setDocumentCachedLocalPath(tabId, document.id, null);
      } catch (error) {
        if (token !== loadToken) return;
        loadState = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    if (boundKind === "ssh" && !document.sourceSessionId) {
      loadState = "error";
      errorMessage = "The SSH session for this file is no longer available.";
      return;
    }
    if (needsExplicitDownload) {
      loadState = "idle";
      return;
    }

    try {
      if (fileKind === "pdf") {
        await downloadToCache();
        return;
      }

      const content = await readInline();
      if (token !== loadToken) return;
      const bytes = decodeBase64(content.content_base64);
      if (fileKind === "image") {
        mediaUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(document.name) }));
      } else {
        const hasUtf8Bom =
          bytes.length >= 3 &&
          bytes[0] === 0xef &&
          bytes[1] === 0xbb &&
          bytes[2] === 0xbf;
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) {
          if (fileKind === "unknown") {
            loadState = "ready";
            return;
          }
          throw error;
        }
        if (fileKind === "unknown") fileKind = "text";
        currentContent = decoded;
        tabsStore.setDocumentLoaded(tabId, document.id, decoded, hasUtf8Bom);
      }
      loadState = "ready";
    } catch (error) {
      if (token !== loadToken) return;
      loadState = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function loadMedia() {
    const token = ++loadToken;
    loadState = "loading";
    errorMessage = "";
    revokeMediaUrl();
    try {
      await downloadToCache();
    } catch (error) {
      if (token !== loadToken) return;
      loadState = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function recoverCachedMedia() {
    if (!leasedMediaPath || !document.cachedLocalPath) return;
    const shouldRedownload = recoverableCachedMedia;
    cachedPathChangeAction = shouldRedownload
      ? fileKind === "pdf" ? "load-document" : "load-media"
      : "ignore";
    revokeMediaUrl();
    tabsStore.setDocumentCachedLocalPath(tabId, document.id, null);
    if (!shouldRedownload) {
      loadState = "error";
      errorMessage = "Unable to preview this file.";
    }
  }
  async function save() {
    if (
      !editable ||
      document.saveState === "saving" ||
      document.savedContent === null ||
      currentContent === document.savedContent
    ) return;
    const sessionId = document.sourceSessionId;
    if (boundKind === "ssh" && !sessionId) {
      tabsStore.setDocumentSaveFailed(
        tabId,
        document.id,
        "The SSH session for this file is no longer available."
      );
      return;
    }
    const contentToSave = currentContent;
    const contentToWrite = document.hasUtf8Bom
      ? String.fromCodePoint(0xfeff) + contentToSave
      : contentToSave;
    const expectedContent = document.hasUtf8Bom
      ? String.fromCodePoint(0xfeff) + document.savedContent
      : document.savedContent;
    tabsStore.setDocumentSaveStarted(tabId, document.id);
    try {
      if (boundKind === "local") {
        await localWriteFile(boundPath, contentToWrite, expectedContent);
      } else {
        await sftpWriteFile(sessionId!, boundPath, contentToWrite, expectedContent);
      }
      tabsStore.setDocumentSaved(tabId, document.id, contentToSave);
      setTimeout(() => {
        tabsStore.clearDocumentSavedState(tabId, document.id);
      }, 1800);
    } catch (error) {
      tabsStore.setDocumentSaveFailed(
        tabId,
        document.id,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function downloadCopy() {
    const sessionId = document.sourceSessionId;
    const cachedPath = boundKind === "ssh" ? document.cachedLocalPath : null;
    if (downloading || (boundKind === "ssh" && !sessionId && !cachedPath)) return;
    const saveTarget = await chooseDownloadSavePath(document.name);
    if (!saveTarget) return;
    const { directory, fileName } = splitSavePath(saveTarget);
    downloading = true;
    actionError = "";
    try {
      if (cachedPath) {
        await localDownloadToDir(cachedPath, directory, fileName);
      } else if (boundKind === "local") {
        await localDownloadToDir(boundPath, directory, fileName);
      } else {
        await sftpDownloadToDir(sessionId!, boundPath, directory, fileName);
      }
      downloadedHint = true;
      setTimeout(() => (downloadedHint = false), 1800);
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      downloading = false;
    }
  }

  interface EditorHighlightPalette {
    muted: string;
    link: string;
    heading: string;
    keyword: string;
    constant: string;
    number: string;
    string: string;
    variable: string;
    definition: string;
    type: string;
    operator: string;
    invalid: string;
  }

  function createEditorHighlightStyle(
    palette: EditorHighlightPalette,
    themeType: "dark" | "light"
  ): HighlightStyle {
    return HighlightStyle.define([
      { tag: tags.meta, color: palette.muted },
      { tag: [tags.link, tags.url], color: palette.link, textDecoration: "underline" },
      { tag: tags.heading, color: palette.heading, fontWeight: "bold" },
      { tag: tags.emphasis, fontStyle: "italic" },
      { tag: tags.strong, fontWeight: "bold" },
      { tag: tags.strikethrough, textDecoration: "line-through" },
      { tag: tags.quote, color: palette.string },
      { tag: tags.monospace, color: palette.number },
      { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: palette.keyword },
      { tag: [tags.atom, tags.bool, tags.null, tags.unit, tags.labelName], color: palette.constant },
      { tag: tags.number, color: palette.number },
      { tag: [tags.literal, tags.string, tags.docString, tags.character, tags.attributeValue, tags.inserted], color: palette.string },
      { tag: [tags.regexp, tags.escape, tags.special(tags.string), tags.deleted], color: palette.constant },
      { tag: tags.name, color: palette.variable },
      { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: palette.definition },
      { tag: [tags.special(tags.variableName), tags.constant(tags.variableName), tags.macroName], color: palette.keyword },
      { tag: [tags.propertyName, tags.attributeName], color: palette.definition },
      { tag: [tags.definition(tags.propertyName), tags.function(tags.propertyName)], color: palette.link },
      { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: palette.type },
      { tag: tags.changed, color: palette.number },
      { tag: tags.operator, color: palette.operator },
      { tag: tags.punctuation, color: palette.operator },
      { tag: tags.comment, color: palette.muted, fontStyle: "italic" },
      { tag: tags.invalid, color: palette.invalid, textDecoration: "underline" },
    ], { themeType });
  }

  const darkEditorHighlightStyle = createEditorHighlightStyle({
    muted: "#a89ca4",
    link: "#82b1ff",
    heading: "#ffcb6b",
    keyword: "#c792ea",
    constant: "#f78c6c",
    number: "#f2c078",
    string: "#b7d58a",
    variable: "#d4c2e8",
    definition: "#82b1ff",
    type: "#ffcb6b",
    operator: "#89ddff",
    invalid: "#ff7187",
  }, "dark");

  const lightEditorHighlightStyle = createEditorHighlightStyle({
    muted: "#50555a",
    link: "#005f9e",
    heading: "#6f4f00",
    keyword: "#6b21a8",
    constant: "#9a3412",
    number: "#8a4b08",
    string: "#225d16",
    variable: "#374151",
    definition: "#005f9e",
    type: "#6f4f00",
    operator: "#005966",
    invalid: "#b00020",
  }, "light");

  const editorTheme = EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--terminal-bg)",
      color: "var(--text-primary)",
      fontSize: "12px",
    },
    ".cm-scroller": {
      fontFamily: '"Sarasa Term K Nerd", "JetBrains Mono", monospace',
      lineHeight: "1.55",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-secondary)",
      color: "var(--text-muted)",
      borderRight: "1px solid var(--border-primary)",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--accent-primary) 7%, transparent)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--accent-primary) 30%, transparent) !important",
    },
    ".cm-cursor": { borderLeftColor: "var(--text-primary)" },
  });

  function editorThemeType(dark: boolean) {
    return EditorView.theme({}, { dark });
  }

  async function mountEditor(host: HTMLDivElement, content: string, token: number) {
    const language = await LanguageDescription.matchFilename(languages, document.name)?.load();
    if (token !== editorToken || editorHost !== host) return;
    const darkTheme = untrack(() => editorUsesDarkTheme);
    appliedEditorDarkTheme = darkTheme;
    editorView = new EditorView({
      doc: content,
      parent: host,
      extensions: [
        basicSetup,
        EditorView.cspNonce.of(
          window.document.querySelector<HTMLElement>("style[nonce], script[nonce]")?.nonce ?? ""
        ),
        EditorState.lineSeparator.of(lineSeparatorOf(content)),
        editorTheme,
        editorThemeCompartment.of(editorThemeType(darkTheme)),
        syntaxHighlighting(darkEditorHighlightStyle),
        syntaxHighlighting(lightEditorHighlightStyle),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void save();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          currentContent = update.state.sliceDoc();
          tabsStore.setDocumentContent(tabId, document.id, currentContent);
        }),
        ...(language ? [language] : []),
      ],
    });
    if (active) editorView.focus();
  }

  $effect(() => {
    const host = editorHost;
    const ready = loadState === "ready";
    const editMode = mode === "edit";
    if (!host || !ready || !editable || !editMode) return;
    const token = ++editorToken;
    const content = untrack(() => currentContent);
    void mountEditor(host, content, token);
    return () => {
      editorToken += 1;
      editorView?.destroy();
      editorView = null;
      appliedEditorDarkTheme = null;
    };
  });

  $effect(() => {
    const darkTheme = editorUsesDarkTheme;
    if (!editorView || appliedEditorDarkTheme === darkTheme) return;
    appliedEditorDarkTheme = darkTheme;
    editorView.dispatch({
      effects: editorThemeCompartment.reconfigure(editorThemeType(darkTheme)),
    });
  });

  $effect(() => {
    if (loadState !== "ready" || fileKind !== "markdown" || mode !== "preview") return;
    const token = ++markdownToken;
    const source = currentContent;
    void Promise.resolve(marked.parse(source)).then((html) => {
      if (token === markdownToken) {
        renderedMarkdown = DOMPurify.sanitize(html, {
          ALLOWED_TAGS: markdownTags,
          ALLOWED_ATTR: markdownAttributes,
        });
      }
    });
  });

  $effect(() => {
    const host = editorHost;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
      editorView?.requestMeasure();
    });
    observer.observe(host);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!visible || !editorView || mode !== "edit") return;
    editorView.requestMeasure();
    if (active) editorView.focus();
  });

  $effect(() => {
    document.id;
    document.sourceSessionId;
    document.cachedLocalPath;
    const action = cachedPathChangeAction;
    cachedPathChangeAction = null;
    if (action === "ignore") return;
    untrack(() => void (action === "load-media" ? loadMedia() : loadDocument()));
  });

  function handleWindowKeydown(event: KeyboardEvent) {
    if (!active || !editable || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
      return;
    }
    event.preventDefault();
    void save();
  }

  onDestroy(() => {
    loadToken += 1;
    markdownToken += 1;
    editorToken += 1;
    editorView?.destroy();
    revokeMediaUrl();
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<section class="document-view" aria-label={document.name}>
  <header class="document-toolbar">
    <div class="document-location" title={document.path}>
      <span class="document-path">{document.path}</span>
      <span class="document-size">{formatBytes(document.size)}</span>
    </div>
    <div class="document-actions">
      {#if fileKind === "markdown"}
        <div class="mode-switch" role="group" aria-label="Markdown mode">
          <button class:active={mode === "edit"} onclick={() => (mode = "edit")}>Edit</button>
          <button class:active={mode === "preview"} onclick={() => (mode = "preview")}>Preview</button>
        </div>
      {/if}
      {#if editable}
        <button
          class="toolbar-button primary"
          disabled={document.saveState === "saving" || !document.dirty}
          onclick={() => void save()}
        >{document.saveState === "saving" ? "Saving…" : document.saveState === "saved" ? "Saved" : "Save"}</button>
      {/if}
      <button class="toolbar-button" disabled={downloading} onclick={() => void downloadCopy()}>
        {downloading ? "Downloading…" : downloadedHint ? "Downloaded" : "Download"}
      </button>
    </div>
  </header>

  {#if document.saveError || actionError}
    <div class="document-error" role="status">{document.saveError || actionError}</div>
  {/if}

  <div class="document-body">
    {#if loadState === "loading"}
      <div class="document-status">Loading {document.name}…</div>
    {:else if loadState === "error"}
      <div class="document-status error">{errorMessage}</div>
    {:else if loadState === "idle"}
      <div class="document-status">
        <strong>{fileKind === "audio" ? "Audio file" : fileKind === "video" ? "Video file" : "Large image"}</strong>
        <span>{formatBytes(document.size)} — load the file to preview it.</span>
        <button class="load-button" onclick={() => void loadMedia()}>
          {fileKind === "image" ? "Load image" : "Load and play"}
        </button>
      </div>
    {:else if editable && (fileKind !== "markdown" || mode === "edit")}
      <div class="editor-host" bind:this={editorHost}></div>
    {:else if fileKind === "markdown" && mode === "preview"}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -- click delegation guards the focusable links inside; keyboard activation of an <a href> reaches the same handler -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- content is sanitized with DOMPurify -->
      <article class="markdown-body" onclick={handleMarkdownLinkClick} onauxclick={blockMarkdownAuxiliaryClick}>{@html renderedMarkdown}</article>
    {:else if fileKind === "pdf" && mediaUrl}
      <iframe class="pdf-preview" src={mediaUrl} title={document.name} onerror={recoverCachedMedia}></iframe>
    {:else if fileKind === "image" && mediaUrl}
      <div class="image-wrap"><img src={mediaUrl} alt={document.name} onerror={recoverCachedMedia} /></div>
    {:else if fileKind === "audio" && mediaUrl}
      <div class="media-wrap"><audio controls src={mediaUrl} onerror={recoverCachedMedia}></audio></div>
    {:else if fileKind === "video" && mediaUrl}
      <div class="media-wrap video-wrap">
        <!-- svelte-ignore a11y_media_has_caption -- arbitrary remote media has no caption track -->
        <video controls src={mediaUrl} onerror={recoverCachedMedia}></video>
      </div>
    {:else}
      <div class="document-status">
        <span>You can download this file instead.</span>
      </div>
    {/if}
  </div>

  {#if fileKind === "pdf" && document.size > MAX_SFTP_DOWNLOAD_BYTES}
    <footer class="document-note">
      PDF preview is limited to {formatBytes(MAX_SFTP_DOWNLOAD_BYTES)}.
    </footer>
  {/if}
</section>

<style>
  .document-view {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--terminal-bg);
    color: var(--text-primary);
  }

  .document-toolbar {
    min-height: 38px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 8px 4px 12px;
    border-bottom: 1px solid var(--border-primary);
    background: var(--bg-secondary);
  }

  .document-location {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-muted);
    font-size: 10px;
  }

  .document-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .document-size {
    flex: 0 0 auto;
  }

  .document-actions,
  .mode-switch {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .mode-switch {
    padding: 2px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-primary);
  }

  .mode-switch button,
  .toolbar-button,
  .load-button {
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }

  .mode-switch button {
    height: 24px;
    padding: 0 9px;
  }

  .mode-switch button.active {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .toolbar-button {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border-primary);
  }

  .toolbar-button.primary {
    border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-primary));
    color: var(--text-primary);
  }

  .toolbar-button:hover:not(:disabled),
  .load-button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .toolbar-button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .document-error {
    flex: 0 0 auto;
    padding: 6px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--status-error) 30%, var(--border-primary));
    background: color-mix(in srgb, var(--status-error) 9%, var(--bg-primary));
    color: var(--status-error);
    font-size: 10px;
  }

  .document-body {
    min-width: 0;
    min-height: 0;
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .editor-host {
    position: absolute;
    inset: 0;
  }

  .document-status {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    color: var(--text-muted);
    text-align: center;
    font-size: 11px;
  }

  .document-status.error {
    color: var(--status-error);
  }

  .load-button {
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--border-primary);
  }

  .pdf-preview {
    width: 100%;
    height: 100%;
    display: block;
    border: 0;
    background: white;
  }

  .image-wrap,
  .media-wrap {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    overflow: auto;
  }

  .video-wrap {
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  }

  .image-wrap img,
  .media-wrap video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .video-wrap video {
    min-width: 0;
    min-height: 0;
  }

  .media-wrap audio {
    width: min(560px, 100%);
  }

  .markdown-body {
    height: 100%;
    overflow: auto;
    padding: 28px clamp(28px, 7vw, 96px) 64px;
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.7;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3) {
    margin: 1.5em 0 0.55em;
    line-height: 1.25;
  }

  .markdown-body :global(h1) {
    padding-bottom: 0.35em;
    border-bottom: 1px solid var(--border-primary);
  }

  .markdown-body :global(p),
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0.8em 0;
  }

  .markdown-body :global(pre) {
    overflow: auto;
    padding: 14px 16px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-secondary);
  }

  .markdown-body :global(code) {
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
  }

  .markdown-body :global(a) {
    color: var(--accent-primary);
  }

  .document-note {
    flex: 0 0 auto;
    padding: 6px 12px;
    border-top: 1px solid var(--border-primary);
    color: var(--text-muted);
    font-size: 9px;
  }
</style>
