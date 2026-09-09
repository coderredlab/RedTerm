// @ts-nocheck
import { expect, test } from 'bun:test';
import { paneZoneFromPoint, insertionIndexFromPoint } from './pane-drop';

test('pane center merges and edges split relative to each pane', () => {
  const rect = { left: 100, top: 200, width: 800, height: 400 };
  expect(paneZoneFromPoint(rect, 500, 400)).toBe('merge');
  expect(paneZoneFromPoint(rect, 105, 400)).toBe('left');
  expect(paneZoneFromPoint(rect, 895, 400)).toBe('right');
  expect(paneZoneFromPoint(rect, 500, 205)).toBe('top');
  expect(paneZoneFromPoint(rect, 500, 595)).toBe('bottom');
  expect(paneZoneFromPoint(rect, 99, 400)).toBeNull();
  expect(paneZoneFromPoint({ ...rect, width: 0 }, 100, 400)).toBeNull();
});

test('header insertion uses tab midpoints, including scrolled tabs', () => {
  const rects = [{ left: -60, width: 100 }, { left: 40, width: 100 }, { left: 140, width: 100 }];
  expect(insertionIndexFromPoint(rects, 0)).toBe(1);
  expect(insertionIndexFromPoint(rects, 100)).toBe(2);
  expect(insertionIndexFromPoint(rects, 300)).toBe(3);
});
