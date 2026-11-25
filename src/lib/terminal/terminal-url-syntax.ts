export const WEB_SCHEME = /^https?:\/\//i;
export const isUrlListDelimiter = (char: string): boolean => char === "," || char === ";";

/** Classify a web scheme at a hard pane edge, given the visible outer URL prefix. */
export function paneSchemeOwner(prefix: string, nextRow: string): "outer" | "separate" | "unknown" {
  const query = prefix.indexOf("?");
  const pathBoundary = /[/=]$/.test(prefix) ? "unknown" : "separate";
  if (query < 0 || prefix.includes("#")) return pathBoundary;
  const field = prefix.slice(Math.max(query, prefix.lastIndexOf("&")) + 1);
  const equals = field.indexOf("=");
  if (equals <= 0) return pathBoundary;
  const value = field.slice(equals + 1);
  if (value && !/(?:%20|\+)$/i.test(value)) return pathBoundary;
  // An empty URI-valued field needs corroboration from a subsequent outer
  // field, not the following scheme's own query string.
  return /(?:^|%20|\+)https?:\/\//i.test(value) || /^(?:[^?#&]*(?:%20|\+)https?:\/\/|[^?#]*&[\w~.-]+=)/i.test(nextRow)
    ? "outer" : "unknown";
}
