import type { DocIndex } from '../../lib/docIndex'
import { union } from '../../lib/geometry'
import type { BBox, Line } from '../../model/types'
import { parseQxP } from './values'

/**
 * Visual rows and cells. The reader ends a line at every wide gap and ruling, so one table row is
 * several lines at the same height. Here they are put back together: a visual row is the set of
 * lines whose vertical extents overlap, and each of its lines is a cell (left to right). A cell
 * can be narrower than a line when a line straddles two columns and has to be cut (splitCell).
 */

export interface Cell {
  page: number
  lineId: string
  /** Word ids in logical (reading) order. */
  wordIds: string[]
  /** The words joined with single spaces, in logical order. */
  text: string
  bbox: BBox
}

export interface VisualRow {
  page: number
  /** Left to right by x0. */
  cells: Cell[]
  bbox: BBox
}

export function cellOfWords(index: DocIndex, lineId: string, wordIds: readonly string[]): Cell {
  const words = wordIds.map((id) => index.word.get(id)!)
  return {
    page: words[0].page,
    lineId,
    wordIds: [...wordIds],
    text: words.map((w) => w.text).join(' '),
    bbox: union(words.map((w) => w.bbox)),
  }
}

export function cellOfLine(index: DocIndex, line: Line): Cell {
  return cellOfWords(index, line.id, line.wordIds)
}

export function rowOfCells(cells: readonly Cell[]): VisualRow {
  const sorted = [...cells].sort((a, b) => a.bbox.x0 - b.bbox.x0)
  return { page: sorted[0].page, cells: sorted, bbox: union(sorted.map((c) => c.bbox)) }
}

const height = (b: BBox): number => b.y1 - b.y0

/**
 * Groups the lines of one page into visual rows. A line joins the row above when it overlaps the
 * row's vertical band by at least half of the shorter of the two, so a row of 10pt cells next to a
 * 12pt amount stays one row, while a description's second line (which only touches the first) and
 * a number centred between two description lines start rows of their own; the table layer decides
 * where those belong.
 */
export function visualRows(index: DocIndex, page: number): VisualRow[] {
  const lines = [...(index.pageLines.get(page) ?? [])].filter((l) => l.wordIds.length).sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  const groups: { band: BBox; lines: Line[] }[] = []
  for (const line of lines) {
    const h = height(line.bbox)
    let target: { band: BBox; lines: Line[] } | null = null
    // Look back over the last few rows: lines are sorted by top edge, so a short line can start
    // below a tall neighbour's top and still belong to its row.
    for (let i = groups.length - 1; i >= Math.max(0, groups.length - 3); i--) {
      const g = groups[i]
      const ov = Math.min(g.band.y1, line.bbox.y1) - Math.max(g.band.y0, line.bbox.y0)
      if (ov > 0.5 * Math.min(h, height(g.band))) {
        target = g
        break
      }
    }
    if (target) {
      target.lines.push(line)
      target.band = union([target.band, line.bbox])
    } else groups.push({ band: { ...line.bbox }, lines: [line] })
  }
  return groups
    .map((g) => g.lines.flatMap((l) => cellsOfLine(index, l)))
    .filter((cells) => cells.length > 0)
    .map((cells) => rowOfCells(glueQxP(index, cells)))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0)
}

const RTL_LETTER = /[\u0590-\u05FF\u0600-\u06FF]/

/**
 * "41.20 L @ 7.15" printed with wide, justified spaces comes out of the reader as four lines
 * ("41.20", "L", "@", "7.15"), and on a right-to-left page their joined logical text is reversed.
 * Neighbouring pieces without right-to-left letters that together read, left to right, as
 * "quantity × price" are one cell; its words keep the visual order, which is the logical order
 * of a left-to-right run of numbers.
 */
export function glueQxP(index: DocIndex, cells: readonly Cell[]): Cell[] {
  const sorted = [...cells].sort((a, b) => a.bbox.x0 - b.bbox.x0)
  const out: Cell[] = []
  for (let i = 0; i < sorted.length; i++) {
    let best = -1
    for (let j = i + 1; j < sorted.length && j <= i + 4; j++) {
      const piece = sorted[j]
      const gap = piece.bbox.x0 - sorted[j - 1].bbox.x1
      if (gap > 2.5 * height(piece.bbox) || RTL_LETTER.test(piece.text) || piece.wordIds.length > 3) break
      if (RTL_LETTER.test(sorted[i].text) || sorted[i].wordIds.length > 3) break
      const words = sorted.slice(i, j + 1).flatMap((c) => c.wordIds.map((id) => index.word.get(id)!))
      words.sort((a, b) => a.bbox.x0 - b.bbox.x0)
      if (parseQxP(words.map((w) => w.text).join(' '))) best = j
    }
    if (best < 0) {
      out.push(sorted[i])
      continue
    }
    const words = sorted.slice(i, best + 1).flatMap((c) => c.wordIds.map((id) => index.word.get(id)!))
    words.sort((a, b) => a.bbox.x0 - b.bbox.x0)
    out.push(cellOfWords(index, sorted[i].lineId, words.map((w) => w.id)))
    i = best
  }
  return out
}

/** A ruling line that OCR read as a character. */
const RULE = /^[|¦│┃]+$/

/**
 * The cells of one line: the whole line, or its pieces between ruling characters when a scan
 * read the table's vertical lines as "|" words ("5 | מ"ר" is two cells).
 */
function cellsOfLine(index: DocIndex, line: Line): Cell[] {
  if (!line.wordIds.some((id) => RULE.test(index.word.get(id)!.text))) return [cellOfLine(index, line)]
  const out: Cell[] = []
  let run: string[] = []
  for (const id of line.wordIds) {
    if (RULE.test(index.word.get(id)!.text)) {
      if (run.length) out.push(cellOfWords(index, line.id, run))
      run = []
    } else run.push(id)
  }
  if (run.length) out.push(cellOfWords(index, line.id, run))
  return out
}

/** Median of some numbers (0 for none). */
export function median(xs: readonly number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Typical text height of some cells. */
export function lineHeight(cells: readonly Cell[]): number {
  return median(cells.map((c) => height(c.bbox))) || 10
}

/**
 * Cuts a cell into pieces at the given x boundaries (ascending), by each word's centre, keeping
 * the logical order of the words inside each piece. Used when a reader line straddles columns
 * (tight tables, OCR).
 */
export function splitCell(index: DocIndex, cell: Cell, boundaries: readonly number[]): Cell[] {
  const groups = new Map<number, string[]>()
  for (const id of cell.wordIds) {
    const b = index.word.get(id)!.bbox
    const cx = (b.x0 + b.x1) / 2
    let k = 0
    while (k < boundaries.length && cx > boundaries[k]) k++
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(id)
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => cellOfWords(index, cell.lineId, ids))
}

/** Character offsets of each word of a cell inside `cell.text`. */
export function wordOffsets(index: DocIndex, cell: Cell): { id: string; start: number; end: number }[] {
  let pos = 0
  return cell.wordIds.map((id) => {
    const w = index.word.get(id)!
    const r = { id, start: pos, end: pos + w.text.length }
    pos = r.end + 1
    return r
  })
}

/** Word ids of a cell whose text covers [start, end) of `cell.text`. */
export function wordsInCellSpan(index: DocIndex, cell: Cell, start: number, end: number): string[] {
  return wordOffsets(index, cell)
    .filter((w) => w.end > start && w.start < end)
    .map((w) => w.id)
}
