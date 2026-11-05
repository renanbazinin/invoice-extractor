import type { Line } from '../model/types'
import { findAmounts, findDates, findPhones, parseEmail } from '../semantic'
import type { DocIndex } from './evidence'

/**
 * Whether a text value goes on below its last line: "Payment within 15 days" | "of invoice date"
 * wraps in a narrow value column, and the first line alone is a complete-looking but cut value.
 * A verified text value must be whole, so a likely continuation blocks verification.
 *
 * The next line continues the value when it is the next line of the same block, tightly below
 * (wrapped leading, not a paragraph gap), aligned on the reading-start edge, has no label of its
 * own (no colon, nothing on its row on the label's side, as the next pair of a grid has), and is
 * not a value of its own (a date, an amount, a phone, an e-mail, like the next stacked value).
 */
export function continuationBelow(doc: DocIndex, valueWordIds: Iterable<string>, labelWordIds: Iterable<string> = []): Line | null {
  const lines = linesOf(doc, valueWordIds)
  if (!lines.length) return null
  const last = lines.reduce((a, b) => (b.bbox.y1 > a.bbox.y1 ? b : a))
  const next = doc
    .linesOfBlock(last.blockId)
    .filter((l) => !lines.includes(l) && l.bbox.y0 >= last.bbox.y1 - 1)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0)[0]
  if (!next) return null
  const h = last.bbox.y1 - last.bbox.y0
  if (next.bbox.y0 - last.bbox.y1 > 0.8 * h) return null
  const rtl = last.dir === 'rtl'
  if (Math.abs(rtl ? next.bbox.x1 - last.bbox.x1 : next.bbox.x0 - last.bbox.x0) > 3) return null
  // Text wraps when it reaches the column's far edge. A value line that stops short of a wider line
  // of its block had room to go on, so the line below is something else (a note, the next pair).
  const block = doc.block(last.blockId)?.bbox
  if (block) {
    const short = rtl ? last.bbox.x0 - block.x0 : block.x1 - last.bbox.x1
    if (short > Math.max(6, 0.06 * (block.x1 - block.x0))) return null
  }
  if (/[:：]/.test(next.text)) return null
  if (findDates(next.text).length || findAmounts(next.text).length || findPhones(next.text).length || parseEmail(next.text)) return null
  // A grid's next pair has its own label on its row, in the label column (the label's block).
  const columns = linesOf(doc, labelWordIds)
    .filter((l) => !lines.includes(l))
    .map((l) => doc.block(l.blockId)?.bbox ?? l.bbox)
  const inLabelColumn = (l: Line) => columns.some((c) => Math.min(l.bbox.x1, c.x1) - Math.max(l.bbox.x0, c.x0) > 0)
  const rowMate = doc.pageLines(next.page).some((l) => l !== next && !lines.includes(l) && sameRow(l, next) && inLabelColumn(l))
  return rowMate ? null : next
}

function linesOf(doc: DocIndex, wordIds: Iterable<string>): Line[] {
  const out: Line[] = []
  for (const id of wordIds) {
    const line = doc.lineOfWord(id)
    if (line && !out.includes(line)) out.push(line)
  }
  return out
}

function sameRow(a: Line, b: Line): boolean {
  const overlap = Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0)
  const h = Math.min(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0)
  return h > 0 && overlap / h >= 0.5
}
