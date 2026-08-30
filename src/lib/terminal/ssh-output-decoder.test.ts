// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { SshOutputDecoder } from "./ssh-output-decoder";

describe("SshOutputDecoder", () => {
  test("reassembles UTF-8 characters split across SSH chunks", () => {
    const decoder = new SshOutputDecoder();
    const bytes = new TextEncoder().encode("A한🙂B");

    expect(decoder.decode(bytes.slice(0, 2))).toBe("A");
    expect(decoder.decode(bytes.slice(2, 3))).toBe("");
    expect(decoder.decode(bytes.slice(3, 6))).toBe("한");
    expect(decoder.decode(bytes.slice(6))).toBe("🙂B");
  });

  test("restores an incomplete UTF-8 character from a snapshot", () => {
    const source = new SshOutputDecoder();
    const bytes = new TextEncoder().encode("한");
    expect(source.decode(bytes.slice(0, 2))).toBe("");

    const restored = new SshOutputDecoder();
    restored.restorePendingBytes(source.getPendingBytes());

    expect(restored.decode(bytes.slice(2))).toBe("한");
    expect(restored.getPendingBytes()).toEqual([]);
  });

  test("does not carry an incomplete character into a new SSH session", () => {
    const decoder = new SshOutputDecoder();
    const bytes = new TextEncoder().encode("한");

    expect(decoder.decode(bytes.slice(0, 1))).toBe("");
    decoder.reset();
    expect(decoder.decode(new TextEncoder().encode("next"))).toBe("next");
  });
});
