// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { AnsiParser, type Cell } from "./ansi-parser";

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

    test(`swallows DCS payload terminated by ${name} without dropping surrounding text`, () => {
      const parser = new AnsiParser(80, 3);

      parser.write(`before\x1bPq\"1;1;5;5#0!9~sixel-bytes${terminator}after`);

      expect(visibleRowText(parser)).toBe("beforeafter");
    });
  }
});

describe("AnsiParser Kitty images", () => {
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
    expect(visibleRowText(parser, 1)).toBe("abc");
    const rowBelowImage = parser.getBuffer()[2].map((cell) => cell.char).join("");
    expect(rowBelowImage.trim()).toBe("tail");
    expect(parser.getFullCursor().y).toBe(cursorBeforeImage.y + image.heightCells);
    const visibleText = parser
      .getBuffer()
      .map((row) => row.map((cell) => cell.char).join(""))
      .join("\n");
    expect(visibleText).not.toContain("AAECAwQFBgcI");
    expect(visibleText).not.toContain("CQoLDA0ODw==");
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
    expect(visibleRowText(parser, cursorBeforeImage.y + 1)).toBe("tail");
    expect(parser.getFullCursor()).toEqual({
      x: "tail".length,
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
    expect(visibleRowText(parser, 1)).toBe("xy");
    expect(visibleRowText(parser, 3)).toBe("tail");
    expect(parser.getFullCursor().y).toBe(cursorBeforeImage.y + image.heightCells);
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
    expect(image.heightCells).toBe(2);
    expect(visibleRowText(parser, 3)).toBe("tail");
    expect(parser.getFullCursor().y).toBe(cursorBeforeImage.y + image.heightCells);
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
    expect(image.widthCells).toBe(6);
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

    parser.write(iterm2FileOsc(["inline=1", "width=16px", "height=32px"], TINY_PNG_BASE64));

    const images = parser.getImages();

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.widthCells).toBe(2);
    expect(image.heightCells).toBe(2);
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.data)).toEqual(Array.from(TINY_PNG_BYTES));
  });

  test("converts iTerm2 percent size units against parser dimensions", () => {
    const parser = new AnsiParser(80, 20);

    parser.write(iterm2FileOsc(["inline=1", "width=25%", "height=10%"], TINY_PNG_BASE64));

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

    parser.write(`${iterm2FileOsc(["inline=1", "width=4", "height=2"], TWO_BY_ONE_JPEG_BASE64)}tail`);

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
    expect(image.heightCells).toBe(2);
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

});

describe("AnsiParser image resource limits", () => {
  test("discards oversized OSC and APC controls and resumes plain text", () => {
    const oversizedControl = "x".repeat(6 * 1024 * 1024);

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

  test("rejects encoded images whose dimensions exceed the pixel budget", () => {
    const parser = new AnsiParser(40, 3);
    const oversizedPng = pngWithDimensionsBase64(4097, 1);

    parser.write(`before${kittyPngApc({ payload: oversizedPng })}after`);

    expect(parser.getImages()).toHaveLength(0);
    expect(visibleRowText(parser)).toBe("beforeafter");
  });

  test("caps image placement cells to the current terminal geometry", () => {
    const parser = new AnsiParser(10, 3);
    parser.write("x");

    parser.write(`${kittyPngApc({ widthCells: 999999, heightCells: 999999 })}tail`);

    const [image] = parser.getImages();
    expect(image.widthCells).toBe(9);
    expect(image.heightCells).toBe(3);
    expect(parser.getCursor()).toEqual({ x: 4, y: 2 });
    expect(parser.getScrollbackLength()).toBe(1);
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

  test("limits decoded image placements by total pixel count", () => {
    const parser = new AnsiParser(40, 3);
    const fourMegapixelPng = pngWithDimensionsBase64(2048, 2048);

    for (let index = 0; index < 3; index++) {
      parser.write("\x1b[1;1H");
      parser.write(kittyPngApc({ widthCells: 1, heightCells: 1, payload: fourMegapixelPng }));
    }

    expect(parser.getImages()).toHaveLength(2);
  });

  test("rejects animated GIFs from the encoded image path", () => {
    const parser = new AnsiParser(40, 3);
    const gifHeader = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0];
    const gifFrame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
    const animatedGif = Buffer.from([...gifHeader, ...gifFrame, ...gifFrame, 0x3b]).toString("base64");

    parser.write(`before${iterm2FileOsc(["inline=1", "width=1", "height=1"], animatedGif)}after`);

    expect(parser.getImages()).toHaveLength(0);
    expect(visibleRowText(parser)).toBe("beforeafter");
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
