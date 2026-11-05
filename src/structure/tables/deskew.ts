import type { DocIndex } from '../../lib/docIndex'
import { union } from '../../lib/geometry'
import type { BBox, Line, Word } from '../../model/types'
import { median } from './rows'

/**
 * Scans are often a little rotated (0.3–1.5°). Across a 500pt table that moves the right end of a
 * row by several points against the left end, as much as a row is tall, so the cells of one row
 * stop overlapping vertically. The slope of the text is measured from the words of the page's
 * longer lines (each line's words sit on one baseline); the table layer then works on a view of
 * the document where every box is moved back by that slope. Evidence is still built from the
 * original words.
 */

/** dy/dx of the text lines on a page; 0 when the page is upright or there is too little text. */
export function pageSkew(index: DocIndex, page: number): number {
  const slopes: number[] = []
  for (const line of index.pageLines.get(page) ?? []) {
    const ws = line.wordIds.map((id) => index.word.get(id)!)
    if (ws.length < 3) continue
    const xs = ws.map((w) => (w.bbox.x0 + w.bbox.x1) / 2)
    const ys = ws.map((w) => (w.bbox.y0 + w.bbox.y1) / 2)
    if (Math.max(...xs) - Math.min(...xs) < 60) continue
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let cov = 0
    let vx = 0
    xs.forEach((x, i) => {
      cov += (x - mx) * (ys[i] - my)
      vx += (x - mx) ** 2
    })
    if (vx > 0) slopes.push(cov / vx)
  }
  if (slopes.length < 3) return 0
  const s = median(slopes)
  return Math.abs(s) < 0.003 || Math.abs(s) > 0.05 ? 0 : s
}

const shear = (b: BBox, s: number, cx: number): BBox => {
  const dy = -s * ((b.x0 + b.x1) / 2 - cx)
  return { x0: b.x0, y0: b.y0 + dy, x1: b.x1, y1: b.y1 + dy }
}

/**
 * The index with every scanned page's boxes un-skewed (the same object when nothing is skewed).
 * Only pages read by OCR are measured: embedded text is never rotated within a page.
 */
export function deskewIndex(index: DocIndex): DocIndex {
  const skews = new Map<number, number>()
  for (const p of index.doc.pages) {
    if (p.source !== 'ocr') continue
    const s = pageSkew(index, p.number)
    if (s) skews.set(p.number, s)
  }
  if (!skews.size) return index
  const centre = new Map(index.doc.pages.map((p) => [p.number, p.width / 2]))
  const word = new Map<string, Word>()
  for (const [id, w] of index.word) {
    const s = skews.get(w.page)
    word.set(id, s ? { ...w, bbox: shear(w.bbox, s, centre.get(w.page)!) } : w)
  }
  const line = new Map<string, Line>()
  const pageLines = new Map<number, Line[]>()
  for (const [n, lines] of index.pageLines) {
    pageLines.set(
      n,
      lines.map((l) => {
        const moved = skews.has(n) && l.wordIds.length ? { ...l, bbox: union(l.wordIds.map((id) => word.get(id)!.bbox)) } : l
        line.set(l.id, moved)
        return moved
      }),
    )
  }
  return { doc: index.doc, word, line, block: index.block, pageLines }
}
