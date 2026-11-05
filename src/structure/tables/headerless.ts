import { add, dec, eq, fromInt, isZero, mul, near, round, type Dec } from '../../lib/decimal'
import { matchLabels, parseAmount } from '../../semantic'
import { collectBody, type BodyContext } from './body'
import type { ColumnDraft, RowDraft, TableDraft } from './draft'
import { isLabelLike } from './header'
import { looksLikePayment, rowLabel } from './labels'
import { lineHeight, median, type Cell, type VisualRow } from './rows'
import { cellKind, embeddedQxP, looseAmount, parseQxP } from './values'

/**
 * Item lists without a header row: till receipts ("name / 2 x 9.90  19.80") and untitled tables.
 * Without a header there is no lexicon evidence, so the list must prove itself by arithmetic: a
 * run of rows that each end in an amount, aligned in one column, is a list of items only when
 * its amounts add up to a total printed under it, or when its rows multiply out (quantity × price
 * = amount). A label row printed right above the run, whose cells sit over the run's columns, is
 * taken as the (unknown) header.
 */

interface RowInfo {
  row: VisualRow
  /** The amount at the end of the row (left on a right-to-left page), if any. */
  amount: Cell | null
  /** A "quantity × price" cell. */
  qxp: Cell | null
  /** Text cells that read as descriptions (not labels). */
  texts: Cell[]
  /** The row is a label/value pair or a totals line, not an item. */
  labelled: boolean
  /** Only text, no numbers. */
  textOnly: boolean
  /** Numbers other than the amount (quantity, price). */
  numbers: Cell[]
}

const KEY_VALUE_KINDS = new Set(['field', 'party_attr', 'role', 'doctype', 'trap', 'other'])
const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length

/** A text that is a label of a key/value pair ("קופאית:", "מספר עסקה", "Date"), not a product name. */
function isKeyLabel(text: string): boolean {
  if (/[:：]\s*$|^\s*[:：]/.test(text) || /\S+\s*:\s*\S/.test(text)) return true
  const total = letters(text) || 1
  return matchLabels(text).some((m) => KEY_VALUE_KINDS.has(m.kind) && letters(text.slice(m.start, m.end)) / total >= 0.6)
}

const TAX = new Set(['tax', 'tax_amount', 'tax_rate', 'col.tax_rate'])

/**
 * A line of a VAT breakdown ("zzgl. 19 % USt. auf 3.093,00 €", "מע"מ 17% על 1,200.00"): a rate
 * and a tax word, whatever else is around them. Its amounts add up to the tax total under them,
 * which must not make them a list of items.
 */
function isTaxLine(text: string): boolean {
  return /\d\s*%|%\s*\d/.test(text) && matchLabels(text).some((m) => TAX.has(m.concept) || m.also.some((a) => TAX.has(a)))
}

function info(ctx: BodyContext, row: VisualRow, rtl: boolean): RowInfo {
  const kinds = row.cells.map((c) => cellKind(c.text, ctx.fmt))
  const money = row.cells.filter((_, i) => kinds[i] === 'money')
  const amount = money.length ? money.reduce((a, b) => (rtl ? (b.bbox.x0 < a.bbox.x0 ? b : a) : b.bbox.x1 > a.bbox.x1 ? b : a)) : null
  const qxp = row.cells.find((_, i) => kinds[i] === 'qxp') ?? null
  const texts = row.cells.filter((c, i) => kinds[i] === 'text' && !isKeyLabel(c.text))
  const labelled = !!rowLabel(row.cells) || row.cells.some((c, i) => kinds[i] === 'text' && (isKeyLabel(c.text) || isTaxLine(c.text)))
  // Text, and at most specks a scan made of nothing (a stray "2" or ".").
  const textOnly = kinds.includes('text') && row.cells.every((c, i) => kinds[i] === 'text' || kinds[i] === 'symbol' || (kinds[i] !== 'money' && c.text.trim().length <= 2))
  const numbers = row.cells.filter((c, i) => (kinds[i] === 'money' || kinds[i] === 'number') && c !== amount)
  return { row, amount, qxp, texts, labelled, textOnly, numbers }
}

/** A line with an amount and a name (or "q x p"), not a label/value pair and not a payment ("ויזה ****1234"). */
const isItem = (r: RowInfo): boolean =>
  !!r.amount && !r.labelled && (r.texts.length > 0 || !!r.qxp) && r.row.cells.length <= 10 && !r.texts.some((c) => looksLikePayment(c.text))

function aligned(a: Cell, b: Cell, tol: number): boolean {
  return Math.abs(a.bbox.x1 - b.bbox.x1) <= tol || Math.abs(a.bbox.x0 - b.bbox.x0) <= tol
}

function amountOf(cell: Cell, ctx: BodyContext): Dec | null {
  const p = parseAmount(cell.text, ctx.fmt) ?? looseAmount(cell.text, ctx.fmt)
  return p ? dec(p.amount) : null
}

const product = (q: string, p: string, a: Dec, ctx: BodyContext): boolean => {
  const qa = parseAmount(q, ctx.fmt)
  const pa = parseAmount(p, ctx.fmt)
  return !!qa && !!pa && !isZero(a) && near(round(mul(dec(qa.amount), dec(pa.amount)), 2), a, dec('0.01'))
}

/** The row multiplies out: its "q x p", or two of its other numbers, times give its amount. */
function multipliesOut(r: RowInfo, ctx: BodyContext): boolean {
  if (!r.amount) return false
  const a = amountOf(r.amount, ctx)
  if (!a) return false
  const q = r.qxp ? parseQxP(r.qxp.text) : (r.texts.map((c) => embeddedQxP(c.text)).find((x) => !!x) ?? null)
  if (q) return product(q.qty.raw, q.price.raw, a, ctx)
  for (let i = 0; i < r.numbers.length; i++)
    for (let j = i + 1; j < r.numbers.length; j++) if (product(r.numbers[i].text, r.numbers[j].text, a, ctx)) return true
  return false
}

/** Groups cells into columns: cells that overlap by at least half of the narrower one. */
export function clusterColumns(cells: readonly Cell[]): { x0: number; x1: number; cells: Cell[] }[] {
  const clusters: { x0: number; x1: number; cells: Cell[] }[] = []
  for (const c of [...cells].sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
    const w = c.bbox.x1 - c.bbox.x0
    const hit = clusters.find((k) => {
      const ov = Math.min(k.x1, c.bbox.x1) - Math.max(k.x0, c.bbox.x0)
      return ov > 0 && ov >= 0.5 * Math.min(w, k.x1 - k.x0)
    })
    if (hit) {
      hit.cells.push(c)
      hit.x0 = Math.min(hit.x0, c.bbox.x0)
      hit.x1 = Math.max(hit.x1, c.bbox.x1)
    } else clusters.push({ x0: c.bbox.x0, x1: c.bbox.x1, cells: [c] })
  }
  return clusters.sort((a, b) => a.x0 - b.x0)
}

/**
 * Finds header-less item lists among the rows of one page that no other table took.
 */
export function findHeaderless(ctx: BodyContext, rows: readonly VisualRow[], used: ReadonlySet<number>, rtl: boolean): TableDraft[] {
  const infos = rows.map((r) => info(ctx, r, rtl))
  const out: TableDraft[] = []
  const lineH = lineHeight(rows.flatMap((r) => r.cells))
  const tol = Math.max(3, 0.4 * lineH)
  let i = 0
  while (i < rows.length) {
    if (used.has(i) || !isItem(infos[i])) {
      i++
      continue
    }
    const run: number[] = []
    // A name printed on the line above a "q x p" row.
    if (!infos[i].texts.length && i > 0 && !used.has(i - 1) && infos[i - 1].textOnly && !infos[i - 1].labelled && rows[i].bbox.y0 - rows[i - 1].bbox.y1 <= 1.2 * lineH) run.push(i - 1)
    run.push(i)
    const ref = infos[i].amount!
    let bottom = rows[i].bbox.y1
    let textRun = 0
    let sum = amountOf(ref, ctx) ?? fromInt(0)
    let count = 1
    // The gaps above item rows are told apart from all gaps: a smaller note line under each item
    // ("Two rounds of revisions included") sits tighter than the items do, and must not make the
    // next item look far.
    const gaps: number[] = []
    const itemGaps: number[] = []
    // "q × p" lines (with a barcode) printed under the item they multiply out to.
    const details = new Set<number>()
    let j = i + 1
    for (; j < rows.length; j++) {
      if (used.has(j)) break
      const gap = rows[j].bbox.y0 - bottom
      if (gap > 2.5 * lineH) break
      const r = infos[j]
      const item = isItem(r) && aligned(r.amount!, ref, tol)
      // The totals of a list start after a wider gap than its lines have between them.
      const typical = item ? itemGaps : gaps
      if (typical.length >= 2 && gap > Math.max(1.2 * lineH, 2.2 * median(typical))) break
      if (item) {
        const a = amountOf(r.amount!, ctx)
        // A line that adds up everything above it is the total, whatever its label says.
        if (a && count >= 2 && eq(a, sum)) break
        if (a) sum = add(sum, a)
        count++
        textRun = 0
        itemGaps.push(Math.max(0, gap))
      } else if (r.textOnly && !r.labelled && textRun < 2) {
        textRun++
      } else if (run[run.length - 1] === j - 1 && isDetail(ctx, r, infos[j - 1])) {
        details.add(j)
      } else break
      gaps.push(Math.max(0, gap))
      run.push(j)
      bottom = rows[j].bbox.y1
    }
    while (run.length && !isItem(infos[run[run.length - 1]]) && !details.has(run[run.length - 1])) run.pop()
    const items = run.filter((k) => isItem(infos[k]))
    const accepted = items.length > 0 && provesItself(ctx, infos, items, rows, run[run.length - 1], lineH, details.size)
    if (!accepted) {
      i++
      continue
    }
    out.push(buildDraft(ctx, rows, infos, run, lineH, used))
    i = run[run.length - 1] + 1
  }
  return out
}

/**
 * A till receipt's second line for the item above it: "quantity × price" (and maybe a barcode),
 * no amount of its own, multiplying out to the amount of the item line right above.
 */
function isDetail(ctx: BodyContext, r: RowInfo, above: RowInfo): boolean {
  if (!r.qxp || r.amount || r.numbers.length || r.labelled || !isItem(above)) return false
  const q = parseQxP(r.qxp.text)
  const a = amountOf(above.amount!, ctx)
  return !!q && !!a && product(q.qty.raw, q.price.raw, a, ctx)
}

/** Σ amounts equals a total printed below, or the rows multiply out (`details`: lines proven by a "q × p" line under them). */
function provesItself(ctx: BodyContext, infos: readonly RowInfo[], items: readonly number[], rows: readonly VisualRow[], last: number, lineH: number, details: number): boolean {
  const amounts = items.map((k) => amountOf(infos[k].amount!, ctx))
  if (amounts.some((a) => !a)) return false
  const total = amounts.reduce((s, a) => add(s!, a!), fromInt(0))!
  const products = items.filter((k) => multipliesOut(infos[k], ctx)).length + details
  if (products >= 2) return true
  // Totals under the list: the next rows with a label and an amount (the label need not be in
  // the lexicon: the sum is the evidence). A totals block is often set off by a rule and some
  // space, so it may sit a few lines below.
  let bottom = rows[last].bbox.y1
  for (let k = last + 1; k < rows.length && k <= last + 8; k++) {
    if (rows[k].bbox.y0 - bottom > 5 * lineH) break
    bottom = rows[k].bbox.y1
    if (!rows[k].cells.some((c) => /\p{L}/u.test(c.text))) continue
    for (const c of rows[k].cells) {
      const a = amountOf(c, ctx)
      // Cash totals may be rounded to ten agorot.
      if (a && near(a, total, dec('0.10'))) return items.length >= 2 || products >= 1
    }
  }
  return false
}

function buildDraft(ctx: BodyContext, rows: readonly VisualRow[], infos: readonly RowInfo[], run: readonly number[], lineH: number, used: ReadonlySet<number>): TableDraft {
  const cells = run.flatMap((k) => rows[k].cells)
  const clusters = clusterColumns(cells)
  const amountCells = new Set(run.map((k) => infos[k].amount).filter((c): c is Cell => !!c))
  const textScore = (k: { cells: Cell[] }): number => k.cells.reduce((n, c) => n + letters(c.text), 0)
  const descIndex = clusters.reduce((best, k, idx) => (textScore(k) > textScore(clusters[best]) ? idx : best), 0)
  const columns: ColumnDraft[] = clusters.map((k, idx) => ({
    x0: k.x0,
    x1: k.x1,
    header: [],
    concept: k.cells.some((c) => amountCells.has(c)) ? 'col.line_amount' : idx === descIndex ? 'col.description' : null,
  }))
  const placeOf = (c: Cell): number => clusters.findIndex((k) => k.cells.includes(c))
  const drafts: RowDraft[] = run.map((k) => {
    const r = rows[k]
    const perCol = columns.map((): Cell[] => [])
    for (const c of r.cells) perCol[placeOf(c)].push(c)
    return { row: r, page: r.page, kind: isItem(infos[k]) ? 'item' : 'continuation', cells: perCol }
  })
  // An untitled header: a row of labels right above the list, over its columns.
  const first = run[0]
  if (first > 0 && !used.has(first - 1)) {
    const above = rows[first - 1]
    const fits = above.cells.length >= 2 && above.cells.every((c) => isLabelLike(c.text) && columns.some((col) => Math.min(col.x1, c.bbox.x1) - Math.max(col.x0, c.bbox.x0) > 0))
    if (fits && rows[first].bbox.y0 - above.bbox.y1 <= 2 * lineH && !infos[first - 1].labelled) {
      const perCol = columns.map((): Cell[] => [])
      for (const c of above.cells) {
        const j = columns.findIndex((col) => Math.min(col.x1, c.bbox.x1) - Math.max(col.x0, c.bbox.x0) > 0)
        perCol[j].push(c)
        columns[j].header.push(c)
      }
      drafts.unshift({ row: above, page: above.page, kind: 'header', cells: perCol })
    }
  }
  // Totals under the list belong to it as summary rows.
  const tail = collectBody(ctx, rows, run[run.length - 1] + 1, columns, lineH, rows[run[run.length - 1]].bbox.y1)
  const summaries: RowDraft[] = []
  for (const r of tail.rows) {
    if (r.kind !== 'summary') break
    summaries.push(r)
  }
  return {
    kind: 'headerless',
    pages: [rows[run[0]].page],
    columns,
    rows: [...drafts, ...summaries],
    endedBy: summaries.length ? 'summary' : 'content',
    lineHeight: lineH,
  }
}
