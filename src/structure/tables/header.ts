import { matchLabels, parseAmount, type LabelMatch } from '../../semantic'
import type { DocIndex } from '../../lib/docIndex'
import { cellOfWords, rowOfCells, wordsInCellSpan, type Cell, type VisualRow } from './rows'

/**
 * Column headers. A header cell is a short label whose text is mostly a lexicon column phrase
 * ("תיאור", "כמות", "Unit price", "סה"כ"). Several column words are also document-level labels
 * ("סה"כ" is a subtotal, a total or a column; "Total", "Montant HT"), so a cell takes the column
 * reading whenever the lexicon offers one for the same span (`also`).
 */

/** Column concepts that only an item table has (never a totals block or a payments list). */
export const ITEM_COLUMNS: ReadonlySet<string> = new Set(['col.description', 'col.quantity', 'col.unit_price', 'col.sku', 'col.unit'])

/** Concepts that name the columns of a payments table on a receipt. */
export const PAYMENT_CONCEPTS: ReadonlySet<string> = new Set(['other.payment_method', 'role.bank', 'party.bank_branch', 'party.account_number', 'other.reference'])

export interface HeaderCell {
  cell: Cell
  /** The column concept the cell names (e.g. 'col.quantity'), or null. */
  column: string | null
  /** 'weak' when the only column reading is a weak phrase ("יח'", "Total") or a secondary one. */
  strength: 'strong' | 'weak' | null
  /** Every concept matched in the cell, any kind (payment and meter words included). */
  concepts: string[]
  /** Share of the cell's letters covered by lexicon matches. */
  coverage: number
  /** Short, mostly letters, not an amount: it can be a column title. */
  labelLike: boolean
}

const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length

/** Whether a text can be a column title: short, mostly letters, not an amount. */
export function isLabelLike(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 48) return false
  if (t.split(/\s+/).length > 7) return false
  const l = letters(t)
  const d = (t.match(/\d/g) ?? []).length
  // "#", "%", "₪", "(€)": symbol-only titles of narrow columns.
  if (!l) return !d && /^[#№%₪$€£¥()\s]+$/.test(t)
  if (d > 3 || d > l) return false
  if (parseAmount(t)) return false
  return true
}

function columnScore(m: LabelMatch, concept: string): number {
  const len = m.end - m.start
  if (m.kind === 'column' && m.concept === concept) return len * (m.strength === 'strong' ? 1 : 0.7)
  if (m.also.includes(concept)) return len * 0.6
  return 0
}

/** Reads one cell as a possible column title. */
export function headerCell(cell: Cell): HeaderCell {
  const matches = matchLabels(cell.text)
  // A symbol-only title ("#", "№") is covered by its symbols, not by letters it does not have.
  const count = letters(cell.text) ? letters : (s: string): number => s.replace(/\s/g, '').length
  const total = count(cell.text) || 1
  const covered = matches.reduce((n, m) => n + count(cell.text.slice(m.start, m.end)), 0)
  const candidates = new Set<string>()
  for (const m of matches) {
    if (m.kind === 'column') candidates.add(m.concept)
    for (const a of m.also) if (a.startsWith('col.')) candidates.add(a)
  }
  let column: string | null = null
  let best = 0
  for (const c of candidates) {
    const s = matches.reduce((n, m) => n + columnScore(m, c), 0)
    if (s > best) {
      best = s
      column = c
    }
  }
  let strength: HeaderCell['strength'] = null
  if (column) {
    const primary = matches.find((m) => m.kind === 'column' && m.concept === column && m.strength === 'strong')
    strength = primary ? 'strong' : 'weak'
  }
  const concepts = [...new Set(matches.flatMap((m) => [m.concept, ...m.also]))]
  return { cell, column, strength, concepts, coverage: covered / total, labelLike: isLabelLike(cell.text) }
}

export interface HeaderReading {
  cells: HeaderCell[]
  /** 'items' for an item-table header, 'payments' for a receipt's payments header. */
  kind: 'items' | 'payments'
  /** Extents of title cells left out as a side box beside the table (see sideCells). */
  aside: { x0: number; x1: number }[]
}

/**
 * The title of a box printed beside the table on the same line as its column titles ("B A N K"
 * over IBAN/BIC lines in a left margin): an outer cell that names nothing and is set apart from
 * the titles by much more than they are set apart from each other.
 */
function sideCells(cells: readonly HeaderCell[]): HeaderCell[] {
  if (cells.length < 4) return []
  const box = (c: HeaderCell) => c.cell.bbox
  const lineH = Math.min(...cells.map((c) => box(c).y1 - box(c).y0))
  const out: HeaderCell[] = []
  for (const [edge, inner] of [
    [0, cells.slice(1)],
    [cells.length - 1, cells.slice(0, -1)],
  ] as const) {
    const c = cells[edge]
    if (c.column || c.concepts.length) continue
    const gaps = inner.slice(1).map((x, k) => box(x).x0 - box(inner[k]).x1)
    const apart = edge === 0 ? box(inner[0]).x0 - box(c).x1 : box(c).x0 - box(inner[inner.length - 1]).x1
    if (apart >= 6 * lineH && apart > 1.8 * Math.max(0, ...gaps)) out.push(c)
  }
  return out.length < cells.length - 2 ? out : []
}

/**
 * Whether a visual row is a table header: every cell is a label, and either at least two cells
 * name different column concepts one of which only item tables have (description, quantity, unit
 * price, code, unit), or the row names payment columns (method, bank, branch, account, cheque) next
 * to an amount column. A totals bar ("סכום ביניים | הנחה | מע"מ | סה"כ") names no item column and
 * a meta grid ("תאריך | מספר חשבונית") names no column at all, so neither is a header.
 */
export function readHeader(row: VisualRow): HeaderReading | null {
  if (row.cells.length < 2) return null
  const all = row.cells.map(headerCell)
  if (all.some((c) => !c.labelLike)) return null
  const side = sideCells(all)
  const cells = all.filter((c) => !side.includes(c))
  const aside = side.map((c) => ({ x0: c.cell.bbox.x0, x1: c.cell.bbox.x1 }))
  const named = cells.filter((c) => c.column && c.coverage >= 0.5)
  const distinct = new Set(named.map((c) => c.column))
  const itemSpecific = named.some((c) => ITEM_COLUMNS.has(c.column!) && (c.strength === 'strong' || c.coverage >= 0.8))
  const payment = cells.filter((c) => c.concepts.some((x) => PAYMENT_CONCEPTS.has(x))).length
  const amountCol = named.some((c) => c.column === 'col.line_amount')
  if (payment >= 1 && amountCol && cells.length >= 3) return { cells, kind: 'payments', aside }
  if (distinct.size >= 2 && itemSpecific) return { cells, kind: 'items', aside }
  return null
}

/**
 * A second header line under the first one (stacked bilingual titles: "סה"כ | מחיר | כמות" over
 * "Amount | Price | Qty"): every cell is a label and sits under a header cell.
 */
export function isHeaderContinuation(row: VisualRow, header: VisualRow): boolean {
  if (!row.cells.length) return false
  const hits = row.cells.filter((c) => {
    if (!isLabelLike(c.text)) return false
    return header.cells.some((h) => Math.min(h.bbox.x1, c.bbox.x1) - Math.max(h.bbox.x0, c.bbox.x0) > -2)
  })
  if (hits.length !== row.cells.length) return false
  const named = row.cells.map(headerCell).filter((c) => c.column)
  return named.length >= Math.min(2, row.cells.length)
}

/**
 * Column titles set close together come out of the reader as one line ("Menge Einheit
 * Einzelpreis USt.", "Pos. Art.-Nr."). A cell whose words are separated by gaps wider than a
 * space (half the text height or more) and whose pieces name two or more different column
 * concepts holds several titles; it is cut at those gaps. The title of one column ("Unit price",
 * "Qty (pcs/pairs)", "כמות x מחיר = סה"כ") is set with ordinary spaces and stays whole.
 */
export function splitTitles(index: DocIndex, row: VisualRow): VisualRow {
  let changed = false
  const cells = row.cells.flatMap((cell) => {
    if (cell.wordIds.length < 2 || !isLabelLike(cell.text)) return [cell]
    const words = cell.wordIds.map((id) => index.word.get(id)!).sort((a, b) => a.bbox.x0 - b.bbox.x0)
    // A title the lexicon knows as one phrase ("סה"כ לשורה", "מחיר ליחידה") is never cut, however
    // wide the font sets its spaces.
    const phrases = matchLabels(cell.text)
      .map((m) => new Set(wordsInCellSpan(index, cell, m.start, m.end)))
      .filter((ids) => ids.size > 1)
    const groups: Set<string>[] = [new Set([words[0].id])]
    for (let k = 1; k < words.length; k++) {
      const h = Math.min(words[k].bbox.y1 - words[k].bbox.y0, words[k - 1].bbox.y1 - words[k - 1].bbox.y0)
      const inPhrase = phrases.some((ids) => ids.has(words[k].id) && ids.has(words[k - 1].id))
      if (words[k].bbox.x0 - words[k - 1].bbox.x1 >= 0.55 * h && !inPhrase) groups.push(new Set())
      groups[groups.length - 1].add(words[k].id)
    }
    if (groups.length < 2) return [cell]
    const pieces = groups.map((g) => cellOfWords(index, cell.lineId, cell.wordIds.filter((id) => g.has(id))))
    const named = pieces.map(headerCell).filter((h) => h.column && h.coverage >= 0.5)
    if (new Set(named.map((h) => h.column)).size < 2 || !pieces.every((p) => isLabelLike(p.text))) return [cell]
    changed = true
    return pieces
  })
  return changed ? rowOfCells(cells) : row
}

/**
 * A line that can be part of a title printed over two or three lines: every cell names a column
 * or is a short fragment ("Unit" over "Price", "(excl. VAT)"). A document title or a labelled
 * line above the table ("סיבת הזיכוי הנחה בדיעבד") is neither, and must not be stacked into the
 * column titles under it.
 */
export function isTitleLine(row: VisualRow): boolean {
  return row.cells.every((c) => {
    if (!isLabelLike(c.text)) return false
    const h = headerCell(c)
    return (h.column !== null && h.coverage >= 0.5) || c.text.trim().split(/\s+/).length <= 2
  })
}
