import type { BBox } from '../model/types'

export function union(boxes: readonly BBox[]): BBox {
  if (!boxes.length) throw new Error('union of no boxes')
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0)
    y0 = Math.min(y0, b.y0)
    x1 = Math.max(x1, b.x1)
    y1 = Math.max(y1, b.y1)
  }
  return { x0, y0, x1, y1 }
}

export const width = (b: BBox): number => b.x1 - b.x0
export const height = (b: BBox): number => b.y1 - b.y0
export const centerX = (b: BBox): number => (b.x0 + b.x1) / 2
export const centerY = (b: BBox): number => (b.y0 + b.y1) / 2

/** Length of the overlap of two intervals (0 when apart). */
export function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/** Horizontal overlap as a share of the narrower box (0..1). */
export function xOverlapRatio(a: BBox, b: BBox): number {
  const o = overlap1d(a.x0, a.x1, b.x0, b.x1)
  const w = Math.min(width(a), width(b))
  return w > 0 ? o / w : 0
}

/** Vertical overlap as a share of the shorter box (0..1). */
export function yOverlapRatio(a: BBox, b: BBox): number {
  const o = overlap1d(a.y0, a.y1, b.y0, b.y1)
  const h = Math.min(height(a), height(b))
  return h > 0 ? o / h : 0
}

/** Horizontal gap between two boxes (0 when they overlap horizontally). */
export function xGap(a: BBox, b: BBox): number {
  return Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1))
}

/** Vertical gap between two boxes (0 when they overlap vertically). */
export function yGap(a: BBox, b: BBox): number {
  return Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1))
}

export function contains(outer: BBox, inner: BBox, slack = 0): boolean {
  return inner.x0 >= outer.x0 - slack && inner.x1 <= outer.x1 + slack && inner.y0 >= outer.y0 - slack && inner.y1 <= outer.y1 + slack
}
