import type { CanonicalField, DocumentType, ExtractionResult, FieldStatus, NormalizedValue } from '../../src/model/types'

export const FIELD_GROUPS: { title: string; fields: { key: CanonicalField; en: string; he: string }[] }[] = [
  {
    title: 'Document',
    fields: [
      { key: 'document_type', en: 'Document type', he: 'סוג מסמך' },
      { key: 'invoice_number', en: 'Invoice number', he: 'מספר מסמך' },
      { key: 'invoice_date', en: 'Invoice date', he: 'תאריך' },
      { key: 'due_date', en: 'Due date', he: 'תאריך פירעון' },
      { key: 'delivery_date', en: 'Delivery date', he: 'תאריך אספקה' },
      { key: 'po_number', en: 'PO number', he: 'מספר הזמנה' },
      { key: 'allocation_number', en: 'Allocation number', he: 'מספר הקצאה' },
      { key: 'payment_terms', en: 'Payment terms', he: 'תנאי תשלום' },
    ],
  },
  {
    title: 'Amounts',
    fields: [
      { key: 'currency', en: 'Currency', he: 'מטבע' },
      { key: 'subtotal', en: 'Subtotal', he: 'סכום ביניים' },
      { key: 'discount', en: 'Discount', he: 'הנחה' },
      { key: 'tax_rate', en: 'VAT rate', he: 'שיעור מע״מ' },
      { key: 'tax_amount', en: 'VAT amount', he: 'מע״מ' },
      { key: 'rounding', en: 'Rounding', he: 'עיגול' },
      { key: 'total', en: 'Total', he: 'סה״כ' },
      { key: 'amount_paid', en: 'Amount paid', he: 'שולם' },
      { key: 'amount_due', en: 'Amount due', he: 'לתשלום' },
    ],
  },
  {
    title: 'Supplier',
    fields: [
      { key: 'supplier.name', en: 'Name', he: 'שם הספק' },
      { key: 'supplier.tax_id', en: 'Tax ID', he: 'ח.פ / ע.מ' },
      { key: 'supplier.address', en: 'Address', he: 'כתובת' },
      { key: 'supplier.phone', en: 'Phone', he: 'טלפון' },
      { key: 'supplier.email', en: 'Email', he: 'דוא״ל' },
      { key: 'supplier.bank_account', en: 'Bank account', he: 'חשבון בנק' },
    ],
  },
  {
    title: 'Customer',
    fields: [
      { key: 'customer.name', en: 'Name', he: 'שם הלקוח' },
      { key: 'customer.tax_id', en: 'Tax ID', he: 'ח.פ / ת.ז' },
      { key: 'customer.address', en: 'Address', he: 'כתובת' },
    ],
  },
]

/** "Invoice number", "Supplier tax ID": a field's name outside its group. */
export const FIELD_LABEL: Record<string, string> = Object.fromEntries(
  FIELD_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, g.title === 'Supplier' || g.title === 'Customer' ? `${g.title} ${f.en.replace(/^Name$/, 'name')}` : f.en])),
)

const DOC_TYPES: Record<DocumentType, string> = {
  invoice: 'Invoice',
  tax_invoice: 'Tax invoice',
  tax_invoice_receipt: 'Tax invoice / receipt',
  receipt: 'Receipt',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
  proforma: 'Proforma',
  quote: 'Quote',
  transaction_account: 'Transaction account',
  utility_bill: 'Utility bill',
}

/** Exact decimals keep their digits: grouping is added to the string, never through a float. */
function groupDigits(amount: string): string {
  const [int, frac] = amount.replace(/^-/, '').split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${amount.startsWith('-') ? '−' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`
}

export function showValue(v: NormalizedValue | null, raw: string): string {
  if (!v) return raw
  switch (v.kind) {
    case 'money':
      return `${groupDigits(v.amount)}${v.currency ? ` ${v.currency}` : ''}`
    case 'percent':
      return `${v.value}%`
    case 'decimal':
      return v.value
    case 'date':
      return v.iso
    case 'currency':
      return v.code
    case 'document_type':
      return DOC_TYPES[v.value] ?? v.value
    case 'id':
      return v.value
    case 'text':
      return v.value
  }
}

/** Notes worth showing next to a value: an ambiguous date, a failed checksum. */
export function valueNotes(v: NormalizedValue | null): string[] {
  if (!v) return []
  if (v.kind === 'date' && v.alternatives.length) return [`could also be ${v.alternatives.join(', ')}`]
  if (v.kind === 'id' && v.checksum === true) return [`${v.scheme ?? 'check digit'} ✓`]
  if (v.kind === 'id' && v.checksum === false) return ['check digit fails']
  return []
}

export const STATUS: Record<FieldStatus, { label: string; mark: string; hint: string }> = {
  verified: { label: 'Verified', mark: '✔', hint: 'Found on the document and confirmed independently (arithmetic, check digit, unambiguous label).' },
  proposed: { label: 'Proposed', mark: '?', hint: 'Found on the document and plausible, but nothing independent confirms it.' },
  needs_review: { label: 'Needs review', mark: '!', hint: 'Conflicting readings, a failed check or a weak reading. A person should look.' },
}

export function counts(fields: ExtractionResult['fields']): Record<FieldStatus, number> {
  const c: Record<FieldStatus, number> = { verified: 0, proposed: 0, needs_review: 0 }
  for (const f of Object.values(fields)) if (f) c[f.status]++
  return c
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}
