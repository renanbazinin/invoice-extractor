import type { DocIndex } from '../../lib/docIndex'
import { centerY, height, union } from '../../lib/geometry'
import type { BBox, Direction, Line, Word } from '../../model/types'
import { parseEmail, type LabelMatch } from '../../semantic'
import { matchLabelsPlus } from './lexicon'
import { methodValue } from './inline'
import { analyzeLabel, labelLineScore, ocrRepair, type LabelAnalysis } from './labels'
import { looksLikeTerms } from './terms'

/** A line plus everything pairing needs to know about it, computed once. */
export interface LineInfo {
  line: Line
  words: Word[]
  page: number
  bbox: BBox
  /** Height of the text (largest word box), the unit for every vertical tolerance. */
  h: number
  cy: number
  dir: Direction
  fontSize: number
  bold: boolean
  /** Lexicon matches over the whole line text. */
  matches: LabelMatch[]
  /** The whole line as a label. */
  label: LabelAnalysis
  /** How much the whole line reads as a label whose value is elsewhere (0..1). */
  labelScore: number
  /** How much the whole line reads as a value (0..1). */
  valueScore: number
}

/** True when the text holds nothing but filler (signature lines, dots, dashes). */
function blank(text: string): boolean {
  return !/[\p{L}\p{N}@]/u.test(text)
}

/**
 * Value likeness of a whole line: numbers, dates, ids, e-mails and URLs are values; plain text
 * (a name, an address, "שוטף + 30") is a possible value; a known label or a colon-ended text is not.
 */
export function valueScoreOf(text: string, label: LabelAnalysis, labelScore: number): number {
  if (blank(text)) return 0
  if (/[:：]\s*$/.test(text)) return 0.05
  if (labelScore >= 0.8) return 0.1
  // Words with a rate ("הנחת מסמך 3%", "VAT 18%") label a figure; a lone "18%" is one.
  if (/\p{L}{2,}/u.test(text) && !label.digits && /%/.test(text)) return 0.25
  if (/\d/.test(text)) return 0.9
  if (parseEmail(text) || /(?:https?:\/\/|www\.)\S+/i.test(text)) return 0.9
  if (label.primary && label.exact) return 0.2
  return 0.6
}

export function buildLineInfo(index: DocIndex, line: Line): LineInfo {
  const words = line.wordIds.map((id) => index.word.get(id)!).filter(Boolean)
  // OCR text gets its abbreviation marks repaired for matching (same length, same offsets).
  const ocr = words.some((w) => w.source === 'ocr')
  const matches = matchLabelsPlus(ocr ? ocrRepair(line.text) : line.text)
  const label = analyzeLabel(line.text, matches)
  const ls = labelLineScore(label)
  return {
    line,
    words,
    page: line.page,
    bbox: line.bbox,
    h: Math.max(1, ...words.map((w) => height(w.bbox))),
    cy: centerY(line.bbox),
    dir: line.dir,
    fontSize: Math.max(0, ...words.map((w) => w.fontSize)),
    bold: words.length > 0 && words.every((w) => w.bold),
    matches,
    label,
    labelScore: ls,
    valueScore: valueScoreOf(line.text, label, ls),
  }
}

/**
 * Labels wrapped over two or three lines of a narrow label column ("Total / before / VAT:",
 * "סה"כ אחרי / הנחה:"): consecutive lines of one block, aligned at the reading-start edge, tightly
 * spaced, where only the last one ends with the label's colon. They are read as one label line
 * whose box spans them, so its value (centred on the whole label) pairs with all of it.
 */
export function mergeWrappedLabels(index: DocIndex, infos: readonly LineInfo[]): LineInfo[] {
  const out: LineInfo[] = []
  const used = new Set<LineInfo>()
  const byY = [...infos].sort((a, b) => a.bbox.y0 - b.bbox.y0)
  for (const first of byY) {
    if (used.has(first)) continue
    if (first.label.colon || first.label.digits || !/\p{L}/u.test(first.line.text)) continue
    const group = [first]
    let cur = first
    // One alignment for the whole label, the first line's (a stacked English line under a Hebrew
    // one is right-aligned with it).
    const edge = (l: LineInfo) => (first.dir === 'rtl' ? l.bbox.x1 : l.bbox.x0)
    for (let k = 0; k < 2; k++) {
      const next = byY.find(
        (b) =>
          !used.has(b) &&
          b !== cur &&
          b.line.blockId === cur.line.blockId &&
          b.bbox.y0 > cur.bbox.y0 + 0.5 * cur.h &&
          b.bbox.y0 - cur.bbox.y1 < 0.6 * cur.h &&
          Math.abs(edge(b) - edge(cur)) <= 3,
      )
      if (!next || next.label.digits || !/\p{L}|%/u.test(next.line.text)) break
      group.push(next)
      cur = next
      if (next.label.colon) break
    }
    if (group.length < 2 || !group[group.length - 1]!.label.colon) continue
    const wordIds = group.flatMap((g) => g.line.wordIds)
    const line: Line = {
      ...first.line,
      id: `${first.line.id}+${group.length - 1}`,
      wordIds,
      text: group.map((g) => g.line.text).join(' '),
      bbox: union(group.map((g) => g.bbox)),
    }
    for (const g of group) used.add(g)
    out.push(buildLineInfo(index, line))
  }
  return [...infos.filter((i) => !used.has(i)), ...out]
}

/**
 * Bilingual labels stacked in one cell ("חשבונית מס מס'" over "INVOICE NO.", "תאריך" over "DATE"):
 * a Hebrew label line and a Latin one right under it (or above it), aligned at one edge, tightly
 * spaced, naming the same thing. They are one label, in the direction of the first line, so the
 * value of the cell pairs with both.
 */
export function mergeBilingualLabels(index: DocIndex, infos: readonly LineInfo[]): LineInfo[] {
  const out: LineInfo[] = []
  const used = new Set<LineInfo>()
  const byY = [...infos].sort((a, b) => a.bbox.y0 - b.bbox.y0)
  const hebrew = (l: LineInfo) => /[א-ת]/.test(l.line.text) && !/[a-z]{2}/i.test(l.line.text)
  const latin = (l: LineInfo) => /[a-z]{2}/i.test(l.line.text) && !/[א-ת]/.test(l.line.text)
  const sameThing = (a: LineInfo, b: LineInfo) => {
    const fa = new Set(a.label.matches.flatMap((m) => [m.concept, ...m.also]))
    return b.label.matches.some((m) => fa.has(m.concept) || m.also.some((c) => fa.has(c)))
  }
  // A line with its value beside it on its row ("מספר חשבונית  98688" over "Invoice #") keeps it.
  const besideValue = (l: LineInfo) => {
    const side = readingSide(l.dir)
    const nearest = infos
      .filter((v) => v !== l && sameRow(l, v) && sideGap(l.bbox, v.bbox, side) !== null)
      .sort((x, y) => (sideGap(l.bbox, x.bbox, side) ?? 0) - (sideGap(l.bbox, y.bbox, side) ?? 0))[0]
    if (!nearest) return false
    // A terms word answers a terms label ("תנאים  מזומן").
    const word = looksLikeTerms(nearest.line.text) || (!!nearest.label.primary && methodValue(nearest.label.primary))
    return word || (nearest.valueScore >= 0.5 && nearest.labelScore < 0.4)
  }
  for (const first of byY) {
    if (used.has(first) || first.labelScore < 0.75 || first.label.digits || besideValue(first)) continue
    const second = byY.find(
      (b) =>
        !used.has(b) &&
        b !== first &&
        b.labelScore >= 0.75 &&
        !b.label.digits &&
        ((hebrew(first) && latin(b)) || (latin(first) && hebrew(b))) &&
        b.bbox.y0 > first.bbox.y0 + 0.5 * first.h &&
        b.bbox.y0 - first.bbox.y1 < 0.6 * first.h &&
        (Math.abs(b.bbox.x1 - first.bbox.x1) <= 3 || Math.abs(b.bbox.x0 - first.bbox.x0) <= 3) &&
        !besideValue(b) &&
        sameThing(first, b),
    )
    if (!second) continue
    const line: Line = {
      ...first.line,
      id: `${first.line.id}+b`,
      wordIds: [...first.line.wordIds, ...second.line.wordIds],
      text: `${first.line.text} / ${second.line.text}`,
      bbox: union([first.bbox, second.bbox]),
    }
    used.add(first)
    used.add(second)
    out.push(buildLineInfo(index, line))
  }
  return [...infos.filter((i) => !used.has(i)), ...out]
}

/**
 * Values wrapped over two lines of a grid cell ("חשמל ותאורה חרמון / בע"מ", "רח' ויצמן 130, חיפה /
 * 3374183"): consecutive lines of one block, aligned at the reading-start edge and tightly spaced,
 * with a label beside them whose centre falls between the two lines (the label is centred on the
 * whole cell). They are read as one value line.
 */
export function mergeWrappedValues(index: DocIndex, infos: readonly LineInfo[]): LineInfo[] {
  const out: LineInfo[] = []
  const used = new Set<LineInfo>()
  const byY = [...infos].sort((a, b) => a.bbox.y0 - b.bbox.y0)
  for (const first of byY) {
    if (used.has(first) || first.labelScore >= 0.75 || first.label.colon || first.valueScore < 0.5) continue
    const edge = (l: LineInfo) => (first.dir === 'rtl' ? l.bbox.x1 : l.bbox.x0)
    const second = byY.find(
      (b) =>
        !used.has(b) &&
        b !== first &&
        b.line.blockId === first.line.blockId &&
        b.bbox.y0 > first.bbox.y0 + 0.5 * first.h &&
        b.bbox.y0 - first.bbox.y1 < 0.6 * first.h &&
        Math.abs(edge(b) - edge(first)) <= 3,
    )
    if (!second || second.labelScore >= 0.75 || second.label.colon || second.valueScore < 0.5) continue
    const lo = first.cy + 0.25 * first.h
    const hi = second.cy - 0.25 * second.h
    const box = union([first.bbox, second.bbox])
    // A known label, or an unknown one standing in a column of known labels ("שם החברה" over
    // "כתובת"); not just any short text (an address line of the next box).
    const label = infos.find(
      (l) =>
        l !== first &&
        l !== second &&
        (l.labelScore >= 0.55 || (l.labelScore >= 0.4 && besideLabels(l, infos))) &&
        l.cy > lo &&
        l.cy < hi &&
        sideGap(l.bbox, box, readingSide(l.dir)) !== null,
    )
    if (!label) continue
    // Each line facing a label of its own on its row is that label's value (a value column).
    const ownLabel = (v: LineInfo) => infos.some((l) => l !== label && l.labelScore >= 0.75 && sameRow(l, v) && sideGap(l.bbox, v.bbox, readingSide(l.dir)) !== null)
    if (ownLabel(first) && ownLabel(second)) continue
    const line: Line = { ...first.line, id: `${first.line.id}+v`, wordIds: [...first.line.wordIds, ...second.line.wordIds], text: `${first.line.text} ${second.line.text}`, bbox: box }
    used.add(first)
    used.add(second)
    out.push(buildLineInfo(index, line))
  }
  return [...infos.filter((i) => !used.has(i)), ...out]
}

/** A known label is aligned with this line at the reading-start edge, a few lines away. */
function besideLabels(l: LineInfo, infos: readonly LineInfo[]): boolean {
  const edge = (x: LineInfo) => (l.dir === 'rtl' ? x.bbox.x1 : x.bbox.x0)
  return infos.some((b) => b !== l && b.labelScore >= 0.75 && Math.abs(edge(b) - edge(l)) <= 4 && Math.abs(b.cy - l.cy) <= 8 * Math.max(l.h, b.h))
}

/** Two lines sit on the same visual row: their vertical centres are within half a line height. */
export function sameRow(a: LineInfo, b: LineInfo): boolean {
  if (a.page !== b.page) return false
  const tol = 0.55 * Math.max(a.h, b.h)
  return Math.abs(a.cy - b.cy) <= tol
}

/**
 * Where a label's value sits on its row: left of the label in a right-to-left line, right of it
 * in a left-to-right one (the reading-order side).
 */
export function readingSide(dir: Direction): 'left' | 'right' {
  return dir === 'rtl' ? 'left' : 'right'
}

/** Horizontal distance from a label to a line on the given side, or null when it is not on it. */
export function sideGap(label: BBox, other: BBox, side: 'left' | 'right'): number | null {
  if (side === 'left') return other.x1 <= label.x0 + 2 ? label.x0 - other.x1 : null
  return other.x0 >= label.x1 - 2 ? other.x0 - label.x1 : null
}
