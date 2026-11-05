import { dec, mul, near, round, type Dec } from '../../lib/decimal'
import { parseAmount } from '../../semantic'
import type { BodyContext } from './body'
import type { RowDraft, TableDraft } from './draft'
import { cellKind, parseQxP } from './values'

/**
 * Till receipts often print a product on two lines: its name with the line's amount, and under
 * it the quantity × unit price with the barcode ("חלב 3% 1 ליטר … 13.24" over
 * "7290000111018 … 2 × 6.62"). The second line has no amount of its own: its product is the
 * amount of the line above. Such a row is a detail of that item ('continuation', attached to the
 * item by proximity), never an item of its own.
 */
export function foldDetailRows(ctx: BodyContext, d: TableDraft): void {
  const amountCol = d.columns.findIndex((c) => c.concept === 'col.line_amount')
  d.rows.forEach((r, i) => {
    if (r.kind !== 'item' || i === 0) return
    const above = d.rows[i - 1]
    if (above.kind !== 'item' || above.page !== r.page) return
    const product = detailProduct(ctx, r)
    const amount = product ? amountOf(ctx, above, amountCol) : null
    if (product && amount && near(product, amount, dec('0.01'))) r.kind = 'continuation'
  })
}

/** q × p of a row whose only figure is one "quantity × price" cell (codes may stand beside it). */
function detailProduct(ctx: BodyContext, r: RowDraft): Dec | null {
  const cells = r.cells.flat()
  const kinds = cells.map((c) => cellKind(c.text, ctx.fmt))
  if (kinds.filter((k) => k === 'qxp').length !== 1 || kinds.some((k) => k === 'money' || k === 'number' || k === 'percent')) return null
  const cell = cells[kinds.indexOf('qxp')]
  const q = parseQxP(cell.text)
  const qa = q ? parseAmount(q.qty.raw, ctx.fmt) : null
  const pa = q ? parseAmount(q.price.raw, ctx.fmt) : null
  return qa && pa ? round(mul(dec(qa.amount), dec(pa.amount)), 2) : null
}

/** The row's amount: its amount-column cell, else its only money cell. */
function amountOf(ctx: BodyContext, r: RowDraft, amountCol: number): Dec | null {
  const money = amountCol >= 0 ? r.cells[amountCol] : r.cells.flat().filter((c) => cellKind(c.text, ctx.fmt) === 'money')
  if (money.length !== 1) return null
  const p = parseAmount(money[0].text, ctx.fmt)
  return p ? dec(p.amount) : null
}
