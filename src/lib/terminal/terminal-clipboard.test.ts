// @ts-nocheck
import { describe, expect, test } from "bun:test";

import {
  resolveTerminalClipboardImagePath,
  writeTerminalClipboardText,
} from "./terminal-clipboard";

describe("writeTerminalClipboardText", () => {
  test("uses only the native writer for desktop targets", async () => {
    const nativeWrites: string[] = [];
    const browserWrites: string[] = [];

    await writeTerminalClipboardText(
      "selected text",
      true,
      async (text) => nativeWrites.push(text),
      { writeText: async (text) => browserWrites.push(text) },
    );

    expect(nativeWrites).toEqual(["selected text"]);
    expect(browserWrites).toEqual([]);
  });

  test("does not fall back when the native desktop writer rejects", async () => {
    const browserWrites: string[] = [];

    await expect(
      writeTerminalClipboardText(
        "selected text",
        true,
        async () => {
          throw new Error("native clipboard failed");
        },
        { writeText: async (text) => browserWrites.push(text) },
      ),
    ).rejects.toThrow("native clipboard failed");
    expect(browserWrites).toEqual([]);
  });

  test("uses the browser writer outside desktop targets", async () => {
    const nativeWrites: string[] = [];
    const browserWrites: string[] = [];

    await writeTerminalClipboardText(
      "selected text",
      false,
      async (text) => nativeWrites.push(text),
      { writeText: async (text) => browserWrites.push(text) },
    );

    expect(nativeWrites).toEqual([]);
    expect(browserWrites).toEqual(["selected text"]);
  });

  test("rejects when browser clipboard writing is unavailable", async () => {
    await expect(
      writeTerminalClipboardText("selected text", false, async () => {}, undefined),
    ).rejects.toThrow("Clipboard writing is unavailable");
  });
});

describe("resolveTerminalClipboardImagePath", () => {
  test("keeps the staged local path without uploading for local shells", async () => {
    let uploads = 0;

    const result = await resolveTerminalClipboardImagePath(
      "/tmp/redterm-clipboard.png",
      true,
      async () => {
        uploads += 1;
        return "/remote/clipboard.png";
      },
    );

    expect(result).toBe("/tmp/redterm-clipboard.png");
    expect(uploads).toBe(0);
  });

  test("uses the uploaded remote path for SSH shells", async () => {
    const uploads: string[] = [];

    const result = await resolveTerminalClipboardImagePath(
      "/tmp/redterm-clipboard.png",
      false,
      async (localPath) => {
        uploads.push(localPath);
        return "/remote/clipboard.png";
      },
    );

    expect(uploads).toEqual(["/tmp/redterm-clipboard.png"]);
    expect(result).toBe("/remote/clipboard.png");
  });

  test("rejects SSH routing without an uploader", async () => {
    await expect(
      resolveTerminalClipboardImagePath("/tmp/redterm-clipboard.png", false),
    ).rejects.toThrow("Remote image uploader is unavailable");
  });
});
