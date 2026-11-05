/**
 * Lines → blocks in reading order, by recursive XY-cut.
 *
 * A region is split where a whitespace channel crosses it completely: a vertical channel makes
 * columns (two side-by-side address boxes, a label column beside a value column), a horizontal
 * one separates stacked regions. Ruling lines that cross the whole region (box edges, table
 * borders, a separator under the header) are cuts even when the whitespace around them is thin.
 * Children of a vertical cut are read right-to-left when the region's text is right-to-left
 * (else the page's direction decides).
 *
 * XY-cut has no page-specific knowledge, so it holds for unfamiliar layouts; its known blind
 * spot is a line glued to the top or bottom of two columns (a title too close to them), which
 * `peel` handles by cutting off up to three bands to expose the columns.
 */
import type { BBox, Direction } from '../model/types'
import { union } from '../lib/geometry'
import type { Rule } from './model'

export interface LineBox {
  bbox: BBox
  fontSize: number
}

/** Minimum whitespace (em) of a vertical channel that makes columns. */
export const COLUMN_GAP_EM = 1.0
/** Minimum whitespace (em) between stacked regions; paragraph leading stays below it. */
export const BLOCK_GAP_EM = 0.8

interface Cut {
  axis: 'x' | 'y'
  /** Coordinate of the cut. */
  at: number
  gap: number
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/** Gaps between the merged projections of boxes on one axis: [end of one band, start of next]. */
function gaps(boxes: readonly BBox[], axis: 'x' | 'y'): [number, number][] {
  const iv = boxes.map((b) => (axis === 'x' ? [b.x0, b.x1] : [b.y0, b.y1])).sort((p, q) => p[0] - q[0])
  const out: [number, number][] = []
  let end = iv[0][1]
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] > end) out.push([end, iv[i][0]])
    end = Math.max(end, iv[i][1])
  }
  return out
}

/** A ruling line inside gap [g0, g1] on `axis` that spans most of the region across. */
function ruleInGap(rules: readonly Rule[], axis: 'x' | 'y', g0: number, g1: number, region: BBox): boolean {
  for (const r of rules) {
    if (axis === 'y' && r.axis === 'h') {
      const y = (r.y0 + r.y1) / 2
      const span = Math.min(r.x1, region.x1) - Math.max(r.x0, region.x0)
      if (y >= g0 - 1 && y <= g1 + 1 && span >= 0.6 * (region.x1 - region.x0)) return true
    } else if (axis === 'x' && r.axis === 'v') {
      const x = (r.x0 + r.x1) / 2
      const span = Math.min(r.y1, region.y1) - Math.max(r.y0, region.y0)
      if (x >= g0 - 1 && x <= g1 + 1 && span >= 0.8 * (region.y1 - region.y0)) return true
    }
  }
  return false
}

function bestCut(boxes: readonly BBox[], em: number, rules: readonly Rule[]): Cut | null {
  const region = union([...boxes])
  const ys = gaps(boxes, 'y')
  const xs = gaps(boxes, 'x')
  const widest = (gs: [number, number][], axis: 'x' | 'y'): Cut | null => {
    let best: Cut | null = null
    for (const [g0, g1] of gs) if (!best || g1 - g0 > best.gap) best = { axis, at: (g0 + g1) / 2, gap: g1 - g0 }
    return best
  }
  const ruledY = widest(ys.filter(([g0, g1]) => ruleInGap(rules, 'y', g0, g1, region)), 'y')
  if (ruledY) return ruledY
  const ruledX = widest(xs.filter(([g0, g1]) => ruleInGap(rules, 'x', g0, g1, region)), 'x')
  if (ruledX) return ruledX
  const x = widest(xs, 'x')
  const y = widest(ys, 'y')
  // Horizontal bands first (a table, then the totals under it), columns inside each band: true
  // columns have no whitespace band crossing both of them.
  if (y && y.gap >= BLOCK_GAP_EM * em) return y
  // Columns are side by side. When the two sides of the widest vertical channel are stacked
  // (a totals box at the left, then notes at the right a little lower), the region is read
  // top to bottom: cut horizontally between them instead, however thin the gap.
  if (x && x.gap >= COLUMN_GAP_EM * em) return sideBySide(boxes, x.at) || !y ? x : y
  return null
}

/** Whether the boxes left and right of `at` share a good part of their vertical extent. */
function sideBySide(boxes: readonly BBox[], at: number): boolean {
  const left = boxes.filter((b) => b.x1 <= at)
  const right = boxes.filter((b) => b.x1 > at)
  if (!left.length || !right.length) return true
  const l = union([...left])
  const r = union([...right])
  const ov = Math.min(l.y1, r.y1) - Math.max(l.y0, r.y0)
  return ov >= 0.3 * Math.min(l.y1 - l.y0, r.y1 - r.y0)
}

/**
 * When no cut crosses the region, try cutting off up to three bands at the top or bottom (a
 * title or a footer line touching two columns) if the rest then splits into columns.
 */
function peel(boxes: readonly BBox[], em: number): Cut | null {
  const ys = gaps(boxes, 'y').sort((p, q) => p[0] - q[0])
  const candidates = [...ys.slice(0, 3), ...ys.slice(-3).reverse()]
  for (const [g0, g1] of candidates) {
    const at = (g0 + g1) / 2
    for (const side of [boxes.filter((b) => b.y0 > at), boxes.filter((b) => b.y1 < at)]) {
      if (side.length < 2) continue
      const xs = gaps(side, 'x')
      if (xs.some(([a, b]) => b - a >= COLUMN_GAP_EM * em)) return { axis: 'y', at, gap: g1 - g0 }
    }
  }
  return null
}

/**
 * Splits lines into blocks; returns the blocks in reading order, lines top-down inside.
 * `regionDir` gives the clear script direction of some lines, or null when they have none.
 */
export function segmentBlocks<T extends LineBox>(
  lines: readonly T[],
  dir: Direction,
  rules: readonly Rule[] = [],
  regionDir: (lines: readonly T[]) => Direction | null = () => null,
): T[][] {
  const out: T[][] = []
  const visit = (items: readonly T[], depth: number): void => {
    if (items.length <= 1 || depth > 60) {
      if (items.length) out.push(orderInBlock(items, dir, regionDir))
      return
    }
    const em = median(items.map((l) => l.fontSize)) || 10
    const boxes = items.map((l) => l.bbox)
    const cut = bestCut(boxes, em, rules) ?? peel(boxes, em)
    if (!cut) {
      out.push(orderInBlock(items, dir, regionDir))
      return
    }
    const before = items.filter((l) => (cut.axis === 'x' ? l.bbox.x1 : l.bbox.y1) <= cut.at)
    const after = items.filter((l) => (cut.axis === 'x' ? l.bbox.x1 : l.bbox.y1) > cut.at)
    if (!before.length || !after.length) {
      out.push(orderInBlock(items, dir, regionDir))
      return
    }
    const parts = cut.axis === 'x' && (regionDir(items) ?? dir) === 'rtl' ? [after, before] : [before, after]
    for (const p of parts) visit(p, depth + 1)
  }
  visit(lines, 0)
  return out
}

/**
 * Lines of one block: top-down; lines sharing a row (a block can keep a label and a nearby
 * value apart as two lines) are read in the row's own direction when its text has a clear one,
 * else the page's: "Total:  100.00" on a Hebrew page still reads label first.
 */
export function orderInBlock<T extends LineBox>(lines: readonly T[], dir: Direction, regionDir: (lines: readonly T[]) => Direction | null = () => null): T[] {
  const sorted = [...lines].sort((a, b) => a.bbox.y0 + a.bbox.y1 - (b.bbox.y0 + b.bbox.y1))
  const rows: T[][] = []
  for (const l of sorted) {
    const row = rows[rows.length - 1]
    const ref = row?.[0]
    const h = ref ? Math.min(ref.bbox.y1 - ref.bbox.y0, l.bbox.y1 - l.bbox.y0) : 0
    const sameRow = ref && Math.abs((ref.bbox.y0 + ref.bbox.y1) / 2 - (l.bbox.y0 + l.bbox.y1) / 2) < 0.5 * h
    if (sameRow) row.push(l)
    else rows.push([l])
  }
  return rows.flatMap((r) => {
    const rowDir = r.length > 1 ? (regionDir(r) ?? dir) : dir
    return r.sort((a, b) => (rowDir === 'rtl' ? b.bbox.x1 - a.bbox.x1 : a.bbox.x0 - b.bbox.x0))
  })
}
