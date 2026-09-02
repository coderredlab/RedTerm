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

  test("recognizes extensionless shell and configuration files", () => {
    expect(previewKindOf(".gitconfig")).toBe("code");
    expect(previewKindOf(".profile")).toBe("code");
    expect(previewKindOf(".tcshrc")).toBe("code");
    expect(previewKindOf(".zprofile")).toBe("code");
    expect(previewKindOf(".zshenv")).toBe("code");
  });

  test("recognizes generated shell files and backups", () => {
    expect(previewKindOf(".zcompdump-host-5.9")).toBe("code");
    expect(previewKindOf(".zshrc.backup-2026")).toBe("code");
    expect(previewKindOf(".zshrc.pre-oh-my-zsh")).toBe("code");
  });

  test("recognizes extensionless text metadata without masking binary files", () => {
    expect(previewKindOf(".CFUserTextEncoding")).toBe("text");
    expect(previewKindOf(".zsh_history")).toBe("text");
    expect(previewKindOf(".lmstudio-home-pointer")).toBe("text");
    expect(previewKindOf(".DS_Store")).toBe("unknown");
  });

  test("keeps known binary formats out of the text editor", () => {
    expect(previewKindOf("manual.pdf")).toBe("pdf");
    expect(previewKindOf("photo.png")).toBe("image");
    expect(previewKindOf("recording.mp3")).toBe("audio");
    expect(previewKindOf("recording.mp4")).toBe("video");
  });
});
