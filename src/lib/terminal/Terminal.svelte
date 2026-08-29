<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { AnsiParser, type Cell, type TerminalSnapshot } from "./ansi-parser";
  import { CanvasRenderer } from './CanvasRenderer';
  import {
    MAX_CLIPBOARD_IMAGE_BYTES,
    sshConnect,
    sshWrite,
    sshResize,
    sshDisconnect,
    sshGetSessionOutput,
    sshGetSessionSnapshot,
    sshStoreSessionSnapshot,
    listenSshData,
    listenSshExit,
    sshUploadClipboardImage,
    sshUploadClipboardImageFromLocalPath,
    readClipboardImage,
    sshCheckHostKey,
    sshTrustHostKey,
    localShellStart,
    localShellWrite,
    localShellResize,
    localShellDisconnect,
    listenLocalData,
    listenLocalExit,
    type AuthConfig,
    type HostKeyCheckResult,
  } from "$lib/tauri/commands";
  import { modifiersStore } from "$lib/stores/modifiers.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import { terminalModesStore } from "$lib/stores/terminal-modes.svelte";
  import { ctrlKey, altKey, getArrowKeyCode } from "$lib/utils/key-mapper";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { createStartupScriptDispatcher, type StartupScriptDispatcher } from "./startup-script";
  import { findUrlAtCell, validateTerminalUrl, type SafeTerminalUrl } from "./terminal-links";
  import { extractTerminalSelection } from "./terminal-selection";
  import { formatTerminalPaste } from "./terminal-paste";
  import { SshOutputDecoder } from "./ssh-output-decoder";
  import { cleanupFailedSessionAttach } from "./session-attach-cleanup";
  import { getThemeById, THEMES } from "$lib/styles/themes";
  import {
    runHostKeyGate,
    type HostKeyPreflightResult,
    type HostKeyPromptChallenge,
    type HostKeyPromptDecision,
    type HostKeyTrustRequest,
  } from "./host-key-gate";
  import {
    buildConnectionAuthConfig,
    commitKeyPassphraseRetry,
    createKeyPassphraseRetryCache,
    getKeyPassphraseForConnect,
    getResolvedKeyPassphrase,
    rollbackKeyPassphraseRetry,
    shouldPromptForKeyPassphraseRetry,
    stageKeyPassphraseRetry,
  } from "../components/connection-auth-plan";

  interface Props {
    host: string;
    port: number;
    auth: AuthConfig;
    existingSessionId?: string | null;
    connectionId?: string;
    interactive?: boolean;
    refocusOnBlur?: boolean;
    disconnectOnDestroy?: boolean;
    /** "local" spawns the machine's own shell instead of an SSH session. */
    kind?: "ssh" | "local";
    startupScript?: string;
    startupScriptReadyText?: string;
    onConnected?: (sessionId: string) => void;
    onDisconnected?: () => void;
    onError?: (error: string) => void;
  }

  let {
    host,
    port,
    auth,
    existingSessionId = null,
    connectionId,
    startupScript = "",
    startupScriptReadyText = "",
    interactive = true,
    refocusOnBlur = true,
    disconnectOnDestroy = true,
    kind = "ssh",
    onConnected,
    onDisconnected,
    onError
  }: Props = $props();

  // Terminal state
  let terminalContainer: HTMLDivElement;
  let scrollContainer: HTMLDivElement;
  let hiddenInput: HTMLTextAreaElement;
  let parser: AnsiParser | null = null;
  let sessionId: string | null = null;
  let unlisten: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let connected = $state(false);
  let resizeObserver: ResizeObserver | null = null;

  // Render state
  let buffer = $state<Cell[][]>([]);
  let cursorPos = $state({ x: 0, y: 0 });
  let prevCursorY = 0;
  let cols = $state(80);
  let rows = $state(24);
  let statusMessage = $state("");
  let debugInfo = $state("");
  let cursorVisible = $state(true);
  let parserCursorVisible = $state(true);
  let viewportTop = $state(0);
  let viewportHeight = $state(0);
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let heightFiller: HTMLDivElement | undefined = $state();
  let renderer: CanvasRenderer | null = null;
  let pendingHostKeyChallenge = $state<HostKeyPromptChallenge | null>(null);
  let resolvingHostKeyTrust = $state(false);
  let hostKeyPromptResolver: ((decision: HostKeyPromptDecision) => void) | null = null;
  let pendingKeyPassphrasePrompt = $state<{ keyId: string } | null>(null);
  let keyPassphraseInput = $state("");
  let keyPassphrasePromptResolver: ((passphrase: string | null) => void) | null = null;
  let keyPassphraseRetryCache = createKeyPassphraseRetryCache();
  const TERMINAL_SNAPSHOT_STORAGE_KEY = "redterm.sessionSnapshots.v1";
  const MAX_SESSION_SNAPSHOTS = 20;
  const SESSION_SNAPSHOT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 3;

  // Font metrics
  const LINE_HEIGHT_MULTIPLIER = 1.4;
  const FONT_FAMILY = '"Sarasa Term K Nerd", "JetBrains Mono", "Fira Code", monospace';
  const TERMINAL_HORIZONTAL_PADDING_PX = 8;
  let charWidth = $state(8.4);
  let charHeight = $state(Math.round(settingsStore.fontSize * LINE_HEIGHT_MULTIPLIER));

  const encoder = new TextEncoder();
  const sshOutputDecoder = new SshOutputDecoder();

  function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return merged;
  }


  // Cursor blink
  let cursorInterval: number | null = null;
  let blurHandler: ((e: FocusEvent) => void) | null = null;
  let pasteHandler: ((e: ClipboardEvent) => void) | null = null;
  let androidImagePasteHandler: ((e: Event) => void) | null = null;
  let visibilityChangeHandler: (() => void) | null = null;
  let replayBufferedChunks: Array<{ seq: number; data: Uint8Array }> | null = null;
  let replayBufferedBytes = 0;
  let sshDataPaused = false;
  let resumingSshData = false;
  let viewportUpdatePending = false;
  let autoStickToBottom = true;
  let reconnecting = false;
  let disconnectRequested = false;
  let lastProcessedSeq = 0;
  let startupScriptDispatcher: StartupScriptDispatcher | null = null;
  const REPLAY_SLICE_BUDGET_MS = 8;
  const LIVE_OUTPUT_SLICE_BUDGET_MS = 8;
  const LIVE_OUTPUT_SLICE_CHARACTERS = 256 * 1024;
  const MAX_PENDING_OUTPUT_CHARACTERS = 4 * 1024 * 1024;
  const MAX_REPLAY_BUFFER_BYTES = 4 * 1024 * 1024;
  const STICKY_BOTTOM_THRESHOLD_PX = 24;
  const TOUCH_LONG_PRESS_DELAY_MS = 420;
  const TOUCH_MOVE_CANCEL_PX = 12;
  const MOUSE_DRAG_SELECTION_THRESHOLD_PX = 4;
  const SELECTION_HANDLE_SIZE_PX = 18;
  const TOUCH_SELECTION_ROW_OFFSET = 3; // 롱프레스 시 손가락에 안 가리도록 위로 올릴 행 수
  let selectionMode = $state(false);
  let selectedText = $state("");
  let selectionFeedback = $state("");
  let selectionFeedbackTimer: number | null = null;
  let pendingTerminalUrl = $state<SafeTerminalUrl | null>(null);
  let openingTerminalUrl = $state(false);
  let pendingSelectionRefresh = false;
  let selectionStart = $state<{ row: number; col: number } | null>(null);
  let selectionEnd = $state<{ row: number; col: number } | null>(null);
  let selectionPointerId: number | null = null;
  let suppressNextFocus = false;
  let suppressBlurRefocus = false;
  let touchLongPressTimer: number | null = null;
  let touchPointerId: number | null = null;
  let touchPointerStart: { x: number; y: number } | null = null;
  let touchPointerMoved = false;
  let longPressTriggered = false;
  let terminalMousePointerId: number | null = null;
  let pendingMouseClick: {
    pointerId: number;
    startX: number;
    startY: number;
    startCell: { row: number; col: number };
  } | null = null;
  let selectionDragTarget: 'range' | 'start-handle' | 'end-handle' | null = null;
  let selectionHandleBoundary: 'selectionStart' | 'selectionEnd' | null = null;

  const showSelectionToolbar = $derived(selectionMode);
  const canCopySelection = $derived(selectionMode && selectedText.trim().length > 0);

  interface StoredTerminalSnapshot {
    snapshot: TerminalSnapshot;
    savedAt: number;
  }

  function canUseStorage() {
    return typeof window !== "undefined" && typeof localStorage !== "undefined";
  }

  function normalizeStoredSnapshot(
    value: StoredTerminalSnapshot | TerminalSnapshot | undefined
  ): StoredTerminalSnapshot | null {
    if (!value) return null;

    if ("snapshot" in value && typeof value.savedAt === "number") {
      return value as StoredTerminalSnapshot;
    }

    return {
      snapshot: value as TerminalSnapshot,
      savedAt: Date.now(),
    };
  }

  function pruneSessionSnapshots(
    snapshots: Record<string, StoredTerminalSnapshot | TerminalSnapshot>,
    now = Date.now()
  ): Record<string, StoredTerminalSnapshot> {
    const normalizedEntries = Object.entries(snapshots)
      .map(([sessionKey, value]) => {
        const normalized = normalizeStoredSnapshot(value);
        if (!normalized) return null;
        if (now - normalized.savedAt > SESSION_SNAPSHOT_MAX_AGE_MS) return null;
        return [sessionKey, normalized] as const;
      })
      .filter((entry): entry is readonly [string, StoredTerminalSnapshot] => entry !== null)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_SESSION_SNAPSHOTS);

    return Object.fromEntries(normalizedEntries);
  }

  function loadSessionSnapshots(): Record<string, StoredTerminalSnapshot> {
    if (!canUseStorage()) return {};

    try {
      const raw = localStorage.getItem(TERMINAL_SNAPSHOT_STORAGE_KEY);
      if (!raw) return {};
      return pruneSessionSnapshots(
        JSON.parse(raw) as Record<string, StoredTerminalSnapshot | TerminalSnapshot>
      );
    } catch {
      return {};
    }
  }

  function saveSessionSnapshot(targetSessionId: string) {
    if (!parser || !canUseStorage()) return;
    const snapshots = loadSessionSnapshots();
    snapshots[targetSessionId] = {
      snapshot: parser.createSnapshot(),
      savedAt: Date.now(),
    };
    const prunedSnapshots = pruneSessionSnapshots(snapshots);
    localStorage.setItem(TERMINAL_SNAPSHOT_STORAGE_KEY, JSON.stringify(prunedSnapshots));
  }

  function restoreSessionSnapshot(targetSessionId: string): TerminalSnapshot | null {
    if (!parser) return null;
    const storedSnapshot = loadSessionSnapshots()[targetSessionId];
    if (!storedSnapshot) return null;

    parser.restoreSnapshot(storedSnapshot.snapshot);
    updateBuffer();
    return storedSnapshot.snapshot;
  }

  function clearSessionSnapshot(targetSessionId: string | null | undefined) {
    if (!targetSessionId || !canUseStorage()) return;
    const snapshots = loadSessionSnapshots();
    if (!(targetSessionId in snapshots)) return;
    delete snapshots[targetSessionId];
    localStorage.setItem(
      TERMINAL_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(pruneSessionSnapshots(snapshots))
    );
  }

  function pointerToCell(e: PointerEvent): { row: number; col: number } {
    if (!scrollContainer) return { row: 0, col: 0 };
    const rect = scrollContainer.getBoundingClientRect();
    const x = e.clientX - rect.left - TERMINAL_HORIZONTAL_PADDING_PX;
    const y = e.clientY - rect.top + scrollContainer.scrollTop;
    const col = Math.max(0, Math.min(cols - 1, Math.floor(x / charWidth)));
    const row = Math.max(0, Math.floor(y / charHeight));
    return { row, col };
  }

  function touchToCell(touch: Touch): { row: number; col: number } {
    if (!scrollContainer) return { row: 0, col: 0 };
    const rect = scrollContainer.getBoundingClientRect();
    const x = touch.clientX - rect.left - TERMINAL_HORIZONTAL_PADDING_PX;
    const y = touch.clientY - rect.top + scrollContainer.scrollTop;
    const col = Math.max(0, Math.min(cols - 1, Math.floor(x / charWidth)));
    const row = Math.max(0, Math.floor(y / charHeight));
    return { row, col };
  }

  function compareCells(a: { row: number; col: number }, b: { row: number; col: number }) {
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  }

  function getOrderedSelectionRange() {
    if (!selectionStart || !selectionEnd) return null;

    if (compareCells(selectionStart, selectionEnd) <= 0) {
      return {
        start: selectionStart,
        end: selectionEnd,
      };
    }

    return {
      start: selectionEnd,
      end: selectionStart,
    };
  }

  function getHandleBoundary(kind: 'start' | 'end'): 'selectionStart' | 'selectionEnd' {
    const startComesFirst = !!selectionStart && !!selectionEnd && compareCells(selectionStart, selectionEnd) <= 0;

    if (kind === 'start') {
      return startComesFirst ? 'selectionStart' : 'selectionEnd';
    }

    return startComesFirst ? 'selectionEnd' : 'selectionStart';
  }

  function updateSelectionBoundary(point: { row: number; col: number }) {
    if (selectionHandleBoundary === 'selectionStart') {
      selectionStart = point;
    } else if (selectionHandleBoundary === 'selectionEnd') {
      selectionEnd = point;
    }
  }

  function getSelectionHandleStyle(kind: 'start' | 'end'): string {
    if (!scrollContainer) return 'display: none;';

    const range = getOrderedSelectionRange();
    if (!range) return 'display: none;';

    const point = kind === 'start' ? range.start : range.end;
    const cssPadLeft = parseFloat(getComputedStyle(scrollContainer).paddingLeft) || 0;
    const rawLeft = cssPadLeft + TERMINAL_HORIZONTAL_PADDING_PX + (kind === 'start' ? point.col : point.col + 1) * charWidth;
    const rawTop = point.row * charHeight + charHeight;
    const maxLeft = Math.max(SELECTION_HANDLE_SIZE_PX, scrollContainer.clientWidth - SELECTION_HANDLE_SIZE_PX);
    const minTop = viewportTop + SELECTION_HANDLE_SIZE_PX;
    const maxTop = viewportTop + scrollContainer.clientHeight - SELECTION_HANDLE_SIZE_PX;
    const left = Math.max(SELECTION_HANDLE_SIZE_PX, Math.min(maxLeft, rawLeft));
    const top = Math.max(minTop, Math.min(maxTop, rawTop));

    return `left: ${left}px; top: ${top}px;`;
  }

  function extractSelectedText(): string {
    const range = getOrderedSelectionRange();
    return range ? extractTerminalSelection(buffer, range) : "";
  }

  function clearSelectionFeedbackTimer() {
    if (selectionFeedbackTimer) {
      clearTimeout(selectionFeedbackTimer);
      selectionFeedbackTimer = null;
    }
  }

  function showSelectionMessage(message: string) {
    selectionFeedback = message;
    clearSelectionFeedbackTimer();
    selectionFeedbackTimer = window.setTimeout(() => {
      selectionFeedback = "";
      selectionFeedbackTimer = null;
    }, 1500);
  }

  function confirmAndOpenTerminalUrl(url: string) {
    const safeUrl = validateTerminalUrl(url);
    if (!safeUrl) {
      showSelectionMessage("Unsafe URL blocked");
      focusInput();
      return;
    }
    pendingTerminalUrl = safeUrl;
    openingTerminalUrl = false;
  }

  function cancelPendingTerminalUrl() {
    pendingTerminalUrl = null;
    openingTerminalUrl = false;
    focusInput();
  }

  async function openPendingTerminalUrl() {
    if (!pendingTerminalUrl || openingTerminalUrl) return;
    const safeUrl = validateTerminalUrl(pendingTerminalUrl.url);
    if (!safeUrl) {
      pendingTerminalUrl = null;
      showSelectionMessage("Unsafe URL blocked");
      focusInput();
      return;
    }
    openingTerminalUrl = true;

    try {
      await openUrl(safeUrl.url);
      pendingTerminalUrl = null;
    } catch (error) {
      console.error("[Terminal] failed to open URL:", error);
      pendingTerminalUrl = null;
      showSelectionMessage("Unable to open URL");
    } finally {
      openingTerminalUrl = false;
      if (pendingTerminalUrl === null) focusInput();
    }
  }

  function clearTouchLongPressTimer() {
    if (touchLongPressTimer) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
    }
  }

  function shouldForwardTerminalMouseEvents(): boolean {
    return !!parser && parser.isMouseEnabled() && !selectionMode;
  }

  function sendMouseButton(button: number, point: { row: number; col: number }, pressed: boolean) {
    if (!sessionId || !parser) return;

    const col = point.col + 1;
    const row = point.row + 1;

    if (parser.isSgrMouseEncoding()) {
      const code = pressed ? button : 3;
      const suffix = pressed ? 'M' : 'm';
      sendSessionData(encoder.encode(`\x1b[<${code};${col};${row}${suffix}`), true);
      return;
    }

    const code = pressed ? button : 3;
    const payload = `\x1b[M${String.fromCharCode(32 + code, 32 + col, 32 + row)}`;
    sendSessionData(encoder.encode(payload), true);
  }

  function beginSelectionAt(e: PointerEvent) {
    selectionDragTarget = 'range';
    selectionHandleBoundary = null;
    selectionPointerId = e.pointerId;
    selectionStart = pointerToCell(e);
    selectionEnd = { ...selectionStart };
    selectedText = extractSelectedText();
    if (scrollContainer && !scrollContainer.hasPointerCapture(e.pointerId)) {
      scrollContainer.setPointerCapture(e.pointerId);
    }
    requestRedraw();
  }

  function beginSelectionAtWithOffset(e: PointerEvent, rowOffset: number) {
    selectionDragTarget = 'range';
    selectionHandleBoundary = null;
    selectionPointerId = e.pointerId;
    const cell = pointerToCell(e);
    cell.row = Math.max(0, cell.row - rowOffset);
    selectionStart = cell;
    selectionEnd = { ...selectionStart };
    selectedText = extractSelectedText();
    if (scrollContainer && !scrollContainer.hasPointerCapture(e.pointerId)) {
      scrollContainer.setPointerCapture(e.pointerId);
    }
    requestRedraw();
  }

  function enterSelectionMode() {
    selectionMode = true;
    suppressNextFocus = true;
    hiddenInput?.blur();
  }

  function exitSelectionMode() {
    selectionMode = false;
    selectionStart = null;
    selectionEnd = null;
    selectionDragTarget = null;
    selectionHandleBoundary = null;
    selectionPointerId = null;
    selectedText = "";

    focusInput();

    if (pendingSelectionRefresh) {
      pendingSelectionRefresh = false;
      updateBuffer();
    } else {
      requestRedraw();
    }

  }

  async function copySelectedText() {
    const text = extractSelectedText();
    if (!text.trim()) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      showSelectionMessage("Copied");
      selectionStart = null;
      selectionEnd = null;
      exitSelectionMode();
    } catch (error) {
      console.error("[Terminal] copy failed:", error);
      showSelectionMessage("Copy failed");
    }
  }

  /// Keyboard entry point (Ctrl/Cmd+Shift+C): copy without closing the
  /// selection, so repeated copies are possible.
  export function copySelection() {
    const text = extractSelectedText();
    if (text.trim() && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch((e) => {
        console.error("[Terminal] copy failed:", e);
      });
    }
  }

  function cancelSelection() {
    clearSelectionFeedbackTimer();
    selectionFeedback = "";
    exitSelectionMode();
  }

  function swallowPointerClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }




  function swallowPointerPress(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function startSelectionHandleDrag(e: PointerEvent, kind: 'start' | 'end') {
    if (!selectionMode || !selectionStart || !selectionEnd) return;

    e.preventDefault();
    e.stopPropagation();
    suppressNextFocus = true;
    selectionDragTarget = kind === 'start' ? 'start-handle' : 'end-handle';
    selectionHandleBoundary = getHandleBoundary(kind);
    selectionPointerId = e.pointerId;

    if (scrollContainer && !scrollContainer.hasPointerCapture(e.pointerId)) {
      scrollContainer.setPointerCapture(e.pointerId);
    }
  }


  async function uploadClipboardImageBytes(bytes: Uint8Array) {
    if (!sessionId || kind === "local") return;

    const prevStatusMessage = statusMessage;
    statusMessage = "Uploading pasted image...";

    try {
      const uploadResult = await sshUploadClipboardImage(sessionId, bytes);
      statusMessage = prevStatusMessage;
      queueWrite(uploadResult.remote_path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = `Image upload failed: ${message}`;
      console.error("[SSH] image upload failed:", error);
    }
  }

  async function uploadClipboardImageFromLocalPath(localPath: string) {
    if (!sessionId || kind === "local") return;

    const prevStatusMessage = statusMessage;
    statusMessage = "Uploading pasted image...";

    try {
      const uploadResult = await sshUploadClipboardImageFromLocalPath(sessionId, localPath);
      statusMessage = prevStatusMessage;
      queueWrite(uploadResult.remote_path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = `Image upload failed: ${message}`;
      console.error("[SSH] local image upload failed:", error);
    }
  }

  function sendPastedText(text: string) {
    try {
      const payload = formatTerminalPaste(text, parser?.isBracketedPasteMode() ?? false);
      if (payload) queueWrite(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = `Paste failed: ${message}`;
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    if (!sessionId) return;
    const clipboardData = e.clipboardData;

    // 웹 클립보드 API에서 이미지 확인 (데스크톱)
    if (clipboardData) {
      const imageItem = Array.from(clipboardData.items).find((item) =>
        item.type.startsWith("image/")
      );
      if (imageItem) {
        const imageFile = imageItem.getAsFile();
        if (imageFile) {
          if (imageFile.size > MAX_CLIPBOARD_IMAGE_BYTES) {
            e.preventDefault();
            statusMessage = "Image upload failed: Clipboard image exceeds 10 MiB";
            return;
          }
          e.preventDefault();
          const bytes = new Uint8Array(await imageFile.arrayBuffer());
          await uploadClipboardImageBytes(bytes);
          return;
        }
      }

      const text = clipboardData.getData("text/plain");
      if (text) {
        e.preventDefault();
        sendPastedText(text);
        return;
      }
    }

    // Android fallback: 시스템 클립보드에서 이미지 확인
    try {
      const result = await readClipboardImage();
      if (result.found && result.localPath) {
        e.preventDefault();
        await uploadClipboardImageFromLocalPath(result.localPath);
      }
    } catch {
      // readClipboardImage 실패 시 무시 (데스크톱에서는 no-op)
    }
  }

  // ─── Canvas helpers ─────────────────────────────────────
  // Selection drag handles are a touch UX (mobile); the desktop build
  // selects by mouse drag directly.
  const isDesktopTarget = import.meta.env.VITE_REDTERM_TARGET === "desktop";

  function redrawCanvas(force = false) {
    if (!renderer || !parser) return;
    // synchronized output 중에는 중간 상태 노출 방지를 위해 렌더 스킵
    // force=true: resize 직후 등 캔버스가 클리어된 경우 반드시 다시 그려야 함
    if (!force && parser.isSynchronizedOutput()) return;
    const buf = parser.getFullBuffer();
    if (buf.length === 0) return;

    // heightFiller를 최신 버퍼에 맞게 동기화 (DOM write만 — reflow 없음)
    const totalHeight = buf.length * charHeight;
    if (heightFiller) {
      heightFiller.style.height = `${totalHeight}px`;
    }

    // viewportTop 동기화 (scrollTop read만 — scrollHeight 안 읽어서 reflow 최소화)
    if (scrollContainer) {
      viewportTop = scrollContainer.scrollTop;
    }

    const startRow = Math.max(
      0,
      Math.min(Math.floor(viewportTop / charHeight), buf.length - 1)
    );
    const fracOffsetY = viewportTop % charHeight;
    const endRow = Math.min(startRow + rows + 2, buf.length);

    renderer.clear();
    renderer.beginDraw(fracOffsetY);
    renderer.drawVisibleRows(buf, startRow, endRow);
    renderer.drawImages(parser.getImages(), startRow, endRow);

    // 커서
    if (connected && cursorVisible && parserCursorVisible) {
      const cursorScreenY = cursorPos.y - startRow;
      if (cursorScreenY >= 0 && cursorScreenY < rows + 2) {
        renderer.drawCursor(cursorPos.x, cursorScreenY);
      }
    }

    drawSelectionIfActive(startRow);
    renderer.endDraw();
  }

  function requestRedraw() {
    if (redrawPending) return;
    // updatePending 체크 제거: resize로 캔버스가 클리어된 후 반드시 다시 그려야 함
    redrawPending = true;
    requestAnimationFrame(() => {
      redrawPending = false;
      redrawCanvas();
    });
  }

  function drawSelectionIfActive(startRow: number) {
    const range = getOrderedSelectionRange();
    if (!selectionMode || !range || !renderer) return;
    renderer.drawSelection(range.start.row, range.start.col, range.end.row, range.end.col, startRow);
  }

  onMount(async () => {
    // CanvasRenderer 초기화
    if (canvasEl) {
      const theme = getThemeById(settingsStore.theme) ?? THEMES[0];
      renderer = new CanvasRenderer(canvasEl, {
        fontSize: settingsStore.fontSize,
        fontFamily: FONT_FAMILY,
        lineHeightMultiplier: LINE_HEIGHT_MULTIPLIER,
        horizontalPadding: TERMINAL_HORIZONTAL_PADDING_PX,
        defaultFg: theme.colors.terminalFg,
        defaultBg: theme.colors.terminalBg,
        cursorColor: theme.colors.terminalCursor,
        onImageLoad: requestRedraw,
      });
    }
    measureFont();
    calculateSize();

    if (typeof document !== "undefined" && "fonts" in document) {
      void (document as Document & { fonts: FontFaceSet }).fonts.ready.then(() => {
        measureFont();
        calculateSize();
      });
    }

    // Cursor blink
    cursorInterval = window.setInterval(() => {
      cursorVisible = !cursorVisible;
      requestRedraw();
    }, 530);

    // Setup input handlers BEFORE initTerminal
    await tick();
    if (hiddenInput) {
      hiddenInput.addEventListener('input', handleInput);
      hiddenInput.addEventListener('keydown', handleKeyDown);
      hiddenInput.addEventListener('compositionstart', handleCompositionStart);
      hiddenInput.addEventListener('compositionend', handleCompositionEnd);
      pasteHandler = (e: ClipboardEvent) => {
        void handlePaste(e);
      };
      hiddenInput.addEventListener('paste', pasteHandler);

      blurHandler = () => {
        if (suppressBlurRefocus) {
          suppressBlurRefocus = false;
          return;
        }

        if (interactive && refocusOnBlur && connected && hiddenInput && !selectionMode) {
          hiddenInput.focus();
        }
      };
      hiddenInput.addEventListener('blur', blurHandler);

    }

    androidImagePasteHandler = (event: Event) => {
      const customEvent = event as CustomEvent<{ localPath?: string }>;

      if (!sessionId || tabsStore.activeTab?.sessionId !== sessionId) return;

      const localPath = customEvent.detail?.localPath;
      if (!localPath) return;


      void uploadClipboardImageFromLocalPath(localPath);
    };
    window.addEventListener("redterm:android-image-paste", androidImagePasteHandler);

    // Periodic focus check (every 200ms - isComposing 체크 제거로 빠른 복구)
    // Now connect
    await initTerminal();

    visibilityChangeHandler = () => {
      if (document.visibilityState === "visible") {
        if (!parser || !renderer) { void probeAndReconnect(); return; }
        parser.markAllDirty();

        // Android WebView resume 시 DOM 레이아웃 복원 타이밍이 불확실해서
        // 여러 시점에서 scrollTop 재설정 + canvas 다시 그리기
        const forceScrollToBottomAndRedraw = () => {
          if (!parser || !renderer) return;
          autoStickToBottom = true;

          const buf = parser.getFullBuffer();
          if (buf.length === 0) return;

          const totalHeight = buf.length * charHeight;
          if (heightFiller) heightFiller.style.height = `${totalHeight}px`;
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
            viewportTop = scrollContainer.scrollTop;
          }

          cursorPos = { ...parser.getFullCursor() };
          parserCursorVisible = parser.isCursorVisible();
          buffer = buf;

          const startRow = Math.max(
            0,
            Math.min(Math.floor(viewportTop / charHeight), parser.getBuffer().length - 1)
          );
          const fracOffsetY = viewportTop % charHeight;
          const endRow = Math.min(startRow + rows + 2, buf.length);

          renderer.clear();
          renderer.beginDraw(fracOffsetY);
          renderer.drawVisibleRows(buf, startRow, endRow);
          renderer.drawImages(parser.getImages(), startRow, endRow);
          if (connected && cursorVisible && parserCursorVisible) {
            const cursorScreenY = cursorPos.y - startRow;
            if (cursorScreenY >= 0 && cursorScreenY < rows + 2) {
              renderer.drawCursor(cursorPos.x, cursorScreenY);
            }
          }
          renderer.endDraw();
        };

        // 3중 보장: 즉시 + 다음 repaint + DOM 안정화 후
        forceScrollToBottomAndRedraw();
        requestAnimationFrame(forceScrollToBottomAndRedraw);
        setTimeout(forceScrollToBottomAndRedraw, 150);

        void resumeAfterBackground();
      } else if (document.visibilityState === "hidden") {
        pauseSshDataForBackground();
      }
    };
    document.addEventListener("visibilitychange", visibilityChangeHandler);
  });

  function measureFont() {
    if (!renderer) return;
    renderer.measureFont();
    charWidth = renderer.charWidth;
    charHeight = renderer.charHeight;
  }

  let resizeTimer: number | null = null;

  function commitResize(newCols: number, newRows: number) {
    cols = newCols;
    rows = newRows;

    if (parser) {
      parser.resize(cols, rows);
    }

    if (sessionId) {
      resizeSessionRemote();
    }

    // resize 후 커서가 보이도록 스크롤 조정
    if (scrollContainer && parser) {
      const cursorFullY = parser.getScrollbackLength() + parser.getCursor().y;
      const totalHeight = (parser.getScrollbackLength() + rows) * charHeight;
      if (heightFiller) {
        heightFiller.style.height = `${totalHeight}px`;
      }
      const cursorPixelY = cursorFullY * charHeight;
      const viewportBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;
      if (cursorPixelY >= viewportBottom || cursorPixelY < scrollContainer.scrollTop) {
        scrollContainer.scrollTop = Math.max(0, cursorPixelY - scrollContainer.clientHeight + charHeight);
      }
      viewportTop = scrollContainer.scrollTop;
    }

    updateBuffer();
  }

  function calculateSize() {
    if (!terminalContainer) return;

    const rect = terminalContainer.getBoundingClientRect();
    const availableWidth = rect.width - TERMINAL_HORIZONTAL_PADDING_PX * 2;
    const newCols = Math.floor(availableWidth / charWidth);
    const newRows = Math.floor(rect.height / charHeight);


    if (newCols > 0 && newRows > 0 && (newCols !== cols || newRows !== rows)) {
      // resize 전에 stickToBottom 상태 캡처 (키보드 올라와서 clientHeight가 줄어들기 전)
      const wasAtBottom = autoStickToBottom || isNearBottom();

      // canvas와 cols/rows를 즉시 업데이트 (debounce 중에도 렌더링이 정확하도록)
      cols = newCols;
      rows = newRows;
      if (renderer) {
        renderer.resize(rect.width, rect.height, newCols, newRows);
      }

      if (!sessionId) {
        // 세션 없으면 (초기 셋업) 즉시 적용
        commitResize(newCols, newRows);
      } else {
        // 세션 있으면 debounce — 파서와 원격 앱이 동시에 resize되도록
        // debounce 중에는 파서가 이전 크기로 데이터 처리 (원격 앱도 이전 크기)
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null;
          commitResize(newCols, newRows);
        }, 300);

        // 키보드 올라올 때 stickToBottom 유지: clientHeight 감소로 distanceFromBottom이
        // 임계값을 넘어도 scrollTop을 맨 아래로 재설정
        if (wasAtBottom && scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
          viewportTop = scrollContainer.scrollTop;
          autoStickToBottom = true;
        }

        // resize가 캔버스를 클리어하므로 즉시 동기적으로 다시 그리기 (잔상/깜빡임 방지)
        // RAF까지 기다리면 1-2프레임 동안 빈 화면이 보임
        // force=true: synchronized output 중이어도 그리기 (이전 완성 상태는 파서 버퍼에 있음)
        redrawCanvas(true);
      }
    }

    syncViewportMetrics();
  }

  let updatePending = false;
  let redrawPending = false;
  let isComposing = false;
  let immediateCompositionText = "";
  let compositionTimeout: number | null = null;
  let pendingWrite = "";
  let writeFlushScheduled = false;
  const MAX_AUTOMATIC_RESPONSES_PER_SECOND = 32;
  const MAX_AUTOMATIC_RESPONSE_QUEUE = 32;
  const MAX_AUTOMATIC_RESPONSE_BYTES = 4096;
  let automaticResponseQueue: string[] = [];
  let automaticResponseBytes = 0;
  let automaticResponseSending = false;
  let automaticResponseWindowStartedAt = 0;
  let automaticResponseCount = 0;
  let protocolFloodDetected = false;
  let deferredUpdateTimer: number | null = null;
  let lastNonBottomRenderAt = 0;
  let prevScrollbackLength = 0;
  const NON_BOTTOM_RENDER_INTERVAL_MS = 90;
  type PendingOutputChunk = { seq: number; text: string; completesSeq: boolean };
  let pendingDataChunks: PendingOutputChunk[] = [];
  let pendingDataHead = 0;
  let pendingDataCharacters = 0;

  function clearPendingOutput() {
    pendingDataChunks = [];
    pendingDataHead = 0;
    pendingDataCharacters = 0;
  }

  function pauseSshDataSource() {
    if (!unlisten || sshDataPaused) return;
    sshDataPaused = true;
    unlisten();
    unlisten = null;
  }

  function enqueuePendingOutput(seq: number, text: string) {
    if (!text) {
      lastProcessedSeq = Math.max(lastProcessedSeq, seq);
      return;
    }

    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + 4096, text.length);
      const finalCodeUnit = text.charCodeAt(end - 1);
      if (end < text.length && finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
        end--;
      }
      pendingDataChunks.push({
        seq,
        text: text.slice(offset, end),
        completesSeq: end === text.length,
      });
      offset = end;
    }
    pendingDataCharacters += text.length;
    if (pendingDataCharacters >= MAX_PENDING_OUTPUT_CHARACTERS) {
      pauseSshDataSource();
    }
  }

  function processPendingOutputSlice(force: boolean) {
    if (!parser) return;
    const startedAt = performance.now();
    let processedCharacters = 0;
    while (pendingDataHead < pendingDataChunks.length) {
      if (
        !force &&
        processedCharacters > 0 &&
        (processedCharacters >= LIVE_OUTPUT_SLICE_CHARACTERS ||
          performance.now() - startedAt >= LIVE_OUTPUT_SLICE_BUDGET_MS)
      ) {
        break;
      }

      const chunk = pendingDataChunks[pendingDataHead++];
      parser.write(chunk.text);
      pendingDataCharacters -= chunk.text.length;
      processedCharacters += chunk.text.length;
      if (chunk.completesSeq) {
        lastProcessedSeq = Math.max(lastProcessedSeq, chunk.seq);
      }
    }

    if (pendingDataHead >= pendingDataChunks.length) {
      clearPendingOutput();
    } else if (pendingDataHead >= 1024 && pendingDataHead * 2 >= pendingDataChunks.length) {
      pendingDataChunks = pendingDataChunks.slice(pendingDataHead);
      pendingDataHead = 0;
    }
  }

  function distanceFromBottom(): number {
    if (!scrollContainer) return 0;
    return Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
    );
  }

  function isNearBottom(): boolean {
    return distanceFromBottom() <= STICKY_BOTTOM_THRESHOLD_PX;
  }

  function updateBuffer(force = false) {
    // force=true: 앱 복귀 시 selection/throttle 무시하고 강제 렌더링
    if (!force && selectionMode) {
      pendingSelectionRefresh = true;
      return;
    }

    // 강제 렌더링 시 stickToBottom 복원 + pending 무시
    if (force) {
      autoStickToBottom = true;
    }

    const shouldStickToBottom = autoStickToBottom;
    const nearBottom = shouldStickToBottom || isNearBottom();

    if (nearBottom && deferredUpdateTimer) {
      clearTimeout(deferredUpdateTimer);
      deferredUpdateTimer = null;
    }

    if (!force && !nearBottom) {
      const now = Date.now();
      const elapsed = now - lastNonBottomRenderAt;
      if (elapsed < NON_BOTTOM_RENDER_INTERVAL_MS) {
        if (!deferredUpdateTimer) {
          deferredUpdateTimer = window.setTimeout(() => {
            deferredUpdateTimer = null;
            updateBuffer();
          }, NON_BOTTOM_RENDER_INTERVAL_MS - elapsed);
        }
        return;
      }
      lastNonBottomRenderAt = now;
    }

    if (!force && updatePending) return;
    updatePending = true;

    requestAnimationFrame(() => {
      updatePending = false;
      if (!parser || !renderer) return;

      // Parse within a fixed per-frame budget. Synchronized-output markers
      // still pass through this path, so a closing marker cannot deadlock.
      if (pendingDataHead < pendingDataChunks.length) {
        processPendingOutputSlice(force);
        if (sessionId) {
          terminalModesStore.setAppCursorMode(
            sessionId,
            parser.isApplicationCursorKeys(),
          );
        }
      }

      if (!force && parser.isSynchronizedOutput()) {
        if (pendingDataHead < pendingDataChunks.length) {
          updateBuffer();
        }
        return;
      }

      const newScrollbackLength = parser.getScrollbackLength();
      prevScrollbackLength = newScrollbackLength;

      const newBuffer = parser.getFullBuffer();
      buffer = newBuffer;
      cursorPos = { ...parser.getFullCursor() };
      parserCursorVisible = parser.isCursorVisible();


      // height filler 업데이트 (네이티브 스크롤을 위한 가상 높이)
      const totalHeight = newBuffer.length * charHeight;
      if (heightFiller) {
        heightFiller.style.height = `${totalHeight}px`;
      }

      // stick to bottom: 스크롤 먼저 → 렌더는 정확한 viewportTop으로
      if (scrollContainer && shouldStickToBottom) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        viewportTop = scrollContainer.scrollTop;
      } else if (scrollContainer) {
        // 스크롤 중이 아니어도 viewportTop을 최신 scrollTop으로 동기화 (잔상 방지)
        viewportTop = scrollContainer.scrollTop;
      }

      // visible range 계산
      const startRow = Math.max(
        0,
        Math.min(Math.floor(viewportTop / charHeight), newBuffer.length - 1)
      );
      const fracOffsetY = viewportTop % charHeight;
      const endRow = Math.min(startRow + rows + 2, newBuffer.length);

      // 항상 전체 다시 그리기
      renderer.clear();
      renderer.beginDraw(fracOffsetY);
      renderer.drawVisibleRows(newBuffer, startRow, endRow);
      renderer.drawImages(parser.getImages(), startRow, endRow);

      prevCursorY = cursorPos.y;

      // 커서 그리기
      const cursorScreenY = cursorPos.y - startRow;
      if (connected && cursorVisible && parserCursorVisible) {
        if (cursorScreenY >= 0 && cursorScreenY < rows + 2) {
          renderer.drawCursor(cursorPos.x, cursorScreenY);
        }
      }

      drawSelectionIfActive(startRow);
      renderer.endDraw();
      parser.clearDirtyRows();
      if (pendingDataHead < pendingDataChunks.length) {
        updateBuffer();
      } else if (
        sshDataPaused &&
        replayBufferedChunks === null &&
        document.visibilityState !== "hidden"
      ) {
        void resumeAfterBackground();
      }
    });
  }

  function syncViewportMetrics() {
    if (!scrollContainer) return;
    viewportTop = scrollContainer.scrollTop;
    viewportHeight = scrollContainer.clientHeight;
  }

  function handleTerminalScroll() {
    if (!scrollContainer) return;
    const newScrollTop = scrollContainer.scrollTop;
    const scrolledUp = newScrollTop < viewportTop;


    if (scrolledUp) {
      // 위로 스크롤 — 사용자가 위로 올렸으면 stickToBottom 해제
      autoStickToBottom = isNearBottom();
    } else if (!autoStickToBottom && isNearBottom()) {
      // 아래로 스크롤해서 맨 아래 도달 — stickToBottom 복구
      autoStickToBottom = true;
    }
    // 프로그래밍적 아래 스크롤(updateBuffer)에서는 autoStickToBottom 변경 안 함

    viewportTop = newScrollTop;
    viewportHeight = scrollContainer.clientHeight;
    requestRedraw();
  }

  // ─── 터치 스크롤 → 마우스 휠 변환 (tmux 등 alternate screen) ───
  let touchScrollLastY: number | null = null;
  let touchScrollAccum = 0;
  const TOUCH_SCROLL_LINE_THRESHOLD = 0.6; // charHeight의 60%만큼 이동하면 1줄 스크롤

  function shouldInterceptScroll(): boolean {
    // alternate screen 기반 TUI는 mouse mode를 명시적으로 켜지 않아도
    // 터치 드래그를 네이티브 스크롤 대신 내부 휠 입력으로 기대하는 경우가 있다.
    // 상위 레이아웃이 전역 스크롤을 막고 있으니, alt-screen에서는 우선 wheel 변환을 허용한다.
    return !!parser && parser.isAlternateScreen() && !selectionMode;
  }

  function sendMouseWheel(up: boolean, lines: number, point: { row: number; col: number }) {
    if (!sessionId || !parser) return;
    const button = up ? 64 : 65; // 64=wheel up, 65=wheel down
    const col = point.col + 1;
    const row = point.row + 1;
    const enc = parser.isSgrMouseEncoding();
    const data: string[] = [];
    for (let i = 0; i < lines; i++) {
      if (enc) {
        data.push(`\x1b[<${button};${col};${row}M`);
      } else {
        data.push(`\x1b[M${String.fromCharCode(32 + button, 32 + col, 32 + row)}`);
      }
    }
    sendSessionData(encoder.encode(data.join('')), true);
  }

  function handleTouchStart(e: TouchEvent) {
    if (!shouldInterceptScroll()) return;
    touchScrollLastY = e.touches[0].clientY;
    touchScrollAccum = 0;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!shouldInterceptScroll() || touchScrollLastY === null) return;

    const currentY = e.touches[0].clientY;
    if (touchPointerStart && Math.abs(currentY - touchPointerStart.y) > TOUCH_MOVE_CANCEL_PX) {
      touchPointerMoved = true;
    }
    const delta = touchScrollLastY - currentY; // 양수 = 위로 스크롤 (내용이 위로)
    touchScrollLastY = currentY;
    touchScrollAccum += delta;

    const lineThreshold = charHeight * TOUCH_SCROLL_LINE_THRESHOLD;
    const lines = Math.floor(Math.abs(touchScrollAccum) / lineThreshold);
    if (lines > 0) {
      const up = touchScrollAccum < 0;
      sendMouseWheel(up, lines, touchToCell(e.touches[0]));
      // accum을 0 방향으로 줄여야 소비됨
      touchScrollAccum -= Math.sign(touchScrollAccum) * lines * lineThreshold;
      e.preventDefault(); // 네이티브 스크롤 방지
    }
  }

  function handleTouchEnd() {
    touchScrollLastY = null;
    touchScrollAccum = 0;
  }

  function promptKeyPassphrase(keyId: string): Promise<string | null> {
    pendingKeyPassphrasePrompt = { keyId };
    keyPassphraseInput = "";
    return new Promise((resolve) => {
      keyPassphrasePromptResolver = resolve;
    });
  }

  function resolveKeyPassphrasePrompt(passphrase: string | null) {
    if (!keyPassphrasePromptResolver) return;

    const resolve = keyPassphrasePromptResolver;
    keyPassphrasePromptResolver = null;
    pendingKeyPassphrasePrompt = null;
    resolve(passphrase);
  }

  async function resolveAuthForConnect(): Promise<AuthConfig> {
    if (auth.method.type === "key") {
      if (getResolvedKeyPassphrase(keyPassphraseRetryCache) === undefined && auth.method.passphrase !== undefined) {
        keyPassphraseRetryCache = commitKeyPassphraseRetry(
          stageKeyPassphraseRetry(keyPassphraseRetryCache, auth.method.passphrase)
        );
      }

      return buildConnectionAuthConfig({
        authType: "key",
        username: auth.username,
        keyId: auth.method.key_id,
        passphrase: getKeyPassphraseForConnect(keyPassphraseRetryCache),
      });
    }

    return auth;
  }

  async function connectWithResolvedAuth(): Promise<string> {
    const resolvedAuth = await resolveAuthForConnect();
    return sshConnect(host, port, resolvedAuth, cols, rows);
  }

  async function connectWithKeyPassphraseRetry(): Promise<string> {
    startupScriptDispatcher = createStartupScriptDispatcher(startupScript, startupScriptReadyText);
    try {
      return await connectWithResolvedAuth();
    } catch (error) {
      if (
        auth.method.type !== "key" ||
        !shouldPromptForKeyPassphraseRetry({
          auth,
          resolvedKeyPassphrase: getResolvedKeyPassphrase(keyPassphraseRetryCache),
          error,
        })
      ) {
        throw error;
      }

      const passphrase = await promptKeyPassphrase(auth.method.key_id);
      if (passphrase === null) {
        throw new Error("Key passphrase entry cancelled");
      }

      keyPassphraseRetryCache = stageKeyPassphraseRetry(keyPassphraseRetryCache, passphrase);
      try {
        startupScriptDispatcher = createStartupScriptDispatcher(startupScript, startupScriptReadyText);
        const sessionId = await connectWithResolvedAuth();
        keyPassphraseRetryCache = commitKeyPassphraseRetry(keyPassphraseRetryCache);
        return sessionId;
      } catch (retryError) {
        keyPassphraseRetryCache = rollbackKeyPassphraseRetry(keyPassphraseRetryCache);
        throw retryError;
      }
    }
  }

  async function bindSessionListener(nextSessionId: string) {
    sshDataPaused = false;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }

    unlisten = await listenSshData(nextSessionId, (data, seq) => {
      if (replayBufferedChunks) {
        if (replayBufferedBytes + data.byteLength > MAX_REPLAY_BUFFER_BYTES) {
          pauseSshDataSource();
          return;
        }
        replayBufferedChunks.push({ seq, data: data.slice() });
        replayBufferedBytes += data.byteLength;
        return;
      }
      const text = sshOutputDecoder.decode(data);
      const startupPayload = startupScriptDispatcher?.consumeOutput(text);
      if (startupPayload) {
        queueWrite(startupPayload);
      }

      if (parser) {
        enqueuePendingOutput(seq, text);
        updateBuffer();
      }
    });

    unlistenExit = await listenSshExit(nextSessionId, () => {
      if (sessionId !== nextSessionId || disconnectRequested) return;
      connected = false;

      // If app is in background, defer cleanup and attempt reconnect on resume
      if (document.visibilityState === "hidden") {
        statusMessage = "Connection lost (backgrounded)";
        void reconnectSession("background disconnect");
        return;
      }

      sessionId = null;
      lastProcessedSeq = 0;
      terminalModesStore.clearSession(nextSessionId);
      clearSessionSnapshot(nextSessionId);
      statusMessage = "Session ended";
      onDisconnected?.();
      startupScriptDispatcher = null;
    });
  }

  async function attachExistingSession(nextSessionId: string): Promise<boolean> {
    sshOutputDecoder.reset();
    try {
      replayBufferedChunks = [];
      replayBufferedBytes = 0;
      sessionId = nextSessionId;
      connected = true;
      statusMessage = "";
      await bindSessionListener(nextSessionId);

      const backendSnapshot = await sshGetSessionSnapshot(nextSessionId);
      const historyChunks = await sshGetSessionOutput(nextSessionId);
      if (backendSnapshot && parser) {
        parser.restoreSnapshot(backendSnapshot.snapshot);
        lastProcessedSeq = backendSnapshot.last_seq;
        updateBuffer();
      } else {
        restoreSessionSnapshot(nextSessionId);
      }

      await replayAndDrainSessionChunks(historyChunks);

      terminalModesStore.setAppCursorMode(
        nextSessionId,
        parser?.isApplicationCursorKeys() ?? terminalModesStore.isAppCursorMode(nextSessionId)
      );
      await sshResize(nextSessionId, cols, rows);
      clearSessionSnapshot(nextSessionId);
      onConnected?.(nextSessionId);
      return true;
    } catch {
      const cleanupError = await cleanupFailedSessionAttach({
        sessionId: nextSessionId,
        unlistenData: unlisten,
        unlistenExit,
        clearMode: (id) => terminalModesStore.clearSession(id),
        clearSnapshot: (id) => clearSessionSnapshot(id),
        disconnect: (id) => sshDisconnect(id),
      });
      unlisten = null;
      unlistenExit = null;
      replayBufferedChunks = null;
      replayBufferedBytes = 0;
      sshDataPaused = false;
      clearPendingOutput();
      sessionId = null;
      connected = false;
      lastProcessedSeq = 0;
      startupScriptDispatcher = null;
      resetParser();
      if (cleanupError) {
        console.error("Failed to clean up attached SSH session:", cleanupError);
      }
      return false;
    }
  }

  function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  function normalizeHostKeyPreflight(result: HostKeyCheckResult): HostKeyPreflightResult {
    if (result.status === "trusted") {
      return { status: "trusted" };
    }

    return {
      status: result.status,
      algorithm: result.algorithm,
      publicKey: result.public_key,
      fingerprint: result.fingerprint,
      knownFingerprints: result.known_fingerprints,
      challengeToken: result.challenge_token,
    };
  }

  async function preflightHostKey(hostToCheck: string, portToCheck: number): Promise<HostKeyPreflightResult> {
    return normalizeHostKeyPreflight(await sshCheckHostKey(hostToCheck, portToCheck));
  }

  function promptHostKey(challenge: HostKeyPromptChallenge): Promise<HostKeyPromptDecision> {
    pendingHostKeyChallenge = challenge;
    resolvingHostKeyTrust = false;
    return new Promise((resolve) => {
      hostKeyPromptResolver = resolve;
    });
  }

  async function trustPresentedHostKey(request: HostKeyTrustRequest): Promise<void> {
    await sshTrustHostKey(request.challengeToken);
  }

  function resolveHostKeyPrompt(decision: HostKeyPromptDecision) {
    if (!hostKeyPromptResolver) return;

    if (decision === "trust") {
      resolvingHostKeyTrust = true;
    } else {
      pendingHostKeyChallenge = null;
      resolvingHostKeyTrust = false;
    }

    const resolve = hostKeyPromptResolver;
    hostKeyPromptResolver = null;
    resolve(decision);
  }

  function clearHostKeyPrompt() {
    pendingHostKeyChallenge = null;
    resolvingHostKeyTrust = false;
    hostKeyPromptResolver = null;
  }

  function sendSessionData(bytes: Uint8Array, silent = false) {
    if (!sessionId) return;
    if (kind === "local") {
      localShellWrite(sessionId, bytes).catch(silent ? () => {} : handleWriteError);
    } else {
      sshWrite(sessionId, bytes).catch(silent ? () => {} : handleWriteError);
    }
  }

  function resizeSessionRemote() {
    if (!sessionId) return;
    if (kind === "local") {
      localShellResize(sessionId, cols, rows).catch(console.error);
    } else {
      sshResize(sessionId, cols, rows).catch(console.error);
    }
  }

  async function disconnectSessionRemote(sid: string) {
    if (kind === "local") {
      await localShellDisconnect(sid);
    } else {
      await sshDisconnect(sid);
    }
  }

  async function bindLocalSessionListener(nextSessionId: string) {
    sshDataPaused = false;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }

    let localSeq = lastProcessedSeq;
    unlisten = await listenLocalData(nextSessionId, (data) => {
      const text = sshOutputDecoder.decode(data);
      if (parser) {
        enqueuePendingOutput(++localSeq, text);
        updateBuffer();
      }
    });

    unlistenExit = await listenLocalExit(nextSessionId, () => {
      if (sessionId !== nextSessionId || disconnectRequested) return;
      connected = false;
      sessionId = null;
      statusMessage = "Local shell exited";
      onDisconnected?.();
    });
  }

  async function connectLocalSession(showError = true): Promise<boolean> {
    sshOutputDecoder.reset();
    statusMessage = "Starting local shell...";
    try {
      const nextSessionId = await localShellStart(cols, rows);
      sessionId = nextSessionId;
      connected = true;
      statusMessage = "";
      terminalModesStore.setAppCursorMode(nextSessionId, false);
      await bindLocalSessionListener(nextSessionId);
      onConnected?.(nextSessionId);
      return true;
    } catch (e) {
      connected = false;
      sessionId = null;
      const message = e instanceof Error ? e.message : String(e);
      statusMessage = `Failed to start local shell: ${message}`;
      if (showError) {
        onError?.(message);
      }
      return false;
    }
  }

  async function connectNewSession(showError = true): Promise<boolean> {
    if (kind === "local") {
      return connectLocalSession(showError);
    }
    sshOutputDecoder.reset();
    statusMessage = `Connecting to ${host}:${port}...`;
    let nextSessionId: string | null = null;

    try {
      const gateResult = await runHostKeyGate({
        target: { host, port },
        preflightHostKey,
        promptHostKey,
        trustHostKey: trustPresentedHostKey,
        clearTrustedHostKeyPrompt: clearHostKeyPrompt,
        connect: connectWithKeyPassphraseRetry,
      });

      if (gateResult.status === "blocked") {
        clearHostKeyPrompt();
        startupScriptDispatcher = null;
        connected = false;
        if (gateResult.reason === "preflight-failed") {
          statusMessage = `Connection failed: ${gateResult.error}`;
          if (showError) {
            onError?.(gateResult.error);
          }
        } else {
          statusMessage = "Connection cancelled";
        }
        return false;
      }

      clearHostKeyPrompt();
      nextSessionId = gateResult.sessionId;
      sessionId = nextSessionId;
      connected = true;
      lastProcessedSeq = 0;
      statusMessage = "";
      terminalModesStore.setAppCursorMode(nextSessionId, false);
      replayBufferedChunks = [];
      replayBufferedBytes = 0;
      await bindSessionListener(nextSessionId);
      const historyChunks = await sshGetSessionOutput(nextSessionId);
      await replayAndDrainSessionChunks(historyChunks);
      const dispatcher = startupScriptDispatcher;
      if (!dispatcher) {
        throw new Error("Startup script dispatcher was not initialized");
      }
      const startupPayload = dispatcher.takeImmediatePayload();
      if (startupPayload) {
        queueWrite(startupPayload);
      }
      onConnected?.(nextSessionId);
      requestNotificationPermission();
      return true;
    } catch (e) {
      replayBufferedChunks = null;
      replayBufferedBytes = 0;
      if (nextSessionId) {
        if (unlisten) {
          unlisten();
          unlisten = null;
        }
        if (unlistenExit) {
          unlistenExit();
          unlistenExit = null;
        }
        if (sessionId === nextSessionId) {
          sessionId = null;
        }
        terminalModesStore.clearSession(nextSessionId);
        clearSessionSnapshot(nextSessionId);
        try {
          await sshDisconnect(nextSessionId);
        } catch (cleanupError) {
          console.error("Failed to clean up partially initialized SSH session:", cleanupError);
        }
      }
      clearHostKeyPrompt();
      startupScriptDispatcher = null;
      connected = false;
      const errorMsg = e instanceof Error ? e.message : String(e);
      statusMessage = `Connection failed: ${errorMsg}`;
      if (showError) {
        onError?.(errorMsg);
      }
      return false;
    }
  }

  function resetParser() {
    parser = new AnsiParser(cols, rows);
    parser.setResponseHandler((data: string) => {
      enqueueAutomaticResponse(data);
    });
    updateBuffer();
  }

  async function reconnectSession(reason: string) {
    if (reconnecting || disconnectRequested) return;
    reconnecting = true;

    const oldSessionId = sessionId;
    connected = false;
    statusMessage = `Reconnecting (${reason})...`;

    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }

    startupScriptDispatcher = null;
    if (oldSessionId) {
      terminalModesStore.clearSession(oldSessionId);
      clearSessionSnapshot(oldSessionId);
      try {
        await disconnectSessionRemote(oldSessionId);
      } catch {
        // old session may already be gone
      }
    }
    sessionId = null;
    lastProcessedSeq = 0;
    resetParser();
    clearAutomaticResponses();

    try {
      const reconnected = await connectNewSession(false);
      if (reconnected) {
        await tick();
        focusInput();
      } else {
        onDisconnected?.();
      }
    } finally {
      reconnecting = false;
    }
  }

  async function probeAndReconnect() {
    if (disconnectRequested || reconnecting) return;
    // Local shells need no liveness probe or history replay on resume.
    if (kind === "local") return;

    if (!sessionId) {
      // Session was lost while backgrounded, try to reconnect
      if (!connected && host) {
        await reconnectSession("resume after disconnect");
      }
      return;
    }

    try {
      await sshResize(sessionId, cols, rows);
      connected = true;
    } catch {
      await reconnectSession("resume");
    }
  }

  function pauseSshDataForBackground() {
    if (kind === "local") return;
    if (!sessionId || !connected || !parser || !unlisten || sshDataPaused) return;

    pauseSshDataSource();
    processPendingOutputSlice(true);
    void sshStoreSessionSnapshot(sessionId, parser.createSnapshot(), lastProcessedSeq).catch(() => {});
  }

  async function writeChunksTimeSliced(chunks: Array<{ seq: number; data: Uint8Array }>) {
    let sliceStart = performance.now();
    for (const chunk of chunks) {
      if (chunk.seq <= lastProcessedSeq) continue;
      const text = sshOutputDecoder.decode(chunk.data);
      const startupPayload = startupScriptDispatcher?.consumeOutput(text);
      if (startupPayload) {
        queueWrite(startupPayload);
      }

      let offset = 0;
      while (offset < text.length) {
        let end = Math.min(offset + 4096, text.length);
        const finalCodeUnit = text.charCodeAt(end - 1);
        if (end < text.length && finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
          end--;
        }
        parser?.write(text.slice(offset, end));
        offset = end;
        if (offset < text.length && performance.now() - sliceStart >= REPLAY_SLICE_BUDGET_MS) {
          updateBuffer();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          sliceStart = performance.now();
        }
      }
      lastProcessedSeq = Math.max(lastProcessedSeq, chunk.seq);
      if (performance.now() - sliceStart >= REPLAY_SLICE_BUDGET_MS) {
        updateBuffer();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    updateBuffer();
  }

  async function replayAndDrainSessionChunks(historyChunks: Array<{ seq: number; data: Uint8Array }>) {
    if (parser && historyChunks.length > 0) {
      await writeChunksTimeSliced(historyChunks);
    }

    while (replayBufferedChunks && replayBufferedChunks.length > 0) {
      const buffered = replayBufferedChunks;
      replayBufferedChunks = [];
      replayBufferedBytes = 0;
      await writeChunksTimeSliced(buffered);
    }
    replayBufferedChunks = null;
    replayBufferedBytes = 0;
  }

  async function resumeAfterBackground() {
    if (kind === "local") return;
    if (resumingSshData) return;
    if (!sshDataPaused || !sessionId || !parser || reconnecting) {
      await probeAndReconnect();
      return;
    }

    resumingSshData = true;
    try {
      do {
        const activeId = sessionId;
        replayBufferedChunks = [];
        replayBufferedBytes = 0;
        await bindSessionListener(activeId);
        const chunks = await sshGetSessionOutput(activeId);
        await replayAndDrainSessionChunks(chunks);
      } while (
        sshDataPaused &&
        pendingDataCharacters === 0 &&
        sessionId &&
        document.visibilityState !== "hidden"
      );
    } catch {
      // probeAndReconnect below decides between reconnect and teardown.
    } finally {
      replayBufferedChunks = null;
      replayBufferedBytes = 0;
      resumingSshData = false;
    }
    await probeAndReconnect();
  }

  async function initTerminal() {
    // 레이아웃이 안정될 때까지 대기 (ExtraKeysBar 등 조건부 컴포넌트 렌더 후)
    await tick();
    await new Promise(r => requestAnimationFrame(r));

    calculateSize();
    resetParser();

    // Setup resize observer
    resizeObserver = new ResizeObserver(() => {
      calculateSize();
    });
    resizeObserver.observe(terminalContainer);

    let attached = false;
    if (kind === "local" && existingSessionId) {
      // A moved local shell is still running in the backend; re-subscribe to
      // its event stream instead of spawning a second shell, and resync the
      // PTY size to the new pane geometry.
      sessionId = existingSessionId;
      connected = true;
      statusMessage = "";
      await bindLocalSessionListener(existingSessionId);
      localShellResize(existingSessionId, cols, rows);
      onConnected?.(existingSessionId);
      attached = true;
    } else if (existingSessionId) {
      attached = await attachExistingSession(existingSessionId);
    }

    if (!attached) {
      await connectNewSession();
    }

    await tick();
    focusInput();
  }

  function focusInput() {
    if (!interactive || selectionMode) return;
    hiddenInput?.focus();
  }

  function handleWrapperClick() {
    if (!interactive) return;

    if (suppressNextFocus) {
      suppressNextFocus = false;
      return;
    }

    if (selectionMode) {
      if (!selectedText.trim()) {
        exitSelectionMode();
      }
      return;
    }
  }

  $effect(() => {
    if (!interactive && hiddenInput && document.activeElement === hiddenInput) {
      hiddenInput.blur();
      return;
    }
  });

  // 설정 변경 감지 — 폰트 크기
  $effect(() => {
    const fs = settingsStore.fontSize;
    if (!renderer) return;
    renderer.updateConfig({
      fontSize: fs,
      fontFamily: FONT_FAMILY,
      lineHeightMultiplier: LINE_HEIGHT_MULTIPLIER,
    });
    measureFont();
    calculateSize();
  });

  // 설정 변경 감지 — 테마
  $effect(() => {
    const themeId = settingsStore.theme;
    if (!renderer) return;
    const def = getThemeById(themeId) ?? THEMES[0];
    renderer.updateConfig({
      defaultFg: def.colors.terminalFg,
      defaultBg: def.colors.terminalBg,
      cursorColor: def.colors.terminalCursor,
    });
    requestRedraw();
  });

  function handleScreenPointerDown(e: PointerEvent) {
    if (statusMessage) return;

    if (e.pointerType === "mouse") {
      if (e.button !== 0) return;
      if (shouldForwardTerminalMouseEvents()) {
        e.preventDefault();
        suppressNextFocus = true;
        terminalMousePointerId = e.pointerId;
        if (scrollContainer && !scrollContainer.hasPointerCapture(e.pointerId)) {
          scrollContainer.setPointerCapture(e.pointerId);
        }
        sendMouseButton(0, pointerToCell(e), true);
        return;
      }

      e.preventDefault();
      suppressNextFocus = true;

      if (selectionMode) {
        beginSelectionAt(e);
        return;
      }

      pendingMouseClick = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startCell: pointerToCell(e),
      };

      if (scrollContainer && !scrollContainer.hasPointerCapture(e.pointerId)) {
        scrollContainer.setPointerCapture(e.pointerId);
      }
      return;
    }

    if (selectionMode) {
      e.preventDefault();
      beginSelectionAt(e);
      return;
    }

    clearTouchLongPressTimer();
    touchPointerId = e.pointerId;
    touchPointerStart = { x: e.clientX, y: e.clientY };
    touchPointerMoved = false;
    longPressTriggered = false;

    touchLongPressTimer = window.setTimeout(() => {
      longPressTriggered = true;
      enterSelectionMode();
      beginSelectionAt(e);
    }, TOUCH_LONG_PRESS_DELAY_MS);
  }


  function handleScreenPointerMove(e: PointerEvent) {
    if (pendingMouseClick?.pointerId === e.pointerId) {
      const dx = e.clientX - pendingMouseClick.startX;
      const dy = e.clientY - pendingMouseClick.startY;
      if (Math.hypot(dx, dy) <= MOUSE_DRAG_SELECTION_THRESHOLD_PX) return;

      e.preventDefault();
      enterSelectionMode();
      selectionDragTarget = 'range';
      selectionHandleBoundary = null;
      selectionPointerId = e.pointerId;
      selectionStart = pendingMouseClick.startCell;
      selectionEnd = pointerToCell(e);
      selectedText = extractSelectedText();
      pendingMouseClick = null;
      requestRedraw();
      return;
    }

    if (selectionMode && selectionStart && selectionPointerId === e.pointerId) {
      e.preventDefault();
      const point = pointerToCell(e);
      if (selectionDragTarget === 'start-handle' || selectionDragTarget === 'end-handle') {
        updateSelectionBoundary(point);
      } else {
        selectionEnd = point;
      }
      selectedText = extractSelectedText();
      requestRedraw();
    }

    if (touchPointerId !== e.pointerId || longPressTriggered || !touchPointerStart) return;

    const dx = e.clientX - touchPointerStart.x;
    const dy = e.clientY - touchPointerStart.y;
    if (Math.hypot(dx, dy) > TOUCH_MOVE_CANCEL_PX) {
      touchPointerMoved = true;
      clearTouchLongPressTimer();
    }
  }

  function resetTouchLongPressState() {
    clearTouchLongPressTimer();
    touchPointerId = null;
    touchPointerStart = null;
    touchPointerMoved = false;
    longPressTriggered = false;
  }

  function handleScreenPointerEnd(e: PointerEvent) {
    if (terminalMousePointerId === e.pointerId) {
      e.preventDefault();
      sendMouseButton(0, pointerToCell(e), false);
      if (scrollContainer?.hasPointerCapture(e.pointerId)) {
        scrollContainer.releasePointerCapture(e.pointerId);
      }
      terminalMousePointerId = null;
    }

    if (pendingMouseClick?.pointerId === e.pointerId) {
      e.preventDefault();
      const point = pointerToCell(e);
      const match = e.type === "pointerup" ? findUrlAtCell(buffer, point) : null;
      pendingMouseClick = null;

      if (scrollContainer?.hasPointerCapture(e.pointerId)) {
        scrollContainer.releasePointerCapture(e.pointerId);
      }

      if (match) {
        void confirmAndOpenTerminalUrl(match.url);
      } else {
        focusInput();
      }
      return;
    }

    if (selectionPointerId === e.pointerId) {
      e.preventDefault();
      const point = pointerToCell(e);
      if (selectionDragTarget === 'start-handle' || selectionDragTarget === 'end-handle') {
        updateSelectionBoundary(point);
      } else {
        selectionEnd = selectionStart ? point : selectionEnd;
      }
      selectedText = extractSelectedText();
      selectionPointerId = null;
      selectionDragTarget = null;
      selectionHandleBoundary = null;
      if (scrollContainer?.hasPointerCapture(e.pointerId)) {
        scrollContainer.releasePointerCapture(e.pointerId);
      }
      // 선택 텍스트가 없으면 (클릭만 한 경우) 선택 모드 해제
      if (!selectedText.trim()) {
        exitSelectionMode();
      } else {
        requestRedraw();
      }
    }

    if (touchPointerId === e.pointerId) {
      if (e.pointerType === "touch" && !touchPointerMoved && !longPressTriggered && touchPointerStart) {
        if (shouldForwardTerminalMouseEvents()) {
          const point = pointerToCell(e);
          sendMouseButton(0, point, true);
          sendMouseButton(0, point, false);
        } else {
          const match = e.type === "pointerup" ? findUrlAtCell(buffer, pointerToCell(e)) : null;
          resetTouchLongPressState();
          if (match) {
            e.preventDefault();
            void confirmAndOpenTerminalUrl(match.url);
            focusInput();
            return;
          }
          focusInput();
          return;
        }
      }
      resetTouchLongPressState();
    }
  }

  // Composition handlers for Korean/CJK input
  function handleCompositionStart() {
    isComposing = true;
    immediateCompositionText = "";
    // 3초 후 자동으로 isComposing 해제 (stuck 방지)
    if (compositionTimeout) clearTimeout(compositionTimeout);
    compositionTimeout = window.setTimeout(() => {
      isComposing = false;
      compositionTimeout = null;
    }, 3000);
  }

  function handleCompositionEnd(e: CompositionEvent) {
    if (compositionTimeout) {
      clearTimeout(compositionTimeout);
      compositionTimeout = null;
    }
    isComposing = false;
    if (sessionId) {
      const data = e.data ?? "";
      if (data.startsWith(immediateCompositionText)) {
        const remainingText = data.slice(immediateCompositionText.length);
        if (remainingText) sendText(remainingText);
      } else if (immediateCompositionText.startsWith(data)) {
        // Composition shrank or was canceled: erase already-sent chars.
        queueWrite("\x7f".repeat(immediateCompositionText.length - data.length));
      } else {
        // Composition replaced (e.g. suggestion pick): erase, then send anew.
        queueWrite("\x7f".repeat(immediateCompositionText.length));
        sendText(data);
      }
    }
    immediateCompositionText = "";
    if (hiddenInput) {
      hiddenInput.value = "";
    }
  }

  // Handle textarea input (main input method for mobile)
  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    const inputEvent = e as InputEvent;

    if (!sessionId) return;

    const value = target.value;
    // Backspace must edit already-sent terminal text, but should not leak
    // remote DELs while CJK composition is still local-only.
    if (inputEvent.inputType === "deleteContentBackward") {
      if (!isComposing) {
        queueWrite("\x7f");
        target.value = "";
      } else if (immediateCompositionText.length > 0) {
        queueWrite("\x7f");
        immediateCompositionText = immediateCompositionText.slice(0, -1);
        target.value = "";
      }
      // Pure-CJK composition is still local-only: leave the composing textarea alone.
      return;
    }

    // Samsung keyboard clipboard panel image paste: comes as insertFromPaste input event
    if (inputEvent.inputType === "insertFromPaste") {
      target.value = "";
      // Try reading image from clipboard via Android plugin
      void (async () => {
        try {
          const result = await readClipboardImage();
          if (result.found && result.localPath) {
            await uploadClipboardImageFromLocalPath(result.localPath);
            return;
          }
        } catch {
          // readClipboardImage not available or failed
        }
        // If no image found, treat as text paste
        const clipText = inputEvent.data;
        if (clipText) {
          sendPastedText(clipText);
        }
      })();
      return;
    }

    // Samsung Keyboard composes even English letters on some devices. Terminal
    // input should receive printable ASCII immediately; keep CJK composition
    // deferred until compositionend.
    if (isComposing) {
      const text = value || inputEvent.data || "";
      if (
        inputEvent.inputType === "insertCompositionText" &&
        /^[\x20-\x7e]*$/.test(text) &&
        (text || immediateCompositionText)
      ) {
        if (text.startsWith(immediateCompositionText)) {
          const nextText = text.slice(immediateCompositionText.length);
          if (nextText) sendText(nextText);
        } else if (immediateCompositionText.startsWith(text)) {
          // IME deleted composed chars (backspace reported as composition update).
          queueWrite("\x7f".repeat(immediateCompositionText.length - text.length));
        } else {
          // IME replaced the composition (e.g. suggestion pick).
          queueWrite("\x7f".repeat(immediateCompositionText.length));
          sendText(text);
        }
        immediateCompositionText = text;
        target.value = "";
      }
      return;
    }

    // Handle Enter (newline in value)
    if (value.includes("\n") || value.includes("\r")) {
      const parts = value.split(/[\r\n]/);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part) {
          sendText(part);
        }
        if (i < parts.length - 1) {
          queueWrite("\r");
        }
      }
      target.value = "";
      return;
    }

    // Normal text (non-composing)
    if (value) {
      sendText(value);
      target.value = "";
    }
  }

  // Handle keydown for special keys
  function handleKeyDown(e: KeyboardEvent) {
    if (!sessionId) return;

    // Enter key
    if (e.key === "Enter") {
      e.preventDefault();
      queueWrite("\r");
      return;
    }

    // Backspace
    if (e.key === "Backspace") {
      e.preventDefault();
      queueWrite("\x7f");
      return;
    }

    // Tab
    if (e.key === "Tab") {
      e.preventDefault();
      queueWrite("\t");
      return;
    }

    // Escape
    if (e.key === "Escape") {
      e.preventDefault();
      queueWrite("\x1b");
      return;
    }

    // Arrow keys
    const appCursorMode = parser?.isApplicationCursorKeys() ?? false;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      queueWrite(getArrowKeyCode("up", appCursorMode));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      queueWrite(getArrowKeyCode("down", appCursorMode));
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      queueWrite(getArrowKeyCode("right", appCursorMode));
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      queueWrite(getArrowKeyCode("left", appCursorMode));
      return;
    }

    // Control characters: Ctrl+letter → C0 control byte (Ctrl+C = SIGINT,
    // Ctrl+D = EOF, Ctrl+U, Ctrl+W ...). The shell cannot work without them.
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const lower = e.key.toLowerCase();
      if (lower >= "a" && lower <= "z") {
        e.preventDefault();
        queueWrite(String.fromCharCode(lower.charCodeAt(0) - 96));
        return;
      }
    }
  }

  function handleWriteError(e: unknown) {
    console.error('[SSH] write failed:', e);
    if (String(e).includes('Channel closed') || String(e).includes('closed')) {
      void reconnectSession("channel closed");
    }
  }

  function clearAutomaticResponses() {
    automaticResponseQueue = [];
    automaticResponseBytes = 0;
    automaticResponseSending = false;
    automaticResponseWindowStartedAt = 0;
    automaticResponseCount = 0;
    protocolFloodDetected = false;
  }

  function stopForAutomaticResponseFlood() {
    if (protocolFloodDetected) return;
    protocolFloodDetected = true;
    automaticResponseQueue = [];
    automaticResponseBytes = 0;
    statusMessage = "Connection closed: excessive terminal status requests";
    void disconnect();
  }

  async function drainAutomaticResponses() {
    if (automaticResponseSending) return;
    automaticResponseSending = true;
    try {
      while (automaticResponseQueue.length > 0) {
        const activeSessionId = sessionId;
        if (!activeSessionId) break;
        const response = automaticResponseQueue.shift()!;
        automaticResponseBytes -= response.length;
        sendSessionData(encoder.encode(response));
      }
    } catch (error) {
      handleWriteError(error);
    } finally {
      automaticResponseSending = false;
      if (automaticResponseQueue.length > 0 && sessionId) {
        void drainAutomaticResponses();
      }
    }
  }

  function enqueueAutomaticResponse(data: string) {
    if (!sessionId || data.length === 0) return;
    const now = performance.now();
    if (
      automaticResponseWindowStartedAt === 0 ||
      now - automaticResponseWindowStartedAt >= 1000
    ) {
      automaticResponseWindowStartedAt = now;
      automaticResponseCount = 0;
    }
    // Identical consecutive replies are coalesced and must not consume the
    // flood budget (prompt themes legitimately re-ask the same query).
    if (automaticResponseQueue.at(-1) === data) return;
    automaticResponseCount++;
    if (automaticResponseCount > MAX_AUTOMATIC_RESPONSES_PER_SECOND) {
      stopForAutomaticResponseFlood();
      return;
    }
    if (
      automaticResponseQueue.length >= MAX_AUTOMATIC_RESPONSE_QUEUE ||
      automaticResponseBytes + data.length > MAX_AUTOMATIC_RESPONSE_BYTES
    ) {
      stopForAutomaticResponseFlood();
      return;
    }
    automaticResponseQueue.push(data);
    automaticResponseBytes += data.length;
    void drainAutomaticResponses();
  }

  function queueWrite(data: string) {
    if (!sessionId || data.length === 0) return;
    pendingWrite += data;
    if (writeFlushScheduled) return;

    writeFlushScheduled = true;
    queueMicrotask(() => {
      writeFlushScheduled = false;
      if (!sessionId || pendingWrite.length === 0) return;

      const payload = pendingWrite;
      pendingWrite = "";
      sendSessionData(encoder.encode(payload));
    });
  }

  function sendText(text: string) {
    if (!sessionId) return;

    let data = text;

    // Apply modifiers for single character
    if (data.length === 1) {
      if (modifiersStore.ctrlActive) {
        data = ctrlKey(data);
        modifiersStore.resetCtrl();
      } else if (modifiersStore.altActive) {
        data = altKey(data);
        modifiersStore.resetAlt();
      }
    }

    if (data) queueWrite(data);
  }

  onDestroy(() => {
    const activeSessionId = sessionId;
    const isBackgroundTeardown =
      typeof document !== "undefined" && document.visibilityState === "hidden";

    if (activeSessionId && isBackgroundTeardown && kind === "ssh") {
      if (parser) {
        void sshStoreSessionSnapshot(activeSessionId, parser.createSnapshot(), lastProcessedSeq).catch((e) => {
          console.error("Store session snapshot error:", e);
        });
      }
    }

    // Disconnect SSH session when tab is closed. Callers moving a live
    // terminal between containers opt out via disconnectOnDestroy and
    // re-attach with existingSessionId.
    if (activeSessionId && !isBackgroundTeardown && disconnectOnDestroy) {
      disconnectRequested = true;
      void disconnectSessionRemote(activeSessionId).catch((e) => {
        console.error("Disconnect on destroy error:", e);
      });
    }

    clearTouchLongPressTimer();

    clearSelectionFeedbackTimer();
    if (visibilityChangeHandler) {
      document.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    if (androidImagePasteHandler) {
      window.removeEventListener("redterm:android-image-paste", androidImagePasteHandler);
      androidImagePasteHandler = null;
    }
    if (compositionTimeout) {
      clearTimeout(compositionTimeout);
    }
    if (deferredUpdateTimer) {
      clearTimeout(deferredUpdateTimer);
      deferredUpdateTimer = null;
    }
    if (cursorInterval) {
      clearInterval(cursorInterval);
    }
    if (renderer) {
      renderer.destroy();
      renderer = null;
    }
    pendingWrite = "";
    writeFlushScheduled = false;
    clearAutomaticResponses();
    if (hiddenInput) {
      hiddenInput.removeEventListener('input', handleInput);
      hiddenInput.removeEventListener('keydown', handleKeyDown);
      hiddenInput.removeEventListener('compositionstart', handleCompositionStart);
      hiddenInput.removeEventListener('compositionend', handleCompositionEnd);
      if (pasteHandler) {
        hiddenInput.removeEventListener('paste', pasteHandler);
      }
      if (blurHandler) {
        hiddenInput.removeEventListener('blur', blurHandler);
      }
    }
    blurHandler = null;
    pasteHandler = null;
    resizeObserver?.disconnect();
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }

    if (
      activeSessionId &&
      !disconnectRequested &&
      !isBackgroundTeardown &&
      disconnectOnDestroy
    ) {
      terminalModesStore.clearSession(activeSessionId);
      clearSessionSnapshot(activeSessionId);
      void disconnectSessionRemote(activeSessionId).catch((e) => {
        console.error("Unmount disconnect error:", e);
      });
      onDisconnected?.();
    }
  });

  // Export functions for external use (ExtraKeysBar)
  export function write(data: string | Uint8Array) {
    if (sessionId) {
      if (typeof data === "string") {
        queueWrite(data);
      } else {
        sendSessionData(data);
      }
    }
  }

  export async function disconnect() {
    disconnectRequested = true;

    const activeSessionId = sessionId;
    sessionId = null;
    connected = false;
    pendingWrite = "";
    writeFlushScheduled = false;
    clearAutomaticResponses();

    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }

    if (activeSessionId) {
      terminalModesStore.clearSession(activeSessionId);
      clearSessionSnapshot(activeSessionId);
      try {
        await disconnectSessionRemote(activeSessionId);
      } catch (e) {
        console.error("Disconnect error:", e);
      }
    }

    onDisconnected?.();
  }

  export function focus() {
    focusInput();
  }

  /// Persist the current screen so a caller moving this terminal between
  /// containers can restore it exactly after the remount.
  export function storeSnapshot() {
    if (sessionId && parser) {
      void sshStoreSessionSnapshot(sessionId, parser.createSnapshot(), lastProcessedSeq).catch(
        () => {}
      );
    }
  }

  /// Re-measure the container and push the current geometry to the PTY.
  /// Called after pane moves/splits, where the container may have settled
  /// after the initial attach.
  export function syncSize() {
    calculateSize();
    resizeSessionRemote();
  }

  export function blur() {
    suppressBlurRefocus = true;
    hiddenInput?.blur();
  }

  export function resize() {
    calculateSize();
  }

  function isErrorStatus(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes("connection lost") || lower.includes("connection failed");
  }

  function getStatusTitle(message: string): string {
    if (isErrorStatus(message)) return "Connection Lost";
    return "Connecting";
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="terminal-wrapper"
  bind:this={terminalContainer}
  onclick={handleWrapperClick}
>
  <!-- Hidden input for keyboard capture -->
  <textarea
    bind:this={hiddenInput}
    class="hidden-input"
    inputmode="none"
    autocomplete="off"
    autocapitalize="off"
    data-autocorrect="off"
    spellcheck="false"
    enterkeyhint="send"
  ></textarea>

  <!-- Status message -->
  {#if statusMessage}
    <div class="status-overlay" class:error={isErrorStatus(statusMessage)}>
      <div class="status-card">
        <div class="status-header">
          <span class="status-indicator" aria-hidden="true"></span>
          <strong>{getStatusTitle(statusMessage)}</strong>
        </div>
        <div class="status-message">{statusMessage}</div>
      </div>
    </div>
  {/if}

  {#if showSelectionToolbar || selectionFeedback}
    <div class="selection-toolbar">
      {#if showSelectionToolbar}
        <button class="selection-action-btn secondary" onclick={(e) => { swallowPointerClick(e); cancelSelection(); }}>
          Cancel
        </button>
        <button class="selection-action-btn" onclick={(e) => { swallowPointerClick(e); void copySelectedText(); }} disabled={!canCopySelection}>
          Copy
        </button>
      {/if}
      {#if selectionFeedback}
        <span class="selection-feedback">{selectionFeedback}</span>
      {/if}
    </div>
  {/if}

  {#if pendingTerminalUrl}
    <div class="link-dialog-backdrop" role="presentation" onclick={(e) => e.stopPropagation()} onpointerdown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div
        class="link-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-dialog-title"
        aria-describedby="link-dialog-origin link-dialog-url"
        onpointerdown={swallowPointerPress}
        tabindex="-1"
      >
        <div class="link-dialog-mark" aria-hidden="true">↗</div>
        <div class="link-dialog-content">
          <p class="link-dialog-kicker">External link</p>
          <h2 id="link-dialog-title">Open this URL?</h2>
          <p id="link-dialog-origin" class="link-dialog-origin" dir="ltr">{pendingTerminalUrl.origin}</p>
          <p id="link-dialog-url" class="link-dialog-url" dir="ltr">{pendingTerminalUrl.url}</p>
        </div>
        <div class="link-dialog-actions">
          <button
            type="button"
            class="link-dialog-btn ghost"
            onpointerdown={(e) => { swallowPointerPress(e); cancelPendingTerminalUrl(); }}
            onclick={(e) => { swallowPointerClick(e); cancelPendingTerminalUrl(); }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="link-dialog-btn primary"
            onpointerdown={(e) => { swallowPointerPress(e); void openPendingTerminalUrl(); }}
            onclick={(e) => { swallowPointerClick(e); void openPendingTerminalUrl(); }}
            disabled={openingTerminalUrl}
          >
            {openingTerminalUrl ? "Opening…" : "Open"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if pendingHostKeyChallenge}
    <div class="link-dialog-backdrop" role="presentation" onclick={(e) => e.stopPropagation()} onpointerdown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div
        class="link-dialog-card host-key-dialog-card"
        class:warning={pendingHostKeyChallenge.kind === "changed"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-key-dialog-title"
        aria-describedby="host-key-dialog-description"
        onpointerdown={swallowPointerPress}
        tabindex="-1"
      >
        <div class="link-dialog-mark host-key-dialog-mark" class:warning={pendingHostKeyChallenge.kind === "changed"} aria-hidden="true">
          {pendingHostKeyChallenge.kind === "changed" ? "!" : "?"}
        </div>
        <div class="link-dialog-content">
          <p class="link-dialog-kicker">
            {pendingHostKeyChallenge.kind === "changed" ? "SSH host key changed" : "New SSH host key"}
          </p>
          <h2 id="host-key-dialog-title">
            {pendingHostKeyChallenge.kind === "changed" ? "Replace saved host key?" : "Trust this server?"}
          </h2>
          <p id="host-key-dialog-description" class="host-key-dialog-copy">
            {pendingHostKeyChallenge.kind === "changed"
              ? "The saved key for this server no longer matches. Only replace it if you trust this server."
              : "This server is not in known hosts yet. Verify the fingerprint before connecting."}
          </p>
          <div class="host-key-dialog-meta">
            <span>{pendingHostKeyChallenge.host}:{pendingHostKeyChallenge.port}</span>
            <span>{pendingHostKeyChallenge.algorithm}</span>
          </div>
          <p class="link-dialog-url host-key-fingerprint">{pendingHostKeyChallenge.fingerprint}</p>
          {#if pendingHostKeyChallenge.knownFingerprints?.length}
            <div class="known-host-fingerprints">
              <span>Previously trusted</span>
              {#each pendingHostKeyChallenge.knownFingerprints as fingerprint}
                <code>{fingerprint}</code>
              {/each}
            </div>
          {/if}
        </div>
        <div class="link-dialog-actions">
          <button
            type="button"
            class="link-dialog-btn ghost"
            onpointerdown={(e) => { swallowPointerPress(e); resolveHostKeyPrompt("cancel"); }}
            onclick={(e) => { swallowPointerClick(e); resolveHostKeyPrompt("cancel"); }}
            disabled={resolvingHostKeyTrust}
          >
            Cancel
          </button>
          <button
            type="button"
            class="link-dialog-btn primary"
            class:warning={pendingHostKeyChallenge.kind === "changed"}
            onpointerdown={(e) => { swallowPointerPress(e); resolveHostKeyPrompt("trust"); }}
            onclick={(e) => { swallowPointerClick(e); resolveHostKeyPrompt("trust"); }}
            disabled={resolvingHostKeyTrust}
          >
            {resolvingHostKeyTrust
              ? "Saving…"
              : pendingHostKeyChallenge.kind === "changed"
                ? "Replace and connect"
                : "Trust and connect"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if pendingKeyPassphrasePrompt}
    <div class="link-dialog-backdrop" role="presentation" onclick={(e) => e.stopPropagation()} onpointerdown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div
        class="link-dialog-card passphrase-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-passphrase-dialog-title"
        aria-describedby="key-passphrase-dialog-description"
        onpointerdown={(e) => e.stopPropagation()}
        tabindex="-1"
      >
        <div class="link-dialog-mark" aria-hidden="true">⌁</div>
        <div class="link-dialog-content">
          <p class="link-dialog-kicker">SSH key passphrase</p>
          <h2 id="key-passphrase-dialog-title">Unlock private key?</h2>
          <p id="key-passphrase-dialog-description" class="host-key-dialog-copy">
            Enter the passphrase if this private key is encrypted. Leave it blank for unencrypted keys.
          </p>
          <p class="link-dialog-url host-key-fingerprint">{pendingKeyPassphrasePrompt.keyId}</p>
          <input
            class="passphrase-dialog-input"
            type="password"
            bind:value={keyPassphraseInput}
            autocomplete="current-password"
            placeholder="Passphrase"
          />
        </div>
        <div class="link-dialog-actions">
          <button
            type="button"
            class="link-dialog-btn ghost"
            onpointerdown={(e) => { swallowPointerPress(e); resolveKeyPassphrasePrompt(null); }}
            onclick={(e) => { swallowPointerClick(e); resolveKeyPassphrasePrompt(null); }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="link-dialog-btn primary"
            onpointerdown={(e) => { swallowPointerPress(e); resolveKeyPassphrasePrompt(keyPassphraseInput); }}
            onclick={(e) => { swallowPointerClick(e); resolveKeyPassphrasePrompt(keyPassphraseInput); }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Terminal screen (scrollable) -->
  <div
    class="terminal-screen"
    class:selection-mode={selectionMode}
    bind:this={scrollContainer}
    onscroll={handleTerminalScroll}
    oncontextmenu={(e) => e.preventDefault()}
    onpointerdown={handleScreenPointerDown}
    onpointermove={handleScreenPointerMove}
    onpointerup={handleScreenPointerEnd}
    onpointercancel={handleScreenPointerEnd}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    ontouchcancel={handleTouchEnd}
  >
    <!-- Height filler for native scrolling -->
    <div bind:this={heightFiller} class="height-filler"></div>

    <!-- Canvas -->
    <canvas
      bind:this={canvasEl}
      class="terminal-canvas"
    ></canvas>

    {#if !isDesktopTarget && selectionMode && selectionStart && selectionEnd}
      <button
        type="button"
        class="selection-handle selection-handle-start"
        aria-label="Adjust selection start"
        style={getSelectionHandleStyle('start')}
        onclick={swallowPointerClick}
        onpointerdown={(e) => startSelectionHandleDrag(e, 'start')}
      >
        <span class="selection-handle-knob"></span>
      </button>
      <button
        type="button"
        class="selection-handle selection-handle-end"
        aria-label="Adjust selection end"
        style={getSelectionHandleStyle('end')}
        onclick={swallowPointerClick}
        onpointerdown={(e) => startSelectionHandleDrag(e, 'end')}
      >
        <span class="selection-handle-knob"></span>
      </button>
    {/if}
  </div>
</div>

<style>
  .terminal-wrapper {
    width: 100%;
    height: 100%;
    background: var(--terminal-bg, #1a0f0f);
    overflow: hidden;
    position: relative;
    isolation: isolate;
  }

  .hidden-input {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    background: transparent;
    border: none;
    outline: none;
    resize: none;
    color: transparent;
    caret-color: transparent;
    z-index: -1;
    pointer-events: none;
    -webkit-tap-highlight-color: transparent;
  }

  .status-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(16, 8, 8, 0.45);
    backdrop-filter: blur(2px);
    z-index: 10;
    pointer-events: none;
  }

  .selection-toolbar {
    position: absolute;
    top: 12px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    z-index: 11;
  }

  .selection-action-btn {
    border: none;
    border-radius: 999px;
    padding: 8px 14px;
    background: rgba(255, 107, 107, 0.96);
    color: #1a0f0f;
    font-size: 12px;
    font-weight: 700;
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
    transition: opacity 0.18s ease;
  }

  .selection-action-btn.secondary {
    background: rgba(48, 18, 18, 0.96);
    color: #ffdada;
  }

  .selection-action-btn:disabled {
    opacity: 0.45;
  }

  .selection-feedback {
    padding: 7px 10px;
    border-radius: 999px;
    background: rgba(48, 18, 18, 0.92);
    color: #ffdada;
    font-size: 12px;
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
  }

  .link-dialog-backdrop {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
    padding-block: max(18px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-bottom));
    background:
      radial-gradient(circle at 50% 72%, color-mix(in srgb, var(--accent-primary) 18%, transparent), transparent 34%),
      color-mix(in srgb, var(--bg-primary) 72%, transparent);
    backdrop-filter: blur(8px);
  }

  .link-dialog-card {
    width: min(100%, 520px);
    border: 1px solid color-mix(in srgb, var(--accent-primary) 32%, var(--border-secondary));
    border-radius: 26px;
    padding: 18px;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 14px;
    color: var(--text-primary);
    background:
      linear-gradient(
        145deg,
        color-mix(in srgb, var(--bg-secondary) 92%, var(--accent-primary)),
        color-mix(in srgb, var(--bg-primary) 96%, var(--bg-secondary))
      );
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.54),
      inset 0 1px 0 color-mix(in srgb, var(--terminal-fg) 10%, transparent);
  }

  .link-dialog-mark {
    width: 42px;
    height: 42px;
    border-radius: 15px;
    display: grid;
    place-items: center;
    color: var(--bg-primary);
    background: linear-gradient(135deg, var(--accent-primary), var(--accent-hover));
    font-size: 22px;
    font-weight: 800;
    box-shadow: 0 12px 24px color-mix(in srgb, var(--accent-primary) 26%, transparent);
  }

  .link-dialog-content {
    min-width: 0;
  }

  .link-dialog-kicker {
    margin: 1px 0 4px;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .link-dialog-card h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: 20px;
    line-height: 1.15;
    letter-spacing: -0.02em;
  }

  .link-dialog-origin {
    margin: 12px 0 0;
    color: var(--text-primary);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 17px;
    font-weight: 800;
    direction: ltr;
    unicode-bidi: isolate;
    overflow-wrap: anywhere;
  }

  .link-dialog-url {
    margin: 12px 0 0;
    padding: 11px 12px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, var(--border-secondary));
    color: var(--terminal-fg);
    background: color-mix(in srgb, var(--terminal-bg) 78%, var(--bg-primary));
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 13px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .link-dialog-actions {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 4px;
  }

  .link-dialog-btn {
    min-height: 46px;
    border: none;
    border-radius: 16px;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.01em;
  }

  .link-dialog-btn.ghost {
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-tertiary) 82%, transparent);
  }

  .link-dialog-btn.primary {
    color: var(--bg-primary);
    background: linear-gradient(135deg, var(--accent-primary), var(--accent-hover));
    box-shadow: 0 12px 28px color-mix(in srgb, var(--accent-primary) 26%, transparent);
  }

  .link-dialog-btn.primary.warning {
    color: var(--bg-primary);
    background: linear-gradient(135deg, var(--status-warning), color-mix(in srgb, var(--status-warning) 78%, var(--accent-hover)));
    box-shadow: 0 12px 28px color-mix(in srgb, var(--status-warning) 26%, transparent);
  }

  .host-key-dialog-card.warning {
    border-color: color-mix(in srgb, var(--status-warning) 44%, var(--border-secondary));
  }

  .host-key-dialog-mark.warning {
    background: linear-gradient(135deg, var(--status-warning), color-mix(in srgb, var(--status-warning) 72%, var(--accent-hover)));
    box-shadow: 0 12px 24px color-mix(in srgb, var(--status-warning) 26%, transparent);
  }

  .host-key-dialog-copy {
    margin: 10px 0 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.45;
  }

  .host-key-dialog-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .host-key-dialog-meta span {
    padding: 5px 8px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-tertiary) 82%, transparent);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 11px;
  }

  .host-key-fingerprint {
    user-select: text;
  }

  .known-host-fingerprints {
    margin-top: 10px;
    display: grid;
    gap: 6px;
  }

  .known-host-fingerprints span {
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .known-host-fingerprints code {
    padding: 8px 10px;
    border-radius: 12px;
    color: var(--status-warning);
    background: color-mix(in srgb, var(--terminal-bg) 78%, var(--bg-primary));
    border: 1px solid color-mix(in srgb, var(--status-warning) 28%, var(--border-secondary));
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", monospace;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .passphrase-dialog-card {
    border-color: color-mix(in srgb, var(--accent-primary) 36%, var(--border-secondary));
  }

  .passphrase-dialog-input {
    width: 100%;
    margin-top: 12px;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, var(--border-secondary));
    background: color-mix(in srgb, var(--bg-tertiary) 72%, var(--bg-primary));
    color: var(--text-primary);
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .passphrase-dialog-input:focus {
    border-color: var(--accent-primary);
  }

  .link-dialog-btn:disabled {
    opacity: 0.62;
  }

  .status-card {
    min-width: 240px;
    max-width: min(90vw, 420px);
    padding: 14px 16px;
    border-radius: 10px;
    border: 1px solid rgba(255, 144, 144, 0.35);
    background: rgba(48, 18, 18, 0.92);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.38);
    color: #ffdada;
  }

  .status-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 14px;
    letter-spacing: 0.2px;
  }

  .status-indicator {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #ff5b5b;
    box-shadow: 0 0 0 4px rgba(255, 91, 91, 0.2);
  }

  .status-message {
    color: #ffdada;
    font-size: 13px;
    line-height: 1.4;
    word-break: break-word;
  }

  .status-overlay:not(.error) .status-card {
    border-color: rgba(255, 220, 130, 0.35);
    background: rgba(52, 42, 16, 0.9);
    color: #ffeac4;
  }

  .status-overlay:not(.error) .status-indicator {
    background: #ffd86b;
    box-shadow: 0 0 0 4px rgba(255, 216, 107, 0.22);
  }

  .status-overlay:not(.error) .status-message {
    color: #ffeac4;
  }

  .terminal-screen {
    width: 100%;
    height: 100%;
    padding: 0 var(--terminal-horizontal-padding, 4px);
    overflow-y: auto;
    overflow-x: clip;
    /* Edge rubber-band + scroll chaining fight the sticky canvas repaint
       on macOS — contain them inside the terminal scroller. */
    overscroll-behavior-y: contain;
    box-sizing: border-box;
    -webkit-overflow-scrolling: touch; /* 모바일 스크롤 부드럽게 */
    contain: layout style paint;
    position: relative;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    touch-action: pan-y;
    overscroll-behavior: contain;
    background: var(--terminal-bg, #1a0f0f);
  }

  .terminal-screen.selection-mode {
    cursor: text;
    touch-action: none;
  }

  .terminal-canvas {
    position: sticky;
    top: 0;
    left: 0;
    display: block;
    pointer-events: none;
    z-index: 0;
  }

  .selection-handle {
    position: absolute;
    width: 30px;
    height: 30px;
    margin-left: -15px;
    margin-top: 0;
    border: none;
    background: transparent;
    padding: 0;
    z-index: 2;
    touch-action: none;
  }

  .selection-handle-knob {
    position: absolute;
    left: 50%;
    top: 0;
    width: 18px;
    height: 18px;
    margin-left: -9px;
    border-radius: 999px;
    background: #ff6b6b;
    border: 2px solid rgba(255, 255, 255, 0.92);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.35);
  }

  .selection-handle-knob::after {
    content: '';
    position: absolute;
    left: 50%;
    top: -10px;
    width: 2px;
    height: 12px;
    margin-left: -1px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
  }


  .height-filler {
    width: 1px;
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    z-index: -1;
  }

</style>
