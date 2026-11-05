import { type DocIndex, indexDocument } from '../lib/docIndex'
import type { Direction, DocumentModel } from '../model/types'
import { findCurrencies, inferDateOrder, inferNumberFormat, type NumberFormat } from '../semantic'

/** What the whole document says about how to read any one value on it. */
export interface DocContext {
  index: DocIndex
  /** Decimal/grouping separators used on this document. */
  numberFormat: NumberFormat
  dateOrder: 'DMY' | 'MDY'
  /** 0 when nothing on the page decided the order. */
  dateOrderConfidence: number
  /** The explicit currency mentioned most often (ISO code), or null when none is printed. */
  currency: string | null
  /** Every currency printed, most frequent first. */
  currencies: { code: string; count: number }[]
  /** Base direction of most lines. */
  direction: Direction
  hebrew: boolean
}

export function buildContext(doc: DocumentModel): DocContext {
  const index = indexDocument(doc)
  const texts = doc.lines.map((l) => l.text)
  const numberFormat = inferNumberFormat(texts)
  const order = inferDateOrder(texts)
  const counts = new Map<string, number>()
  for (const t of texts) for (const c of findCurrencies(t)) counts.set(c.code, (counts.get(c.code) ?? 0) + 1)
  const currencies = [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count)
  const rtl = doc.lines.filter((l) => l.dir === 'rtl').length
  return {
    index,
    numberFormat,
    dateOrder: order.order,
    dateOrderConfidence: order.confidence,
    currency: currencies[0]?.code ?? null,
    currencies,
    direction: rtl * 2 >= doc.lines.length && rtl > 0 ? 'rtl' : 'ltr',
    hebrew: doc.meta.scripts.includes('hebrew'),
  }
}
