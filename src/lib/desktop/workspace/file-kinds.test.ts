// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { previewKindOf } from "./file-kinds";

describe("file preview kinds", () => {
  test("opens Svelte source files as editable code", () => {
    expect(previewKindOf("Component.svelte")).toBe("code");
  });

  test("keeps unregistered extensions available for content detection", () => {
    expect(previewKindOf("template.templ")).toBe("unknown");
  });

  test("keeps known binary formats out of the text editor", () => {
    expect(previewKindOf("manual.pdf")).toBe("pdf");
    expect(previewKindOf("photo.png")).toBe("image");
    expect(previewKindOf("recording.mp3")).toBe("audio");
    expect(previewKindOf("recording.mp4")).toBe("video");
  });
});
