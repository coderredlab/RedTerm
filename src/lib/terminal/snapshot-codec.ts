import type { Cell, TerminalParseState, TerminalSnapshot, TextStyle } from './ansi-parser';
import { KITTY_KEYBOARD_STACK_LIMIT } from './kitty-keyboard';

type SnapshotState = Omit<TerminalSnapshot,
  'bufferRows' | 'scrollbackRows' | 'mainScreenBufferRows' | 'mainScreenScrollbackRows' | 'runtimeImageState'>;
type CellContent = Omit<Cell, 'style'>;
type EncodedRow = Array<[number, string | CellContent]>;

export interface EncodedTerminalSnapshot {
  version: 2;
  styles: TextStyle[];
  state: SnapshotState;
  buffer: EncodedRow[];
  scrollback: EncodedRow[];
  mainBuffer?: EncodedRow[];
  mainScrollback?: EncodedRow[];
}

// Rows carry their actual contents, never a repeat count or allocated width.
// Scrollback matches the parser limit; geometry matches the native u16 PTY boundary.
const MAX_GEOMETRY = 0xffff;
const MAX_SCROLLBACK = 50000;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((4 * 1024 * 1024 * 4) / 3) * 4;
const MAX_IMAGE_CHUNKS = Math.ceil(MAX_IMAGE_BASE64_CHARS / 4096);

export function encodeTerminalSnapshot(snapshot: TerminalSnapshot): EncodedTerminalSnapshot {
  const { bufferRows, scrollbackRows, mainScreenBufferRows, mainScreenScrollbackRows,
    runtimeImageState: _images, ...state } = snapshot;
  const styles: TextStyle[] = [];
  const styleIds = new Map<TextStyle, number>();
  const styleKeys = new Map<string, number>();
  const styleId = (style: TextStyle): number => {
    const cached = styleIds.get(style);
    if (cached !== undefined) return cached;
    const key = JSON.stringify([style.fg, style.bg, style.bold, style.dim, style.italic,
      style.underline, style.inverse, style.strikethrough, style.hidden, style.ansiFgIndex,
      style.ansiBgIndex, style.kittyForegroundId, style.kittyUnderlineId]);
    let id = styleKeys.get(key);
    if (id === undefined) {
      id = styles.length;
      styles.push(style);
      styleKeys.set(key, id);
    }
    styleIds.set(style, id);
    return id;
  };
  const rows = (source: Cell[][]): EncodedRow[] => source.map((row) => {
    const result: EncodedRow = [];
    let run: [number, string | CellContent] | undefined;
    for (const cell of row) {
      const id = styleId(cell.style);
      // Only printable single-unit ASCII can be joined without losing cell boundaries.
      if (cell.char.length === 1 && cell.char >= ' ' && cell.char <= '~' &&
          !cell.hyperlink && !cell.imagePlaceholder && !cell.textSizing) {
        if (run && run[0] === id && typeof run[1] === 'string') run[1] += cell.char;
        else {
          run = [id, cell.char];
          result.push(run);
        }
      } else {
        const { style: _style, ...content } = cell;
        result.push([id, content]);
        run = undefined;
      }
    }
    return result;
  });
  return {
    version: 2, styles, state,
    buffer: rows(bufferRows), scrollback: rows(scrollbackRows),
    mainBuffer: mainScreenBufferRows === undefined ? undefined : rows(mainScreenBufferRows),
    mainScrollback: mainScreenScrollbackRows === undefined ? undefined : rows(mainScreenScrollbackRows),
  };
}

class InvalidSnapshotError extends Error {}
function invalid(): never { throw new InvalidSnapshotError('Invalid terminal snapshot'); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || value.includes(undefined)) return invalid();
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function text(value: unknown, max = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || value.length > max) return invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function optional<T>(value: unknown, decode: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : decode(value);
}
// Like parser restoration, discard an invalid pending transfer, not its screen.
function optionalTransfer<T>(value: unknown, decode: (value: unknown) => T): T | undefined {
  try { return optional(value, decode); } catch (error) {
    if (error instanceof InvalidSnapshotError) return undefined;
    throw error;
  }
}
function style(value: unknown): TextStyle {
  const v = record(value);
  const index = (value: unknown) => integer(value, 0xffffffff);
  return {
    fg: v.fg === null ? null : text(v.fg, 128), bg: text(v.bg, 128),
    bold: boolean(v.bold), dim: boolean(v.dim), italic: boolean(v.italic),
    underline: boolean(v.underline), inverse: boolean(v.inverse),
    strikethrough: boolean(v.strikethrough), hidden: boolean(v.hidden),
    ansiFgIndex: optional(v.ansiFgIndex, index), ansiBgIndex: optional(v.ansiBgIndex, index),
    kittyForegroundId: optional(v.kittyForegroundId, index), kittyUnderlineId: optional(v.kittyUnderlineId, index),
  };
}
function hyperlink(value: unknown): NonNullable<Cell['hyperlink']> {
  const v = record(value);
  return { uri: text(v.uri, 4096), id: optional(v.id, (id) => text(id, 256)) };
}
function placeholder(value: unknown): NonNullable<Cell['imagePlaceholder']> {
  const v = record(value);
  return {
    renderId: integer(v.renderId), imageId: integer(v.imageId),
    imageIdLow: integer(v.imageIdLow, 0xffffff), imageIdHigh: integer(v.imageIdHigh),
    placementId: optional(v.placementId, (id) => integer(id, 0xffffffff)),
    row: integer(v.row), col: integer(v.col), diacriticCount: integer(v.diacriticCount, 3),
  };
}
function alignment(value: unknown): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  return invalid();
}
function textSizing(value: unknown): NonNullable<Cell['textSizing']> {
  const v = record(value);
  return {
    text: optional(v.text, (value) => text(value, 4096)),
    scale: integer(v.scale, 7, 1), width: integer(v.width, 7, 1),
    numerator: integer(v.numerator, 15), denominator: integer(v.denominator, 15),
    verticalAlign: alignment(v.verticalAlign), horizontalAlign: alignment(v.horizontalAlign),
    row: integer(v.row), col: integer(v.col),
  };
}
function content(value: unknown): CellContent {
  const v = record(value);
  return {
    char: text(v.char), hyperlink: optional(v.hyperlink, hyperlink),
    imagePlaceholder: optional(v.imagePlaceholder, placeholder), textSizing: optional(v.textSizing, textSizing),
  };
}
function cursor(value: unknown): { x: number; y: number } {
  const v = record(value);
  return { x: integer(v.x, MAX_GEOMETRY), y: integer(v.y, MAX_GEOMETRY) };
}
function region(value: unknown): { top: number; bottom: number } {
  const v = record(value);
  return { top: integer(v.top, MAX_GEOMETRY), bottom: integer(v.bottom, MAX_GEOMETRY) };
}
function parseState(value: unknown): TerminalParseState {
  switch (value) {
    case 'normal': case 'escape': case 'csi': case 'csiDiscard': case 'osc': case 'oscEscape':
    case 'oscDiscard': case 'oscDiscardEscape': case 'ss3': case 'charset': case 'apc': case 'apcEscape':
    case 'apcDiscard': case 'apcDiscardEscape': case 'dcs': case 'dcsEscape': case 'dcsDiscard':
    case 'dcsDiscardEscape': return value;
    default: return invalid();
  }
}
function stringMap(value: unknown): Array<[string, string]> {
  let size = 0;
  return array(value, 32).map((entry): [string, string] => {
    const tuple = array(entry, 2);
    if (tuple.length !== 2) return invalid();
    const key = text(tuple[0]);
    const value = text(tuple[1]);
    size += key.length + value.length;
    if (size > 4096) return invalid();
    return [key, value];
  });
}
function chunks(value: unknown): { chunks: string[]; encodedLength: number } {
  const v = record(value);
  let encodedLength = 0;
  const chunks = array(v.chunks, MAX_IMAGE_CHUNKS).map((chunk) => {
    const result = text(chunk);
    encodedLength += result.length;
    if (encodedLength > MAX_IMAGE_BASE64_CHARS) return invalid();
    return result;
  });
  return { chunks, encodedLength };
}
function snapshotState(value: unknown): SnapshotState {
  const v = record(value);
  const geometry = (value: unknown) => integer(value, MAX_GEOMETRY);
  const flags = (value: unknown) => integer(value, 31);
  return {
    cursorX: geometry(v.cursorX), cursorY: geometry(v.cursorY),
    scrollTop: geometry(v.scrollTop), scrollBottom: geometry(v.scrollBottom),
    outputOffset: integer(v.outputOffset), applicationCursorKeys: boolean(v.applicationCursorKeys),
    usingAlternateScreen: boolean(v.usingAlternateScreen),
    autoWrapMode: optional(v.autoWrapMode, boolean), bracketedPasteMode: optional(v.bracketedPasteMode, boolean),
    mouseMode: optional(v.mouseMode, (value) => integer(value, 1003)),
    cursorVisible: optional(v.cursorVisible, boolean), synchronizedOutput: optional(v.synchronizedOutput, boolean),
    sgrMouseEncoding: optional(v.sgrMouseEncoding, boolean),
    kittyKeyboard: optional(v.kittyKeyboard, (value) => {
      const k = record(value);
      return { mainFlags: flags(k.mainFlags), alternateFlags: flags(k.alternateFlags),
        mainStack: array(k.mainStack, KITTY_KEYBOARD_STACK_LIMIT).map(flags),
        alternateStack: array(k.alternateStack, KITTY_KEYBOARD_STACK_LIMIT).map(flags) };
    }),
    oscTitle: optional(v.oscTitle, (value) => text(value, 1024)),
    oscCurrentDirectoryUri: optional(v.oscCurrentDirectoryUri, (value) => text(value, 4096)),
    oscPalette: optional(v.oscPalette, (value) => {
      const palette = array(value, 256);
      if (palette.length !== 256) return invalid();
      return palette.map((entry) => text(entry, 128));
    }),
    oscColors: optional(v.oscColors, (value) => {
      const c = record(value);
      return { foreground: text(c.foreground, 128), background: text(c.background, 128), cursor: text(c.cursor, 128) };
    }),
    oscShellIntegration: optional(v.oscShellIntegration, (value) => {
      const s = record(value);
      const phase = s.phase;
      if (phase !== 'none' && phase !== 'prompt' && phase !== 'command' && phase !== 'output' && phase !== 'finished') return invalid();
      return { phase, row: integer(s.row), col: integer(s.col), exitStatus: s.exitStatus === null ? null : integer(s.exitStatus, 255) };
    }),
    oscActiveHyperlink: optional(v.oscActiveHyperlink, hyperlink),
    mainScreenCursor: optional(v.mainScreenCursor, cursor), mainScreenScrollRegion: optional(v.mainScreenScrollRegion, region),
    parserState: optional(v.parserState, parseState),
    // The parser resets state and buffer together when a captured stream exceeds its limit.
    parserEscapeBuffer: optional(v.parserEscapeBuffer, text),
    parserStyle: optional(v.parserStyle, style), parserSavedCursor: optional(v.parserSavedCursor, cursor),
    parserLastPrintedChar: optional(v.parserLastPrintedChar, text),
    pendingKittyImage: optionalTransfer(v.pendingKittyImage, (value) => ({ params: stringMap(record(value).params), ...chunks(value) })),
    pendingITerm2File: optionalTransfer(v.pendingITerm2File, (value) => ({ args: stringMap(record(value).args), ...chunks(value) })),
    utf8PendingBytes: optional(v.utf8PendingBytes, (value) => array(value, 3).map((byte) => integer(byte, 255))),
  };
}

/** Untrusted local/IPC data enters here; legacy records are read, never emitted. */
export function decodeTerminalSnapshot(value: unknown): TerminalSnapshot | null {
  try {
    const v = record(value);
    if (v.version === undefined) {
      const rows = (value: unknown, max: number): Cell[][] => array(value, max).map((row) =>
        array(row, MAX_GEOMETRY).map((cell) => ({ ...content(cell), style: style(record(cell).style) })));
      return { ...snapshotState(v), bufferRows: rows(v.bufferRows, MAX_GEOMETRY),
        scrollbackRows: rows(v.scrollbackRows, MAX_SCROLLBACK),
        mainScreenBufferRows: optional(v.mainScreenBufferRows, (value) => rows(value, MAX_GEOMETRY)),
        mainScreenScrollbackRows: optional(v.mainScreenScrollbackRows, (value) => rows(value, MAX_SCROLLBACK)) };
    }
    if (v.version !== 2) return null;
    // A style can survive pool eviction, so its table is bounded by actual cells,
    // not by the parser's 4096-entry interning cache.
    const styles = array(v.styles, Number.MAX_SAFE_INTEGER).map(style);
    const rows = (value: unknown, max: number): Cell[][] => array(value, max).map((value) => {
      const row: Cell[] = [];
      for (const entry of array(value, MAX_GEOMETRY)) {
        const tuple = array(entry, 2);
        if (tuple.length !== 2) return invalid();
        const id = integer(tuple[0], styles.length - 1);
        const cellStyle = styles[id];
        const data = tuple[1];
        if (typeof data === 'string') {
          if (!data.length || data.length > MAX_GEOMETRY - row.length || /[^ -~]/.test(data)) return invalid();
          for (let index = 0; index < data.length; index++) row.push({ char: data[index], style: cellStyle });
        } else {
          if (row.length >= MAX_GEOMETRY) return invalid();
          row.push({ ...content(data), style: cellStyle });
        }
      }
      return row;
    });
    return { ...snapshotState(v.state), bufferRows: rows(v.buffer, MAX_GEOMETRY),
      scrollbackRows: rows(v.scrollback, MAX_SCROLLBACK),
      mainScreenBufferRows: optional(v.mainBuffer, (value) => rows(value, MAX_GEOMETRY)),
      mainScreenScrollbackRows: optional(v.mainScrollback, (value) => rows(value, MAX_SCROLLBACK)) };
  } catch {
    return null;
  }
}
