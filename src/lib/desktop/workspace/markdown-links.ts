import { validateTerminalUrl } from "$lib/terminal/terminal-links";

export type MarkdownLinkDecision =
  | { action: "anchor" }
  | { action: "open-external"; url: string }
  | { action: "blocked" };

/**
 * In-document anchors are safe; only validated http(s) targets may leave the
 * sanitized markdown preview. Everything else is blocked so the addressless
 * webview can never navigate to attacker-chosen destinations. The returned
 * url is the validated, normalized form — pass that to the opener, not the
 * raw href (opener permission patterns are case-sensitive).
 */
export function classifyMarkdownLink(href: string): MarkdownLinkDecision {
  if (href.startsWith("#")) return { action: "anchor" };
  const safe = validateTerminalUrl(href);
  return safe ? { action: "open-external", url: safe.url } : { action: "blocked" };
}
