import type { SftpDirEntry } from "$lib/tauri/commands";

export interface ExplorerSort {
  key: "name" | "date";
  direction: "asc" | "desc";
}

export const DEFAULT_EXPLORER_SORT: ExplorerSort = { key: "name", direction: "asc" };

export function normalizeExplorerSort(value: unknown): ExplorerSort {
  if (typeof value !== "object" || value === null) return DEFAULT_EXPLORER_SORT;
  const candidate = value as Partial<ExplorerSort>;
  return {
    key: candidate.key === "date" ? "date" : "name",
    direction: candidate.direction === "desc" ? "desc" : "asc",
  };
}

function compareNames(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

/** Directories always list first, then entries by the chosen key and direction. */
export function sortExplorerEntries(
  entries: SftpDirEntry[],
  sort: ExplorerSort
): SftpDirEntry[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    if (sort.key === "date") {
      if (a.mtime !== b.mtime) return sign * (a.mtime - b.mtime);
      return compareNames(a.name, b.name);
    }
    const byName = compareNames(a.name, b.name);
    if (byName !== 0) return sign * byName;
    return sign * (a.mtime - b.mtime);
  });
}
