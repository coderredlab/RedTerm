// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { encode as encodePng } from "fast-png";
import { zlibSync } from "fflate";

import { AnsiParser, type Cell } from "./ansi-parser";
import { CanvasRenderer, compareTerminalImageOrder } from "./CanvasRenderer";

function scrollbackLengthAfter(sequence: string): number {
  const parser = new AnsiParser(20, 3);
  parser.write("line1\r\nline2\r\nline3\r\nline4");
  parser.write(sequence);
  return parser.getScrollbackLength();
}

function visibleRowText(parser: AnsiParser, row = 0): string {
  return parser
    .getBuffer()
    [row].map((cell) => cell.char)
    .join("")
    .trimEnd();
}


function kittyRgbaApc({
  widthCells = 1,
  heightCells = 1,
  pixelWidth = 1,
  pixelHeight = 1,
  payload = "AQIDBA==",
} = {}): string {
  return `\x1b_Ga=T,f=32,s=${pixelWidth},v=${pixelHeight},c=${widthCells},r=${heightCells};${payload}\x1b\\`;
}

function kittyRgbaTransmit({
  imageId,
  pixel = [1, 2, 3, 4],
}: {
  imageId: number;
  pixel?: number[];
}): string {
  const payload = Buffer.from(pixel).toString("base64");
  return `\x1b_Ga=t,f=32,s=1,v=1,i=${imageId};${payload}\x1b\\`;
}

function kittyPlace({
  imageId,
  placementId,
  widthCells = 1,
  heightCells = 1,
}: {
  imageId: number;
  placementId?: number;
  widthCells?: number;
  heightCells?: number;
}): string {
  const params = [`a=p`, `i=${imageId}`, `c=${widthCells}`, `r=${heightCells}`];
  if (placementId !== undefined) params.push(`p=${placementId}`);
  return `\x1b_G${params.join(",")}\x1b\\`;
}

function kittyDeleteImage(imageId: number, payload = ""): string {
  return `\x1b_Ga=d,d=i,i=${imageId}${payload ? `;${payload}` : ""}\x1b\\`;
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));
const TINY_JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);
const TINY_JPEG_BASE64 = Buffer.from(TINY_JPEG_BYTES).toString("base64");
const TWO_BY_ONE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z";
const TWO_BY_ONE_JPEG_BYTES = Uint8Array.from(Buffer.from(TWO_BY_ONE_JPEG_BASE64, "base64"));

const TWO_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADUlEQVR42mP8z8BQDwAFgwJ/l4YQqAAAAABJRU5ErkJggg==";

function pngWithDimensionsBase64(width: number, height: number): string {
  const bytes = Uint8Array.from(TINY_PNG_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString("base64");
}

function rgbaPngBase64(width: number, height: number, rgba: number[]): string {
  return Buffer.from(encodePng({
    width,
    height,
    data: Uint8Array.from(rgba),
    channels: 4,
    depth: 8,
  })).toString("base64");
}
function kittyPngApc(options = {}): string {
  const {
    payload = TINY_PNG_BASE64,
    cursorMovement,
  } = options;
  const widthCells = Object.prototype.hasOwnProperty.call(options, "widthCells")
    ? options.widthCells
    : 3;
  const heightCells = Object.prototype.hasOwnProperty.call(options, "heightCells")
    ? options.heightCells
    : 2;
  const params = ["a=T", "f=100"];
  if (widthCells !== undefined) params.push(`c=${widthCells}`);
  if (heightCells !== undefined) params.push(`r=${heightCells}`);
  if (cursorMovement !== undefined) params.push(`C=${cursorMovement}`);
  return `\x1b_G${params.join(",")};${payload}\x1b\\`;
}

function iterm2FileOsc(params: string[], payload: string, terminator = "\x07"): string {
  return `\x1b]1337;File=${params.join(";")}:${payload}${terminator}`;
}
function chunkBase64(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function writeChunkedKittyImage(parser: AnsiParser, params: string, payload: string): void {
  const chunks = chunkBase64(payload, 4096);
  if (chunks.length === 1) {
    parser.write(`\x1b_G${params};${chunks[0]}\x1b\\`);
    return;
  }
  parser.write(`\x1b_G${params},m=1;${chunks[0]}\x1b\\`);
  for (const chunk of chunks.slice(1, -1)) {
    parser.write(`\x1b_Gm=1;${chunk}\x1b\\`);
  }
  parser.write(`\x1b_Gm=0;${chunks.at(-1)}\x1b\\`);
}


function scrollUntilScrollbackCapStopsGrowing(parser: AnsiParser): number {
  let previousLength = parser.getScrollbackLength();
  for (let scrolls = 1; scrolls <= 5000; scrolls++) {
    parser.write("\r\n");
    const nextLength = parser.getScrollbackLength();
    if (nextLength === previousLength) {
      return scrolls;
    }
    previousLength = nextLength;
  }
  throw new Error("scrollback cap was not reached");
}

const STRING_CONTROL_TERMINATORS = [
  { name: "BEL", terminator: "\x07" },
  { name: "ST", terminator: "\x1b\\" },
];

describe("AnsiParser unsupported string controls", () => {
  for (const { name, terminator } of STRING_CONTROL_TERMINATORS) {
    test(`swallows APC payload terminated by ${name} without dropping surrounding text`, () => {
      const parser = new AnsiParser(80, 3);

      parser.write(`before\x1b_Ga=T,f=32;image-bytes${terminator}after`);

      expect(visibleRowText(parser)).toBe("beforeafter");
    });

    test(`renders Sixel DCS terminated by ${name} without printing payload text`, () => {
      const parser = new AnsiParser(80, 3);

      parser.write(`before\x1bPq\"1;1;5;5#0!9~sixel-bytes${terminator}after`);

      expect(visibleRowText(parser, 0)).toBe("before");
      expect(visibleRowText(parser, 1)).toBe("after");
      expect(parser.getImages()).toHaveLength(1);
    });
  }
});
describe("AnsiParser Kitty keyboard protocol", () => {
  test("queries and applies progressive enhancement flags", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));

    parser.write("\x1b[?u\x1b[=3u\x1b[=4;2u\x1b[=2;3u\x1b[?u");

    expect(responses).toEqual(["\x1b[?0u", "\x1b[?5u"]);
    expect(parser.getKittyKeyboardFlags()).toBe(5);

    parser.write("\x1b[=63u\x1b[=bad;1u");
    expect(parser.getKittyKeyboardFlags()).toBe(31);
  });

  test("pushes and pops bounded keyboard mode state", () => {
    const parser = new AnsiParser(20, 3);
    parser.write("\x1b[=5u\x1b[>9u\x1b[>3u\x1b[<u");
    expect(parser.getKittyKeyboardFlags()).toBe(9);
    parser.write("\x1b[<2u");
    expect(parser.getKittyKeyboardFlags()).toBe(0);

    const exactPop = new AnsiParser(20, 3);
    exactPop.write("\x1b[=5u\x1b[>9u\x1b[<u");
    expect(exactPop.getKittyKeyboardFlags()).toBe(0);
    expect(exactPop.createSnapshot().kittyKeyboard?.mainStack).toHaveLength(0);

    for (let flags = 1; flags <= 65; flags++) parser.write(`\x1b[>${flags}u`);
    expect(parser.createSnapshot().kittyKeyboard?.mainStack).toHaveLength(64);

    parser.write("\x1b[<2147483647u");
    expect(parser.getKittyKeyboardFlags()).toBe(0);
    expect(parser.createSnapshot().kittyKeyboard?.mainStack).toHaveLength(0);
  });

  test("keeps main and alternate screen keyboard stacks independent", () => {
    const parser = new AnsiParser(20, 3);
    parser.write("\x1b[=1u\x1b[?1049h");
    expect(parser.getKittyKeyboardFlags()).toBe(0);
    parser.write("\x1b[>10u\x1b[?1049l");
    expect(parser.getKittyKeyboardFlags()).toBe(1);
    parser.write("\x1b[?1049h");
    expect(parser.getKittyKeyboardFlags()).toBe(10);
    parser.write("\x1b[<u");
    expect(parser.getKittyKeyboardFlags()).toBe(0);
  });

  test("restores both keyboard mode stacks from snapshots", () => {
    const source = new AnsiParser(20, 3);
    source.write("\x1b[=1u\x1b[>3u\x1b[?1049h\x1b[=8u");

    const restored = new AnsiParser(20, 3);
    restored.restoreSnapshot(source.createSnapshot());
    expect(restored.getKittyKeyboardFlags()).toBe(8);
    restored.write("\x1b[?1049l");
    expect(restored.getKittyKeyboardFlags()).toBe(3);
    restored.write("\x1b[<u");
    expect(restored.getKittyKeyboardFlags()).toBe(0);
    expect(restored.createSnapshot().kittyKeyboard?.mainStack).toHaveLength(0);
  });
});
describe("AnsiParser terminal capabilities and SGR", () => {
  test("advertises Sixel support in primary device attributes only", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));

    parser.write("\x1b[c\x1b[>c");

    expect(responses).toEqual(["\x1b[?64;4c"]);
  });

  test("rejects unsupported XTSMGRAPHICS queries without scrolling", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    parser.write("first\r\nsecond\r\nthird");

    parser.write("\x1b[?2;1;0S");

    expect(parser.getBuffer().map((_, row) => visibleRowText(parser, row))).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(responses).toEqual(["\x1b[?2;3;0S"]);
  });

  test("keeps standard CSI S scrolling behavior", () => {
    const parser = new AnsiParser(20, 3);
    parser.write("first\r\nsecond\r\nthird");

    parser.write("\x1b[2S");

    expect(parser.getBuffer().map((_, row) => visibleRowText(parser, row))).toEqual([
      "third",
      "",
      "",
    ]);
  });

  test("preserves colon SGR subparameters without treating underline style as italic", () => {
    const parser = new AnsiParser(20, 3);

    parser.write("\x1b[4:3mX");

    expect(parser.getFullBuffer()[0][0].style).toMatchObject({ underline: true, italic: false });
  });
});
describe("AnsiParser OSC compatibility", () => {
  test("emits bounded title and file URI events across BEL and ST boundaries", () => {
    const parser = new AnsiParser(20, 3);
    const events: string[] = [];
    parser.setOscEventHandler((event) => {
      if (event.type === "title") events.push(`title:${event.value}`);
      if (event.type === "current-directory") events.push(`cwd:${event.uri}`);
    });

    parser.write("\x1b]2;dep");
    parser.write("loy\u202e\x1b\\");
    parser.write("\x1b]7;file://server/home/redterm\x07");
    parser.write("\x1b]7;https://example.com/not-a-directory\x07");

    expect(events).toEqual([
      "title:deploy",
      "cwd:file://server/home/redterm",
    ]);
    expect(parser.getOscTitle()).toBe("deploy");
    expect(parser.getCurrentDirectoryUri()).toBe("file://server/home/redterm");
  });

  test("continues a split OSC sequence after a JSON snapshot round trip", () => {
    const source = new AnsiParser(20, 3);
    source.write("\x1b]2;dep");

    const restored = new AnsiParser(20, 3);
    const titles: string[] = [];
    restored.setOscEventHandler((event) => {
      if (event.type === "title") titles.push(event.value);
    });
    restored.restoreSnapshot(JSON.parse(JSON.stringify(source.createSnapshot())));
    titles.length = 0;
    restored.write("loy\x1b\\");

    expect(titles).toEqual(["deploy"]);
    expect(restored.getOscTitle()).toBe("deploy");
    expect(visibleRowText(restored).trimEnd()).toBe("");
  });
  test("restores REP, saved cursor, and SGR meaning across snapshots", () => {
    const repSource = new AnsiParser(20, 3);
    repSource.write("A\x1b[3");
    const repRestored = new AnsiParser(20, 3);
    repRestored.restoreSnapshot(repSource.createSnapshot());
    repRestored.write("b");
    expect(visibleRowText(repRestored).trimEnd()).toBe("AAAA");

    const cursorSource = new AnsiParser(20, 3);
    cursorSource.write("abc\x1b7\r\x1b");
    const cursorRestored = new AnsiParser(20, 3);
    cursorRestored.restoreSnapshot(cursorSource.createSnapshot());
    cursorRestored.write("8X");
    expect(visibleRowText(cursorRestored).trimEnd()).toBe("abcX");

    const styleSource = new AnsiParser(20, 3);
    styleSource.write("\x1b[31mA");
    const styleRestored = new AnsiParser(20, 3);
    styleRestored.restoreSnapshot(styleSource.createSnapshot());
    styleRestored.write("B");
    expect(styleRestored.getBuffer()[0][1].style).toMatchObject({ ansiFgIndex: 1 });
  });


  test("stores OSC 8 hyperlinks on only the enclosed cells and snapshots them", () => {
    const parser = new AnsiParser(20, 3);
    parser.write("\x1b]8;id=docs;https://example.com/docs\x1b\\link\x1b]8;;\x1b\\ plain");

    expect(parser.getBuffer()[0].slice(0, 4).map((cell) => cell.hyperlink)).toEqual([
      { uri: "https://example.com/docs", id: "docs" },
      { uri: "https://example.com/docs", id: "docs" },
      { uri: "https://example.com/docs", id: "docs" },
      { uri: "https://example.com/docs", id: "docs" },
    ]);
    expect(parser.getBuffer()[0][4].hyperlink).toBeUndefined();

    const restored = new AnsiParser(20, 3);
    restored.restoreSnapshot(parser.createSnapshot());
    expect(restored.getBuffer()[0][2].hyperlink).toEqual({
      uri: "https://example.com/docs",
      id: "docs",
    });
  });

  test("sets queries and resets palette and dynamic colors", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    const foregrounds: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    parser.setOscColorDefaults({ foreground: "#112233", background: "#223344", cursor: "#334455" });
    parser.setOscEventHandler((event) => {
      if (event.type === "colors") foregrounds.push(event.colors.foreground);
    });

    parser.write("\x1b[31mA");
    parser.write("\x1b]4;1;rgb:00/ff/00\x1b\\B");
    expect(parser.getBuffer()[0][0].style.fg).toBe("#00ff00");
    expect(parser.getBuffer()[0][1].style.fg).toBe("#00ff00");
    parser.write("\x1b]4;1;?\x1b\\");
    expect(responses.at(-1)).toBe("\x1b]4;1;rgb:0000/ffff/0000\x1b\\");

    parser.write("\x1b]104;1\x1b\\");
    expect(parser.getBuffer()[0][0].style.fg).toBe("#ff6b6b");
    parser.write("\x1b]10;#abcdef\x07\x1b]10;?\x1b\\");
    expect(foregrounds.at(-1)).toBe("#abcdef");
    expect(responses.at(-1)).toBe("\x1b]10;rgb:abab/cdcd/efef\x1b\\");
    parser.write("\x1b]110\x07");
    expect(foregrounds.at(-1)).toBe("#112233");
  });

  test("tracks OSC 133 shell phases and exit status", () => {
    const parser = new AnsiParser(20, 3);
    parser.write("prompt");
    parser.write("\x1b]133;A\x1b\\\x1b]133;B\x1b\\\x1b]133;C\x1b\\\x1b]133;D;7\x1b\\");

    expect(parser.getShellIntegrationState()).toEqual({
      phase: "finished",
      row: 0,
      col: 6,
      exitStatus: 7,
    });
    const restored = new AnsiParser(20, 3);
    restored.restoreSnapshot(parser.createSnapshot());
    expect(restored.getShellIntegrationState()).toEqual(parser.getShellIntegrationState());
  });
  test("decodes OSC 52 clipboard writes across chunks and both terminators", () => {
    const parser = new AnsiParser(20, 3);
    const writes: string[] = [];
    parser.setOscEventHandler((event) => {
      if (event.type === "clipboard") writes.push(event.text);
    });
    const encoded = Buffer.from("hello 안녕").toString("base64");

    parser.write(`\x1b]52;c;${encoded.slice(0, 5)}`);
    parser.write(`${encoded.slice(5)}\x1b\\`);
    parser.write("\x1b]52;c;\x07");

    expect(writes).toEqual(["hello 안녕", ""]);
  });

  test("rejects OSC 52 reads unsafe targets malformed text and oversized payloads", () => {
    const parser = new AnsiParser(20, 3);
    const writes: string[] = [];
    parser.setOscEventHandler((event) => {
      if (event.type === "clipboard") writes.push(event.text);
    });

    parser.write("\x1b]52;c;?\x07");
    parser.write("\x1b]52;p;dGVzdA==\x07");
    parser.write("\x1b]52;c;%%%%\x07");
    parser.write("\x1b]52;c;/w==\x07");
    parser.write("\x1b]52;c;AA==\x07");
    const overDecodedLimit = Buffer.alloc(64 * 1024 + 1).toString("base64");
    parser.write(`\x1b]52;c;${overDecodedLimit}\x07`);
    parser.write(`\x1b]52;c;${"A".repeat(overDecodedLimit.length + 128)}\x07ok`);

    expect(writes).toEqual([]);
    expect(visibleRowText(parser).trimEnd()).toBe("ok");
  });
  test("terminates normal and discarded OSC after consecutive escape bytes", () => {
    const parser = new AnsiParser(40, 2);
    const titles: string[] = [];
    parser.setOscEventHandler((event) => {
      if (event.type === "title") titles.push(event.value);
    });

    parser.write("\x1b]2;bad\x1b\x1b\\after");
    expect(titles).toEqual(["bad"]);
    expect(visibleRowText(parser).trimEnd()).toBe("after");

    parser.write(`\x1b]2;${"x".repeat(5000)}\x1b\x1b\\tail`);
    expect(visibleRowText(parser).trimEnd()).toBe("aftertail");
  });

  test("never leaves an unmatched surrogate at the OSC title limit", () => {
    const parser = new AnsiParser(20, 2);
    parser.write(`\x1b]2;${"a".repeat(1023)}😀\x1b\\`);

    const title = parser.getOscTitle();
    expect(title).toBe("a".repeat(1023));
    expect(title?.isWellFormed()).toBe(true);
  });


});

describe("AnsiParser OSC 66 text sizing", () => {
  test("splits zero-width metadata into scaled grapheme blocks", () => {
    const parser = new AnsiParser(12, 4);

    parser.write("\x1b]66;s=2;Ab\x07");

    const buffer = parser.getBuffer();
    expect(parser.getCursor()).toEqual({ x: 4, y: 0 });
    expect(buffer[0][0]).toMatchObject({
      char: "A",
      textSizing: { text: "A", scale: 2, width: 1, row: 0, col: 0 },
    });
    expect(buffer[0][1]).toMatchObject({ char: "", textSizing: { row: 0, col: 1 } });
    expect(buffer[1][0]).toMatchObject({ char: "", textSizing: { row: 1, col: 0 } });
    expect(buffer[0][2]).toMatchObject({
      char: "b",
      textSizing: { text: "b", scale: 2, width: 1, row: 0, col: 0 },
    });
  });

  test("uses explicit width and fractional alignment for one block", () => {
    const parser = new AnsiParser(12, 4);

    parser.write("\x1b]66;s=2:w=3:n=1:d=2:v=1:h=2;Hi\x1b\\");

    const buffer = parser.getBuffer();
    expect(parser.getCursor()).toEqual({ x: 6, y: 0 });
    expect(buffer[0][0]).toMatchObject({
      char: "Hi",
      textSizing: {
        text: "Hi",
        scale: 2,
        width: 3,
        numerator: 1,
        denominator: 2,
        verticalAlign: 1,
        horizontalAlign: 2,
        row: 0,
        col: 0,
      },
    });
    expect(buffer[1][5]).toMatchObject({ char: "", textSizing: { row: 1, col: 5 } });
  });

  test("reports width and scale support through cursor position changes", () => {
    const parser = new AnsiParser(20, 4);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));

    parser.write("\r\x1b[6n");
    parser.write("\x1b]66;w=2; \x07\x1b[6n");
    parser.write("\x1b]66;s=2; \x07\x1b[6n");

    expect(responses).toEqual(["\x1b[1;1R", "\x1b[1;3R", "\x1b[1;5R"]);
  });

  test("wraps blocks and skips writes over their lower rows", () => {
    const parser = new AnsiParser(5, 4);
    parser.write("abcd\x1b]66;s=2:w=1;X\x07");

    expect(parser.getCursor()).toEqual({ x: 2, y: 1 });
    expect(parser.getBuffer()[1][0].textSizing?.text).toBe("X");

    parser.write("\x1b[3;1Hq");
    expect(parser.getBuffer()[1][0].textSizing?.text).toBe("X");
    expect(parser.getBuffer()[2][2].char).toBe("q");
    expect(parser.getCursor()).toEqual({ x: 3, y: 2 });
  });

  test("erases a whole block when writing or erasing through it", () => {
    const rootOverwrite = new AnsiParser(8, 4);
    rootOverwrite.write("\x1b]66;s=2:w=1;X\x07\x1b[1;1Ha");
    expect(rootOverwrite.getBuffer()[0][0].char).toBe("a");
    expect(rootOverwrite.getBuffer()[1][1].textSizing).toBeUndefined();

    const lowerErase = new AnsiParser(8, 4);
    lowerErase.write("\x1b]66;s=2:w=1;X\x07\x1b[2;2H\x1b[X");
    expect(lowerErase.getBuffer()[0][0].char).toBe(" ");
    expect(lowerErase.getBuffer()[1][1].textSizing).toBeUndefined();
  });

  test("preserves complete snapshots and discards blocks broken by reflow", () => {
    const source = new AnsiParser(8, 4);
    source.write("\x1b]66;s=2:w=2;Wide\x07");

    const restored = new AnsiParser(8, 4);
    restored.restoreSnapshot(source.createSnapshot());
    expect(restored.getBuffer()[0][0].textSizing?.text).toBe("Wide");
    expect(restored.getBuffer()[1][3].textSizing).toMatchObject({ row: 1, col: 3 });

    restored.resize(3, 4);
    expect(restored.getFullBuffer().flat().some((cell) => cell.textSizing)).toBe(false);
  });

  test("keeps earlier blocks when wrapped text crosses continuation rows", () => {
    const parser = new AnsiParser(4, 4);

    parser.write("\x1b]66;s=2;ABC\x07");

    const buffer = parser.getBuffer();
    expect(buffer[0][0].textSizing?.text).toBe("A");
    expect(buffer[0][2].textSizing?.text).toBe("B");
    expect(buffer[2][0].textSizing?.text).toBe("C");
    expect(parser.getCursor()).toEqual({ x: 2, y: 2 });
  });

  test("wraps wide characters after skipping a block continuation row", () => {
    const parser = new AnsiParser(3, 4);
    parser.write("\x1b]66;s=2;X\x07");

    parser.write("\x1b[2;1H가");

    const buffer = parser.getBuffer();
    expect(buffer[0][0].textSizing?.text).toBe("X");
    expect(buffer[2][0].char).toBe("가");
    expect(buffer[2][1].char).toBe("");
    expect(parser.getCursor()).toEqual({ x: 2, y: 2 });
  });

  test("preserves complete scrollback blocks beyond the dropped edge", () => {
    const blockSource = new AnsiParser(4, 2);
    blockSource.write("\x1b]66;s=2;X\x07");
    const blockRows = blockSource.createSnapshot().bufferRows;
    const emptySnapshot = new AnsiParser(4, 2).createSnapshot();
    const snapshot = blockSource.createSnapshot();
    snapshot.scrollbackRows = Array.from({ length: 1000 }, (_, row) => {
      if (row === 7) return structuredClone(blockRows[0]);
      if (row === 8) return structuredClone(blockRows[1]);
      return structuredClone(emptySnapshot.bufferRows[0]);
    });
    snapshot.bufferRows = structuredClone(emptySnapshot.bufferRows);
    snapshot.cursorX = 0;
    snapshot.cursorY = 1;

    const restored = new AnsiParser(4, 2);
    restored.restoreSnapshot(snapshot);
    restored.write("\n");

    const fullBuffer = restored.getFullBuffer();
    expect(fullBuffer[6][0].textSizing?.text).toBe("X");
    expect(fullBuffer[7][1].textSizing).toMatchObject({ row: 1, col: 1 });
  });

  test("removes blocks split by downward region scrolling", () => {
    const parser = new AnsiParser(4, 4);
    parser.write("\x1b]66;s=2;X\x07");

    parser.write("\x1b[2;4r\x1b[T");

    expect(parser.getBuffer().flat().some((cell) => cell.textSizing)).toBe(false);
  });

  test("removes blocks split by deleting lines at a region boundary", () => {
    const parser = new AnsiParser(4, 4);
    parser.write("\x1b[3;1H\x1b]66;s=2;X\x07");

    parser.write("\x1b[2;3r\x1b[2;1H\x1b[M");

    expect(parser.getBuffer().flat().some((cell) => cell.textSizing)).toBe(false);
  });

  test("bounds combining marks on text-sized cells and restored snapshots", () => {
    const parser = new AnsiParser(8, 2);
    parser.write("\x1b]66;s=1;X\x07\x1b[1;1H" + "\u0301".repeat(3000));

    const cell = parser.getBuffer()[0][0];
    const boundedText = cell.char;
    expect(new TextEncoder().encode(boundedText).length).toBeLessThanOrEqual(4096);

    parser.write("\u0301".repeat(100));
    expect(parser.getBuffer()[0][0].char).toBe(boundedText);

    const snapshot = parser.createSnapshot();
    snapshot.bufferRows[0][0].char = "x".repeat(4097);
    snapshot.bufferRows[0][0].textSizing!.text = snapshot.bufferRows[0][0].char;
    const restored = new AnsiParser(8, 2);
    restored.restoreSnapshot(snapshot);
    expect(restored.getBuffer()[0][0].textSizing).toBeUndefined();
  });

  test("scrolls resized short scrollback rows without throwing", () => {
    const source = new AnsiParser(2, 2);
    const snapshot = source.createSnapshot();
    snapshot.scrollbackRows = Array.from(
      { length: 1000 },
      () => structuredClone(snapshot.bufferRows[0]),
    );
    snapshot.cursorX = 0;
    snapshot.cursorY = 1;
    const restored = new AnsiParser(2, 2);
    restored.restoreSnapshot(snapshot);
    restored.resize(4, 2);

    expect(() => restored.write("\n")).not.toThrow();
    expect(restored.getFullBuffer()).toHaveLength(1002);
  });

  test("clears both cells of a wide character before placing a block", () => {
    const parser = new AnsiParser(4, 2);
    parser.write("가\x1b[1;2H\x1b]66;w=1;X\x07");

    expect(parser.getBuffer()[0][0].char).toBe(" ");
    expect(parser.getBuffer()[0][1].textSizing?.text).toBe("X");
  });

  test("rejects snapshot text on block continuation cells", () => {
    const source = new AnsiParser(4, 2);
    source.write("\x1b]66;s=2;X\x07");
    const snapshot = source.createSnapshot();
    snapshot.bufferRows[0][1].char = "x".repeat(4097);
    snapshot.bufferRows[0][1].textSizing!.text = "x".repeat(4097);

    const restored = new AnsiParser(4, 2);
    restored.restoreSnapshot(snapshot);

    expect(restored.getBuffer().flat().some((cell) => cell.textSizing)).toBe(false);
  });

  test("invalidates Kitty virtual origins overwritten by a block", () => {
    const parser = new AnsiParser(20, 4);
    parser.write(kittyRgbaTransmit({ imageId: 13 }));
    parser.write(kittyRgbaTransmit({ imageId: 14 }));
    parser.write("\x1b_Ga=p,i=13,p=11,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b_Ga=p,i=14,p=22,P=13,Q=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b[38:5:13;58:5:11m\u{10eeee}\x1b[0m");
    expect(parser.getImages().map((image) => image.placementId)).toEqual([11, 22]);

    parser.write("\x1b[1;1H\x1b]66;w=1;X\x07");

    expect(parser.getImages()).toHaveLength(0);
  });

  test("combines OSC 66 marks with an existing block", () => {
    const parser = new AnsiParser(8, 4);
    parser.write("\x1b]66;s=2;A\x07\x1b[1;1H\x1b]66;s=2;\u0301\x07");

    const buffer = parser.getBuffer();
    expect(buffer[0][0].char).toBe("A\u0301");
    expect(buffer[0][0].textSizing?.text).toBe("A\u0301");
    expect(buffer[1][1].textSizing).toMatchObject({ row: 1, col: 1 });
  });

  test("does not combine explicit-width text that only starts with a mark", () => {
    const parser = new AnsiParser(8, 4);
    parser.write("\x1b]66;s=2;A\x07\x1b[1;1H\x1b]66;w=7;\u0301abcdef\x07");

    expect(parser.getBuffer()[0][0].textSizing).toMatchObject({
      text: "\u0301abcdef",
      scale: 1,
      width: 7,
    });
    expect(parser.getCursor()).toEqual({ x: 7, y: 0 });
  });

  test("uses presentation-sensitive widths for implicit OSC 66 graphemes", () => {
    const parser = new AnsiParser(12, 4);
    parser.write("\x1b]66;;©\x07");
    parser.write("\x1b]66;;❤︎\x07");
    parser.write("\x1b]66;;❤️\x07");
    parser.write("\x1b]66;;🐈\x07");
    parser.write("\x1b]66;;\u0301\x07");

    expect(parser.getCursor()).toEqual({ x: 6, y: 0 });
    expect(parser.getBuffer()[0][0].textSizing).toMatchObject({ text: "©", width: 1 });
    expect(parser.getBuffer()[0][1].textSizing).toMatchObject({ text: "❤︎", width: 1 });
    expect(parser.getBuffer()[0][2].textSizing).toMatchObject({ text: "❤️", width: 2 });
    expect(parser.getBuffer()[0][4].textSizing).toMatchObject({ text: "🐈", width: 2 });
  });

  test("keeps OSC 66 blocks on the current row when DECAWM is disabled after restore", () => {
    const source = new AnsiParser(5, 2);
    source.write("abcd\x1b[?7l");
    const restored = new AnsiParser(5, 2);
    restored.restoreSnapshot(source.createSnapshot());

    restored.write("\x1b]66;w=2;XY\x07");

    expect(visibleRowText(restored)).toBe("abcXY");
    expect(restored.getCursor()).toEqual({ x: 5, y: 0 });
  });

  test("overwrites a right-edge block instead of looping with DECAWM disabled", () => {
    const parser = new AnsiParser(5, 4);
    parser.write("\x1b[1;4H\x1b]66;s=2:w=1;X\x07");
    parser.write("\x1b[2;4H\x1b[?7lq");

    expect(parser.getBuffer()[1][3].char).toBe("q");
    expect(parser.getBuffer().flat().some((cell) => cell.textSizing)).toBe(false);
    expect(parser.getCursor()).toEqual({ x: 4, y: 1 });
  });

  test("preserves an existing block when partial-region overflow rejects replacement", () => {
    const parser = new AnsiParser(8, 3);
    parser.write("\x1b[3;1H\x1b]66;w=1;X\x07");
    parser.write("\x1b[2;3r\x1b[3;1H\x1b]66;s=2;Y\x07");

    expect(parser.getBuffer()[2][0].textSizing).toMatchObject({ text: "X", scale: 1, width: 1 });
    expect(parser.getBuffer()[2][0].char).toBe("X");
  });

  test("rejects invalid metadata and text over the byte limit", () => {
    const parser = new AnsiParser(20, 3);
    parser.write("\x1b]66;s=8;bad\x07");
    parser.write("\x1b]66;n=2:d=1;bad\x07");
    parser.write("\x1b]66;;" + "한".repeat(1366) + "\x07");
    parser.write("ok");

    expect(visibleRowText(parser)).toBe("ok");
    expect(parser.getFullBuffer().flat().some((cell) => cell.textSizing)).toBe(false);
  });
});

describe("CanvasRenderer OSC 66 text sizing", () => {
  test("draws scaled origins at the scaled font and block width", () => {
    const draws: Array<{ text: string; maxWidth: number | undefined; font: string }> = [];
    const context = {
      fillStyle: "",
      font: "",
      textAlign: "start",
      fillRect() {},
      fillText(text: string, _x: number, _y: number, maxWidth?: number) {
        draws.push({ text, maxWidth, font: this.font });
      },
    };
    const renderer = Object.create(CanvasRenderer.prototype) as CanvasRenderer;
    Object.assign(renderer, {
      ctx: context,
      wideCharCache: new Map(),
      config: {
        fontSize: 10,
        fontFamily: "monospace",
        defaultFg: "#fff",
        defaultBg: "#000",
        horizontalPadding: 0,
      },
      charWidth: 6,
      charHeight: 14,
    });
    const parser = new AnsiParser(12, 4);
    parser.write("\x1b]66;s=2;AB\x07");

    renderer.drawVisibleRowText(parser.getBuffer(), 0, 4);

    expect(draws.filter((draw) => draw.maxWidth !== undefined)).toEqual([
      { text: "A", maxWidth: 12, font: "20px monospace" },
      { text: "B", maxWidth: 12, font: "20px monospace" },
    ]);
  });
});

describe("CanvasRenderer image ordering", () => {
  test("orders same-z Kitty images by protocol image id", () => {
    const images = [
      { protocol: "kitty", id: 1, imageId: 20, zIndex: 0 },
      { protocol: "kitty", id: 3, imageId: 10, zIndex: 0 },
      { protocol: "iterm2", id: 2, zIndex: -1 },
    ] as unknown as Array<Parameters<typeof compareTerminalImageOrder>[0]>;

    images.sort(compareTerminalImageOrder);

    expect(images.map((image) => image.imageId ?? image.id)).toEqual([2, 10, 20]);
  });
});

describe("AnsiParser Kitty images", () => {
  test("retains three max-sized visible image caches without LRU churn", () => {
    const renderer = Object.create(CanvasRenderer.prototype) as CanvasRenderer;
    const pixelsPerImage = 4 * 1024 * 1024;
    const internals = renderer as unknown as {
      imageCache: Map<number, unknown>;
      imageCachePixels: number;
      protectedImageCacheIds: Set<number>;
      evictImageCacheIfNeeded(incomingPixels: number): boolean;
    };
    internals.imageCache = new Map([
      [1, { kind: "ready", source: {}, pixelCount: pixelsPerImage, animated: false }],
      [2, { kind: "ready", source: {}, pixelCount: pixelsPerImage, animated: false }],
    ]);
    internals.imageCachePixels = pixelsPerImage * 2;
    internals.protectedImageCacheIds = new Set([1, 2, 3]);

    expect(internals.evictImageCacheIfNeeded(pixelsPerImage)).toBe(true);
    expect([...internals.imageCache.keys()]).toEqual([1, 2]);
  });

  test("prunes unretained image cache entries and revokes object URLs", () => {
    const renderer = Object.create(CanvasRenderer.prototype) as CanvasRenderer;
    const internals = renderer as unknown as {
      imageCache: Map<number, unknown>;
      imageCachePixels: number;
    };
    internals.imageCache = new Map([
      [1, { kind: "loading", url: "blob:stale", pixelCount: 4 }],
      [2, { kind: "ready", source: {}, pixelCount: 6, animated: false }],
    ]);
    internals.imageCachePixels = 10;
    const revoked: string[] = [];
    const revokeObjectUrl = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => revoked.push(url);
    try {
      renderer.pruneImageCache(new Set([2]));
    } finally {
      URL.revokeObjectURL = revokeObjectUrl;
    }

    expect([...internals.imageCache.keys()]).toEqual([2]);
    expect(internals.imageCachePixels).toBe(6);
    expect(revoked).toEqual(["blob:stale"]);
  });

  test("captures one chafa-style multi-chunk RGBA APC image without printing payload bytes", () => {
    const parser = new AnsiParser(80, 3);
    const rgbaBytes = new Uint8Array([
      0, 1, 2, 3,
      4, 5, 6, 7,
      8, 9, 10, 11,
      12, 13, 14, 15,
    ]);

    parser.write("top\r\nabc");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write("\x1b_Ga=T,f=32,s=2,v=2,c=2,r=1,m=1\x1b\\");
    parser.write("\x1b_Gm=1;AAECAwQFBgcI\x1b\\");
    parser.write("\x1b_Gm=1;CQoLDA0ODw==\x1b\\");
    parser.write("\x1b_Gm=0\x1b\\tail");

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBe(2);
    expect(image.heightCells).toBe(1);
    expect(image.pixelWidth).toBe(2);
    expect(image.pixelHeight).toBe(2);
    expect(Array.from(image.data)).toEqual(Array.from(rgbaBytes));
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("abc");
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("     tail");
    expect(parser.getFullCursor()).toEqual({ x: 9, y: cursorBeforeImage.y + image.heightCells });
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    expect(visibleText).not.toContain("AAECAwQFBgcI");
    expect(visibleText).not.toContain("CQoLDA0ODw==");
  });

  test("continues a multi-chunk Kitty image after a JSON snapshot round trip", () => {
    const source = new AnsiParser(80, 3);
    source.write("\x1b_Ga=T,f=32,s=2,v=2,c=2,r=1,m=1\x1b\\");
    source.write("\x1b_Gm=1;AAECAwQFBgcI\x1b\\");

    const restored = new AnsiParser(80, 3);
    restored.restoreSnapshot(JSON.parse(JSON.stringify(source.createSnapshot())));
    restored.write("\x1b_Gm=1;CQoLDA0ODw==\x1b\\");
    restored.write("\x1b_Gm=0\x1b\\");

    expect(Array.from(restored.getImages()[0].data)).toEqual([
      0, 1, 2, 3,
      4, 5, 6, 7,
      8, 9, 10, 11,
      12, 13, 14, 15,
    ]);
  });
  test("keeps a pending Kitty anchor in full-buffer coordinates across snapshots", () => {
    const source = new AnsiParser(80, 3);
    source.write("1\r\n2\r\n3\r\n4\r\n5");
    const anchor = source.getFullCursor();
    source.write("\x1b_Ga=T,f=32,s=2,v=2,c=2,r=1,m=1;AAECAwQFBgcI\x1b\\");

    const restored = new AnsiParser(80, 3);
    restored.restoreSnapshot(JSON.parse(JSON.stringify(source.createSnapshot())));
    restored.write("\x1b_Gm=0;CQoLDA0ODw==\x1b\\");

    expect(restored.getImages()[0]).toMatchObject({ row: anchor.y, col: anchor.x });
  });

  test("discards a pending Kitty transfer when its anchor scrolls out of a restored snapshot", () => {
    const source = new AnsiParser(80, 3);
    source.write("\x1b_Ga=T,f=32,s=2,v=2,m=1;AAAA\x1b\\");
    const snapshot = source.createSnapshot();
    snapshot.scrollbackRows = Array.from({ length: 1001 }, () => snapshot.bufferRows[0]);
    snapshot.pendingKittyImage!.row = 0;

    const restored = new AnsiParser(80, 3);
    restored.restoreSnapshot(snapshot);

    expect((restored as unknown as { pendingKittyImage: unknown }).pendingKittyImage).toBeNull();
  });

  test("rejects oversized pending Kitty APC buffers from snapshots", () => {
    const source = new AnsiParser(80, 3);
    const snapshot = source.createSnapshot();
    snapshot.parserState = "apc";
    snapshot.parserEscapeBuffer = "G".repeat(8195);

    const restored = new AnsiParser(80, 3);
    restored.restoreSnapshot(snapshot);

    expect(restored.createSnapshot()).toMatchObject({
      parserState: "normal",
      parserEscapeBuffer: "",
    });
  });

  test("rejects pending image snapshots above the chunk count limit", () => {
    const source = new AnsiParser(80, 3);
    source.write("\x1b_Ga=T,f=32,s=2,v=2,m=1;AAAA\x1b\\");
    const snapshot = source.createSnapshot();
    snapshot.pendingKittyImage!.chunks = Array.from({ length: 5463 }, () => "");

    const restored = new AnsiParser(80, 3);
    restored.restoreSnapshot(snapshot);

    expect((restored as unknown as { pendingKittyImage: unknown }).pendingKittyImage).toBeNull();
  });


  test("captures explicit direct RGB APC image as RGBA without printing payload bytes", () => {
    const parser = new AnsiParser(80, 3);
    const rgbBytes = [65, 66, 67];
    const rgbPayload = Buffer.from(rgbBytes).toString("base64");

    parser.write("abc");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`\x1b_Ga=T,t=d,f=24,s=1,v=1,c=1,r=1;${rgbPayload}\x1b\\tail`);

    const images = parser.getImages();
    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBe(1);
    expect(image.heightCells).toBe(1);
    expect(image.pixelWidth).toBe(1);
    expect(image.pixelHeight).toBe(1);
    expect(image.kind ?? image.format).toBe("rgba");
    expect(Array.from(image.data)).toEqual([...rgbBytes, 255]);
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("abc");
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("    tail");
    expect(parser.getFullCursor()).toEqual({
      x: 8,
      y: cursorBeforeImage.y + image.heightCells,
    });
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    expect(visibleText).not.toContain(rgbPayload);
    expect(visibleText).not.toContain("ABC");
  });

  test("ignores file-medium Kitty image paths without placement, cursor movement, or payload text", () => {
    const parser = new AnsiParser(80, 3);
    const path = "/tmp/redterm-kitty.rgb";
    const encodedPath = Buffer.from(path).toString("base64");

    parser.write("abc");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`\x1b_Ga=T,t=f,f=32,s=1,v=1,c=1,r=1;${encodedPath}\x1b\\`);

    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");

    expect(parser.getImages()).toHaveLength(0);
    expect(parser.getFullCursor()).toEqual(cursorBeforeImage);
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("abc");
    expect(visibleText).not.toContain(encodedPath);
    expect(visibleText).not.toContain(path);
  });

  test("captures direct PNG APC image using placement cells and IHDR pixel dimensions", () => {
    const parser = new AnsiParser(80, 5);

    parser.write("top\r\nxy");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`${kittyPngApc({ widthCells: 3, heightCells: 2 })}tail`);

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBe(3);
    expect(image.heightCells).toBe(2);
    expect(image.pixelWidth).toBe(1);
    expect(image.pixelHeight).toBe(1);
    expect(image.kind ?? image.format).toBe("png");
    expect(Array.from(image.data)).toEqual(Array.from(TINY_PNG_BYTES));
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("xy");
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("     tail");
    expect(parser.getFullCursor()).toEqual({ x: 9, y: cursorBeforeImage.y + image.heightCells });
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    expect(visibleText).not.toContain(TINY_PNG_BASE64);
  });

  test("computes PNG placement rows from columns and advances by the computed height", () => {
    const parser = new AnsiParser(80, 6);

    parser.write("top\r\nxy");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(
      `${kittyPngApc({
        widthCells: 4,
        heightCells: undefined,
        payload: TWO_BY_ONE_PNG_BASE64,
      })}tail`,
    );

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.pixelWidth).toBe(2);
    expect(image.pixelHeight).toBe(1);
    expect(image.widthCells).toBe(4);
    expect(image.heightCells).toBe(1);
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("      tail");
    expect(parser.getFullCursor()).toEqual({ x: 10, y: cursorBeforeImage.y + image.heightCells });
  });

  test("computes PNG placement columns from rows", () => {
    const parser = new AnsiParser(80, 6);

    parser.write(
      kittyPngApc({
        widthCells: undefined,
        heightCells: 3,
        payload: TWO_BY_ONE_PNG_BASE64,
      }),
    );

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.pixelWidth).toBe(2);
    expect(image.pixelHeight).toBe(1);
    expect(image.widthCells).toBe(12);
    expect(image.heightCells).toBe(3);
  });

  test("stores C=1 PNG image without moving the cursor before following text", () => {
    const parser = new AnsiParser(80, 5);

    parser.write("abc");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`${kittyPngApc({ cursorMovement: 1 })}tail`);

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    expect(images[0].row).toBe(cursorBeforeImage.y);
    expect(images[0].col).toBe(cursorBeforeImage.x);
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("abctail");
    expect(parser.getFullCursor()).toEqual({
      x: cursorBeforeImage.x + "tail".length,
      y: cursorBeforeImage.y,
    });
  });

  test("transmits RGBA data by image id without displaying it and later places the stored image", () => {
    const parser = new AnsiParser(80, 5);

    parser.write("abc");
    const cursorBeforeTransmit = parser.getFullCursor();

    parser.write(kittyRgbaTransmit({ imageId: 7, pixel: [1, 2, 3, 4] }));

    expect(parser.getImages()).toHaveLength(0);
    expect(parser.getFullCursor()).toEqual(cursorBeforeTransmit);
    expect(visibleRowText(parser)).toBe("abc");

    parser.write("xy");
    const cursorBeforePlacement = parser.getFullCursor();

    parser.write(`${kittyPlace({ imageId: 7, widthCells: 2, heightCells: 1 })}tail`);

    const images = parser.getImages();
    expect(images).toHaveLength(1);
    expect(images[0].row).toBe(cursorBeforePlacement.y);
    expect(images[0].col).toBe(cursorBeforePlacement.x);
    expect(images[0].widthCells).toBe(2);
    expect(images[0].heightCells).toBe(1);
    expect(Array.from(images[0].data)).toEqual([1, 2, 3, 4]);
    expect(visibleRowText(parser, cursorBeforeTransmit.y)).toContain("abcxy");
  });

  test("replaces an existing placement with the same image id and placement id", () => {
    const parser = new AnsiParser(80, 5);

    parser.write(kittyRgbaTransmit({ imageId: 8, pixel: [9, 8, 7, 6] }));

    parser.write("first");
    const firstPlacementCursor = parser.getFullCursor();
    parser.write(kittyPlace({ imageId: 8, placementId: 3 }));

    parser.write("\x1b[2;5Hsecond");
    const secondPlacementCursor = parser.getFullCursor();
    parser.write(kittyPlace({ imageId: 8, placementId: 3 }));

    const images = parser.getImages();
    expect(images).toHaveLength(1);
    expect(images[0].row).toBe(secondPlacementCursor.y);
    expect(images[0].col).toBe(secondPlacementCursor.x);
    expect(Array.from(images[0].data)).toEqual([9, 8, 7, 6]);
    expect(images[0].row).not.toBe(firstPlacementCursor.y);
    expect(images[0].col).not.toBe(firstPlacementCursor.x);
  });

  test("retransmitting an image id removes old placements and later placements use the new data", () => {
    const parser = new AnsiParser(80, 5);

    parser.write(kittyRgbaTransmit({ imageId: 9, pixel: [1, 1, 1, 1] }));
    parser.write("old");
    parser.write(kittyPlace({ imageId: 9, placementId: 1 }));

    expect(parser.getImages()).toHaveLength(1);
    expect(Array.from(parser.getImages()[0].data)).toEqual([1, 1, 1, 1]);

    parser.write("\x1b[2;4H");
    const cursorBeforeRetransmit = parser.getFullCursor();

    parser.write(kittyRgbaTransmit({ imageId: 9, pixel: [5, 6, 7, 8] }));

    expect(parser.getImages()).toHaveLength(0);
    expect(parser.getFullCursor()).toEqual(cursorBeforeRetransmit);

    parser.write("new");
    const cursorBeforeNewPlacement = parser.getFullCursor();

    parser.write(kittyPlace({ imageId: 9, placementId: 1 }));

    const images = parser.getImages();
    expect(images).toHaveLength(1);
    expect(images[0].row).toBe(cursorBeforeNewPlacement.y);
    expect(images[0].col).toBe(cursorBeforeNewPlacement.x);
    expect(Array.from(images[0].data)).toEqual([5, 6, 7, 8]);
  });

  test("retransmitting an image id removes virtual placements and relative children", () => {
    const parser = new AnsiParser(20, 4);
    parser.write(kittyRgbaTransmit({ imageId: 13 }));
    parser.write(kittyRgbaTransmit({ imageId: 14 }));
    parser.write("\x1b_Ga=p,i=13,p=11,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b_Ga=p,i=14,p=22,P=13,Q=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b[38:5:13;58:5:11m\u{10eeee}\x1b[0m");
    expect(parser.getImages().map((image) => image.placementId)).toEqual([11, 22]);

    parser.write(kittyRgbaTransmit({ imageId: 13, pixel: [5, 6, 7, 8] }));

    expect(parser.getImages()).toHaveLength(0);
  });

  test("deletes placements for an image id without printing Kitty payload or control text", () => {
    const parser = new AnsiParser(80, 5);

    parser.write(`before${kittyRgbaTransmit({ imageId: 10, pixel: [2, 4, 6, 8] })}`);
    parser.write(kittyPlace({ imageId: 10 }));

    expect(parser.getImages()).toHaveLength(1);

    parser.write(`${kittyDeleteImage(10, "delete-payload")}after`);

    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");

    expect(parser.getImages()).toHaveLength(0);
    expect(visibleText).toContain("before");
    expect(visibleText).toContain("after");
    expect(visibleText).not.toContain("a=d");
    expect(visibleText).not.toContain("i=10");
    expect(visibleText).not.toContain("delete-payload");
  });

  test("drops renderer cache ids when Kitty image data is freed", () => {
    const parser = new AnsiParser(80, 5);
    parser.write(kittyRgbaTransmit({ imageId: 12, pixel: [2, 4, 6, 8] }));
    parser.write(kittyPlace({ imageId: 12 }));

    const cacheId = parser.getImages()[0].dataId;
    expect(cacheId).toBeDefined();
    expect(parser.consumeImageCachePruneRequest()).toContain(cacheId!);

    parser.write("\x1b_Ga=d,d=I,i=12\x1b\\");

    expect(parser.consumeImageCachePruneRequest()).not.toContain(cacheId!);
  });

  test("requests cache pruning when display erase removes the last placement", () => {
    const parser = new AnsiParser(80, 5);
    parser.write(kittyRgbaTransmit({ imageId: 15 }));
    parser.write(kittyPlace({ imageId: 15 }));
    const cacheId = parser.getImages()[0].dataId;
    expect(parser.consumeImageCachePruneRequest()).toContain(cacheId!);

    parser.write("\x1b[2J");

    expect(parser.getImages()).toHaveLength(0);
    expect(parser.consumeImageCachePruneRequest()).not.toContain(cacheId!);
  });

  test("swallows corrupt PNG APC payload without storing an image or printing payload text", () => {
    const parser = new AnsiParser(80, 3);
    const corruptPngPayload = "not-valid-base64%%%";

    parser.write(`before${kittyPngApc({ payload: corruptPngPayload })}after`);

    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");

    expect(parser.getImages()).toHaveLength(0);
    expect(visibleRowText(parser)).toBe("beforeafter");
    expect(visibleText).not.toContain(corruptPngPayload);
  });

  test("hides main-screen images while alternate screen is active and restores them after exit", () => {
    const parser = new AnsiParser(80, 3);

    parser.write("main\r\n");
    parser.write(kittyRgbaApc({ widthCells: 2, payload: "AQIDBA==" }));

    expect(parser.getImages()).toHaveLength(1);
    const [mainImage] = parser.getImages();

    parser.write("\x1b[?1049h");

    expect(parser.getImages()).toHaveLength(0);

    parser.write(kittyRgbaApc({ payload: "BAAAAA==" }));

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0].data[0]).toBe(4);

    parser.write("\x1b[?1049l");

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0].row).toBe(mainImage.row);
    expect(parser.getImages()[0].col).toBe(mainImage.col);
    expect(parser.getImages()[0].widthCells).toBe(mainImage.widthCells);
    expect(parser.getImages()[0].data[0]).toBe(1);
  });

  test("keeps saved main-screen placements when alternate-screen visible placements are deleted", () => {
    const parser = new AnsiParser(20, 3);
    parser.write(kittyRgbaTransmit({ imageId: 90 }));
    parser.write(kittyPlace({ imageId: 90, placementId: 1 }));
    expect(parser.getImages()).toHaveLength(1);

    parser.write("\x1b[?1049h\x1b_Ga=d\x1b\\\x1b[?1049l");

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0].imageId).toBe(90);
  });

  test("deletes saved main-screen virtual placements by image id from the alternate screen", () => {
    const parser = new AnsiParser(20, 3);
    parser.write(kittyRgbaTransmit({ imageId: 91 }));
    parser.write("\x1b_Ga=p,i=91,p=1,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b[38;5;91m\u{10eeee}\x1b[0m");
    expect(parser.getImages()).toHaveLength(1);

    parser.write("\x1b[?1049h\x1b_Ga=d,d=i,i=91\x1b\\\x1b[?1049l");

    expect(parser.getImages()).toHaveLength(0);
  });

  test("deletes visible virtual placements with every screen selector", () => {
    const selectors = [
      "a",
      "c",
      "p,x=1,y=1",
      "q,x=1,y=1,z=5",
      "x,x=1",
      "y,y=1",
      "z,z=5",
    ];

    for (const selector of selectors) {
      const parser = new AnsiParser(20, 3);
      parser.write(kittyRgbaTransmit({ imageId: 92 }));
      parser.write("\x1b_Ga=p,i=92,p=1,U=1,c=1,r=1,z=5\x1b\\");
      parser.write("\x1b[38;5;92m\u{10eeee}\x1b[0m");
      expect(parser.getImages()).toHaveLength(1);

      parser.write(`\x1b[1;1H\x1b_Ga=d,d=${selector}\x1b\\`);

      expect(parser.getImages()).toHaveLength(0);
    }
  });

  test("clears nonpersistent image state and placeholders when restoring a snapshot", () => {
    const source = new AnsiParser(20, 3);
    source.write(kittyRgbaTransmit({ imageId: 93 }));
    source.write("\x1b_Ga=p,i=93,p=1,U=1,c=1,r=1\x1b\\");
    source.write("\x1b[38;5;93m\u{10eeee}\x1b[0m");
    expect(source.getImages()).toHaveLength(1);

    const restored = new AnsiParser(20, 3);
    restored.write(kittyRgbaApc());
    expect(restored.getImages()).toHaveLength(1);

    restored.restoreSnapshot(source.createSnapshot());

    expect(restored.getImages()).toHaveLength(0);
    expect(restored.getFullBuffer().flat().every((cell) => cell.imagePlaceholder === undefined)).toBe(true);
  });

  test("preserves completed and virtual images in a runtime snapshot", () => {
    const source = new AnsiParser(20, 3);
    source.write(kittyRgbaTransmit({ imageId: 94 }));
    source.write("\x1b_Ga=p,i=94,p=1,U=1,c=1,r=1\x1b\\");
    source.write("\x1b[38;5;94m\u{10eeee}\x1b[0m");
    const expectedData = Array.from(source.getImages()[0].data);

    const restored = new AnsiParser(20, 3);
    restored.restoreSnapshot(source.createRuntimeSnapshot());

    expect(restored.getImages()).toHaveLength(1);
    expect(Array.from(restored.getImages()[0].data)).toEqual(expectedData);
    expect(restored.getFullBuffer().flat().some((cell) => cell.imagePlaceholder)).toBe(true);
    restored.write("\x1b_Ga=d,d=i,i=94\x1b\\");
    expect(restored.getImages()).toHaveLength(0);
  });

  test("preserves partially clipped signed rows and discards fully clipped runtime images", () => {
    const source = new AnsiParser(20, 3);
    source.write(kittyRgbaApc());
    const partialSnapshot = source.createRuntimeSnapshot();
    partialSnapshot.runtimeImageState!.images[0].row = -1;
    partialSnapshot.runtimeImageState!.images[0].heightCells = 2;

    const partial = new AnsiParser(20, 3);
    partial.restoreSnapshot(partialSnapshot);
    expect(partial.getImages()).toHaveLength(1);
    expect(partial.getImages()[0].row).toBe(-1);

    const discardedSnapshot = source.createRuntimeSnapshot();
    discardedSnapshot.runtimeImageState!.images[0].row = -2;
    discardedSnapshot.runtimeImageState!.images[0].heightCells = 2;
    const discarded = new AnsiParser(20, 3);
    discarded.restoreSnapshot(discardedSnapshot);
    expect(discarded.getImages()).toHaveLength(0);
  });

  test("discards runtime images below a restored alternate-screen viewport", () => {
    const source = new AnsiParser(20, 4);
    source.write("\x1b[?1049h\x1b[4;1H");
    source.write(kittyRgbaApc());
    expect(source.getImages()[0].row).toBe(2);

    const restored = new AnsiParser(20, 2);
    restored.restoreSnapshot(source.createRuntimeSnapshot());

    expect(restored.getImages()).toHaveLength(0);
  });

  test("refreshes dirty virtual origins before creating a runtime snapshot", () => {
    const source = new AnsiParser(20, 4);
    source.write("\x1b[?1049h");
    source.write(kittyRgbaTransmit({ imageId: 95 }));
    source.write("\x1b[3;1H\x1b_Ga=p,i=95,p=1,U=1,c=1,r=1\x1b\\");
    source.write("\x1b[38;5;95m\u{10eeee}\x1b[0m");
    expect(source.getImages()[0].row).toBe(2);

    source.write("\x1b[1;4r\x1b[4;1H\n");
    const snapshot = source.createRuntimeSnapshot();

    expect(snapshot.runtimeImageState!.kittyVirtualPlacements[0][1].originRow).toBe(1);
  });

  test("discards relative placements whose restored parent is outside the viewport", () => {
    const source = new AnsiParser(20, 4);
    source.write("\x1b[?1049h");
    source.write(kittyRgbaTransmit({ imageId: 96 }));
    source.write(kittyRgbaTransmit({ imageId: 97 }));
    source.write("\x1b[4;1H\x1b_Ga=p,i=96,p=11,c=1,r=1,C=1\x1b\\");
    source.write("\x1b_Ga=p,i=97,p=22,P=96,Q=11,c=1,r=1,C=1\x1b\\");

    const restored = new AnsiParser(20, 2);
    restored.restoreSnapshot(source.createRuntimeSnapshot());

    expect(restored.getImages()).toHaveLength(0);
    expect(
      (restored as unknown as { kittyRelativePlacements: Map<string, unknown> })
        .kittyRelativePlacements.size
    ).toBe(0);
  });

  test("rebases image rows when scrollback drops older rows and removes images that fall past the cap", () => {
    const parser = new AnsiParser(20, 3);

    parser.write("old\r\n");
    parser.write(kittyRgbaApc());
    parser.write("\x1b[3;1H");

    scrollUntilScrollbackCapStopsGrowing(parser);

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0].row).toBe(0);

    parser.write("\r\n");

    expect(parser.getImages()).toHaveLength(0);
  });

  test("caps stored Kitty images instead of retaining every completed placement", () => {
    const parser = new AnsiParser(80, 10);
    const attemptedImages = 5000;

    for (let i = 0; i < attemptedImages; i++) {
      parser.write("\x1b[1;1H");
      parser.write(kittyRgbaApc({ payload: i % 2 === 0 ? "AQIDBA==" : "BQYHCA==" }));
    }

    expect(parser.getImages().length).toBeLessThan(attemptedImages);
  });

  test("removes relative placement groups when the image cap evicts their parent", () => {
    const parser = new AnsiParser(20, 5);
    const internals = parser as unknown as { kittyRelativePlacements: Map<string, unknown> };
    parser.write(kittyRgbaTransmit({ imageId: 1 }));
    parser.write(kittyRgbaTransmit({ imageId: 2 }));
    parser.write("\x1b_Ga=p,i=1,p=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b_Ga=p,i=2,p=22,P=1,Q=11,c=1,r=1,C=1\x1b\\");

    for (let index = 0; index < 128; index++) {
      parser.write("\x1b_Ga=p,i=1,p=" + (100 + index) + ",c=1,r=1,C=1\x1b\\");
    }

    expect(parser.getImages()).toHaveLength(128);
    expect(parser.getImages().some((image) => image.imageId === 2)).toBe(false);
    expect(internals.kittyRelativePlacements.size).toBe(0);
  });
  test("decompresses zlib image data and reports the resolved image id", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    const rgba = Uint8Array.from([9, 8, 7, 6]);
    const payload = Buffer.from(zlibSync(rgba)).toString("base64");

    parser.write(`\x1b_Ga=T,f=32,s=1,v=1,i=41,o=z,C=1;${payload}\x1b\\`);

    expect(Array.from(parser.getImages()[0].data)).toEqual(Array.from(rgba));
    expect(responses).toEqual(["\x1b_Gi=41;OK\x1b\\"]);
  });

  test("rejects zlib image data as soon as decoded output exceeds the limit", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    const payload = Buffer.from(zlibSync(new Uint8Array(16 * 1024 * 1024 + 1))).toString("base64");

    writeChunkedKittyImage(parser, "a=t,f=32,s=1,v=1,i=42,o=z", payload);

    expect(parser.getImages()).toHaveLength(0);
    expect(responses.at(-1)).toContain("ENOSPC:decompressed image too large");
  });

  test("suppresses successful responses with q=1 but still reports failures", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));

    parser.write("\x1b_Ga=t,f=32,s=1,v=1,i=42,q=1;AQIDBA==\x1b\\");
    parser.write("\x1b_Ga=t,f=32,s=2,v=1,i=43,q=1;AQIDBA==\x1b\\");

    expect(responses).toHaveLength(1);
    expect(responses[0]).toContain("i=43");
    expect(responses[0]).toContain("EINVAL");
  });

  test("renders Unicode placeholders using image and placement color ids", () => {
    const parser = new AnsiParser(20, 3);
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]).toString("base64");
    parser.write(`\x1b_Ga=t,f=32,s=2,v=1,i=7;${rgba}\x1b\\`);
    parser.write("\x1b_Ga=p,i=7,p=9,U=1,c=2,r=1\x1b\\");
    parser.write("\x1b[38:5:7;58:5:9m\u{10eeee}\u{10eeee}\x1b[0m");

    const placeholders = parser.getImages();
    expect(placeholders).toHaveLength(2);
    expect(placeholders.map((image) => [image.col, image.sourceX, image.sourceWidth])).toEqual([
      [0, 0, 1],
      [1, 1, 1],
    ]);
    expect(parser.getBuffer()[0][0].imagePlaceholder?.imageId).toBe(7);
  });

  test("preserves aspect ratio across Unicode placeholder cells", () => {
    const parser = new AnsiParser(20, 3);
    parser.setCellSize(8, 16);
    const rgba = Buffer.from(new Uint8Array(4 * 4).fill(255)).toString("base64");
    parser.write(`\x1b_Ga=t,f=32,s=4,v=1,i=17;${rgba}\x1b\\`);
    parser.write("\x1b_Ga=p,i=17,U=1,c=2,r=2\x1b\\");
    parser.write("\x1b[38;5;17m\u{10eeee}\u0305\u{10eeee}\r\n\u{10eeee}\u030d\u{10eeee}\x1b[0m");

    const placeholders = parser.getImages();
    expect(placeholders).toHaveLength(4);
    expect(placeholders.map((image) => [image.sourceX, image.sourceWidth])).toEqual([
      [0, 2],
      [2, 2],
      [0, 2],
      [2, 2],
    ]);
    expect(placeholders[0].sourceY).toBeCloseTo(0);
    expect(placeholders[0].sourceHeight).toBeCloseTo(0.5);
    expect(placeholders[0].offsetY).toBeCloseTo(14);
    expect(placeholders[0].heightCells).toBeCloseTo(0.125);
    expect(placeholders[2].sourceY).toBeCloseTo(0.5);
    expect(placeholders[2].sourceHeight).toBeCloseTo(0.5);
    expect(placeholders[2].offsetY).toBeCloseTo(0);
    expect(placeholders[2].heightCells).toBeCloseTo(0.125);
  });

  test("inherits omitted placeholder columns and resets them when the row changes", () => {
    const parser = new AnsiParser(20, 3);
    const rgba = Buffer.from(new Uint8Array(3 * 2 * 4).fill(255)).toString("base64");
    parser.write(`\x1b_Ga=t,f=32,s=3,v=2,i=8;${rgba}\x1b\\`);
    parser.write("\x1b_Ga=p,i=8,U=1,c=3,r=2\x1b\\");
    parser.write("\x1b[38;5;8m\u{10eeee}\u0305\u{10eeee}\u{10eeee}\r\n\u{10eeee}\u030d\u{10eeee}\x1b[0m");

    const cells = parser.getFullBuffer().flatMap((row) => row.filter((cell) => cell.imagePlaceholder));
    expect(cells.map((cell) => [cell.imagePlaceholder?.row, cell.imagePlaceholder?.col])).toEqual([
      [0, 0], [0, 1], [0, 2], [1, 0], [1, 1],
    ]);
  });

  test("keeps virtual and relative placement sizes independent of the cursor column", () => {
    const parser = new AnsiParser(5, 3);
    const internals = parser as unknown as {
      kittyVirtualPlacements: Map<string, { columns: number }>;
    };
    parser.write(kittyRgbaTransmit({ imageId: 71 }));
    parser.write(kittyRgbaTransmit({ imageId: 72 }));
    parser.write("\x1b[1;5H");
    parser.write("\x1b_Ga=p,i=71,p=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b_Ga=p,i=72,p=22,P=71,Q=11,c=10,r=1,C=1\x1b\\");
    parser.write("\x1b_Ga=p,i=72,p=33,U=1,c=10,r=1,C=1\x1b\\");

    expect(parser.getImages().find((image) => image.placementId === 22)?.widthCells).toBe(10);
    expect([...internals.kittyVirtualPlacements.values()][0]?.columns).toBe(10);
  });
  test("anchors relative placements to independent sparse placeholder minima", () => {
    const parser = new AnsiParser(20, 4);
    parser.write(kittyRgbaTransmit({ imageId: 21 }));
    parser.write(kittyRgbaTransmit({ imageId: 22 }));
    parser.write("\x1b_Ga=p,i=21,p=11,U=1,c=2,r=2\x1b\\");
    parser.write("\x1b_Ga=p,i=22,p=22,P=21,Q=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b[1;6H\x1b[38:5:21;58:5:11m\u{10eeee}\u0305\u0305");
    parser.write("\x1b[2;2H\u{10eeee}\u030d\u030d\x1b[0m");

    const relative = parser.getImages().find((image) => image.placementId === 22);
    expect(relative).toMatchObject({ row: 0, col: 1 });
  });

  test("records a virtual origin before it leaves the requested render range", () => {
    const parser = new AnsiParser(20, 3);
    parser.write(kittyRgbaTransmit({ imageId: 23 }));
    parser.write(kittyRgbaTransmit({ imageId: 24 }));
    parser.write("\x1b_Ga=p,i=23,p=11,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b_Ga=p,i=24,p=22,P=23,Q=11,V=3,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b[38:5:23;58:5:11m\u{10eeee}\x1b[0m");
    parser.write("\x1b[3;1H\r\n");

    const relative = parser
      .getImages(1, 4)
      .find((image) => image.placementId === 22);
    expect(relative).toMatchObject({ row: 3, col: 0 });
  });

  test("consumes every official Kitty row-column diacritic", () => {
    const parser = new AnsiParser(5, 3);
    parser.write(kittyRgbaTransmit({ imageId: 25 }));
    parser.write("\x1b_Ga=p,i=25,p=11,U=1,c=1,r=297\x1b\\");
    parser.write("\x1b[38:5:25;58:5:11m\u{10eeee}\u{a8e6}\x1b[0m");

    expect(parser.getBuffer()[0][0].imagePlaceholder?.row).toBe(256);
    expect(parser.getFullCursor()).toEqual({ x: 1, y: 0 });
  });

  test("removes relative images after their virtual parent cells are erased", () => {
    const parser = new AnsiParser(20, 4);
    parser.write(kittyRgbaTransmit({ imageId: 26 }));
    parser.write(kittyRgbaTransmit({ imageId: 27 }));
    parser.write("\x1b_Ga=p,i=26,p=11,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b_Ga=p,i=27,p=22,P=26,Q=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b[38:5:26;58:5:11m\u{10eeee}\x1b[0m");
    expect(parser.getImages().find((image) => image.placementId === 22)?.row).toBe(0);

    parser.write("\x1b[1;1H\x1b[2K");

    expect(parser.getImages().find((image) => image.placementId === 22)).toBeUndefined();
  });

  test("moves relative images when line insertion moves their virtual parent", () => {
    const parser = new AnsiParser(20, 4);
    parser.write(kittyRgbaTransmit({ imageId: 28 }));
    parser.write(kittyRgbaTransmit({ imageId: 29 }));
    parser.write("\x1b_Ga=p,i=28,p=11,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b_Ga=p,i=29,p=22,P=28,Q=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b[2;1H\x1b[38:5:28;58:5:11m\u{10eeee}\x1b[0m");
    expect(parser.getImages().find((image) => image.placementId === 22)?.row).toBe(1);

    parser.write("\x1b[1;1H\x1b[1L");

    expect(parser.getImages().find((image) => image.placementId === 22)?.row).toBe(2);
  });

  test("positions relative placements and rejects cycles", () => {
    const parser = new AnsiParser(20, 5);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    parser.write(kittyRgbaTransmit({ imageId: 1, pixel: [1, 0, 0, 255] }));
    parser.write(kittyRgbaTransmit({ imageId: 2, pixel: [2, 0, 0, 255] }));
    parser.write("\x1b_Ga=p,i=1,p=11,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b_Ga=p,i=2,p=22,P=1,Q=11,H=3,V=1,c=1,r=1\x1b\\");

    const relative = parser.getImages().find((image) => image.imageId === 2);
    expect(relative).toMatchObject({ row: 1, col: 3, placementId: 22 });
    expect(parser.getFullCursor()).toEqual({ x: 0, y: 0 });

    parser.write("\x1b_Ga=p,i=1,p=11,P=2,Q=22,c=1,r=1\x1b\\");
    expect(responses.at(-1)).toContain("ECYCLE");
  });

  test("switches and advances RGBA animation frames", () => {
    const parser = new AnsiParser(20, 3);
    parser.write(kittyRgbaTransmit({ imageId: 60, pixel: [255, 0, 0, 255] }));
    parser.write("\x1b_Ga=p,i=60,p=1,c=1,r=1,C=1\x1b\\");
    const green = Buffer.from([0, 255, 0, 255]).toString("base64");
    parser.write(`\x1b_Ga=f,f=32,s=1,v=1,i=60,z=40;${green}\x1b\\`);
    parser.write("\x1b_Ga=a,i=60,c=2,s=3\x1b\\");

    expect(Array.from(parser.getImages()[0].data)).toEqual([0, 255, 0, 255]);
    expect(parser.getKittyAnimationDelay(new Set([60]))).not.toBeNull();
  });
  test("does not schedule or advance animations without visible placements", () => {
    const parser = new AnsiParser(20, 3);
    const internals = parser as unknown as {
      kittyImageData: Map<
        number,
        { animation?: { currentFrame: number; lastFrameAt: number } }
      >;
    };
    parser.write(kittyRgbaTransmit({ imageId: 62, pixel: [255, 0, 0, 255] }));
    const green = Buffer.from([0, 255, 0, 255]).toString("base64");
    parser.write(
      "\x1b_Ga=f,f=32,s=1,v=1,i=62,z=40;" + green + "\x1b\\",
    );
    parser.write("\x1b_Ga=a,i=62,c=1,s=3\x1b\\");

    const animation = internals.kittyImageData.get(62)?.animation;
    expect(animation).toBeDefined();
    const currentFrame = animation!.currentFrame;
    expect(parser.getKittyAnimationDelay(new Set(), animation!.lastFrameAt)).toBeNull();
    expect(
      parser.advanceKittyAnimations(new Set(), animation!.lastFrameAt + 100),
    ).toBe(false);
    expect(animation!.currentFrame).toBe(currentFrame);
  });

  test("keeps placement render ids stable while advancing animation frames", () => {
    const parser = new AnsiParser(20, 3);
    const internals = parser as unknown as {
      kittyImageData: Map<number, { animation?: { lastFrameAt: number } }>;
    };
    parser.write(kittyRgbaTransmit({ imageId: 61, pixel: [255, 0, 0, 255] }));
    parser.write("\x1b_Ga=p,i=61,p=1,c=1,r=1,C=1\x1b\\");
    parser.write("\x1b_Ga=p,i=61,p=2,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b[38:5:61;58:5:2m\u{10eeee}\u0305\u0305\x1b[0m");
    const green = Buffer.from([0, 255, 0, 255]).toString("base64");
    parser.write(`\x1b_Ga=f,f=32,s=1,v=1,i=61,z=40;${green}\x1b\\`);
    parser.write("\x1b_Ga=a,i=61,c=1,s=3\x1b\\");

    const before = parser.getImages();
    const physicalId = before.find((image) => image.placementId === 1)?.id;
    const virtualId = before.find((image) => image.placementId === 2)?.id;
    const placeholderRenderId = parser.getBuffer()[0][0].imagePlaceholder?.renderId;
    const animation = internals.kittyImageData.get(61)?.animation;
    expect(animation).toBeDefined();

    parser.advanceKittyAnimations(new Set([61]), animation!.lastFrameAt);

    const after = parser.getImages();
    expect(after.find((image) => image.placementId === 1)?.id).toBe(physicalId);
    expect(after.find((image) => image.placementId === 2)?.id).toBe(virtualId);
    expect(parser.getBuffer()[0][0].imagePlaceholder?.renderId).toBe(placeholderRenderId);
    expect(Array.from(after.find((image) => image.placementId === 2)?.data ?? [])).toEqual([0, 255, 0, 255]);
  });

  test("composites partial PNG animation frames into the root image", () => {
    const parser = new AnsiParser(20, 3);
    const root = rgbaPngBase64(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
    const green = rgbaPngBase64(1, 1, [0, 255, 0, 255]);
    parser.write("\x1b_Ga=t,f=100,i=70;" + root + "\x1b\\");
    parser.write("\x1b_Ga=p,i=70,p=1,c=2,r=1,C=1\x1b\\");
    parser.write("\x1b_Ga=f,f=100,i=70,x=1,y=0,c=1;" + green + "\x1b\\");
    parser.write("\x1b_Ga=a,i=70,c=2,s=1\x1b\\");

    expect(Array.from(parser.getImages()[0].data)).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]);
  });

  test("caps detached placements and animation frames", () => {
    const placementParser = new AnsiParser(20, 3);
    const placementResponses: string[] = [];
    const placementInternals = placementParser as unknown as {
      kittyVirtualPlacements: Map<string, unknown>;
      kittyRelativePlacements: Map<string, unknown>;
    };
    placementParser.setResponseHandler((response) => placementResponses.push(response));
    placementParser.write(kittyRgbaTransmit({ imageId: 80 }));
    placementResponses.length = 0;

    for (let placementId = 1; placementId <= 129; placementId++) {
      placementParser.write(
        `\x1b_Ga=p,i=80,p=${placementId},U=1,c=1,r=1,q=1\x1b\\`,
      );
    }

    expect(
      placementInternals.kittyVirtualPlacements.size +
        placementInternals.kittyRelativePlacements.size,
    ).toBe(128);
    expect(placementResponses.at(-1)).toContain("ENOSPC:image placement limit exceeded");

    const frameParser = new AnsiParser(20, 3);
    const frameResponses: string[] = [];
    const frameInternals = frameParser as unknown as {
      kittyImageData: Map<number, { animation?: { frames: unknown[] } }>;
    };
    frameParser.setResponseHandler((response) => frameResponses.push(response));
    frameParser.write(kittyRgbaTransmit({ imageId: 81 }));
    const framePayload = Buffer.from([5, 6, 7, 8]).toString("base64");
    for (let frame = 0; frame < 255; frame++) {
      frameParser.write(
        `\x1b_Ga=f,f=32,s=1,v=1,i=81,z=1,q=1;${framePayload}\x1b\\`,
      );
    }
    expect(frameInternals.kittyImageData.get(81)?.animation?.frames).toHaveLength(256);

    frameResponses.length = 0;
    frameParser.write(`\x1b_Ga=f,f=32,s=1,v=1,i=81,z=1,q=1;${framePayload}\x1b\\`);

    expect(frameInternals.kittyImageData.get(81)?.animation?.frames).toHaveLength(256);
    expect(frameResponses.at(-1)).toContain("ENOSPC:animation frame limit exceeded");
  });

  test("uses Kitty source and destination frame coordinates when composing", () => {
    const parser = new AnsiParser(20, 3);
    const root = Buffer.from([10, 0, 0, 255, 20, 0, 0, 255]).toString("base64");
    const source = Buffer.from([30, 0, 0, 255, 40, 0, 0, 255]).toString("base64");
    const internals = parser as unknown as {
      kittyImageData: Map<number, {
        animation?: { frames: Array<{ data: { data: Uint8Array | Uint8ClampedArray } }> };
      }>;
    };
    parser.write(`\x1b_Ga=t,f=32,s=2,v=1,i=82;${root}\x1b\\`);
    parser.write(`\x1b_Ga=f,f=32,s=2,v=1,i=82,z=40;${source}\x1b\\`);

    parser.write("\x1b_Ga=c,i=82,r=2,c=1,x=1,y=0,X=0,Y=0,w=1,h=1,C=1\x1b\\");

    const frames = internals.kittyImageData.get(82)?.animation?.frames;
    expect(Array.from(frames?.[0].data.data ?? [])).toEqual([
      40, 0, 0, 255,
      20, 0, 0, 255,
    ]);
    expect(Array.from(frames?.[1].data.data ?? [])).toEqual([
      30, 0, 0, 255,
      40, 0, 0, 255,
    ]);
  });

  test("allows replacing the displayed frame at the exact image byte limit", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    const dimension = 1024;
    const buffers = Array.from(
      { length: 8 },
      () => new Uint8ClampedArray(dimension * dimension * 4),
    );
    const root = { kind: "rgba" as const, pixelWidth: dimension, pixelHeight: dimension, data: buffers[0] };
    const frames = buffers.map((data) => ({ data: { ...root, data }, gap: 40 }));
    const imageData = {
      ...root,
      animation: {
        frames,
        currentFrame: 1,
        running: false,
        waitForFrames: false,
        configuredLoops: 0,
        remainingLoops: 0,
        lastFrameAt: 0,
      },
    };
    const placement = {
      ...root,
      id: 1,
      protocol: "kitty" as const,
      imageId: 85,
      row: 0,
      col: 0,
      widthCells: 1,
      heightCells: 1,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: dimension,
      sourceHeight: dimension,
      offsetX: 0,
      offsetY: 0,
      zIndex: 0,
      data: buffers[1],
    };
    const internals = parser as unknown as {
      kittyImageData: Map<number, typeof imageData>;
      images: Array<typeof placement>;
    };
    internals.kittyImageData.set(85, imageData);
    internals.images = [placement];

    parser.write("\x1b_Ga=c,i=85,r=1,c=2,w=" + dimension + ",h=" + dimension + ",C=1\x1b\\");

    expect(responses.at(-1)).toContain(";OK");
    expect(frames[1].data.data).not.toBe(buffers[1]);
    expect(internals.images[0].data).toBe(frames[1].data.data);
  });

  test("counts a shared root buffer that remains after frame replacement", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    const dimension = 1024;
    const buffers = Array.from(
      { length: 8 },
      () => new Uint8ClampedArray(dimension * dimension * 4),
    );
    const root = {
      kind: "rgba" as const,
      pixelWidth: dimension,
      pixelHeight: dimension,
      data: buffers[0],
    };
    const frames = buffers.map((data) => ({
      data: { ...root, data },
      gap: 40,
    }));
    const image = {
      ...root,
      animation: {
        frames,
        currentFrame: 0,
        running: false,
        waitForFrames: false,
        configuredLoops: 0,
        remainingLoops: 0,
        lastFrameAt: 0,
      },
    };
    const internals = parser as unknown as {
      kittyImageData: Map<number, typeof image>;
    };
    internals.kittyImageData.set(84, image);

    parser.write(
      `\x1b_Ga=c,i=84,r=2,c=1,w=${dimension},h=${dimension},C=1\x1b\\`,
    );

    expect(responses.at(-1)).toContain("ENOSPC:image storage limit exceeded");
    expect(frames[0].data.data).toBe(buffers[0]);
  });

  test("keeps PNG frame composition within the total image byte budget", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    const dimension = 1024;
    const png = Buffer.from(encodePng({
      width: dimension,
      height: dimension,
      data: new Uint8Array(dimension * dimension * 4),
      channels: 4,
      depth: 8,
    })).toString("base64");
    const internals = parser as unknown as {
      kittyImageData: Map<number, {
        data: Uint8Array | Uint8ClampedArray;
        animation?: {
          frames: Array<{ data: { data: Uint8Array | Uint8ClampedArray } }>;
        };
      }>;
    };

    writeChunkedKittyImage(parser, "a=t,f=100,i=83", png);
    for (let frame = 2; frame <= 10; frame++) {
      writeChunkedKittyImage(parser, "a=f,f=100,i=83,z=40", png);
    }
    responses.length = 0;

    for (let destination = 2; destination <= 10; destination++) {
      parser.write(
        `\x1b_Ga=c,i=83,r=1,c=${destination},w=${dimension},h=${dimension},C=1\x1b\\`,
      );
    }

    const image = internals.kittyImageData.get(83)!;
    const retained = new Set<Uint8Array | Uint8ClampedArray>([
      image.data,
      ...(image.animation?.frames.map((frame) => frame.data.data) ?? []),
    ]);
    const retainedBytes = [...retained].reduce((total, data) => total + data.byteLength, 0);
    expect(retainedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(responses.at(-1)).toContain("ENOSPC:image storage limit exceeded");
  });

  test("rejects out-of-bounds and overlapping Kitty frame composition", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    parser.setResponseHandler((response) => responses.push(response));
    const root = Buffer.from([10, 0, 0, 255, 20, 0, 0, 255]).toString("base64");
    const source = Buffer.from([30, 0, 0, 255, 40, 0, 0, 255]).toString("base64");
    parser.write(`\x1b_Ga=t,f=32,s=2,v=1,i=83;${root}\x1b\\`);
    parser.write(`\x1b_Ga=f,f=32,s=2,v=1,i=83,z=40;${source}\x1b\\`);

    responses.length = 0;
    parser.write("\x1b_Ga=c,i=83,r=2,c=1,X=0,Y=0,x=0,y=0,w=3,h=1,C=1\x1b\\");
    expect(responses.at(-1)).toContain("EINVAL:invalid composition rectangle");

    responses.length = 0;
    parser.write("\x1b_Ga=c,i=83,r=1,c=1,X=0,Y=0,x=0,y=0,w=1,h=1,C=1\x1b\\");
    expect(responses.at(-1)).toContain("EINVAL:overlapping composition rectangles");
  });

  test("applies low-bit grayscale PNG transparency after sample expansion", () => {
    const parser = new AnsiParser(20, 3);
    const internals = parser as unknown as {
      decodedPngToRgba(decoded: {
        width: number;
        height: number;
        channels: number;
        depth: number;
        data: Uint8Array;
        transparency: Uint16Array;
      }): Uint8ClampedArray | null;
    };

    const rgba = internals.decodedPngToRgba({
      width: 1,
      height: 1,
      channels: 1,
      depth: 1,
      data: Uint8Array.of(0b1000_0000),
      transparency: Uint16Array.of(1),
    });

    expect(Array.from(rgba ?? [])).toEqual([255, 255, 255, 0]);
  });

  test("preserves the root animation frame zero-millisecond gap", () => {
    const parser = new AnsiParser(20, 3);
    const internals = parser as unknown as {
      kittyImageData: Map<number, { animation?: { lastFrameAt: number } }>;
    };
    parser.write(kittyRgbaTransmit({ imageId: 83 }));
    const frame = Buffer.from([5, 6, 7, 8]).toString("base64");
    parser.write(`\x1b_Ga=f,f=32,s=1,v=1,i=83,z=40;${frame}\x1b\\`);
    parser.write("\x1b_Ga=a,i=83,c=1,s=3\x1b\\");

    const animation = internals.kittyImageData.get(83)?.animation;
    expect(animation).toBeDefined();
    expect(parser.getKittyAnimationDelay(new Set([83]), animation!.lastFrameAt)).toBe(0);
  });

  test("resets finite animation loops when stopped and restarted", () => {
    const parser = new AnsiParser(20, 3);
    const internals = parser as unknown as {
      kittyImageData: Map<number, {
        animation?: { configuredLoops: number; remainingLoops: number };
      }>;
    };
    parser.write(kittyRgbaTransmit({ imageId: 84 }));
    const frame = Buffer.from([5, 6, 7, 8]).toString("base64");
    parser.write(`\x1b_Ga=f,f=32,s=1,v=1,i=84,z=40;${frame}\x1b\\`);
    parser.write("\x1b_Ga=a,i=84,c=1,v=3,s=3\x1b\\");
    const animation = internals.kittyImageData.get(84)?.animation;
    expect(animation).toBeDefined();
    animation!.remainingLoops = 0;

    parser.write("\x1b_Ga=a,i=84,s=1\x1b\\");
    expect(animation!.remainingLoops).toBe(2);
    parser.write("\x1b_Ga=a,i=84,s=3\x1b\\");
    expect(animation!.remainingLoops).toBe(2);
  });

  test("restores main-screen virtual placements after alternate-screen erase", () => {
    const parser = new AnsiParser(20, 3);
    parser.write(kittyRgbaTransmit({ imageId: 85 }));
    parser.write("\x1b_Ga=p,i=85,p=1,U=1,c=1,r=1\x1b\\");
    parser.write("\x1b[38;5;85m\u{10eeee}\x1b[0m");
    expect(parser.getImages()).toHaveLength(1);

    parser.write("\x1b[?1049h\x1b[2J\x1b[?1049l");

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getBuffer()[0][0].imagePlaceholder?.imageId).toBe(85);
  });

  test("allows replacing an image that already occupies the byte budget", () => {
    const parser = new AnsiParser(20, 3);
    const responses: string[] = [];
    const internals = parser as unknown as {
      kittyImageData: Map<number, {
        kind: "rgba";
        pixelWidth: number;
        pixelHeight: number;
        data: Uint8ClampedArray;
      }>;
    };
    parser.setResponseHandler((response) => responses.push(response));
    internals.kittyImageData.set(86, {
      kind: "rgba",
      pixelWidth: 1,
      pixelHeight: 1,
      data: new Uint8ClampedArray(32 * 1024 * 1024),
    });

    parser.write(kittyRgbaTransmit({ imageId: 86, pixel: [9, 8, 7, 6] }));

    expect(responses.at(-1)).toContain(";OK");
    expect(Array.from(internals.kittyImageData.get(86)?.data ?? [])).toEqual([9, 8, 7, 6]);
  });

  test("omits physical images outside the requested row range", () => {
    const parser = new AnsiParser(20, 3);
    parser.write(kittyRgbaApc({ widthCells: 1, heightCells: 1 }));

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages(2, 3)).toHaveLength(0);
  });
  test("skips negative-gap frames without displaying them", () => {
    const parser = new AnsiParser(20, 3);
    const internals = parser as unknown as {
      kittyImageData: Map<number, { animation?: { lastFrameAt: number } }>;
    };
    parser.write(kittyRgbaTransmit({ imageId: 73, pixel: [255, 0, 0, 255] }));
    parser.write("\x1b_Ga=p,i=73,p=1,c=1,r=1,C=1\x1b\\");
    const green = Buffer.from([0, 255, 0, 255]).toString("base64");
    const blue = Buffer.from([0, 0, 255, 255]).toString("base64");
    parser.write("\x1b_Ga=f,f=32,s=1,v=1,i=73,z=-10;" + green + "\x1b\\");
    parser.write("\x1b_Ga=f,f=32,s=1,v=1,i=73,z=40;" + blue + "\x1b\\");
    parser.write("\x1b_Ga=a,i=73,c=1,s=3\x1b\\");

    const animation = internals.kittyImageData.get(73)?.animation;
    expect(animation).toBeDefined();
    parser.advanceKittyAnimations(new Set([73]), animation!.lastFrameAt);

    expect(Array.from(parser.getImages()[0].data)).toEqual([0, 0, 255, 255]);
  });
});

describe("AnsiParser iTerm2 OSC 1337 images", () => {
  test("reconstructs multipart inline PNG without printing payload chunks", () => {
    const parser = new AnsiParser(80, 5);
    const chunks = chunkBase64(TINY_PNG_BASE64, 17);

    parser.write("xy");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(
      `\x1b]1337;MultipartFile=inline=1;width=4;height=2\x07` +
        chunks.map((chunk) => `\x1b]1337;FilePart=${chunk}\x07`).join("") +
        `\x1b]1337;FileEnd\x07tail`,
    );

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBe(4);
    expect(image.heightCells).toBe(2);
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.data)).toEqual(Array.from(TINY_PNG_BYTES));
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("xy");
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("tail");
    expect(parser.getFullCursor()).toEqual({
      x: "tail".length,
      y: cursorBeforeImage.y + image.heightCells,
    });
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    for (const chunk of chunks) {
      expect(visibleText).not.toContain(chunk);
    }
    expect(visibleText).not.toContain("FilePart");
  });

  test("ignores multipart non-inline transfers without moving the cursor", () => {
    const parser = new AnsiParser(80, 5);
    const chunks = chunkBase64(TINY_PNG_BASE64, 17);

    parser.write("abc");
    const cursorBeforeTransfer = parser.getFullCursor();

    parser.write(
      `\x1b]1337;MultipartFile=width=4;height=2\x07` +
        chunks.map((chunk) => `\x1b]1337;FilePart=${chunk}\x07`).join("") +
        `\x1b]1337;FileEnd\x07`,
    );

    expect(parser.getImages()).toHaveLength(0);
    expect(parser.getFullCursor()).toEqual(cursorBeforeTransfer);
    expect(visibleRowText(parser, cursorBeforeTransfer.y)).toBe("abc");
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    for (const chunk of chunks) {
      expect(visibleText).not.toContain(chunk);
    }
  });

  test("converts iTerm2 pixel size units to terminal cells", () => {
    const parser = new AnsiParser(80, 5);

    parser.write(iterm2FileOsc(
      ["inline=1", "width=16px", "height=32px", "preserveAspectRatio=0"],
      TINY_PNG_BASE64,
    ));

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.widthCells).toBe(2);
    expect(image.heightCells).toBe(2);
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.data)).toEqual(Array.from(TINY_PNG_BYTES));
  });

  test("preserves non-cell-aligned iTerm2 pixel dimensions", () => {
    const parser = new AnsiParser(80, 5);
    parser.setCellSize(8, 16);
    parser.write(iterm2FileOsc(
      ["inline=1", "width=9px", "height=9px", "preserveAspectRatio=0"],
      TINY_PNG_BASE64,
    ));

    expect(parser.getImages()[0]).toMatchObject({
      widthCells: 2,
      heightCells: 1,
      destinationPixelWidth: 9,
      destinationPixelHeight: 9,
    });
  });

  test("converts iTerm2 percent size units against parser dimensions", () => {
    const parser = new AnsiParser(80, 20);

    parser.write(iterm2FileOsc(
      ["inline=1", "width=25%", "height=10%", "preserveAspectRatio=0"],
      TINY_PNG_BASE64,
    ));

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.widthCells).toBe(20);
    expect(image.heightCells).toBe(2);
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.data)).toEqual(Array.from(TINY_PNG_BYTES));
  });

  test("captures BEL-terminated inline JPEG without printing payload bytes", () => {
    const parser = new AnsiParser(80, 5);

    parser.write("top\r\nxy");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`${iterm2FileOsc(["inline=1", "width=4", "height=2", "preserveAspectRatio=0"], TWO_BY_ONE_JPEG_BASE64)}tail`);

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBe(4);
    expect(image.heightCells).toBe(2);
    expect(image.mimeType).toBe("image/jpeg");
    expect(Array.from(image.data)).toEqual(Array.from(TWO_BY_ONE_JPEG_BYTES));
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("xy");
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("tail");
    expect(parser.getFullCursor()).toEqual({
      x: "tail".length,
      y: cursorBeforeImage.y + image.heightCells,
    });
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    expect(visibleText).not.toContain(TWO_BY_ONE_JPEG_BASE64);
  });

  test("creates inline PNG with natural cells when width and height are omitted", () => {
    const parser = new AnsiParser(80, 4);

    parser.write("abc");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`${iterm2FileOsc(["inline=1"], TINY_PNG_BASE64)}tail`);

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBeGreaterThan(0);
    expect(image.heightCells).toBeGreaterThan(0);
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.data)).toEqual(Array.from(TINY_PNG_BYTES));
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("abc");
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("tail");
  });

  test("computes one-sided JPEG height from source dimensions", () => {
    const parser = new AnsiParser(80, 5);

    parser.write("xy");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`${iterm2FileOsc(["inline=1", "width=4"], TWO_BY_ONE_JPEG_BASE64)}tail`);

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBe(4);
    expect(image.heightCells).toBe(1);
    expect(image.pixelWidth).toBe(2);
    expect(image.pixelHeight).toBe(1);
    expect(image.mimeType).toBe("image/jpeg");
    expect(Array.from(image.data)).toEqual(Array.from(TWO_BY_ONE_JPEG_BYTES));
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("tail");
  });

  test("captures ST-terminated inline PNG with exact encoded bytes", () => {
    const parser = new AnsiParser(80, 4);

    parser.write("abc");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`${iterm2FileOsc(["inline=1", "width=1", "height=1"], TINY_PNG_BASE64, "\x1b\\")}tail`);

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.row).toBe(cursorBeforeImage.y);
    expect(image.col).toBe(cursorBeforeImage.x);
    expect(image.widthCells).toBe(1);
    expect(image.heightCells).toBe(1);
    expect(["png", "encoded"]).toContain(image.kind ?? image.format);
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.data)).toEqual(Array.from(TINY_PNG_BYTES));
    expect(visibleRowText(parser, cursorBeforeImage.y)).toBe("abc");
    expect(visibleRowText(parser, cursorBeforeImage.y + image.heightCells)).toBe("tail");
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    expect(visibleText).not.toContain(TINY_PNG_BASE64);
  });

  test("preserves aspect ratio inside a two-axis iTerm2 size box by default", () => {
    const parser = new AnsiParser(80, 5);
    parser.setCellSize(8, 16);

    parser.write(iterm2FileOsc(
      ["inline=1", "width=4", "height=4", "doNotMoveCursor=1"],
      TWO_BY_ONE_JPEG_BASE64,
    ));

    expect(parser.getImages()[0]).toMatchObject({ widthCells: 4, heightCells: 1 });
  });

  test("stretches one unspecified axis when preserveAspectRatio=0", () => {
    const parser = new AnsiParser(80, 5);
    parser.setCellSize(8, 16);

    parser.write(iterm2FileOsc(
      ["inline=1", "height=3", "preserveAspectRatio=0", "doNotMoveCursor=1"],
      TWO_BY_ONE_JPEG_BASE64,
    ));

    expect(parser.getImages()[0]).toMatchObject({ widthCells: 1, heightCells: 3 });
    expect(parser.getFullCursor()).toEqual({ x: 0, y: 0 });
  });

  test("ignores non-inline file transfers without printing payload bytes", () => {
    const parser = new AnsiParser(80, 3);
    const encodedName = Buffer.from("tiny.jpg").toString("base64");

    parser.write("abc");
    const cursorBeforeTransfer = parser.getFullCursor();

    parser.write(
      iterm2FileOsc([`name=${encodedName}`, `size=${TINY_JPEG_BYTES.length}`], TINY_JPEG_BASE64),
    );

    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");

    expect(parser.getImages()).toHaveLength(0);
    expect(parser.getFullCursor()).toEqual(cursorBeforeTransfer);
    expect(visibleRowText(parser, cursorBeforeTransfer.y)).toBe("abc");
    expect(visibleText).not.toContain(TINY_JPEG_BASE64);
  });
});

describe("AnsiParser image lifecycle", () => {
  test("moves image placements with partial scroll regions", () => {
    const parser = new AnsiParser(20, 4);
    parser.write(kittyRgbaTransmit({ imageId: 70 }));
    parser.write("\x1b[3;1H\x1b_Ga=p,i=70,p=1,c=1,r=1,C=1\x1b\\");

    parser.write("\x1b[2;4r\x1b[4;1H\n");

    expect(parser.getImages()[0].row).toBe(1);
  });

  test("keeps an image crossing a scroll boundary intact", () => {
    const parser = new AnsiParser(20, 4);
    const payload = Buffer.from(new Uint8Array(1 * 32 * 4).fill(255)).toString("base64");
    parser.write(`\x1b[1;1H\x1b_Ga=T,f=32,s=1,v=32,i=71,p=1,c=1,r=2,C=1;${payload}\x1b\\`);

    parser.write("\x1b[2;4r\x1b[4;1H\n");

    const [image] = parser.getImages();
    expect(image).toMatchObject({ row: 0, heightCells: 2, sourceY: 0, sourceHeight: 32 });
  });

  test("adjusts destination pixels when clipping a non-cell-aligned image", () => {
    const parser = new AnsiParser(20, 4);
    parser.setCellSize(8, 16);
    parser.write("\x1bPq\"3;1;8;8#0!8~\x1b\\");
    const original = parser.getImages()[0];
    const internals = parser as unknown as {
      sliceImageRows: (image: typeof original, start: number, end: number, destinationRow: number) => typeof original;
    };

    const clipped = internals.sliceImageRows(original, 1, 2, 0);

    expect(clipped.destinationPixelHeight).toBe(8);
    expect(clipped.heightCells).toBe(1);
    expect(clipped.sourceY).toBeCloseTo(16 / 3);
    expect(clipped.sourceHeight).toBeCloseTo(8 / 3);
  });
});

describe("AnsiParser Sixel images", () => {
  test("applies Pan/Pad as vertical-to-horizontal pixel aspect ratio", () => {
    const parser = new AnsiParser(20, 4);
    parser.setCellSize(8, 16);

    parser.write("\x1bPq\"2;1;8;8#0!8~\x1b\\");

    expect(parser.getImages()[0]).toMatchObject({
      pixelWidth: 8,
      pixelHeight: 8,
      widthCells: 1,
      heightCells: 1,
    });
  });

  test("preserves non-cell-aligned Sixel Pan/Pad dimensions", () => {
    const parser = new AnsiParser(20, 4);
    parser.setCellSize(8, 16);
    parser.write("\x1bPq\"3;1;8;8#0!8~\x1b\\");

    expect(parser.getImages()[0]).toMatchObject({
      widthCells: 1,
      heightCells: 2,
      destinationPixelWidth: 8,
      destinationPixelHeight: 24,
    });
  });

  test("keeps the full six-pixel height of a data band", () => {
    const setPixel = new AnsiParser(20, 4);
    setPixel.write("\x1bPq@\x1b\\");
    expect(setPixel.getImages()[0]).toMatchObject({ pixelWidth: 1, pixelHeight: 6 });

    const emptyBand = new AnsiParser(20, 4);
    emptyBand.write("\x1bPq?\x1b\\");
    expect(emptyBand.getImages()[0]).toMatchObject({ pixelWidth: 1, pixelHeight: 6 });
  });

  for (const terminator of ["\x07", "\x1b\\"]) {
    test(`decodes palette, repeat, raster size, and ${JSON.stringify(terminator)} termination`, () => {
      const parser = new AnsiParser(20, 4);
      parser.setCellSize(8, 16);

      parser.write(`\x1bP0;1q"1;1;2;6#1;2;100;0;0!2~${terminator}`);

      const [image] = parser.getImages();
      expect(image).toMatchObject({
        protocol: "sixel",
        kind: "rgba",
        pixelWidth: 2,
        pixelHeight: 6,
        widthCells: 1,
        heightCells: 1,
      });
      expect(Array.from(image.data.slice(0, 8))).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
    });
  }

  test("keeps untouched pixels transparent in transparent background mode", () => {
    const parser = new AnsiParser(20, 4);
    parser.write(`\x1bP0;1q"1;1;2;6#1;2;100;0;0@\x1b\\`);

    const [image] = parser.getImages();
    expect(image.data[3]).toBe(255);
    expect(image.data[7]).toBe(0);
  });
});

describe("AnsiParser resize", () => {
  test("keeps top content visible when the viewport shrinks below blank rows", () => {
    const parser = new AnsiParser(20, 6);
    parser.write("prompt$ ");

    parser.resize(20, 3);

    expect(visibleRowText(parser, 0)).toBe("prompt$");
    expect(parser.getFullCursor()).toEqual({ x: 8, y: 0 });
    expect(parser.getScrollbackLength()).toBe(0);
  });

  test("moves only cursor-overflow rows to scrollback and restores them on expansion", () => {
    const parser = new AnsiParser(20, 6);
    parser.write("line0\r\nline1\r\nline2\r\nline3\r\nline4");

    parser.resize(20, 3);

    expect(parser.getScrollbackLength()).toBe(2);
    expect(parser.getBuffer().map((_, row) => visibleRowText(parser, row))).toEqual([
      "line2",
      "line3",
      "line4",
    ]);
    expect(parser.getCursor()).toEqual({ x: 5, y: 2 });

    parser.resize(20, 6);

    expect(parser.getScrollbackLength()).toBe(0);
    expect(parser.getBuffer().slice(0, 5).map((_, row) => visibleRowText(parser, row))).toEqual([
      "line0",
      "line1",
      "line2",
      "line3",
      "line4",
    ]);
    expect(parser.getCursor()).toEqual({ x: 5, y: 4 });
  });

  test("reflows long rows instead of truncating when narrowing", () => {
    const parser = new AnsiParser(20, 6);
    parser.write("0123456789ABCDEFGHIJKL");

    parser.resize(10, 6);

    expect(visibleRowText(parser, 0)).toBe("0123456789");
    expect(visibleRowText(parser, 1)).toBe("ABCDEFGHIJ");
    expect(visibleRowText(parser, 2)).toBe("KL");
    expect(parser.getCursor()).toEqual({ x: 2, y: 2 });
  });

  test("maps a tracked preedit anchor independently from the live cursor", () => {
    const parser = new AnsiParser(80, 6);
    parser.write("x".repeat(73));

    const resizedAnchor = parser.resize(40, 6, { x: 70, y: 0 });

    expect(resizedAnchor).toEqual({ x: 30, y: 1 });
    expect(parser.getFullCursor()).toEqual({ x: 33, y: 1 });
  });

  test("maps an anchor after trailing spaces with the cursor column rule", () => {
    const parser = new AnsiParser(80, 6);
    parser.write("abc ");

    const resizedAnchor = parser.resize(2, 6, { x: 4, y: 0 });

    expect(resizedAnchor).toEqual({ x: 0, y: 1 });
    expect(parser.getFullCursor()).toEqual({ x: 0, y: 1 });
  });

  test("returns null when resize drops the tracked row", () => {
    const parser = new AnsiParser(20, 6);
    parser.write("\x1b[6;1Hanchor\x1b[1;1H");

    expect(parser.resize(20, 3, { x: 0, y: 5 })).toBeNull();
  });

  test("does not reflow a tracked row trimmed into scrollback", () => {
    const parser = new AnsiParser(80, 6);
    parser.write("x".repeat(70));
    parser.write("\x1b[6;1H");

    expect(parser.resize(40, 3, { x: 70, y: 0 })).toEqual({ x: 39, y: 0 });
  });

  test("reflows a tracked scrollback row pulled into the viewport", () => {
    const parser = new AnsiParser(80, 3);
    parser.write(`${"x".repeat(70)}\r\nrow1\r\nrow2\r\nrow3`);

    expect(parser.getScrollbackLength()).toBe(1);
    expect(parser.resize(40, 6, { x: 70, y: 0 })).toEqual({ x: 30, y: 1 });
  });

  test("clamps a tracked alternate-screen anchor without reflowing it", () => {
    const parser = new AnsiParser(80, 6);
    parser.write("\x1b[?1049h\x1b[1;71H");

    const resizedAnchor = parser.resize(40, 6, { x: 70, y: 0 });

    expect(resizedAnchor).toEqual({ x: 39, y: 0 });
    expect(parser.getFullCursor()).toEqual({ x: 39, y: 0 });
  });

  test("does not create persistent scrollback while alternate screen resizes", () => {
    const parser = new AnsiParser(20, 6);
    parser.write("\x1b[?1049h\x1b[6;1Hstatus");

    parser.resize(20, 3);

    expect(parser.isAlternateScreen()).toBe(true);
    expect(parser.getScrollbackLength()).toBe(0);
    expect(parser.getFullBuffer()).toHaveLength(3);

    parser.resize(20, 6);

    expect(parser.getScrollbackLength()).toBe(0);
    expect(parser.getFullBuffer()).toHaveLength(6);
  });

  test("normalizes the saved main screen before leaving a resized alternate screen", () => {
    const parser = new AnsiParser(20, 6);
    parser.write("line0\r\nline1\r\nline2\r\nline3\r\nline4");
    parser.write("\x1b[?1049h");

    parser.resize(20, 3);
    parser.write("\x1b[?1049l");

    expect(parser.getBuffer()).toHaveLength(3);
    expect(parser.getBuffer().map((_, row) => visibleRowText(parser, row))).toEqual([
      "line2",
      "line3",
      "line4",
    ]);
    expect(parser.getScrollbackLength()).toBe(2);
    expect(parser.getFullBuffer()).toHaveLength(5);
    expect(parser.getCursor()).toEqual({ x: 5, y: 2 });
  });
});

describe("AnsiParser erase in display", () => {
  test("CSI 2J clears visible screen but preserves scrollback", () => {
    expect(scrollbackLengthAfter("\x1b[2J")).toBe(1);
  });

  test("CSI 3J clears visible screen and scrollback", () => {
    expect(scrollbackLengthAfter("\x1b[3J")).toBe(0);
  });
});

describe("AnsiParser CSI work limits", () => {
  test("caps REP to the per-sequence work budget", () => {
    const parser = new AnsiParser(10, 2);

    parser.write("x\x1b[10001b");

    expect(parser.getCursor()).toEqual({ x: 7, y: 1 });
    expect(parser.getScrollbackLength()).toBe(24);
  });

  test("resolves oversized tab movement within terminal geometry", () => {
    const parser = new AnsiParser(80, 2);

    parser.write("\x1b[2147483647I");
    expect(parser.getCursor()).toEqual({ x: 79, y: 0 });

    parser.write("\x1b[2147483647Z");
    expect(parser.getCursor()).toEqual({ x: 0, y: 0 });
  });

  test("allocates insert cells only for the remaining columns", () => {
    const parser = new AnsiParser(8, 2);
    const parserInternals = parser as AnsiParser & {
      createEmptyCell: () => Cell;
    };
    const createEmptyCell = parserInternals.createEmptyCell.bind(parser);
    let allocatedCells = 0;
    parserInternals.createEmptyCell = () => {
      allocatedCells++;
      return createEmptyCell();
    };

    parser.write("abcdef\r\x1b[3C\x1b[10001@");

    expect(allocatedCells).toBe(5);
    expect(parser.getBuffer()[0]).toHaveLength(8);
    expect(visibleRowText(parser)).toBe("abc");
  });

  test("allocates scroll rows only for the active region", () => {
    const parser = new AnsiParser(8, 3);
    const parserInternals = parser as AnsiParser & {
      createEmptyRow: () => Cell[];
    };
    const createEmptyRow = parserInternals.createEmptyRow.bind(parser);
    let allocatedRows = 0;
    parserInternals.createEmptyRow = () => {
      allocatedRows++;
      return createEmptyRow();
    };

    parser.write("\x1b[10001S");

    expect(allocatedRows).toBe(3);
    expect(parser.getBuffer()).toHaveLength(3);
  });

  test("ignores CSI sequences with more than 32 parameters", () => {
    const parser = new AnsiParser(40, 2);
    parser.write("x");
    const cursorBeforeSequence = parser.getCursor();
    const parameters = Array.from({ length: 33 }, () => "1").join(";");

    parser.write(`\x1b[${parameters}b`);

    expect(parser.getCursor()).toEqual(cursorBeforeSequence);
    expect(visibleRowText(parser)).toBe("x");
  });

  test("discards oversized CSI sequences and resumes plain text", () => {
    const parser = new AnsiParser(40, 2);
    const oversizedParameters = "1;".repeat(600);

    parser.write(`before\x1b[${oversizedParameters}bafter`);

    expect(visibleRowText(parser)).toBe("beforeafter");
  });

  test("tracks bracketed paste mode across snapshots", () => {
    const parser = new AnsiParser(40, 2);
    parser.write("\x1b[?2004h");
    expect(parser.isBracketedPasteMode()).toBe(true);

    const restored = new AnsiParser(40, 2);
    restored.restoreSnapshot(parser.createSnapshot());
    expect(restored.isBracketedPasteMode()).toBe(true);

    restored.write("\x1b[?2004l");
    expect(restored.isBracketedPasteMode()).toBe(false);
  });

  test("preserves cursor visibility and synchronized output across snapshots", () => {
    const parser = new AnsiParser(40, 2);
    parser.write("\x1b[?25l\x1b[?2026h");

    const restored = new AnsiParser(40, 2);
    restored.restoreSnapshot(parser.createSnapshot());

    expect(restored.isCursorVisible()).toBe(false);
    expect(restored.isSynchronizedOutput()).toBe(true);
  });

  test("tracks mouse motion modes and preserves them across snapshots", () => {
    const parser = new AnsiParser(40, 2);
    parser.write("\x1b[?1002h\x1b[?1006h");

    expect(parser.isMouseEnabled()).toBe(true);
    expect(parser.shouldReportMouseMotion(false)).toBe(false);
    expect(parser.shouldReportMouseMotion(true)).toBe(true);
    expect(parser.shouldReportMouseRelease()).toBe(true);
    expect(parser.isSgrMouseEncoding()).toBe(true);

    const restored = new AnsiParser(40, 2);
    restored.restoreSnapshot(parser.createSnapshot());
    expect(restored.isMouseEnabled()).toBe(true);
    expect(restored.shouldReportMouseMotion(true)).toBe(true);
    expect(restored.isSgrMouseEncoding()).toBe(true);

    restored.write("\x1b[?1003h");
    expect(restored.shouldReportMouseMotion(false)).toBe(true);
    restored.write("\x1b[?1003l\x1b[?1006l");
    expect(restored.isMouseEnabled()).toBe(false);
    expect(restored.isSgrMouseEncoding()).toBe(false);
  });

  test("tracks X10 press-only mouse mode across snapshots", () => {
    const parser = new AnsiParser(40, 2);
    parser.write("\x1b[?9h");

    expect(parser.isMouseEnabled()).toBe(true);
    expect(parser.shouldReportMouseMotion(false)).toBe(false);
    expect(parser.shouldReportMouseMotion(true)).toBe(false);
    expect(parser.shouldReportMouseRelease()).toBe(false);

    const restored = new AnsiParser(40, 2);
    restored.restoreSnapshot(parser.createSnapshot());
    expect(restored.isMouseEnabled()).toBe(true);
    expect(restored.shouldReportMouseRelease()).toBe(false);

    restored.write("\x1b[?9l");
    expect(restored.isMouseEnabled()).toBe(false);
  });

  test("keeps the active mouse mode when an inactive mode is reset", () => {
    const parser = new AnsiParser(40, 2);
    parser.write("\x1b[?1002h");

    parser.write("\x1b[?1003l\x1b[?1000l");
    expect(parser.isMouseEnabled()).toBe(true);
    expect(parser.shouldReportMouseMotion(false)).toBe(false);
    expect(parser.shouldReportMouseMotion(true)).toBe(true);

    parser.write("\x1b[?1002l");
    expect(parser.isMouseEnabled()).toBe(false);
  });

});

describe("AnsiParser image resource limits", () => {
  test("discards oversized OSC and APC controls and resumes plain text", () => {
    const oversizedControl = "x".repeat(24 * 1024 * 1024);

    for (const state of ["osc", "apc"]) {
      const parser = new AnsiParser(40, 2);
      const parserInternals = parser as AnsiParser & {
        parseState: "osc" | "apc";
        escapeBuffer: string;
        pendingITerm2File: unknown;
        pendingKittyImage: unknown;
      };
      parser.write("before");
      parserInternals.parseState = state;
      parserInternals.escapeBuffer = oversizedControl;
      parserInternals.pendingITerm2File = state === "osc" ? {} : null;
      parserInternals.pendingKittyImage = state === "apc" ? {} : null;

      parser.write("x\x07after");

      expect(visibleRowText(parser)).toBe("beforeafter");
      expect(parserInternals.escapeBuffer).toBe("");
      expect(parserInternals.pendingITerm2File).toBeNull();
      expect(parserInternals.pendingKittyImage).toBeNull();
    }
  });

  test("cancels oversized APC and DCS controls with CAN or SUB", () => {
    const oversizedControl = "x".repeat(24 * 1024 * 1024);

    for (const [state, cancel] of [["apc", "\x18"], ["dcs", "\x1a"]] as const) {
      const parser = new AnsiParser(40, 2);
      const parserInternals = parser as AnsiParser & {
        parseState: "apc" | "dcs";
        escapeBuffer: string;
      };
      parser.write("before");
      parserInternals.parseState = state;
      parserInternals.escapeBuffer = oversizedControl;

      parser.write(`x${cancel}after`);

      expect(visibleRowText(parser)).toBe("beforeafter");
      expect(parserInternals.escapeBuffer).toBe("");
    }
  });

  test("abandons multipart images when their encoded byte budget is exceeded", () => {
    const parser = new AnsiParser(40, 2);
    const parserInternals = parser as AnsiParser & {
      pendingITerm2File: {
        args: Map<string, string>;
        chunks: string[];
        encodedLength: number;
      } | null;
      pendingKittyImage: {
        row: number;
        col: number;
        params: Map<string, string>;
        chunks: string[];
        encodedLength: number;
      } | null;
    };

    parserInternals.pendingITerm2File = {
      args: new Map([["inline", "1"]]),
      chunks: [],
      encodedLength: Number.MAX_SAFE_INTEGER,
    };
    parser.write("\x1b]1337;FilePart=AAAA\x07");
    expect(parserInternals.pendingITerm2File).toBeNull();

    parserInternals.pendingKittyImage = {
      row: 0,
      col: 0,
      params: new Map([["f", "32"]]),
      chunks: [],
      encodedLength: Number.MAX_SAFE_INTEGER,
    };
    parser.write("\x1b_Gm=1;AAAA\x1b\\");
    expect(parserInternals.pendingKittyImage).toBeNull();
    expect(parser.getImages()).toHaveLength(0);
  });

  test("accepts a maximum-size raw Kitty image in protocol-sized chunks", () => {
    const parser = new AnsiParser(120, 40);
    const width = 4096;
    const height = 1024;
    const payload = Buffer.alloc(width * height * 4, 255).toString("base64");
    const chunks = chunkBase64(payload, 4096);

    parser.write(
      `\x1b_Ga=T,f=32,s=${width},v=${height},i=901,c=20,r=20,m=1;${chunks[0]}\x1b\\`,
    );
    for (const chunk of chunks.slice(1, -1)) {
      parser.write(`\x1b_Gm=1;${chunk}\x1b\\`);
    }
    parser.write(`\x1b_Gm=0;${chunks.at(-1)}\x1b\\`);

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0]).toMatchObject({
      pixelWidth: width,
      pixelHeight: height,
    });
    expect(parser.getImages()[0].data).toHaveLength(width * height * 4);
  });

  test("rejects raw Kitty images one pixel over the decoded byte budget", () => {
    const parser = new AnsiParser(120, 40);
    const width = 4096;
    const height = 1024;
    const payload = Buffer.alloc(width * height * 4 + 4, 255).toString("base64");
    const chunks = chunkBase64(payload, 4096);

    parser.write(
      `\x1b_Ga=T,f=32,s=${width},v=${height},i=902,c=20,r=20,m=1;${chunks[0]}\x1b\\`,
    );
    for (const chunk of chunks.slice(1, -1)) {
      parser.write(`\x1b_Gm=1;${chunk}\x1b\\`);
    }
    parser.write(`\x1b_Gm=0;${chunks.at(-1)}\x1b\\`);

    expect(parser.getImages()).toHaveLength(0);
  });

  test("rejects Kitty APC chunks above the protocol limit", () => {
    const parser = new AnsiParser(40, 3);
    const oversizedChunk = "A".repeat(4097);

    parser.write(`\x1b_Ga=T,f=32,s=1,v=1,m=0;${oversizedChunk}\x1b\\`);
    parser.write(kittyRgbaApc({ imageId: 903, width: 1, height: 1 }));

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0]).toMatchObject({ pixelWidth: 1, pixelHeight: 1 });
  });

  test("rejects encoded images whose dimensions exceed the pixel budget", () => {
    const parser = new AnsiParser(40, 3);
    const oversizedPng = pngWithDimensionsBase64(4097, 1);

    parser.write(`before${kittyPngApc({ payload: oversizedPng })}after`);

    expect(parser.getImages()).toHaveLength(0);
    expect(visibleRowText(parser)).toBe("beforeafter");
  });

  test("preserves Kitty placement geometry past the right viewport edge", () => {
    const parser = new AnsiParser(5, 3);
    const payload = Buffer.alloc(10 * 4, 255).toString("base64");
    parser.write("abcd");
    const cursorBeforeImage = parser.getFullCursor();

    parser.write(`\x1b_Ga=T,f=32,s=10,v=1,c=10,r=1,C=1;${payload}\x1b\\`);

    expect(parser.getImages()[0]).toMatchObject({
      col: 4,
      widthCells: 10,
      sourceWidth: 10,
    });
    expect(parser.getFullCursor()).toEqual(cursorBeforeImage);
  });

  test("rejects new image data after the session byte budget is full", () => {
    const parser = new AnsiParser(40, 3);
    const parserInternals = parser as AnsiParser & {
      kittyImageData: Map<number, {
        kind: "rgba";
        pixelWidth: number;
        pixelHeight: number;
        data: Uint8ClampedArray;
      }>;
    };
    parserInternals.kittyImageData.set(1, {
      kind: "rgba",
      pixelWidth: 1,
      pixelHeight: 1,
      data: new Uint8ClampedArray(32 * 1024 * 1024),
    });

    parser.write(kittyRgbaApc());

    expect(parser.getImages()).toHaveLength(0);
  });

  test("does not let retained Kitty history block another image protocol", () => {
    const parser = new AnsiParser(40, 3);
    const fourMegapixelPng = pngWithDimensionsBase64(2048, 2048);

    for (let index = 0; index < 3; index++) {
      parser.write("\x1b[1;1H");
      parser.write(kittyPngApc({ widthCells: 1, heightCells: 1, payload: fourMegapixelPng }));
    }
    parser.write(iterm2FileOsc(["inline=1", "width=1", "height=1"], TINY_PNG_BASE64));

    expect(parser.getImages().map((image) => image.protocol)).toEqual([
      "kitty",
      "kitty",
      "kitty",
      "iterm2",
    ]);
  });

  test("retains compressed Kitty history beyond the renderer pixel cache", () => {
    const parser = new AnsiParser(40, 3);
    const fourMegapixelPng = pngWithDimensionsBase64(2048, 2048);

    for (let index = 0; index < 3; index++) {
      parser.write("\x1b[1;1H");
      parser.write(kittyPngApc({ widthCells: 1, heightCells: 1, payload: fourMegapixelPng }));
    }

    expect(parser.getImages()).toHaveLength(3);
  });

  test("accepts animated GIFs through the encoded image path", () => {
    const parser = new AnsiParser(40, 3);
    const gifHeader = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0];
    const gifFrame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
    const animatedGif = Buffer.from([...gifHeader, ...gifFrame, ...gifFrame, 0x3b]).toString("base64");

    parser.write(iterm2FileOsc(["inline=1", "width=1", "height=1"], animatedGif));

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0]).toMatchObject({
      kind: "encoded",
      mimeType: "image/gif",
      animated: true,
      decodedFramePixels: 2,
    });
  });

  test("accounts for an animated image's full logical canvas", () => {
    const parser = new AnsiParser(40, 3);
    const gifHeader = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 8, 0, 8, 0, 0, 0];
    const gifFrame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
    const animatedGif = Buffer.from([...gifHeader, ...gifFrame, ...gifFrame, 0x3b]).toString("base64");

    parser.write(iterm2FileOsc(["inline=1", "width=1", "height=1"], animatedGif));

    expect(parser.getImages()[0]).toMatchObject({
      pixelWidth: 2048,
      pixelHeight: 2048,
      decodedFramePixels: 4 * 1024 * 1024,
    });
  });

  test("accepts animated WebP metadata through the encoded image path", () => {
    const parser = new AnsiParser(40, 3);
    const webp = new Uint8Array(54);
    webp.set(Buffer.from("RIFF"), 0);
    new DataView(webp.buffer).setUint32(4, webp.length - 8, true);
    webp.set(Buffer.from("WEBPVP8X"), 8);
    new DataView(webp.buffer).setUint32(16, 10, true);
    webp[20] = 0x02;
    webp[24] = 1;
    webp.set(Buffer.from("ANMF"), 30);
    new DataView(webp.buffer).setUint32(34, 16, true);
    webp[44] = 1;

    parser.write(
      iterm2FileOsc(["inline=1", "width=1", "height=1"], Buffer.from(webp).toString("base64")),
    );

    expect(parser.getImages()).toHaveLength(1);
    expect(parser.getImages()[0]).toMatchObject({
      kind: "encoded",
      mimeType: "image/webp",
      pixelWidth: 2,
      pixelHeight: 1,
      animated: true,
      decodedFramePixels: 2,
    });
  });
  test("rejects separator-heavy iTerm2 and Kitty metadata", () => {
    const parser = new AnsiParser(40, 3);
    const itermParams = [
      "inline=1",
      ...Array.from({ length: 32 }, (_, index) => `x${index}=1`),
    ].join(";");
    const kittyParams = [
      "a=T",
      "f=32",
      "s=1",
      "v=1",
      "c=1",
      "r=1",
      ...Array.from({ length: 27 }, (_, index) => `x${index}=1`),
    ].join(",");

    parser.write(`before${iterm2FileOsc(itermParams.split(";"), TINY_PNG_BASE64)}after`);
    parser.write(`\x1b_G${kittyParams};AQIDBA==\x1b\\tail`);

    expect(parser.getImages()).toHaveLength(0);
    expect(visibleRowText(parser)).toBe("beforeaftertail");
  });

});

describe("AnsiParser image reflow", () => {
  test("moves a physical image anchor with its wrapped text row", () => {
    const parser = new AnsiParser(4, 4);
    parser.write("abc");
    parser.write("\x1b_Ga=T,f=32,s=1,v=1,c=1,r=1,C=1;AQIDBA==\x1b\\");

    expect(parser.getImages()[0]).toMatchObject({ row: 0, col: 3 });

    parser.resize(2, 4);

    expect(parser.getImages()[0]).toMatchObject({ row: 1, col: 1 });
  });
});
describe("AnsiParser reflow wide-char boundaries", () => {
  test("narrowing keeps wide-char pairs together at chunk boundaries", () => {
    const parser = new AnsiParser(20, 3);
    parser.write("가가가가x가AB");
    parser.resize(10, 3);

    const rows = parser.getBuffer();
    for (const row of rows) {
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (cell.char === "") {
          // A placeholder must always sit right after its wide main cell,
          // never at the start of a reflowed row.
          expect(x).toBeGreaterThan(0);
        }
      }
    }
    const flattened = rows.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(flattened.replace(/\n+$/g, "")).toContain("가가가가x");
  });

  test("Nerd Font PUA glyphs remain one cell", () => {
    const parser = new AnsiParser(8, 2);
    parser.write("󰪥X");

    expect(parser.getBuffer()[0].slice(0, 3).map((cell) => cell.char)).toEqual([
      "",
      "󰪥",
      "X",
    ]);
  });
});
