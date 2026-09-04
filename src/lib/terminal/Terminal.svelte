<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { AnsiParser, type Cell, type TerminalOscEvent, type TerminalSnapshot } from "./ansi-parser";
  import { CanvasRenderer } from './CanvasRenderer';
  import {
    MAX_CLIPBOARD_IMAGE_BYTES,
    confirmAction,
    getKeyboardLayoutMap,
    listenKeyboardLayoutChanged,
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
    readClipboardText,
    writeClipboardText,
    sshCheckHostKey,
    sshTrustHostKey,
    localShellGetOutput,
    localShellStart,
    localShellWrite,
    localShellResize,
    localShellDisconnect,
    listenLocalData,
    listenLocalExit,
    type AuthConfig,
    type HostKeyCheckResult,
    type KeyboardLayoutMap,
  } from "$lib/tauri/commands";
  import { modifiersStore } from "$lib/stores/modifiers.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import { terminalModesStore } from "$lib/stores/terminal-modes.svelte";
  import { terminalModalGate } from "$lib/stores/terminal-modal-gate.svelte";
  import { ctrlKey, altKey, getArrowKeyCode } from "$lib/utils/key-mapper";
  import { settingsStore, terminalFontStack } from "$lib/stores/settings.svelte";
  import { createStartupScriptDispatcher, type StartupScriptDispatcher } from "./startup-script";
  import { findUrlAtCell, validateTerminalUrl, type SafeTerminalUrl } from "./terminal-links";
  import { extractTerminalSelection } from "./terminal-selection";
  import { formatTerminalPaste } from "./terminal-paste";
  import { encodeTerminalMouseEvent, terminalMouseCellFromPoint } from "./terminal-mouse";
  import {
    resolveTerminalClipboardImagePath,
    writeTerminalClipboardText,
  } from "./terminal-clipboard";
  import CloseConfirmationModal from "../desktop/workspace/CloseConfirmationModal.svelte";
  import { Osc52SessionGate } from "./terminal-osc52";
  import { SshOutputDecoder } from "./ssh-output-decoder";
  import { cleanupFailedSessionAttach } from "./session-attach-cleanup";
  import { AutomaticResponseBuffer } from "./automatic-response-buffer";
  import {
    clearRuntimeSessionSnapshot,
    storeRuntimeSessionSnapshot,
    takeRuntimeSessionSnapshot,
  } from "./session-runtime-snapshot";
  import { composeJamoSequence, HangulComposer } from "./hangul-compose";
  import {
    encodeKittyInputText,
    encodeKittyKeyboardEvent,
    encodeTerminalKeyboardEvent,
    resolveKittyLayoutKey,
    type KittyKeyboardEvent,
  } from "./kitty-keyboard";
  import type { HangulFeedResult } from "./hangul-compose";
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
    onRetryConnection?: () => void;
    onEditConnection?: () => void;
    onCloseTab?: () => void;
    closeTabPending?: boolean;
    onTitleChange?: (title: string) => void;
  }
  type TerminalMouseModifiers = Pick<
    MouseEvent,
    "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >;

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
    onError,
    onRetryConnection,
    onEditConnection,
    onCloseTab,
    closeTabPending = false,
    onTitleChange
  }: Props = $props();

  // Terminal state
  let terminalContainer: HTMLDivElement;
  let scrollContainer: HTMLDivElement;
  let currentDirectoryUri: string | null = null;
  let hiddenInput: HTMLTextAreaElement;
  let parser: AnsiParser | null = null;

  // Keep every parser instance aligned with the configured scrollback size.
  $effect(() => {
    parser?.setMaxScrollback(settingsStore.scrollbackLines);
  });
  let sessionId: string | null = null;
  let unlisten: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let connected = $state(false);
  let resizeObserver: ResizeObserver | null = null;
  let surfaceVisibilityObserver: IntersectionObserver | null = null;
  let terminalSurfaceIntersecting = false;
  let terminalSurfaceVisible = false;

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
  let destroyed = false;
  let parserGeneration = 0;
  let pendingHostKeyChallenge = $state<HostKeyPromptChallenge | null>(null);
  let resolvingHostKeyTrust = $state(false);
  let hostKeyPromptResolver: ((decision: HostKeyPromptDecision) => void) | null = null;
  let pendingKeyPassphrasePrompt = $state<{ keyId: string } | null>(null);
  let keyPassphraseInput = $state("");
  let keyPassphrasePromptResolver: ((passphrase: string | null) => void) | null = null;

  let osc52ApprovalOpen = $state(false);
  let osc52ApprovalResolver: ((decision: boolean) => void) | null = null;

  function requestOsc52Approval(): Promise<boolean> {
    terminalModalGate.enter();
    osc52ApprovalOpen = true;
    return new Promise((resolve) => {
      osc52ApprovalResolver = resolve;
    });
  }

  function settleOsc52Approval(decision: boolean) {
    if (!osc52ApprovalResolver) return;
    const resolver = osc52ApprovalResolver;
    osc52ApprovalResolver = null;
    osc52ApprovalOpen = false;
    terminalModalGate.exit();
    resolver(decision);
  }
  let keyPassphraseRetryCache = createKeyPassphraseRetryCache();
  let keyPassphraseRetryKeyId: string | null = null;
  const TERMINAL_SNAPSHOT_STORAGE_KEY = "redterm.sessionSnapshots.v1";
  const MAX_SESSION_SNAPSHOTS = 20;
  const SESSION_SNAPSHOT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 3;

  // Font metrics
  const LINE_HEIGHT_MULTIPLIER = 1.4;
  const TERMINAL_HORIZONTAL_PADDING_PX = 8;
  let charWidth = $state(8.4);
  let charHeight = $state(Math.round(settingsStore.fontSize * LINE_HEIGHT_MULTIPLIER));

  function compositionInputStyle(position: { x: number; y: number } = cursorPos): string {
    const left = TERMINAL_HORIZONTAL_PADDING_PX + position.x * charWidth;
    const top = position.y * charHeight - viewportTop;
    return `left: calc(var(--terminal-horizontal-padding, 4px) + ${left}px); top: ${top}px; height: ${charHeight}px; font-size: ${settingsStore.fontSize}px; line-height: ${charHeight}px; font-family: ${terminalFontStack(settingsStore.terminalFontFamily)};`;
  }

  function hasUsableCompositionAnchor(): boolean {
    return (
      !compositionAnchorLost &&
      (!parser || parser.isAlternateScreen() === compositionAnchorAlternateScreen)
    );
  }

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
  let replayBufferOverflowed = false;
  let replayBufferedBytes = 0;
  let sshDataPaused = false;
  let resumingSshData = false;
  let viewportUpdatePending = false;
  let autoStickToBottom = true;
  let reconnecting = false;
  let disconnectRequested = false;
  let connectionGeneration = 0;

  // Remote servers must earn clipboard access (OSC 52) once per connection
  // generation; local shells are trusted. The gate keys approval to the
  // generation, so every reconnect requires fresh approval without any
  // explicit reset call site.
  const osc52SessionGate = new Osc52SessionGate();
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
  let terminalMouseButton: number | null = null;
  let localSelectionPointerId: number | null = null;
  let lastTerminalMouseCell: { row: number; col: number } | null = null;
  let desktopWheelRows = 0;
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

  function createTerminalSnapshot(activeParser: AnsiParser): TerminalSnapshot {
    return {
      ...activeParser.createSnapshot(),
      utf8PendingBytes: sshOutputDecoder.getPendingBytes(),
      outputOffset: lastProcessedSeq,
    };
  }
  function createRuntimeTerminalSnapshot(activeParser: AnsiParser): TerminalSnapshot {
    return {
      ...activeParser.createRuntimeSnapshot(),
      utf8PendingBytes: sshOutputDecoder.getPendingBytes(),
      outputOffset: lastProcessedSeq,
    };
  }

  function restoreTerminalSnapshot(activeParser: AnsiParser, snapshot: TerminalSnapshot) {
    activeParser.restoreSnapshot(snapshot);
    sshOutputDecoder.restorePendingBytes(snapshot.utf8PendingBytes);
  }

  function snapshotOutputOffset(snapshot: TerminalSnapshot): number {
    return Number.isSafeInteger(snapshot.outputOffset) && snapshot.outputOffset >= 0
      ? snapshot.outputOffset
      : 0;
  }

  function saveSessionSnapshot(targetSessionId: string) {
    if (!parser || !canUseStorage()) return;
    const snapshots = loadSessionSnapshots();
    snapshots[targetSessionId] = {
      snapshot: createTerminalSnapshot(parser),
      savedAt: Date.now(),
    };
    const prunedSnapshots = pruneSessionSnapshots(snapshots);
    localStorage.setItem(TERMINAL_SNAPSHOT_STORAGE_KEY, JSON.stringify(prunedSnapshots));
  }

  function restoreSessionSnapshot(targetSessionId: string): TerminalSnapshot | null {
    if (!parser) return null;
    const storedSnapshot = loadSessionSnapshots()[targetSessionId];
    if (!storedSnapshot) return null;

    restoreTerminalSnapshot(parser, storedSnapshot.snapshot);
    lastProcessedSeq = snapshotOutputOffset(storedSnapshot.snapshot);
    updateBuffer();
    return storedSnapshot.snapshot;
  }

  function clearSessionSnapshot(targetSessionId: string | null | undefined) {
    if (!targetSessionId) return;
    clearRuntimeSessionSnapshot(targetSessionId);
    if (!canUseStorage()) return;
    const snapshots = loadSessionSnapshots();
    if (!(targetSessionId in snapshots)) return;
    delete snapshots[targetSessionId];
    localStorage.setItem(
      TERMINAL_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(pruneSessionSnapshots(snapshots))
    );
  }

  function pointerToCell(e: { clientX: number; clientY: number }): { row: number; col: number } {
    if (!scrollContainer) return { row: 0, col: 0 };
    const scrollRect = scrollContainer.getBoundingClientRect();
    const canvasLeft = canvasEl?.getBoundingClientRect().left ?? scrollRect.left;
    const x = e.clientX - canvasLeft - TERMINAL_HORIZONTAL_PADDING_PX;
    const y = e.clientY - scrollRect.top + scrollContainer.scrollTop;
    const col = Math.max(0, Math.min(cols - 1, Math.floor(x / charWidth)));
    const row = Math.max(0, Math.floor(y / charHeight));
    return { row, col };
  }

  function pointerToViewportCell(point: { clientX: number; clientY: number }): {
    row: number;
    col: number;
  } {
    if (!scrollContainer) return { row: 0, col: 0 };
    const scrollRect = scrollContainer.getBoundingClientRect();
    const canvasLeft = canvasEl?.getBoundingClientRect().left ?? scrollRect.left;
    return terminalMouseCellFromPoint({
      clientX: point.clientX,
      clientY: point.clientY,
      viewportLeft: canvasLeft,
      viewportTop: scrollRect.top,
      horizontalPadding: TERMINAL_HORIZONTAL_PADDING_PX,
      charWidth,
      charHeight,
      cols: parser?.getCols() ?? cols,
      rows: parser?.getRows() ?? rows,
    });
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

  function sendMouseButton(
    button: number,
    point: { row: number; col: number },
    pressed: boolean,
    modifiers?: TerminalMouseModifiers,
  ) {
    if (!sessionId || !parser || (!pressed && !parser.shouldReportMouseRelease())) return;
    sendSessionData(
      encodeTerminalMouseEvent({
        action: pressed ? "press" : "release",
        button,
        col: point.col,
        row: point.row,
        sgr: parser.isSgrMouseEncoding(),
        shiftKey: modifiers?.shiftKey,
        altKey: modifiers?.altKey,
        ctrlKey: modifiers?.ctrlKey,
        metaKey: modifiers?.metaKey,
      }),
      true,
    );
  }

  function sendMouseMotion(
    button: number,
    point: { row: number; col: number },
    modifiers: TerminalMouseModifiers,
  ) {
    if (!sessionId || !parser) return;
    sendSessionData(
      encodeTerminalMouseEvent({
        action: "move",
        button,
        col: point.col,
        row: point.row,
        sgr: parser.isSgrMouseEncoding(),
        shiftKey: modifiers.shiftKey,
        altKey: modifiers.altKey,
        ctrlKey: modifiers.ctrlKey,
        metaKey: modifiers.metaKey,
      }),
      true,
    );
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

  function writeSystemClipboardText(text: string) {
    return writeTerminalClipboardText(
      text,
      isDesktopTarget,
      writeClipboardText,
      navigator.clipboard,
    );
  }

  async function copySelectedText() {
    const text = extractSelectedText();
    if (!text.trim()) return;
    try {
      await writeSystemClipboardText(text);
      showSelectionMessage("Copied");
      selectionStart = null;
      selectionEnd = null;
      exitSelectionMode();
    } catch (error) {
      console.error("[Terminal] copy failed:", error);
      showSelectionMessage("Copy failed");
    }
  }

  export function hasSelection(): boolean {
    return Boolean(extractSelectedText().trim());
  }

  /// Keyboard entry point (Ctrl/Cmd+Shift+C): copy without closing the
  /// selection, so repeated copies are possible.
  export function copySelection() {
    const text = extractSelectedText();
    if (!text.trim()) return;
    void writeSystemClipboardText(text).catch((error) => {
      console.error("[Terminal] copy failed:", error);
    });
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
    const targetSessionId = sessionId;
    if (!targetSessionId || kind === "local") return;
    const generation = connectionGeneration;

    const prevStatusMessage = statusMessage;
    statusMessage = "Uploading pasted image...";

    try {
      const uploadResult = await sshUploadClipboardImage(targetSessionId, bytes);
      if (!isConnectionAttemptActive(generation, targetSessionId)) return;
      statusMessage = prevStatusMessage;
      sendPastedText(uploadResult.remote_path);
    } catch (error) {
      if (!isConnectionAttemptActive(generation, targetSessionId)) return;
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = "Image upload failed: " + message;
      console.error("[SSH] image upload failed:", error);
    }
  }

  async function pasteClipboardImageFromLocalPath(
    localPath: string,
    targetSessionId: string | null = sessionId
  ) {
    if (!targetSessionId) return;
    if (kind === "local") {
      sendPastedText(await resolveTerminalClipboardImagePath(localPath, true));
      return;
    }
    const generation = connectionGeneration;

    const prevStatusMessage = statusMessage;
    statusMessage = "Uploading pasted image...";

    try {
      const pastedPath = await resolveTerminalClipboardImagePath(
        localPath,
        false,
        async (sourcePath) =>
          (await sshUploadClipboardImageFromLocalPath(targetSessionId, sourcePath)).remote_path,
      );
      if (!isConnectionAttemptActive(generation, targetSessionId)) return;
      statusMessage = prevStatusMessage;
      sendPastedText(pastedPath);
    } catch (error) {
      if (!isConnectionAttemptActive(generation, targetSessionId)) return;
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = "Image upload failed: " + message;
      console.error("[SSH] local image upload failed:", error);
    }
  }

  async function pasteNativeClipboardImage(targetSessionId: string): Promise<boolean> {
    try {
      const result = await readClipboardImage();
      if (!result.found || !result.localPath) return false;
      await pasteClipboardImageFromLocalPath(result.localPath, targetSessionId);
      return true;
    } catch (error) {
      console.error("[Terminal] clipboard image read failed:", error);
      return false;
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
    const targetSessionId = sessionId;
    const clipboardData = e.clipboardData;

    // 웹 클립보드 API에서 이미지 확인 (데스크톱)
    if (clipboardData) {
      const imageItem = Array.from(clipboardData.items).find((item) =>
        item.type.startsWith("image/")
      );
      if (imageItem) {
        const imageFile = imageItem.getAsFile();
        if (imageFile) {
          e.preventDefault();
          if (kind === "local") {
            await pasteNativeClipboardImage(targetSessionId);
            return;
          }
          if (imageFile.size > MAX_CLIPBOARD_IMAGE_BYTES) {
            statusMessage = "Image upload failed: Clipboard image exceeds 10 MiB";
            return;
          }
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

    // Native clipboard fallback for desktop/mobile WebViews that omit image items.
    if (await pasteNativeClipboardImage(targetSessionId)) {
      e.preventDefault();
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
    const images = parser.getImages(startRow, endRow);
    renderer.drawImages(images, startRow, endRow, 'background');
    renderer.drawVisibleRowBackgrounds(buf, startRow, endRow);
    renderer.drawImages(images, startRow, endRow, 'below');
    renderer.drawVisibleRowText(buf, startRow, endRow);
    renderer.drawImages(images, startRow, endRow, 'above');

    drawSelectionIfActive(startRow);

    // 커서
    if (connected && cursorVisible && parserCursorVisible && !(isDesktopTarget && isComposing)) {
      const cursorScreenY = cursorPos.y - startRow;
      if (cursorScreenY >= 0 && cursorScreenY < rows + 2) {
        renderer.drawCursor(cursorPos.x, cursorScreenY, isDesktopTarget, buf[cursorPos.y]?.[cursorPos.x]);
      }
    }

    renderer.endDraw();
  }

  function requestRedraw() {
    if (destroyed || redrawPending) return;
    // updatePending 체크 제거: resize로 캔버스가 클리어된 후 반드시 다시 그려야 함
    redrawPending = true;
    requestAnimationFrame(() => {
      redrawPending = false;
      if (!destroyed) redrawCanvas();
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
        fontFamily: terminalFontStack(settingsStore.terminalFontFamily),
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
      const fonts = (document as Document & { fonts: FontFaceSet }).fonts;
      void fonts.load(
        `${settingsStore.fontSize}px "Sarasa Term K Nerd"`,
        "\u{F109}\u{F0AA5}\u{F055D}\u{F0068}",
      ).then(() => {
        if (destroyed) return;
        measureFont();
        calculateSize();
        requestRedraw();
      });
    }

    const applyNativeKeyboardLayout = (layout: KeyboardLayoutMap) => {
      if (destroyed) return;
      observedUnshiftedKeys.clear();
      browserKeyboardLayoutMap = null;
      nativeKeyboardLayoutMap = layout;
    };
    const nativeLayoutUnlisten = await listenKeyboardLayoutChanged(
      applyNativeKeyboardLayout,
    ).catch(() => null);
    if (destroyed) {
      nativeLayoutUnlisten?.();
      return;
    }
    keyboardLayoutUnlisten = nativeLayoutUnlisten;

    const loadNativeKeyboardLayout = async (): Promise<boolean> => {
      const layout = await getKeyboardLayoutMap();
      if (destroyed) return false;
      applyNativeKeyboardLayout(layout);
      return Object.keys(layout).length > 0;
    };
    keyboardLayoutApi = (
      navigator as Navigator & { keyboard?: BrowserKeyboardApi }
    ).keyboard ?? null;
    const loadBrowserKeyboardLayout = async (): Promise<boolean> => {
      if (!keyboardLayoutApi?.getLayoutMap) return false;
      try {
        const layout = await keyboardLayoutApi.getLayoutMap();
        if (destroyed) return false;
        observedUnshiftedKeys.clear();
        browserKeyboardLayoutMap = layout;
        nativeKeyboardLayoutMap = {};
        return true;
      } catch {
        return false;
      }
    };
    keyboardLayoutChangeHandler = () => {
      observedUnshiftedKeys.clear();
      browserKeyboardLayoutMap = null;
      nativeKeyboardLayoutMap = {};
      void loadNativeKeyboardLayout().catch(() => false).then((loaded) => {
        if (!loaded) void loadBrowserKeyboardLayout();
      });
    };
    keyboardLayoutApi?.addEventListener?.("layoutchange", keyboardLayoutChangeHandler);
    const loadedNativeKeyboardLayout = await loadNativeKeyboardLayout().catch(() => false);
    if (!loadedNativeKeyboardLayout) {
      await loadBrowserKeyboardLayout();
    }
    if (destroyed) return;

    // Cursor blink
    cursorInterval = window.setInterval(() => {
      if (destroyed) return;
      cursorVisible = !cursorVisible;
      requestRedraw();
    }, 530);

    // Setup input handlers BEFORE initTerminal
    await tick();
    if (destroyed) return;
    if (hiddenInput) {
      hiddenInput.addEventListener('input', handleInput);
      hiddenInput.addEventListener('keydown', handleKeyDown);
      hiddenInput.addEventListener('keyup', handleKeyUp);
      hiddenInput.addEventListener('compositionstart', handleCompositionStart);
      hiddenInput.addEventListener('compositionupdate', handleCompositionUpdate);
      hiddenInput.addEventListener('compositionend', handleCompositionEnd);
      pasteHandler = (e: ClipboardEvent) => {
        void handlePaste(e);
      };
      hiddenInput.addEventListener('paste', pasteHandler);

      blurHandler = (event: FocusEvent) => {
        if (suppressBlurRefocus) {
          suppressBlurRefocus = false;
          return;
        }

        // A focus that has moved into another editable surface (modal
        // dialogs, document editors) is intentional; recapturing would steal
        // typing away from it. relatedTarget is the element receiving focus
        // and is reliable mid-transition, unlike document.activeElement,
        // which can still report body while focus steps are in flight —
        // fall back to it only when relatedTarget is absent (focus leaving
        // the document, e.g. a window switch).
        const destination =
          event.relatedTarget instanceof HTMLElement
            ? event.relatedTarget
            : document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        if (
          destination !== null &&
          (destination.tagName === 'INPUT' ||
            destination.tagName === 'TEXTAREA' ||
            destination.isContentEditable)
        ) {
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

      const targetSessionId = sessionId;
      if (!targetSessionId || tabsStore.activeTab?.sessionId !== targetSessionId) return;

      const localPath = customEvent.detail?.localPath;
      if (!localPath) return;

      void pasteClipboardImageFromLocalPath(localPath, targetSessionId);
    };
    window.addEventListener("redterm:android-image-paste", androidImagePasteHandler);

    // Periodic focus check (every 200ms - isComposing 체크 제거로 빠른 복구)
    // Now connect
    await initTerminal();
    if (destroyed) return;

    visibilityChangeHandler = () => {
      updateImageAnimationVisibility();
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

          const nextCursor = { ...parser.getFullCursor() };
          followCommittedHangulEcho(nextCursor);
          cursorPos = nextCursor;
          parserCursorVisible = parser.isCursorVisible();
          buffer = buf;

          const startRow = Math.max(
            0,
            Math.min(Math.floor(viewportTop / charHeight), buf.length - 1)
          );
          const fracOffsetY = viewportTop % charHeight;
          const endRow = Math.min(startRow + rows + 2, buf.length);

          renderer.clear();
          renderer.beginDraw(fracOffsetY);
          const images = parser.getImages(startRow, endRow);
          renderer.drawImages(images, startRow, endRow, 'background');
          renderer.drawVisibleRowBackgrounds(buf, startRow, endRow);
          renderer.drawImages(images, startRow, endRow, 'below');
          renderer.drawVisibleRowText(buf, startRow, endRow);
          renderer.drawImages(images, startRow, endRow, 'above');
          if (connected && cursorVisible && parserCursorVisible && !(isDesktopTarget && isComposing)) {
            const cursorScreenY = cursorPos.y - startRow;
            if (cursorScreenY >= 0 && cursorScreenY < rows + 2) {
              renderer.drawCursor(cursorPos.x, cursorScreenY, isDesktopTarget, buf[cursorPos.y]?.[cursorPos.x]);
            }
          }
          renderer.endDraw();
        };

        // 3중 보장: 즉시 + 다음 repaint + DOM 안정화 후
        forceScrollToBottomAndRedraw();
        requestAnimationFrame(forceScrollToBottomAndRedraw);
        setTimeout(forceScrollToBottomAndRedraw, 150);
        scheduleImageAnimation();

        void resumeAfterBackground();
      } else if (document.visibilityState === "hidden") {
        clearImageAnimationTimer();
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
    parser?.setCellSize(charWidth, charHeight);
  }

  let resizeTimer: number | null = null;

  function commitResize(newCols: number, newRows: number) {
    cols = newCols;
    rows = newRows;

    if (parser) {
      const canReflowCompositionAnchor =
        isComposing &&
        !compositionAnchorLost &&
        parser.isAlternateScreen() === compositionAnchorAlternateScreen;
      const resizedAnchor = parser.resize(
        cols,
        rows,
        canReflowCompositionAnchor ? compositionAnchor : undefined,
      );
      if (isComposing && (!canReflowCompositionAnchor || resizedAnchor === null)) {
        compositionAnchorLost = true;
      } else if (resizedAnchor) {
        compositionAnchor = resizedAnchor;
      }
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
  let isComposing = $state(false);
  let compositionText = $state("");
  let compositionAnchor = $state({ x: 0, y: 0 });
  let compositionAnchorAlternateScreen = false;
  let compositionAnchorLost = $state(false);
  let immediateCompositionText = "";
  let compositionUpdateStarted = false;
  let compositionTimeout: number | null = null;
  let pendingHangulEchoCells = 0;
  const hangulComposer = new HangulComposer();
  let pendingCommitKey: { data: string; suppressPlainSpace: boolean } | null = null;
  let suppressPlainSpace = false;
  let pendingWrite = "";
  let writeFlushScheduled = false;
  type BrowserKeyboardLayoutMap = { get(code: string): string | undefined };
  type BrowserKeyboardApi = {
    getLayoutMap?: () => Promise<BrowserKeyboardLayoutMap>;
    addEventListener?: (type: "layoutchange", listener: () => void) => void;
    removeEventListener?: (type: "layoutchange", listener: () => void) => void;
  };
  const observedUnshiftedKeys = new Map<string, string>();
  let browserKeyboardLayoutMap: BrowserKeyboardLayoutMap | null = null;
  let nativeKeyboardLayoutMap: KeyboardLayoutMap = {};
  let keyboardLayoutApi: BrowserKeyboardApi | null = null;
  let keyboardLayoutChangeHandler: (() => void) | null = null;
  let keyboardLayoutUnlisten: (() => void) | null = null;
  const automaticResponseBuffer = new AutomaticResponseBuffer();
  let automaticResponseFlushScheduled = false;
  let automaticResponseGeneration = 0;
  let deferredUpdateTimer: number | null = null;
  let synchronizedOutputTimer: number | null = null;
  let imageAnimationTimer: number | null = null;
  let lastNonBottomRenderAt = 0;
  let prevScrollbackLength = 0;
  const NON_BOTTOM_RENDER_INTERVAL_MS = 90;
  const SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 150;
  const MIN_IMAGE_ANIMATION_DELAY_MS = 16;
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

  function clearSynchronizedOutputTimer() {
    if (synchronizedOutputTimer === null) return;
    clearTimeout(synchronizedOutputTimer);
    synchronizedOutputTimer = null;
  }

  function scheduleSynchronizedOutputRender() {
    if (synchronizedOutputTimer !== null) return;
    synchronizedOutputTimer = window.setTimeout(() => {
      synchronizedOutputTimer = null;
      updateBuffer(true);
    }, SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
  }
  function clearImageAnimationTimer() {
    if (imageAnimationTimer === null) return;
    clearTimeout(imageAnimationTimer);
    imageAnimationTimer = null;
  }

  function getVisibleKittyImageIds(): Set<number> {
    if (!parser) return new Set();
    const startRow = Math.max(0, Math.floor(viewportTop / Math.max(1, charHeight)));
    const endRow = Math.min(parser.getFullBuffer().length, startRow + parser.getRows() + 2);
    const imageIds = new Set<number>();
    for (const image of parser.getImages(startRow, endRow)) {
      if (
        image.protocol === "kitty" &&
        image.imageId !== undefined &&
        image.col < cols &&
        image.col + image.widthCells > 0
      ) {
        imageIds.add(image.imageId);
      }
    }
    return imageIds;
  }

  function isTerminalSurfaceVisible(): boolean {
    return (
      document.visibilityState === "visible" &&
      terminalSurfaceIntersecting &&
      terminalContainer.getClientRects().length > 0 &&
      terminalContainer.clientWidth > 0 &&
      terminalContainer.clientHeight > 0
    );
  }

  function updateImageAnimationVisibility() {
    terminalSurfaceVisible = isTerminalSurfaceVisible();
    renderer?.setAnimationsEnabled(terminalSurfaceVisible);
    if (terminalSurfaceVisible) scheduleImageAnimation();
    else clearImageAnimationTimer();
  }

  function scheduleImageAnimation() {
    clearImageAnimationTimer();
    if (!parser || !terminalSurfaceVisible) return;
    const delay = parser.getKittyAnimationDelay(getVisibleKittyImageIds());
    if (delay === null) return;
    imageAnimationTimer = window.setTimeout(() => {
      imageAnimationTimer = null;
      if (!parser || !terminalSurfaceVisible) return;
      if (parser.advanceKittyAnimations(getVisibleKittyImageIds())) updateBuffer();
      scheduleImageAnimation();
    }, Math.max(MIN_IMAGE_ANIMATION_DELAY_MS, delay));
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
          terminalModesStore.setKittyKeyboardFlags(
            sessionId,
            parser.getKittyKeyboardFlags(),
          );
        }
      }

      const retainedImageCacheIds = parser.consumeImageCachePruneRequest();
      if (retainedImageCacheIds) renderer.pruneImageCache(retainedImageCacheIds);

      const synchronizedOutput = parser.isSynchronizedOutput();
      if (!synchronizedOutput || force) {
        clearSynchronizedOutputTimer();
      }
      if (!force && synchronizedOutput) {
        scheduleSynchronizedOutputRender();
        if (pendingDataHead < pendingDataChunks.length) {
          updateBuffer();
        }
        return;
      }

      const newScrollbackLength = parser.getScrollbackLength();
      prevScrollbackLength = newScrollbackLength;

      const newBuffer = parser.getFullBuffer();
      buffer = newBuffer;
      const nextCursor = { ...parser.getFullCursor() };
      followCommittedHangulEcho(nextCursor);
      cursorPos = nextCursor;
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
      const images = parser.getImages(startRow, endRow);
      renderer.drawImages(images, startRow, endRow, 'background');
      renderer.drawVisibleRowBackgrounds(newBuffer, startRow, endRow);
      renderer.drawImages(images, startRow, endRow, 'below');
      renderer.drawVisibleRowText(newBuffer, startRow, endRow);
      renderer.drawImages(images, startRow, endRow, 'above');

      prevCursorY = cursorPos.y;

      drawSelectionIfActive(startRow);

      // 커서 그리기
      const cursorScreenY = cursorPos.y - startRow;
      if (connected && cursorVisible && parserCursorVisible && !(isDesktopTarget && isComposing)) {
        if (cursorScreenY >= 0 && cursorScreenY < rows + 2) {
          renderer.drawCursor(cursorPos.x, cursorScreenY, isDesktopTarget, newBuffer[cursorPos.y]?.[cursorPos.x]);
        }
      }

      renderer.endDraw();
      parser.clearDirtyRows();
      scheduleImageAnimation();
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
    scheduleImageAnimation();
    requestRedraw();
  }

  // ─── 터치 스크롤 → 마우스 휠 변환 (tmux 등 alternate screen) ───
  let touchScrollLastY: number | null = null;
  let touchScrollAccum = 0;
  const TOUCH_SCROLL_LINE_THRESHOLD = 0.6; // charHeight의 60%만큼 이동하면 1줄 스크롤

  function shouldInterceptScroll(): boolean {
    return (
      !!parser &&
      parser.isAlternateScreen() &&
      parser.isMouseEnabled() &&
      !selectionMode
    );
  }

  function sendMouseWheel(
    up: boolean,
    lines: number,
    point: { row: number; col: number },
    modifiers?: TerminalMouseModifiers,
  ) {
    if (!sessionId || !parser || lines <= 0) return;
    sendSessionData(
      encodeTerminalMouseEvent({
        action: "press",
        button: up ? 64 : 65,
        col: point.col,
        row: point.row,
        sgr: parser.isSgrMouseEncoding(),
        shiftKey: modifiers?.shiftKey,
        altKey: modifiers?.altKey,
        ctrlKey: modifiers?.ctrlKey,
        metaKey: modifiers?.metaKey,
        repeat: lines,
      }),
      true,
    );
  }

  function handleTerminalWheel(e: WheelEvent) {
    if (e.shiftKey || !shouldForwardTerminalMouseEvents() || e.deltaY === 0) return;
    e.preventDefault();

    const deltaRows =
      e.deltaMode === 1
        ? e.deltaY
        : e.deltaMode === 2
          ? e.deltaY * rows
          : e.deltaY / Math.max(1, charHeight);
    if (desktopWheelRows !== 0 && Math.sign(desktopWheelRows) !== Math.sign(deltaRows)) {
      desktopWheelRows = 0;
    }
    desktopWheelRows = Math.max(-rows, Math.min(rows, desktopWheelRows + deltaRows));

    const signedLines = Math.trunc(desktopWheelRows);
    if (signedLines === 0) return;
    sendMouseWheel(signedLines < 0, Math.abs(signedLines), pointerToViewportCell(e), e);
    desktopWheelRows -= signedLines;
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
      sendMouseWheel(up, lines, pointerToViewportCell(e.touches[0]));
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
    const currentKeyId = auth.method.type === "key" ? auth.method.key_id : null;
    if (currentKeyId !== keyPassphraseRetryKeyId) {
      keyPassphraseRetryKeyId = currentKeyId;
      keyPassphraseRetryCache = createKeyPassphraseRetryCache();
    }

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

  async function connectWithKeyPassphraseRetry(generation: number): Promise<string> {
    if (!isConnectionAttemptActive(generation)) throw new Error("Connection attempt superseded");
    try {
      const connectedSessionId = await connectWithResolvedAuth();
      if (!isConnectionAttemptActive(generation)) {
        await sshDisconnect(connectedSessionId).catch(() => {});
        throw new Error("Connection attempt superseded");
      }
      return connectedSessionId;
    } catch (error) {
      if (!isConnectionAttemptActive(generation)) throw error;
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
      if (!isConnectionAttemptActive(generation)) {
        throw new Error("Connection attempt superseded");
      }
      if (passphrase === null) {
        throw new Error("Key passphrase entry cancelled");
      }

      keyPassphraseRetryCache = stageKeyPassphraseRetry(keyPassphraseRetryCache, passphrase);
      try {
        const connectedSessionId = await connectWithResolvedAuth();
        if (!isConnectionAttemptActive(generation)) {
          await sshDisconnect(connectedSessionId).catch(() => {});
          throw new Error("Connection attempt superseded");
        }
        keyPassphraseRetryCache = commitKeyPassphraseRetry(keyPassphraseRetryCache);
        return connectedSessionId;
      } catch (retryError) {
        if (isConnectionAttemptActive(generation)) {
          keyPassphraseRetryCache = rollbackKeyPassphraseRetry(keyPassphraseRetryCache);
        }
        throw retryError;
      }
    }
  }


  async function bindSessionListener(
    nextSessionId: string,
    generation: number
  ): Promise<boolean> {
    if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
    sshDataPaused = false;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }

    const dataUnlisten = await listenSshData(nextSessionId, (data, seq) => {
      if (!isConnectionAttemptActive(generation, nextSessionId)) return;
      if (replayBufferedChunks) {
        if (replayBufferedBytes + data.byteLength > MAX_REPLAY_BUFFER_BYTES) {
          pauseSshDataSource();
          return;
        }
        replayBufferedChunks.push({ seq, data: data.slice() });
        replayBufferedBytes += data.byteLength;
        return;
      }
      if (seq <= lastProcessedSeq) return;
      const text = sshOutputDecoder.decode(data);
      const startupPayload = startupScriptDispatcher?.consumeOutput(text);
      if (startupPayload && isConnectionAttemptActive(generation, nextSessionId)) {
        queueWrite(startupPayload);
      }
      if (parser) {
        enqueuePendingOutput(seq, text);
        if (pendingDataCharacters >= MAX_PENDING_OUTPUT_CHARACTERS) {
          processPendingOutputSlice(true);
        }
        updateBuffer();
      }
    });
    if (!isConnectionAttemptActive(generation, nextSessionId)) {
      dataUnlisten();
      return false;
    }
    unlisten = dataUnlisten;

    const exitUnlisten = await listenSshExit(nextSessionId, () => {
      if (
        !isConnectionAttemptActive(generation, nextSessionId) ||
        disconnectRequested
      ) return;
      connected = false;
      if (document.visibilityState === "hidden") {
        statusMessage = "Connection lost (backgrounded)";
        void reconnectSession("background disconnect");
        return;
      }
      sessionId = null;
      connectionGeneration++;
      lastProcessedSeq = 0;
      terminalModesStore.clearSession(nextSessionId);
      clearSessionSnapshot(nextSessionId);
      statusMessage = "Session ended";
      onDisconnected?.();
      startupScriptDispatcher = null;
    });
    if (!isConnectionAttemptActive(generation, nextSessionId)) {
      exitUnlisten();
      if (unlisten === dataUnlisten) {
        dataUnlisten();
        unlisten = null;
      }
      return false;
    }
    unlistenExit = exitUnlisten;
    return true;
  }

  async function attachExistingSession(
    nextSessionId: string,
    generation = ++connectionGeneration
  ): Promise<boolean> {
    sshOutputDecoder.reset();
    try {
      replayBufferedChunks = [];
      replayBufferedBytes = 0;
      sessionId = nextSessionId;
      connected = true;
      statusMessage = "";
      if (!(await bindSessionListener(nextSessionId, generation))) return false;

      const backendSnapshot = await sshGetSessionSnapshot(nextSessionId);
      if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
      const historyChunks = await sshGetSessionOutput(nextSessionId);
      if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
      const runtimeSnapshot = takeRuntimeSessionSnapshot(nextSessionId);
      if (runtimeSnapshot && parser) {
        restoreTerminalSnapshot(parser, runtimeSnapshot);
        lastProcessedSeq = snapshotOutputOffset(runtimeSnapshot);
        updateBuffer();
      } else if (backendSnapshot && parser) {
        restoreTerminalSnapshot(parser, backendSnapshot.snapshot);
        lastProcessedSeq = backendSnapshot.last_seq;
        updateBuffer();
      } else {
        restoreSessionSnapshot(nextSessionId);
      }
      if (
        !(await replayAndDrainSessionChunks(historyChunks, generation, nextSessionId)) ||
        !isConnectionAttemptActive(generation, nextSessionId)
      ) return false;

      terminalModesStore.setAppCursorMode(
        nextSessionId,
        parser?.isApplicationCursorKeys() ?? terminalModesStore.isAppCursorMode(nextSessionId)
      );
      terminalModesStore.setKittyKeyboardFlags(
        nextSessionId,
        parser?.getKittyKeyboardFlags() ?? terminalModesStore.getKittyKeyboardFlags(nextSessionId),
      );
      await sshResize(nextSessionId, cols, rows);
      if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
      clearSessionSnapshot(nextSessionId);
      onConnected?.(nextSessionId);
      return true;
    } catch {
      if (!isConnectionAttemptActive(generation, nextSessionId)) {
        if (sessionId !== nextSessionId) await sshDisconnect(nextSessionId).catch(() => {});
        return false;
      }
      const cleanupError = await cleanupFailedSessionAttach({
        sessionId: nextSessionId,
        unlistenData: unlisten,
        unlistenExit,
        clearMode: (id) => terminalModesStore.clearSession(id),
        clearSnapshot: (id) => clearSessionSnapshot(id),
        disconnect: (id) => sshDisconnect(id),
      });
      if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
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
    const targetSessionId = sessionId;
    if (!targetSessionId) return;
    const generation = connectionGeneration;
    const onWriteError = silent
      ? () => {}
      : (error: unknown) => {
          if (isConnectionAttemptActive(generation, targetSessionId)) handleWriteError(error);
        };
    if (kind === "local") {
      localShellWrite(targetSessionId, bytes).catch(onWriteError);
    } else {
      sshWrite(targetSessionId, bytes).catch(onWriteError);
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

  function isConnectionAttemptActive(generation: number, expectedSessionId?: string): boolean {
    return (
      !destroyed &&
      connectionGeneration === generation &&
      (expectedSessionId === undefined || sessionId === expectedSessionId)
    );
  }

  async function bindLocalSessionListener(
    nextSessionId: string,
    generation: number
  ): Promise<boolean> {
    if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
    sshDataPaused = false;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (unlistenExit) {
      unlistenExit();
      unlistenExit = null;
    }

    const dataUnlisten = await listenLocalData(nextSessionId, (chunk) => {
      if (!isConnectionAttemptActive(generation, nextSessionId)) return;
      if (replayBufferedChunks) {
        if (replayBufferOverflowed) return;
        if (replayBufferedBytes + chunk.data.byteLength > MAX_REPLAY_BUFFER_BYTES) {
          replayBufferOverflowed = true;
          replayBufferedChunks = [];
          replayBufferedBytes = 0;
          return;
        }
        replayBufferedChunks.push({ seq: chunk.seq, data: chunk.data.slice() });
        replayBufferedBytes += chunk.data.byteLength;
        return;
      }
      if (chunk.seq <= lastProcessedSeq) return;
      const text = sshOutputDecoder.decode(chunk.data);
      if (parser) {
        enqueuePendingOutput(chunk.seq, text);
        if (
          document.visibilityState === "hidden" ||
          pendingDataCharacters >= MAX_PENDING_OUTPUT_CHARACTERS
        ) processPendingOutputSlice(true);
        if (document.visibilityState !== "hidden") updateBuffer();
      }
    });
    if (!isConnectionAttemptActive(generation, nextSessionId)) {
      dataUnlisten();
      return false;
    }
    unlisten = dataUnlisten;

    const exitUnlisten = await listenLocalExit(nextSessionId, () => {
      if (
        !isConnectionAttemptActive(generation, nextSessionId) ||
        disconnectRequested
      ) return;
      connected = false;
      sessionId = null;
      connectionGeneration++;
      lastProcessedSeq = 0;
      terminalModesStore.clearSession(nextSessionId);
      clearSessionSnapshot(nextSessionId);
      statusMessage = "Local shell exited";
      onDisconnected?.();
    });
    if (!isConnectionAttemptActive(generation, nextSessionId)) {
      exitUnlisten();
      if (unlisten === dataUnlisten) {
        dataUnlisten();
        unlisten = null;
      }
      return false;
    }
    unlistenExit = exitUnlisten;
    return true;
  }

  async function replayAndDrainLocalSession(
    nextSessionId: string,
    generation: number,
    historyChunks: Array<{ seq: number; data: Uint8Array }>
  ): Promise<boolean> {
    let chunks = historyChunks;
    while (isConnectionAttemptActive(generation, nextSessionId)) {
      if (!(await writeChunksTimeSliced(chunks, generation, nextSessionId))) return false;
      if (replayBufferOverflowed) {
        replayBufferOverflowed = false;
        replayBufferedChunks = [];
        replayBufferedBytes = 0;
        chunks = await localShellGetOutput(nextSessionId, lastProcessedSeq);
        if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
        continue;
      }
      if (replayBufferedChunks && replayBufferedChunks.length > 0) {
        chunks = replayBufferedChunks;
        replayBufferedChunks = [];
        replayBufferedBytes = 0;
        continue;
      }
      replayBufferedChunks = null;
      replayBufferedBytes = 0;
      return true;
    }
    return false;
  }

  async function completeLocalSessionAttach(
    nextSessionId: string,
    generation: number,
    restoreStoredSnapshot: boolean
  ): Promise<boolean> {
    replayBufferedChunks = [];
    replayBufferedBytes = 0;
    replayBufferOverflowed = false;
    sessionId = nextSessionId;
    connected = true;
    statusMessage = "";
    if (!(await bindLocalSessionListener(nextSessionId, generation))) return false;

    if (restoreStoredSnapshot && parser) {
      const runtimeSnapshot = takeRuntimeSessionSnapshot(nextSessionId);
      if (runtimeSnapshot) {
        restoreTerminalSnapshot(parser, runtimeSnapshot);
        lastProcessedSeq = snapshotOutputOffset(runtimeSnapshot);
        updateBuffer();
      } else {
        restoreSessionSnapshot(nextSessionId);
      }
    }
    const historyChunks = await localShellGetOutput(nextSessionId, lastProcessedSeq);
    if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
    if (!(await replayAndDrainLocalSession(nextSessionId, generation, historyChunks))) return false;
    await localShellResize(nextSessionId, cols, rows);
    if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
    terminalModesStore.setAppCursorMode(nextSessionId, false);
    clearSessionSnapshot(nextSessionId);
    onConnected?.(nextSessionId);
    return true;
  }

  async function connectLocalSession(
    showError = true,
    generation = ++connectionGeneration
  ): Promise<boolean> {
    sshOutputDecoder.reset();
    lastProcessedSeq = 0;
    statusMessage = "Starting local shell...";
    let nextSessionId: string | null = null;
    try {
      nextSessionId = await localShellStart(cols, rows);
      if (!isConnectionAttemptActive(generation)) {
        await localShellDisconnect(nextSessionId);
        return false;
      }
      const attached = await completeLocalSessionAttach(nextSessionId, generation, false);
      if (!attached) await localShellDisconnect(nextSessionId).catch(() => {});
      return attached;
    } catch (e) {
      if (nextSessionId) {
        await localShellDisconnect(nextSessionId).catch(() => {});
      }
      if (!isConnectionAttemptActive(generation)) return false;
      connected = false;
      sessionId = null;
      replayBufferedChunks = null;
      replayBufferedBytes = 0;
      replayBufferOverflowed = false;
      const message = e instanceof Error ? e.message : String(e);
      statusMessage = "Failed to start local shell: " + message;
      if (showError) onError?.(message);
      return false;
    }
  }

  async function attachExistingLocalSession(
    nextSessionId: string,
    generation = ++connectionGeneration
  ): Promise<boolean> {
    sshOutputDecoder.reset();
    lastProcessedSeq = 0;
    try {
      return await completeLocalSessionAttach(nextSessionId, generation, true);
    } catch (error) {
      if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
      await localShellDisconnect(nextSessionId).catch(() => {});
      if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
      unlisten?.();
      unlistenExit?.();
      unlisten = null;
      unlistenExit = null;
      replayBufferedChunks = null;
      replayBufferedBytes = 0;
      replayBufferOverflowed = false;
      sessionId = null;
      connected = false;
      lastProcessedSeq = 0;
      resetParser();
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = "Failed to restore local shell: " + message;
      return false;
    }
  }


  async function connectNewSession(
    showError = true,
    generation = ++connectionGeneration
  ): Promise<boolean> {
    if (kind === "local") return connectLocalSession(showError, generation);
    if (keyPassphrasePromptResolver) resolveKeyPassphrasePrompt(null);
    if (hostKeyPromptResolver) resolveHostKeyPrompt("cancel");
    sshOutputDecoder.reset();
    statusMessage = "Connecting to " + host + ":" + port + "...";
    let nextSessionId: string | null = null;

    try {
      const gateResult = await runHostKeyGate({
        target: { host, port },
        preflightHostKey: async (targetHost, targetPort) => {
          const result = await preflightHostKey(targetHost, targetPort);
          if (!isConnectionAttemptActive(generation)) {
            throw new Error("Connection attempt superseded");
          }
          return result;
        },
        promptHostKey: (challenge) =>
          isConnectionAttemptActive(generation)
            ? promptHostKey(challenge)
            : Promise.resolve("cancel"),
        trustHostKey: async (request) => {
          if (!isConnectionAttemptActive(generation)) {
            throw new Error("Connection attempt superseded");
          }
          await trustPresentedHostKey(request);
          if (!isConnectionAttemptActive(generation)) {
            throw new Error("Connection attempt superseded");
          }
        },
        clearTrustedHostKeyPrompt: () => {
          if (isConnectionAttemptActive(generation)) clearHostKeyPrompt();
        },
        connect: () => connectWithKeyPassphraseRetry(generation),
      });

      if (!isConnectionAttemptActive(generation)) {
        if (gateResult.status !== "blocked") await sshDisconnect(gateResult.sessionId).catch(() => {});
        return false;
      }
      if (gateResult.status === "blocked") {
        clearHostKeyPrompt();
        startupScriptDispatcher = null;
        connected = false;
        if (gateResult.reason === "preflight-failed") {
          statusMessage = "Connection failed: " + gateResult.error;
          if (showError) onError?.(gateResult.error);
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
      startupScriptDispatcher = createStartupScriptDispatcher(startupScript, startupScriptReadyText);
      terminalModesStore.setAppCursorMode(nextSessionId, false);
      terminalModesStore.setKittyKeyboardFlags(nextSessionId, 0);
      replayBufferedChunks = [];
      replayBufferedBytes = 0;
      if (!(await bindSessionListener(nextSessionId, generation))) {
        throw new Error("Connection attempt superseded");
      }
      const historyChunks = await sshGetSessionOutput(nextSessionId);
      if (!isConnectionAttemptActive(generation, nextSessionId)) {
        throw new Error("Connection attempt superseded");
      }
      if (!(await replayAndDrainSessionChunks(historyChunks, generation, nextSessionId))) {
        throw new Error("Connection attempt superseded");
      }
      if (!isConnectionAttemptActive(generation, nextSessionId)) {
        throw new Error("Connection attempt superseded");
      }
      const dispatcher = startupScriptDispatcher;
      if (!dispatcher) throw new Error("Startup script dispatcher was not initialized");
      const startupPayload = dispatcher.takeImmediatePayload();
      if (startupPayload) queueWrite(startupPayload);
      if (!isConnectionAttemptActive(generation, nextSessionId)) return false;
      onConnected?.(nextSessionId);
      requestNotificationPermission();
      return true;
    } catch (e) {
      if (!isConnectionAttemptActive(generation)) {
        if (nextSessionId) {
          await sshDisconnect(nextSessionId).catch(() => {});
        }
        return false;
      }
      replayBufferedChunks = null;
      replayBufferedBytes = 0;
      if (nextSessionId) {
        unlisten?.();
        unlistenExit?.();
        unlisten = null;
        unlistenExit = null;
        if (sessionId === nextSessionId) sessionId = null;
        terminalModesStore.clearSession(nextSessionId);
        clearSessionSnapshot(nextSessionId);
        try {
          await sshDisconnect(nextSessionId);
        } catch (cleanupError) {
          if (isConnectionAttemptActive(generation)) {
            console.error("Failed to clean up partially initialized SSH session:", cleanupError);
          }
        }
      }
      if (!isConnectionAttemptActive(generation)) return false;
      clearHostKeyPrompt();
      startupScriptDispatcher = null;
      connected = false;
      const errorMsg = e instanceof Error ? e.message : String(e);
      statusMessage = "Connection failed: " + errorMsg;
      if (showError) onError?.(errorMsg);
      return false;
    }
  }

  function handleOscEvent(event: TerminalOscEvent) {
    if (destroyed) return;
    if (event.type === "title") {
      onTitleChange?.(event.value);
      return;
    }
    if (event.type === "current-directory") {
      currentDirectoryUri = event.uri;
      return;
    }
    if (event.type === "colors") {
      renderer?.updateConfig({
        defaultFg: event.colors.foreground,
        defaultBg: event.colors.background,
        cursorColor: event.colors.cursor,
      });
      requestRedraw();
      return;
    }
    if (event.type === "clipboard") {
      if (!interactive) return;
      const generation = connectionGeneration;
      void osc52SessionGate
        .resolve(
          event.text,
          kind === "local",
          generation,
          requestOsc52Approval
        )
        .then((text) => {
          if (text === null) return;
          if (destroyed || !interactive || generation !== connectionGeneration) return;
          return writeSystemClipboardText(text);
        })
        .catch((error) => {
          console.error("[Terminal] OSC 52 clipboard write failed:", error);
        });
    }
  }

  function resetParser(notifyTitleReset = true) {
    if (destroyed) return;
    clearSynchronizedOutputTimer();
    parserGeneration++;
    clearImageAnimationTimer();
    renderer?.resetImageCache();
    currentDirectoryUri = null;
    if (notifyTitleReset) onTitleChange?.("");
    parser = new AnsiParser(cols, rows);
    parser.setCellSize(charWidth, charHeight);
    parser.setMaxScrollback(settingsStore.scrollbackLines);
    const theme = getThemeById(settingsStore.theme) ?? THEMES[0];
    renderer?.updateConfig({
      defaultFg: theme.colors.terminalFg,
      defaultBg: theme.colors.terminalBg,
      cursorColor: theme.colors.terminalCursor,
    });
    parser.setOscColorDefaults({
      foreground: theme.colors.terminalFg,
      background: theme.colors.terminalBg,
      cursor: theme.colors.terminalCursor,
    });
    parser.setOscEventHandler(handleOscEvent);
    parser.setResponseHandler((data: string) => {
      enqueueAutomaticResponse(data);
    });
    updateBuffer();
  }

  async function reconnectSession(reason: string) {
    if (reconnecting || disconnectRequested || destroyed) return;
    reconnecting = true;
    const generation = ++connectionGeneration;
    resumingSshData = false;
    replayBufferedChunks = null;
    replayBufferedBytes = 0;

    try {
      const oldSessionId = sessionId;
      connected = false;
      statusMessage = "Reconnecting (" + reason + ")...";

      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (unlistenExit) {
        unlistenExit();
        unlistenExit = null;
      }
      clearPendingOutput();
      parserGeneration++;
      clearAutomaticResponses();

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
      if (!isConnectionAttemptActive(generation)) return;

      sessionId = null;
      lastProcessedSeq = 0;
      resetParser();
      hangulComposer.reset();
      pendingCommitKey = null;
      pendingHangulEchoCells = 0;
      suppressPlainSpace = false;

      const reconnected = await connectNewSession(false, generation);
      if (!isConnectionAttemptActive(generation)) return;
      if (reconnected) {
        await tick();
        if (isConnectionAttemptActive(generation)) focusInput();
      } else {
        onDisconnected?.();
      }
    } finally {
      if (connectionGeneration === generation) reconnecting = false;
    }
  }
  async function probeAndReconnect() {
    if (disconnectRequested || reconnecting) return;
    if (kind === "local") return;

    if (!sessionId) {
      if (!connected && host) {
        await reconnectSession("resume after disconnect");
      }
      return;
    }

    const activeId = sessionId;
    const generation = connectionGeneration;
    try {
      await sshResize(activeId, cols, rows);
      if (isConnectionAttemptActive(generation, activeId)) connected = true;
    } catch {
      if (isConnectionAttemptActive(generation, activeId)) {
        await reconnectSession("resume");
      }
    }
  }

  function pauseSshDataForBackground() {
    if (kind === "local") return;
    if (!sessionId || !connected || !parser || !unlisten || sshDataPaused) return;

    pauseSshDataSource();
    processPendingOutputSlice(true);
    void sshStoreSessionSnapshot(sessionId, createTerminalSnapshot(parser), lastProcessedSeq).catch(() => {});
  }

  async function writeChunksTimeSliced(
    chunks: Array<{ seq: number; data: Uint8Array }>,
    generation = connectionGeneration,
    expectedSessionId = sessionId ?? undefined
  ): Promise<boolean> {
    const replayGeneration = parserGeneration;
    const replayParser = parser;
    const replayIsActive = () =>
      isConnectionAttemptActive(generation, expectedSessionId) &&
      parserGeneration === replayGeneration &&
      parser === replayParser;
    if (!replayParser || !replayIsActive()) return false;

    let sliceStart = performance.now();
    for (const chunk of chunks) {
      if (!replayIsActive()) return false;
      if (chunk.seq <= lastProcessedSeq) continue;
      const text = sshOutputDecoder.decode(chunk.data);
      const startupPayload = startupScriptDispatcher?.consumeOutput(text);
      if (startupPayload && replayIsActive()) queueWrite(startupPayload);

      let offset = 0;
      while (offset < text.length) {
        let end = Math.min(offset + 4096, text.length);
        const finalCodeUnit = text.charCodeAt(end - 1);
        if (end < text.length && finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end--;
        replayParser.write(text.slice(offset, end));
        offset = end;
        if (offset < text.length && performance.now() - sliceStart >= REPLAY_SLICE_BUDGET_MS) {
          updateBuffer();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (!replayIsActive()) return false;
          sliceStart = performance.now();
        }
      }
      lastProcessedSeq = Math.max(lastProcessedSeq, chunk.seq);
      if (performance.now() - sliceStart >= REPLAY_SLICE_BUDGET_MS) {
        updateBuffer();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!replayIsActive()) return false;
        sliceStart = performance.now();
      }
    }
    if (!replayIsActive()) return false;
    const replaySessionId = expectedSessionId ?? sessionId;
    if (replaySessionId) {
      terminalModesStore.setAppCursorMode(
        replaySessionId,
        replayParser.isApplicationCursorKeys(),
      );
      terminalModesStore.setKittyKeyboardFlags(
        replaySessionId,
        replayParser.getKittyKeyboardFlags(),
      );
    }
    updateBuffer();
    return true;
  }

  async function replayAndDrainSessionChunks(
    historyChunks: Array<{ seq: number; data: Uint8Array }>,
    generation = connectionGeneration,
    expectedSessionId = sessionId ?? undefined
  ): Promise<boolean> {
    if (!(await writeChunksTimeSliced(historyChunks, generation, expectedSessionId))) return false;

    while (replayBufferedChunks && replayBufferedChunks.length > 0) {
      if (!isConnectionAttemptActive(generation, expectedSessionId)) return false;
      const buffered = replayBufferedChunks;
      replayBufferedChunks = [];
      replayBufferedBytes = 0;
      if (!(await writeChunksTimeSliced(buffered, generation, expectedSessionId))) return false;
    }
    if (!isConnectionAttemptActive(generation, expectedSessionId)) return false;
    replayBufferedChunks = null;
    replayBufferedBytes = 0;
    return true;
  }

  async function resumeAfterBackground() {
    if (kind === "local") return;
    if (resumingSshData) return;
    if (!sshDataPaused || !sessionId || !parser || reconnecting) {
      await probeAndReconnect();
      return;
    }

    const generation = connectionGeneration;
    resumingSshData = true;
    try {
      do {
        const activeId = sessionId;
        if (!activeId || !isConnectionAttemptActive(generation, activeId)) return;
        replayBufferedChunks = [];
        replayBufferedBytes = 0;
        if (!(await bindSessionListener(activeId, generation))) return;
        const chunks = await sshGetSessionOutput(activeId);
        if (!isConnectionAttemptActive(generation, activeId)) return;
        if (!(await replayAndDrainSessionChunks(chunks, generation, activeId))) return;
      } while (
        sshDataPaused &&
        pendingDataCharacters === 0 &&
        sessionId &&
        document.visibilityState !== "hidden"
      );
    } catch {
      // probeAndReconnect below decides between reconnect and teardown.
    } finally {
      if (connectionGeneration === generation) {
        replayBufferedChunks = null;
        replayBufferedBytes = 0;
        resumingSshData = false;
      }
    }
    if (connectionGeneration === generation) await probeAndReconnect();
  }

  async function initTerminal() {
    // 레이아웃이 안정될 때까지 대기 (ExtraKeysBar 등 조건부 컴포넌트 렌더 후)
    await tick();
    await new Promise(r => requestAnimationFrame(r));
    if (destroyed) return;

    calculateSize();
    resetParser(false);

    resizeObserver = new ResizeObserver(() => {
      if (destroyed) return;
      calculateSize();
      updateImageAnimationVisibility();
    });
    resizeObserver.observe(terminalContainer);
    surfaceVisibilityObserver = new IntersectionObserver(([entry]) => {
      terminalSurfaceIntersecting = entry?.isIntersecting ?? false;
      updateImageAnimationVisibility();
      if (terminalSurfaceVisible && parser) {
        parser.markAllDirty();
        updateBuffer(true);
      }
    });
    surfaceVisibilityObserver.observe(terminalContainer);
    updateImageAnimationVisibility();

    let attached = false;
    if (kind === "local" && existingSessionId) {
      attached = await attachExistingLocalSession(existingSessionId);
      if (destroyed || disconnectRequested) return;
    } else if (existingSessionId) {
      attached = await attachExistingSession(existingSessionId);
      if (destroyed || disconnectRequested) return;
    }

    if (!attached) {
      await connectNewSession();
      if (destroyed || disconnectRequested) return;
    }

    await tick();
    if (!destroyed) focusInput();
  }

  function focusInput() {
    if (!interactive || selectionMode) return;
    hiddenInput?.focus();
  }

  function handleWrapperClick() {
    if (!interactive) return;

    if (suppressNextFocus) {
      suppressNextFocus = false;
    }

    if (selectionMode) {
      if (!selectedText.trim()) {
        exitSelectionMode();
      } else {
        // Keep an active selection (and its toolbar) focused off.
        return;
      }
    }

    // The pointerdown handlers preventDefault, so a mouse click never moves
    // focus on its own. Restore it on desktop, otherwise focus lost to a
    // modal, a window switch, or an earlier selection stays lost and typing
    // silently dies until some other surface refocuses the pane.
    if (isDesktopTarget) {
      focusInput();
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
    const fontFamily = terminalFontStack(settingsStore.terminalFontFamily);
    if (!renderer) return;
    renderer.updateConfig({
      fontSize: fs,
      fontFamily,
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
    parser?.setOscColorDefaults({
      foreground: def.colors.terminalFg,
      background: def.colors.terminalBg,
      cursor: def.colors.terminalCursor,
    });
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
      // Rendered URLs take local precedence over remote TUI mouse reporting.
      const localSelectionOverride =
        e.button === 0 && e.shiftKey && shouldForwardTerminalMouseEvents();
      const localUrlClick =
        e.button === 0 && !!findUrlAtCell(buffer, pointerToCell(e));
      if (shouldForwardTerminalMouseEvents() && !localSelectionOverride && !localUrlClick) {
        if (e.button < 0 || e.button > 2) return;
        e.preventDefault();
        suppressNextFocus = true;
        terminalMousePointerId = e.pointerId;
        terminalMouseButton = e.button;
        const point = pointerToViewportCell(e);
        lastTerminalMouseCell = point;
        if (scrollContainer && !scrollContainer.hasPointerCapture(e.pointerId)) {
          scrollContainer.setPointerCapture(e.pointerId);
        }
        sendMouseButton(e.button, point, true, e);
        return;
      }
      if (e.button !== 0) return;

      if (localSelectionOverride) localSelectionPointerId = e.pointerId;
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
    if (e.pointerType === "mouse" && localSelectionPointerId !== e.pointerId) {
      const buttonPressed =
        terminalMousePointerId === e.pointerId && terminalMouseButton !== null;
      const reportsHover = parser?.shouldReportMouseMotion(false) ?? false;
      if (
        (buttonPressed || shouldForwardTerminalMouseEvents()) &&
        parser?.shouldReportMouseMotion(buttonPressed)
      ) {
        const point = pointerToViewportCell(e);
        if (
          !lastTerminalMouseCell ||
          point.row !== lastTerminalMouseCell.row ||
          point.col !== lastTerminalMouseCell.col
        ) {
          e.preventDefault();
          sendMouseMotion(buttonPressed ? terminalMouseButton! : 3, point, e);
          lastTerminalMouseCell = point;
        }
      }
      if (buttonPressed || reportsHover) return;
    }

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
    if (localSelectionPointerId === e.pointerId) localSelectionPointerId = null;
    if (terminalMousePointerId === e.pointerId) {
      e.preventDefault();
      sendMouseButton(
        terminalMouseButton ?? 0,
        pointerToViewportCell(e),
        false,
        e,
      );
      if (scrollContainer?.hasPointerCapture(e.pointerId)) {
        scrollContainer.releasePointerCapture(e.pointerId);
      }
      terminalMousePointerId = null;
      terminalMouseButton = null;
      lastTerminalMouseCell = null;
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
      if (
        e.type === "pointerup" &&
        e.pointerType === "touch" &&
        !touchPointerMoved &&
        !longPressTriggered &&
        touchPointerStart
      ) {
        if (shouldForwardTerminalMouseEvents()) {
          const point = pointerToViewportCell(e);
          sendMouseButton(0, point, true, e);
          sendMouseButton(0, point, false, e);
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
  function getBackspaceInputCode(): string {
    return encodeKittyKeyboardEvent(
      { key: "Backspace", code: "Backspace" },
      parser?.getKittyKeyboardFlags() ?? 0,
    ) ?? "\x7f";
  }
  function redrawDesktopCursorAfterComposition() {
    if (!isDesktopTarget) return;
    requestRedraw();
    if (parser?.isSynchronizedOutput()) scheduleSynchronizedOutputRender();
  }
  function followCommittedHangulEcho(nextCursor: { x: number; y: number }) {
    if (pendingHangulEchoCells === 0) return;
    const advancedCells =
      (nextCursor.y - cursorPos.y) * cols + (nextCursor.x - cursorPos.x);
    if (advancedCells <= 0) return;
    if (
      isComposing &&
      hasUsableCompositionAnchor() &&
      compositionAnchor.x === cursorPos.x &&
      compositionAnchor.y === cursorPos.y
    ) {
      compositionAnchor = { ...nextCursor };
    }
    pendingHangulEchoCells = Math.max(0, pendingHangulEchoCells - advancedCells);
  }

  // Composition handlers for Korean/CJK input
  function handleCompositionStart() {
    compositionAnchor = { ...cursorPos };
    compositionAnchorAlternateScreen = parser?.isAlternateScreen() ?? false;
    compositionAnchorLost = false;
    isComposing = true;
    compositionText = "";
    immediateCompositionText = "";
    compositionUpdateStarted = false;
    if (isDesktopTarget) renderer?.hideCursor();
    // 3초 stuck 타이머는 모바일(안드로이드 WebView)용 — compositionend가
    // 없을 때 플래그를 풀어 입력 막힘을 방지한다. 데스크탑 IME는
    // compositionend를 확실히 주므로 플래그를 임의로 끄지 않는다.
    if (!isDesktopTarget) {
      if (compositionTimeout) clearTimeout(compositionTimeout);
      compositionTimeout = window.setTimeout(() => {
        isComposing = false;
        compositionText = "";
        compositionTimeout = null;
      }, 3000);
    } else {
      // Safety net for WKWebView compositionend quirks. Long enough that
      // no real composition outlives it, and it only re-enables keydown
      // flow — the composer keeps its accumulated word so a late
      // compositionend still corrects cleanly.
      if (compositionTimeout) clearTimeout(compositionTimeout);
      compositionTimeout = window.setTimeout(() => {
        isComposing = false;
        compositionText = "";
        compositionTimeout = null;
        redrawDesktopCursorAfterComposition();
      }, 30000);
    }
  }
  function handleCompositionUpdate(e: CompositionEvent) {
    const text = e.data ?? hiddenInput?.value ?? "";
    compositionText = trackCompositionText(text);
  }

  function trackCompositionText(text: string): string {
    if (!isDesktopTarget) return text;
    const composed = composeJamoSequence(text);
    if (!compositionUpdateStarted && composed) {
      hangulComposer.beginComposition(composed);
      compositionUpdateStarted = true;
    }
    return composed;
  }

  function handleCompositionEnd(e: CompositionEvent) {
    if (compositionTimeout) {
      clearTimeout(compositionTimeout);
      compositionTimeout = null;
    }
    isComposing = false;
    compositionText = "";
    if (sessionId) {
      const data = e.data ?? "";
      if (isDesktopTarget) {
        // Diff against the ASCII the IME already sent as early deltas
        // (pinyin-style IMEs emit insertCompositionText for the marked
        // string). Hangul keeps immediateCompositionText empty, so the
        // full data feeds the composer and jamo commits accumulate
        // across compositionends.
        if (data.startsWith(immediateCompositionText)) {
          const remaining = data.slice(immediateCompositionText.length);
          if (remaining) {
            writeComposed(hangulComposer.feed(remaining), true);
          } else if (!data) {
            // Pure Hangul composition is local-only until compositionend,
            // so cancellation resets state without deleting committed text.
            hangulComposer.breakWord();
          }
        } else if (immediateCompositionText.startsWith(data)) {
          // Composition shrank below the ASCII already sent.
          queueWrite(getBackspaceInputCode().repeat(immediateCompositionText.length - data.length));
          hangulComposer.breakWord();
        } else {
          // Composition replaced (e.g. candidate pick): erase, then send anew.
          queueWrite(getBackspaceInputCode().repeat(immediateCompositionText.length));
          writeComposed(hangulComposer.feed(data), true);
        }
        const pending = pendingCommitKey;
        pendingCommitKey = null;
        if (pending) {
          hangulComposer.breakWord();
          queueWrite(pending.data);
        }
        // WebKit may also deliver the committing space as a plain input
        // event after compositionend; drop that duplicate.
        suppressPlainSpace = pending?.suppressPlainSpace ?? false;
      } else if (data.startsWith(immediateCompositionText)) {
        const remainingText = data.slice(immediateCompositionText.length);
        if (remainingText) sendText(remainingText);
      } else if (immediateCompositionText.startsWith(data)) {
        // Composition shrank or was canceled: erase already-sent chars.
        queueWrite(getBackspaceInputCode().repeat(immediateCompositionText.length - data.length));
      } else {
        // Composition replaced (e.g. suggestion pick): erase, then send anew.
        queueWrite(getBackspaceInputCode().repeat(immediateCompositionText.length));
        sendText(data);
      }
    }
    immediateCompositionText = "";
    if (hiddenInput) {
      hiddenInput.value = "";
    }
    redrawDesktopCursorAfterComposition();
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
        queueWrite(getBackspaceInputCode());
        target.value = "";
      } else if (immediateCompositionText.length > 0) {
        queueWrite(getBackspaceInputCode());
        immediateCompositionText = immediateCompositionText.slice(0, -1);
        target.value = "";
      }
      // Pure-CJK composition is still local-only: leave the composing textarea alone.
      return;
    }

    // Samsung keyboard clipboard panel image paste: comes as insertFromPaste input event
    if (inputEvent.inputType === "insertFromPaste") {
      target.value = "";
      const targetSessionId = sessionId;
      // Try reading image from clipboard via Android plugin
      void (async () => {
        try {
          const result = await readClipboardImage();
          if (result.found && result.localPath) {
            await pasteClipboardImageFromLocalPath(result.localPath, targetSessionId);
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
      compositionText = trackCompositionText(text);
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
          queueWrite(getBackspaceInputCode().repeat(immediateCompositionText.length - text.length));
        } else {
          // IME replaced the composition (e.g. suggestion pick).
          queueWrite(getBackspaceInputCode().repeat(immediateCompositionText.length));
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
      if (suppressPlainSpace) {
        suppressPlainSpace = false;
        if (value !== " ") sendText(value);
      } else {
        sendText(value);
      }
      target.value = "";
    }
  }

  function isSinglePrintableKeyboardKey(value: string): boolean {
    const codePoint = value.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0x20 && String.fromCodePoint(codePoint) === value;
  }

  function nativeLayoutKey(event: KeyboardEvent) {
    return resolveKittyLayoutKey(event, nativeKeyboardLayoutMap[event.code] ?? []);
  }

  function toKittyKeyboardEvent(event: KeyboardEvent): KittyKeyboardEvent {
    const nativeLayout = event.code ? nativeLayoutKey(event) : undefined;
    let unshiftedKey = event.code
      ? observedUnshiftedKeys.get(event.code)
        ?? nativeLayout?.unshifted
        ?? browserKeyboardLayoutMap?.get(event.code)
      : undefined;
    const shiftedKey = event.shiftKey ? nativeLayout?.shifted ?? undefined : undefined;
    if (
      event.code &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.getModifierState("CapsLock") &&
      !event.getModifierState("NumLock") &&
      isSinglePrintableKeyboardKey(event.key)
    ) {
      unshiftedKey = event.key;
      observedUnshiftedKeys.set(event.code, event.key);
    }
    if ((!unshiftedKey || unshiftedKey === event.key) && !shiftedKey) return event;

    return {
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      repeat: event.repeat,
      getModifierState: (key) => event.getModifierState(key),
      unshiftedKey,
      shiftedKey,
    };
  }

  // Handle keydown for special keys
  function handleKeyDown(e: KeyboardEvent) {
    if (!sessionId) return;

    if (isDesktopTarget && e.isComposing) {
      // The IME owns this keystroke. Backspace and Escape edit or cancel
      // the marked syllable (the following compositionend reports the
      // shrink/cancel). Enter commits it; Space commits a Korean syllable
      // but only picks a candidate for pinyin/kana, so defer a literal
      // space only while a Hangul word is active. Windows IMEs report
      // "Process" instead of the real key name.
      const isEnter =
        e.key === "Enter" ||
        (e.key === "Process" && (e.code === "Enter" || e.code === "NumpadEnter"));
      const isSpace = e.key === " " || (e.key === "Process" && e.code === "Space");
      if (isEnter || (isSpace && hangulComposer.hasActiveWord())) {
        const pendingEvent = {
          key: isEnter ? "Enter" : " ",
          code: isEnter ? e.code : "Space",
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          repeat: e.repeat,
          getModifierState: (key: string) => e.getModifierState(key),
        };
        pendingCommitKey = {
          data: encodeKittyKeyboardEvent(
            pendingEvent,
            parser?.getKittyKeyboardFlags() ?? 0,
          ) ?? (isEnter ? "\r" : " "),
          suppressPlainSpace: isSpace,
        };
      }
      return;
    }

    // Any physical key that ends text flow also ends the Hangul word the
    // composer is accumulating. Printable keys are excluded so jamo
    // delivered as plain (non-composition) input keeps accumulating.
    if (
      e.key === "Enter" ||
      e.key === "Backspace" ||
      e.key === "Tab" ||
      e.key === "Escape" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey)
    ) {
      hangulComposer.breakWord();
      pendingCommitKey = null;
      suppressPlainSpace = false;
    }

    const terminalKey = encodeTerminalKeyboardEvent(
      toKittyKeyboardEvent(e),
      navigator.platform,
      parser?.getKittyKeyboardFlags() ?? 0,
    );
    if (terminalKey) {
      e.preventDefault();
      queueWrite(terminalKey);
      return;
    }
    // Enter key
    if (e.key === "Enter") {
      e.preventDefault();
      queueWrite("\r");
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
      // Single letters only — modifier key names ("control", "meta", ...)
      // would otherwise pass this range check on their bare keydown.
      if (lower.length === 1 && lower >= "a" && lower <= "z") {
        e.preventDefault();
        queueWrite(String.fromCharCode(lower.charCodeAt(0) - 96));
        return;
      }
    }
  }
  function handleKeyUp(e: KeyboardEvent) {
    if (!sessionId || e.isComposing) return;
    const terminalKey = encodeTerminalKeyboardEvent(
      toKittyKeyboardEvent(e),
      navigator.platform,
      parser?.getKittyKeyboardFlags() ?? 0,
      "release",
    );
    if (!terminalKey) return;
    e.preventDefault();
    queueWrite(terminalKey);
  }
  function handleWriteError(e: unknown) {
    console.error('[SSH] write failed:', e);
    if (String(e).includes('Channel closed') || String(e).includes('closed')) {
      void reconnectSession("channel closed");
    }
  }

  function clearAutomaticResponses() {
    automaticResponseBuffer.clear();
    automaticResponseFlushScheduled = false;
    automaticResponseGeneration++;
  }

  function flushAutomaticResponses(generation: number, expectedSessionId: string) {
    if (generation !== automaticResponseGeneration) return;
    automaticResponseFlushScheduled = false;
    if (sessionId !== expectedSessionId) {
      automaticResponseBuffer.clear();
      return;
    }

    const data = automaticResponseBuffer.drain();
    if (data.length > 0) sendSessionData(encoder.encode(data));
  }

  function enqueueAutomaticResponse(data: string) {
    const activeSessionId = sessionId;
    if (!activeSessionId || !automaticResponseBuffer.enqueue(data)) return;
    if (automaticResponseFlushScheduled) return;

    automaticResponseFlushScheduled = true;
    const generation = automaticResponseGeneration;
    queueMicrotask(() => {
      flushAutomaticResponses(generation, activeSessionId);
    });
  }

  function queueWrite(data: string) {
    const queuedSessionId = sessionId;
    if (!queuedSessionId || data.length === 0) return;
    pendingWrite += data;
    if (writeFlushScheduled) return;

    const generation = connectionGeneration;
    writeFlushScheduled = true;
    queueMicrotask(() => {
      writeFlushScheduled = false;
      if (
        !isConnectionAttemptActive(generation, queuedSessionId) ||
        pendingWrite.length === 0
      ) {
        pendingWrite = "";
        return;
      }

      const payload = pendingWrite;
      pendingWrite = "";
      sendSessionData(encoder.encode(payload));
    });
  }
  // Apply Kitty reporting or on-screen modifiers before writing text.
  function writeInputText(data: string) {
    if (!data) return;
    if (data.length === 1 && (modifiersStore.ctrlActive || modifiersStore.altActive)) {
      const ctrlActive = modifiersStore.ctrlActive;
      const altActive = modifiersStore.altActive;
      const kittyKey = encodeKittyKeyboardEvent(
        { key: data, ctrlKey: ctrlActive, altKey: altActive },
        parser?.getKittyKeyboardFlags() ?? 0,
      );
      if (ctrlActive) modifiersStore.resetCtrl();
      else modifiersStore.resetAlt();
      if (kittyKey) {
        queueWrite(kittyKey);
        return;
      }
      data = ctrlActive ? ctrlKey(data) : altKey(data);
    }

    const kittyText = encodeKittyInputText(data, parser?.getKittyKeyboardFlags() ?? 0);
    if (kittyText) queueWrite(kittyText);
  }

  // Apply on-screen modifier state to a single composed character and write.
  function writeComposed(result: HangulFeedResult, trackCommittedHangulEcho = false) {
    if (trackCommittedHangulEcho && result.erase === 0) {
      const committedCells = [...result.send].reduce(
        (cells, character) =>
          /[ᄀ-ᇿ㄰-㆏가-힯]/u.test(character) ? cells + 2 : cells,
        0,
      );
      pendingHangulEchoCells += committedCells;
    }
    if (result.erase > 0) queueWrite(getBackspaceInputCode().repeat(result.erase));
    writeInputText(result.send);
  }

  function sendText(text: string) {
    if (!sessionId) return;

    if (isDesktopTarget) {
      // Desktop IMEs deliver Hangul as jamo deltas, in-progress syllable
      // resends, or composed syllables depending on timing; the composer
      // reassembles all three and reports DEL corrections.
      writeComposed(hangulComposer.feed(text.normalize("NFC")));
      return;
    }

    // Mobile IMEs deliver composed text; only NFC + one-shot Jamo
    // composition is needed.
    writeInputText(composeJamoSequence(text.normalize("NFC")));
  }

  onDestroy(() => {
    connectionGeneration++;
    if (hostKeyPromptResolver) resolveHostKeyPrompt("cancel");
    if (keyPassphrasePromptResolver) resolveKeyPassphrasePrompt(null);
    if (osc52ApprovalResolver) settleOsc52Approval(false);
    destroyed = true;
    parserGeneration++;
    const activeParser = parser;
    activeParser?.setOscEventHandler(() => {});
    const activeSessionId = sessionId;
    if (
      activeSessionId &&
      terminalMouseButton !== null &&
      lastTerminalMouseCell &&
      activeParser?.shouldReportMouseRelease()
    ) {
      sendMouseButton(terminalMouseButton, lastTerminalMouseCell, false);
    }
    if (
      terminalMousePointerId !== null &&
      scrollContainer?.hasPointerCapture(terminalMousePointerId)
    ) {
      scrollContainer.releasePointerCapture(terminalMousePointerId);
    }
    terminalMousePointerId = null;
    terminalMouseButton = null;
    lastTerminalMouseCell = null;
    localSelectionPointerId = null;
    const isBackgroundTeardown =
      typeof document !== "undefined" && document.visibilityState === "hidden";

    if (activeSessionId && isBackgroundTeardown && kind === "ssh" && activeParser) {
      void sshStoreSessionSnapshot(
        activeSessionId,
        createTerminalSnapshot(activeParser),
        lastProcessedSeq
      ).catch((e) => {
        console.error("Store session snapshot error:", e);
      });
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
    keyboardLayoutUnlisten?.();
    keyboardLayoutUnlisten = null;
    if (keyboardLayoutApi && keyboardLayoutChangeHandler) {
      keyboardLayoutApi.removeEventListener?.("layoutchange", keyboardLayoutChangeHandler);
    }
    keyboardLayoutApi = null;
    keyboardLayoutChangeHandler = null;

    clearSelectionFeedbackTimer();
    surfaceVisibilityObserver?.disconnect();
    surfaceVisibilityObserver = null;
    terminalSurfaceIntersecting = false;
    renderer?.setAnimationsEnabled(false);
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
    hangulComposer.reset();
    pendingCommitKey = null;
    pendingHangulEchoCells = 0;
    if (deferredUpdateTimer) {
      clearTimeout(deferredUpdateTimer);
      deferredUpdateTimer = null;
    }
    clearSynchronizedOutputTimer();
    clearImageAnimationTimer();
    if (cursorInterval) {
      clearInterval(cursorInterval);
    }
    parser = null;
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
      hiddenInput.removeEventListener('keyup', handleKeyUp);
      hiddenInput.removeEventListener('compositionstart', handleCompositionStart);
      hiddenInput.removeEventListener('compositionupdate', handleCompositionUpdate);
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

  export async function disconnect(fallbackSessionId?: string) {
    connectionGeneration++;
    if (hostKeyPromptResolver) resolveHostKeyPrompt("cancel");
    if (keyPassphrasePromptResolver) resolveKeyPassphrasePrompt(null);
    disconnectRequested = true;

    const activeSessionId = sessionId ?? fallbackSessionId ?? null;
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

  export function getCurrentDirectoryUri(): string | null {
    return currentDirectoryUri;
  }

  export function focus() {
    focusInput();
  }

  /// Paste clipboard image or text into the active terminal. Desktop shortcuts
  /// use this because intercepting Ctrl/Cmd+V prevents the native paste event.
  export async function pasteFromClipboard() {
    if (!sessionId) return;
    const targetSessionId = sessionId;

    if (await pasteNativeClipboardImage(targetSessionId)) return;

    try {
      const text = await readClipboardText();
      if (text) sendPastedText(text);
    } catch (error) {
      console.error("[Terminal] clipboard text read failed:", error);
    }
  }

  export function pasteUploadedImagePath(targetSessionId: string, remotePath: string): boolean {
    if (kind === "local" || sessionId !== targetSessionId) return false;
    sendPastedText(remotePath);
    return true;
  }

  /// Persist the current screen so a caller moving this terminal between
  /// containers can restore it exactly after the remount. Resolves once
  /// the backend snapshot is stored (or resolves immediately when there
  /// is nothing to store).
  export function storeSnapshot(): Promise<void> {
    if (sessionId && parser) {
      processPendingOutputSlice(true);
      storeRuntimeSessionSnapshot(sessionId, createRuntimeTerminalSnapshot(parser));
      if (kind === "local") {
        try {
          saveSessionSnapshot(sessionId);
        } catch (error) {
          console.error("Store local terminal snapshot error:", error);
        }
        return Promise.resolve();
      }
      return sshStoreSessionSnapshot(
        sessionId,
        createTerminalSnapshot(parser),
        lastProcessedSeq
      ).catch(() => {});
    }
    return Promise.resolve();
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

  async function retryFailedConnection() {
    if (destroyed || connected || reconnecting || disconnectRequested) return;
    const didConnect = await connectNewSession();
    if (!didConnect || destroyed) return;
    await tick();
    focusInput();
  }

  function isConnectionFailureStatus(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("connection failed") ||
      lower.includes("failed to start local shell")
    );
  }

  function isErrorStatus(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.startsWith("connection lost") ||
      lower.startsWith("connection failed") ||
      lower.startsWith("failed to ") ||
      lower.startsWith("image upload failed") ||
      lower.startsWith("paste failed")
    );
  }

  function getStatusTitle(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes("failed to start local shell")) return "Local Shell Failed";
    if (lower.includes("failed to restore local shell")) return "Local Shell Failed";
    if (lower.startsWith("image upload failed")) return "Image Upload Failed";
    if (lower.startsWith("paste failed")) return "Paste Failed";
    if (lower.includes("connection failed")) return "Connection Failed";
    if (lower.includes("connection lost")) return "Connection Lost";
    if (lower.includes("connection cancelled")) return "Connection Cancelled";
    if (lower.includes("local shell exited")) return "Local Shell Exited";
    if (lower.includes("session ended")) return "Session Ended";
    if (lower.startsWith("reconnecting")) return "Reconnecting";
    if (lower.startsWith("starting local shell")) return "Starting Local Shell";
    if (lower.startsWith("uploading pasted image")) return "Uploading Image";
    if (lower.startsWith("connecting to")) return "Connecting";
    return "Status";
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
    class:composing={isDesktopTarget && isComposing}
    style={compositionInputStyle(isComposing ? compositionAnchor : cursorPos)}
    inputmode="none"
    autocomplete="off"
    autocapitalize="off"
    data-autocorrect="off"
    spellcheck="false"
    enterkeyhint="send"
    wrap="off"
  ></textarea>

  {#if isDesktopTarget && isComposing && hasUsableCompositionAnchor() && compositionText}
    <div class="composition-view" style={compositionInputStyle(compositionAnchor)} aria-hidden="true">
      <span class="composition-text">{compositionText}</span><span class="composition-caret"></span>
    </div>
  {/if}

  <!-- Status message -->
  {#if statusMessage}
    <div class="status-overlay" class:error={isErrorStatus(statusMessage)}>
      <div class="status-card" role={isErrorStatus(statusMessage) ? "alert" : "status"}>
        <div class="status-header">
          <span class="status-indicator" aria-hidden="true"></span>
          <strong>{getStatusTitle(statusMessage)}</strong>
        </div>
        <div class="status-message">{statusMessage}</div>
        {#if isConnectionFailureStatus(statusMessage)}
          <div class="status-actions">
            <button
              type="button"
              class="status-action primary"
              onclick={(event) => {
                event.stopPropagation();
                onRetryConnection?.();
                void retryFailedConnection();
              }}
            >Retry</button>
            {#if onEditConnection}
              <button
                type="button"
                class="status-action"
                onclick={(event) => {
                  event.stopPropagation();
                  onEditConnection?.();
                }}
              >Edit connection</button>
            {/if}
            {#if onCloseTab}
              <button
                type="button"
                class="status-action"
                disabled={closeTabPending}
                onclick={(event) => {
                  event.stopPropagation();
                  onCloseTab?.();
                }}
              >Close tab</button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if !isDesktopTarget && (showSelectionToolbar || selectionFeedback)}
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
    onwheel={handleTerminalWheel}
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

  <CloseConfirmationModal
    open={osc52ApprovalOpen}
    title="Clipboard access requested"
    message="The remote server requested to write to your clipboard (OSC 52)."
    detail="Allow clipboard writes from this server while this session is open?"
    confirmLabel="Allow"
    destructive={false}
    onCancel={() => settleOsc52Approval(false)}
    onConfirm={() => settleOsc52Approval(true)}
  />

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
    width: 1px;
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

  .hidden-input.composing {
    right: var(--terminal-horizontal-padding, 4px);
    width: auto;
    opacity: 0;
    margin: 0;
    padding: 0;
    overflow: hidden;
    color: transparent;
    caret-color: transparent;
    background: transparent;
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", "Fira Code", monospace;
    white-space: pre;
    z-index: 2;
  }

  .composition-view {
    position: absolute;
    max-width: calc(100% - var(--terminal-horizontal-padding, 4px));
    overflow: hidden;
    color: var(--terminal-fg, #f5f5f5);
    background: var(--terminal-bg, #1a0f0f);
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", "Fira Code", monospace;
    white-space: pre;
    pointer-events: none;
    z-index: 1;
  }

  .composition-text {
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  .composition-caret {
    display: inline-block;
    width: 1px;
    height: 0.95em;
    margin-left: 1px;
    vertical-align: -0.15em;
    background: var(--terminal-cursor, #f5f5f5);
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

  .status-overlay.error .status-card {
    pointer-events: auto;
  }

  .status-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }

  .status-action {
    min-height: 32px;
    padding: 6px 10px;
    border: 1px solid rgba(255, 218, 218, 0.28);
    border-radius: 6px;
    background: transparent;
    color: #ffdada;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .status-action:hover {
    border-color: rgba(255, 218, 218, 0.58);
    background: rgba(255, 218, 218, 0.09);
  }

  .status-action.primary {
    border-color: #ffdada;
    background: #ffdada;
    color: #301212;
  }

  .status-action.primary:hover {
    background: #ffffff;
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
