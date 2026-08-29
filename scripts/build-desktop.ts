#!/usr/bin/env bun

import { delimiter, join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const environment = { ...process.env };

if (process.platform === "darwin") {
  const dmgToolsPath = join(import.meta.dir, "dmg-tools");
  environment.PATH = environment.PATH
    ? `${dmgToolsPath}${delimiter}${environment.PATH}`
    : dmgToolsPath;
  environment.CI = "true";
  environment.REDTERM_PROJECT_ROOT = projectRoot;
  delete environment.TAURI_BUNDLER_DMG_IGNORE_CI;
}

const tauri = Bun.spawn(
  [
    "tauri",
    "build",
    "--config",
    "src-tauri/tauri.desktop.conf.json",
    ...Bun.argv.slice(2)
  ],
  {
    cwd: projectRoot,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  }
);

process.exit(await tauri.exited);
