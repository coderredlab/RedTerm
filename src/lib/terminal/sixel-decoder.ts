export interface SixelDecodeOptions {
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  maxDrawOperations?: number;
  transparentBackground: boolean;
}

export interface DecodedSixel {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  pixelAspectRatio: number;
}

interface SixelDimensions {
  width: number;
  height: number;
  pixelAspectRatio: number;
}

const MAX_COLOR_REGISTERS = 256;
const SIXEL_MIN = 0x3f;
const SIXEL_MAX = 0x7e;

export function decodeSixel(payload: string, options: SixelDecodeOptions): DecodedSixel | null {
  const dimensions = scanDimensions(payload, options);
  if (!dimensions) return null;

  const { width, height, pixelAspectRatio } = dimensions;
  const data = new Uint8ClampedArray(width * height * 4);
  const palette = createDefaultPalette();
  if (!options.transparentBackground) {
    const background = palette[0];
    for (let offset = 0; offset < data.length; offset += 4) {
      data[offset] = background[0];
      data[offset + 1] = background[1];
      data[offset + 2] = background[2];
      data[offset + 3] = 0xff;
    }
  }

  let x = 0;
  let y = 0;
  let colorRegister = 0;
  for (let index = 0; index < payload.length;) {
    const code = payload.charCodeAt(index);
    if (code >= SIXEL_MIN && code <= SIXEL_MAX) {
      drawSixel(data, width, height, x, y, code - SIXEL_MIN, 1, palette[colorRegister]);
      x++;
      index++;
      continue;
    }
    if (payload[index] === '!') {
      const count = readNumber(payload, index + 1);
      if (!count || count.value <= 0 || count.next >= payload.length) return null;
      const repeated = payload.charCodeAt(count.next);
      if (repeated < SIXEL_MIN || repeated > SIXEL_MAX) return null;
      drawSixel(data, width, height, x, y, repeated - SIXEL_MIN, count.value, palette[colorRegister]);
      x += count.value;
      index = count.next + 1;
      continue;
    }
    if (payload[index] === '#') {
      const color = readParameters(payload, index + 1, 5);
      if (color.values.length === 0) return null;
      colorRegister = clamp(color.values[0], 0, MAX_COLOR_REGISTERS - 1);
      if (color.values.length >= 5) {
        const mode = color.values[1];
        if (mode === 2) {
          palette[colorRegister] = [
            percentageByte(color.values[2]),
            percentageByte(color.values[3]),
            percentageByte(color.values[4]),
            0xff,
          ];
        } else if (mode === 1) {
          palette[colorRegister] = hlsToRgba(color.values[2], color.values[3], color.values[4]);
        }
      }
      index = color.next;
      continue;
    }
    if (payload[index] === '"') {
      index = readParameters(payload, index + 1, 4).next;
      continue;
    }
    if (payload[index] === '$') {
      x = 0;
      index++;
      continue;
    }
    if (payload[index] === '-') {
      x = 0;
      y += 6;
      index++;
      continue;
    }
    index++;
  }

  return { data, width, height, pixelAspectRatio };
}

function scanDimensions(payload: string, options: SixelDecodeOptions): SixelDimensions | null {
  let x = 0;
  let y = 0;
  let maxX = 0;
  let maxY = 0;
  let declaredWidth = 0;
  let declaredHeight = 0;
  let pixelAspectRatio = 1;
  const maxDrawOperations = options.maxDrawOperations ?? options.maxPixels * 4;
  let drawOperations = 0;

  for (let index = 0; index < payload.length;) {
    const code = payload.charCodeAt(index);
    if (code >= SIXEL_MIN && code <= SIXEL_MAX) {
      drawOperations += sixelBitCount(code - SIXEL_MIN);
      if (drawOperations > maxDrawOperations) return null;
      x++;
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y + 6);
      index++;
      continue;
    }
    if (payload[index] === '!') {
      const count = readNumber(payload, index + 1);
      if (!count || count.value <= 0 || count.next >= payload.length) return null;
      const repeated = payload.charCodeAt(count.next);
      if (repeated < SIXEL_MIN || repeated > SIXEL_MAX) return null;
      if (count.value > options.maxWidth || x + count.value > options.maxWidth) return null;
      x += count.value;
      const repeatedWrites = count.value * sixelBitCount(repeated - SIXEL_MIN);
      if (repeatedWrites > maxDrawOperations - drawOperations) return null;
      drawOperations += repeatedWrites;
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y + 6);
      index = count.next + 1;
      continue;
    }
    if (payload[index] === '"') {
      const raster = readParameters(payload, index + 1, 4);
      if (raster.values.length >= 2 && raster.values[0] > 0 && raster.values[1] > 0) {
        pixelAspectRatio = raster.values[0] / raster.values[1];
      }
      if (raster.values.length >= 4) {
        declaredWidth = raster.values[2];
        declaredHeight = raster.values[3];
      }
      index = raster.next;
      continue;
    }
    if (payload[index] === '#') {
      index = readParameters(payload, index + 1, 5).next;
      continue;
    }
    if (payload[index] === '$') {
      x = 0;
      index++;
      continue;
    }
    if (payload[index] === '-') {
      x = 0;
      y += 6;
      if (y >= options.maxHeight) return null;
      index++;
      continue;
    }
    index++;
  }

  const width = Math.max(declaredWidth, maxX);
  const height = Math.max(declaredHeight, maxY);
  const destinationHeight = height * pixelAspectRatio;
  if (
    width <= 0 ||
    height <= 0 ||
    width > options.maxWidth ||
    height > options.maxHeight ||
    width * height > options.maxPixels ||
    !Number.isFinite(destinationHeight) ||
    destinationHeight <= 0 ||
    destinationHeight > options.maxHeight ||
    width * destinationHeight > options.maxPixels
  ) {
    return null;
  }
  return { width, height, pixelAspectRatio };
}

function drawSixel(
  destination: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  bits: number,
  repeat: number,
  color: [number, number, number, number],
) {
  const endX = Math.min(width, startX + repeat);
  for (let bit = 0; bit < 6; bit++) {
    if ((bits & (1 << bit)) === 0 || startY + bit >= height) continue;
    let offset = ((startY + bit) * width + startX) * 4;
    for (let x = startX; x < endX; x++, offset += 4) {
      destination[offset] = color[0];
      destination[offset + 1] = color[1];
      destination[offset + 2] = color[2];
      destination[offset + 3] = color[3];
    }
  }
}

function readNumber(value: string, start: number): { value: number; next: number } | null {
  let next = start;
  let parsed = 0;
  let digits = 0;
  while (next < value.length) {
    const code = value.charCodeAt(next);
    if (code < 0x30 || code > 0x39) break;
    parsed = parsed * 10 + code - 0x30;
    if (!Number.isSafeInteger(parsed)) return null;
    digits++;
    next++;
  }
  return digits === 0 ? null : { value: parsed, next };
}

function readParameters(value: string, start: number, limit: number): { values: number[]; next: number } {
  const values: number[] = [];
  let next = start;
  while (values.length < limit && next < value.length) {
    const number = readNumber(value, next);
    if (!number) break;
    values.push(number.value);
    next = number.next;
    if (value[next] !== ';') break;
    next++;
  }
  return { values, next };
}

function sixelBitCount(value: number): number {
  let count = 0;
  for (let bit = 0; bit < 6; bit++) {
    if ((value & (1 << bit)) !== 0) count++;
  }
  return count;
}


function createDefaultPalette(): Array<[number, number, number, number]> {
  const palette = Array.from({ length: MAX_COLOR_REGISTERS }, (): [number, number, number, number] => [0, 0, 0, 0xff]);
  const ansi: Array<[number, number, number]> = [
    [0, 0, 0], [51, 51, 204], [204, 33, 33], [51, 204, 51],
    [204, 51, 204], [51, 204, 204], [204, 204, 51], [229, 229, 229],
    [127, 127, 127], [51, 51, 255], [255, 51, 51], [51, 255, 51],
    [255, 51, 255], [51, 255, 255], [255, 255, 51], [255, 255, 255],
  ];
  for (let index = 0; index < ansi.length; index++) palette[index] = [...ansi[index], 0xff];
  return palette;
}

function percentageByte(value: number): number {
  return Math.round(clamp(value, 0, 100) * 2.55);
}

function hlsToRgba(hue: number, lightness: number, saturation: number): [number, number, number, number] {
  const h = ((hue + 240) % 360) / 360;
  const l = clamp(lightness, 0, 100) / 100;
  const s = clamp(saturation, 0, 100) / 100;
  if (s === 0) {
    const gray = Math.round(l * 255);
    return [gray, gray, gray, 0xff];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(channel(1 / 3) * 255), Math.round(channel(0) * 255), Math.round(channel(-1 / 3) * 255), 0xff];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
