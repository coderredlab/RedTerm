// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { decodeSixel } from "./sixel-decoder";

describe("decodeSixel work limits", () => {
  test("rejects repeated redraws that exceed the cumulative pixel-write budget", () => {
    const payload = "!4096~$".repeat(5000);

    expect(decodeSixel(payload, {
      maxWidth: 4096,
      maxHeight: 4096,
      transparentBackground: false,
      maxPixels: 4 * 1024 * 1024,
    })).toBeNull();
  });

  test("rejects raster aspect ratios that exceed destination pixel limits", () => {
    expect(decodeSixel('"1000000000;1;1;1~', {
      maxWidth: 4096,
      maxHeight: 4096,
      transparentBackground: false,
      maxPixels: 4 * 1024 * 1024,
    })).toBeNull();
  });

  test("rejects destination pixel areas above the image budget", () => {
    expect(decodeSixel('"682;1;4096;1?', {
      maxWidth: 4096,
      maxHeight: 4096,
      transparentBackground: false,
      maxPixels: 4 * 1024 * 1024,
    })).toBeNull();
  });
});
