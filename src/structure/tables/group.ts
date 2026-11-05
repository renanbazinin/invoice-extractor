import type { BBox, TableRowKind } from '../../model/types'
import { median } from './rows'

/**
 * Which item each text-only row belongs to. A description that runs over several lines prints
 * its extra lines under the first one (most tables), above the numbers (till receipts print the
 * name, then "2 x 9.90  19.80"), or around numbers centred in a tall cell. The rule is proximity:
 * - a text row that overlaps an item row vertically is part of it;
 * - a text row right above an item that has no description of its own is that item's name;
 * - a text row close under an item (or under one of its extra lines) continues it;
 * - anything else is not part of an item (a section heading, a note).
 */

export interface GroupRow {
  kind: TableRowKind
  page: number
  bbox: BBox
  /** The row has its own description text (not just numbers or "2 x 9.90"). */
  hasDescription: boolean
}

export interface Attachment {
  /** Index of the text row. */
  row: number
  /** Index of the item row it belongs to, or -1. */
  item: number
}

const h = (b: BBox): number => b.y1 - b.y0
const vOverlap = (a: BBox, b: BBox): number => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)

/** Attaches every 'continuation' row to an item row (or to none). */
export function attachContinuations(rows: readonly GroupRow[]): Attachment[] {
  const lineH = median(rows.map((r) => h(r.bbox))) || 10
  const owner = new Array<number>(rows.length).fill(-1)
  rows.forEach((r, i) => {
    if (r.kind === 'item') owner[i] = i
  })
  const nearestItem = (i: number, step: 1 | -1): number => {
    for (let j = i + step; j >= 0 && j < rows.length; j += step) {
      if (rows[j].page !== rows[i].page) return -1
      if (rows[j].kind === 'item') return j
      if (rows[j].kind === 'summary' || rows[j].kind === 'header') return -1
    }
    return -1
  }
  const out: Attachment[] = []
  // First pass: rows overlapping an item, and names printed above description-less items.
  const pending: number[] = []
  rows.forEach((r, i) => {
    if (r.kind !== 'continuation') return
    const prev = nearestItem(i, -1)
    const next = nearestItem(i, 1)
    const ovPrev = prev >= 0 ? vOverlap(r.bbox, rows[prev].bbox) : -Infinity
    const ovNext = next >= 0 ? vOverlap(r.bbox, rows[next].bbox) : -Infinity
    if (ovPrev > 0 || ovNext > 0) {
      owner[i] = ovPrev >= ovNext ? prev : next
      return
    }
    const nextGap = next >= 0 ? rows[next].bbox.y0 - r.bbox.y1 : Infinity
    const prevGap = prev >= 0 ? r.bbox.y0 - rows[prev].bbox.y1 : Infinity
    if (next >= 0 && !rows[next].hasDescription && nextGap <= 1.2 * lineH && nextGap <= prevGap + 0.5 * lineH) {
      owner[i] = next
      return
    }
    pending.push(i)
  })
  // Second pass, top to bottom: rows close under their item or under an attached line.
  for (const i of pending) {
    const above = i - 1
    if (above < 0 || rows[above].page !== rows[i].page || owner[above] < 0) continue
    // The row right above must be the owner (or one of its lines) and close.
    if (rows[i].bbox.y0 - rows[above].bbox.y1 <= 0.9 * lineH) owner[i] = owner[above]
  }
  // Third pass, bottom to top: numbers printed on the last line of a description (bottom-aligned
  // cells) leave the first lines tight above their item and far from the item before.
  for (const i of [...pending].reverse()) {
    if (owner[i] >= 0) continue
    const below = i + 1
    if (below >= rows.length || rows[below].page !== rows[i].page || owner[below] < 0) continue
    const gapBelow = rows[below].bbox.y0 - rows[i].bbox.y1
    const gapAbove = i > 0 && rows[i - 1].page === rows[i].page ? rows[i].bbox.y0 - rows[i - 1].bbox.y1 : Infinity
    if (gapBelow <= 0.35 * lineH && gapAbove > 0.9 * lineH) owner[i] = owner[below]
  }
  rows.forEach((r, i) => {
    if (r.kind === 'continuation') out.push({ row: i, item: owner[i] })
  })
  return out
}
