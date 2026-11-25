export function isUsableMonospace(
  context: Pick<CanvasRenderingContext2D, "font" | "measureText">,
  family: string,
): boolean {
  const escaped = family.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const font = `16px "${escaped}", `;
  context.font = font + "serif";
  const narrow = context.measureText("iiiiiiii").width;
  const wide = context.measureText("MMMMMMMM").width;
  if (Math.abs(narrow - wide) >= 0.5) return false;

  // Missing faces or glyphs follow the fallback; an actual face keeps its widths.
  context.font = font + "monospace";
  return narrow === context.measureText("iiiiiiii").width &&
    wide === context.measureText("MMMMMMMM").width;
}
