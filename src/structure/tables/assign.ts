import type { BBox } from '../../model/types'

/** A column's horizontal extent. */
export interface Span1d {
  x0: number
  x1: number
}

/** Horizontal distance between a box and a column (0 when they overlap). */
export function gapTo(b: Span1d, col: Span1d): number {
  return Math.max(0, Math.max(b.x0, col.x0) - Math.min(b.x1, col.x1))
}

export const centre = (s: Span1d): number => (s.x0 + s.x1) / 2

export interface AssignOptions {
  /** Cost of leaving a cell out of the table (it lies beyond every column). */
  skipCost: number
  /** Extra cost of putting two neighbouring cells into one column. */
  shareCost: number
  /** Extra cost of a cell in a column, e.g. text in a numbers column (default 0). */
  mismatch?: (cell: number, col: number) => number
}

/**
 * Maps the cells of one row (left to right) to columns (left to right) so that the order is kept
 * (no two cells cross) and the total distance is smallest. Order matters more than distance:
 * numbers right-aligned under a centred title, or a description that starts left of its title,
 * are still matched to the right column because their neighbours take the other columns. A cell
 * far beyond every column is left out (-1). Returns one column index per cell.
 */
export function assignCells(cells: readonly BBox[], cols: readonly Span1d[], opts: AssignOptions): number[] {
  const m = cells.length
  const n = cols.length
  if (!m) return []
  if (!n) return cells.map(() => -1)
  // dp[i][j + 1]: best cost for cells[0..i) with the last used column j (j = -1: none yet).
  const INF = Number.POSITIVE_INFINITY
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(INF))
  const from: { prev: number; col: number }[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(null))
  dp[0][0] = 0
  const cost = (i: number, j: number): number =>
    gapTo(cells[i], cols[j]) + 0.05 * Math.abs(centre(cells[i]) - centre(cols[j])) + (opts.mismatch?.(i, j) ?? 0)
  for (let i = 0; i < m; i++) {
    for (let last = -1; last < n; last++) {
      const base = dp[i][last + 1]
      if (base === INF) continue
      // Leave the cell out.
      if (base + opts.skipCost < dp[i + 1][last + 1]) {
        dp[i + 1][last + 1] = base + opts.skipCost
        from[i + 1][last + 1] = { prev: last, col: -1 }
      }
      for (let j = Math.max(0, last); j < n; j++) {
        const c = base + cost(i, j) + (j === last ? opts.shareCost : 0)
        if (c < dp[i + 1][j + 1]) {
          dp[i + 1][j + 1] = c
          from[i + 1][j + 1] = { prev: last, col: j }
        }
      }
    }
  }
  let bestLast = -1
  for (let j = -1; j < n; j++) if (dp[m][j + 1] < dp[m][bestLast + 1]) bestLast = j
  const out = new Array<number>(m).fill(-1)
  let last = bestLast
  for (let i = m; i > 0; i--) {
    const step = from[i][last + 1]
    out[i - 1] = step.col
    last = step.prev
  }
  return out
}
