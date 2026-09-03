// @ts-nocheck
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EXPLORER_SORT,
  normalizeExplorerSort,
  sortExplorerEntries,
} from "./explorer-sort";
import type { SftpDirEntry } from "$lib/tauri/commands";

function entry(name: string, isDir: boolean, mtime: number): SftpDirEntry {
  return { name, is_dir: isDir, size: 1, mtime };
}

const FIXTURE: SftpDirEntry[] = [
  entry("zeta.txt", false, 300),
  entry("beta", true, 100),
  entry("Alpha.txt", false, 200),
  entry("gamma.md", false, 200),
];

describe("sortExplorerEntries", () => {
  test("defaults sort directories first then names case-insensitively", () => {
    const sorted = sortExplorerEntries(FIXTURE, DEFAULT_EXPLORER_SORT);
    expect(sorted.map((item) => item.name)).toEqual(["beta", "Alpha.txt", "gamma.md", "zeta.txt"]);
  });

  test("name descending flips file order but keeps directories first", () => {
    const sorted = sortExplorerEntries(FIXTURE, { key: "name", direction: "desc" });
    expect(sorted.map((item) => item.name)).toEqual(["beta", "zeta.txt", "gamma.md", "Alpha.txt"]);
  });

  test("date ascending lists oldest first with name tie-break", () => {
    const sorted = sortExplorerEntries(FIXTURE, { key: "date", direction: "asc" });
    expect(sorted.map((item) => item.name)).toEqual(["beta", "Alpha.txt", "gamma.md", "zeta.txt"]);
  });

  test("date descending lists newest first", () => {
    const sorted = sortExplorerEntries(FIXTURE, { key: "date", direction: "desc" });
    expect(sorted.map((item) => item.name)).toEqual(["beta", "zeta.txt", "Alpha.txt", "gamma.md"]);
  });

  test("normalize falls back to defaults for invalid or missing values", () => {
    expect(normalizeExplorerSort(undefined)).toEqual(DEFAULT_EXPLORER_SORT);
    expect(normalizeExplorerSort({ key: "size", direction: "sideways" })).toEqual(
      DEFAULT_EXPLORER_SORT
    );
    expect(normalizeExplorerSort({ key: "date", direction: "desc" })).toEqual({
      key: "date",
      direction: "desc",
    });
  });
});
