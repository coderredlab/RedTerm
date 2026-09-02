// ANSI Escape Sequence Parser
// Handles basic terminal control sequences
import { convertIndexedToRgb, decode as decodePngBytes, type DecodedPng } from 'fast-png';
import { Unzlib } from 'fflate';
import { decodeSixel } from './sixel-decoder';
import { kittyDiacriticIndex } from './kitty-placeholder';
import {
  KITTY_KEYBOARD_STACK_LIMIT,
  KITTY_KEYBOARD_SUPPORTED_FLAGS,
} from './kitty-keyboard';

export interface TextStyle {
  fg: string | null;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
  hidden: boolean;
  ansiFgIndex?: number;
  ansiBgIndex?: number;
  kittyForegroundId?: number;
  kittyUnderlineId?: number;
}
export interface TerminalHyperlink {
  uri: string;
  id?: string;
}

export interface TerminalOscColors {
  foreground: string;
  background: string;
  cursor: string;
}

export type TerminalShellIntegrationPhase = 'none' | 'prompt' | 'command' | 'output' | 'finished';

export interface TerminalShellIntegrationState {
  phase: TerminalShellIntegrationPhase;
  row: number;
  col: number;
  exitStatus: number | null;
}

export type TerminalOscEvent =
  | { type: 'title'; value: string }
  | { type: 'current-directory'; uri: string }
  | { type: 'clipboard'; text: string }
  | { type: 'colors'; colors: TerminalOscColors };


export interface TerminalTextSizingCell {
  text?: string;
  scale: number;
  width: number;
  numerator: number;
  denominator: number;
  verticalAlign: 0 | 1 | 2;
  horizontalAlign: 0 | 1 | 2;
  row: number;
  col: number;
}

export interface Cell {
  char: string;
  hyperlink?: TerminalHyperlink;
  style: TextStyle;
  imagePlaceholder?: KittyPlaceholderCell;
  textSizing?: TerminalTextSizingCell;
}
interface KittyPlaceholderCell {
  renderId: number;
  imageId: number;
  imageIdLow: number;
  imageIdHigh: number;
  placementId?: number;
  row: number;
  col: number;
  diacriticCount: number;
}

interface TerminalImageBase {
  id: number;
  dataId?: number;
  protocol: 'kitty' | 'iterm2' | 'sixel';
  imageId?: number;
  imageNumber?: number;
  placementId?: number;
  row: number;
  col: number;
  widthCells: number;
  heightCells: number;
  pixelWidth: number;
  pixelHeight: number;
  destinationPixelWidth?: number;
  destinationPixelHeight?: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  offsetX: number;
  offsetY: number;
  zIndex: number;
}

export interface TerminalRgbaImage extends TerminalImageBase {
  kind: 'rgba';
  data: Uint8ClampedArray;
}

export interface TerminalPngImage extends TerminalImageBase {
  kind: 'png';
  mimeType: 'image/png';
  data: Uint8Array;
}

export type EncodedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface TerminalEncodedImage extends TerminalImageBase {
  kind: 'encoded';
  mimeType: Exclude<EncodedImageMimeType, 'image/png'>;
  data: Uint8Array;
  animated: boolean;
  decodedFramePixels?: number;
}

export type TerminalImage = TerminalRgbaImage | TerminalPngImage | TerminalEncodedImage;

interface KittyImageDataBase {
  pixelWidth: number;
  pixelHeight: number;
  imageNumber?: number;
  animation?: KittyAnimationState;
}
interface KittyRgbaImageData extends KittyImageDataBase {
  kind: 'rgba';
  data: Uint8ClampedArray;
}

interface KittyPngImageData extends KittyImageDataBase {
  kind: 'png';
  mimeType: 'image/png';
  data: Uint8Array;
}

type KittyImageData = KittyRgbaImageData | KittyPngImageData;
interface KittyAnimationFrame {
  data: KittyImageData;
  gap: number;
}

interface KittyAnimationState {
  frames: KittyAnimationFrame[];
  currentFrame: number;
  running: boolean;
  waitForFrames: boolean;
  configuredLoops: number;
  remainingLoops: number;
  lastFrameAt: number;
}
interface KittyVirtualPlacement {
  imageId: number;
  imageNumber?: number;
  placementId?: number;
  columns: number;
  rows: number;
  zIndex: number;
  originRow?: number;
  originCol?: number;
}

interface KittyRelativePlacement {
  id: number;
  imageId: number;
  imageNumber?: number;
  placementId?: number;
  parentImageId: number;
  parentPlacementId?: number;
  horizontalOffset: number;
  verticalOffset: number;
  widthCells: number;
  heightCells: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  offsetX: number;
  offsetY: number;
  zIndex: number;
}

interface PendingKittyImage {
  row: number;
  col: number;
  params: Map<string, string>;
  chunks: string[];
  encodedLength: number;
}

interface PendingITerm2File {
  args: Map<string, string>;
  chunks: string[];
  encodedLength: number;
}
interface EncodedImageDimensions {
  width: number;
  height: number;
  animated: boolean;
  decodedFramePixels: number;
}


export type TerminalParseState =
  | 'normal'
  | 'escape'
  | 'csi'
  | 'csiDiscard'
  | 'osc'
  | 'oscEscape'
  | 'oscDiscard'
  | 'oscDiscardEscape'
  | 'ss3'
  | 'charset'
  | 'apc'
  | 'apcEscape'
  | 'apcDiscard'
  | 'apcDiscardEscape'
  | 'dcs'
  | 'dcsEscape'
  | 'dcsDiscard'
  | 'dcsDiscardEscape';

interface TerminalRuntimeImageState {
  images: TerminalImage[];
  mainScreenImages: TerminalImage[];
  kittyImageData: Array<[number, KittyImageData]>;
  kittyImageCacheIds: Array<[number, number]>;
  kittyVirtualPlacements: Array<[string, KittyVirtualPlacement]>;
  kittyRelativePlacements: Array<[string, KittyRelativePlacement]>;
  mainScreenKittyVirtualPlacements: Array<[string, KittyVirtualPlacement]>;
  mainScreenKittyRelativePlacements: Array<[string, KittyRelativePlacement]>;
  kittyImageNumbers: Array<[number, number]>;
  nextImageId: number;
  nextKittyImageId: number;
}

export interface TerminalSnapshot {
  bufferRows: Cell[][];
  scrollbackRows: Cell[][];
  cursorX: number;
  cursorY: number;
  applicationCursorKeys: boolean;
  autoWrapMode?: boolean;
  bracketedPasteMode?: boolean;
  mouseMode?: number;
  cursorVisible?: boolean;
  synchronizedOutput?: boolean;
  sgrMouseEncoding?: boolean;
  usingAlternateScreen: boolean;
  kittyKeyboard?: {
    mainFlags: number;
    alternateFlags: number;
    mainStack: number[];
    alternateStack: number[];
  };
  scrollTop: number;
  scrollBottom: number;
  outputOffset: number;
  oscTitle?: string;
  oscCurrentDirectoryUri?: string;
  oscPalette?: string[];
  oscColors?: TerminalOscColors;
  oscShellIntegration?: TerminalShellIntegrationState;
  oscActiveHyperlink?: TerminalHyperlink;
  mainScreenBufferRows?: Cell[][];
  mainScreenScrollbackRows?: Cell[][];
  mainScreenCursor?: { x: number; y: number };
  mainScreenScrollRegion?: { top: number; bottom: number };
  parserState?: TerminalParseState;
  parserEscapeBuffer?: string;
  parserStyle?: TextStyle;
  parserSavedCursor?: { x: number; y: number };
  parserLastPrintedChar?: string;
  pendingKittyImage?: {
    row: number;
    col: number;
    params: Array<[string, string]>;
    chunks: string[];
    encodedLength: number;
  };
  pendingITerm2File?: {
    args: Array<[string, string]>;
    chunks: string[];
    encodedLength: number;
  };
  utf8PendingBytes?: number[];
  runtimeImageState?: TerminalRuntimeImageState;
}

export const DEFAULT_STYLE: TextStyle = {
  fg: null,
  bg: 'transparent',
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strikethrough: false,
  hidden: false,
};

const DEFAULT_STYLE_KEY = 'fg:default|bg:transparent|b:0|d:0|i:0|u:0|v:0|s:0|h:0';
const MAX_STYLE_POOL_SIZE = 4096;
const MAX_CSI_PARAMETER = 0x7fffffff;
const MAX_CSI_REP_COUNT = 256;
const MAX_CSI_SEQUENCE_CHARS = 1024;
const MAX_CONTROL_FIELDS = 32;
const MAX_IMAGE_METADATA_CHARS = 4096;
const MAX_IMAGE_PIXEL_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
const MAX_IMAGE_DECODED_BYTES = MAX_IMAGE_PIXELS * 4;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_DECODED_BYTES / 3) * 4;
const MAX_KITTY_CHUNK_BASE64_CHARS = 4096;
const MAX_KITTY_APC_SEQUENCE_CHARS =
  1 + MAX_IMAGE_METADATA_CHARS + 1 + MAX_KITTY_CHUNK_BASE64_CHARS;
const MAX_CONTROL_SEQUENCE_CHARS = Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4096;
const MAX_OSC_TEXT_BYTES = 4096;
const OSC_TEXT_ENCODER = new TextEncoder();
const OSC_TEXT_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const OSC_TEXT_EMOJI_PRESENTATION = /\p{Emoji_Presentation}|\p{Regional_Indicator}/u;
const OSC_TEXT_ZERO_WIDTH_GRAPHEME = /^(?:\p{Mark}|\p{Cf})+$/u;
const MAX_OSC_TITLE_CHARS = 1024;
const MAX_OSC_URI_CHARS = 4096;
const MAX_OSC_CLIPBOARD_BYTES = 64 * 1024;
const MAX_OSC_CLIPBOARD_BASE64_CHARS = Math.ceil(MAX_OSC_CLIPBOARD_BYTES / 3) * 4;
const MAX_OSC_SEQUENCE_CHARS = MAX_OSC_TEXT_BYTES + 64;
const MAX_IMAGE_CHUNKS = Math.ceil(MAX_IMAGE_BASE64_CHARS / MAX_KITTY_CHUNK_BASE64_CHARS);
const MAX_TOTAL_IMAGE_DATA_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IMAGE_PIXELS = 8 * 1024 * 1024;
const MAX_TERMINAL_IMAGES = 128;
const MAX_KITTY_IMAGE_DATA = 128;
const MAX_ANIMATED_IMAGE_FRAMES = 256;
const MAX_KITTY_DETACHED_PLACEMENTS = 128;
const MAX_IMAGE_CELL_DIMENSION = 4096;
const DEFAULT_ITERM2_CELL_PIXEL_WIDTH = 8;
const DEFAULT_ITERM2_CELL_PIXEL_HEIGHT = 16;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const MAX_ZLIB_INPUT_CHUNK_BYTES = 512;
const ZLIB_OUTPUT_LIMIT_EXCEEDED = Symbol('zlib-output-limit-exceeded');

function unzlibBounded(
  input: Uint8Array,
): { ok: true; data: Uint8Array } | { ok: false; error: string } {
  const chunks: Uint8Array[] = [];
  let outputLength = 0;
  const decoder = new Unzlib((chunk) => {
    if (chunk.length === 0) return;
    outputLength += chunk.length;
    if (outputLength > MAX_IMAGE_DECODED_BYTES) throw ZLIB_OUTPUT_LIMIT_EXCEEDED;
    chunks.push(chunk);
  });

  try {
    for (let offset = 0; offset < input.length; offset += MAX_ZLIB_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + MAX_ZLIB_INPUT_CHUNK_BYTES, input.length);
      decoder.push(input.subarray(offset, end), end === input.length);
    }
  } catch (error) {
    return error === ZLIB_OUTPUT_LIMIT_EXCEEDED
      ? { ok: false, error: 'ENOSPC:decompressed image too large' }
      : { ok: false, error: 'EINVAL:invalid zlib data' };
  }

  const data = new Uint8Array(outputLength);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, data };
}

const UNSAFE_OSC_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function normalizeOscColor(value: string): string | null {
  const rgbMatch = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(value);
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{9}|[0-9a-f]{12})$/i.exec(value);
  const components = rgbMatch
    ? rgbMatch.slice(1)
    : hexMatch
      ? [
          hexMatch[1].slice(0, hexMatch[1].length / 3),
          hexMatch[1].slice(hexMatch[1].length / 3, (hexMatch[1].length / 3) * 2),
          hexMatch[1].slice((hexMatch[1].length / 3) * 2),
        ]
      : null;
  if (!components) return null;

  const normalized = components.map((component) => {
    const maximum = 16 ** component.length - 1;
    return Math.round((Number.parseInt(component, 16) / maximum) * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${normalized.join('')}`;
}

function formatOscColor(color: string): string {
  const normalized = normalizeOscColor(color) ?? '#000000';
  return `rgb:${normalized.slice(1, 3).repeat(2)}/${normalized.slice(3, 5).repeat(2)}/${normalized.slice(5, 7).repeat(2)}`;
}

function truncateWithoutSplittingSurrogate(value: string, maxCodeUnits: number): string {
  let end = Math.min(value.length, maxCodeUnits);
  if (end < value.length && end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return value.slice(0, end);
}

function sanitizeOscTitle(value: string): string {
  return truncateWithoutSplittingSurrogate(value.replace(UNSAFE_OSC_TEXT, ''), MAX_OSC_TITLE_CHARS);
}

function safeOscUri(value: string): string | null {
  UNSAFE_OSC_TEXT.lastIndex = 0;
  const unsafe = UNSAFE_OSC_TEXT.test(value);
  UNSAFE_OSC_TEXT.lastIndex = 0;
  return !value || value.length > MAX_OSC_URI_CHARS || unsafe ? null : value;
}

// Standard ANSI colors
const COLORS_16 = [
  '#3d2020', '#ff6b6b', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d4bebe', // normal
  '#5c3030', '#ff8585', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#e8d4d4', // bright
];
const DEFAULT_PALETTE = Array.from({ length: 256 }, (_, index) => {
  if (index < 16) return COLORS_16[index];
  if (index < 232) {
    const cube = index - 16;
    const blue = (cube % 6) * 51;
    const green = (Math.floor(cube / 6) % 6) * 51;
    const red = Math.floor(cube / 36) * 51;
    return `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
  }
  const gray = (index - 232) * 10 + 8;
  return `#${gray.toString(16).padStart(2, '0').repeat(3)}`;
});
const DEFAULT_OSC_COLORS: TerminalOscColors = {
  foreground: '#e8d4d4',
  background: '#1a0f0f',
  cursor: '#ff6b6b',
};

export class AnsiParser {
  private buffer: Cell[][];
  private scrollback: Cell[][] = [];
  private fullBufferCache: Cell[][] = [];
  private fullBufferDirty = true;
  private textSizingByteLengths = new WeakMap<Cell, number>();
  private dirtyRows = new Set<number>();
  private allDirty = true; // 초기 상태 / resize 시 전체 다시 그리기
  private maxScrollback = 1000;
  private cursorX = 0;
  private cursorY = 0;
  private scrollTop = 0;
  private scrollBottom: number;
  private rows: number;
  private cols: number;
  private style: TextStyle = { ...DEFAULT_STYLE };
  private stylePool = new Map<string, TextStyle>([
    [DEFAULT_STYLE_KEY, Object.freeze({ ...DEFAULT_STYLE })],
  ]);
  private parseState: TerminalParseState = 'normal';
  private escapeBuffer = '';
  private images: TerminalImage[] = [];
  private mainScreenImages: TerminalImage[] = [];
  private nextImageId = 1;
  private kittyImageCacheIds = new WeakMap<KittyImageData, number>();
  private imageCachePrunePending = false;
  private kittyImageData = new Map<number, KittyImageData>();
  private kittyVirtualPlacements = new Map<string, KittyVirtualPlacement>();
  private kittyRelativePlacements = new Map<string, KittyRelativePlacement>();
  private mainScreenKittyVirtualPlacements = new Map<string, KittyVirtualPlacement>();
  private mainScreenKittyRelativePlacements = new Map<string, KittyRelativePlacement>();
  private kittyVirtualOriginsDirty = false;
  private kittyImageNumbers = new Map<number, number>();
  private nextKittyImageId = 1;
  private cellPixelWidth = DEFAULT_ITERM2_CELL_PIXEL_WIDTH;
  private cellPixelHeight = DEFAULT_ITERM2_CELL_PIXEL_HEIGHT;
  private pendingKittyImage: PendingKittyImage | null = null;
  private pendingITerm2File: PendingITerm2File | null = null;
  private savedCursor = { x: 0, y: 0 };
  private lastPrintedChar = ' '; // CSI b (REP) 용
  private applicationCursorKeys = false;
  private autoWrapMode = true;
  private kittyKeyboardMainFlags = 0;
  private kittyKeyboardAlternateFlags = 0;
  private kittyKeyboardMainStack: number[] = [];
  private kittyKeyboardAlternateStack: number[] = [];
  private bracketedPasteMode = false;
  private cursorVisible = true;
  private usingAlternateScreen = false;
  private mainScreenBuffer: Cell[][] | null = null;
  private mainScreenScrollback: Cell[][] = [];
  private mainScreenCursor = { x: 0, y: 0 };
  private mainScreenScrollRegion = { top: 0, bottom: 0 };
  private synchronizedOutput = false; // mode 2026: true이면 렌더링 보류
  private mouseMode = 0; // 0=off, 9=X10 press-only, 1000=normal, 1002=button-event, 1003=any-event
  private sgrMouseEncoding = false; // mode 1006: SGR 마우스 인코딩

  // 터미널 → 원격 앱 응답 콜백 (DA, DSR 등)
  private paletteColors = [...DEFAULT_PALETTE];
  private oscColorDefaults = { ...DEFAULT_OSC_COLORS };
  private oscColors = { ...DEFAULT_OSC_COLORS };
  private oscTitle = '';
  private oscCurrentDirectoryUri: string | null = null;
  private activeHyperlink: TerminalHyperlink | null = null;
  private shellIntegration: TerminalShellIntegrationState = {
    phase: 'none',
    row: 0,
    col: 0,
    exitStatus: null,
  };
  private onResponse: ((data: string) => void) | null = null;
  setResponseHandler(handler: (data: string) => void) {
    this.onResponse = handler;
  }
  private onOscEvent: ((event: TerminalOscEvent) => void) | null = null;
  setOscEventHandler(handler: (event: TerminalOscEvent) => void) {
    this.onOscEvent = handler;
  }
  setOscColorDefaults(colors: TerminalOscColors) {
    const foreground = normalizeOscColor(colors.foreground);
    const background = normalizeOscColor(colors.background);
    const cursor = normalizeOscColor(colors.cursor);
    if (!foreground || !background || !cursor) return;
    this.oscColorDefaults = { foreground, background, cursor };
    this.oscColors = { ...this.oscColorDefaults };
    this.emitOscColors();
  }
  getOscTitle(): string {
    return this.oscTitle;
  }
  getCurrentDirectoryUri(): string | null {
    return this.oscCurrentDirectoryUri;
  }
  getOscColors(): TerminalOscColors {
    return { ...this.oscColors };
  }
  getShellIntegrationState(): TerminalShellIntegrationState {
    return { ...this.shellIntegration };
  }
  setCellSize(width: number, height: number) {
    if (Number.isFinite(width) && width > 0) this.cellPixelWidth = width;
    if (Number.isFinite(height) && height > 0) this.cellPixelHeight = height;
  }

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.scrollBottom = rows - 1;
    this.mainScreenScrollRegion = { top: 0, bottom: this.scrollBottom };
    this.buffer = this.createBuffer();
    this.fullBufferDirty = true;
  }

  private markFullBufferDirty() {
    this.fullBufferDirty = true;
    this.kittyVirtualOriginsDirty = true;
  }

  // buffer 내부 인덱스(cursorY)로 dirty 마킹
  private markRowDirty(bufferY: number) {
    this.dirtyRows.add(bufferY);
  }

  private markAllRowsDirty() {
    this.allDirty = true;
    this.dirtyRows.clear();
  }

  private createBuffer(): Cell[][] {
    const buffer: Cell[][] = [];
    for (let y = 0; y < this.rows; y++) {
      buffer.push(this.createEmptyRow());
    }
    return buffer;
  }

  private createEmptyRow(): Cell[] {
    const row: Cell[] = [];
    for (let x = 0; x < this.cols; x++) {
      row.push(this.createEmptyCell());
    }
    return row;
  }

  private createEmptyCell(): Cell {
    return { char: ' ', style: this.getInternedStyle(DEFAULT_STYLE) };
  }

  private cloneRow(row: Cell[]): Cell[] {
    return row.map((cell) => ({
      char: cell.char,
      style: cell.style,
      hyperlink: cell.hyperlink ? { ...cell.hyperlink } : undefined,
      imagePlaceholder: cell.imagePlaceholder ? { ...cell.imagePlaceholder } : undefined,
      textSizing: cell.textSizing ? { ...cell.textSizing } : undefined,
    }));
  }

  private cloneBuffer(buffer: Cell[][]): Cell[][] {
    return buffer.map((row) => this.cloneRow(row));
  }

  private isFullScreenRegion(scrollTop: number, scrollBottom: number, rowCount: number): boolean {
    return scrollTop === 0 && scrollBottom === Math.max(0, rowCount - 1);
  }

  private restoreViewportState(
    snapshotBufferRows: Cell[][] | undefined,
    snapshotScrollbackRows: Cell[][] | undefined,
    snapshotCursorY: number,
    preserveLatestLines: boolean,
  ): { buffer: Cell[][]; scrollback: Cell[][]; cursorY: number; removedTopRows: number } {
    const normalizedScrollback = (snapshotScrollbackRows ?? [])
      .slice(-this.maxScrollback)
      .map((row) => this.snapshotRowToBufferRow(row));
    let removedTopRows = Math.max(0, (snapshotScrollbackRows?.length ?? 0) - normalizedScrollback.length);
    let nextScrollback = normalizedScrollback;
    let visibleRows = (snapshotBufferRows ?? []).map((row) => this.snapshotRowToBufferRow(row));
    let nextCursorY = snapshotCursorY;

    if (preserveLatestLines) {
      if (visibleRows.length > this.rows) {
        const overflowCount = visibleRows.length - this.rows;
        const combinedScrollback = normalizedScrollback.concat(visibleRows.slice(0, overflowCount));
        removedTopRows += Math.max(0, combinedScrollback.length - this.maxScrollback);
        nextScrollback = combinedScrollback.slice(-this.maxScrollback);
        visibleRows = visibleRows.slice(overflowCount);
        nextCursorY = Math.max(0, snapshotCursorY - overflowCount);
      } else if (visibleRows.length < this.rows) {
        const pulledCount = Math.min(this.rows - visibleRows.length, normalizedScrollback.length);
        const restoredRows =
          pulledCount > 0 ? normalizedScrollback.slice(normalizedScrollback.length - pulledCount) : [];
        nextScrollback =
          pulledCount > 0
            ? normalizedScrollback.slice(0, normalizedScrollback.length - pulledCount)
            : normalizedScrollback;
        visibleRows = restoredRows.concat(visibleRows);
        nextCursorY = snapshotCursorY + pulledCount;
      }
    }

    const nextBuffer = this.createBuffer();
    const copyRows = Math.min(visibleRows.length, this.rows);
    for (let y = 0; y < copyRows; y++) {
      nextBuffer[y] = visibleRows[y];
    }

    return {
      buffer: nextBuffer,
      scrollback: nextScrollback,
      cursorY: Math.min(this.rows - 1, Math.max(0, nextCursorY)),
      removedTopRows,
    };
  }

  private rowContentLength(row: Cell[]): number {
    let last = 0;
    for (let i = 0; i < row.length; i++) {
      if (row[i].char !== ' ' || row[i].textSizing) last = i + 1;
    }
    return Math.max(1, last);
  }

  resize(cols: number, rows: number, trackedPosition?: { x: number; y: number }) {
    if (cols === this.cols && rows === this.rows) {
      return trackedPosition ? { ...trackedPosition } : undefined;
    }

    type RowOrigin = {
      oldRow: number;
      startCol: number;
      endCol: number;
      reflowed: boolean;
    };

    const oldBuffer = this.buffer;
    const oldScrollback = this.scrollback;
    const oldRows = this.rows;
    const oldCols = this.cols;
    const oldCursorY = this.cursorY;
    const oldCursorX = this.cursorX;
    const oldScrollTop = this.scrollTop;
    const oldScrollBottom = this.scrollBottom;
    const oldScrollbackLength = oldScrollback.length;
    const imageContentLengths = new Map<number, number>();
    for (const image of this.images) {
      imageContentLengths.set(
        image.row,
        Math.max(imageContentLengths.get(image.row) ?? 0, image.col + 1),
      );
    }
    const originForRow = (oldRow: number): RowOrigin => ({
      oldRow,
      startCol: 0,
      endCol: Math.max(oldCols, imageContentLengths.get(oldRow) ?? 0),
      reflowed: false,
    });
    const mainScreenUsesFullScrollRegion =
      this.mainScreenBuffer !== null &&
      this.isFullScreenRegion(
        this.mainScreenScrollRegion.top,
        this.mainScreenScrollRegion.bottom,
        this.mainScreenBuffer.length,
      );
    const canReflowMainScreen =
      !this.usingAlternateScreen &&
      oldScrollTop === 0 &&
      oldScrollBottom === oldRows - 1;

    // Keep row/column provenance beside every row so physical image anchors
    // follow the same trim, pull, wrap, and scrollback operations as text.
    let nextBufferRows = oldBuffer;
    let nextBufferOrigins: Array<RowOrigin | null> = oldBuffer.map((_, index) =>
      originForRow(oldScrollbackLength + index),
    );
    let nextScrollback = this.usingAlternateScreen ? [] : oldScrollback;
    let nextScrollbackOrigins: Array<RowOrigin | null> = this.usingAlternateScreen
      ? []
      : oldScrollback.map((_, index) => originForRow(index));
    let nextCursorY = oldCursorY;

    if (canReflowMainScreen) {
      if (rows < oldRows) {
        const trimmedCount = Math.max(0, oldCursorY - (rows - 1));
        const trimmedRows = oldBuffer.slice(0, trimmedCount);
        const trimmedOrigins = nextBufferOrigins.slice(0, trimmedCount);
        nextScrollback = oldScrollback.concat(trimmedRows).slice(-this.maxScrollback);
        nextScrollbackOrigins = nextScrollbackOrigins
          .concat(trimmedOrigins)
          .slice(-this.maxScrollback);
        nextBufferRows = oldBuffer.slice(trimmedCount);
        nextBufferOrigins = nextBufferOrigins.slice(trimmedCount);
        nextCursorY = Math.max(0, oldCursorY - trimmedCount);
      } else if (rows > oldRows) {
        const pulledCount = Math.min(rows - oldRows, nextScrollback.length);
        const restoredRows =
          pulledCount > 0 ? nextScrollback.slice(nextScrollback.length - pulledCount) : [];
        const restoredOrigins =
          pulledCount > 0
            ? nextScrollbackOrigins.slice(nextScrollbackOrigins.length - pulledCount)
            : [];
        nextScrollback =
          pulledCount > 0 ? nextScrollback.slice(0, nextScrollback.length - pulledCount) : nextScrollback;
        nextScrollbackOrigins =
          pulledCount > 0
            ? nextScrollbackOrigins.slice(0, nextScrollbackOrigins.length - pulledCount)
            : nextScrollbackOrigins;
        nextBufferRows = restoredRows.concat(oldBuffer);
        nextBufferOrigins = restoredOrigins.concat(nextBufferOrigins);
        nextCursorY = oldCursorY + pulledCount;
      }
    }

    // Narrowing splits rows into chunks instead of dropping content.
    let finalRows: Cell[][];
    let finalOrigins: Array<RowOrigin | null>;
    let finalCursorY = nextCursorY;
    let finalCursorX = Math.min(oldCursorX, cols - 1);

    if (canReflowMainScreen && cols < oldCols) {
      const allRows: Cell[][] = [];
      const allOrigins: Array<RowOrigin | null> = [];
      let cursorRowOffset = 0;
      for (let y = 0; y < nextBufferRows.length; y++) {
        const row = nextBufferRows[y];
        const origin = nextBufferOrigins[y];
        const contentLength = Math.max(
          this.rowContentLength(row),
          origin ? (imageContentLengths.get(origin.oldRow) ?? 0) : 0,
        );
        let pushed = 0;
        let start = 0;
        while (start < contentLength) {
          let end = Math.min(start + cols, contentLength);
          // Keep a wide main cell and its placeholder in one chunk whenever
          // the target grid has enough columns.
          if (
            cols > 1 &&
            end - start === cols &&
            end < contentLength &&
            row[end].char === '' &&
            row[end - 1].char !== '' &&
            this.isWideChar(row[end - 1].char)
          ) {
            end -= 1;
          }
          allRows.push(row.slice(start, end));
          allOrigins.push(
            origin
              ? {
                  oldRow: origin.oldRow,
                  startCol: origin.startCol + start,
                  endCol: origin.startCol + end,
                  reflowed: true,
                }
              : null,
          );
          start = end;
          pushed++;
        }
        if (pushed === 0) {
          allRows.push([]);
          allOrigins.push(origin);
          pushed = 1;
        }
        if (y < nextCursorY) cursorRowOffset += pushed;
      }

      const cursorRow = nextBufferRows[nextCursorY];
      if (cursorRow) {
        const within = Math.min(
          Math.floor(oldCursorX / cols),
          Math.max(1, Math.ceil(this.rowContentLength(cursorRow) / cols)) - 1,
        );
        finalCursorY = cursorRowOffset + within;
        finalCursorX = oldCursorX % cols;
      }

      finalRows = allRows;
      finalOrigins = allOrigins;
    } else {
      finalRows = nextBufferRows;
      finalOrigins = nextBufferOrigins;
      finalCursorY = nextCursorY;
      finalCursorX = Math.min(oldCursorX, cols - 1);
    }

    this.cols = cols;
    this.rows = rows;

    // Fit the reflowed screen into the viewport while keeping provenance in
    // lockstep. Rows above the cursor enter scrollback; rows below it drop.
    if (finalRows.length > rows) {
      const keptCount = Math.min(finalRows.length, finalCursorY + 1);
      finalRows = finalRows.slice(0, keptCount);
      finalOrigins = finalOrigins.slice(0, keptCount);
      const overflowCount = Math.max(0, finalRows.length - rows);
      if (overflowCount > 0) {
        if (!this.usingAlternateScreen) {
          nextScrollback = nextScrollback
            .concat(finalRows.slice(0, overflowCount))
            .slice(-this.maxScrollback);
          nextScrollbackOrigins = nextScrollbackOrigins
            .concat(finalOrigins.slice(0, overflowCount))
            .slice(-this.maxScrollback);
        }
        finalRows = finalRows.slice(overflowCount);
        finalOrigins = finalOrigins.slice(overflowCount);
        finalCursorY -= overflowCount;
      }
    } else if (finalRows.length < rows) {
      while (finalRows.length < rows) {
        finalRows.push([]);
        finalOrigins.push(null);
      }
    }

    this.scrollback = nextScrollback;
    this.buffer = this.createBuffer();

    const copyRows = Math.min(finalRows.length, rows);
    for (let y = 0; y < copyRows; y++) {
      const source = finalRows[y];
      for (let x = 0; x < source.length && x < cols; x++) {
        this.buffer[y][x] = source[x];
      }
    }

    const anchorDestinations = new Map<
      number,
      Array<{ startCol: number; endCol: number; row: number; reflowed: boolean }>
    >();
    const recordDestination = (origin: RowOrigin | null, row: number) => {
      if (!origin) return;
      const destinations = anchorDestinations.get(origin.oldRow) ?? [];
      destinations.push({
        startCol: origin.startCol,
        endCol: origin.endCol,
        row,
        reflowed: origin.reflowed,
      });
      anchorDestinations.set(origin.oldRow, destinations);
    };
    for (let y = 0; y < nextScrollbackOrigins.length; y++) {
      recordDestination(nextScrollbackOrigins[y], y);
    }
    for (let y = 0; y < finalOrigins.length; y++) {
      recordDestination(finalOrigins[y], nextScrollback.length + y);
    }

    let resizedTrackedPosition: { x: number; y: number } | null | undefined;
    if (trackedPosition) {
      const destinations = anchorDestinations.get(trackedPosition.y);
      const destination =
        destinations?.find((candidate) =>
          trackedPosition.x >= candidate.startCol && trackedPosition.x < candidate.endCol
        ) ?? destinations?.at(-1);
      const trackedRowWillReflow = cols < oldCols && destination?.reflowed === true;
      resizedTrackedPosition = destination
        ? {
            x: trackedRowWillReflow
              ? trackedPosition.x % cols
              : Math.min(cols - 1, Math.max(0, trackedPosition.x)),
            y: destination.row,
          }
        : null;
    }

    const previousImages = this.images;
    this.images = previousImages.flatMap((image) => {
      const destination = anchorDestinations
        .get(image.row)
        ?.find((candidate) => image.col >= candidate.startCol && image.col < candidate.endCol);
      if (!destination) return [];
      return [
        {
          ...image,
          row: destination.row,
          col: image.col - destination.startCol,
        },
      ];
    });
    this.deleteRelativeGroupsForRemovedPhysicalPlacements(previousImages, this.images);

    this.cursorX = Math.min(finalCursorX, cols - 1);
    this.cursorY = Math.min(finalCursorY, rows - 1);

    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;

    this.mainScreenScrollRegion = mainScreenUsesFullScrollRegion
      ? { top: 0, bottom: this.rows - 1 }
      : {
          top: Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.top)),
          bottom: Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.bottom)),
        };
    this.normalizeTextSizingRows(this.scrollback.concat(this.buffer));
    this.markFullBufferDirty();
    this.refreshKittyVirtualOrigins();
    this.markAllRowsDirty();
    return resizedTrackedPosition;
  }

  private oscSequenceLimit(): number {
    if (this.escapeBuffer.startsWith('1337;File')) return MAX_CONTROL_SEQUENCE_CHARS;
    if (this.escapeBuffer.startsWith('52;')) return MAX_OSC_CLIPBOARD_BASE64_CHARS + 64;
    return MAX_OSC_SEQUENCE_CHARS;
  }

  write(data: string) {
    for (const char of data) {
      this.processChar(char);
    }
  }

  private processChar(char: string) {
    switch (this.parseState) {
      case 'normal':
        if (char === '\x1b') {
          this.parseState = 'escape';
          this.escapeBuffer = '';
        } else if (char === '\r') {
          this.cursorX = 0;
        } else if (char === '\n') {
          this.lineFeed();
        } else if (char === '\b') {
          if (this.cursorX > 0) this.cursorX--;
        } else if (char === '\t') {
          // Tab to next 8-column boundary
          this.cursorX = Math.min(this.cols - 1, (Math.floor(this.cursorX / 8) + 1) * 8);
        } else if (char === '\x07') {
          // Bell - ignore
        } else if (char >= ' ') {
          this.putChar(char);
        }
        break;

      case 'escape':
        if (char === '[') {
          this.parseState = 'csi';
        } else if (char === ']') {
          this.parseState = 'osc';
        } else if (char === 'O') {
          this.parseState = 'ss3';
        } else if (char === '_') {
          this.parseState = 'apc';
        } else if (char === 'P') {
          this.parseState = 'dcs';
        } else if (char === '(' || char === ')' || char === '*' || char === '+' || char === '-' || char === '.' || char === '/') {
          this.parseState = 'charset';
        } else if (char === '7') {
          // Save cursor
          this.savedCursor = { x: this.cursorX, y: this.cursorY };
          this.parseState = 'normal';
        } else if (char === '8') {
          // Restore cursor
          this.cursorX = this.savedCursor.x;
          this.cursorY = this.savedCursor.y;
          this.parseState = 'normal';
        } else if (char === 'M') {
          // Reverse line feed
          if (this.cursorY === this.scrollTop) {
            this.scrollRegionDown(1);
          } else if (this.cursorY > 0) {
            this.cursorY--;
          }
          this.parseState = 'normal';
        } else if (char === 'D') {
          this.lineFeed();
          this.parseState = 'normal';
        } else {
          // Unknown escape, return to normal
          this.parseState = 'normal';
        }
        break;

      case 'ss3':
        if (char === 'A') {
          this.cursorY = Math.max(0, this.cursorY - 1);
        } else if (char === 'B') {
          this.cursorY = Math.min(this.rows - 1, this.cursorY + 1);
        } else if (char === 'C') {
          this.cursorX = Math.min(this.cols - 1, this.cursorX + 1);
        } else if (char === 'D') {
          this.cursorX = Math.max(0, this.cursorX - 1);
        }
        this.parseState = 'normal';
        break;

      case 'charset':
        this.parseState = 'normal';
        break;

      case 'csi':
        if (char >= '@' && char <= '~') {
          if (this.escapeBuffer.length >= MAX_CSI_SEQUENCE_CHARS) {
            this.escapeBuffer = '';
          } else {
            this.escapeBuffer += char;
            this.handleCSI(this.escapeBuffer);
          }
          this.parseState = 'normal';
        } else if (this.escapeBuffer.length >= MAX_CSI_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.parseState = 'csiDiscard';
        } else {
          this.escapeBuffer += char;
        }
        break;

      case 'csiDiscard':
        if (char >= '@' && char <= '~') {
          this.parseState = 'normal';
        }
        break;

      case 'osc':
        if (char === '\x07') {
          this.handleOSC(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'oscEscape';
        } else if (this.escapeBuffer.length >= this.oscSequenceLimit()) {
          this.escapeBuffer = '';
          this.pendingITerm2File = null;
          this.parseState = 'oscDiscard';
        } else {
          this.escapeBuffer += char;
        }
        break;

      case 'oscEscape':
        if (char === '\\') {
          this.handleOSC(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'oscEscape';
        } else if (this.escapeBuffer.length + 2 > this.oscSequenceLimit()) {
          this.escapeBuffer = '';
          this.pendingITerm2File = null;
          this.parseState = 'oscDiscard';
        } else {
          this.escapeBuffer += '\x1b' + char;
          this.parseState = 'osc';
        }
        break;

      case 'oscDiscard':
        if (char === '\x07') {
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'oscDiscardEscape';
        }
        break;

      case 'oscDiscardEscape':
        if (char === '\\') this.parseState = 'normal';
        else if (char !== '\x1b') this.parseState = 'oscDiscard';
        break;

      case 'apc':
        if (char === '\x18' || char === '\x1a') {
          this.escapeBuffer = '';
          this.pendingKittyImage = null;
          this.parseState = 'normal';
        } else if (char === '\x07') {
          this.handleAPC(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'apcEscape';
        } else if (this.escapeBuffer.length >= MAX_KITTY_APC_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.pendingKittyImage = null;
          this.parseState = 'apcDiscard';
        } else {
          this.escapeBuffer += char;
        }
        break;

      case 'dcs':
        if (char === '\x18' || char === '\x1a') {
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x07') {
          this.handleDCS(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'dcsEscape';
        } else if (this.escapeBuffer.length >= MAX_CONTROL_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.parseState = 'dcsDiscard';
        } else {
          this.escapeBuffer += char;
        }
        break;

      case 'apcEscape':
        if (char === '\x18' || char === '\x1a') {
          this.escapeBuffer = '';
          this.pendingKittyImage = null;
          this.parseState = 'normal';
        } else if (char === '\\') {
          this.handleAPC(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'apcEscape';
        } else if (this.escapeBuffer.length + 2 > MAX_KITTY_APC_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.pendingKittyImage = null;
          this.parseState = 'apcDiscard';
        } else {
          this.escapeBuffer += '\x1b' + char;
          this.parseState = 'apc';
        }
        break;

      case 'apcDiscard':
        if (char === '\x07' || char === '\x18' || char === '\x1a') {
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'apcDiscardEscape';
        }
        break;

      case 'apcDiscardEscape':
        if (char === '\\' || char === '\x18' || char === '\x1a') this.parseState = 'normal';
        else if (char !== '\x1b') this.parseState = 'apcDiscard';
        break;

      case 'dcsEscape':
        if (char === '\x18' || char === '\x1a') {
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\\') {
          this.handleDCS(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'dcsEscape';
        } else if (this.escapeBuffer.length + 2 > MAX_CONTROL_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.parseState = 'dcsDiscard';
        } else {
          this.escapeBuffer += '\x1b' + char;
          this.parseState = 'dcs';
        }
        break;

      case 'dcsDiscard':
        if (char === '\x07' || char === '\x18' || char === '\x1a') {
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'dcsDiscardEscape';
        }
        break;

      case 'dcsDiscardEscape':
        if (char === '\\' || char === '\x18' || char === '\x1a') this.parseState = 'normal';
        else if (char !== '\x1b') this.parseState = 'dcsDiscard';
        break;
    }
  }

  private handleAPC(seq: string) {
    if (!seq.startsWith('G')) return;
    this.handleKittyGraphics(seq.slice(1));
  }
  private handleDCS(seq: string) {
    const commandIndex = seq.indexOf('q');
    if (commandIndex < 0) return;
    const rawParams = seq.slice(0, commandIndex);
    if (!/^[0-9;?]*$/.test(rawParams)) return;
    const params = rawParams.replace(/^\?/, '').split(';').map((value) => Number.parseInt(value || '0', 10));
    const decoded = decodeSixel(seq.slice(commandIndex + 1), {
      maxWidth: MAX_IMAGE_PIXEL_DIMENSION,
      maxHeight: MAX_IMAGE_PIXEL_DIMENSION,
      maxPixels: MAX_IMAGE_PIXELS,
      transparentBackground: params[1] === 1,
    });
    if (!decoded || !this.canRetainImageData(decoded.data)) return;

    const placement = this.resolveImagePlacementCells(
      new Map(),
      decoded.width,
      decoded.height * decoded.pixelAspectRatio,
    );
    if (!placement) return;
    this.appendTerminalImage({
      kind: 'rgba',
      protocol: 'sixel',
      id: this.nextImageId++,
      row: this.scrollback.length + this.cursorY,
      col: this.cursorX,
      widthCells: placement.width,
      heightCells: placement.height,
      pixelWidth: decoded.width,
      pixelHeight: decoded.height,
      destinationPixelWidth: decoded.width,
      destinationPixelHeight: decoded.height * decoded.pixelAspectRatio,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      offsetX: 0,
      offsetY: 0,
      zIndex: 0,
      data: decoded.data,
    });
    this.advanceCursorRows(placement.height);
    this.markAllRowsDirty();
  }

  private handleOSC(seq: string) {
    const separatorIndex = seq.indexOf(';');
    const command = separatorIndex < 0 ? seq : seq.slice(0, separatorIndex);
    const payload = separatorIndex < 0 ? '' : seq.slice(separatorIndex + 1);
    switch (command) {
      case '0':
      case '2':
        this.handleOscTitle(payload);
        return;
      case '4':
        this.handleOscPalette(payload);
        return;
      case '7':
        this.handleOscCurrentDirectory(payload);
        return;
      case '8':
        this.handleOscHyperlink(payload);
        return;
      case '10':
      case '11':
      case '12':
        this.handleOscDynamicColor(command, payload);
        return;
      case '52':
        this.handleOscClipboard(payload);
        return;
      case '66':
        this.handleOscTextSizing(payload);
        return;
      case '104':
        this.resetOscPalette(payload);
        return;
      case '110':
      case '111':
      case '112':
        this.resetOscDynamicColor(command);
        return;
      case '133':
        this.handleOscShellIntegration(payload);
        return;
    }

    if (seq.startsWith('1337;File=')) {
      this.handleITerm2File(seq.slice('1337;File='.length));
    } else if (seq.startsWith('1337;MultipartFile=')) {
      const args = this.parseITerm2Params(seq.slice('1337;MultipartFile='.length));
      if (!args) {
        this.pendingITerm2File = null;
        return;
      }
      this.pendingITerm2File = {
        args,
        chunks: [],
        encodedLength: 0,
      };
    } else if (seq.startsWith('1337;FilePart=')) {
      const pending = this.pendingITerm2File;
      if (!pending) return;

      const chunk = seq.slice('1337;FilePart='.length);
      if (
        pending.chunks.length >= MAX_IMAGE_CHUNKS ||
        pending.encodedLength + chunk.length > MAX_IMAGE_BASE64_CHARS
      ) {
        this.pendingITerm2File = null;
        return;
      }

      pending.chunks.push(chunk);
      pending.encodedLength += chunk.length;
    } else if (seq === '1337;FileEnd') {
      const pending = this.pendingITerm2File;
      this.pendingITerm2File = null;
      if (pending) this.completeITerm2File(pending.args, pending.chunks);
    }
  }

  private handleOscTextSizing(payload: string) {
    const separatorIndex = payload.indexOf(';');
    if (separatorIndex < 0) return;

    const rawMetadata = payload.slice(0, separatorIndex);
    const text = payload.slice(separatorIndex + 1);
    if (!text || OSC_TEXT_ENCODER.encode(text).length > MAX_OSC_TEXT_BYTES) return;

    let scale = 1;
    let width = 0;
    let numerator = 0;
    let denominator = 0;
    let verticalAlign: 0 | 1 | 2 = 0;
    let horizontalAlign: 0 | 1 | 2 = 0;
    for (const item of rawMetadata.split(':')) {
      if (!item) continue;
      const match = /^([a-z])=(\d+)$/.exec(item);
      if (!match) return;
      const value = Number.parseInt(match[2], 10);
      switch (match[1]) {
        case 's':
          if (value < 1 || value > 7) return;
          scale = value;
          break;
        case 'w':
          if (value < 0 || value > 7) return;
          width = value;
          break;
        case 'n':
          if (value < 0 || value > 15) return;
          numerator = value;
          break;
        case 'd':
          if (value < 0 || value > 15) return;
          denominator = value;
          break;
        case 'v':
          if (value < 0 || value > 2) return;
          verticalAlign = value as 0 | 1 | 2;
          break;
        case 'h':
          if (value < 0 || value > 2) return;
          horizontalAlign = value as 0 | 1 | 2;
          break;
      }
    }
    if ((numerator !== 0 || denominator !== 0) && denominator <= numerator) return;

    const options = {
      scale,
      numerator,
      denominator,
      verticalAlign,
      horizontalAlign,
    };
    if (width > 0) {
      this.putTextSizingBlock(text, width, options);
      return;
    }

    for (const { segment } of OSC_TEXT_SEGMENTER.segment(text)) {
      if (OSC_TEXT_ZERO_WIDTH_GRAPHEME.test(segment)) {
        this.combineTextSizingMarkAt(this.cursorY, this.cursorX, segment);
        continue;
      }
      const width = segment.includes('\ufe0e')
        ? 1
        : segment.includes('\ufe0f') ||
            this.isWideChar(segment) ||
            OSC_TEXT_EMOJI_PRESENTATION.test(segment)
          ? 2
          : 1;
      this.putTextSizingBlock(segment, width, options);
    }
  }

  private handleOscTitle(payload: string) {
    this.oscTitle = sanitizeOscTitle(payload);
    this.onOscEvent?.({ type: 'title', value: this.oscTitle });
  }

  private handleOscCurrentDirectory(payload: string) {
    const safe = safeOscUri(payload);
    if (!safe) return;
    try {
      const uri = new URL(safe);
      if (
        uri.protocol !== 'file:' ||
        uri.username ||
        uri.password ||
        uri.port ||
        uri.search ||
        uri.hash
      ) {
        return;
      }
      this.oscCurrentDirectoryUri = uri.href;
      this.onOscEvent?.({ type: 'current-directory', uri: uri.href });
    } catch {
      return;
    }
  }

  private handleOscHyperlink(payload: string) {
    const separatorIndex = payload.indexOf(';');
    if (separatorIndex < 0) return;
    const rawParams = payload.slice(0, separatorIndex);
    const rawUri = payload.slice(separatorIndex + 1);
    if (!rawUri) {
      this.activeHyperlink = null;
      return;
    }
    const uri = safeOscUri(rawUri);
    if (!uri || rawParams.length > 512) return;

    let id: string | undefined;
    for (const field of rawParams.split(':')) {
      const equals = field.indexOf('=');
      if (equals < 0 || field.slice(0, equals) !== 'id') continue;
      const candidate = field.slice(equals + 1);
      if (!candidate || candidate.length > 256 || !safeOscUri(candidate)) return;
      id = candidate;
    }
    this.activeHyperlink = Object.freeze({ uri, ...(id ? { id } : {}) });
  }

  private parseOscPaletteIndex(value: string): number | null {
    if (!/^\d{1,3}$/.test(value)) return null;
    const index = Number.parseInt(value, 10);
    return index <= 255 ? index : null;
  }

  private handleOscPalette(payload: string) {
    const fields = payload.split(';');
    if (fields.length < 2 || fields.length % 2 !== 0) return;
    const changed = new Set<number>();
    for (let index = 0; index < fields.length; index += 2) {
      const paletteIndex = this.parseOscPaletteIndex(fields[index]);
      if (paletteIndex === null) continue;
      const color = fields[index + 1];
      if (color === '?') {
        this.onResponse?.(`\x1b]4;${paletteIndex};${formatOscColor(this.paletteColors[paletteIndex])}\x1b\\`);
        continue;
      }
      const normalized = normalizeOscColor(color);
      if (normalized && normalized !== this.paletteColors[paletteIndex]) {
        this.paletteColors[paletteIndex] = normalized;
        changed.add(paletteIndex);
      }
    }
    this.refreshOscPaletteStyles(changed);
  }

  private refreshOscPaletteStyles(changed: Set<number>) {
    if (changed.size === 0) return;
    const refreshed = new Map<TextStyle, TextStyle>();
    const refresh = (style: TextStyle, intern: boolean): TextStyle => {
      if (intern) {
        const cached = refreshed.get(style);
        if (cached) return cached;
      }
      const updateForeground = style.ansiFgIndex !== undefined && changed.has(style.ansiFgIndex);
      const updateBackground = style.ansiBgIndex !== undefined && changed.has(style.ansiBgIndex);
      const next = updateForeground || updateBackground
        ? {
            ...style,
            ...(updateForeground ? { fg: this.paletteColors[style.ansiFgIndex!] } : {}),
            ...(updateBackground ? { bg: this.paletteColors[style.ansiBgIndex!] } : {}),
          }
        : style;
      const result = intern && next !== style ? this.getInternedStyle(next) : next;
      if (intern) refreshed.set(style, result);
      return result;
    };

    this.style = refresh(this.style, false);
    for (const rows of [this.scrollback, this.buffer, this.mainScreenScrollback, this.mainScreenBuffer ?? []]) {
      for (const row of rows) {
        for (const cell of row) cell.style = refresh(cell.style, true);
      }
    }
    this.markAllRowsDirty();
  }

  private handleOscDynamicColor(command: '10' | '11' | '12', payload: string) {
    const key = command === '10' ? 'foreground' : command === '11' ? 'background' : 'cursor';
    if (payload === '?') {
      this.onResponse?.(`\x1b]${command};${formatOscColor(this.oscColors[key])}\x1b\\`);
      return;
    }
    const color = normalizeOscColor(payload);
    if (!color) return;
    this.oscColors = { ...this.oscColors, [key]: color };
    this.emitOscColors();
  }

  private resetOscPalette(payload: string) {
    const changed = new Set<number>();
    const reset = (index: number) => {
      if (this.paletteColors[index] === DEFAULT_PALETTE[index]) return;
      this.paletteColors[index] = DEFAULT_PALETTE[index];
      changed.add(index);
    };
    if (!payload) {
      for (let index = 0; index < DEFAULT_PALETTE.length; index++) reset(index);
    } else {
      for (const field of payload.split(';')) {
        const index = this.parseOscPaletteIndex(field);
        if (index !== null) reset(index);
      }
    }
    this.refreshOscPaletteStyles(changed);
  }

  private resetOscDynamicColor(command: '110' | '111' | '112') {
    const key = command === '110' ? 'foreground' : command === '111' ? 'background' : 'cursor';
    this.oscColors = { ...this.oscColors, [key]: this.oscColorDefaults[key] };
    this.emitOscColors();
  }

  private emitOscColors() {
    this.onOscEvent?.({ type: 'colors', colors: { ...this.oscColors } });
    this.markAllRowsDirty();
  }

  private handleOscClipboard(payload: string) {
    const separatorIndex = payload.indexOf(';');
    if (separatorIndex < 0 || payload.slice(0, separatorIndex) !== 'c') return;
    const encoded = payload.slice(separatorIndex + 1);
    if (
      encoded === '?' ||
      encoded.length > MAX_OSC_CLIPBOARD_BASE64_CHARS ||
      encoded.length % 4 !== 0 ||
      !STRICT_BASE64.test(encoded)
    ) {
      return;
    }

    try {
      const bytes = this.decodeBase64Chunk(encoded);
      if (bytes.length > MAX_OSC_CLIPBOARD_BYTES) return;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) return;
      this.onOscEvent?.({ type: 'clipboard', text });
    } catch {
      return;
    }
  }

  private handleOscShellIntegration(payload: string) {
    const fields = payload.split(';');
    const marker = fields[0];
    const phase = marker === 'A'
      ? 'prompt'
      : marker === 'B'
        ? 'command'
        : marker === 'C'
          ? 'output'
          : marker === 'D'
            ? 'finished'
            : null;
    if (!phase) return;

    let exitStatus = this.shellIntegration.exitStatus;
    if (marker === 'D') {
      const rawStatus = fields[1];
      exitStatus = rawStatus !== undefined && /^\d{1,3}$/.test(rawStatus)
        ? Math.min(255, Number.parseInt(rawStatus, 10))
        : null;
    }
    this.shellIntegration = {
      phase,
      row: this.scrollback.length + this.cursorY,
      col: this.cursorX,
      exitStatus,
    };
  }

  private handleITerm2File(seq: string) {
    const separatorIndex = seq.indexOf(':');
    if (separatorIndex < 0) return;

    const args = this.parseITerm2Params(seq.slice(0, separatorIndex));
    if (!args) return;
    this.completeITerm2File(args, [seq.slice(separatorIndex + 1)]);
  }

  private completeITerm2File(args: Map<string, string>, chunks: string[]) {
    if (args.get('inline') !== '1' || chunks.length === 0) return;

    const bytes = this.decodeConcatenatedBase64Bytes(chunks);
    if (!bytes) return;

    const mimeType = this.detectEncodedImageMimeType(bytes);
    if (!mimeType) return;

    const dimensions = this.resolveEncodedImageDimensions(bytes, mimeType);
    if (!dimensions || !this.isImageDimensionsAllowed(dimensions.width, dimensions.height)) return;

    const placementCells = this.resolveITerm2Placement(
      args.get('width'),
      args.get('height'),
      dimensions,
      args.get('preserveAspectRatio') !== '0',
    );
    if (!placementCells || !this.canRetainImageData(bytes)) {
      return;
    }

    const row = this.scrollback.length + this.cursorY;
    const col = this.cursorX;
    const common = {
      id: this.nextImageId++,
      protocol: 'iterm2' as const,
      row,
      col,
      widthCells: placementCells.width,
      heightCells: placementCells.height,
      pixelWidth: dimensions.width,
      destinationPixelWidth: placementCells.destinationPixelWidth,
      destinationPixelHeight: placementCells.destinationPixelHeight,
      pixelHeight: dimensions.height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      offsetX: 0,
      offsetY: 0,
      zIndex: 0,
    };
    const terminalImage: TerminalImage = mimeType === 'image/png'
      ? { ...common, kind: 'png', mimeType, data: bytes }
      : {
          ...common,
          kind: 'encoded',
          mimeType,
          data: bytes,
          animated: dimensions.animated,
          decodedFramePixels: dimensions.decodedFramePixels,
        };

    this.appendTerminalImage(terminalImage);
    if (args.get('doNotMoveCursor') !== '1') this.advanceCursorRows(placementCells.height);
    this.markAllRowsDirty();
  }

  private parseITerm2Params(rawParams: string): Map<string, string> | null {
    if (
      rawParams.length > MAX_IMAGE_METADATA_CHARS ||
      this.hasTooManyControlFields(rawParams, ';')
    ) {
      return null;
    }

    const params = new Map<string, string>();
    for (const part of rawParams.split(';')) {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) continue;
      params.set(part.slice(0, separatorIndex), part.slice(separatorIndex + 1));
    }
    return params;
  }

  private parseITerm2PixelSize(value: string | undefined, axis: 'width' | 'height'): number | null {
    if (!value || value.length === 0 || value === 'auto') return null;
    const pixelUnit = value.endsWith('px');
    const percentUnit = value.endsWith('%');
    const numberText = pixelUnit ? value.slice(0, -2) : percentUnit ? value.slice(0, -1) : value;
    const parsed = Number.parseFloat(numberText);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    if (!pixelUnit && !percentUnit) {
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x30 || code > 0x39) return null;
      }
    }
    const cellPixels = axis === 'width' ? this.cellPixelWidth : this.cellPixelHeight;
    if (pixelUnit) return parsed;
    if (percentUnit) {
      const baseCells = axis === 'width' ? this.cols : this.rows;
      return baseCells * cellPixels * parsed / 100;
    }
    return parsed * cellPixels;
  }

  private resolveITerm2Placement(
    widthValue: string | undefined,
    heightValue: string | undefined,
    dimensions: { width: number; height: number },
    preserveAspectRatio: boolean,
  ): {
    width: number;
    height: number;
    destinationPixelWidth: number;
    destinationPixelHeight: number;
  } | null {
    const requestedWidth = this.parseITerm2PixelSize(widthValue, 'width');
    const requestedHeight = this.parseITerm2PixelSize(heightValue, 'height');
    const availableWidth = Math.max(1, (this.cols - this.cursorX) * this.cellPixelWidth);
    const availableHeight = Math.max(1, this.rows * this.cellPixelHeight);
    let destinationPixelWidth: number;
    let destinationPixelHeight: number;

    if (preserveAspectRatio) {
      const boxWidth = Math.min(availableWidth, requestedWidth ?? availableWidth);
      const boxHeight = Math.min(availableHeight, requestedHeight ?? availableHeight);
      const maxScale = requestedWidth === null && requestedHeight === null
        ? 1
        : Number.POSITIVE_INFINITY;
      const scale = Math.min(
        maxScale,
        boxWidth / dimensions.width,
        boxHeight / dimensions.height,
      );
      destinationPixelWidth = dimensions.width * scale;
      destinationPixelHeight = dimensions.height * scale;
    } else {
      destinationPixelWidth = Math.min(availableWidth, requestedWidth ?? dimensions.width);
      destinationPixelHeight = Math.min(availableHeight, requestedHeight ?? dimensions.height);
    }

    if (
      !Number.isFinite(destinationPixelWidth) ||
      !Number.isFinite(destinationPixelHeight) ||
      destinationPixelWidth <= 0 ||
      destinationPixelHeight <= 0
    ) {
      return null;
    }
    return {
      width: Math.max(1, Math.ceil(destinationPixelWidth / this.cellPixelWidth)),
      height: Math.max(1, Math.ceil(destinationPixelHeight / this.cellPixelHeight)),
      destinationPixelWidth,
      destinationPixelHeight,
    };
  }


  private detectEncodedImageMimeType(data: Uint8Array): EncodedImageMimeType | null {
    if (data.length >= 8 && PNG_SIGNATURE.every((byte, index) => data[index] === byte)) return 'image/png';
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (
      data.length >= 6 &&
      data[0] === 0x47 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x38 &&
      (data[4] === 0x37 || data[4] === 0x39) &&
      data[5] === 0x61
    ) {
      return 'image/gif';
    }
    if (
      data.length >= 12 &&
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46 &&
      data[8] === 0x57 &&
      data[9] === 0x45 &&
      data[10] === 0x42 &&
      data[11] === 0x50
    ) {
      return 'image/webp';
    }
    return null;
  }

  private resolveEncodedImageDimensions(
    data: Uint8Array,
    mimeType: EncodedImageMimeType,
  ): EncodedImageDimensions | null {
    if (mimeType === 'image/gif') return this.parseGifDimensions(data);
    if (mimeType === 'image/webp') return this.parseWebpDimensions(data);
    const dimensions = mimeType === 'image/png'
      ? this.parsePngDimensions(data)
      : this.parseJpegDimensions(data);
    return dimensions
      ? { ...dimensions, animated: false, decodedFramePixels: dimensions.width * dimensions.height }
      : null;
  }
  private parseJpegDimensions(data: Uint8Array): { width: number; height: number } | null {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;

    let offset = 2;
    while (offset + 3 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }

      while (offset < data.length && data[offset] === 0xff) offset++;
      if (offset >= data.length) return null;

      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= data.length) return null;

      const length = this.readUint16(data, offset);
      if (length < 2 || offset + length > data.length) return null;

      if (this.isJpegStartOfFrame(marker)) {
        if (length < 7) return null;
        const height = this.readUint16(data, offset + 3);
        const width = this.readUint16(data, offset + 5);
        if (width <= 0 || height <= 0) return null;
        return { width, height };
      }

      offset += length;
    }
    return null;
  }

  private isJpegStartOfFrame(marker: number): boolean {
    return (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    );
  }

  private parseGifDimensions(data: Uint8Array): EncodedImageDimensions | null {
    if (data.length < 14) return null;

    const width = this.readLittleEndianUint16(data, 6);
    const height = this.readLittleEndianUint16(data, 8);
    if (width <= 0 || height <= 0) return null;

    let offset = 13;
    if ((data[10] & 0x80) !== 0) {
      offset += 3 * (1 << ((data[10] & 0x07) + 1));
    }
    if (offset > data.length) return null;

    let frameCount = 0;
    let decodedFramePixels = 0;
    while (offset < data.length) {
      const blockType = data[offset++];
      if (blockType === 0x3b) {
        return frameCount > 0
          ? {
              width,
              height,
              animated: frameCount > 1,
              decodedFramePixels: Math.max(width * height, decodedFramePixels),
            }
          : null;
      }

      if (blockType === 0x21) {
        if (offset >= data.length) return null;
        offset++;
        const nextOffset = this.skipGifSubBlocks(data, offset);
        if (nextOffset === null) return null;
        offset = nextOffset;
        continue;
      }

      if (blockType !== 0x2c || offset + 9 > data.length) return null;
      const left = this.readLittleEndianUint16(data, offset);
      const top = this.readLittleEndianUint16(data, offset + 2);
      const frameWidth = this.readLittleEndianUint16(data, offset + 4);
      const frameHeight = this.readLittleEndianUint16(data, offset + 6);
      const packedFields = data[offset + 8];
      if (
        frameWidth <= 0 ||
        frameHeight <= 0 ||
        left + frameWidth > width ||
        top + frameHeight > height
      ) {
        return null;
      }
      frameCount++;
      decodedFramePixels += frameWidth * frameHeight;
      if (frameCount > MAX_ANIMATED_IMAGE_FRAMES || decodedFramePixels > MAX_TOTAL_IMAGE_PIXELS) return null;

      offset += 9;
      if ((packedFields & 0x80) !== 0) {
        offset += 3 * (1 << ((packedFields & 0x07) + 1));
      }
      if (offset >= data.length) return null;

      offset++;
      const nextOffset = this.skipGifSubBlocks(data, offset);
      if (nextOffset === null) return null;
      offset = nextOffset;
    }

    return null;
  }

  private skipGifSubBlocks(data: Uint8Array, startOffset: number): number | null {
    let offset = startOffset;
    while (offset < data.length) {
      const blockLength = data[offset++];
      if (blockLength === 0) return offset;
      if (offset + blockLength > data.length) return null;
      offset += blockLength;
    }
    return null;
  }

  private parseWebpDimensions(data: Uint8Array): EncodedImageDimensions | null {
    if (data.length < 25) return null;

    const chunkType = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (chunkType === 'VP8X') {
      if (data.length < 30) return null;
      const width = 1 + this.readLittleEndianUint24(data, 24);
      const height = 1 + this.readLittleEndianUint24(data, 27);
      const animated = (data[20] & 0x02) !== 0;
      if (!animated) {
        return { width, height, animated: false, decodedFramePixels: width * height };
      }

      let offset = 12;
      let frameCount = 0;
      let decodedFramePixels = 0;
      while (offset + 8 <= data.length) {
        const type = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
        const chunkLength = this.readLittleEndianUint32(data, offset + 4);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkLength;
        if (chunkEnd > data.length) return null;
        if (type === 'ANMF') {
          if (chunkLength < 16) return null;
          const frameX = this.readLittleEndianUint24(data, chunkStart) * 2;
          const frameY = this.readLittleEndianUint24(data, chunkStart + 3) * 2;
          const frameWidth = 1 + this.readLittleEndianUint24(data, chunkStart + 6);
          const frameHeight = 1 + this.readLittleEndianUint24(data, chunkStart + 9);
          if (frameX + frameWidth > width || frameY + frameHeight > height) return null;
          frameCount++;
          decodedFramePixels += frameWidth * frameHeight;
          if (frameCount > MAX_ANIMATED_IMAGE_FRAMES || decodedFramePixels > MAX_TOTAL_IMAGE_PIXELS) return null;
        }
        offset = chunkEnd + (chunkLength & 1);
      }
      return frameCount > 0
        ? {
            width,
            height,
            animated: true,
            decodedFramePixels: Math.max(width * height, decodedFramePixels),
          }
        : null;
    }

    if (chunkType === 'VP8L') {
      if (data[20] !== 0x2f) return null;
      const width = 1 + data[21] + ((data[22] & 0x3f) << 8);
      const height = 1 + ((data[22] & 0xc0) >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10);
      return { width, height, animated: false, decodedFramePixels: width * height };
    }

    if (
      chunkType === 'VP8 ' &&
      data.length >= 30 &&
      data[23] === 0x9d &&
      data[24] === 0x01 &&
      data[25] === 0x2a
    ) {
      const width = (data[26] + (data[27] << 8)) & 0x3fff;
      const height = (data[28] + (data[29] << 8)) & 0x3fff;
      return { width, height, animated: false, decodedFramePixels: width * height };
    }

    return null;
  }

  private readLittleEndianUint16(data: Uint8Array, offset: number): number {
    return data[offset] + (data[offset + 1] << 8);
  }

  private readLittleEndianUint24(data: Uint8Array, offset: number): number {
    return data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16);
  }

  private readLittleEndianUint32(data: Uint8Array, offset: number): number {
    return data[offset] +
      data[offset + 1] * 0x100 +
      data[offset + 2] * 0x10000 +
      data[offset + 3] * 0x1000000;
  }
  private readUint16(data: Uint8Array, offset: number): number {
    return (data[offset] << 8) + data[offset + 1];
  }

  private handleKittyGraphics(seq: string) {
    this.imageCachePrunePending = true;
    const separatorIndex = seq.indexOf(';');
    const rawParams = separatorIndex >= 0 ? seq.slice(0, separatorIndex) : seq;
    const payload = separatorIndex >= 0 ? seq.slice(separatorIndex + 1) : '';
    const params = this.parseKittyParams(rawParams);
    if (!params) {
      this.pendingKittyImage = null;
      return;
    }
    if (payload.length > MAX_KITTY_CHUNK_BASE64_CHARS) {
      this.pendingKittyImage = null;
      this.sendKittyResponse(params, false, 'ENOSPC:image chunk too large', null, true);
      return;
    }

    const action = params.get('a') ?? 't';
    if (action === 'd') {
      this.pendingKittyImage = null;
      this.handleKittyDelete(params);
      return;
    }
    if (action === 'p') {
      this.pendingKittyImage = null;
      this.placeStoredKittyImage(params);
      return;
    }
    if (action === 'a' || action === 'c') {
      this.pendingKittyImage = null;
      this.handleKittyAnimationControl(params);
      return;
    }
    if (!['t', 'T', 'q', 'f'].includes(action)) {
      this.pendingKittyImage = null;
      this.sendKittyResponse(params, false, 'EINVAL:unsupported action', null, true);
      return;
    }

    const startsTransfer = params.has('a') || params.has('f') || params.has('s') || params.has('v') || params.has('t');
    if (startsTransfer) {
      this.pendingKittyImage = {
        row: this.scrollback.length + this.cursorY,
        col: this.cursorX,
        params,
        chunks: [],
        encodedLength: 0,
      };
    } else if (this.pendingKittyImage) {
      for (const [key, value] of params) {
        this.pendingKittyImage.params.set(key, value);
      }
    }

    const pending = this.pendingKittyImage;
    if (!pending) {
      this.sendKittyResponse(params, false, 'EINVAL:missing transfer', null, true);
      return;
    }
    if (payload.length > 0) {
      if (
        pending.chunks.length >= MAX_IMAGE_CHUNKS ||
        pending.encodedLength + payload.length > MAX_IMAGE_BASE64_CHARS
      ) {
        this.pendingKittyImage = null;
        this.sendKittyResponse(pending.params, false, 'ENOSPC:image payload too large', null, true);
        return;
      }
      pending.chunks.push(payload);
      pending.encodedLength += payload.length;
    }

    if (params.get('m') !== '1') this.completeKittyImage();
  }

  private parseKittyParams(rawParams: string): Map<string, string> | null {
    if (
      rawParams.length > MAX_IMAGE_METADATA_CHARS ||
      this.hasTooManyControlFields(rawParams, ',')
    ) {
      return null;
    }

    const params = new Map<string, string>();
    for (const part of rawParams.split(',')) {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) continue;
      params.set(part.slice(0, separatorIndex), part.slice(separatorIndex + 1));
    }
    return params;
  }

  private completeKittyImage() {
    const transfer = this.pendingKittyImage;
    this.pendingKittyImage = null;
    if (!transfer) return;

    const params = transfer.params;
    const action = params.get('a') ?? 't';
    const identity = this.resolveKittyImageIdentity(params, action === 't' || action === 'T' || action === 'q');
    if (!identity.ok) {
      this.sendKittyResponse(params, false, identity.error, null, true);
      return;
    }

    const medium = params.get('t') ?? 'd';
    if (medium !== 'd') {
      this.sendKittyResponse(params, false, 'ENOTSUP:transmission medium is not available over SSH', identity.imageId, true);
      return;
    }
    if (transfer.chunks.length === 0) {
      this.sendKittyResponse(params, false, 'EINVAL:missing image data', identity.imageId, true);
      return;
    }

    const decoded = this.decodeKittyImageData(params, transfer.chunks);
    if (!decoded.ok) {
      this.sendKittyResponse(params, false, decoded.error, identity.imageId, true);
      return;
    }
    const imageData = decoded.data;
    imageData.imageNumber = identity.imageNumber ?? undefined;

    if (action === 'q') {
      this.sendKittyResponse(params, true, 'OK', identity.imageId, true);
      return;
    }
    if (action === 'f') {
      this.addKittyAnimationFrame(params, identity.imageId, imageData);
      return;
    }
    if (!this.canRetainImageData(imageData.data, identity.imageId)) {
      this.sendKittyResponse(params, false, 'ENOSPC:image storage limit exceeded', identity.imageId, true);
      return;
    }

    const imageId = identity.imageId;
    if (imageId !== null) {
      this.removeAllKittyPlacementsForImage(imageId);
      this.kittyImageData.delete(imageId);
      this.storeKittyImageData(imageId, imageData);
      if (identity.imageNumber !== null) this.kittyImageNumbers.set(identity.imageNumber, imageId);
    }

    if (action === 'T') {
      const placed = this.addKittyPlacement(transfer.row, transfer.col, params, imageData, imageId);
      if (!placed.ok) {
        this.sendKittyResponse(params, false, placed.error, imageId, true);
        return;
      }
    }
    this.sendKittyResponse(params, true, 'OK', imageId);
  }

  private decodeKittyImageData(
    params: Map<string, string>,
    chunks: string[],
  ): { ok: true; data: KittyImageData } | { ok: false; error: string } {
    const decodedBytes = this.decodeIndependentBase64Bytes(chunks);
    if (!decodedBytes) return { ok: false, error: 'EINVAL:invalid base64 data' };
    let bytes: Uint8Array = decodedBytes;

    const compression = params.get('o');
    if (compression && compression !== 'z') {
      return { ok: false, error: 'ENOTSUP:unsupported compression' };
    }
    if (compression === 'z') {
      const decompressed = unzlibBounded(bytes);
      if (!decompressed.ok) return decompressed;
      bytes = decompressed.data;
    }

    const format = Number.parseInt(params.get('f') ?? '32', 10);
    if (format === 24 || format === 32) {
      const pixelWidth = this.parseKittyUint(params.get('s'));
      const pixelHeight = this.parseKittyUint(params.get('v'));
      if (pixelWidth === null || pixelHeight === null || !this.isImageDimensionsAllowed(pixelWidth, pixelHeight)) {
        return { ok: false, error: 'EINVAL:invalid image dimensions' };
      }
      const bytesPerPixel = format === 24 ? 3 : 4;
      const expectedLength = pixelWidth * pixelHeight * bytesPerPixel;
      if (bytes.length !== expectedLength) return { ok: false, error: 'EINVAL:unexpected pixel data size' };

      const data = format === 32
        ? new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
      if (format === 24) {
        for (let src = 0, dst = 0; src < bytes.length; src += 3, dst += 4) {
          data[dst] = bytes[src];
          data[dst + 1] = bytes[src + 1];
          data[dst + 2] = bytes[src + 2];
          data[dst + 3] = 0xff;
        }
      }
      return { ok: true, data: { kind: 'rgba', pixelWidth, pixelHeight, data } };
    }

    if (format === 100) {
      const dimensions = this.parsePngDimensions(bytes);
      if (!dimensions || !this.isImageDimensionsAllowed(dimensions.width, dimensions.height)) {
        return { ok: false, error: 'EINVAL:invalid PNG data' };
      }
      return {
        ok: true,
        data: {
          kind: 'png',
          pixelWidth: dimensions.width,
          pixelHeight: dimensions.height,
          mimeType: 'image/png',
          data: bytes,
        },
      };
    }
    return { ok: false, error: 'ENOTSUP:unsupported image format' };
  }

  private resolveKittyImageIdentity(
    params: Map<string, string>,
    allocateImageNumber: boolean,
  ):
    | { ok: true; imageId: number | null; imageNumber: number | null }
    | { ok: false; error: string } {
    const imageId = this.parseKittyUint(params.get('i'));
    const imageNumber = this.parseKittyUint(params.get('I'));
    if (params.has('i') && imageId === null) return { ok: false, error: 'EINVAL:invalid image id' };
    if (params.has('I') && imageNumber === null) return { ok: false, error: 'EINVAL:invalid image number' };
    if (imageId !== null && imageNumber !== null) return { ok: false, error: 'EINVAL:i and I are mutually exclusive' };
    if (imageId !== null) return { ok: true, imageId, imageNumber: null };
    if (imageNumber === null) return { ok: true, imageId: null, imageNumber: null };

    if (!allocateImageNumber) {
      return { ok: true, imageId: this.kittyImageNumbers.get(imageNumber) ?? null, imageNumber };
    }
    let allocatedId = this.nextKittyImageId;
    while (this.kittyImageData.has(allocatedId)) {
      allocatedId = allocatedId === 0xffffffff ? 1 : allocatedId + 1;
      if (allocatedId === this.nextKittyImageId) return { ok: false, error: 'ENOSPC:no image ids available' };
    }
    this.nextKittyImageId = allocatedId === 0xffffffff ? 1 : allocatedId + 1;
    return { ok: true, imageId: allocatedId, imageNumber };
  }

  private placeStoredKittyImage(params: Map<string, string>) {
    const identity = this.resolveKittyImageIdentity(params, false);
    if (!identity.ok) {
      this.sendKittyResponse(params, false, identity.error, null, true);
      return;
    }
    if (identity.imageId === null) {
      this.sendKittyResponse(params, false, 'ENOENT:image not found', null, true);
      return;
    }
    const imageData = this.kittyImageData.get(identity.imageId);
    if (!imageData) {
      this.sendKittyResponse(params, false, 'ENOENT:image not found', identity.imageId, true);
      return;
    }
    const placed = this.addKittyPlacement(
      this.scrollback.length + this.cursorY,
      this.cursorX,
      params,
      imageData,
      identity.imageId,
    );
    this.sendKittyResponse(params, placed.ok, placed.ok ? 'OK' : placed.error, identity.imageId, true);
  }

  private storeKittyImageData(imageId: number, imageData: KittyImageData) {
    this.kittyImageData.delete(imageId);
    this.kittyImageData.set(imageId, imageData);
    while (this.kittyImageData.size > MAX_KITTY_IMAGE_DATA) {
      const oldestId = this.kittyImageData.keys().next().value as number | undefined;
      if (oldestId === undefined) return;
      this.freeKittyImageData(oldestId);
    }
  }

  private freeKittyImageData(imageId: number) {
    this.kittyImageData.delete(imageId);
    for (const [imageNumber, mappedId] of this.kittyImageNumbers) {
      if (mappedId === imageId) this.kittyImageNumbers.delete(imageNumber);
    }
  }
  private hasKittyImageReference(imageId: number): boolean {
    if (
      this.images.some((image) => image.protocol === 'kitty' && image.imageId === imageId) ||
      this.mainScreenImages.some((image) => image.protocol === 'kitty' && image.imageId === imageId)
    ) {
      return true;
    }
    for (const placement of this.kittyVirtualPlacements.values()) {
      if (placement.imageId === imageId) return true;
    }
    for (const placement of this.kittyRelativePlacements.values()) {
      if (placement.imageId === imageId) return true;
    }
    for (const placement of this.mainScreenKittyVirtualPlacements.values()) {
      if (placement.imageId === imageId) return true;
    }
    for (const placement of this.mainScreenKittyRelativePlacements.values()) {
      if (placement.imageId === imageId) return true;
    }
    return false;
  }

  private kittyImageCacheId(imageData: KittyImageData): number {
    const existing = this.kittyImageCacheIds.get(imageData);
    if (existing !== undefined) return existing;
    const cacheId = this.nextImageId++;
    this.kittyImageCacheIds.set(imageData, cacheId);
    return cacheId;
  }
  consumeImageCachePruneRequest(): ReadonlySet<number> | null {
    if (!this.imageCachePrunePending) return null;
    this.imageCachePrunePending = false;
    const retainedCacheIds = new Set<number>();
    const placedKittyImageIds = new Set<number>();
    const collectRenderedImage = (image: TerminalImage) => {
      retainedCacheIds.add(image.dataId ?? image.id);
      if (image.protocol === 'kitty' && image.imageId !== undefined) {
        placedKittyImageIds.add(image.imageId);
      }
    };
    for (const image of this.images) collectRenderedImage(image);
    for (const image of this.mainScreenImages) collectRenderedImage(image);
    const collectStoredPlacements = (placements: Iterable<{ imageId: number }>) => {
      for (const placement of placements) placedKittyImageIds.add(placement.imageId);
    };
    collectStoredPlacements(this.kittyVirtualPlacements.values());
    collectStoredPlacements(this.kittyRelativePlacements.values());
    collectStoredPlacements(this.mainScreenKittyVirtualPlacements.values());
    collectStoredPlacements(this.mainScreenKittyRelativePlacements.values());
    for (const imageId of placedKittyImageIds) {
      const imageData = this.kittyImageData.get(imageId);
      if (!imageData) continue;
      const rootCacheId = this.kittyImageCacheIds.get(imageData);
      if (rootCacheId !== undefined) retainedCacheIds.add(rootCacheId);
      for (const frame of imageData.animation?.frames ?? []) {
        const frameCacheId = this.kittyImageCacheIds.get(frame.data);
        if (frameCacheId !== undefined) retainedCacheIds.add(frameCacheId);
      }
    }
    return retainedCacheIds;
  }


  private addKittyPlacement(
    row: number,
    col: number,
    params: Map<string, string>,
    imageData: KittyImageData,
    imageId: number | null,
  ): { ok: true } | { ok: false; error: string } {
    const source = this.resolveKittySourceRect(params, imageData.pixelWidth, imageData.pixelHeight);
    if (!source) return { ok: false, error: 'EINVAL:invalid source rectangle' };

    const placementId = this.parseKittyUint(params.get('p'));
    const parentImageId = this.parseKittyUint(params.get('P'));
    const parentPlacementId = this.parseKittyUint(params.get('Q'));
    const placementCells = this.resolveImagePlacementCells(
      params,
      source.width,
      source.height,
      col,
      false,
    );
    if (!placementCells) return { ok: false, error: 'EINVAL:invalid placement size' };
    const offsetX = this.parseNonNegativeInteger(params.get('X')) ?? 0;
    const offsetY = this.parseNonNegativeInteger(params.get('Y')) ?? 0;
    const horizontalOffset = this.parseKittyInt32(params.get('H')) ?? 0;
    const verticalOffset = this.parseKittyInt32(params.get('V')) ?? 0;
    const zIndex = this.parseKittyInt32(params.get('z')) ?? 0;
    if (
      (params.has('p') && placementId === null) ||
      (params.has('P') && parentImageId === null) ||
      (params.has('Q') && parentPlacementId === null) ||
      (params.has('X') && this.parseNonNegativeInteger(params.get('X')) === null) ||
      (params.has('Y') && this.parseNonNegativeInteger(params.get('Y')) === null) ||
      (params.has('H') && this.parseKittyInt32(params.get('H')) === null) ||
      (params.has('V') && this.parseKittyInt32(params.get('V')) === null) ||
      (params.has('z') && this.parseKittyInt32(params.get('z')) === null)
    ) {
      return { ok: false, error: 'EINVAL:invalid placement parameters' };
    }
    if (offsetX >= this.cellPixelWidth || offsetY >= this.cellPixelHeight) {
      return { ok: false, error: 'EINVAL:cell offset exceeds cell size' };
    }

    const imageNumber = imageData.imageNumber;
    const virtual = params.get('U') === '1';
    if (virtual) {
      if (parentImageId !== null) return { ok: false, error: 'EINVAL:virtual placement cannot be relative' };
      if (imageId === null) return { ok: false, error: 'EINVAL:virtual placement requires an image id' };
      const key = this.kittyVirtualPlacementKey(imageId, placementId);
      const replacesDetachedPlacement =
        this.kittyVirtualPlacements.has(key) || this.kittyRelativePlacements.has(key);
      if (
        !replacesDetachedPlacement &&
        this.kittyVirtualPlacements.size + this.kittyRelativePlacements.size >= MAX_KITTY_DETACHED_PLACEMENTS
      ) {
        return { ok: false, error: 'ENOSPC:image placement limit exceeded' };
      }
      this.kittyRelativePlacements.delete(key);
      this.removeKittyPlacements((placement) =>
        placement.protocol === 'kitty' && placement.imageId === imageId && placement.placementId === (placementId ?? undefined));
      this.kittyVirtualPlacements.set(key, {
        imageId,
        imageNumber,
        placementId: placementId ?? undefined,
        columns: placementCells.width,
        rows: placementCells.height,
        zIndex,
      });
      return { ok: true };
    }

    if (parentImageId !== null) {
      if (imageId === null || placementId === null) {
        return { ok: false, error: 'EINVAL:relative placement requires image and placement ids' };
      }
      const childKey = this.kittyVirtualPlacementKey(imageId, placementId);
      let ancestorKey = this.kittyVirtualPlacementKey(parentImageId, parentPlacementId);
      if (!this.hasKittyPlacement(parentImageId, parentPlacementId)) {
        return { ok: false, error: 'ENOPARENT:parent placement not found' };
      }
      let depth = 1;
      while (true) {
        if (ancestorKey === childKey) return { ok: false, error: 'ECYCLE:relative placement cycle' };
        const ancestor = this.kittyRelativePlacements.get(ancestorKey);
        if (!ancestor) break;
        depth++;
        if (depth > 8) return { ok: false, error: 'ETOODEEP:relative placement chain too deep' };
        ancestorKey = this.kittyVirtualPlacementKey(ancestor.parentImageId, ancestor.parentPlacementId ?? null);
      }
      const replacesDetachedPlacement =
        this.kittyVirtualPlacements.has(childKey) || this.kittyRelativePlacements.has(childKey);
      if (
        !replacesDetachedPlacement &&
        this.kittyVirtualPlacements.size + this.kittyRelativePlacements.size >= MAX_KITTY_DETACHED_PLACEMENTS
      ) {
        return { ok: false, error: 'ENOSPC:image placement limit exceeded' };
      }
      this.removeKittyPlacements((placement) =>
        placement.protocol === 'kitty' && placement.imageId === imageId && placement.placementId === placementId);
      this.kittyVirtualPlacements.delete(childKey);
      this.kittyRelativePlacements.set(childKey, {
        id: this.nextImageId++,
        imageId,
        imageNumber,
        placementId,
        parentImageId,
        parentPlacementId: parentPlacementId ?? undefined,
        horizontalOffset,
        verticalOffset,
        widthCells: placementCells.width,
        heightCells: placementCells.height,
        sourceX: source.x,
        sourceY: source.y,
        sourceWidth: source.width,
        sourceHeight: source.height,
        offsetX,
        offsetY,
        zIndex,
      });
      this.markAllRowsDirty();
      return { ok: true };
    }

    if (imageId !== null && placementId !== null) {
      const key = this.kittyVirtualPlacementKey(imageId, placementId);
      this.kittyVirtualPlacements.delete(key);
      this.kittyRelativePlacements.delete(key);
      this.removeKittyPlacements(
        (placement) =>
          placement.protocol === 'kitty' &&
          placement.imageId === imageId &&
          placement.placementId === placementId,
      );
    }
    const common = {
      id: this.nextImageId++,
      protocol: 'kitty' as const,
      dataId: this.kittyImageCacheId(imageData),
      imageId: imageId ?? undefined,
      imageNumber,
      placementId: placementId ?? undefined,
      row,
      col,
      widthCells: placementCells.width,
      heightCells: placementCells.height,
      pixelWidth: imageData.pixelWidth,
      pixelHeight: imageData.pixelHeight,
      sourceX: source.x,
      sourceY: source.y,
      sourceWidth: source.width,
      sourceHeight: source.height,
      offsetX,
      offsetY,
      zIndex,
    };
    const terminalImage: TerminalImage = imageData.kind === 'png'
      ? { ...common, kind: 'png', mimeType: imageData.mimeType, data: imageData.data }
      : { ...common, kind: 'rgba', data: imageData.data };

    this.appendTerminalImage(terminalImage);
    if (params.get('C') !== '1') {
      this.advanceCursorAfterKittyPlacement(col, placementCells.width, placementCells.height);
    }
    this.markAllRowsDirty();
    return { ok: true };
  }

  private hasKittyPlacement(imageId: number, placementId: number | null): boolean {
    const key = this.kittyVirtualPlacementKey(imageId, placementId);
    if (this.kittyVirtualPlacements.has(key) || this.kittyRelativePlacements.has(key)) return true;
    return this.images.some((placement) =>
      placement.protocol === 'kitty' &&
      placement.imageId === imageId &&
      placement.placementId === (placementId ?? undefined));
  }

  private resolveKittySourceRect(
    params: Map<string, string>,
    pixelWidth: number,
    pixelHeight: number,
  ): { x: number; y: number; width: number; height: number } | null {
    const x = this.parseNonNegativeInteger(params.get('x')) ?? 0;
    const y = this.parseNonNegativeInteger(params.get('y')) ?? 0;
    if (x >= pixelWidth || y >= pixelHeight) return null;
    const requestedWidth = this.parseKittyUint(params.get('w')) ?? pixelWidth - x;
    const requestedHeight = this.parseKittyUint(params.get('h')) ?? pixelHeight - y;
    const width = Math.min(requestedWidth, pixelWidth - x);
    const height = Math.min(requestedHeight, pixelHeight - y);
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  }

  private handleKittyDelete(params: Map<string, string>) {
    const selector = params.get('d') ?? 'a';
    const freeData = selector === selector.toUpperCase();
    const normalized = selector.toLowerCase();
    const placementId = this.parseKittyUint(params.get('p'));
    const identity = this.resolveKittyImageIdentity(params, false);
    if (!identity.ok) {
      this.sendKittyResponse(params, false, identity.error, null, true);
      return;
    }

    const cursorRow = this.scrollback.length + this.cursorY;
    const cursorCol = this.cursorX;
    const x = this.parseKittyUint(params.get('x'));
    const y = this.parseKittyUint(params.get('y'));
    const cellRow = y === null ? null : this.scrollback.length + y - 1;
    const cellCol = x === null ? null : x - 1;
    const zIndex = this.parseKittyInt32(params.get('z'));
    const affectedImageIds = new Set<number>();
    const matches = (image: TerminalImage) => {
      if (image.protocol !== 'kitty') return false;
      let matched = false;
      if (normalized === 'a') {
        const viewportTop = this.scrollback.length;
        matched = image.row < viewportTop + this.rows && image.row + image.heightCells > viewportTop;
      } else if (normalized === 'i') {
        matched = identity.imageId !== null && image.imageId === identity.imageId &&
          (placementId === null || image.placementId === placementId);
      } else if (normalized === 'n') {
        matched = identity.imageNumber !== null && image.imageNumber === identity.imageNumber &&
          (placementId === null || image.placementId === placementId);
      } else if (normalized === 'c') {
        matched = this.imageIntersectsCell(image, cursorRow, cursorCol);
      } else if (normalized === 'p') {
        matched = cellRow !== null && cellCol !== null && this.imageIntersectsCell(image, cellRow, cellCol);
      } else if (normalized === 'q') {
        matched = cellRow !== null && cellCol !== null && zIndex !== null && image.zIndex === zIndex &&
          this.imageIntersectsCell(image, cellRow, cellCol);
      } else if (normalized === 'r') {
        matched = x !== null && y !== null && image.imageId !== undefined && image.imageId >= x && image.imageId <= y;
      } else if (normalized === 'x') {
        matched = cellCol !== null && cellCol >= image.col && cellCol < image.col + image.widthCells;
      } else if (normalized === 'y') {
        matched = cellRow !== null && cellRow >= image.row && cellRow < image.row + image.heightCells;
      } else if (normalized === 'z') {
        matched = zIndex !== null && image.zIndex === zIndex;
      }
      if (matched && image.imageId !== undefined) affectedImageIds.add(image.imageId);
      return matched;
    };

    if (!['a', 'i', 'n', 'c', 'p', 'q', 'r', 'x', 'y', 'z', 'f'].includes(normalized)) {
      this.sendKittyResponse(params, false, 'EINVAL:unsupported delete selector', identity.imageId, true);
      return;
    }
    if (normalized === 'f') {
      this.deleteKittyAnimationFrames(identity.imageId, params);
      return;
    }
    const globalByIdentity = normalized === 'i' || normalized === 'n' || normalized === 'r';
    const matchesStoredPlacement = (placement: {
      imageId: number;
      imageNumber?: number;
      placementId?: number;
    }) => normalized === 'i'
      ? identity.imageId !== null && placement.imageId === identity.imageId &&
        (placementId === null || placement.placementId === placementId)
      : normalized === 'n'
        ? identity.imageNumber !== null && placement.imageNumber === identity.imageNumber &&
          (placementId === null || placement.placementId === placementId)
        : normalized === 'r' && x !== null && y !== null &&
          placement.imageId >= x && placement.imageId <= y;
    const removedParentKeys = this.images
      .filter(matches)
      .filter((image) => image.imageId !== undefined)
      .map((image) => this.kittyVirtualPlacementKey(image.imageId!, image.placementId ?? null));
    if (!globalByIdentity && this.kittyVirtualPlacements.size > 0) {
      const renderedPlacements = this.getImages();
      for (const [key, virtual] of this.kittyVirtualPlacements) {
        const matched = renderedPlacements.some((image) =>
          image.protocol === 'kitty' &&
          image.imageId === virtual.imageId &&
          (image.placementId === virtual.placementId || image.placementId === undefined) &&
          matches(image));
        if (!matched) continue;
        affectedImageIds.add(virtual.imageId);
        removedParentKeys.push(key);
        this.kittyVirtualPlacements.delete(key);
      }
    }
    const savedRemovedParentKeys = globalByIdentity
      ? this.mainScreenImages
        .filter(matches)
        .filter((image) => image.imageId !== undefined)
        .map((image) => this.kittyVirtualPlacementKey(image.imageId!, image.placementId ?? null))
      : [];
    this.removeKittyPlacements(matches, globalByIdentity);

    const relativeRenderIds = new Set(
      [...this.kittyRelativePlacements.values()].map((relative) => relative.id),
    );
    const relativeRenderImages = new Map(
      this.getImages()
        .filter((image) => relativeRenderIds.has(image.id))
        .map((image) => [image.id, image]),
    );
    for (const [key, relative] of this.kittyRelativePlacements) {
      const rendered = relativeRenderImages.get(relative.id);
      const matched = globalByIdentity
        ? matchesStoredPlacement(relative)
        : rendered ? matches(rendered) : false;
      if (matched) {
        affectedImageIds.add(relative.imageId);
        removedParentKeys.push(key);
      }
    }

    if (globalByIdentity) {
      for (const [key, virtual] of this.kittyVirtualPlacements) {
        if (!matchesStoredPlacement(virtual)) continue;
        affectedImageIds.add(virtual.imageId);
        removedParentKeys.push(key);
        this.kittyVirtualPlacements.delete(key);
      }
      for (const [key, relative] of this.mainScreenKittyRelativePlacements) {
        if (!matchesStoredPlacement(relative)) continue;
        affectedImageIds.add(relative.imageId);
        savedRemovedParentKeys.push(key);
      }
      for (const [key, virtual] of this.mainScreenKittyVirtualPlacements) {
        if (!matchesStoredPlacement(virtual)) continue;
        affectedImageIds.add(virtual.imageId);
        savedRemovedParentKeys.push(key);
        this.mainScreenKittyVirtualPlacements.delete(key);
      }
    }
    this.deleteKittyRelativePlacementGroups(removedParentKeys, affectedImageIds);
    this.deleteKittyRelativePlacementGroups(
      savedRemovedParentKeys,
      affectedImageIds,
      this.mainScreenKittyRelativePlacements,
    );
    if (freeData) {
      if (identity.imageId !== null) affectedImageIds.add(identity.imageId);
      for (const imageId of affectedImageIds) {
        if (!this.hasKittyImageReference(imageId)) this.freeKittyImageData(imageId);
      }
    }
    this.markAllRowsDirty();
    this.sendKittyResponse(params, true, 'OK', identity.imageId);
  }

  private deleteKittyRelativePlacementGroups(
    parentKeys: string[],
    affectedImageIds: Set<number>,
    placements: Map<string, KittyRelativePlacement> = this.kittyRelativePlacements,
  ) {
    const queue = [...new Set(parentKeys)];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const parentKey = queue.shift()!;
      if (visited.has(parentKey)) continue;
      visited.add(parentKey);
      const parentRelative = placements.get(parentKey);
      if (parentRelative) {
        affectedImageIds.add(parentRelative.imageId);
        placements.delete(parentKey);
      }
      for (const [key, relative] of placements) {
        const relativeParentKey = this.kittyVirtualPlacementKey(
          relative.parentImageId,
          relative.parentPlacementId ?? null,
        );
        if (relativeParentKey === parentKey) queue.push(key);
      }
    }
  }

  private removeAllKittyPlacementsForImage(imageId: number) {
    const currentParentKeys = this.images
      .filter((image) => image.protocol === 'kitty' && image.imageId === imageId)
      .map((image) => this.kittyVirtualPlacementKey(imageId, image.placementId ?? null));
    const savedParentKeys = this.mainScreenImages
      .filter((image) => image.protocol === 'kitty' && image.imageId === imageId)
      .map((image) => this.kittyVirtualPlacementKey(imageId, image.placementId ?? null));
    const collectStoredPlacements = (
      virtualPlacements: Map<string, KittyVirtualPlacement>,
      relativePlacements: Map<string, KittyRelativePlacement>,
      parentKeys: string[],
    ) => {
      for (const [key, placement] of virtualPlacements) {
        if (placement.imageId !== imageId) continue;
        parentKeys.push(key);
        virtualPlacements.delete(key);
      }
      for (const [key, placement] of relativePlacements) {
        if (placement.imageId === imageId) parentKeys.push(key);
      }
    };
    collectStoredPlacements(
      this.kittyVirtualPlacements,
      this.kittyRelativePlacements,
      currentParentKeys,
    );
    collectStoredPlacements(
      this.mainScreenKittyVirtualPlacements,
      this.mainScreenKittyRelativePlacements,
      savedParentKeys,
    );
    this.removeKittyPlacements(
      (image) => image.protocol === 'kitty' && image.imageId === imageId,
    );
    const affectedImageIds = new Set<number>();
    this.deleteKittyRelativePlacementGroups(currentParentKeys, affectedImageIds);
    this.deleteKittyRelativePlacementGroups(
      savedParentKeys,
      affectedImageIds,
      this.mainScreenKittyRelativePlacements,
    );
    this.kittyVirtualOriginsDirty = true;
  }

  private removeKittyPlacements(
    predicate: (image: TerminalImage) => boolean,
    includeSavedMainScreen = true,
  ) {
    const currentImageCount = this.images.length;
    const savedImageCount = this.mainScreenImages.length;
    this.images = this.images.filter((image) => !predicate(image));
    if (includeSavedMainScreen) {
      this.mainScreenImages = this.mainScreenImages.filter((image) => !predicate(image));
    }
    if (this.images.length !== currentImageCount || this.mainScreenImages.length !== savedImageCount) {
      this.imageCachePrunePending = true;
      this.markAllRowsDirty();
    }
  }

  private imageIntersectsCell(image: TerminalImage, row: number, col: number): boolean {
    return row >= image.row && row < image.row + image.heightCells &&
      col >= image.col && col < image.col + image.widthCells;
  }

  private resolveImagePlacementCells(
    params: Map<string, string>,
    pixelWidth: number,
    pixelHeight: number,
    col = this.cursorX,
    constrainToViewport = true,
  ): { width: number; height: number } | null {
    const widthCells = this.parseKittyUint(params.get('c'));
    const heightCells = this.parseKittyUint(params.get('r'));
    const maxWidth = constrainToViewport
      ? Math.max(1, this.cols - Math.max(0, col))
      : MAX_IMAGE_CELL_DIMENSION;
    const maxHeight = constrainToViewport ? Math.max(1, this.rows) : MAX_IMAGE_CELL_DIMENSION;
    if ((params.has('c') && widthCells === null) || (params.has('r') && heightCells === null)) return null;

    if (widthCells !== null && heightCells !== null) {
      return { width: Math.min(widthCells, maxWidth), height: Math.min(heightCells, maxHeight) };
    }
    if (widthCells !== null) {
      const width = Math.min(widthCells, maxWidth);
      const renderedHeightPixels = (width * this.cellPixelWidth * pixelHeight) / pixelWidth;
      return { width, height: Math.min(maxHeight, Math.max(1, Math.ceil(renderedHeightPixels / this.cellPixelHeight))) };
    }
    if (heightCells !== null) {
      const height = Math.min(heightCells, maxHeight);
      const renderedWidthPixels = (height * this.cellPixelHeight * pixelWidth) / pixelHeight;
      return { width: Math.min(maxWidth, Math.max(1, Math.ceil(renderedWidthPixels / this.cellPixelWidth))), height };
    }

    return {
      width: Math.min(maxWidth, Math.max(1, Math.ceil(pixelWidth / this.cellPixelWidth))),
      height: Math.min(maxHeight, Math.max(1, Math.ceil(pixelHeight / this.cellPixelHeight))),
    };
  }

  private kittyVirtualPlacementKey(imageId: number, placementId: number | null): string {
    return imageId + ':' + (placementId ?? 0);
  }
  private parseKittyUint(value: string | undefined): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 0xffffffff ? parsed : null;
  }

  private parseNonNegativeInteger(value: string | undefined): number | null {
    if (value === undefined) return null;
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed : null;
  }

  private parseKittyInt32(value: string | undefined): number | null {
    if (value === undefined || !/^-?\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= -0x80000000 && parsed <= 0x7fffffff ? parsed : null;
  }

  private sendKittyResponse(
    params: Map<string, string>,
    ok: boolean,
    message: string,
    resolvedImageId: number | null,
    force = false,
  ) {
    const quiet = Number.parseInt(params.get('q') ?? '0', 10);
    if (quiet === 2 || (ok && quiet === 1)) return;
    if (!force && resolvedImageId === null && !params.has('I') && !params.has('p')) return;

    const fields: string[] = [];
    if (resolvedImageId !== null) fields.push('i=' + resolvedImageId);
    const imageNumber = this.parseKittyUint(params.get('I'));
    if (imageNumber !== null) fields.push('I=' + imageNumber);
    const placementId = this.parseKittyUint(params.get('p'));
    if (placementId !== null) fields.push('p=' + placementId);
    const safeMessage = message.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256);
    this.onResponse?.('\x1b_G' + fields.join(',') + ';' + safeMessage + '\x1b\\');
  }

  private handleKittyAnimationControl(params: Map<string, string>) {
    const identity = this.resolveKittyImageIdentity(params, false);
    if (!identity.ok || identity.imageId === null) {
      this.sendKittyResponse(params, false, identity.ok ? 'ENOENT:image not found' : identity.error, null, true);
      return;
    }
    const imageData = this.kittyImageData.get(identity.imageId);
    if (!imageData?.animation) {
      this.sendKittyResponse(params, false, 'ENOENT:animation not found', identity.imageId, true);
      return;
    }
    if (params.get('a') === 'c') {
      const composed = this.composeKittyAnimationFrames(identity.imageId, imageData.animation, params);
      this.sendKittyResponse(params, composed.ok, composed.ok ? 'OK' : composed.error, identity.imageId, true);
      if (composed.ok) this.applyCurrentKittyFrame(identity.imageId, imageData);
      return;
    }

    const animation = imageData.animation;
    const currentFrame = this.parseKittyUint(params.get('c'));
    if (params.has('c')) {
      if (currentFrame === null || currentFrame > animation.frames.length) {
        this.sendKittyResponse(params, false, 'EINVAL:invalid animation frame', identity.imageId, true);
        return;
      }
      animation.currentFrame = currentFrame - 1;
    }
    const gapFrame = this.parseKittyUint(params.get('r'));
    const gap = this.parseKittyInt32(params.get('z'));
    if (gap !== null) {
      const target = gapFrame ?? animation.currentFrame + 1;
      if (target < 1 || target > animation.frames.length) {
        this.sendKittyResponse(params, false, 'EINVAL:invalid animation frame', identity.imageId, true);
        return;
      }
      if (gap !== 0) animation.frames[target - 1].gap = gap;
    }

    const loops = this.parseKittyUint(params.get('v'));
    if (loops !== null) {
      animation.configuredLoops = loops === 1 ? Number.POSITIVE_INFINITY : loops - 1;
      animation.remainingLoops = animation.configuredLoops;
    }
    const state = this.parseKittyUint(params.get('s'));
    if (state !== null) {
      if (state < 1 || state > 3) {
        this.sendKittyResponse(params, false, 'EINVAL:invalid animation state', identity.imageId, true);
        return;
      }
      animation.running = state !== 1;
      animation.waitForFrames = state === 2;
      animation.lastFrameAt = Date.now();
      if (state === 1) animation.remainingLoops = animation.configuredLoops;
    }
    this.applyCurrentKittyFrame(identity.imageId, imageData);
    this.sendKittyResponse(params, true, 'OK', identity.imageId, true);
  }

  private addKittyAnimationFrame(params: Map<string, string>, imageId: number | null, frameData: KittyImageData) {
    if (imageId === null) {
      this.sendKittyResponse(params, false, 'EINVAL:animation frame requires an image id', null, true);
      return;
    }
    const imageData = this.kittyImageData.get(imageId);
    if (!imageData) {
      this.sendKittyResponse(params, false, 'ENOENT:image not found', imageId, true);
      return;
    }
    if (!imageData.animation) {
      imageData.animation = {
        frames: [{ data: this.kittyFrameData(imageData), gap: 0 }],
        currentFrame: 0,
        running: false,
        waitForFrames: false,
        configuredLoops: Number.POSITIVE_INFINITY,
        remainingLoops: Number.POSITIVE_INFINITY,
        lastFrameAt: Date.now(),
      };
    }

    const animation = imageData.animation;
    const targetFrame = this.parseKittyUint(params.get('r'));
    if (targetFrame !== null && targetFrame > animation.frames.length) {
      this.sendKittyResponse(params, false, 'EINVAL:frame to edit does not exist', imageId, true);
      return;
    }
    if (targetFrame === null && animation.frames.length >= MAX_ANIMATED_IMAGE_FRAMES) {
      this.sendKittyResponse(params, false, 'ENOSPC:animation frame limit exceeded', imageId, true);
      return;
    }
    const composed = this.createKittyAnimationFrame(animation, frameData, params, targetFrame);
    if (!composed.ok) {
      this.sendKittyResponse(params, false, composed.error, imageId, true);
      return;
    }
    if (
      !this.canRetainKittyAnimationFrameData(
        composed.data.data,
        imageId,
        animation,
        targetFrame === null ? null : targetFrame - 1,
      )
    ) {
      this.sendKittyResponse(params, false, 'ENOSPC:image storage limit exceeded', imageId, true);
      return;
    }

    const gapValue = this.parseKittyInt32(params.get('z'));
    const frame = { data: composed.data, gap: gapValue && gapValue !== 0 ? gapValue : 40 };
    if (targetFrame === null) {
      animation.frames.push(frame);
    } else {
      const oldGap = animation.frames[targetFrame - 1].gap;
      frame.gap = gapValue === null || gapValue === 0 ? oldGap : gapValue;
      animation.frames[targetFrame - 1] = frame;
    }
    if (animation.running && animation.waitForFrames && animation.currentFrame >= animation.frames.length - 2) {
      animation.lastFrameAt = Date.now();
    }
    if (targetFrame !== null && animation.currentFrame === targetFrame - 1) this.applyCurrentKittyFrame(imageId, imageData);
    this.sendKittyResponse(params, true, 'OK', imageId, true);
  }

  private decodeKittyRgbaFrame(imageData: KittyImageData): KittyRgbaImageData | null {
    if (imageData.kind === 'rgba') {
      return {
        kind: 'rgba',
        pixelWidth: imageData.pixelWidth,
        pixelHeight: imageData.pixelHeight,
        imageNumber: imageData.imageNumber,
        data: imageData.data,
      };
    }

    try {
      const decoded = decodePngBytes(imageData.data, { checkCrc: true });
      if (
        decoded.width !== imageData.pixelWidth ||
        decoded.height !== imageData.pixelHeight ||
        !this.isImageDimensionsAllowed(decoded.width, decoded.height)
      ) {
        return null;
      }
      const data = this.decodedPngToRgba(decoded);
      return data
        ? {
            kind: 'rgba',
            pixelWidth: decoded.width,
            pixelHeight: decoded.height,
            imageNumber: imageData.imageNumber,
            data,
          }
        : null;
    } catch {
      return null;
    }
  }

  private decodedPngToRgba(decoded: DecodedPng): Uint8ClampedArray | null {
    const pixelCount = decoded.width * decoded.height;
    let source: Uint8Array | Uint8ClampedArray | Uint16Array = decoded.data;
    let channels = decoded.channels;
    let depth = decoded.depth;
    let transparentGray = decoded.transparency?.[0];

    if (decoded.palette) {
      source = convertIndexedToRgb(decoded);
      channels = decoded.palette[0]?.length ?? 0;
      depth = 8;
    } else if (depth < 8) {
      if (channels !== 1 || !(source instanceof Uint8Array || source instanceof Uint8ClampedArray)) return null;
      const unpacked = new Uint8Array(pixelCount);
      const rowBytes = Math.ceil((decoded.width * depth) / 8);
      const mask = (1 << depth) - 1;
      if (transparentGray !== undefined) {
        transparentGray = Math.round((transparentGray * 255) / mask);
      }
      for (let y = 0; y < decoded.height; y++) {
        for (let x = 0; x < decoded.width; x++) {
          const bitOffset = x * depth;
          const byte = source[y * rowBytes + Math.floor(bitOffset / 8)];
          const shift = 8 - depth - (bitOffset % 8);
          unpacked[y * decoded.width + x] = Math.round((((byte >> shift) & mask) * 255) / mask);
        }
      }
      source = unpacked;
      depth = 8;
    }

    if (channels < 1 || channels > 4 || source.length !== pixelCount * channels) return null;
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    const transparent = decoded.transparency;
    const toByte = (value: number) => depth === 16 ? Math.round(value / 257) : value;
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const src = pixel * channels;
      const dst = pixel * 4;
      if (channels === 1 || channels === 2) {
        const grayValue = source[src];
        const gray = toByte(grayValue);
        rgba[dst] = gray;
        rgba[dst + 1] = gray;
        rgba[dst + 2] = gray;
        rgba[dst + 3] = channels === 2
          ? toByte(source[src + 1])
          : transparentGray === grayValue ? 0 : 255;
      } else {
        const redValue = source[src];
        const greenValue = source[src + 1];
        const blueValue = source[src + 2];
        rgba[dst] = toByte(redValue);
        rgba[dst + 1] = toByte(greenValue);
        rgba[dst + 2] = toByte(blueValue);
        rgba[dst + 3] = channels === 4
          ? toByte(source[src + 3])
          : transparent &&
              transparent[0] === redValue &&
              transparent[1] === greenValue &&
              transparent[2] === blueValue
            ? 0
            : 255;
      }
    }
    return rgba;
  }
  private createKittyAnimationFrame(
    animation: KittyAnimationState,
    frameData: KittyImageData,
    params: Map<string, string>,
    targetFrame: number | null,
  ): { ok: true; data: KittyImageData } | { ok: false; error: string } {
    const root = animation.frames[0].data;
    const destX = this.parseNonNegativeInteger(params.get('x')) ?? 0;
    const destY = this.parseNonNegativeInteger(params.get('y')) ?? 0;
    const fullFrame = destX === 0 && destY === 0 &&
      frameData.pixelWidth === root.pixelWidth && frameData.pixelHeight === root.pixelHeight;
    if (fullFrame && targetFrame === null) return { ok: true, data: this.kittyFrameData(frameData) };

    const frameRgba = this.decodeKittyRgbaFrame(frameData);
    if (!frameRgba) return { ok: false, error: 'EINVAL:invalid PNG animation frame' };

    let base: KittyRgbaImageData;
    if (targetFrame !== null) {
      const target = animation.frames[targetFrame - 1]?.data;
      const targetRgba = target ? this.decodeKittyRgbaFrame(target) : null;
      if (!targetRgba) return { ok: false, error: 'EINVAL:animation frame cannot be decoded' };
      base = { ...targetRgba, data: new Uint8ClampedArray(targetRgba.data), animation: undefined };
    } else {
      const baseFrame = this.parseKittyUint(params.get('c'));
      if (baseFrame !== null) {
        const source = animation.frames[baseFrame - 1]?.data;
        const sourceRgba = source ? this.decodeKittyRgbaFrame(source) : null;
        if (!sourceRgba) return { ok: false, error: 'EINVAL:base frame not found' };
        base = { ...sourceRgba, data: new Uint8ClampedArray(sourceRgba.data), animation: undefined };
      } else {
        base = {
          kind: 'rgba',
          pixelWidth: root.pixelWidth,
          pixelHeight: root.pixelHeight,
          imageNumber: root.imageNumber,
          data: new Uint8ClampedArray(root.pixelWidth * root.pixelHeight * 4),
        };
        const background = this.parseNonNegativeInteger(params.get('Y'));
        if (background !== null) {
          const red = (background >>> 24) & 0xff;
          const green = (background >>> 16) & 0xff;
          const blue = (background >>> 8) & 0xff;
          const alpha = background & 0xff;
          for (let offset = 0; offset < base.data.length; offset += 4) {
            base.data.set([red, green, blue, alpha], offset);
          }
        }
      }
    }
    this.compositeRgba(
      base.data,
      base.pixelWidth,
      base.pixelHeight,
      frameRgba.data,
      frameRgba.pixelWidth,
      frameRgba.pixelHeight,
      destX,
      destY,
      params.get('X') === '1',
    );
    return { ok: true, data: base };
  }

  private composeKittyAnimationFrames(
    imageId: number,
    animation: KittyAnimationState,
    params: Map<string, string>,
  ): { ok: true } | { ok: false; error: string } {
    const sourceFrame = this.parseKittyUint(params.get('r'));
    const destinationFrame = this.parseKittyUint(params.get('c'));
    if (sourceFrame === null || destinationFrame === null) return { ok: false, error: 'EINVAL:source and destination frames are required' };
    const sourceData = animation.frames[sourceFrame - 1]?.data;
    const destinationData = animation.frames[destinationFrame - 1]?.data;
    if (!sourceData || !destinationData) return { ok: false, error: 'ENOENT:animation frame not found' };
    const source = this.decodeKittyRgbaFrame(sourceData);
    const destination = this.decodeKittyRgbaFrame(destinationData);
    if (!source || !destination) return { ok: false, error: 'EINVAL:animation frame cannot be decoded' };

    const sourceXValue = params.get('x');
    const sourceYValue = params.get('y');
    const destinationXValue = params.get('X');
    const destinationYValue = params.get('Y');
    const widthValue = params.get('w');
    const heightValue = params.get('h');
    const parsedSourceX = this.parseNonNegativeInteger(sourceXValue);
    const parsedSourceY = this.parseNonNegativeInteger(sourceYValue);
    const parsedDestinationX = this.parseNonNegativeInteger(destinationXValue);
    const parsedDestinationY = this.parseNonNegativeInteger(destinationYValue);
    const sourceX = parsedSourceX ?? 0;
    const sourceY = parsedSourceY ?? 0;
    const destinationX = parsedDestinationX ?? 0;
    const destinationY = parsedDestinationY ?? 0;
    const width = widthValue === undefined ? source.pixelWidth : this.parseKittyUint(widthValue);
    const height = heightValue === undefined ? source.pixelHeight : this.parseKittyUint(heightValue);
    if (
      (sourceXValue !== undefined && parsedSourceX === null) ||
      (sourceYValue !== undefined && parsedSourceY === null) ||
      (destinationXValue !== undefined && parsedDestinationX === null) ||
      (destinationYValue !== undefined && parsedDestinationY === null) ||
      width === null ||
      height === null ||
      sourceX + width > source.pixelWidth ||
      sourceY + height > source.pixelHeight ||
      destinationX + width > destination.pixelWidth ||
      destinationY + height > destination.pixelHeight
    ) {
      return { ok: false, error: 'EINVAL:invalid composition rectangle' };
    }
    if (
      sourceFrame === destinationFrame &&
      Math.max(sourceX, destinationX) < Math.min(sourceX + width, destinationX + width) &&
      Math.max(sourceY, destinationY) < Math.min(sourceY + height, destinationY + height)
    ) {
      return { ok: false, error: 'EINVAL:overlapping composition rectangles' };
    }

    const cropped = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      const start = ((sourceY + row) * source.pixelWidth + sourceX) * 4;
      cropped.set(source.data.subarray(start, start + width * 4), row * width * 4);
    }
    const nextDestination = new Uint8ClampedArray(destination.data);
    this.compositeRgba(
      nextDestination,
      destination.pixelWidth,
      destination.pixelHeight,
      cropped,
      width,
      height,
      destinationX,
      destinationY,
      params.get('C') === '1',
    );
    if (!this.canRetainKittyAnimationFrameData(nextDestination, imageId, animation, destinationFrame - 1)) {
      return { ok: false, error: 'ENOSPC:image storage limit exceeded' };
    }
    animation.frames[destinationFrame - 1] = {
      ...animation.frames[destinationFrame - 1],
      data: { ...destination, data: nextDestination, animation: undefined },
    };
    return { ok: true };
  }

  private compositeRgba(
    destination: Uint8ClampedArray,
    destinationWidth: number,
    destinationHeight: number,
    source: Uint8ClampedArray,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    overwrite: boolean,
  ) {
    const copyWidth = Math.max(0, Math.min(sourceWidth, destinationWidth - destinationX));
    const copyHeight = Math.max(0, Math.min(sourceHeight, destinationHeight - destinationY));
    for (let y = 0; y < copyHeight; y++) {
      for (let x = 0; x < copyWidth; x++) {
        const src = (y * sourceWidth + x) * 4;
        const dst = ((destinationY + y) * destinationWidth + destinationX + x) * 4;
        if (overwrite || source[src + 3] === 0xff) {
          destination.set(source.subarray(src, src + 4), dst);
          continue;
        }
        const sourceAlpha = source[src + 3] / 255;
        const destinationAlpha = destination[dst + 3] / 255;
        const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
        if (outputAlpha === 0) {
          destination.fill(0, dst, dst + 4);
          continue;
        }
        for (let channel = 0; channel < 3; channel++) {
          destination[dst + channel] = Math.round(
            (source[src + channel] * sourceAlpha + destination[dst + channel] * destinationAlpha * (1 - sourceAlpha)) /
              outputAlpha,
          );
        }
        destination[dst + 3] = Math.round(outputAlpha * 255);
      }
    }
  }

  private kittyFrameData(data: KittyImageData): KittyImageData {
    return data.kind === 'png'
      ? { kind: 'png', pixelWidth: data.pixelWidth, pixelHeight: data.pixelHeight, imageNumber: data.imageNumber, mimeType: data.mimeType, data: data.data }
      : { kind: 'rgba', pixelWidth: data.pixelWidth, pixelHeight: data.pixelHeight, imageNumber: data.imageNumber, data: data.data };
  }

  private applyCurrentKittyFrame(imageId: number, imageData: KittyImageData) {
    const animation = imageData.animation;
    if (!animation) return;
    const animationFrame = animation.frames[animation.currentFrame];
    if (!animationFrame || animationFrame.gap < 0) return;
    const frame = animationFrame.data;
    const apply = (image: TerminalImage): TerminalImage => {
      if (image.protocol !== 'kitty' || image.imageId !== imageId) return image;
      const common = {
        id: image.id,
        protocol: image.protocol,
        dataId: this.kittyImageCacheId(frame),
        imageId: image.imageId,
        imageNumber: image.imageNumber,
        placementId: image.placementId,
        row: image.row,
        col: image.col,
        widthCells: image.widthCells,
        heightCells: image.heightCells,
        pixelWidth: frame.pixelWidth,
        pixelHeight: frame.pixelHeight,
        sourceX: image.sourceX,
        sourceY: image.sourceY,
        sourceWidth: image.sourceWidth,
        sourceHeight: image.sourceHeight,
        offsetX: image.offsetX,
        offsetY: image.offsetY,
        zIndex: image.zIndex,
      };
      return frame.kind === 'png'
        ? { ...common, kind: 'png', mimeType: frame.mimeType, data: frame.data }
        : { ...common, kind: 'rgba', data: frame.data };
    };
    this.images = this.images.map(apply);
    this.mainScreenImages = this.mainScreenImages.map(apply);
    this.markAllRowsDirty();
  }

  advanceKittyAnimations(visibleImageIds: ReadonlySet<number>, now = Date.now()): boolean {
    let changed = false;
    for (const [imageId, imageData] of this.kittyImageData) {
      if (!visibleImageIds.has(imageId)) continue;
      const animation = imageData.animation;
      if (!animation?.running || animation.frames.length < 2) continue;
      let imageChanged = false;
      let guard = animation.frames.length;
      while (guard-- > 0) {
        const frame = animation.frames[animation.currentFrame];
        const gap = Math.max(0, frame.gap);
        if (gap > 0 && now - animation.lastFrameAt < gap) break;
        if (animation.currentFrame + 1 < animation.frames.length) {
          animation.currentFrame++;
        } else if (animation.waitForFrames) {
          animation.lastFrameAt = now;
          break;
        } else {
          if (Number.isFinite(animation.remainingLoops)) {
            if (animation.remainingLoops <= 0) {
              animation.running = false;
              break;
            }
            animation.remainingLoops--;
          }
          animation.currentFrame = 0;
        }
        animation.lastFrameAt += gap;
        imageChanged = true;
      }
      const currentFrame = animation.frames[animation.currentFrame];
      if (guard < 0 && currentFrame?.gap < 0) animation.running = false;
      if (imageChanged && currentFrame?.gap >= 0) {
        changed = true;
        this.applyCurrentKittyFrame(imageId, imageData);
      }
    }
    return changed;
  }

  getKittyAnimationDelay(visibleImageIds: ReadonlySet<number>, now = Date.now()): number | null {
    let delay: number | null = null;
    for (const [imageId, imageData] of this.kittyImageData) {
      if (!visibleImageIds.has(imageId)) continue;
      const animation = imageData.animation;
      if (!animation?.running || animation.frames.length < 2) continue;
      if (animation.waitForFrames && animation.currentFrame === animation.frames.length - 1) continue;
      const frame = animation.frames[animation.currentFrame];
      const gap = Math.max(0, frame.gap);
      const remaining = gap === 0 ? 0 : Math.max(0, gap - (now - animation.lastFrameAt));
      delay = delay === null ? remaining : Math.min(delay, remaining);
    }
    return delay;
  }
  private deleteKittyAnimationFrames(imageId: number | null, params: Map<string, string>) {
    if (imageId === null) {
      this.sendKittyResponse(params, false, 'EINVAL:image id required', null, true);
      return;
    }
    const imageData = this.kittyImageData.get(imageId);
    if (!imageData?.animation) {
      this.sendKittyResponse(params, false, 'ENOENT:animation not found', imageId, true);
      return;
    }
    imageData.animation.currentFrame = 0;
    this.applyCurrentKittyFrame(imageId, imageData);
    imageData.animation = undefined;
    this.sendKittyResponse(params, true, 'OK', imageId, true);
  }

  private parsePositiveInteger(value: string | undefined): number | null {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private parsePngDimensions(data: Uint8Array): { width: number; height: number } | null {
    if (data.length < 24) return null;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
      if (data[i] !== PNG_SIGNATURE[i]) return null;
    }
    if (this.readPngUint32(data, 8) !== 13) return null;
    if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return null;

    const width = this.readPngUint32(data, 16);
    const height = this.readPngUint32(data, 20);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  private readPngUint32(data: Uint8Array, offset: number): number {
    return (
      data[offset] * 0x1000000 +
      (data[offset + 1] << 16) +
      (data[offset + 2] << 8) +
      data[offset + 3]
    );
  }

  private isImageDimensionsAllowed(width: number, height: number): boolean {
    return (
      Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width <= MAX_IMAGE_PIXEL_DIMENSION &&
      height <= MAX_IMAGE_PIXEL_DIMENSION &&
      width * height <= MAX_IMAGE_PIXELS
    );
  }

  private canRetainImageData(
    data: Uint8Array | Uint8ClampedArray,
    replacingImageId: number | null = null,
  ): boolean {
    const seen = new Set<Uint8Array | Uint8ClampedArray>();
    let totalBytes = 0;
    const track = (candidate: Uint8Array | Uint8ClampedArray) => {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      totalBytes += candidate.byteLength;
    };

    for (const image of this.images) {
      if (replacingImageId === null || image.protocol !== 'kitty' || image.imageId !== replacingImageId) {
        track(image.data);
      }
    }
    for (const image of this.mainScreenImages) {
      if (replacingImageId === null || image.protocol !== 'kitty' || image.imageId !== replacingImageId) {
        track(image.data);
      }
    }
    for (const [imageId, imageData] of this.kittyImageData) {
      if (imageId === replacingImageId) continue;
      track(imageData.data);
      for (const frame of imageData.animation?.frames ?? []) track(frame.data.data);
    }
    return seen.has(data) || totalBytes + data.byteLength <= MAX_TOTAL_IMAGE_DATA_BYTES;
  }

  private canRetainKittyAnimationFrameData(
    data: Uint8Array | Uint8ClampedArray,
    imageId: number,
    animation: KittyAnimationState,
    replacingFrameIndex: number | null,
  ): boolean {
    if (replacingFrameIndex === null) return this.canRetainImageData(data);
    const replacingCurrentFrame = animation.currentFrame === replacingFrameIndex;
    const seen = new Set<Uint8Array | Uint8ClampedArray>();
    let totalBytes = 0;
    const track = (candidate: Uint8Array | Uint8ClampedArray) => {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      totalBytes += candidate.byteLength;
    };

    for (const image of this.images) {
      if (!(replacingCurrentFrame && image.protocol === 'kitty' && image.imageId === imageId)) {
        track(image.data);
      }
    }
    for (const image of this.mainScreenImages) {
      if (!(replacingCurrentFrame && image.protocol === 'kitty' && image.imageId === imageId)) {
        track(image.data);
      }
    }
    for (const [candidateImageId, imageData] of this.kittyImageData) {
      track(imageData.data);
      imageData.animation?.frames.forEach((frame, frameIndex) => {
        if (candidateImageId !== imageId || frameIndex !== replacingFrameIndex) track(frame.data.data);
      });
    }
    return seen.has(data) || totalBytes + data.byteLength <= MAX_TOTAL_IMAGE_DATA_BYTES;
  }

  private encodedImageLength(chunks: string[]): number | null {
    if (chunks.length === 0 || chunks.length > MAX_IMAGE_CHUNKS) return null;

    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
      if (totalLength > MAX_IMAGE_BASE64_CHARS) return null;
    }
    return totalLength;
  }

  private decodeConcatenatedBase64Bytes(chunks: string[]): Uint8Array | null {
    if (this.encodedImageLength(chunks) === null) return null;

    try {
      const bytes = this.decodeBase64Chunk(chunks.length === 1 ? chunks[0] : chunks.join(''));
      return bytes.length <= MAX_IMAGE_DECODED_BYTES ? bytes : null;
    } catch {
      return null;
    }
  }

  private decodeIndependentBase64Bytes(chunks: string[]): Uint8Array | null {
    const encodedLength = this.encodedImageLength(chunks);
    if (encodedLength === null) return null;

    const finalChunk = chunks.at(-1)!;
    const padding = finalChunk.endsWith('==') ? 2 : finalChunk.endsWith('=') ? 1 : 0;
    const decodedLength = Math.floor(encodedLength / 4) * 3 - padding;
    if (decodedLength > MAX_IMAGE_DECODED_BYTES) return null;

    try {
      const bytes = new Uint8Array(decodedLength);
      let offset = 0;
      for (const chunk of chunks) {
        const binary = atob(chunk);
        if (offset + binary.length > bytes.length) return null;
        for (let index = 0; index < binary.length; index += 1) {
          bytes[offset + index] = binary.charCodeAt(index);
        }
        offset += binary.length;
      }
      return offset === bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  private decodeBase64Chunk(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private advanceCursorRows(count: number) {
    this.cursorX = 0;
    const rowsToAdvance = Math.min(count, this.rows);
    for (let i = 0; i < rowsToAdvance; i++) this.lineFeed();
  }

  private advanceCursorAfterKittyPlacement(originCol: number, widthCells: number, heightCells: number) {
    const targetCol = Math.min(this.cols - 1, Math.max(0, originCol + widthCells));
    this.advanceCursorRows(heightCells);
    this.cursorX = targetCol;
  }

  private boundedCsiCount(value: number | undefined, limit: number): number {
    if (limit <= 0) return 0;
    return Math.min(value || 1, limit);
  }

  private hasTooManyControlFields(value: string, separator: string): boolean {
    let fieldCount = 1;
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== separator) continue;
      fieldCount++;
      if (fieldCount > MAX_CONTROL_FIELDS) return true;
    }
    return false;
  }

  private parseSgrParameters(rawParams: string): number[] | null {
    const fields = (rawParams.length > 0 ? rawParams : '0').split(';');
    const params: number[] = [];
    const parse = (value: string | undefined) => {
      const parsed = Number.parseInt(value ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return Math.min(parsed, MAX_CSI_PARAMETER);
    };

    for (const field of fields) {
      if (!field.includes(':')) {
        params.push(parse(field));
      } else {
        const components = field.split(':');
        const primary = parse(components[0]);
        params.push(primary);
        if (primary === 38 || primary === 48 || primary === 58) {
          const mode = parse(components[1]);
          if (mode === 5 && components[2] !== undefined) {
            params.push(5, parse(components[2]));
          } else if (mode === 2) {
            const colorOffset = components.length >= 6 ? 3 : 2;
            if (components[colorOffset + 2] !== undefined) {
              params.push(
                2,
                parse(components[colorOffset]),
                parse(components[colorOffset + 1]),
                parse(components[colorOffset + 2]),
              );
            }
          }
        }
      }
      if (params.length > MAX_CONTROL_FIELDS) return null;
    }
    return params;
  }
  private handleCSI(seq: string) {
    const command = seq[seq.length - 1];
    const rawParams = seq.slice(0, -1);
    if (command === 'u' && this.handleKittyKeyboardProtocol(rawParams)) return;
    const isPrivateMode = rawParams.startsWith('?');
    const isSecondaryDeviceAttributes = rawParams.startsWith('>');
    const normalizedParams = isPrivateMode || isSecondaryDeviceAttributes ? rawParams.slice(1) : rawParams;
    if (command === 'm') {
      const sgrParams = this.parseSgrParameters(normalizedParams);
      if (sgrParams) this.handleSGR(sgrParams);
      return;
    }
    const parameterFields = (normalizedParams.length > 0 ? normalizedParams : '0').split(';');
    if (parameterFields.length > MAX_CONTROL_FIELDS) return;
    const params = parameterFields.map((p) => {
      const parsed = Number.parseInt(p, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return Math.min(parsed, MAX_CSI_PARAMETER);
    });

    switch (command) {
      case 'A': // Cursor up
        this.cursorY = Math.max(0, this.cursorY - (params[0] || 1));
        break;
      case 'B': // Cursor down
        this.cursorY = Math.min(this.rows - 1, this.cursorY + (params[0] || 1));
        break;
      case 'C': // Cursor forward
        this.cursorX = Math.min(this.cols - 1, this.cursorX + (params[0] || 1));
        break;
      case 'D': // Cursor back
        this.cursorX = Math.max(0, this.cursorX - (params[0] || 1));
        break;
      case 'E': // Cursor Next Line (CNL) — n행 아래 + 행 처음으로
        this.cursorY = Math.min(this.rows - 1, this.cursorY + (params[0] || 1));
        this.cursorX = 0;
        break;
      case 'F': // Cursor Previous Line (CPL) — n행 위 + 행 처음으로
        this.cursorY = Math.max(0, this.cursorY - (params[0] || 1));
        this.cursorX = 0;
        break;
      case 'G':
        this.cursorX = Math.min(this.cols - 1, Math.max(0, (params[0] || 1) - 1));
        break;
      case 'a': // HPR — 커서 오른쪽 상대이동 (CSI C와 동일)
        this.cursorX = Math.min(this.cols - 1, this.cursorX + (params[0] || 1));
        break;
      case 'e': // VPR — 커서 아래 상대이동 (CSI B와 동일)
        this.cursorY = Math.min(this.rows - 1, this.cursorY + (params[0] || 1));
        break;
      case 'I': { // CHT — 탭 앞으로 n번
        const count = this.boundedCsiCount(params[0], Math.ceil(this.cols / 8));
        this.cursorX = Math.min(this.cols - 1, (Math.floor(this.cursorX / 8) + count) * 8);
        break;
      }
      case 'Z': { // CBT — 탭 뒤로 n번
        const count = this.boundedCsiCount(params[0], Math.ceil(this.cols / 8));
        this.cursorX = Math.max(0, (Math.ceil(this.cursorX / 8) - count) * 8);
        break;
      }
      case 'd':
        this.cursorY = Math.min(this.rows - 1, Math.max(0, (params[0] || 1) - 1));
        break;
      case 'H': // Cursor position
      case 'f':
        this.cursorY = Math.min(this.rows - 1, Math.max(0, (params[0] || 1) - 1));
        this.cursorX = Math.min(this.cols - 1, Math.max(0, (params[1] || 1) - 1));
        break;
      case 'J': // Erase in display
        this.eraseInDisplay(params[0] || 0);
        break;
      case 'K': // Erase in line
        this.eraseInLine(params[0] || 0);
        break;
      case 'r':
        this.setScrollRegion(params[0], params[1]);
        break;
      case '@':
        this.insertChars(params[0] || 1);
        break;
      case 'P':
        this.deleteChars(params[0] || 1);
        break;
      case 'X':
        this.eraseChars(params[0] || 1);
        break;
      case 'L':
        this.insertLines(params[0] || 1);
        break;
      case 'M':
        this.deleteLines(params[0] || 1);
        break;
      case 'S':
        if (isPrivateMode) {
          // XTSMGRAPHICS. RedTerm does not expose Sixel geometry, so report
          // failure instead of treating the query as a scroll command.
          if (params[0] === 2 && params[1] === 1) {
            this.onResponse?.('\x1b[?2;3;0S');
          }
        } else {
          this.scrollRegionUp(params[0] || 1);
        }
        break;
      case 'T':
        this.scrollRegionDown(params[0] || 1);
        break;
      case 's': // Save cursor
        this.savedCursor = { x: this.cursorX, y: this.cursorY };
        break;
      case 'u': // Restore cursor
        this.cursorX = this.savedCursor.x;
        this.cursorY = this.savedCursor.y;
        break;
      case 'b': { // REP — 직전 출력 문자를 n번 반복
        const count = this.boundedCsiCount(params[0], MAX_CSI_REP_COUNT);
        for (let i = 0; i < count; i++) {
          this.putChar(this.lastPrintedChar);
        }
        break;
      }
      case 'c':
        if (!isPrivateMode && !isSecondaryDeviceAttributes && (params[0] ?? 0) === 0) {
          this.onResponse?.('\x1b[?64;4c');
        }
        break;
      case 'n': // DSR (Device Status Report)
        if (params[0] === 6) {
          // CPR (Cursor Position Report): row;col (1-based)
          this.onResponse?.(`\x1b[${this.cursorY + 1};${this.cursorX + 1}R`);
        } else if (params[0] === 5) {
          // Status report: "OK"
          this.onResponse?.('\x1b[0n');
        }
        break;
      case 'h':
      case 'l':
        if (isPrivateMode) {
          this.handlePrivateMode(params, command === 'h');
        }
        break;
    }
  }
  private normalizeKittyKeyboardFlags(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value & KITTY_KEYBOARD_SUPPORTED_FLAGS
      : 0;
  }

  private currentKittyKeyboardStack(): number[] {
    return this.usingAlternateScreen
      ? this.kittyKeyboardAlternateStack
      : this.kittyKeyboardMainStack;
  }

  private setKittyKeyboardFlags(flags: number) {
    if (this.usingAlternateScreen) this.kittyKeyboardAlternateFlags = flags;
    else this.kittyKeyboardMainFlags = flags;
  }

  private parseKittyKeyboardParameter(value: string, fallback: number): number | null {
    if (value === '') return fallback;
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_CSI_PARAMETER) : null;
  }

  private handleKittyKeyboardProtocol(rawParams: string): boolean {
    const prefix = rawParams[0];
    if (prefix !== '?' && prefix !== '=' && prefix !== '>' && prefix !== '<') return false;

    const body = rawParams.slice(1);
    if (prefix === '?') {
      if (body === '') this.onResponse?.(`\x1b[?${this.getKittyKeyboardFlags()}u`);
      return true;
    }

    const fields = body.split(';');
    if (prefix === '=') {
      if (fields.length > 2) return true;
      const requested = this.parseKittyKeyboardParameter(fields[0], 0);
      const mode = this.parseKittyKeyboardParameter(fields[1] ?? '', 1);
      if (requested === null || mode === null || mode < 1 || mode > 3) return true;

      const flags = requested & KITTY_KEYBOARD_SUPPORTED_FLAGS;
      const current = this.getKittyKeyboardFlags();
      this.setKittyKeyboardFlags(
        mode === 1 ? flags : mode === 2 ? current | flags : current & ~flags,
      );
      return true;
    }

    if (fields.length > 1) return true;
    if (prefix === '>') {
      const requested = this.parseKittyKeyboardParameter(fields[0], 0);
      if (requested === null) return true;
      const stack = this.currentKittyKeyboardStack();
      if (stack.length === KITTY_KEYBOARD_STACK_LIMIT) stack.shift();
      stack.push(this.getKittyKeyboardFlags());
      this.setKittyKeyboardFlags(requested & KITTY_KEYBOARD_SUPPORTED_FLAGS);
      return true;
    }

    const count = this.parseKittyKeyboardParameter(fields[0], 1);
    if (count === null) return true;
    const stack = this.currentKittyKeyboardStack();
    if (count > 0 && count >= stack.length) {
      stack.length = 0;
      this.setKittyKeyboardFlags(0);
      return true;
    }


    let flags = this.getKittyKeyboardFlags();
    for (let index = 0; index < count; index++) flags = stack.pop()!;
    this.setKittyKeyboardFlags(flags);
    return true;
  }
  private handlePrivateMode(params: number[], enabled: boolean) {
    for (const mode of params) {
      if (mode === 1) {
        this.applicationCursorKeys = enabled;
      } else if (mode === 25) {
        this.cursorVisible = enabled;
      } else if (mode === 47 || mode === 1047 || mode === 1049) {
        if (enabled) {
          this.enterAlternateScreen();
        } else {
          this.exitAlternateScreen();
        }
      } else if (mode === 2004) {
        this.bracketedPasteMode = enabled;
      } else if (mode === 7) {
        this.autoWrapMode = enabled;
      } else if (mode === 2026) {
        this.synchronizedOutput = enabled;
      } else if (mode === 9 || mode === 1000 || mode === 1002 || mode === 1003) {
        if (enabled) {
          this.mouseMode = mode;
        } else if (this.mouseMode === mode) {
          this.mouseMode = 0;
        }
      } else if (mode === 1006) {
        this.sgrMouseEncoding = enabled;
      }
    }
  }

  private enterAlternateScreen() {
    if (this.usingAlternateScreen) return;

    this.mainScreenBuffer = this.cloneBuffer(this.buffer);
    this.mainScreenScrollback = this.cloneBuffer(this.scrollback);
    this.mainScreenCursor = { x: this.cursorX, y: this.cursorY };
    this.mainScreenScrollRegion = { top: this.scrollTop, bottom: this.scrollBottom };
    this.mainScreenImages = this.images;
    this.mainScreenKittyVirtualPlacements = this.kittyVirtualPlacements;
    this.mainScreenKittyRelativePlacements = this.kittyRelativePlacements;

    this.buffer = this.createBuffer();
    this.scrollback = [];
    this.images = [];
    this.kittyVirtualPlacements = new Map();
    this.kittyRelativePlacements = new Map();
    this.pendingKittyImage = null;
    this.pendingITerm2File = null;
    this.cursorX = 0;
    this.cursorY = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.usingAlternateScreen = true;
    this.markFullBufferDirty();
    this.markAllRowsDirty();
  }

  private exitAlternateScreen() {
    if (!this.usingAlternateScreen) return;

    const preserveMainScreenLatestLines = this.isFullScreenRegion(
      this.mainScreenScrollRegion.top,
      this.mainScreenScrollRegion.bottom,
      this.rows,
    );
    const mainScreenBuffer =
      preserveMainScreenLatestLines &&
      this.mainScreenBuffer &&
      this.mainScreenBuffer.length > this.rows
        ? this.mainScreenBuffer.slice(0, this.mainScreenCursor.y + 1)
        : this.mainScreenBuffer;
    const restoredMainScreen = this.restoreViewportState(
      mainScreenBuffer ?? undefined,
      this.mainScreenScrollback,
      this.mainScreenCursor.y,
      preserveMainScreenLatestLines,
    );
    this.buffer = this.mainScreenBuffer ? restoredMainScreen.buffer : this.createBuffer();
    this.scrollback = restoredMainScreen.scrollback;
    this.cursorX = Math.min(this.cols - 1, Math.max(0, this.mainScreenCursor.x));
    this.cursorY = restoredMainScreen.cursorY;

    const restoredTop = Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.top));
    const restoredBottom = Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.bottom));
    if (restoredTop < restoredBottom) {
      this.scrollTop = restoredTop;
      this.scrollBottom = restoredBottom;
    } else {
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
    }

    this.normalizeTextSizingRows(this.scrollback.concat(this.buffer));
    this.imageCachePrunePending = true;
    this.mainScreenBuffer = null;
    this.mainScreenScrollback = [];
    this.images = this.mainScreenImages;
    this.mainScreenImages = [];
    this.kittyVirtualPlacements = this.mainScreenKittyVirtualPlacements;
    this.kittyRelativePlacements = this.mainScreenKittyRelativePlacements;
    this.mainScreenKittyVirtualPlacements = new Map();
    this.mainScreenKittyRelativePlacements = new Map();
    this.pendingKittyImage = null;
    this.pendingITerm2File = null;
    this.usingAlternateScreen = false;
    this.markFullBufferDirty();
    this.markAllRowsDirty();
  }

  private insertChars(count: number) {
    const row = this.buffer[this.cursorY];
    const amount = this.boundedCsiCount(count, this.cols - this.cursorX);
    if (amount === 0) return;
    const targets = new Map<string, number>();
    for (let col = this.cursorX; col < this.cols; col++) {
      const sizing = row[col].textSizing;
      if (!sizing) continue;
      const originCol = col - sizing.col;
      const rightCol = originCol + sizing.scale * sizing.width - 1;
      if (sizing.scale > 1 || originCol < this.cursorX || rightCol >= this.cols - amount) {
        targets.set(String(originCol), col);
      }
    }
    for (const col of targets.values()) this.eraseTextSizingAt(this.cursorY, col);
    row.splice(this.cursorX, 0, ...Array.from({ length: amount }, () => this.createEmptyCell()));
    row.splice(this.cols);
    this.markRowDirty(this.cursorY);
    this.kittyVirtualOriginsDirty = true;
  }

  private deleteChars(count: number) {
    const row = this.buffer[this.cursorY];
    const amount = this.boundedCsiCount(count, this.cols - this.cursorX);
    if (amount === 0) return;
    const targets = new Map<string, number>();
    for (let col = this.cursorX; col < this.cols; col++) {
      const sizing = row[col].textSizing;
      if (!sizing) continue;
      const originCol = col - sizing.col;
      if (sizing.scale > 1 || originCol < this.cursorX + amount) {
        targets.set(String(originCol), col);
      }
    }
    for (const col of targets.values()) this.eraseTextSizingAt(this.cursorY, col);
    row.splice(this.cursorX, amount);
    while (row.length < this.cols) row.push(this.createEmptyCell());
    this.markRowDirty(this.cursorY);
    this.kittyVirtualOriginsDirty = true;
  }

  private eraseChars(count: number) {
    const row = this.buffer[this.cursorY];
    const amount = this.boundedCsiCount(count, this.cols - this.cursorX);
    this.eraseTextSizingIntersecting(
      this.cursorY,
      this.cursorY,
      this.cursorX,
      this.cursorX + amount - 1,
    );
    for (let x = this.cursorX; x < this.cursorX + amount; x++) row[x] = this.createEmptyCell();
    this.markRowDirty(this.cursorY);
    this.kittyVirtualOriginsDirty = true;
  }

  private insertLines(count: number) {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;

    const amount = Math.min(Math.max(1, count), this.scrollBottom - this.cursorY + 1);
    const splitTargets: number[] = [];
    for (let col = 0; col < this.cols; col++) {
      const sizing = this.buffer[this.cursorY][col].textSizing;
      if (sizing?.row && !splitTargets.includes(col - sizing.col)) splitTargets.push(col - sizing.col);
    }
    for (const col of splitTargets) this.eraseTextSizingAt(this.cursorY, col);
    this.eraseTextSizingIntersecting(
      this.scrollBottom - amount + 1,
      this.scrollBottom,
      0,
      this.cols - 1,
    );
    this.markFullBufferDirty();
    this.scrollImagesInRegion(this.cursorY, this.scrollBottom, amount);
    for (let i = 0; i < amount; i++) {
      this.buffer.splice(this.cursorY, 0, this.createEmptyRow());
      this.buffer.splice(this.scrollBottom + 1, 1);
    }
    this.markAllRowsDirty();
  }

  private deleteLines(count: number) {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) return;

    const amount = Math.min(Math.max(1, count), this.scrollBottom - this.cursorY + 1);
    this.eraseTextSizingCrossingRowBoundary(this.scrollBottom + 1);
    this.eraseTextSizingIntersecting(
      this.cursorY,
      this.cursorY + amount - 1,
      0,
      this.cols - 1,
    );
    this.markFullBufferDirty();
    this.scrollImagesInRegion(this.cursorY, this.scrollBottom, -amount);
    for (let i = 0; i < amount; i++) {
      this.buffer.splice(this.cursorY, 1);
      this.buffer.splice(this.scrollBottom, 0, this.createEmptyRow());
    }
    this.markAllRowsDirty();
  }

  private setScrollRegion(topParam?: number, bottomParam?: number) {
    const top = topParam && topParam > 0 ? topParam - 1 : 0;
    const bottom = bottomParam && bottomParam > 0 ? bottomParam - 1 : this.rows - 1;

    if (top < 0 || bottom >= this.rows || top >= bottom) {
      return;
    }

    this.scrollTop = top;
    this.scrollBottom = bottom;
    this.cursorX = 0;
    this.cursorY = 0;
  }

  private scrollRegionUp(count: number, trackScrollback = false) {
    const amount = this.boundedCsiCount(count, this.scrollBottom - this.scrollTop + 1);
    if (!trackScrollback) {
      this.eraseTextSizingCrossingRowBoundary(this.scrollBottom + 1);
      this.eraseTextSizingIntersecting(
        this.scrollTop,
        this.scrollTop + amount - 1,
        0,
        this.cols - 1,
      );
    }

    this.markFullBufferDirty();
    if (!trackScrollback) this.scrollImagesInRegion(this.scrollTop, this.scrollBottom, -amount);
    let droppedScrollbackRows = 0;
    for (let i = 0; i < amount; i++) {
      const removedLine = this.buffer.splice(this.scrollTop, 1)[0];
      this.buffer.splice(this.scrollBottom, 0, this.createEmptyRow());

      if (trackScrollback && removedLine && !this.usingAlternateScreen) {
        this.scrollback.push(removedLine);
        if (this.scrollback.length > this.maxScrollback) {
          this.eraseTextSizingInAbsoluteRow(0);
          this.scrollback.shift();
          droppedScrollbackRows++;
        }
      }
    }
    if (droppedScrollbackRows > 0) {
      this.rebaseImageRows(droppedScrollbackRows);
    }
    this.markAllRowsDirty(); // scrollback 변경으로 전체 인덱스 무효화
  }

  private scrollImagesInRegion(top: number, bottom: number, delta: number) {
    if (delta === 0 || this.images.length === 0) return;
    const regionStart = this.scrollback.length + top;
    const regionEnd = this.scrollback.length + bottom + 1;
    const amount = Math.abs(delta);
    const sourceStart = delta < 0 ? regionStart + amount : regionStart;
    const sourceEnd = delta < 0 ? regionEnd : regionEnd - amount;
    const transformed: TerminalImage[] = [];

    for (const image of this.images) {
      const imageStart = image.row;
      const imageEnd = image.row + image.heightCells;
      if (imageStart < regionStart || imageEnd > regionEnd) {
        transformed.push(image);
        continue;
      }

      const survivingStart = Math.max(imageStart, sourceStart);
      const survivingEnd = Math.min(imageEnd, sourceEnd);
      if (survivingStart < survivingEnd) {
        transformed.push(this.sliceImageRows(image, survivingStart, survivingEnd, survivingStart + delta));
      }
    }
    const previousImages = this.images;
    this.images = transformed;
    if (transformed.length !== previousImages.length) this.imageCachePrunePending = true;
    this.deleteRelativeGroupsForRemovedPhysicalPlacements(previousImages, transformed);
  }

  private appendTerminalImage(image: TerminalImage) {
    const previousImages = this.images;
    const overflowCount = Math.max(0, previousImages.length + 1 - MAX_TERMINAL_IMAGES);
    this.images = previousImages.slice(overflowCount).concat(image);
    if (overflowCount > 0) {
      this.imageCachePrunePending = true;
      this.deleteRelativeGroupsForRemovedPhysicalPlacements(previousImages, this.images);
    }
  }
  private deleteRelativeGroupsForRemovedPhysicalPlacements(
    previousImages: TerminalImage[],
    nextImages: TerminalImage[],
  ) {
    const remainingKeys = new Set(nextImages
      .filter((image) => image.protocol === 'kitty' && image.imageId !== undefined)
      .map((image) => this.kittyVirtualPlacementKey(image.imageId!, image.placementId ?? null)));
    const removedKeys = previousImages
      .filter((image) => image.protocol === 'kitty' && image.imageId !== undefined)
      .map((image) => this.kittyVirtualPlacementKey(image.imageId!, image.placementId ?? null))
      .filter((key) => !remainingKeys.has(key));
    if (removedKeys.length === 0) return;

    const affectedImageIds = new Set<number>();
    this.deleteKittyRelativePlacementGroups(removedKeys, affectedImageIds);
    this.imageCachePrunePending = true;
    for (const imageId of affectedImageIds) {
      if (!this.hasKittyImageReference(imageId)) this.freeKittyImageData(imageId);
    }
  }

  private sliceImageRows(image: TerminalImage, start: number, end: number, destinationRow: number): TerminalImage {
    const destinationHeight = image.destinationPixelHeight ?? image.heightCells * this.cellPixelHeight;
    const startPixel = (start - image.row) * this.cellPixelHeight;
    const endPixel = (end - image.row) * this.cellPixelHeight;
    const clippedStart = Math.max(image.offsetY, startPixel);
    const clippedEnd = Math.min(image.offsetY + destinationHeight, endPixel);
    const clippedHeight = clippedEnd - clippedStart;
    const topFraction = (clippedStart - image.offsetY) / destinationHeight;
    const heightFraction = clippedHeight / destinationHeight;
    const offsetY = clippedStart - startPixel;
    return {
      ...image,
      id: this.nextImageId++,
      row: destinationRow,
      heightCells: Math.max(1, Math.ceil((offsetY + clippedHeight) / this.cellPixelHeight)),
      destinationPixelHeight: clippedHeight,
      sourceY: image.sourceY + image.sourceHeight * topFraction,
      sourceHeight: image.sourceHeight * heightFraction,
      offsetY,
    };
  }
  private recordKittyVirtualOrigin(
    placeholder: NonNullable<Cell['imagePlaceholder']>,
    row: number,
    col: number,
    placements = this.kittyVirtualPlacements,
  ) {
    const directKey = this.kittyVirtualPlacementKey(
      placeholder.imageId,
      placeholder.placementId ?? null,
    );
    let placement = placements.get(directKey);
    if (!placement && placeholder.placementId === undefined) {
      for (const candidate of placements.values()) {
        if (candidate.imageId !== placeholder.imageId) continue;
        placement = candidate;
        break;
      }
    }
    if (
      !placement ||
      placeholder.col >= placement.columns ||
      placeholder.row >= placement.rows
    ) return;
    placement.originRow =
      placement.originRow === undefined ? row : Math.min(placement.originRow, row);
    placement.originCol =
      placement.originCol === undefined ? col : Math.min(placement.originCol, col);
  }

  private refreshKittyVirtualOrigins() {
    const refresh = (placements: Map<string, KittyVirtualPlacement>, rows: Cell[][]) => {
      for (const placement of placements.values()) {
        placement.originRow = undefined;
        placement.originCol = undefined;
      }
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        for (let col = 0; col < row.length; col++) {
          const placeholder = row[col].imagePlaceholder;
          if (!placeholder) continue;
          this.recordKittyVirtualOrigin(placeholder, rowIndex, col, placements);
        }
      }
    };

    refresh(this.kittyVirtualPlacements, this.scrollback.concat(this.buffer));
    if (this.mainScreenBuffer) {
      refresh(
        this.mainScreenKittyVirtualPlacements,
        this.mainScreenScrollback.concat(this.mainScreenBuffer),
      );
    }
    this.kittyVirtualOriginsDirty = false;
  }

  private rebaseImageRows(droppedRows: number) {
    const previousImages = this.images;
    this.images = previousImages
      .map((image) => ({ ...image, row: image.row - droppedRows }))
      .filter((image) => image.row + image.heightCells > 0);
    if (this.images.length !== previousImages.length) this.imageCachePrunePending = true;
    for (const placement of this.kittyVirtualPlacements.values()) {
      if (placement.originRow !== undefined) placement.originRow -= droppedRows;
    }
    this.deleteRelativeGroupsForRemovedPhysicalPlacements(previousImages, this.images);
  }

  private scrollRegionDown(count: number) {
    const amount = this.boundedCsiCount(count, this.scrollBottom - this.scrollTop + 1);
    this.eraseTextSizingCrossingRowBoundary(this.scrollTop);
    this.eraseTextSizingIntersecting(
      this.scrollBottom - amount + 1,
      this.scrollBottom,
      0,
      this.cols - 1,
    );

    this.markFullBufferDirty();
    this.scrollImagesInRegion(this.scrollTop, this.scrollBottom, amount);
    for (let i = 0; i < amount; i++) {
      this.buffer.splice(this.scrollBottom, 1);
      this.buffer.splice(this.scrollTop, 0, this.createEmptyRow());
    }
    this.markAllRowsDirty(); // 행 이동으로 전체 인덱스 무효화
  }

  private handleSGR(params: number[]) {
    if (params.length === 0) params = [0];

    let i = 0;
    while (i < params.length) {
      const p = params[i];

      if (p === 0) {
        this.style = { ...DEFAULT_STYLE };
      } else if (p === 1) {
        this.style.bold = true;
      } else if (p === 2) {
        this.style.dim = true;
      } else if (p === 3) {
        this.style.italic = true;
      } else if (p === 4) {
        this.style.underline = true;
      } else if (p === 5 || p === 6) {
        // Blink — 무시 (시각적으로 미구현이지만 파싱은 해야 함)
      } else if (p === 7) {
        this.style.inverse = true;
      } else if (p === 8) {
        this.style.hidden = true;
      } else if (p === 9) {
        this.style.strikethrough = true;
      } else if (p === 22) {
        this.style.bold = false;
        this.style.dim = false;
      } else if (p === 23) {
        this.style.italic = false;
      } else if (p === 24) {
        this.style.underline = false;
      } else if (p === 25) {
        // Blink off — 무시
      } else if (p === 27) {
        this.style.inverse = false;
      } else if (p === 28) {
        this.style.hidden = false;
      } else if (p === 29) {
        this.style.strikethrough = false;
      } else if (p >= 30 && p <= 37) {
        const index = p - 30;
        this.style.fg = this.paletteColors[index];
        this.style.ansiFgIndex = index;
        this.style.kittyForegroundId = index;
      } else if (p === 38) {
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          const index = params[i + 2] & 0xff;
          this.style.fg = this.color256(index);
          this.style.ansiFgIndex = index;
          this.style.kittyForegroundId = params[i + 2] & 0xffffff;
          i += 2;
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          this.style.fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
          this.style.ansiFgIndex = undefined;
          this.style.kittyForegroundId =
            ((params[i + 2] & 0xff) << 16) | ((params[i + 3] & 0xff) << 8) | (params[i + 4] & 0xff);
          i += 4;
        }
      } else if (p === 39) {
        this.style.fg = DEFAULT_STYLE.fg;
        this.style.ansiFgIndex = undefined;
        this.style.kittyForegroundId = undefined;
      } else if (p >= 40 && p <= 47) {
        const index = p - 40;
        this.style.bg = this.paletteColors[index];
        this.style.ansiBgIndex = index;
      } else if (p === 48) {
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          const index = params[i + 2] & 0xff;
          this.style.bg = this.color256(index);
          this.style.ansiBgIndex = index;
          i += 2;
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          this.style.bg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
          this.style.ansiBgIndex = undefined;
          i += 4;
        }
      } else if (p === 49) {
        this.style.bg = DEFAULT_STYLE.bg;
        this.style.ansiBgIndex = undefined;
      } else if (p === 58) {
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          this.style.kittyUnderlineId = params[i + 2] & 0xffffff;
          i += 2;
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          this.style.kittyUnderlineId =
            ((params[i + 2] & 0xff) << 16) | ((params[i + 3] & 0xff) << 8) | (params[i + 4] & 0xff);
          i += 4;
        }
      } else if (p === 59) {
        this.style.kittyUnderlineId = undefined;
      } else if (p >= 90 && p <= 97) {
        const index = p - 90 + 8;
        this.style.fg = this.paletteColors[index];
        this.style.ansiFgIndex = index;
        this.style.kittyForegroundId = index;
      } else if (p >= 100 && p <= 107) {
        const index = p - 100 + 8;
        this.style.bg = this.paletteColors[index];
        this.style.ansiBgIndex = index;
      }

      i++;
    }
  }

  private color256(n: number): string {
    const index = Number.isFinite(n) ? Math.min(255, Math.max(0, Math.trunc(n))) : 0;
    return this.paletteColors[index];
  }

  // Check if character is wide (CJK, Korean, etc.)
  // East Asian Width "W"/"F"인 문자만 wide 처리. Emoji/PUA/기호는 narrow 유지 (터미널 표준)
  private isWideChar(char: string): boolean {
    const code = char.codePointAt(0)!;
    // Korean Hangul
    if (code >= 0xAC00 && code <= 0xD7AF) return true;
    if (code >= 0x1100 && code <= 0x11FF) return true;
    if (code >= 0x3130 && code <= 0x318F) return true;
    // CJK
    if (code >= 0x4E00 && code <= 0x9FFF) return true;
    if (code >= 0x3400 && code <= 0x4DBF) return true;
    if (code >= 0x20000 && code <= 0x2A6DF) return true; // CJK Ext-B
    if (code >= 0x2A700 && code <= 0x2CEAF) return true; // CJK Ext-C/D/E/F
    if (code >= 0xF900 && code <= 0xFAFF) return true;   // CJK Compatibility Ideographs
    // Japanese
    if (code >= 0x3040 && code <= 0x309F) return true;
    if (code >= 0x30A0 && code <= 0x30FF) return true;
    // Fullwidth
    if (code >= 0xFF00 && code <= 0xFFEF) return true;
    return false;
  }

  private normalizeTextSizingRows(rows: Cell[][]) {
    const groups = new Map<string, Array<{ row: number; col: number }>>();
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        const sizing = rows[row][col].textSizing;
        if (!sizing) continue;
        const validCoordinates =
          Number.isInteger(sizing.row) && Number.isInteger(sizing.col) &&
          sizing.row >= 0 && sizing.col >= 0;
        const key = validCoordinates
          ? (row - sizing.row) + ':' + (col - sizing.col)
          : 'invalid:' + row + ':' + col;
        const positions = groups.get(key) ?? [];
        positions.push({ row, col });
        groups.set(key, positions);
      }
    }

    for (const positions of groups.values()) {
      const first = positions[0];
      const sample = rows[first.row][first.col].textSizing!;
      const originRow = first.row - sample.row;
      const originCol = first.col - sample.col;
      const blockWidth = sample.scale * sample.width;
      const origin = rows[originRow]?.[originCol];
      const root = origin?.textSizing;
      const originTextBytes = origin && origin.char.length <= MAX_OSC_TEXT_BYTES
        ? OSC_TEXT_ENCODER.encode(origin.char).length
        : MAX_OSC_TEXT_BYTES + 1;
      let valid =
        Number.isInteger(sample.scale) && sample.scale >= 1 && sample.scale <= 7 &&
        Number.isInteger(sample.width) && sample.width >= 1 && sample.width <= 7 &&
        Number.isInteger(sample.numerator) && sample.numerator >= 0 && sample.numerator <= 15 &&
        Number.isInteger(sample.denominator) && sample.denominator >= 0 && sample.denominator <= 15 &&
        (sample.numerator === 0 && sample.denominator === 0 || sample.denominator > sample.numerator) &&
        Number.isInteger(sample.verticalAlign) && sample.verticalAlign >= 0 && sample.verticalAlign <= 2 &&
        Number.isInteger(sample.horizontalAlign) && sample.horizontalAlign >= 0 && sample.horizontalAlign <= 2 &&
        blockWidth <= this.cols && sample.scale <= this.rows &&
        originRow >= 0 && originCol >= 0 &&
        positions.length === blockWidth * sample.scale &&
        originTextBytes <= MAX_OSC_TEXT_BYTES &&
        root?.row === 0 && root.col === 0 &&
        (root.text?.length ?? MAX_OSC_TEXT_BYTES + 1) <= MAX_OSC_TEXT_BYTES &&
        root.text === origin.char;

      for (let row = 0; valid && row < sample.scale; row++) {
        for (let col = 0; col < blockWidth; col++) {
          const candidateCell = rows[originRow + row]?.[originCol + col];
          const candidate = candidateCell?.textSizing;
          if (
            !candidate || candidate.row !== row || candidate.col !== col ||
            candidate.scale !== sample.scale || candidate.width !== sample.width ||
            candidate.numerator !== sample.numerator || candidate.denominator !== sample.denominator ||
            candidate.verticalAlign !== sample.verticalAlign ||
            candidate.horizontalAlign !== sample.horizontalAlign ||
            (row === 0 && col === 0
              ? candidateCell.char !== origin?.char || candidate.text !== origin.char
              : candidateCell.char !== '' || candidate.text !== undefined)
          ) {
            valid = false;
            break;
          }
        }
      }
      if (valid && origin) {
        this.textSizingByteLengths.set(origin, originTextBytes);
      } else {
        for (const position of positions) {
          rows[position.row][position.col] = this.createEmptyCell();
        }
      }
    }
  }

  private eraseTextSizingIntersecting(
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
  ) {
    const targets = new Map<string, { row: number; col: number }>();
    for (let row = Math.max(0, startRow); row <= Math.min(this.rows - 1, endRow); row++) {
      for (let col = Math.max(0, startCol); col <= Math.min(this.cols - 1, endCol); col++) {
        const sizing = this.buffer[row][col].textSizing;
        if (!sizing) continue;
        const key = (row - sizing.row) + ':' + (col - sizing.col);
        if (!targets.has(key)) targets.set(key, { row, col });
      }
    }
    for (const target of targets.values()) this.eraseTextSizingAt(target.row, target.col);
  }

  private eraseTextSizingCrossingRowBoundary(boundaryRow: number) {
    if (boundaryRow <= 0 || boundaryRow >= this.rows) return;
    const row = this.buffer[boundaryRow];
    for (let col = 0; col < this.cols; col++) {
      const sizing = row[col].textSizing;
      if (sizing && sizing.row > 0) this.eraseTextSizingAt(boundaryRow, col);
    }
  }

  private getAbsoluteRow(absoluteRow: number): Cell[] | undefined {
    if (absoluteRow < 0) return undefined;
    return absoluteRow < this.scrollback.length
      ? this.scrollback[absoluteRow]
      : this.buffer[absoluteRow - this.scrollback.length];
  }

  private eraseTextSizingInAbsoluteRow(absoluteRow: number) {
    const row = this.getAbsoluteRow(absoluteRow);
    if (!row) return;
    for (let col = 0; col < row.length; col++) {
      if (row[col].textSizing) this.eraseTextSizingAbsoluteAt(absoluteRow, col);
    }
  }

  private eraseTextSizingAt(row: number, col: number) {
    this.eraseTextSizingAbsoluteAt(this.scrollback.length + row, col);
  }

  private eraseTextSizingAbsoluteAt(absoluteRow: number, col: number) {
    const sizing = this.getAbsoluteRow(absoluteRow)?.[col]?.textSizing;
    if (!sizing) return;
    const originRow = absoluteRow - sizing.row;
    const originCol = col - sizing.col;
    const blockWidth = sizing.scale * sizing.width;
    for (let y = 0; y < sizing.scale; y++) {
      const row = this.getAbsoluteRow(originRow + y);
      for (let x = 0; x < blockWidth; x++) {
        const candidate = row?.[originCol + x]?.textSizing;
        if (
          candidate && candidate.row === y && candidate.col === x &&
          candidate.scale === sizing.scale && candidate.width === sizing.width
        ) {
          row![originCol + x] = this.createEmptyCell();
          const bufferRow = originRow + y - this.scrollback.length;
          if (bufferRow >= 0) this.markRowDirty(bufferRow);
        }
      }
    }
    this.markFullBufferDirty();
  }

  private eraseWideCharAt(row: number, col: number) {
    const cells = this.buffer[row];
    const cell = cells?.[col];
    if (!cell) return;
    if (cell.char === '' && col > 0 && this.isWideChar(cells[col - 1].char)) {
      cells[col - 1] = this.createEmptyCell();
    }
    if (this.isWideChar(cell.char) && cells[col + 1]?.char === '') {
      cells[col + 1] = this.createEmptyCell();
    }
  }

  private combineTextSizingMarkAt(row: number, col: number, char: string): boolean {
    if (!/^\p{Mark}+$/u.test(char)) return false;
    const sizing = this.buffer[row]?.[col]?.textSizing;
    if (!sizing) return false;
    const originAbsoluteRow = this.scrollback.length + row - sizing.row;
    const originCol = col - sizing.col;
    const origin = originAbsoluteRow < this.scrollback.length
      ? this.scrollback[originAbsoluteRow]?.[originCol]
      : this.buffer[originAbsoluteRow - this.scrollback.length]?.[originCol];
    if (origin?.textSizing) {
      const currentBytes = this.textSizingByteLengths.get(origin) ??
        (origin.char.length <= MAX_OSC_TEXT_BYTES
          ? OSC_TEXT_ENCODER.encode(origin.char).length
          : MAX_OSC_TEXT_BYTES + 1);
      this.textSizingByteLengths.set(origin, currentBytes);
      const combinedBytes = currentBytes + OSC_TEXT_ENCODER.encode(char).length;
      if (combinedBytes <= MAX_OSC_TEXT_BYTES) {
        origin.char += char;
        origin.textSizing.text = origin.char;
        this.textSizingByteLengths.set(origin, combinedBytes);
        const bufferOriginRow = originAbsoluteRow - this.scrollback.length;
        if (bufferOriginRow >= 0) this.markRowDirty(bufferOriginRow);
      }
    }
    return true;
  }

  private prepareTextSizingWrite(
    char: string,
    cellWidth: number,
    blockHeight = 1,
    combineMark = true,
  ): boolean {
    const partialScrollRegion = this.scrollTop !== 0 || this.scrollBottom !== this.rows - 1;
    while (true) {
      if (this.cursorX >= this.cols || this.cursorX + cellWidth > this.cols) {
        if (!this.autoWrapMode) {
          this.cursorX = Math.max(0, this.cols - cellWidth);
        } else {
          const nextCursorY = this.cursorY === this.scrollBottom
            ? this.cursorY
            : Math.min(this.rows - 1, this.cursorY + 1);
          if (partialScrollRegion && nextCursorY + blockHeight > this.rows) return false;
          this.cursorX = 0;
          this.lineFeed();
        }
      }
      if (partialScrollRegion && this.cursorY + blockHeight > this.rows) return false;
      let skippedTo = this.cursorX;
      const intersecting: Array<{ row: number; col: number }> = [];
      for (let x = this.cursorX; x < Math.min(this.cols, this.cursorX + cellWidth); x++) {
        const sizing = this.buffer[this.cursorY][x].textSizing;
        if (!sizing) continue;
        if (combineMark && this.combineTextSizingMarkAt(this.cursorY, x, char)) return false;
        if (sizing.row > 0) {
          const blockEnd = x - sizing.col + sizing.scale * sizing.width;
          if (!this.autoWrapMode && blockEnd >= this.cols) {
            intersecting.push({ row: this.cursorY, col: x });
          } else {
            skippedTo = Math.max(skippedTo, blockEnd);
          }
        } else {
          intersecting.push({ row: this.cursorY, col: x });
        }
      }
      if (skippedTo > this.cursorX) {
        this.cursorX = skippedTo;
        continue;
      }
      for (const position of intersecting) {
        this.eraseTextSizingAt(position.row, position.col);
      }
      return true;
    }
  }

  private putTextSizingBlock(
    text: string,
    width: number,
    options: {
      scale: number;
      numerator: number;
      denominator: number;
      verticalAlign: 0 | 1 | 2;
      horizontalAlign: 0 | 1 | 2;
    },
  ) {
    const blockWidth = options.scale * width;
    if (blockWidth > this.cols || options.scale > this.rows) return;
    if (!this.prepareTextSizingWrite(text, blockWidth, options.scale)) return;

    const overflow = this.cursorY + options.scale - this.rows;
    if (overflow > 0) {
      if (this.scrollTop !== 0 || this.scrollBottom !== this.rows - 1) return;
      this.scrollRegionUp(overflow, !this.usingAlternateScreen);
      this.cursorY -= overflow;
    }

    for (let y = this.cursorY; y < this.cursorY + options.scale; y++) {
      for (let x = this.cursorX; x < this.cursorX + blockWidth; x++) {
        if (this.buffer[y][x].imagePlaceholder) this.kittyVirtualOriginsDirty = true;
        this.eraseTextSizingAt(y, x);
        this.eraseWideCharAt(y, x);
      }
    }

    const style = this.getInternedStyle(this.style);
    const originX = this.cursorX;
    for (let row = 0; row < options.scale; row++) {
      for (let col = 0; col < blockWidth; col++) {
        const cell: Cell = {
          char: row === 0 && col === 0 ? text : '',
          hyperlink: this.activeHyperlink ?? undefined,
          style,
          textSizing: {
            ...(row === 0 && col === 0 ? { text } : {}),
            scale: options.scale,
            width,
            numerator: options.numerator,
            denominator: options.denominator,
            verticalAlign: options.verticalAlign,
            horizontalAlign: options.horizontalAlign,
            row,
            col,
          },
        };
        this.buffer[this.cursorY + row][originX + col] = cell;
        if (row === 0 && col === 0) {
          this.textSizingByteLengths.set(cell, OSC_TEXT_ENCODER.encode(text).length);
        }
      }
      this.markRowDirty(this.cursorY + row);
    }
    this.cursorX += blockWidth;
  }

  private putChar(char: string) {
    const diacriticIndex = kittyDiacriticIndex(char);
    if (diacriticIndex !== null && this.cursorX > 0) {
      const previousCell = this.buffer[this.cursorY][this.cursorX - 1];
      const placeholder = previousCell.imagePlaceholder;
      if (placeholder && placeholder.diacriticCount < 3) {
        previousCell.char += char;
        const left = this.cursorX > 1
          ? this.buffer[this.cursorY][this.cursorX - 2].imagePlaceholder
          : undefined;
        const sameIdentity = left?.imageIdLow === placeholder.imageIdLow &&
          left.placementId === placeholder.placementId;
        if (placeholder.diacriticCount === 0) {
          placeholder.row = diacriticIndex;
          if (sameIdentity && left.row === diacriticIndex) {
            placeholder.col = left.col + 1;
            placeholder.imageIdHigh = left.imageIdHigh;
          } else {
            placeholder.col = 0;
            placeholder.imageIdHigh = 0;
          }
        } else if (placeholder.diacriticCount === 1) {
          placeholder.col = diacriticIndex;
          placeholder.imageIdHigh = sameIdentity &&
            left.row === placeholder.row && left.col + 1 === diacriticIndex
            ? left.imageIdHigh
            : 0;
        } else {
          placeholder.imageIdHigh = diacriticIndex;
        }
        placeholder.imageId = placeholder.imageIdLow + placeholder.imageIdHigh * 0x1000000;
        placeholder.diacriticCount++;
        this.recordKittyVirtualOrigin(
          placeholder,
          this.scrollback.length + this.cursorY,
          this.cursorX - 1,
        );
        this.markRowDirty(this.cursorY);
        return;
      }
    }

    const isWide = this.isWideChar(char);
    if (this.cursorX >= this.cols || (isWide && this.cursorX >= this.cols - 1)) {
      if (this.autoWrapMode) {
        this.cursorX = 0;
        this.lineFeed();
      } else {
        this.cursorX = Math.max(0, this.cols - (isWide ? 2 : 1));
      }
    }
    if (!this.prepareTextSizingWrite(char, isWide ? 2 : 1)) return;

    const cell: Cell = {
      char,
      hyperlink: this.activeHyperlink ?? undefined,
      style: this.getInternedStyle(this.style),
    };
    if (char.codePointAt(0) === 0x10eeee && this.style.kittyForegroundId !== undefined) {
      const previous = this.cursorX > 0 ? this.buffer[this.cursorY][this.cursorX - 1].imagePlaceholder : undefined;
      const imageIdLow = this.style.kittyForegroundId & 0xffffff;
      const placementId = this.style.kittyUnderlineId;
      const inherited = previous?.imageIdLow === imageIdLow && previous.placementId === placementId;
      cell.imagePlaceholder = {
        renderId: this.nextImageId++,
        imageId: inherited ? imageIdLow + previous.imageIdHigh * 0x1000000 : imageIdLow,
        imageIdLow,
        imageIdHigh: inherited ? previous.imageIdHigh : 0,
        placementId,
        row: inherited ? previous.row : 0,
        col: inherited ? previous.col + 1 : 0,
        diacriticCount: 0,
      };
    }
    if (this.buffer[this.cursorY][this.cursorX].imagePlaceholder) {
      this.kittyVirtualOriginsDirty = true;
    }
    this.buffer[this.cursorY][this.cursorX] = cell;
    if (cell.imagePlaceholder) {
      this.recordKittyVirtualOrigin(
        cell.imagePlaceholder,
        this.scrollback.length + this.cursorY,
        this.cursorX,
      );
    }
    this.markRowDirty(this.cursorY);
    this.lastPrintedChar = char;
    this.cursorX++;

    if (isWide && this.cursorX < this.cols) {
      if (this.buffer[this.cursorY][this.cursorX].imagePlaceholder) {
        this.kittyVirtualOriginsDirty = true;
      }
      this.buffer[this.cursorY][this.cursorX] = {
        char: '',
        hyperlink: this.activeHyperlink ?? undefined,
        style: this.getInternedStyle(this.style),
      };
      this.cursorX++;
    }
  }

  private getStyleKey(style: TextStyle): string {
    return `fg:${style.fg ?? 'default'}|bg:${style.bg}|fi:${style.ansiFgIndex ?? ''}|bi:${style.ansiBgIndex ?? ''}|b:${style.bold ? 1 : 0}|d:${style.dim ? 1 : 0}|i:${style.italic ? 1 : 0}|u:${style.underline ? 1 : 0}|v:${style.inverse ? 1 : 0}|s:${style.strikethrough ? 1 : 0}|h:${style.hidden ? 1 : 0}|ki:${style.kittyForegroundId ?? ''}|kp:${style.kittyUnderlineId ?? ''}`;
  }

  private getInternedStyle(style: TextStyle): TextStyle {
    const key = this.getStyleKey(style);
    const cached = this.stylePool.get(key);
    if (cached) {
      // Keep recently used styles hot and allow old truecolor styles to age out.
      this.stylePool.delete(key);
      this.stylePool.set(key, cached);
      return cached;
    }

    this.evictStylePoolIfNeeded();

    const frozen = Object.freeze({ ...style });
    this.stylePool.set(key, frozen);
    return frozen;
  }

  private evictStylePoolIfNeeded() {
    while (this.stylePool.size >= MAX_STYLE_POOL_SIZE) {
      const oldestKey = this.stylePool.keys().next().value as string | undefined;
      if (!oldestKey) return;
      if (oldestKey === DEFAULT_STYLE_KEY) {
        const defaultStyle = this.stylePool.get(DEFAULT_STYLE_KEY);
        this.stylePool.delete(DEFAULT_STYLE_KEY);
        if (defaultStyle) this.stylePool.set(DEFAULT_STYLE_KEY, defaultStyle);
        continue;
      }
      this.stylePool.delete(oldestKey);
    }
  }

  private lineFeed() {
    if (this.cursorY === this.scrollBottom) {
      const trackScrollback = !this.usingAlternateScreen && this.scrollTop === 0 && this.scrollBottom === this.rows - 1;
      this.scrollRegionUp(1, trackScrollback); // scrollRegionUp이 markAllRowsDirty 호출
    } else if (this.cursorY < this.rows - 1) {
      this.cursorY++;
      this.markRowDirty(this.cursorY);
    }
  }

  private eraseInDisplay(mode: number) {
    this.markFullBufferDirty();
    if (mode === 0) {
      this.eraseTextSizingIntersecting(this.cursorY, this.cursorY, this.cursorX, this.cols - 1);
      this.eraseTextSizingIntersecting(this.cursorY + 1, this.rows - 1, 0, this.cols - 1);
      this.eraseInLine(0);
      for (let y = this.cursorY + 1; y < this.rows; y++) {
        this.buffer[y] = this.createEmptyRow();
        this.markRowDirty(y);
      }
    } else if (mode === 1) {
      this.eraseTextSizingIntersecting(0, this.cursorY - 1, 0, this.cols - 1);
      this.eraseTextSizingIntersecting(this.cursorY, this.cursorY, 0, this.cursorX);
      for (let y = 0; y < this.cursorY; y++) {
        this.buffer[y] = this.createEmptyRow();
        this.markRowDirty(y);
      }
      this.eraseInLine(1);
    } else if (mode === 2) {
      this.eraseTextSizingIntersecting(0, this.rows - 1, 0, this.cols - 1);
      this.buffer = this.createBuffer();
      this.imageCachePrunePending = true;
      this.images = [];
      this.kittyVirtualPlacements.clear();
      this.kittyRelativePlacements.clear();
      this.pendingKittyImage = null;
      this.pendingITerm2File = null;
      this.markAllRowsDirty();
    } else if (mode === 3) {
      this.scrollback = [];
      this.buffer = this.createBuffer();
      this.imageCachePrunePending = true;
      this.images = [];
      this.kittyVirtualPlacements.clear();
      this.kittyRelativePlacements.clear();
      this.pendingKittyImage = null;
      this.pendingITerm2File = null;
      this.markAllRowsDirty();
    }
  }

  private eraseInLine(mode: number) {
    const row = this.buffer[this.cursorY];
    if (mode === 0) {
      this.eraseTextSizingIntersecting(this.cursorY, this.cursorY, this.cursorX, this.cols - 1);
      for (let x = this.cursorX; x < this.cols; x++) row[x] = this.createEmptyCell();
    } else if (mode === 1) {
      this.eraseTextSizingIntersecting(this.cursorY, this.cursorY, 0, this.cursorX);
      for (let x = 0; x <= this.cursorX; x++) row[x] = this.createEmptyCell();
    } else if (mode === 2) {
      this.eraseTextSizingIntersecting(this.cursorY, this.cursorY, 0, this.cols - 1);
      this.markFullBufferDirty();
      this.buffer[this.cursorY] = this.createEmptyRow();
    }
    this.markRowDirty(this.cursorY);
    this.kittyVirtualOriginsDirty = true;
  }

  getBuffer(): Cell[][] {
    return this.buffer;
  }

  // 스크롤백 + 현재 화면 전체 반환
  getFullBuffer(): Cell[][] {
    if (this.fullBufferDirty) {
      this.fullBufferCache = this.scrollback.concat(this.buffer);
      this.fullBufferDirty = false;
    }
    return this.fullBufferCache;
  }

  getImages(startRow = 0, endRow = Number.POSITIVE_INFINITY): TerminalImage[] {
    if (this.kittyVirtualOriginsDirty) this.refreshKittyVirtualOrigins();
    const rows = this.getFullBuffer();
    const visibleStart = Math.max(0, startRow);
    const visibleEnd = Math.min(rows.length, endRow);
    const intersectsVisibleRows = (image: TerminalImage) =>
      image.row < visibleEnd && image.row + image.heightCells > visibleStart;
    if (this.kittyVirtualPlacements.size === 0 && this.kittyRelativePlacements.size === 0) {
      return this.images.filter(intersectsVisibleRows);
    }
    const scanStart = visibleStart;
    const scanEnd = visibleEnd;
    const placeholders: TerminalImage[] = [];
    const virtualOrigins = new Map<string, { row: number; col: number }>();
    for (const [key, placement] of this.kittyVirtualPlacements) {
      if (placement.originRow === undefined || placement.originCol === undefined) continue;
      virtualOrigins.set(key, { row: placement.originRow, col: placement.originCol });
    }
    const virtualFits = new Map<string, { scale: number; offsetX: number; offsetY: number }>();
    for (let rowIndex = scanStart; rowIndex < scanEnd; rowIndex++) {
      const row = rows[rowIndex];
      for (let col = 0; col < row.length; col++) {
        const placeholder = row[col].imagePlaceholder;
        if (!placeholder) continue;
        let key = this.kittyVirtualPlacementKey(placeholder.imageId, placeholder.placementId ?? null);
        let virtualPlacement = this.kittyVirtualPlacements.get(key);
        if (!virtualPlacement && !placeholder.placementId) {
          for (const [candidateKey, candidate] of this.kittyVirtualPlacements) {
            if (candidate.imageId !== placeholder.imageId) continue;
            key = candidateKey;
            virtualPlacement = candidate;
            break;
          }
        }
        const storedData = this.kittyImageData.get(placeholder.imageId);
        if (!virtualPlacement || !storedData) continue;
        if (placeholder.col >= virtualPlacement.columns || placeholder.row >= virtualPlacement.rows) continue;
        const previousOrigin = virtualOrigins.get(key);
        const origin = {
          row: previousOrigin ? Math.min(previousOrigin.row, rowIndex) : rowIndex,
          col: previousOrigin ? Math.min(previousOrigin.col, col) : col,
        };
        virtualOrigins.set(key, origin);
        virtualPlacement.originRow = origin.row;
        virtualPlacement.originCol = origin.col;
        if (rowIndex < visibleStart || rowIndex >= visibleEnd) continue;

        const imageData = storedData.animation
          ? storedData.animation.frames[storedData.animation.currentFrame]?.data ?? storedData
          : storedData;
        let fit = virtualFits.get(key);
        if (!fit) {
          const boxWidth = virtualPlacement.columns * this.cellPixelWidth;
          const boxHeight = virtualPlacement.rows * this.cellPixelHeight;
          const scale = Math.min(boxWidth / imageData.pixelWidth, boxHeight / imageData.pixelHeight);
          fit = {
            scale,
            offsetX: (boxWidth - imageData.pixelWidth * scale) / 2,
            offsetY: (boxHeight - imageData.pixelHeight * scale) / 2,
          };
          virtualFits.set(key, fit);
        }

        const cellLeft = placeholder.col * this.cellPixelWidth;
        const cellTop = placeholder.row * this.cellPixelHeight;
        const drawLeft = Math.max(cellLeft, fit.offsetX);
        const drawTop = Math.max(cellTop, fit.offsetY);
        const drawRight = Math.min(cellLeft + this.cellPixelWidth, fit.offsetX + imageData.pixelWidth * fit.scale);
        const drawBottom = Math.min(cellTop + this.cellPixelHeight, fit.offsetY + imageData.pixelHeight * fit.scale);
        if (drawLeft >= drawRight || drawTop >= drawBottom) continue;

        const sourceX = (drawLeft - fit.offsetX) / fit.scale;
        const sourceY = (drawTop - fit.offsetY) / fit.scale;
        const sourceWidth = (drawRight - drawLeft) / fit.scale;
        const sourceHeight = (drawBottom - drawTop) / fit.scale;
        const common = {
          id: placeholder.renderId,
          protocol: 'kitty' as const,
          dataId: this.kittyImageCacheId(imageData),
          imageId: placeholder.imageId,
          imageNumber: virtualPlacement.imageNumber,
          placementId: placeholder.placementId,
          row: rowIndex,
          col,
          widthCells: (drawRight - drawLeft) / this.cellPixelWidth,
          heightCells: (drawBottom - drawTop) / this.cellPixelHeight,
          pixelWidth: imageData.pixelWidth,
          pixelHeight: imageData.pixelHeight,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          offsetX: drawLeft - cellLeft,
          offsetY: drawTop - cellTop,
          zIndex: virtualPlacement.zIndex,
        };
        placeholders.push(
          imageData.kind === 'png'
            ? { ...common, kind: 'png', mimeType: imageData.mimeType, data: imageData.data }
            : { ...common, kind: 'rgba', data: imageData.data },
        );
      }
    }

    const result = this.images.concat(placeholders);
    const pending = new Map(this.kittyRelativePlacements);
    for (let depth = 0; depth < 8 && pending.size > 0; depth++) {
      let progressed = false;
      for (const [key, relative] of pending) {
        const parentKey = this.kittyVirtualPlacementKey(
          relative.parentImageId,
          relative.parentPlacementId ?? null,
        );
        const virtualOrigin = virtualOrigins.get(parentKey);
        const parentPlacements = virtualOrigin
          ? []
          : result.filter((candidate) =>
              candidate.protocol === 'kitty' &&
              candidate.imageId === relative.parentImageId &&
              candidate.placementId === relative.parentPlacementId);
        if (!virtualOrigin && parentPlacements.length === 0) continue;
        const parentRow = virtualOrigin
          ? virtualOrigin.row
          : Math.min(...parentPlacements.map((parent) => parent.row));
        const parentCol = virtualOrigin
          ? virtualOrigin.col
          : Math.min(...parentPlacements.map((parent) => parent.col));
        const storedData = this.kittyImageData.get(relative.imageId);
        if (!storedData) {
          pending.delete(key);
          continue;
        }
        const imageData = storedData.animation
          ? storedData.animation.frames[storedData.animation.currentFrame]?.data ?? storedData
          : storedData;
        const common = {
          id: relative.id,
          protocol: 'kitty' as const,
          dataId: this.kittyImageCacheId(imageData),
          imageId: relative.imageId,
          imageNumber: relative.imageNumber,
          placementId: relative.placementId,
          row: parentRow + relative.verticalOffset,
          col: parentCol + relative.horizontalOffset,
          widthCells: relative.widthCells,
          heightCells: relative.heightCells,
          pixelWidth: imageData.pixelWidth,
          pixelHeight: imageData.pixelHeight,
          sourceX: relative.sourceX,
          sourceY: relative.sourceY,
          sourceWidth: relative.sourceWidth,
          sourceHeight: relative.sourceHeight,
          offsetX: relative.offsetX,
          offsetY: relative.offsetY,
          zIndex: relative.zIndex,
        };
        result.push(
          imageData.kind === 'png'
            ? { ...common, kind: 'png', mimeType: imageData.mimeType, data: imageData.data }
            : { ...common, kind: 'rgba', data: imageData.data },
        );
        pending.delete(key);
        progressed = true;
      }
      if (!progressed) break;
    }
    return result.filter(intersectsVisibleRows);
  }

  getScrollbackLength(): number {
    return this.scrollback.length;
  }

  /**
   * 변경된 행 인덱스 반환 (buffer 내부 인덱스 기준).
   * 'all'이면 전체 다시 그리기 필요.
   * 사용 시 scrollback.length를 더해서 fullBuffer 인덱스로 변환할 것.
   */
  getDirtyRows(): Set<number> | 'all' {
    if (this.allDirty) return 'all';
    return this.dirtyRows;
  }

  clearDirtyRows() {
    this.dirtyRows.clear();
    this.allDirty = false;
  }

  /** 외부에서 전체 다시 그리기 강제 (visibility change, resize 등) */
  markAllDirty() {
    this.allDirty = true;
    this.dirtyRows.clear();
  }

  getCursor(): { x: number; y: number } {
    return { x: this.cursorX, y: this.cursorY };
  }

  isApplicationCursorKeys(): boolean {
    return this.applicationCursorKeys;
  }

  getKittyKeyboardFlags(): number {
    return this.usingAlternateScreen
      ? this.kittyKeyboardAlternateFlags
      : this.kittyKeyboardMainFlags;
  }

  isBracketedPasteMode(): boolean {
    return this.bracketedPasteMode;
  }

  isCursorVisible(): boolean {
    return this.cursorVisible;
  }

  isSynchronizedOutput(): boolean {
    return this.synchronizedOutput;
  }

  isAlternateScreen(): boolean {
    return this.usingAlternateScreen;
  }

  isMouseEnabled(): boolean {
    return this.mouseMode > 0;
  }

  shouldReportMouseMotion(buttonPressed: boolean): boolean {
    return this.mouseMode === 1003 || (buttonPressed && this.mouseMode === 1002);
  }

  shouldReportMouseRelease(): boolean {
    return this.mouseMode !== 0 && this.mouseMode !== 9;
  }

  isSgrMouseEncoding(): boolean {
    return this.sgrMouseEncoding;
  }

  // 스크롤백을 포함한 전체에서의 커서 위치
  getFullCursor(): { x: number; y: number } {
    return { x: this.cursorX, y: this.cursorY + this.scrollback.length };
  }

  getCols(): number {
    return this.cols;
  }

  getRows(): number {
    return this.rows;
  }

  private cloneRuntimeImageState(): TerminalRuntimeImageState {
    if (this.kittyVirtualOriginsDirty) this.refreshKittyVirtualOrigins();
    const byteClones = new Map<
      Uint8Array | Uint8ClampedArray,
      Uint8Array | Uint8ClampedArray
    >();
    const cloneBytes = <T extends Uint8Array | Uint8ClampedArray>(data: T): T => {
      const existing = byteClones.get(data);
      if (existing) return existing as T;
      const cloned = data instanceof Uint8ClampedArray
        ? new Uint8ClampedArray(data)
        : new Uint8Array(data);
      byteClones.set(data, cloned);
      return cloned as T;
    };
    const kittyDataClones = new Map<KittyImageData, KittyImageData>();
    const cloneKittyData = (source: KittyImageData): KittyImageData => {
      const existing = kittyDataClones.get(source);
      if (existing) return existing;
      const cloned: KittyImageData = source.kind === 'png'
        ? {
            kind: 'png',
            pixelWidth: source.pixelWidth,
            pixelHeight: source.pixelHeight,
            imageNumber: source.imageNumber,
            mimeType: source.mimeType,
            data: cloneBytes(source.data),
          }
        : {
            kind: 'rgba',
            pixelWidth: source.pixelWidth,
            pixelHeight: source.pixelHeight,
            imageNumber: source.imageNumber,
            data: cloneBytes(source.data),
          };
      kittyDataClones.set(source, cloned);
      if (source.animation) {
        cloned.animation = {
          ...source.animation,
          frames: source.animation.frames.map((frame) => ({
            gap: frame.gap,
            data: cloneKittyData(frame.data),
          })),
        };
      }
      return cloned;
    };
    const cloneImage = (image: TerminalImage): TerminalImage => ({
      ...image,
      data: cloneBytes(image.data),
    }) as TerminalImage;
    const kittyImageCacheIds: Array<[number, number]> = [];
    for (const [imageId, imageData] of this.kittyImageData) {
      const cacheId = this.kittyImageCacheIds.get(imageData);
      if (cacheId !== undefined) kittyImageCacheIds.push([imageId, cacheId]);
    }
    return {
      images: this.images.map(cloneImage),
      mainScreenImages: this.mainScreenImages.map(cloneImage),
      kittyImageData: [...this.kittyImageData].map(([imageId, data]) => [imageId, cloneKittyData(data)]),
      kittyImageCacheIds,
      kittyVirtualPlacements: [...this.kittyVirtualPlacements].map(([key, value]) => [key, { ...value }]),
      kittyRelativePlacements: [...this.kittyRelativePlacements].map(([key, value]) => [key, { ...value }]),
      mainScreenKittyVirtualPlacements: [...this.mainScreenKittyVirtualPlacements].map(
        ([key, value]) => [key, { ...value }],
      ),
      mainScreenKittyRelativePlacements: [...this.mainScreenKittyRelativePlacements].map(
        ([key, value]) => [key, { ...value }],
      ),
      kittyImageNumbers: [...this.kittyImageNumbers],
      nextImageId: this.nextImageId,
      nextKittyImageId: this.nextKittyImageId,
    };
  }

  createRuntimeSnapshot(): TerminalSnapshot {
    return {
      ...this.createSnapshot(),
      runtimeImageState: this.cloneRuntimeImageState(),
    };
  }


  createSnapshot(): TerminalSnapshot {
    return {
      bufferRows: this.cloneBuffer(this.buffer),
      scrollbackRows: this.cloneBuffer(this.scrollback),
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      applicationCursorKeys: this.applicationCursorKeys,
      autoWrapMode: this.autoWrapMode,
      bracketedPasteMode: this.bracketedPasteMode,
      mouseMode: this.mouseMode,
      sgrMouseEncoding: this.sgrMouseEncoding,
      usingAlternateScreen: this.usingAlternateScreen,
      kittyKeyboard: {
        mainFlags: this.kittyKeyboardMainFlags,
        alternateFlags: this.kittyKeyboardAlternateFlags,
        mainStack: [...this.kittyKeyboardMainStack],
        alternateStack: [...this.kittyKeyboardAlternateStack],
      },
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
      outputOffset: 0,
      oscTitle: this.oscTitle,
      cursorVisible: this.cursorVisible,
      synchronizedOutput: this.synchronizedOutput,
      oscCurrentDirectoryUri: this.oscCurrentDirectoryUri ?? undefined,
      oscPalette: [...this.paletteColors],
      oscColors: { ...this.oscColors },
      oscShellIntegration: { ...this.shellIntegration },
      oscActiveHyperlink: this.activeHyperlink ? { ...this.activeHyperlink } : undefined,
      mainScreenBufferRows: this.mainScreenBuffer ? this.cloneBuffer(this.mainScreenBuffer) : undefined,
      mainScreenScrollbackRows: this.cloneBuffer(this.mainScreenScrollback),
      mainScreenCursor: { ...this.mainScreenCursor },
      mainScreenScrollRegion: { ...this.mainScreenScrollRegion },
      parserState: this.parseState,
      parserEscapeBuffer: this.escapeBuffer,
      parserStyle: { ...this.style },
      parserSavedCursor: { ...this.savedCursor },
      parserLastPrintedChar: this.lastPrintedChar,
      pendingKittyImage: this.pendingKittyImage
        ? {
            row: this.pendingKittyImage.row,
            col: this.pendingKittyImage.col,
            params: [...this.pendingKittyImage.params],
            chunks: [...this.pendingKittyImage.chunks],
            encodedLength: this.pendingKittyImage.encodedLength,
          }
        : undefined,
      pendingITerm2File: this.pendingITerm2File
        ? {
            args: [...this.pendingITerm2File.args],
            chunks: [...this.pendingITerm2File.chunks],
            encodedLength: this.pendingITerm2File.encodedLength,
          }
        : undefined,
    };
  }

  private clearRetainedImageState() {
    this.imageCachePrunePending = true;
    this.images = [];
    this.mainScreenImages = [];
    this.nextImageId = 1;
    this.kittyImageCacheIds = new WeakMap();
    this.kittyImageData.clear();
    this.kittyVirtualPlacements.clear();
    this.kittyRelativePlacements.clear();
    this.mainScreenKittyVirtualPlacements.clear();
    this.mainScreenKittyRelativePlacements.clear();
    this.kittyImageNumbers.clear();
    this.nextKittyImageId = 1;
    this.pendingKittyImage = null;
    this.pendingITerm2File = null;
  }

  private restoreRuntimeImageState(
    state: TerminalRuntimeImageState | undefined,
    removedTopRows: number,
    retainedRows: number,
    removedMainScreenTopRows: number,
    retainedMainScreenRows: number,
  ): boolean {
    if (
      !state ||
      !Array.isArray(state.images) ||
      !Array.isArray(state.mainScreenImages) ||
      !Array.isArray(state.kittyImageData) ||
      !Array.isArray(state.kittyVirtualPlacements) ||
      !Array.isArray(state.kittyRelativePlacements) ||
      !Array.isArray(state.mainScreenKittyVirtualPlacements) ||
      !Array.isArray(state.mainScreenKittyRelativePlacements) ||
      !Array.isArray(state.kittyImageNumbers)
    ) {
      return false;
    }
    const isImageData = (data: unknown): data is Uint8Array | Uint8ClampedArray =>
      data instanceof Uint8Array || data instanceof Uint8ClampedArray;
    if (
      !state.images.every((image) => isImageData(image?.data)) ||
      !state.mainScreenImages.every((image) => isImageData(image?.data)) ||
      !state.kittyImageData.every((entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        isImageData(entry[1]?.data) &&
        (entry[1].animation?.frames.every((frame) => isImageData(frame.data?.data)) ?? true)
      )
    ) {
      return false;
    }

    const adjustImageRows = (
      images: TerminalImage[],
      removedRows: number,
      retainedRowCount: number,
    ): TerminalImage[] => images
      .map((image) => ({ ...image, row: image.row - removedRows }))
      .filter((image) => image.row < retainedRowCount && image.row + image.heightCells > 0);
    const adjustVirtualRows = (
      entries: Array<[string, KittyVirtualPlacement]>,
      removedRows: number,
      retainedRowCount: number,
    ): Array<[string, KittyVirtualPlacement]> => entries
      .map(([key, placement]): [string, KittyVirtualPlacement] => [
        key,
        placement.originRow === undefined
          ? { ...placement }
          : { ...placement, originRow: placement.originRow - removedRows },
      ])
      .filter(([, placement]) =>
        placement.originRow === undefined ||
        (placement.originRow < retainedRowCount && placement.originRow + placement.rows > 0)
      );
    const adjustRelativePlacements = (
      entries: Array<[string, KittyRelativePlacement]>,
      images: TerminalImage[],
      virtualPlacements: Map<string, KittyVirtualPlacement>,
    ): Array<[string, KittyRelativePlacement]> => {
      const retainedKeys = new Set(virtualPlacements.keys());
      for (const image of images) {
        if (image.protocol === 'kitty' && image.imageId !== undefined) {
          retainedKeys.add(this.kittyVirtualPlacementKey(image.imageId, image.placementId ?? null));
        }
      }
      const pending = new Map(entries.map(([key, placement]) => [key, { ...placement }]));
      const retained: Array<[string, KittyRelativePlacement]> = [];
      let added = true;
      while (added) {
        added = false;
        for (const [key, placement] of pending) {
          const parentKey = this.kittyVirtualPlacementKey(
            placement.parentImageId,
            placement.parentPlacementId ?? null,
          );
          if (!retainedKeys.has(parentKey)) continue;
          retained.push([key, placement]);
          retainedKeys.add(key);
          pending.delete(key);
          added = true;
        }
      }
      return retained;
    };

    this.images = adjustImageRows(state.images, removedTopRows, retainedRows);
    this.mainScreenImages = adjustImageRows(
      state.mainScreenImages,
      removedMainScreenTopRows,
      retainedMainScreenRows,
    );
    this.kittyImageData = new Map(state.kittyImageData);
    this.kittyImageCacheIds = new WeakMap();
    for (const [imageId, cacheId] of state.kittyImageCacheIds ?? []) {
      const imageData = this.kittyImageData.get(imageId);
      if (imageData && Number.isSafeInteger(cacheId) && cacheId > 0) {
        this.kittyImageCacheIds.set(imageData, cacheId);
      }
    }
    this.kittyVirtualPlacements = new Map(
      adjustVirtualRows(state.kittyVirtualPlacements, removedTopRows, retainedRows),
    );
    this.kittyRelativePlacements = new Map(
      adjustRelativePlacements(
        state.kittyRelativePlacements,
        this.images,
        this.kittyVirtualPlacements,
      ),
    );
    this.mainScreenKittyVirtualPlacements = new Map(
      adjustVirtualRows(
        state.mainScreenKittyVirtualPlacements,
        removedMainScreenTopRows,
        retainedMainScreenRows,
      ),
    );
    this.mainScreenKittyRelativePlacements = new Map(
      adjustRelativePlacements(
        state.mainScreenKittyRelativePlacements,
        this.mainScreenImages,
        this.mainScreenKittyVirtualPlacements,
      ),
    );
    this.kittyImageNumbers = new Map(state.kittyImageNumbers);
    this.nextImageId = Number.isSafeInteger(state.nextImageId) && state.nextImageId > 0
      ? state.nextImageId
      : 1;
    this.nextKittyImageId = Number.isSafeInteger(state.nextKittyImageId) && state.nextKittyImageId > 0
      ? state.nextKittyImageId
      : 1;
    this.kittyVirtualOriginsDirty = true;
    return true;
  }


  private clearRestoredImagePlaceholders() {
    const buffers = [this.buffer, this.scrollback, this.mainScreenBuffer, this.mainScreenScrollback];
    for (const rows of buffers) {
      if (!rows) continue;
      for (const row of rows) {
        for (const cell of row) delete cell.imagePlaceholder;
      }
    }
  }

  private isTerminalParseState(value: unknown): value is TerminalParseState {
    switch (value) {
      case 'normal':
      case 'escape':
      case 'csi':
      case 'csiDiscard':
      case 'osc':
      case 'oscEscape':
      case 'oscDiscard':
      case 'oscDiscardEscape':
      case 'ss3':
      case 'charset':
      case 'apc':
      case 'apcEscape':
      case 'apcDiscard':
      case 'apcDiscardEscape':
      case 'dcs':
      case 'dcsEscape':
      case 'dcsDiscard':
      case 'dcsDiscardEscape':
        return true;
      default:
        return false;
    }
  }

  private restoreSnapshotStringMap(value: unknown): Map<string, string> | null {
    if (!Array.isArray(value) || value.length > MAX_CONTROL_FIELDS) return null;
    const result = new Map<string, string>();
    let totalLength = 0;
    for (const entry of value) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'string'
      ) {
        return null;
      }
      totalLength += entry[0].length + entry[1].length;
      if (totalLength > MAX_IMAGE_METADATA_CHARS) return null;
      result.set(entry[0], entry[1]);
    }
    return result;
  }

  private restoreSnapshotChunks(value: unknown): { chunks: string[]; encodedLength: number } | null {
    if (!Array.isArray(value) || value.length > MAX_IMAGE_CHUNKS) return null;
    const chunks: string[] = [];
    let encodedLength = 0;
    for (const chunk of value) {
      if (typeof chunk !== 'string') return null;
      encodedLength += chunk.length;
      if (encodedLength > MAX_IMAGE_BASE64_CHARS) return null;
      chunks.push(chunk);
    }
    return { chunks, encodedLength };
  }

  private restoreSnapshotTextStyle(value: unknown): TextStyle {
    if (!value || typeof value !== 'object') return this.getInternedStyle(DEFAULT_STYLE);
    const record = value as Record<string, unknown>;
    const color = (candidate: unknown, fallback: string | null): string | null =>
      candidate === null || (typeof candidate === 'string' && candidate.length <= 128)
        ? candidate as string | null
        : fallback;
    const optionalIndex = (candidate: unknown): number | undefined =>
      Number.isInteger(candidate) && (candidate as number) >= 0 && (candidate as number) <= 0xffffffff
        ? candidate as number
        : undefined;
    return this.getInternedStyle({
      fg: color(record.fg, DEFAULT_STYLE.fg),
      bg: color(record.bg, DEFAULT_STYLE.bg) ?? DEFAULT_STYLE.bg,
      bold: record.bold === true,
      dim: record.dim === true,
      italic: record.italic === true,
      underline: record.underline === true,
      inverse: record.inverse === true,
      strikethrough: record.strikethrough === true,
      hidden: record.hidden === true,
      ansiFgIndex: optionalIndex(record.ansiFgIndex),
      ansiBgIndex: optionalIndex(record.ansiBgIndex),
      kittyForegroundId: optionalIndex(record.kittyForegroundId),
      kittyUnderlineId: optionalIndex(record.kittyUnderlineId),
    });
  }

  private restoreParserStreamState(snapshot: TerminalSnapshot, removedTopRows: number) {
    const escapeBuffer = typeof snapshot.parserEscapeBuffer === 'string'
      ? snapshot.parserEscapeBuffer
      : '';
    const maxEscapeBufferChars =
      snapshot.parserState === 'apc' || snapshot.parserState === 'apcEscape'
        ? MAX_KITTY_APC_SEQUENCE_CHARS
        : MAX_CONTROL_SEQUENCE_CHARS;
    if (
      this.isTerminalParseState(snapshot.parserState) &&
      escapeBuffer.length <= maxEscapeBufferChars
    ) {
      this.parseState = snapshot.parserState;
      this.escapeBuffer = escapeBuffer;
    } else {
      this.parseState = 'normal';
      this.escapeBuffer = '';
    }
    this.style = this.restoreSnapshotTextStyle(snapshot.parserStyle);
    const savedCursor = snapshot.parserSavedCursor;
    this.savedCursor = savedCursor && Number.isInteger(savedCursor.x) && Number.isInteger(savedCursor.y)
      ? {
          x: Math.min(this.cols - 1, Math.max(0, savedCursor.x)),
          y: Math.min(this.rows - 1, Math.max(0, savedCursor.y)),
        }
      : { x: 0, y: 0 };
    const lastPrintedChar = snapshot.parserLastPrintedChar;
    this.lastPrintedChar =
      typeof lastPrintedChar === 'string' && Array.from(lastPrintedChar).length === 1
        ? lastPrintedChar
        : ' ';


    const kitty = snapshot.pendingKittyImage;
    const kittyParams = this.restoreSnapshotStringMap(kitty?.params);
    const kittyPayload = this.restoreSnapshotChunks(kitty?.chunks);
    this.pendingKittyImage =
      kitty &&
      Number.isInteger(kitty.row) &&
      Number.isInteger(kitty.col) &&
      kitty.row >= removedTopRows &&
      kittyParams &&
      kittyPayload
        ? {
            row: kitty.row - removedTopRows,
            col: Math.min(this.cols - 1, Math.max(0, kitty.col)),
            params: kittyParams,
            chunks: kittyPayload.chunks,
            encodedLength: kittyPayload.encodedLength,
          }
        : null;

    const iTerm2 = snapshot.pendingITerm2File;
    const iTerm2Args = this.restoreSnapshotStringMap(iTerm2?.args);
    const iTerm2Payload = this.restoreSnapshotChunks(iTerm2?.chunks);
    this.pendingITerm2File = iTerm2 && iTerm2Args && iTerm2Payload
      ? {
          args: iTerm2Args,
          chunks: iTerm2Payload.chunks,
          encodedLength: iTerm2Payload.encodedLength,
        }
      : null;
  }

  restoreSnapshot(snapshot: TerminalSnapshot) {
    this.clearRetainedImageState();
    const preserveLatestLines =
      !snapshot.usingAlternateScreen &&
      this.isFullScreenRegion(snapshot.scrollTop, snapshot.scrollBottom, snapshot.bufferRows.length);
    const restoredState = this.restoreViewportState(
      snapshot.bufferRows,
      snapshot.scrollbackRows,
      snapshot.cursorY,
      preserveLatestLines,
    );
    this.scrollback = restoredState.scrollback;
    this.buffer = restoredState.buffer;

    this.cursorX = Math.min(this.cols - 1, Math.max(0, snapshot.cursorX));
    this.cursorY = restoredState.cursorY;
    this.applicationCursorKeys = snapshot.applicationCursorKeys;
    this.autoWrapMode = snapshot.autoWrapMode ?? true;
    this.bracketedPasteMode = snapshot.bracketedPasteMode ?? false;
    this.mouseMode =
      snapshot.mouseMode === 9 ||
      snapshot.mouseMode === 1000 ||
      snapshot.mouseMode === 1002 ||
      snapshot.mouseMode === 1003
        ? snapshot.mouseMode
        : 0;
    this.sgrMouseEncoding = snapshot.sgrMouseEncoding ?? false;
    this.cursorVisible = snapshot.cursorVisible ?? true;
    this.synchronizedOutput = snapshot.synchronizedOutput ?? false;
    this.usingAlternateScreen = snapshot.usingAlternateScreen;
    const kittyKeyboard = snapshot.kittyKeyboard;
    this.kittyKeyboardMainFlags = this.normalizeKittyKeyboardFlags(kittyKeyboard?.mainFlags);
    this.kittyKeyboardAlternateFlags = this.normalizeKittyKeyboardFlags(kittyKeyboard?.alternateFlags);
    this.kittyKeyboardMainStack = Array.isArray(kittyKeyboard?.mainStack)
      ? kittyKeyboard.mainStack
          .slice(-KITTY_KEYBOARD_STACK_LIMIT)
          .map((flags) => this.normalizeKittyKeyboardFlags(flags))
      : [];
    this.kittyKeyboardAlternateStack = Array.isArray(kittyKeyboard?.alternateStack)
      ? kittyKeyboard.alternateStack
          .slice(-KITTY_KEYBOARD_STACK_LIMIT)
          .map((flags) => this.normalizeKittyKeyboardFlags(flags))
      : [];
    this.scrollTop = Math.min(this.rows - 1, Math.max(0, snapshot.scrollTop));
    this.scrollBottom = Math.min(this.rows - 1, Math.max(this.scrollTop, snapshot.scrollBottom));

    const preserveMainScreenLatestLines =
      this.isFullScreenRegion(
        snapshot.mainScreenScrollRegion?.top ?? 0,
        snapshot.mainScreenScrollRegion?.bottom ?? Math.max(0, (snapshot.mainScreenBufferRows?.length ?? 1) - 1),
        snapshot.mainScreenBufferRows?.length ?? this.rows,
      );
    const restoredMainScreenState = this.restoreViewportState(
      snapshot.mainScreenBufferRows,
      snapshot.mainScreenScrollbackRows,
      snapshot.mainScreenCursor?.y ?? 0,
      preserveMainScreenLatestLines,
    );
    this.mainScreenBuffer = snapshot.mainScreenBufferRows ? restoredMainScreenState.buffer : null;
    this.mainScreenScrollback = restoredMainScreenState.scrollback;
    this.normalizeTextSizingRows(this.scrollback.concat(this.buffer));
    if (this.mainScreenBuffer) {
      this.normalizeTextSizingRows(this.mainScreenScrollback.concat(this.mainScreenBuffer));
    }
    this.mainScreenCursor = snapshot.mainScreenCursor
      ? {
          x: Math.min(this.cols - 1, Math.max(0, snapshot.mainScreenCursor.x)),
          y: restoredMainScreenState.cursorY,
        }
      : { x: 0, y: 0 };
    this.mainScreenScrollRegion = snapshot.mainScreenScrollRegion
      ? {
          top: Math.min(this.rows - 1, Math.max(0, snapshot.mainScreenScrollRegion.top)),
          bottom: Math.min(this.rows - 1, Math.max(0, snapshot.mainScreenScrollRegion.bottom)),
        }
      : { top: 0, bottom: this.rows - 1 };
    if (
      !this.restoreRuntimeImageState(
        snapshot.runtimeImageState,
        restoredState.removedTopRows,
        restoredState.scrollback.length + restoredState.buffer.length,
        restoredMainScreenState.removedTopRows,
        restoredMainScreenState.scrollback.length + restoredMainScreenState.buffer.length,
      )
    ) {
      this.clearRestoredImagePlaceholders();
    }
    this.restoreParserStreamState(snapshot, restoredState.removedTopRows);
    this.restoreOscState(snapshot);
    this.markFullBufferDirty();
    this.markAllRowsDirty();
  }

  private restoreOscState(snapshot: TerminalSnapshot) {
    this.oscTitle = sanitizeOscTitle(snapshot.oscTitle ?? '');
    if (snapshot.oscTitle !== undefined) {
      this.onOscEvent?.({ type: 'title', value: this.oscTitle });
    }

    this.oscCurrentDirectoryUri = null;
    if (snapshot.oscCurrentDirectoryUri) {
      this.handleOscCurrentDirectory(snapshot.oscCurrentDirectoryUri);
    }

    if (snapshot.oscPalette?.length === 256) {
      const palette = snapshot.oscPalette.map(normalizeOscColor);
      if (palette.every((color): color is string => color !== null)) this.paletteColors = palette;
    }

    if (snapshot.oscColors) {
      const foreground = normalizeOscColor(snapshot.oscColors.foreground);
      const background = normalizeOscColor(snapshot.oscColors.background);
      const cursor = normalizeOscColor(snapshot.oscColors.cursor);
      if (foreground && background && cursor) this.oscColors = { foreground, background, cursor };
    }

    const hyperlinkUri = snapshot.oscActiveHyperlink
      ? safeOscUri(snapshot.oscActiveHyperlink.uri)
      : null;
    const hyperlinkId = snapshot.oscActiveHyperlink?.id;
    this.activeHyperlink = hyperlinkUri &&
      (!hyperlinkId || (hyperlinkId.length <= 256 && safeOscUri(hyperlinkId)))
      ? { uri: hyperlinkUri, ...(hyperlinkId ? { id: hyperlinkId } : {}) }
      : null;

    const shell = snapshot.oscShellIntegration;
    if (
      shell &&
      ['none', 'prompt', 'command', 'output', 'finished'].includes(shell.phase) &&
      Number.isSafeInteger(shell.row) && shell.row >= 0 &&
      Number.isSafeInteger(shell.col) && shell.col >= 0 &&
      (shell.exitStatus === null ||
        (Number.isSafeInteger(shell.exitStatus) && shell.exitStatus >= 0 && shell.exitStatus <= 255))
    ) {
      this.shellIntegration = { ...shell };
    }
    this.emitOscColors();
  }

  private snapshotRowToBufferRow(snapshotRow: Cell[]): Cell[] {
    const row = this.createEmptyRow();
    for (let x = 0; x < Math.min(snapshotRow.length, this.cols); x++) {
      const source = snapshotRow[x];
      row[x] = {
        char: source.char,
        style: this.getInternedStyle(source.style),
        hyperlink: source.hyperlink ? { ...source.hyperlink } : undefined,
        imagePlaceholder: source.imagePlaceholder ? { ...source.imagePlaceholder } : undefined,
        textSizing: source.textSizing ? { ...source.textSizing } : undefined,
      };
    }

    return row;
  }
}
