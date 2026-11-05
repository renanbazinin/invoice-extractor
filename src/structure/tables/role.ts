import type { Table } from '../../model/types'
import type { TableDraft } from './draft'
import { headerCell } from './header'
import { looksLikePayment } from './labels'

/**
 * What a table lists. Payments tables (receipts: method, bank, branch, cheque number, amount) and
 * meter-reading or history tables are not invoice lines; tax breakdowns list rates and bases.
 */
export function tableRole(d: TableDraft): Table['role'] {
  if (d.kind === 'payments') return 'payments'
  const header = d.columns.flatMap((c) => c.header.map(headerCell))
  const concepts = new Set(header.flatMap((h) => h.concepts))
  const columns = new Set(d.columns.map((c) => c.concept))
  if (concepts.has('trap.meter_number') && !columns.has('col.unit_price')) return 'other'
  const itemish = columns.has('col.quantity') || columns.has('col.unit_price') || columns.has('col.sku')
  if (!itemish && (concepts.has('tax_rate') || concepts.has('col.tax_rate')) && !columns.has('col.description')) return 'tax'
  // Rows that name means of payment (cash, cheque, card brands, masked card numbers).
  const descCol = d.columns.findIndex((c) => c.concept === 'col.description')
  const items = d.rows.filter((r) => r.kind === 'item')
  if (!itemish && items.length) {
    const texts = items.map((r) => (descCol >= 0 ? r.cells[descCol] : r.cells.flat()).map((c) => c.text).join(' '))
    const paying = texts.filter((t) => looksLikePayment(t)).length
    if (paying * 2 >= texts.length) return 'payments'
  }
  return 'items'
}
