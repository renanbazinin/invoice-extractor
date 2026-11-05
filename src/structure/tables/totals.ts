import { add, dec, eq, fromInt, type Dec } from '../../lib/decimal'
import { parseAmount } from '../../semantic'
import type { BodyContext } from './body'
import type { TableDraft } from './draft'
import { cellKind, isNumericKind } from './values'

/**
 * Running totals inside a table: a row that only carries an amount equal to the sum of the items
 * above it (on this page, or so far) is a page total or a carried-forward figure, whatever its
 * label says ("מהעברה", "Übertrag", "a riportare" are not all in the lexicon). Such rows are
 * 'other', never items. Rows with a quantity or a unit price are real lines and are never demoted.
 */
export function demoteRunningTotals(ctx: BodyContext, d: TableDraft): void {
  const amountCol = d.columns.findIndex((c) => c.concept === 'col.line_amount')
  if (amountCol < 0) return
  const qtyPrice = d.columns.map((c, j) => (c.concept === 'col.quantity' || c.concept === 'col.unit_price' ? j : -1)).filter((j) => j >= 0)
  const descCol = d.columns.findIndex((c) => c.concept === 'col.description')
  let total: Dec = fromInt(0)
  let pageSum: Dec = fromInt(0)
  let page = d.pages[0]
  let count = 0
  for (const r of d.rows) {
    if (r.page !== page) {
      page = r.page
      pageSum = fromInt(0)
    }
    if (r.kind !== 'item') continue
    const cell = r.cells[amountCol][0]
    const parsed = cell ? parseAmount(cell.text, ctx.fmt) : null
    if (!parsed) continue
    const amount = dec(parsed.amount)
    const hasQtyPrice = qtyPrice.some((j) => r.cells[j].some((c) => isNumericKind(cellKind(c.text, ctx.fmt))))
    const descEmpty = descCol < 0 || !r.cells[descCol].some((c) => /\p{L}/u.test(c.text))
    const judged = qtyPrice.length > 0 || descEmpty
    if (!hasQtyPrice && judged && count >= 2 && (eq(amount, total) || eq(amount, pageSum))) {
      r.kind = 'other'
      continue
    }
    total = add(total, amount)
    pageSum = add(pageSum, amount)
    count++
  }
}
