#!/usr/bin/env bun

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const iconRoot = join(projectRoot, "src-tauri", "icons");
const catalog = join(projectRoot, "src-tauri", "gen", "apple", "Assets.xcassets", "AppIcon.appiconset");
const source = await Bun.file(join(iconRoot, "app-icon.svg")).text();
const insetBackground = '<rect x="64" y="64" width="896" height="896" rx="220" fill="url(#bg)"/>';
if (source.split(insetBackground).length !== 2) {
  throw new Error("Expected exactly one inset background in app-icon.svg");
}

// iOS masks the icon itself; preserve the desktop artwork but fill its transparent inset.
const fullBleed = source.replace(
  insetBackground,
  '<rect x="0" y="0" width="1024" height="1024" fill="url(#bg)"/>'
);
const staging = await mkdtemp(join(tmpdir(), "redterm-ios-icons-"));
try {
  const input = join(staging, "icon.svg");
  const output = join(staging, "generated");
  await Bun.write(input, fullBleed);
  const tauri = Bun.spawn([process.execPath, "run", "tauri", "icon", input, "--output", output], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit"
  });
  if ((await tauri.exited) !== 0) throw new Error("Tauri icon generation failed");

  const manifest = await Bun.file(join(catalog, "Contents.json")).json();
  const filenames = [...new Set(manifest.images.map((image: { filename: string }) => image.filename))];
  for (const filename of filenames) {
    if (!(await Bun.file(join(output, "ios", filename)).exists())) {
      throw new Error(`Missing generated iOS icon: ${filename}`);
    }
  }
  for (const filename of filenames) {
    const generated = join(output, "ios", filename);
    await copyFile(generated, join(iconRoot, "ios", filename));
    await copyFile(generated, join(catalog, filename));
  }
  console.log(`Updated ${filenames.length} iOS icon sizes and their Xcode catalog copies`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
