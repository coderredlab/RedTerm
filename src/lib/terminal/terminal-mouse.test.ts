// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { encodeTerminalMouseEvent } from "./terminal-mouse";

const decoder = new TextDecoder();

describe("encodeTerminalMouseEvent", () => {
  test("encodes SGR press, drag, release, and wheel events", () => {
    expect(
      decoder.decode(
        encodeTerminalMouseEvent({ action: "press", button: 0, col: 4, row: 7, sgr: true }),
      ),
    ).toBe("\x1b[<0;5;8M");
    expect(
      decoder.decode(
        encodeTerminalMouseEvent({ action: "move", button: 0, col: 5, row: 8, sgr: true }),
      ),
    ).toBe("\x1b[<32;6;9M");
    expect(
      decoder.decode(
        encodeTerminalMouseEvent({ action: "release", button: 0, col: 5, row: 8, sgr: true }),
      ),
    ).toBe("\x1b[<0;6;9m");
    expect(
      decoder.decode(
        encodeTerminalMouseEvent({
          action: "press",
          button: 64,
          col: 5,
          row: 8,
          sgr: true,
          repeat: 2,
        }),
      ),
    ).toBe("\x1b[<64;6;9M\x1b[<64;6;9M");
  });

  test("encodes legacy events as protocol bytes", () => {
    expect(
      Array.from(
        encodeTerminalMouseEvent({ action: "press", button: 0, col: 4, row: 7, sgr: false }),
      ),
    ).toEqual([0x1b, 0x5b, 0x4d, 32, 37, 40]);
    expect(
      Array.from(
        encodeTerminalMouseEvent({ action: "move", button: 0, col: 5, row: 8, sgr: false }),
      ),
    ).toEqual([0x1b, 0x5b, 0x4d, 64, 38, 41]);
    expect(
      Array.from(
        encodeTerminalMouseEvent({ action: "release", button: 0, col: 5, row: 8, sgr: false }),
      ),
    ).toEqual([0x1b, 0x5b, 0x4d, 35, 38, 41]);
  });
});
