// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { AutomaticResponseBuffer } from "./automatic-response-buffer";
import { AnsiParser } from "./ansi-parser";

describe("AutomaticResponseBuffer", () => {
  test("batches a full palette probe without a fixed request-rate cutoff", () => {
    const buffer = new AutomaticResponseBuffer();
    const responses = Array.from(
      { length: 256 },
      (_, index) => `\x1b]4;${index};rgb:0000/0000/0000\x1b\\`,
    );

    for (const response of responses) {
      expect(buffer.enqueue(response)).toBeTrue();
    }

    expect(buffer.drain()).toBe(responses.join(""));
  });

  test("preserves one reply for every repeated status request", () => {
    const buffer = new AutomaticResponseBuffer();

    expect(buffer.enqueue("\x1b[0n")).toBeTrue();
    expect(buffer.enqueue("\x1b[0n")).toBeTrue();
    expect(buffer.drain()).toBe("\x1b[0n\x1b[0n");
  });

  test("keeps every reply from a rapid parser status-query burst", () => {
    const parser = new AnsiParser(80, 24);
    const buffer = new AutomaticResponseBuffer();
    parser.setResponseHandler((response) => {
      expect(buffer.enqueue(response)).toBeTrue();
    });

    parser.write("\x1b[5n".repeat(256));

    expect(buffer.drain()).toBe("\x1b[0n".repeat(256));
  });

  test("drops only an overflowing reply and accepts the next batch", () => {
    const buffer = new AutomaticResponseBuffer(2, 8);

    expect(buffer.enqueue("abc")).toBeTrue();
    expect(buffer.enqueue("def")).toBeTrue();
    expect(buffer.enqueue("ghi")).toBeFalse();
    expect(buffer.drain()).toBe("abcdef");
    expect(buffer.enqueue("next")).toBeTrue();
  });
});
