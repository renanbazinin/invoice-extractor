import { xOverlapRatio } from '../../lib/geometry'
import { expectedKinds, findAmounts, parseAmount } from '../../semantic'
import { readingSide, sameRow, sideGap, type LineInfo } from './lineInfo'
import { looksLikeTerms } from './terms'

/**
 * Pairs across lines: 'grid' (label and value on the same visual row, the value on the label's
 * reading side) and 'below' (the value on the line under the label, aligned with it). Both work
 * on whole lines: the reader already split a row at its wide gaps, so a label cell and a value
 * cell are separate lines.
 */

export interface LinePair {
  label: LineInfo
  value: LineInfo
  layout: 'grid' | 'below'
  score: number
}

/** Concepts whose whole-line match is never a label waiting for a value elsewhere. */
const NOT_A_LABEL = new Set(['trap.copy_mark', 'trap.blessing', 'role.software', 'trap.page_number'])

/** A line that can be the label of a grid or below pair. */
export function canLabel(a: LineInfo): boolean {
  if (a.labelScore < 0.4) return false
  // A title or a copy mark alone is not a label ("חשבונית מס", "מקור"); with a number sign it is
  // one ("מס' חשבון תקופתי").
  const only = a.label.matches.every((m) => m.kind === 'doctype' || NOT_A_LABEL.has(m.concept))
  if (a.label.primary && only && !a.label.colon) return false
  return true
}

/** Lexicon words that are values of terms labels ("מזומן", "שוטף", "Net"), not labels. */
const VALUE_WORDS = new Set(['payment_terms', 'other.payment_method'])
const TERMS_LABELS = new Set(['payment_terms', 'due_date', 'other.payment_method'])

/** `b` is a terms word answering a terms label ("מועד תשלום" → "מזומן"). */
export function valueWord(a: LineInfo, b: LineInfo): boolean {
  const ac = a.label.primary?.concept
  const bc = b.label.primary?.concept
  if (!ac || !TERMS_LABELS.has(ac) || b.label.colon) return false
  return (!!bc && VALUE_WORDS.has(bc)) || looksLikeTerms(b.line.text)
}

/** Strong enough as a label that whatever it faces on its row is not its value. */
function isStrongLabel(b: LineInfo): boolean {
  return b.labelScore >= 0.75
}

/** The label names an amount (totals rows can carry other figures before the amount). */
export function expectsAmount(a: LineInfo): boolean {
  const p = a.label.primary
  if (!p) return false
  if (expectedKinds(p.concept)[0] === 'amount') return true
  return p.also.some((c) => expectedKinds(c)[0] === 'amount')
}

/**
 * Other strong labels aligned with this one at the reading-start edge (a label column), so an
 * unknown text in that column is a label too ("Gültig bis" under "Datum", "Zahlbar bis").
 */
export function inLabelColumn(a: LineInfo, page: readonly LineInfo[]): boolean {
  const edge = (l: LineInfo) => (a.dir === 'rtl' ? l.bbox.x1 : l.bbox.x0)
  const aligned = page.filter(
    (b) => b !== a && b.labelScore >= 0.75 && Math.abs(edge(b) - edge(a)) <= 4 && Math.abs(b.cy - a.cy) <= 8 * Math.max(a.h, b.h),
  )
  // One aligned heading ("CUSTOMER" over a name) is not a column of labels; one aligned label
  // with its own value beside it is (a two-row meta grid).
  if (aligned.length >= 2) return true
  return aligned.some((b) => gridLabel(b, page))
}

/**
 * A speck next to a label: a one-character line in much smaller type (an OCR'd border tick or a
 * stray mark), never a value.
 */
export function speck(v: LineInfo, label: LineInfo): boolean {
  const compact = v.line.text.replace(/\s/g, '')
  if (compact.length > 2) return false
  const tiny = v.bbox.x1 - v.bbox.x0 < 2 || (label.fontSize > 0 && v.fontSize < 0.6 * label.fontSize)
  return tiny || !/[\p{L}\p{N}]/u.test(compact)
}

function amountQuality(l: LineInfo): number {
  const p = parseAmount(l.line.text)
  if (!p) return 0
  return (p.decimals === 2 ? 2 : p.decimals ? 1 : 0.5) + (p.currency ? 0.5 : 0)
}

/**
 * The value of a label on its own row: the nearest line on the reading side, unless a strong
 * label comes first. A row that continues with more values after it is a table row: only an
 * amount label (a totals/summary row) keeps a value there, the best amount of the row.
 */
export function gridPartner(a: LineInfo, page: readonly LineInfo[], fallback = false): LinePair | null {
  const primary = readingSide(a.dir)
  const side = fallback ? (primary === 'left' ? 'right' : 'left') : primary
  const row = page
    .filter((b) => b !== a && sameRow(a, b))
    .map((b) => ({ b, gap: sideGap(a.bbox, b.bbox, side) }))
    .filter((x): x is { b: LineInfo; gap: number } => x.gap !== null)
    .sort((x, y) => x.gap - y.gap)
  const values: { b: LineInfo; gap: number }[] = []
  for (const x of row) {
    const word = valueWord(a, x.b)
    if (!word && (isStrongLabel(x.b) || x.b.label.colon || (values.length && x.b.labelScore >= 0.55))) break
    if ((!word && x.b.valueScore < 0.3) || speck(x.b, a)) continue
    if (values.length && x.b.labelScore >= 0.4) continue
    values.push(x)
  }
  if (!values.length) return null
  const known = !!a.label.primary || a.label.columnOnly
  // Text right under a heading ("Emisor" over "Ortega Partners S.A.") is the heading's content.
  const supported = known || a.label.colon || (inLabelColumn(a, page) && !underHeading(a, page))
  if (!supported) return null
  const first = values[0]!
  // An unknown, colon-less label needs a value with digits (or a label column behind it).
  if (!known && !a.label.colon && !/\d/.test(first.b.line.text) && !inLabelColumn(a, page)) return null
  // Words of one heading the reader split at a wide word space ("נמלית" "שילוח" in display type).
  if (!known && !a.label.colon && first.gap <= 1.5 * a.fontSize && Math.abs(a.fontSize - first.b.fontSize) < 0.5 && !/\d/.test(first.b.line.text)) return null
  let chosen = first
  let tabular = false
  // One more value further away than the label is from its own value is the next column's
  // (side-by-side party boxes), not the rest of a table row.
  const nextColumn =
    (values.length === 2 && values[1]!.gap - (values[0]!.b.bbox.x1 - values[0]!.b.bbox.x0) - first.gap > first.gap) ||
    // A label column facing a column of values (a meta grid) ends at that value column: what
    // follows on the row is the next box (the addressee beside the invoice details).
    (!expectsAmount(a) && metaGrid(a, first.b, page))
  if (values.length > 1 && !nextColumn) {
    tabular = true
    if (!expectsAmount(a)) return null
    const best = [...values].sort((x, y) => amountQuality(y.b) - amountQuality(x.b) || y.gap - x.gap)[0]!
    if (amountQuality(best.b) === 0) return null
    chosen = best
  }
  let score = known && a.label.exact ? 0.85 : a.label.colon ? 0.78 : known ? 0.7 : 0.6
  if (tabular) score -= 0.15
  if (chosen.gap > 260) score -= 0.1
  if (fallback) score -= 0.25
  return { label: a, value: chosen.b, layout: 'grid', score: Math.max(0.05, Math.round(score * 100) / 100) }
}

/**
 * The label is one of a column of strong labels and its value one of a column of values: at least
 * two other rows of the label column hold a value aligned with this one (same reading-start edge).
 */
export function metaGrid(a: LineInfo, v: LineInfo, page: readonly LineInfo[]): boolean {
  const edge = (l: LineInfo) => (a.dir === 'rtl' ? l.bbox.x1 : l.bbox.x0)
  const vEdges = (l: LineInfo) => [l.bbox.x0, l.bbox.x1]
  const labels = page.filter((b) => b !== a && b.labelScore >= 0.75 && Math.abs(edge(b) - edge(a)) <= 4 && Math.abs(b.cy - a.cy) <= 8 * Math.max(a.h, b.h))
  let rows = 0
  for (const b of labels) {
    const mate = page.some(
      (x) => x !== b && x !== v && sameRow(b, x) && x.valueScore >= 0.5 && x.labelScore < 0.4 && vEdges(x).some((e, i) => Math.abs(e - vEdges(v)[i]!) <= 4),
    )
    if (mate) rows++
  }
  return rows >= 2
}

/** The aligned line right above is a strong label with nothing beside it: a section heading. */
export function underHeading(a: LineInfo, page: readonly LineInfo[]): boolean {
  const near = (upper: LineInfo, lower: LineInfo) => upper.bbox.y1 <= lower.bbox.y0 + 0.3 * a.h && lower.bbox.y0 - upper.bbox.y1 <= 1.6 * a.h
  const above = page.filter((b) => b !== a && near(b, a) && verticallyAligned(b, a)).sort((x, y) => y.bbox.y1 - x.bbox.y1)[0]
  if (!above || above.labelScore < 0.75 || gridLabel(above, page)) return false
  // A label column starting under the heading ("פרטי הספק" / "שם החברה" / "כתובת" …) is labels.
  const below = page.filter((b) => b !== a && near(a, b) && verticallyAligned(a, b)).sort((x, y) => x.bbox.y0 - y.bbox.y0)[0]
  return !(below && below.labelScore >= 0.75 && gridLabel(below, page))
}

/**
 * A label with a value beside it on its row: the nearest line on its reading side is a value. A
 * value further along, behind other labels ("SUPPLIER   CUSTOMER   Date of issue  2026-10-12"),
 * belongs to one of those, so a row of side-by-side headings does not count.
 */
function gridLabel(l: LineInfo, page: readonly LineInfo[]): boolean {
  const side = readingSide(l.dir)
  const nearest = page
    .filter((v) => v !== l && sameRow(l, v))
    .map((v) => ({ v, gap: sideGap(l.bbox, v.bbox, side) }))
    .filter((x): x is { v: LineInfo; gap: number } => x.gap !== null)
    .sort((x, y) => x.gap - y.gap)[0]
  return !!nearest && nearest.v.valueScore >= 0.5 && nearest.v.labelScore < 0.4
}

/** Horizontally aligned enough for a label above its value. */
export function verticallyAligned(a: LineInfo, b: LineInfo): boolean {
  if (xOverlapRatio(a.bbox, b.bbox) >= 0.5) return true
  if (a.dir === 'rtl' && Math.abs(a.bbox.x1 - b.bbox.x1) <= 4) return true
  if (a.dir === 'ltr' && Math.abs(a.bbox.x0 - b.bbox.x0) <= 4) return true
  return Math.abs((a.bbox.x0 + a.bbox.x1) / 2 - (b.bbox.x0 + b.bbox.x1) / 2) <= 6
}

/** The nearest aligned line under `a`, within a tight vertical gap. */
export function lineBelow(a: LineInfo, page: readonly LineInfo[], maxGap?: number): { b: LineInfo; gap: number } | null {
  const limit = maxGap ?? Math.max(1.9 * a.h, 12)
  let best: { b: LineInfo; gap: number } | null = null
  for (const b of page) {
    if (b === a || b.bbox.y0 < a.bbox.y1 - 0.3 * a.h) continue
    if (sameRow(a, b)) continue
    const gap = b.bbox.y0 - a.bbox.y1
    if (gap > limit) continue
    if (!verticallyAligned(a, b)) continue
    if (!best || gap < best.gap) best = { b, gap }
  }
  return best
}

/**
 * The value under a known label in a strip of cells, aligned with the other edge of its cell (a
 * Hebrew label at the cell's right and a number printed left-to-right at its left): the nearest
 * line under the label that lies inside the label's cell, which ends at the next line on the
 * label's row in its reading direction.
 */
export function cellBelow(a: LineInfo, page: readonly LineInfo[]): { b: LineInfo; gap: number } | null {
  if (a.labelScore < 0.75 || !a.label.primary) return null
  const rtl = a.dir === 'rtl'
  const row = page.filter((x) => x !== a && sameRow(a, x))
  // The last cell of a strip has no neighbour: a cell a few label widths wide.
  const reach = Math.max(3 * (a.bbox.x1 - a.bbox.x0), 100)
  const left = row.filter((x) => x.bbox.x1 <= a.bbox.x0 + 2).map((x) => x.bbox.x1)
  const right = row.filter((x) => x.bbox.x0 >= a.bbox.x1 - 2).map((x) => x.bbox.x0)
  const bound = rtl ? (left.length ? Math.max(...left) : a.bbox.x0 - reach) : right.length ? Math.min(...right) : a.bbox.x1 + reach
  const limit = Math.max(1.9 * a.h, 12)
  let best: { b: LineInfo; gap: number } | null = null
  for (const b of page) {
    if (b === a || sameRow(a, b) || b.bbox.y0 < a.bbox.y1 - 0.3 * a.h) continue
    const gap = b.bbox.y0 - a.bbox.y1
    if (gap > limit) continue
    const inside = rtl ? b.bbox.x1 <= a.bbox.x1 + 2 && b.bbox.x0 >= bound - 2 : b.bbox.x0 >= a.bbox.x0 - 2 && b.bbox.x1 <= bound + 2
    if (!inside) continue
    if (!best || gap < best.gap) best = { b, gap }
  }
  return best
}

/** Column headers that only head an item table (description, quantity, unit price). */
const ITEM_HEADERS = new Set(['col.description', 'col.quantity', 'col.unit_price', 'col.line_number', 'col.sku', 'col.unit'])

/** The label's row is an item-table header: whatever is under it is a table row, not a value. */
export function inItemHeaderRow(a: LineInfo, page: readonly LineInfo[]): boolean {
  const isHeader = (l: LineInfo) => {
    const m = l.matches[0]
    return !!m && m.kind === 'column' && ITEM_HEADERS.has(m.concept) && (l.label.exact || l.label.columnOnly)
  }
  if (isHeader(a)) return true
  return page.filter((b) => b !== a && sameRow(a, b) && isHeader(b)).length >= 1
}

/**
 * The value under a label (cards, label strips, boxed grids). Rejected when the value line is
 * the first of a column of values (a table column under its header).
 */
export function belowPartner(a: LineInfo, page: readonly LineInfo[]): LinePair | null {
  const below = lineBelow(a, page) ?? cellBelow(a, page)
  if (!below) return null
  const b = below.b
  if (!valueWord(a, b) && (isStrongLabel(b) || b.label.colon || b.valueScore < 0.3)) return null
  // An amount label over a text without a figure ("סה"כ שולם" over "תודה על שיתוף הפעולה!", a
  // paragraph of fine print).
  if (expectsAmount(a) && amountQuality(b) === 0 && !findAmounts(b.line.text).some((x) => x.decimals === 2 || !!x.currency)) return null
  // A line of a label column is a label, not the value of the heading above it ("פרטי הספק" over
  // "שם החברה").
  if (b.labelScore >= 0.4 && inLabelColumn(b, page)) return null
  if (inItemHeaderRow(a, page)) return null
  const row = page.filter((x) => x !== a && sameRow(a, x))
  // A label followed on its row by values is a cell of a data row (a payment method, a description).
  if (valuesBeside(a, row) >= 2) return null
  const known = !!a.label.primary || a.label.columnOnly
  const contrast = a.fontSize > 0 && b.fontSize > 0 && (a.fontSize < 0.92 * b.fontSize || (!a.bold && b.bold))
  // A strip of labels over a row of values (totals bars, meta strips) vouches for its unknown members.
  const strip = row.filter((x) => x.labelScore >= 0.75 && (lineBelow(x, page)?.b.valueScore ?? 0) >= 0.5).length >= 2
  if (!known && !a.label.colon && !contrast && !strip) return null
  // A second value under the first one, spaced alike: a table column, not a key/value.
  const next = lineBelow(b, page, below.gap + Math.max(6, 0.6 * b.h))
  if (next && next.b.valueScore >= 0.5 && !isStrongLabel(next.b) && !next.b.label.colon && Math.abs(next.gap - below.gap) <= 6) return null
  if (tableUnder([a, ...row.filter((x) => x.labelScore >= 0.4)], b, below.gap, page)) return null
  let score = known && (a.label.exact || a.label.columnOnly) ? 0.8 : a.label.colon ? 0.72 : known ? 0.65 : 0.55
  if (contrast) score += 0.05
  return { label: a, value: b, layout: 'below', score: Math.round(score * 100) / 100 }
}

/** Values that follow a line on its reading side before any label: the rest of a data row. */
export function valuesBeside(a: LineInfo, row: readonly LineInfo[]): number {
  const side = readingSide(a.dir)
  const ordered = row
    .map((b) => ({ b, gap: sideGap(a.bbox, b.bbox, side) }))
    .filter((x): x is { b: LineInfo; gap: number } => x.gap !== null)
    .sort((x, y) => x.gap - y.gap)
  let n = 0
  for (const { b } of ordered) {
    if (b.labelScore >= 0.4 || b.label.colon) break
    if (b.valueScore >= 0.5) n++
  }
  return n
}

/**
 * A header row with at least two rows of values under it is a table: the row after the first
 * value row has two or more values aligned under the headers. A strip of labels over a single
 * row of values (meta strips, totals bars, cards) is not.
 */
export function tableUnder(headers: readonly LineInfo[], first: LineInfo, gap: number, page: readonly LineInfo[]): boolean {
  const firstRow = page.filter((x) => x === first || sameRow(first, x))
  const bottom = Math.max(...firstRow.map((x) => x.bbox.y1))
  const limit = gap + Math.max(8, first.h)
  const next = page
    .filter((x) => x.bbox.y0 >= bottom - 0.3 * x.h && x.bbox.y0 - bottom <= limit && !firstRow.includes(x))
    .sort((x, y) => x.bbox.y0 - y.bbox.y0)[0]
  if (!next) return false
  const nextRow = page.filter((x) => x === next || sameRow(next, x))
  const aligned = nextRow.filter((x) => x.valueScore >= 0.5 && x.labelScore < 0.75 && headers.some((h) => verticallyAligned(h, x)))
  return aligned.length >= 2
}
