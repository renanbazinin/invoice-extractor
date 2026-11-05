/**
 * Field values as plain text for exports, and text a supplier template read (a label's value, the
 * words in a box) turned into the same normalized values the pipeline produces.
 */
import type { CanonicalField, DocumentType, NormalizedValue } from '../model/types'
import { DOCUMENT_TYPES } from '../model/types'
import { parseAmount, parseBankAccount, parseCurrency, parseDate, parseEmail, parsePercent, parsePhone, parseTaxId } from '../semantic'
import type { ExportOptions } from './types'

const MONEY: ReadonlySet<CanonicalField> = new Set(['subtotal', 'discount', 'tax_amount', 'total', 'amount_paid', 'amount_due', 'rounding'])
const DATES: ReadonlySet<CanonicalField> = new Set(['invoice_date', 'due_date', 'delivery_date'])
const TAX_IDS: ReadonlySet<CanonicalField> = new Set(['supplier.tax_id', 'customer.tax_id'])

export type ValueKind = 'money' | 'percent' | 'date' | 'currency' | 'id' | 'text'

export function kindOfField(field: CanonicalField): ValueKind {
  if (MONEY.has(field)) return 'money'
  if (field === 'tax_rate') return 'percent'
  if (DATES.has(field)) return 'date'
  if (field === 'currency') return 'currency'
  if (TAX_IDS.has(field) || field === 'supplier.bank_account') return 'id'
  return 'text'
}

/**
 * Reads `text` as a value of `field`, or null when it is not one ("abc" for a total). Dates take
 * the day-first reading unless `monthFirst`; an ambiguous one keeps the other as an alternative.
 */
export function normalizeFor(field: CanonicalField, text: string, opts: { currency?: string | null; monthFirst?: boolean } = {}): NormalizedValue | null {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return null
  switch (kindOfField(field)) {
    case 'money': {
      const a = parseAmount(t)
      return a ? { kind: 'money', amount: a.negative && !a.amount.startsWith('-') ? `-${a.amount}` : a.amount, currency: a.currency ?? opts.currency ?? null } : null
    }
    case 'percent': {
      const p = parsePercent(t) ?? (/^\d+(?:[.,]\d+)?$/.test(t) ? { value: t.replace(',', '.') } : null)
      return p ? { kind: 'percent', value: p.value } : null
    }
    case 'date': {
      const d = parseDate(t, { order: opts.monthFirst ? 'MDY' : 'DMY' })
      return d ? { kind: 'date', iso: d.iso, alternatives: d.alternatives } : null
    }
    case 'currency': {
      const c = parseCurrency(t) ?? (/^[A-Z]{3}$/.test(t) ? t : null)
      return c ? { kind: 'currency', code: c } : null
    }
    case 'id': {
      if (field === 'supplier.bank_account') {
        const b = parseBankAccount(t)
        return b ? { kind: 'id', value: b.value, scheme: b.scheme, checksum: b.checksum } : { kind: 'text', value: t }
      }
      const id = parseTaxId(t)
      return id ? { kind: 'id', value: id.value, scheme: id.scheme, checksum: id.checksum } : null
    }
    case 'text': {
      if (field === 'document_type') return (DOCUMENT_TYPES as readonly string[]).includes(t) ? { kind: 'document_type', value: t as DocumentType } : { kind: 'text', value: t }
      if (field === 'supplier.email') return { kind: 'text', value: parseEmail(t)?.value ?? t }
      if (field === 'supplier.phone') return { kind: 'text', value: parsePhone(t)?.value ?? t }
      return { kind: 'text', value: t }
    }
  }
}

/** The value as plain text, as an export writes it: money without grouping, dates per `dateFormat`. */
export function plainValue(v: NormalizedValue | null, raw: string, opts: Pick<ExportOptions, 'dateFormat' | 'decimal'>): string {
  if (!v) return raw
  const num = (s: string) => (opts.decimal === ',' ? s.replace('.', ',') : s)
  switch (v.kind) {
    case 'money':
      return num(v.amount)
    case 'percent':
    case 'decimal':
      return num(v.value)
    case 'date':
      return formatDate(v.iso, opts.dateFormat)
    case 'currency':
      return v.code
    case 'document_type':
    case 'id':
    case 'text':
      return v.value
  }
}

export function formatDate(iso: string, format: ExportOptions['dateFormat']): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m || format === 'iso') return iso
  return format === 'dd/mm/yyyy' ? `${m[3]}/${m[2]}/${m[1]}` : `${m[2]}/${m[3]}/${m[1]}`
}

/** Two values are the same reading (money and percent by amount, ids and text loosely). */
export function sameValue(a: NormalizedValue | null, b: NormalizedValue | null): boolean {
  if (!a || !b) return false
  const opts = { dateFormat: 'iso', decimal: '.' } as const
  const x = plainValue(a, '', opts)
  const y = plainValue(b, '', opts)
  if (a.kind === 'money' || a.kind === 'percent' || a.kind === 'decimal') return Number(x) === Number(y)
  const loose = (s: string) => s.toLowerCase().replace(/[\s\-./,"'״׳]/g, '')
  return loose(x) === loose(y)
}
