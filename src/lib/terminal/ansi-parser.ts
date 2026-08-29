// ANSI Escape Sequence Parser
// Handles basic terminal control sequences

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
}

export interface Cell {
  char: string;
  style: TextStyle;
}

interface TerminalImageBase {
  id: number;
  imageId?: number;
  placementId?: number;
  row: number;
  col: number;
  widthCells: number;
  heightCells: number;
  pixelWidth: number;
  pixelHeight: number;
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
}

export type TerminalImage = TerminalRgbaImage | TerminalPngImage | TerminalEncodedImage;

interface KittyImageDataBase {
  pixelWidth: number;
  pixelHeight: number;
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


export interface TerminalSnapshot {
  bufferRows: Cell[][];
  scrollbackRows: Cell[][];
  cursorX: number;
  cursorY: number;
  applicationCursorKeys: boolean;
  bracketedPasteMode?: boolean;
  usingAlternateScreen: boolean;
  scrollTop: number;
  scrollBottom: number;
  outputOffset: number;
  mainScreenBufferRows?: Cell[][];
  mainScreenScrollbackRows?: Cell[][];
  mainScreenCursor?: { x: number; y: number };
  mainScreenScrollRegion?: { top: number; bottom: number };
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
const MAX_IMAGE_DECODED_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_DECODED_BYTES / 3) * 4;
const MAX_CONTROL_SEQUENCE_CHARS = MAX_IMAGE_BASE64_CHARS + 4096;
const MAX_IMAGE_CHUNKS = 4096;
const MAX_IMAGE_PIXEL_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_DATA_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IMAGE_PIXELS = 8 * 1024 * 1024;
const MAX_TERMINAL_IMAGES = 128;
const MAX_KITTY_IMAGE_DATA = 128;
const DEFAULT_ITERM2_CELL_PIXEL_WIDTH = 8;
const DEFAULT_ITERM2_CELL_PIXEL_HEIGHT = 16;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

// Standard ANSI colors
const COLORS_16 = [
  '#3d2020', '#ff6b6b', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d4bebe', // normal
  '#5c3030', '#ff8585', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#e8d4d4', // bright
];

export class AnsiParser {
  private buffer: Cell[][];
  private scrollback: Cell[][] = [];
  private fullBufferCache: Cell[][] = [];
  private fullBufferDirty = true;
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
  private parseState:
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
    | 'dcsEscape' = 'normal';
  private escapeBuffer = '';
  private images: TerminalImage[] = [];
  private mainScreenImages: TerminalImage[] = [];
  private nextImageId = 1;
  private kittyImageData = new Map<number, KittyImageData>();
  private pendingKittyImage: PendingKittyImage | null = null;
  private pendingITerm2File: PendingITerm2File | null = null;
  private savedCursor = { x: 0, y: 0 };
  private lastPrintedChar = ' '; // CSI b (REP) 용
  private applicationCursorKeys = false;
  private bracketedPasteMode = false;
  private cursorVisible = true;
  private usingAlternateScreen = false;
  private mainScreenBuffer: Cell[][] | null = null;
  private mainScreenScrollback: Cell[][] = [];
  private mainScreenCursor = { x: 0, y: 0 };
  private mainScreenScrollRegion = { top: 0, bottom: 0 };
  private synchronizedOutput = false; // mode 2026: true이면 렌더링 보류
  private mouseMode = 0; // 0=off, 1000=normal, 1002=button-event, 1003=any-event
  private sgrMouseEncoding = false; // mode 1006: SGR 마우스 인코딩

  // 터미널 → 원격 앱 응답 콜백 (DA, DSR 등)
  private onResponse: ((data: string) => void) | null = null;
  setResponseHandler(handler: (data: string) => void) {
    this.onResponse = handler;
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
  ): { buffer: Cell[][]; scrollback: Cell[][]; cursorY: number } {
    const normalizedScrollback = (snapshotScrollbackRows ?? [])
      .slice(-this.maxScrollback)
      .map((row) => this.snapshotRowToBufferRow(row));
    let nextScrollback = normalizedScrollback;
    let visibleRows = (snapshotBufferRows ?? []).map((row) => this.snapshotRowToBufferRow(row));
    let nextCursorY = snapshotCursorY;

    if (preserveLatestLines) {
      if (visibleRows.length > this.rows) {
        const overflowCount = visibleRows.length - this.rows;
        nextScrollback = normalizedScrollback
          .concat(visibleRows.slice(0, overflowCount))
          .slice(-this.maxScrollback);
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
    };
  }

  private rowContentLength(row: Cell[]): number {
    let last = 0;
    for (let i = 0; i < row.length; i++) {
      if (row[i].char !== ' ') last = i + 1;
    }
    return Math.max(1, last);
  }

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;

    const oldBuffer = this.buffer;
    const oldScrollback = this.scrollback;
    const oldRows = this.rows;
    const oldCols = this.cols;
    const oldCursorY = this.cursorY;
    const oldCursorX = this.cursorX;
    const oldScrollTop = this.scrollTop;
    const oldScrollBottom = this.scrollBottom;
    const canReflowMainScreen =
      !this.usingAlternateScreen &&
      oldScrollTop === 0 &&
      oldScrollBottom === oldRows - 1;

    // --- Step 1: adjust the screen row count at the old column width ---
    let nextBufferRows = oldBuffer;
    let nextScrollback = oldScrollback;
    let nextCursorY = oldCursorY;

    if (canReflowMainScreen) {
      if (rows < oldRows) {
        const trimmedCount = Math.max(0, oldCursorY - (rows - 1));
        const trimmedRows = oldBuffer.slice(0, trimmedCount);
        nextScrollback = oldScrollback.concat(trimmedRows).slice(-this.maxScrollback);
        nextBufferRows = oldBuffer.slice(trimmedCount);
        nextCursorY = Math.max(0, oldCursorY - trimmedCount);
      } else if (rows > oldRows) {
        const pulledCount = Math.min(rows - oldRows, nextScrollback.length);
        const restoredRows =
          pulledCount > 0 ? nextScrollback.slice(nextScrollback.length - pulledCount) : [];
        nextScrollback =
          pulledCount > 0 ? nextScrollback.slice(0, nextScrollback.length - pulledCount) : nextScrollback;
        nextBufferRows = restoredRows.concat(oldBuffer);
        nextCursorY = oldCursorY + pulledCount;
      }
    }

    // --- Step 2: reflow columns ---
    // Narrowing previously TRUNCATED each row (content past the new width
    // was lost) which mangled prompts and duplicated redraws. Split every
    // row into new-width chunks instead so no content is dropped.
    let finalRows: Cell[][];
    let finalCursorY = nextCursorY;
    let finalCursorX = Math.min(oldCursorX, cols - 1);

    if (canReflowMainScreen && cols < oldCols) {
      const allRows: Cell[][] = [];
      let cursorRowOffset = 0;
      for (let y = 0; y < nextBufferRows.length; y++) {
        const row = nextBufferRows[y];
        const contentLength = this.rowContentLength(row);
        let pushed = 0;
        let start = 0;
        while (start < contentLength) {
          let end = Math.min(start + cols, contentLength);
          // Keep wide-char pairs together: if the chunk would end on a
          // wide main cell whose placeholder lands in the next chunk,
          // move the pair down. With a 1-column grid the split is
          // unavoidable and the renderer clips the glyph.
          if (
            cols > 1 &&
            end - start === cols &&
            end < contentLength &&
            row[end].char === "" &&
            row[end - 1].char !== "" &&
            this.isWideChar(row[end - 1].char)
          ) {
            end -= 1;
          }
          allRows.push(row.slice(start, end));
          start = end;
          pushed++;
        }
        if (pushed === 0) {
          allRows.push([]);
          pushed = 1;
        }
        if (y < nextCursorY) {
          cursorRowOffset += pushed;
        }
      }

      // Map the cursor into the reflowed rows.
      const cursorRow = nextBufferRows[nextCursorY];
      if (cursorRow) {
        const within = Math.min(
          Math.floor(oldCursorX / cols),
          Math.max(1, Math.ceil(this.rowContentLength(cursorRow) / cols)) - 1
        );
        finalCursorY = cursorRowOffset + within;
        finalCursorX = oldCursorX % cols;
      }

      finalRows = allRows;
    } else {
      finalRows = nextBufferRows;
      finalCursorY = nextCursorY;
      finalCursorX = Math.min(oldCursorX, cols - 1);
    }

    this.cols = cols;
    this.rows = rows;

    // --- Step 3: fit the reflowed screen into the viewport ---
    // The cursor must stay visible: trailing rows below the cursor are
    // dropped, and rows above the cursor overflow into scrollback.
    if (finalRows.length > rows) {
      finalRows = finalRows.slice(0, Math.min(finalRows.length, finalCursorY + 1));
      const overflowCount = Math.max(0, finalRows.length - rows);
      if (overflowCount > 0) {
        nextScrollback = nextScrollback
          .concat(finalRows.slice(0, overflowCount))
          .slice(-this.maxScrollback);
        finalRows = finalRows.slice(overflowCount);
        finalCursorY -= overflowCount;
      }
    } else if (finalRows.length < rows) {
      // The screen grows downward: blank rows are added below the content.
      while (finalRows.length < rows) {
        finalRows.push([]);
      }
    }

    this.scrollback = nextScrollback;
    this.buffer = this.createBuffer();

    // Preserve existing content.
    const copyRows = Math.min(finalRows.length, rows);
    for (let y = 0; y < copyRows; y++) {
      const source = finalRows[y];
      for (let x = 0; x < source.length && x < cols; x++) {
        this.buffer[y][x] = source[x];
      }
    }

    this.cursorX = Math.min(finalCursorX, cols - 1);
    this.cursorY = Math.min(finalCursorY, rows - 1);

    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;

    this.mainScreenScrollRegion = {
      top: Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.top)),
      bottom: Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.bottom)),
    };
    this.markFullBufferDirty();
    this.markAllRowsDirty();
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
        } else if (this.escapeBuffer.length >= MAX_CONTROL_SEQUENCE_CHARS) {
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
        } else if (this.escapeBuffer.length + 2 > MAX_CONTROL_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.pendingITerm2File = null;
          this.parseState = 'oscDiscard';
        } else {
          this.escapeBuffer += `\x1b${char}`;
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
        this.parseState = char === '\\' ? 'normal' : 'oscDiscard';
        break;

      case 'apc':
        if (char === '\x07') {
          this.handleAPC(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'apcEscape';
        } else if (this.escapeBuffer.length >= MAX_CONTROL_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.pendingKittyImage = null;
          this.parseState = 'apcDiscard';
        } else {
          this.escapeBuffer += char;
        }
        break;

      case 'dcs':
        if (char === '\x07') {
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'dcsEscape';
        }
        break;

      case 'apcEscape':
        if (char === '\\') {
          this.handleAPC(this.escapeBuffer);
          this.escapeBuffer = '';
          this.parseState = 'normal';
        } else if (this.escapeBuffer.length + 2 > MAX_CONTROL_SEQUENCE_CHARS) {
          this.escapeBuffer = '';
          this.pendingKittyImage = null;
          this.parseState = 'apcDiscard';
        } else {
          this.escapeBuffer += `\x1b${char}`;
          this.parseState = 'apc';
        }
        break;

      case 'apcDiscard':
        if (char === '\x07') {
          this.parseState = 'normal';
        } else if (char === '\x1b') {
          this.parseState = 'apcDiscardEscape';
        }
        break;

      case 'apcDiscardEscape':
        this.parseState = char === '\\' ? 'normal' : 'apcDiscard';
        break;

      case 'dcsEscape':
        this.parseState = char === '\\' ? 'normal' : 'dcs';
        break;
    }
  }

  private handleAPC(seq: string) {
    if (!seq.startsWith('G')) return;
    this.handleKittyGraphics(seq.slice(1));
  }

  private handleOSC(seq: string) {
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

    const widthCells = this.parseITerm2CellCount(args.get('width'), 'width');
    const heightCells = this.parseITerm2CellCount(args.get('height'), 'height');
    const placementCells = this.resolveITerm2PlacementCells(widthCells, heightCells, dimensions);
    if (
      !placementCells ||
      !this.canRetainImageData(bytes) ||
      !this.canRetainImagePlacement(dimensions.width, dimensions.height)
    ) {
      return;
    }

    const row = this.scrollback.length + this.cursorY;
    const col = this.cursorX;
    const terminalImage: TerminalImage =
      mimeType === 'image/png'
        ? {
            kind: 'png',
            id: this.nextImageId++,
            row,
            col,
            widthCells: placementCells.width,
            heightCells: placementCells.height,
            pixelWidth: dimensions.width,
            pixelHeight: dimensions.height,
            mimeType,
            data: bytes,
          }
        : {
            kind: 'encoded',
            id: this.nextImageId++,
            row,
            col,
            widthCells: placementCells.width,
            heightCells: placementCells.height,
            pixelWidth: dimensions.width,
            pixelHeight: dimensions.height,
            mimeType,
            data: bytes,
          };

    this.images.push(terminalImage);
    if (this.images.length > MAX_TERMINAL_IMAGES) {
      this.images.splice(0, this.images.length - MAX_TERMINAL_IMAGES);
    }
    this.advanceCursorRows(placementCells.height);
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

  private parseITerm2CellCount(value: string | undefined, axis: 'width' | 'height'): number | null {
    if (!value || value.length === 0 || value === 'auto') return null;

    const pixelUnit = value.endsWith('px');
    const percentUnit = value.endsWith('%');
    const numberText = pixelUnit ? value.slice(0, -2) : percentUnit ? value.slice(0, -1) : value;
    const parsed = Number.parseFloat(numberText);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;

    if (pixelUnit) {
      const cellPixels = axis === 'width' ? DEFAULT_ITERM2_CELL_PIXEL_WIDTH : DEFAULT_ITERM2_CELL_PIXEL_HEIGHT;
      return Math.max(1, Math.ceil(parsed / cellPixels));
    }

    if (percentUnit) {
      const base = axis === 'width' ? this.cols : this.rows;
      return Math.max(1, Math.ceil((base * parsed) / 100));
    }

    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x30 || code > 0x39) return null;
    }
    return this.parsePositiveInteger(value);
  }

  private resolveITerm2PlacementCells(
    widthCells: number | null,
    heightCells: number | null,
    dimensions: { width: number; height: number },
  ): { width: number; height: number } | null {
    if (widthCells !== null || heightCells !== null) {
      return this.resolveImagePlacementCells(
        new Map([
          ...(widthCells !== null ? [['c', String(widthCells)] as [string, string]] : []),
          ...(heightCells !== null ? [['r', String(heightCells)] as [string, string]] : []),
        ]),
        dimensions.width,
        dimensions.height,
      );
    }

    const availableColumns = Math.max(1, this.cols - this.cursorX);
    const naturalWidth = Math.max(1, Math.ceil(dimensions.width / DEFAULT_ITERM2_CELL_PIXEL_WIDTH));
    const naturalHeight = Math.max(1, Math.ceil(dimensions.height / DEFAULT_ITERM2_CELL_PIXEL_HEIGHT));
    const width = Math.min(availableColumns, naturalWidth);
    const height =
      width === naturalWidth
        ? naturalHeight
        : Math.max(
            1,
            Math.ceil(
              (width * dimensions.height * DEFAULT_ITERM2_CELL_PIXEL_WIDTH) /
                (dimensions.width * DEFAULT_ITERM2_CELL_PIXEL_HEIGHT),
            ),
          );

    return {
      width,
      height: Math.min(this.rows, height),
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
  ): { width: number; height: number } | null {
    if (mimeType === 'image/png') return this.parsePngDimensions(data);
    if (mimeType === 'image/jpeg') return this.parseJpegDimensions(data);
    if (mimeType === 'image/gif') return this.parseGifDimensions(data);
    return this.parseWebpDimensions(data);
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

  private parseGifDimensions(data: Uint8Array): { width: number; height: number } | null {
    if (data.length < 14) return null;

    const width = data[6] + (data[7] << 8);
    const height = data[8] + (data[9] << 8);
    if (width <= 0 || height <= 0) return null;

    let offset = 13;
    if ((data[10] & 0x80) !== 0) {
      offset += 3 * (1 << ((data[10] & 0x07) + 1));
    }

    let frameCount = 0;
    while (offset < data.length) {
      const blockType = data[offset++];
      if (blockType === 0x3b) {
        return frameCount === 1 ? { width, height } : null;
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
      frameCount++;
      if (frameCount > 1) return null;

      const packedFields = data[offset + 8];
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

  private parseWebpDimensions(data: Uint8Array): { width: number; height: number } | null {
    if (data.length < 25) return null;

    const chunkType = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (chunkType === 'VP8X') {
      if (data.length < 30 || (data[20] & 0x02) !== 0) return null;
      return {
        width: 1 + data[24] + (data[25] << 8) + (data[26] << 16),
        height: 1 + data[27] + (data[28] << 8) + (data[29] << 16),
      };
    }

    if (chunkType === 'VP8L') {
      if (data[20] !== 0x2f) return null;
      return {
        width: 1 + data[21] + ((data[22] & 0x3f) << 8),
        height: 1 + ((data[22] & 0xc0) >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10),
      };
    }

    if (
      chunkType === 'VP8 ' &&
      data.length >= 30 &&
      data[23] === 0x9d &&
      data[24] === 0x01 &&
      data[25] === 0x2a
    ) {
      return {
        width: (data[26] + (data[27] << 8)) & 0x3fff,
        height: (data[28] + (data[29] << 8)) & 0x3fff,
      };
    }

    return null;
  }


  private readUint16(data: Uint8Array, offset: number): number {
    return (data[offset] << 8) + data[offset + 1];
  }

  private handleKittyGraphics(seq: string) {
    const separatorIndex = seq.indexOf(';');
    const rawParams = separatorIndex >= 0 ? seq.slice(0, separatorIndex) : seq;
    const payload = separatorIndex >= 0 ? seq.slice(separatorIndex + 1) : '';
    const params = this.parseKittyParams(rawParams);
    if (!params) {
      this.pendingKittyImage = null;
      return;
    }
    const action = params.get('a');

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

    const startsImage = action === 'T' || action === 't' || params.has('f') || params.has('s') || params.has('v');

    if (startsImage) {
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
    if (!pending) return;
    if (payload.length > 0) {
      if (
        pending.chunks.length >= MAX_IMAGE_CHUNKS ||
        pending.encodedLength + payload.length > MAX_IMAGE_BASE64_CHARS
      ) {
        this.pendingKittyImage = null;
        return;
      }
      pending.chunks.push(payload);
      pending.encodedLength += payload.length;
    }

    if (params.get('m') !== '1') {
      this.completeKittyImage();
    }
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
    const image = this.pendingKittyImage;
    this.pendingKittyImage = null;
    if (!image || image.chunks.length === 0) return;

    const medium = image.params.get('t') ?? 'd';
    if (medium !== 'd') return;

    const format = Number.parseInt(image.params.get('f') ?? '', 10);
    const bytes = this.decodeIndependentBase64Bytes(image.chunks);
    if (!bytes) return;
    let imageData: KittyImageData | null = null;

    if (format === 24 || format === 32) {
      const pixelWidth = Number.parseInt(image.params.get('s') ?? '', 10);
      const pixelHeight = Number.parseInt(image.params.get('v') ?? '', 10);
      if (!this.isImageDimensionsAllowed(pixelWidth, pixelHeight)) return;

      const bytesPerPixel = format === 24 ? 3 : 4;
      const expectedLength = pixelWidth * pixelHeight * bytesPerPixel;
      if (bytes.length !== expectedLength) return;

      const rgbaLength = pixelWidth * pixelHeight * 4;
      const data = new Uint8ClampedArray(rgbaLength);
      if (format === 32) {
        data.set(bytes);
      } else {
        for (let src = 0, dst = 0; src < expectedLength; src += 3, dst += 4) {
          data[dst] = bytes[src];
          data[dst + 1] = bytes[src + 1];
          data[dst + 2] = bytes[src + 2];
          data[dst + 3] = 0xff;
        }
      }

      imageData = {
        kind: 'rgba',
        pixelWidth,
        pixelHeight,
        data,
      };
    } else if (format === 100) {
      const dimensions = this.parsePngDimensions(bytes);
      if (!dimensions || !this.isImageDimensionsAllowed(dimensions.width, dimensions.height)) return;

      imageData = {
        kind: 'png',
        pixelWidth: dimensions.width,
        pixelHeight: dimensions.height,
        mimeType: 'image/png',
        data: bytes,
      };
    } else {
      return;
    }

    const imageId = this.parsePositiveInteger(image.params.get('i'));
    if (imageId !== null) {
      this.removeKittyPlacements((placement) => placement.imageId === imageId);
      this.kittyImageData.delete(imageId);
    }

    if (!this.canRetainImageData(imageData.data)) return;
    if (imageId !== null) {
      this.storeKittyImageData(imageId, imageData);
    }

    const action = image.params.get('a') ?? 'T';
    if (action === 't') return;

    this.addKittyPlacement(image.row, image.col, image.params, imageData, imageId);
  }

  private placeStoredKittyImage(params: Map<string, string>) {
    const imageId = this.parsePositiveInteger(params.get('i'));
    if (imageId === null) return;

    const imageData = this.kittyImageData.get(imageId);
    if (!imageData) return;

    this.addKittyPlacement(this.scrollback.length + this.cursorY, this.cursorX, params, imageData, imageId);
  }

  private storeKittyImageData(imageId: number, imageData: KittyImageData) {
    this.kittyImageData.delete(imageId);
    this.kittyImageData.set(imageId, imageData);

    while (this.kittyImageData.size > MAX_KITTY_IMAGE_DATA) {
      const oldestId = this.kittyImageData.keys().next().value as number | undefined;
      if (oldestId === undefined) return;
      this.kittyImageData.delete(oldestId);
    }
  }

  private addKittyPlacement(
    row: number,
    col: number,
    params: Map<string, string>,
    imageData: KittyImageData,
    imageId: number | null,
  ) {
    const placementCells = this.resolveImagePlacementCells(params, imageData.pixelWidth, imageData.pixelHeight);
    if (!placementCells) return;

    const placementId = this.parsePositiveInteger(params.get('p'));
    if (imageId !== null && placementId !== null) {
      this.removeKittyPlacements((placement) => placement.imageId === imageId && placement.placementId === placementId);
    }
    if (!this.canRetainImagePlacement(imageData.pixelWidth, imageData.pixelHeight)) return;

    const terminalImage: TerminalImage =
      imageData.kind === 'png'
        ? {
            kind: 'png',
            id: this.nextImageId++,
            imageId: imageId ?? undefined,
            placementId: placementId ?? undefined,
            row,
            col,
            widthCells: placementCells.width,
            heightCells: placementCells.height,
            pixelWidth: imageData.pixelWidth,
            pixelHeight: imageData.pixelHeight,
            mimeType: imageData.mimeType,
            data: imageData.data,
          }
        : {
            kind: 'rgba',
            id: this.nextImageId++,
            imageId: imageId ?? undefined,
            placementId: placementId ?? undefined,
            row,
            col,
            widthCells: placementCells.width,
            heightCells: placementCells.height,
            pixelWidth: imageData.pixelWidth,
            pixelHeight: imageData.pixelHeight,
            data: imageData.data,
          };

    this.images.push(terminalImage);
    if (this.images.length > MAX_TERMINAL_IMAGES) {
      this.images.splice(0, this.images.length - MAX_TERMINAL_IMAGES);
    }
    if (params.get('C') !== '1') this.advanceCursorRows(placementCells.height);
    this.markAllRowsDirty();
  }

  private handleKittyDelete(params: Map<string, string>) {
    const selector = params.get('d');
    const imageId = this.parsePositiveInteger(params.get('i'));
    const placementId = this.parsePositiveInteger(params.get('p'));

    if (selector === 'i' || selector === 'I') {
      if (imageId === null) return;
      this.removeKittyPlacements(
        (placement) => placement.imageId === imageId && (placementId === null || placement.placementId === placementId),
      );
      if (selector === 'I') this.kittyImageData.delete(imageId);
      return;
    }

    if (selector === 'p' || selector === 'P') {
      if (placementId === null) return;
      this.removeKittyPlacements(
        (placement) =>
          placement.placementId === placementId && (imageId === null || placement.imageId === imageId),
      );
      return;
    }

    if (this.images.length === 0) return;
    this.images = [];
    this.markAllRowsDirty();
  }

  private removeKittyPlacements(predicate: (image: TerminalImage) => boolean) {
    const currentImageCount = this.images.length;
    const savedImageCount = this.mainScreenImages.length;

    this.images = this.images.filter((image) => !predicate(image));
    this.mainScreenImages = this.mainScreenImages.filter((image) => !predicate(image));

    if (this.images.length !== currentImageCount || this.mainScreenImages.length !== savedImageCount) {
      this.markAllRowsDirty();
    }
  }

  private resolveImagePlacementCells(
    params: Map<string, string>,
    pixelWidth: number,
    pixelHeight: number,
  ): { width: number; height: number } | null {
    const widthCells = this.parsePositiveInteger(params.get('c'));
    const heightCells = this.parsePositiveInteger(params.get('r'));
    const maxWidth = Math.max(1, this.cols - this.cursorX);
    const maxHeight = Math.max(1, this.rows);

    if (widthCells !== null && heightCells !== null) {
      return {
        width: Math.min(widthCells, maxWidth),
        height: Math.min(heightCells, maxHeight),
      };
    }
    if (widthCells !== null) {
      const width = Math.min(widthCells, maxWidth);
      return {
        width,
        height: Math.min(maxHeight, Math.max(1, Math.ceil((width * pixelHeight) / pixelWidth))),
      };
    }
    if (heightCells !== null) {
      const height = Math.min(heightCells, maxHeight);
      return {
        width: Math.min(maxWidth, Math.max(1, Math.ceil((height * pixelWidth) / pixelHeight))),
        height,
      };
    }

    return null;
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

  private canRetainImageData(data: Uint8Array | Uint8ClampedArray): boolean {
    const seen = new Set<Uint8Array | Uint8ClampedArray>();
    let totalBytes = 0;
    const track = (candidate: Uint8Array | Uint8ClampedArray) => {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      totalBytes += candidate.byteLength;
    };

    for (const image of this.images) track(image.data);
    for (const image of this.mainScreenImages) track(image.data);
    for (const imageData of this.kittyImageData.values()) track(imageData.data);

    return seen.has(data) || totalBytes + data.byteLength <= MAX_TOTAL_IMAGE_DATA_BYTES;
  }

  private canRetainImagePlacement(pixelWidth: number, pixelHeight: number): boolean {
    let totalPixels = 0;
    for (const image of this.images) totalPixels += image.pixelWidth * image.pixelHeight;
    for (const image of this.mainScreenImages) totalPixels += image.pixelWidth * image.pixelHeight;
    return totalPixels + pixelWidth * pixelHeight <= MAX_TOTAL_IMAGE_PIXELS;
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
    if (this.encodedImageLength(chunks) === null) return null;

    try {
      const decodedChunks: Uint8Array[] = [];
      let totalLength = 0;
      for (const chunk of chunks) {
        const decoded = this.decodeBase64Chunk(chunk);
        totalLength += decoded.length;
        if (totalLength > MAX_IMAGE_DECODED_BYTES) return null;
        decodedChunks.push(decoded);
      }

      const bytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of decodedChunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
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
    for (let i = 0; i < rowsToAdvance; i++) {
      this.lineFeed();
    }
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

  private handleCSI(seq: string) {
    const command = seq[seq.length - 1];
    const rawParams = seq.slice(0, -1);
    const isPrivateMode = rawParams.startsWith('?');
    const normalizedParams = isPrivateMode ? rawParams.slice(1) : rawParams;
    if (this.hasTooManyControlFields(normalizedParams, ';')) return;
    const params = (normalizedParams.length > 0 ? normalizedParams : '0')
      .split(';')
      .map((p) => {
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
      case 'm': // SGR (Select Graphic Rendition)
        this.handleSGR(params);
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
        this.scrollRegionUp(params[0] || 1);
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
      case 'c': // DA1/DA2 — 무시 (응답이 텍스트로 출력되는 문제 방지)
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
        // Auto-wrap mode (DECAWM) — 항상 켜져있는 것으로 처리
      } else if (mode === 2026) {
        this.synchronizedOutput = enabled;
      } else if (mode === 1000 || mode === 1002 || mode === 1003) {
        this.mouseMode = enabled ? mode : 0;
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

    this.buffer = this.createBuffer();
    this.scrollback = [];
    this.images = [];
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

    this.buffer = this.mainScreenBuffer ? this.cloneBuffer(this.mainScreenBuffer) : this.createBuffer();
    this.scrollback = this.cloneBuffer(this.mainScreenScrollback);
    this.cursorX = Math.min(this.cols - 1, Math.max(0, this.mainScreenCursor.x));
    this.cursorY = Math.min(this.rows - 1, Math.max(0, this.mainScreenCursor.y));

    const restoredTop = Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.top));
    const restoredBottom = Math.min(this.rows - 1, Math.max(0, this.mainScreenScrollRegion.bottom));
    if (restoredTop < restoredBottom) {
      this.scrollTop = restoredTop;
      this.scrollBottom = restoredBottom;
    } else {
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
    }

    this.mainScreenBuffer = null;
    this.mainScreenScrollback = [];
    this.images = this.mainScreenImages;
    this.mainScreenImages = [];
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
    row.splice(this.cursorX, 0, ...Array.from({ length: amount }, () => this.createEmptyCell()));
    row.splice(this.cols);
  }

  private deleteChars(count: number) {
    const row = this.buffer[this.cursorY];
    const amount = this.boundedCsiCount(count, this.cols - this.cursorX);
    if (amount === 0) return;
    row.splice(this.cursorX, amount);
    while (row.length < this.cols) {
      row.push(this.createEmptyCell());
    }
  }

  private eraseChars(count: number) {
    const row = this.buffer[this.cursorY];
    const amount = this.boundedCsiCount(count, this.cols - this.cursorX);
    for (let x = this.cursorX; x < this.cursorX + amount; x++) {
      row[x] = this.createEmptyCell();
    }
  }

  private insertLines(count: number) {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) {
      return;
    }

    const amount = Math.min(Math.max(1, count), this.scrollBottom - this.cursorY + 1);
    this.markFullBufferDirty();
    for (let i = 0; i < amount; i++) {
      this.buffer.splice(this.cursorY, 0, this.createEmptyRow());
      this.buffer.splice(this.scrollBottom + 1, 1);
    }
  }

  private deleteLines(count: number) {
    if (this.cursorY < this.scrollTop || this.cursorY > this.scrollBottom) {
      return;
    }

    const amount = Math.min(Math.max(1, count), this.scrollBottom - this.cursorY + 1);
    this.markFullBufferDirty();
    for (let i = 0; i < amount; i++) {
      this.buffer.splice(this.cursorY, 1);
      this.buffer.splice(this.scrollBottom, 0, this.createEmptyRow());
    }
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

    this.markFullBufferDirty();
    let droppedScrollbackRows = 0;
    for (let i = 0; i < amount; i++) {
      const removedLine = this.buffer.splice(this.scrollTop, 1)[0];
      this.buffer.splice(this.scrollBottom, 0, this.createEmptyRow());

      if (trackScrollback && removedLine && !this.usingAlternateScreen) {
        this.scrollback.push(removedLine);
        if (this.scrollback.length > this.maxScrollback) {
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

  private rebaseImageRows(droppedRows: number) {
    this.images = this.images
      .map((image) => ({ ...image, row: image.row - droppedRows }))
      .filter((image) => image.row + image.heightCells > 0);
  }

  private scrollRegionDown(count: number) {
    const amount = this.boundedCsiCount(count, this.scrollBottom - this.scrollTop + 1);

    this.markFullBufferDirty();
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
        this.style.fg = COLORS_16[p - 30];
      } else if (p === 38) {
        // Extended foreground color
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          this.style.fg = this.color256(params[i + 2]);
          i += 2;
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          this.style.fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
          i += 4;
        }
      } else if (p === 39) {
        this.style.fg = DEFAULT_STYLE.fg;
      } else if (p >= 40 && p <= 47) {
        this.style.bg = COLORS_16[p - 40];
      } else if (p === 48) {
        // Extended background color
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          this.style.bg = this.color256(params[i + 2]);
          i += 2;
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          this.style.bg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
          i += 4;
        }
      } else if (p === 49) {
        this.style.bg = DEFAULT_STYLE.bg;
      } else if (p >= 90 && p <= 97) {
        this.style.fg = COLORS_16[p - 90 + 8];
      } else if (p >= 100 && p <= 107) {
        this.style.bg = COLORS_16[p - 100 + 8];
      }

      i++;
    }
  }

  private color256(n: number): string {
    if (n < 16) {
      return COLORS_16[n];
    } else if (n < 232) {
      // 216 color cube
      n -= 16;
      const b = (n % 6) * 51;
      const g = (Math.floor(n / 6) % 6) * 51;
      const r = Math.floor(n / 36) * 51;
      return `rgb(${r},${g},${b})`;
    } else {
      // Grayscale
      const gray = (n - 232) * 10 + 8;
      return `rgb(${gray},${gray},${gray})`;
    }
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

  private putChar(char: string) {
    const isWide = this.isWideChar(char);

    // Check if we need to wrap
    if (this.cursorX >= this.cols || (isWide && this.cursorX >= this.cols - 1)) {
      this.cursorX = 0;
      this.lineFeed();
    }

    this.buffer[this.cursorY][this.cursorX] = {
      char,
      style: this.getInternedStyle(this.style),
    };
    this.markRowDirty(this.cursorY);
    this.lastPrintedChar = char;
    this.cursorX++;

    // Wide character takes 2 cells
    if (isWide && this.cursorX < this.cols) {
      this.buffer[this.cursorY][this.cursorX] = {
        char: '',  // Empty placeholder for second cell
        style: this.getInternedStyle(this.style),
      };
      this.cursorX++;
    }
  }

  private getStyleKey(style: TextStyle): string {
    return `fg:${style.fg ?? 'default'}|bg:${style.bg}|b:${style.bold ? 1 : 0}|d:${style.dim ? 1 : 0}|i:${style.italic ? 1 : 0}|u:${style.underline ? 1 : 0}|v:${style.inverse ? 1 : 0}|s:${style.strikethrough ? 1 : 0}|h:${style.hidden ? 1 : 0}`;
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
      // Erase from cursor to end
      this.eraseInLine(0);
      for (let y = this.cursorY + 1; y < this.rows; y++) {
        this.buffer[y] = this.createEmptyRow();
        this.markRowDirty(y);
      }
    } else if (mode === 1) {
      // Erase from start to cursor
      for (let y = 0; y < this.cursorY; y++) {
        this.buffer[y] = this.createEmptyRow();
        this.markRowDirty(y);
      }
      this.eraseInLine(1);
    } else if (mode === 2) {
      // Erase entire visible display only. Scrollback is preserved for CSI 2 J.
      this.buffer = this.createBuffer();
      this.images = [];
      this.kittyImageData.clear();
      this.pendingKittyImage = null;
      this.pendingITerm2File = null;
      this.markAllRowsDirty();
    } else if (mode === 3) {
      // Erase display + scrollback (xterm 확장)
      this.scrollback = [];
      this.buffer = this.createBuffer();
      this.images = [];
      this.kittyImageData.clear();
      this.pendingKittyImage = null;
      this.pendingITerm2File = null;
      this.markAllRowsDirty();
    }
  }

  private eraseInLine(mode: number) {
    const row = this.buffer[this.cursorY];
    if (mode === 0) {
      // Erase from cursor to end
      for (let x = this.cursorX; x < this.cols; x++) {
        row[x] = this.createEmptyCell();
      }
    } else if (mode === 1) {
      // Erase from start to cursor
      for (let x = 0; x <= this.cursorX; x++) {
        row[x] = this.createEmptyCell();
      }
    } else if (mode === 2) {
      // Erase entire line
      this.markFullBufferDirty();
      this.buffer[this.cursorY] = this.createEmptyRow();
    }
    this.markRowDirty(this.cursorY);
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

  getImages(): TerminalImage[] {
    return this.images;
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

  createSnapshot(): TerminalSnapshot {
    return {
      bufferRows: this.cloneBuffer(this.buffer),
      scrollbackRows: this.cloneBuffer(this.scrollback),
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      applicationCursorKeys: this.applicationCursorKeys,
      bracketedPasteMode: this.bracketedPasteMode,
      usingAlternateScreen: this.usingAlternateScreen,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
      outputOffset: 0,
      mainScreenBufferRows: this.mainScreenBuffer ? this.cloneBuffer(this.mainScreenBuffer) : undefined,
      mainScreenScrollbackRows: this.cloneBuffer(this.mainScreenScrollback),
      mainScreenCursor: { ...this.mainScreenCursor },
      mainScreenScrollRegion: { ...this.mainScreenScrollRegion },
    };
  }

  restoreSnapshot(snapshot: TerminalSnapshot) {
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
    this.bracketedPasteMode = snapshot.bracketedPasteMode ?? false;
    this.usingAlternateScreen = snapshot.usingAlternateScreen;
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
    this.markFullBufferDirty();
    this.markAllRowsDirty();
  }

  private snapshotRowToBufferRow(snapshotRow: Cell[]): Cell[] {
    const row = this.createEmptyRow();
    for (let x = 0; x < Math.min(snapshotRow.length, this.cols); x++) {
      row[x] = {
        char: snapshotRow[x].char,
        style: this.getInternedStyle(snapshotRow[x].style),
      };
    }

    return row;
  }
}
