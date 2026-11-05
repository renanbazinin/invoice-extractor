import { matchLabels } from '../../semantic'
import type { Cell } from './rows'

/**
 * What the label of a table row says: a sum at the foot of the table (subtotal, VAT, total,
 * payable, paid, rounding), a per-page or carried-forward figure, or a payment method.
 */

/** Labels of the totals under a table. */
const SUMMARY = new Set([
  'subtotal', 'total', 'total_due', 'tax', 'tax_amount', 'tax_rate', 'amount_due', 'amount_paid', 'rounding', 'discount',
  'other.after_discount', 'other.charge', 'trap.exempt', 'trap.total_quantity', 'trap.tax_withholding', 'trap.previous_balance',
])

/** Summary labels that can also be the description of an ordinary line (a discount or shipping line). */
const SOFT = new Set(['discount', 'other.charge'])

/** Figures that belong to a page, not to the document: never items, never the document's totals. */
const PAGE = new Set(['trap.page_subtotal', 'trap.carried_forward'])

const PAYMENT = new Set(['other.payment_method'])

/** Words that open a totals line ("סה"כ חיוב לתקופה", "Total charges"): enough at the start of a label. */
const LEADING = new Set(['subtotal', 'total', 'total_due', 'tax_amount', 'amount_due', 'amount_paid'])

export interface RowLabel {
  kind: 'summary' | 'page' | 'payment'
  concept: string
  /** A discount/charge label: the row may still be an ordinary line. */
  soft: boolean
  /** The label ends with a colon ("Subtotal:"), as labels in a totals block do. */
  colon: boolean
  cell: Cell
}

const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length

/**
 * The label a row's cells carry, when one of its text cells is mostly (half of its letters or
 * more) a summary, page-total or payment-method phrase. Longer, stronger readings win.
 */
export function rowLabel(cells: readonly Cell[]): RowLabel | null {
  let best: { label: RowLabel; score: number } | null = null
  for (const cell of cells) {
    const total = letters(cell.text)
    if (!total) continue
    for (const m of matchLabels(cell.text)) {
      const covered = letters(cell.text.slice(m.start, m.end)) / total
      const ids = [m.concept, ...m.also]
      const leading = !/[\p{L}\p{N}]/u.test(cell.text.slice(0, m.start)) && LEADING.has(m.concept)
      if (covered < 0.5 && !leading) continue
      const page = ids.find((c) => PAGE.has(c))
      const summary = ids.find((c) => SUMMARY.has(c))
      const payment = ids.find((c) => PAYMENT.has(c))
      const concept = page ?? summary ?? payment
      if (!concept) continue
      const kind: RowLabel['kind'] = page ? 'page' : summary ? 'summary' : 'payment'
      const score = covered + (m.strength === 'strong' ? 0.2 : 0) + (m.end - m.start) / 100
      const label: RowLabel = { kind, concept, soft: kind === 'summary' && SOFT.has(concept), colon: /[:：]\s*$|^\s*[:：]/.test(cell.text), cell }
      if (!best || score > best.score) best = { label, score }
    }
  }
  return best?.label ?? null
}

/** Card brands, wallets and masked card numbers: what a payment line names. */
const PAYMENT_WORDS =
  /ויזה|\bvisa\b|מאסטרקארד|mastercard|ישראכרט|isracard|אמריקן אקספרס|\bamex\b|american express|דיינרס|diners|לאומי ?קארד|כרטיס אשראי|אשראי|המחאה|צ['׳]ק|מזומן|העברה בנקאית|אפליקציית תשלום|(?<!\p{L})ביט(?!\p{L})|פייבוקס|\bpaybox\b|\bcheque\b|\bcash\b|credit card|bank transfer|wire transfer|\*{2,}\s?\d{2,4}/iu

/** Whether a description names a means of payment rather than goods or services. */
export function looksLikePayment(text: string): boolean {
  if (PAYMENT_WORDS.test(text)) return true
  return matchLabels(text).some((m) => m.concept === 'other.payment_method' && letters(text.slice(m.start, m.end)) / (letters(text) || 1) >= 0.5)
}
