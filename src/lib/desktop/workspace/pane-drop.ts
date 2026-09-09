export type PaneDropZone = 'left' | 'right' | 'top' | 'bottom' | 'merge';

export interface PaneDropTarget {
  tabId: string;
  paneId: string;
  zone: PaneDropZone;
  /** Gap in the target's terminal tabs, before removing the dragged tab. */
  insertIndex: number | null;
}

export function paneZoneFromPoint(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  x: number,
  y: number,
): PaneDropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const horizontal = (x - rect.left) / rect.width;
  const vertical = (y - rect.top) / rect.height;
  if (horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1) return null;
  if (horizontal >= 0.25 && horizontal <= 0.75 && vertical >= 0.25 && vertical <= 0.75) return 'merge';
  const distances: Array<[PaneDropZone, number]> = [
    ['left', horizontal], ['right', 1 - horizontal], ['top', vertical], ['bottom', 1 - vertical],
  ];
  return distances.reduce((best, next) => next[1] < best[1] ? next : best)[0];
}

export function insertionIndexFromPoint(rects: Array<Pick<DOMRect, 'left' | 'width'>>, x: number): number {
  return rects.filter((rect) => x > rect.left + rect.width / 2).length;
}
