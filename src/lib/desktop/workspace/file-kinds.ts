export type FilePreviewKind =
  | "markdown"
  | "code"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "unknown";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "flac",
  "m4a",
  "aac",
  "opus",
]);

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mkv",
  "mov",
  "m4v",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "conf",
  "ini",
  "cfg",
  "env",
  "toml",
  "properties",
  "csv",
  "tsv",
]);

/** highlight.js language ids for extensions we can highlight. */
const CODE_EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  tsx: "typescript",
  rs: "rust",
  py: "python",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  html: "xml",
  htm: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  lua: "lua",
  pl: "perl",
  r: "r",
  dart: "dart",
  vue: "xml",
  proto: "protobuf",
};

const SPECIAL_TEXT_NAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".editorconfig": "ini",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  m4v: "video/mp4",
};

export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function previewKindOf(name: string): FilePreviewKind {
  const lower = name.toLowerCase();
  if (SPECIAL_TEXT_NAMES[lower] !== undefined) return "code";
  const ext = extensionOf(name);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (ext in CODE_EXTENSIONS) return "code";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (lower.startsWith("license") || lower.startsWith("readme")) return "text";
  return "unknown";
}

export function highlightLanguageOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (SPECIAL_TEXT_NAMES[lower] !== undefined) return SPECIAL_TEXT_NAMES[lower];
  const ext = extensionOf(name);
  return CODE_EXTENSIONS[ext] ?? null;
}

export function mimeOf(name: string): string {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? "application/octet-stream";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** Compact format — long locale dates squeeze the file name column. */
export function formatTimestamp(mtime: number): string {
  if (!mtime) return "";
  const date = new Date(mtime * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const base = `${month}-${day} ${hours}:${minutes}`;
  const year = date.getFullYear();
  return year === new Date().getFullYear() ? base : `${year}-${base}`;
}
