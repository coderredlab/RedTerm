export type DropZone = "left" | "right" | "top" | "bottom";
export type DragKind = "tab" | "pane";

/**
 * Shared mutable drag state for tab-strip and pane drags. Pointer events are
 * tracked by the component that started the drag; the workspace overlay and
 * ghost read from here.
 */
export const tabDrag = $state({
  active: false,
  kind: "tab" as DragKind,
  tabId: null as string | null,
  paneId: null as string | null,
  title: "",
  pointerX: 0,
  pointerY: 0,
  overTabStrip: false,
  insertIndex: null as number | null,
  dropZone: null as DropZone | null,
});

/** Workspace element registered by DesktopApp for drop hit-testing. */
export const dragTargets = {
  workspace: null as HTMLElement | null,
};

export function resetTabDrag() {
  tabDrag.active = false;
  tabDrag.kind = "tab";
  tabDrag.tabId = null;
  tabDrag.paneId = null;
  tabDrag.title = "";
  tabDrag.pointerX = 0;
  tabDrag.pointerY = 0;
  tabDrag.overTabStrip = false;
  tabDrag.insertIndex = null;
  tabDrag.dropZone = null;
}

export function zoneFromPoint(
  rect: DOMRect,
  x: number,
  y: number
): DropZone | null {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    return null;
  }
  const distances: Array<[DropZone, number]> = [
    ["left", x - rect.left],
    ["right", rect.right - x],
    ["top", y - rect.top],
    ["bottom", rect.bottom - y],
  ];
  let best: [DropZone, number] = distances[0]!;
  for (const candidate of distances) {
    if (candidate[1] < best[1]) best = candidate;
  }
  return best[0];
}
