// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { encodeTerminalMouseEvent, terminalMouseCellFromPoint } from "./terminal-mouse";

const decoder = new TextDecoder();

describe("terminalMouseCellFromPoint", () => {
  const viewport = {
    viewportLeft: 100,
    viewportTop: 50,
    horizontalPadding: 8,
    charWidth: 10,
    charHeight: 20,
    cols: 80,
    rows: 24,
  };

  test("uses viewport-relative rows without scrollback offsets", () => {
    expect(
      terminalMouseCellFromPoint({
        ...viewport,
        clientX: 148,
        clientY: 200,
      }),
    ).toEqual({ col: 4, row: 7 });
  });

  test("clamps coordinates to the remote terminal geometry", () => {
    expect(
      terminalMouseCellFromPoint({
        ...viewport,
        clientX: 0,
        clientY: 0,
      }),
    ).toEqual({ col: 0, row: 0 });
    expect(
      terminalMouseCellFromPoint({
        ...viewport,
        clientX: 2000,
        clientY: 2000,
      }),
    ).toEqual({ col: 79, row: 23 });
  });
});

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

  test("encodes all buttons and modifier bits", () => {
    expect(
      decoder.decode(
        encodeTerminalMouseEvent({
          action: "press",
          button: 2,
          col: 0,
          row: 0,
          sgr: true,
          shiftKey: true,
          ctrlKey: true,
        }),
      ),
    ).toBe("\x1b[<22;1;1M");
    expect(
      decoder.decode(
        encodeTerminalMouseEvent({
          action: "move",
          button: 1,
          col: 2,
          row: 3,
          sgr: true,
          altKey: true,
        }),
      ),
    ).toBe("\x1b[<41;3;4M");
    expect(
      decoder.decode(
        encodeTerminalMouseEvent({
          action: "release",
          button: 2,
          col: 2,
          row: 3,
          sgr: true,
          shiftKey: true,
        }),
      ),
    ).toBe("\x1b[<6;3;4m");
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
    expect(
      Array.from(
        encodeTerminalMouseEvent({
          action: "release",
          button: 2,
          col: 0,
          row: 0,
          sgr: false,
          altKey: true,
          ctrlKey: true,
        }),
      ),
    ).toEqual([0x1b, 0x5b, 0x4d, 59, 33, 33]);
  });
});
