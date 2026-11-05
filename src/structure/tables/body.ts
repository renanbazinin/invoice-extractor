import type { DocIndex } from '../../lib/docIndex'
import { add, dec, eq, fromInt, type Dec } from '../../lib/decimal'
import { parseAmount, type NumberFormat } from '../../semantic'
import { assignCells, type Span1d } from './assign'
import { NUMERIC_CONCEPTS, TEXT_CONCEPTS, type ColumnDraft, type RowDraft, type TableDraft } from './draft'
import { readHeader } from './header'
import { looksLikePayment, rowLabel } from './labels'
import { cellOfWords, median, splitCell, type Cell, type VisualRow } from './rows'
import { cellKind, isNumericKind, type CellKind } from './values'

/**
 * The body of a table under a known set of columns: rows are read one by one until the table
 * ends (a totals block, a wide gap, content that does not fit the columns, another header or the
 * end of the page). Every row gets a kind: item, continuation (text only, inside the text
 * columns; settled later by proximity), summary (the totals under the table), other (page totals,
 * carried-forward figures, headings).
 */

export interface BodyContext {
  index: DocIndex
  fmt: NumberFormat
}

export interface PlacedRow {
  /** Cells per column. */
  cells: Cell[][]
  /** Cells beyond every column. */
  outside: Cell[]
}

const isNumericColumn = (c: ColumnDraft): boolean => c.concept === null || NUMERIC_CONCEPTS.has(c.concept)
const isTextColumn = (c: ColumnDraft): boolean => c.concept !== null && TEXT_CONCEPTS.has(c.concept)

/**
 * Cuts a cell that straddles several columns into per-column pieces when the pieces are values of
 * their own: two numbers (a tight row such as "2 40.90" read as one line), or a number and its
 * unit under separate titles. A long description that runs under a neighbouring title stays whole.
 */
function splitStraddling(ctx: BodyContext, cell: Cell, columns: readonly ColumnDraft[]): Cell[] {
  if (cell.wordIds.length < 2) return [cell]
  const hit = columns.filter((c) => Math.min(c.x1, cell.bbox.x1) - Math.max(c.x0, cell.bbox.x0) > 2)
  if (hit.length < 2) return [cell]
  const boundaries: number[] = []
  for (let k = 0; k + 1 < columns.length; k++) boundaries.push((columns[k].x1 + columns[k + 1].x0) / 2)
  const pieces = splitCell(ctx.index, cell, boundaries)
  if (pieces.length < 2) return [cell]
  const numeric = pieces.filter((p) => isNumericKind(cellKind(p.text, ctx.fmt))).length
  if (numeric >= 2) return pieces
  // "2.50 שעה" under "כמות | יח'": a number and its unit, each under its own title. Never cut
  // text that reaches into the description column.
  const touchesDescription = hit.some((c) => c.concept === 'col.description')
  if (numeric >= 1 && !touchesDescription) return pieces
  // "40-1180 Bürodrehstuhl …": an article code under the code title run into the description
  // under its own title. Cut only when every piece is the kind of value its column holds.
  return codeAndText(ctx, pieces, columns, boundaries) ? pieces : [cell]
}

/** Every piece is a code under a code/line-number title or text under the description title. */
function codeAndText(ctx: BodyContext, pieces: readonly Cell[], columns: readonly ColumnDraft[], boundaries: readonly number[]): boolean {
  let codes = 0
  let texts = 0
  for (const p of pieces) {
    const cx = (p.bbox.x0 + p.bbox.x1) / 2
    let k = 0
    while (k < boundaries.length && cx > boundaries[k]) k++
    const concept = columns[k].concept
    const kind = cellKind(p.text, ctx.fmt)
    if (kind === 'code' && (concept === 'col.sku' || concept === 'col.line_number')) codes++
    else if (kind === 'text' && concept === 'col.description') texts++
    else return false
  }
  return codes >= 1 && texts >= 1
}

/**
 * A currency sign or a lone symbol printed apart from its number ("₪" … "81.80") is one value with
 * it: glued to the nearest cell when they are close (within two text heights).
 */
function glueSymbols(ctx: BodyContext, cells: Cell[], lineH: number): Cell[] {
  if (cells.length < 2) return cells
  const out = [...cells].sort((a, b) => a.bbox.x0 - b.bbox.x0)
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (cellKind(c.text, ctx.fmt) !== 'symbol' || out.length < 2) continue
    const left = out[i - 1]
    const right = out[i + 1]
    const gl = left ? c.bbox.x0 - left.bbox.x1 : Infinity
    const gr = right ? right.bbox.x0 - c.bbox.x1 : Infinity
    const j = gl <= gr ? i - 1 : i + 1
    if (Math.min(gl, gr) > 2 * lineH) continue
    const other = out[j]
    const merged = cellOfWords(ctx.index, other.lineId, j < i ? [...other.wordIds, ...c.wordIds] : [...c.wordIds, ...other.wordIds])
    out.splice(Math.min(i, j), 2, merged)
    i = Math.max(-1, Math.min(i, j) - 1)
  }
  return out
}

/** A cell of the side box beside the table: mostly inside its extent and under no column. */
function inAside(c: Cell, columns: readonly ColumnDraft[], aside: readonly Span1d[]): boolean {
  if (!aside.length) return false
  const w = Math.max(1, c.bbox.x1 - c.bbox.x0)
  if (columns.some((col) => Math.min(col.x1, c.bbox.x1) - Math.max(col.x0, c.bbox.x0) > 0)) return false
  return aside.some((a) => Math.min(a.x1, c.bbox.x1) - Math.max(a.x0, c.bbox.x0) >= 0.5 * Math.min(w, a.x1 - a.x0))
}

/**
 * Places a row's cells into the columns (order-preserving, see assignCells). Words in a numbers
 * column and numbers in the description column cost extra, so a lone description line goes to
 * the description column even when a narrow neighbouring title is closer.
 */
export function placeRow(ctx: BodyContext, row: VisualRow, columns: readonly ColumnDraft[], lineH: number, aside: readonly Span1d[] = []): PlacedRow {
  const own = row.cells.filter((c) => !inAside(c, columns, aside))
  const pieces = glueSymbols(ctx, own.flatMap((c) => splitStraddling(ctx, c, columns)), lineH)
  const kinds = pieces.map((p) => cellKind(p.text, ctx.fmt))
  const mismatch = (i: number, j: number): number => {
    const concept = columns[j].concept
    if (kinds[i] === 'text' && concept && NUMERIC_CONCEPTS.has(concept)) return 2 * lineH
    if (kinds[i] === 'text' && concept !== 'col.description' && concept !== 'col.unit') return lineH
    if (isNumericKind(kinds[i]) && kinds[i] !== 'qxp' && concept === 'col.description') return 2 * lineH
    // "2 Stk." printed tight against the unit column is the quantity (with its unit).
    if ((kinds[i] === 'number' || kinds[i] === 'money') && concept === 'col.unit') return lineH
    return 0
  }
  // Two cells in one column are rare (a value is one cell once symbols are glued), and a
  // description may start far from a centred title: sharing costs more than a long reach.
  const assign = assignCells(
    pieces.map((p) => p.bbox),
    columns,
    { skipCost: 12 * lineH, shareCost: 10 * lineH, mismatch },
  )
  const cells = columns.map((): Cell[] => [])
  const outside: Cell[] = []
  pieces.forEach((p, i) => (assign[i] >= 0 ? cells[assign[i]].push(p) : outside.push(p)))
  return { cells, outside }
}

interface RowFacts {
  kinds: CellKind[][]
  /** Money and number cells (not percents) anywhere in the row. */
  numbers: number
  /** A number in a quantity/price/amount (or untitled) column. */
  hasNumber: boolean
  /** A number in a quantity or unit-price column. */
  hasQtyOrPrice: boolean
  /** Every cell sits in a text column (description, code, unit) and holds no number there. */
  textOnly: boolean
  /** Letters anywhere. */
  hasText: boolean
}

function rowFacts(ctx: BodyContext, placed: PlacedRow, columns: readonly ColumnDraft[]): RowFacts {
  const kinds = placed.cells.map((list) => list.map((c) => cellKind(c.text, ctx.fmt)))
  let hasNumber = false
  let hasQtyOrPrice = false
  let textOnly = placed.outside.length === 0
  let hasText = false
  // A bare integer under an unknown title ("19" in a clause-number column) is not a line's figure
  // when the table has quantity, price or amount titles: a section heading carries one too.
  const titled = columns.some((c) => c.concept !== null && NUMERIC_CONCEPTS.has(c.concept))
  kinds.forEach((list, j) => {
    const col = columns[j]
    for (const k of list) {
      if (k === 'text') hasText = true
      const counts = isNumericColumn(col) && !(titled && col.concept === null && k === 'number')
      if (isNumericKind(k) && (counts || k === 'qxp')) {
        hasNumber = true
        if (col.concept === 'col.quantity' || col.concept === 'col.unit_price' || k === 'qxp') hasQtyOrPrice = true
      }
      if (!isTextColumn(col) && k !== 'symbol') textOnly = false
    }
  })
  // A line of text that runs across a numbers column is a paragraph under the table, not a
  // description line ("Pay by bank transfer: …").
  const across = placed.cells.flat().some((c) =>
    columns.some((col) => isNumericColumn(col) && col.x1 - col.x0 > 0 && Math.min(col.x1, c.bbox.x1) - Math.max(col.x0, c.bbox.x0) > 0.5 * (col.x1 - col.x0)),
  )
  if (across) textOnly = false
  const numbers = kinds.flat().filter((k) => k === 'money' || k === 'number' || k === 'qxp').length
  return { kinds, numbers, hasNumber, hasQtyOrPrice, textOnly: textOnly && !hasNumber, hasText }
}

export interface BodyResult {
  rows: RowDraft[]
  endedBy: TableDraft['endedBy']
  /** Index (into the page rows) of the first row not taken. */
  next: number
}

/**
 * Reads body rows from `rows[start]` on. `columns` are widened by the item cells they receive.
 *
 * Long tables are often cut into sections: a heading row ("עבודות עפר | 01", a delivery note's
 * number and date across the row, "Labour") before each group of lines, and sometimes a subtotal
 * after it. A heading is a row of text that the columns cannot read as a line; it stays in the
 * table (as 'other') only when a line of the table follows it. A totals line that adds up the
 * lines of its section and is followed by more lines (or by a carry to the next page) is a
 * section subtotal: 'other', never the document's total.
 */
export function collectBody(ctx: BodyContext, rows: readonly VisualRow[], start: number, columns: ColumnDraft[], lineH: number, prevBottom: number, aside: readonly Span1d[] = []): BodyResult {
  const out: RowDraft[] = []
  const gaps: number[] = []
  let bottom = prevBottom
  let summarySeen = false
  let endedBy: TableDraft['endedBy'] = 'page'
  let items = 0
  // Where the current section starts in `out`, and where its totals start.
  let section = 0
  let sections = 0
  let summaryAt = -1
  let r = start
  const descCol = columns.findIndex((c) => c.concept === 'col.description')
  const amountCol = columns.findIndex((c) => c.concept === 'col.line_amount')
  const priced = columns.some((c) => c.concept === 'col.quantity' || c.concept === 'col.unit_price')
  /** rows[k] is one of this table's lines: numbers under its number titles, nothing beyond its columns, no label. */
  const lineAt = (k: number, above: number): boolean => {
    if (k >= rows.length || rows[k].bbox.y0 - above > 3 * lineH) return false
    const next = rows[k]
    if (readHeader(next) || rowLabel(next.cells)) return false
    const p = placeRow(ctx, next, columns, lineH, aside)
    if (p.outside.some((c) => cellKind(c.text, ctx.fmt) !== 'symbol')) return false
    const f = rowFacts(ctx, p, columns)
    if (!f.hasNumber) return false
    if (priced) return f.hasQtyOrPrice && f.numbers >= 2
    // Without quantity or price titles a line is a name and an amount; a payment is not one.
    return f.hasText && !next.cells.some((c) => looksLikePayment(c.text))
  }
  /** A heading is short and is no "label: value" pair ("Labour:" and "עבודות עפר | 01" are). */
  const headingLike = (row: VisualRow): boolean => {
    const words = row.cells.reduce((n, c) => n + c.text.trim().split(/\s+/).length, 0)
    return words <= 8 && !row.cells.some((c) => /\S\s*[:：]\s*\S/.test(c.text))
  }
  for (; r < rows.length; r++) {
    const row = rows[r]
    const gap = row.bbox.y0 - bottom
    if (readHeader(row)) {
      endedBy = 'header'
      break
    }
    const placed = placeRow(ctx, row, columns, lineH, aside)
    const facts = rowFacts(ctx, placed, columns)
    const label = rowLabel(row.cells.filter((c) => !inAside(c, columns, aside)))
    const draft = (kind: RowDraft['kind']): RowDraft => ({ row, page: row.page, kind, cells: placed.cells })
    // An item row prints a quantity or price next to its amount; a totals line prints one figure
    // (and maybe a rate) next to its label, wherever the columns put them.
    const itemLike = facts.hasQtyOrPrice && facts.numbers >= 2
    // A label printed outside the description column next to a lone figure is a totals line even
    // when the lexicon does not know its words ("Gesamt zzgl. Fracht", "סה"כ קנייה").
    const looseTotal = !itemLike && items > 0 && facts.numbers === 1 && labelOutsideDescription(ctx, placed, descCol)
    // A shipping or discount word without any figure is a description line ("Ocean freight").
    const figure = [...placed.cells.flat(), ...placed.outside].some((c) => ['money', 'number'].includes(cellKind(c.text, ctx.fmt)))
    const summaryLabel = label?.kind === 'summary' && (figure || !label.soft)
    if (summarySeen) {
      if ((summaryLabel || looseTotal) && gap <= 3 * lineH && !itemLike) {
        out.push(draft('summary'))
        bottom = row.bbox.y1
        continue
      }
      const goesOn = label?.kind === 'page' || lineAt(r, bottom) || (!facts.hasNumber && !label && lineAt(r + 1, row.bbox.y1))
      if (!goesOn || !closesSection(ctx, out, section, summaryAt, amountCol)) {
        endedBy = 'summary'
        break
      }
      for (let k = summaryAt; k < out.length; k++) out[k].kind = 'other'
      summarySeen = false
      section = out.length
      sections++
    }
    const typical = gaps.length ? median(gaps) : lineH
    if (gap > Math.max(3 * lineH, 2.5 * typical + lineH)) {
      endedBy = 'gap'
      break
    }
    const outsideNumber = placed.outside.some((c) => isNumericKind(cellKind(c.text, ctx.fmt)))
    if (label?.kind === 'page' && !itemLike) {
      out.push(draft('other'))
    } else if ((summaryLabel && !itemLike && !lineLikeCharge(label!, placed, descCol, amountCol)) || (looseTotal && label?.kind !== 'payment')) {
      summaryAt = out.length
      out.push(draft('summary'))
      summarySeen = true
    } else if (facts.hasNumber) {
      // A number left outside the columns means the row belongs to something else (a totals
      // block that is not labelled as such, a side box).
      if (outsideNumber) {
        endedBy = 'content'
        break
      }
      out.push(draft('item'))
      items++
      widenColumns(columns, [out[out.length - 1]])
    } else if (facts.textOnly && facts.hasText) {
      out.push(draft('continuation'))
    } else if (!facts.hasText && !facts.hasNumber && placed.outside.length === 0) {
      out.push(draft('other'))
    } else if (facts.hasText && !label && !outsideNumber && headingLike(row) && lineAt(r + 1, row.bbox.y1)) {
      // A section heading: text the columns cannot read as a line, with a line right under it.
      out.push(draft('other'))
    } else {
      endedBy = 'content'
      break
    }
    // The gap under the header counts too: OCR boxes hug the ink, so text heights alone understate the row pitch.
    gaps.push(Math.max(0, gap))
    bottom = Math.max(bottom, row.bbox.y1)
  }
  if (r >= rows.length && !summarySeen) endedBy = 'page'
  if (summarySeen && r >= rows.length) endedBy = 'summary'
  // The last section's subtotal stands right above the document's totals: like the sections
  // before it, a figure equal to its section's sum is not one of them.
  if (summarySeen && sections > 0 && out.length - summaryAt > 1 && closesSection(ctx, out.slice(0, summaryAt + 1), section, summaryAt, amountCol)) out[summaryAt].kind = 'other'
  return { rows: out, endedBy, next: r }
}

/**
 * The totals run that starts at `out[summaryAt]` is one figure equal to the sum of the amounts of
 * the section's items (from `out[section]`): a section subtotal.
 */
function closesSection(ctx: BodyContext, out: readonly RowDraft[], section: number, summaryAt: number, amountCol: number): boolean {
  if (amountCol < 0 || summaryAt < section || out.length - summaryAt !== 1) return false
  const amount = (r: RowDraft): Dec | null => {
    const cell = r.cells[amountCol]?.[0] ?? null
    const p = cell ? parseAmount(cell.text, ctx.fmt) : null
    return p ? dec(p.amount) : null
  }
  const lines = out.slice(section, summaryAt).filter((r) => r.kind === 'item')
  if (lines.length < 2) return false
  let sum: Dec = fromInt(0)
  for (const r of lines) {
    const a = amount(r)
    if (!a) return false
    sum = add(sum, a)
  }
  const sub = amount(out[summaryAt])
  return !!sub && eq(sub, sum)
}

/** The row's words sit outside the description column (in a numbers column, or beyond the table). */
function labelOutsideDescription(ctx: BodyContext, placed: PlacedRow, descCol: number): boolean {
  if (descCol < 0) return false
  const texts = [...placed.cells.flatMap((list, j) => list.map((c) => ({ c, j }))), ...placed.outside.map((c) => ({ c, j: -1 }))].filter(
    ({ c }) => cellKind(c.text, ctx.fmt) === 'text',
  )
  return texts.length > 0 && texts.every(({ j }) => j !== descCol)
}

/**
 * A discount or shipping label is an ordinary line when it reads like one: no colon, in the
 * description column, its amount in the amount column, before any totals.
 */
function lineLikeCharge(label: NonNullable<ReturnType<typeof rowLabel>>, placed: PlacedRow, descCol: number, amountCol: number): boolean {
  if (!label.soft || label.colon) return false
  if (descCol < 0 || !placed.cells[descCol].includes(label.cell)) return false
  return amountCol < 0 || placed.cells[amountCol].length > 0
}

/** Widens each column to the cells assigned to it in item rows. */
export function widenColumns(columns: ColumnDraft[], rows: readonly RowDraft[]): void {
  for (const r of rows) {
    if (r.kind !== 'item') continue
    r.cells.forEach((list, j) => {
      for (const c of list) {
        // Never across a neighbour: a stray cell must not make columns overlap.
        const left = j > 0 ? columns[j - 1].x1 : -Infinity
        const right = j + 1 < columns.length ? columns[j + 1].x0 : Infinity
        columns[j].x0 = Math.max(Math.min(columns[j].x0, c.bbox.x0), left)
        columns[j].x1 = Math.min(Math.max(columns[j].x1, c.bbox.x1), right)
      }
    })
  }
}
