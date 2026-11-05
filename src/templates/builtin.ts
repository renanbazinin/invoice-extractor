/**
 * The templates that ship with the app: a starting point to use as they are or to fork. Their ids
 * start with "builtin:" and they are read-only; a fork is the user's own copy.
 */
import { CANONICAL_FIELDS, type CanonicalField } from '../model/types'
import type { Column, ExportOptions, ExportTemplate, FieldPart, LineProp, MetaProp, SupplierTemplate, Template } from './types'

const f = (header: string, field: CanonicalField, part?: FieldPart): Column => ({ header, source: part ? { type: 'field', field, part } : { type: 'field', field } })
const line = (header: string, prop: LineProp): Column => ({ header, source: { type: 'line', prop } })
const meta = (header: string, prop: MetaProp): Column => ({ header, source: { type: 'meta', prop } })

export const DEFAULT_OPTIONS: ExportOptions = {
  dateFormat: 'dd/mm/yyyy',
  decimal: '.',
  delimiter: ',',
  unverified: 'keep',
  statusColumns: false,
  highlight: true,
}

const SUMMARY: Column[] = [
  meta('File', 'fileName'),
  f('Document type', 'document_type'),
  f('Number', 'invoice_number'),
  f('Date', 'invoice_date'),
  f('Due date', 'due_date'),
  f('Supplier', 'supplier.name'),
  f('Supplier tax ID', 'supplier.tax_id'),
  f('Customer', 'customer.name'),
  f('Currency', 'currency'),
  f('Subtotal', 'subtotal'),
  f('VAT', 'tax_amount'),
  f('Total', 'total'),
  f('Amount due', 'amount_due'),
  meta('Status', 'status'),
]

const SUMMARY_HE: Column[] = [
  meta('קובץ', 'fileName'),
  f('סוג מסמך', 'document_type'),
  f('מספר מסמך', 'invoice_number'),
  f('תאריך', 'invoice_date'),
  f('תאריך פירעון', 'due_date'),
  f('ספק', 'supplier.name'),
  f('ח.פ / ע.מ ספק', 'supplier.tax_id'),
  f('לקוח', 'customer.name'),
  f('מטבע', 'currency'),
  f('סכום לפני מע"מ', 'subtotal'),
  f('מע"מ', 'tax_amount'),
  f('סה"כ', 'total'),
  f('לתשלום', 'amount_due'),
  f('מספר הקצאה', 'allocation_number'),
  meta('סטטוס', 'status'),
]

const exportTemplate = (t: Omit<ExportTemplate, 'kind' | 'options'> & { options?: Partial<ExportOptions> }): ExportTemplate => ({
  ...t,
  kind: 'export',
  options: { ...DEFAULT_OPTIONS, ...t.options },
})

export const BUILTIN_EXPORT: ExportTemplate[] = [
  exportTemplate({
    id: 'builtin:summary-xlsx',
    name: 'Invoice summary (Excel)',
    description: 'One row per invoice with the main fields. Cells that are not verified are coloured: amber for proposed, red for needs review.',
    format: 'xlsx',
    rows: 'invoice',
    columns: SUMMARY,
  }),
  exportTemplate({
    id: 'builtin:summary-he-xlsx',
    name: 'סיכום חשבוניות (Excel)',
    description: 'שורה לכל חשבונית, כותרות בעברית וגיליון מימין לשמאל. ערכים שלא אומתו צבועים.',
    format: 'xlsx',
    rows: 'invoice',
    columns: SUMMARY_HE,
  }),
  exportTemplate({
    id: 'builtin:summary-csv',
    name: 'Invoice summary (CSV)',
    description: 'The same summary as a CSV file (UTF-8, opens in Excel with Hebrew intact).',
    format: 'csv',
    rows: 'invoice',
    columns: SUMMARY,
  }),
  exportTemplate({
    id: 'builtin:lines-xlsx',
    name: 'Line items (Excel)',
    description: 'One row per line item, with the invoice number, date and supplier repeated on each row.',
    format: 'xlsx',
    rows: 'line',
    columns: [
      meta('File', 'fileName'),
      f('Invoice number', 'invoice_number'),
      f('Date', 'invoice_date'),
      f('Supplier', 'supplier.name'),
      line('#', 'index'),
      line('Description', 'description'),
      line('SKU', 'sku'),
      line('Quantity', 'quantity'),
      line('Unit price', 'unitPrice'),
      line('Amount', 'amount'),
    ],
  }),
  exportTemplate({
    id: 'builtin:vat-input-he-xlsx',
    name: 'דוח מע"מ תשומות (Excel)',
    description: 'שורה לכל חשבונית ספק עם הנתונים לדיווח מע"מ, כולל מספר הקצאה, ועמודת סטטוס ליד כל ערך.',
    format: 'xlsx',
    rows: 'invoice',
    columns: [
      f('תאריך', 'invoice_date'),
      f('ספק', 'supplier.name'),
      f('ח.פ / ע.מ ספק', 'supplier.tax_id'),
      f('מספר מסמך', 'invoice_number'),
      f('מספר הקצאה', 'allocation_number'),
      f('סכום לפני מע"מ', 'subtotal'),
      f('שיעור מע"מ', 'tax_rate'),
      f('מע"מ', 'tax_amount'),
      f('סה"כ', 'total'),
    ],
    options: { statusColumns: true },
  }),
  exportTemplate({
    id: 'builtin:expenses-csv',
    name: 'Expense import, verified only (CSV)',
    description: 'A generic import file for accounting software. Only verified values are filled in; the rest is left empty for a person to complete.',
    format: 'csv',
    rows: 'invoice',
    columns: [
      f('Date', 'invoice_date'),
      f('Reference', 'invoice_number'),
      f('Supplier ID', 'supplier.tax_id'),
      f('Supplier', 'supplier.name'),
      f('Net', 'subtotal'),
      f('VAT', 'tax_amount'),
      f('Gross', 'total'),
      f('Currency', 'currency'),
      f('Due date', 'due_date'),
    ],
    options: { unverified: 'blank' },
  }),
  exportTemplate({
    id: 'builtin:review-xlsx',
    name: 'Review sheet (Excel)',
    description: 'Every standard field with its status next to it, for checking a batch before it goes anywhere.',
    format: 'xlsx',
    rows: 'invoice',
    columns: [meta('File', 'fileName'), meta('Overall status', 'status'), ...CANONICAL_FIELDS.map((k) => f(k, k))],
    options: { statusColumns: true },
  }),
  exportTemplate({
    id: 'builtin:fields-json',
    name: 'Standard fields (JSON)',
    description: 'One JSON object per invoice, keyed by the standard field names, for scripts and APIs.',
    format: 'json',
    rows: 'invoice',
    columns: [meta('file', 'fileName'), meta('status', 'status'), ...CANONICAL_FIELDS.map((k) => f(k, k))],
    options: { dateFormat: 'iso', highlight: false },
  }),
]

export const BUILTIN_SUPPLIER: SupplierTemplate[] = [
  {
    id: 'builtin:demo-garage',
    kind: 'supplier',
    name: 'Example: מוסך הדמו',
    description:
      'An example for the demo scan. It knows the garage\'s name and address, reads the car number ("מספר רכב") as the order reference, and sends its invoices to the line-items export.',
    match: { taxIds: ['033333337'], names: ['מוסך הדמו'] },
    fixed: { 'supplier.name': 'מוסך הדמו', 'supplier.address': 'רחוב הדמו 3, באר שבע', currency: 'ILS' },
    labels: [{ label: 'מספר רכב', field: 'po_number' }],
    regions: [],
    exportTemplateId: 'builtin:lines-xlsx',
  },
  {
    id: 'builtin:demo-studio',
    kind: 'supplier',
    name: 'Example: סטודיו הדמו',
    description: 'An example for the demo tax invoice. It knows the studio\'s legal name and bank account, and sends its invoices to the Hebrew summary.',
    match: { taxIds: ['515555555'], names: ['סטודיו הדמו'] },
    fixed: { 'supplier.name': 'סטודיו הדמו בע"מ', 'supplier.bank_account': '12-345-123456' },
    labels: [],
    regions: [],
    exportTemplateId: 'builtin:summary-he-xlsx',
  },
]

export const BUILTIN_TEMPLATES: Template[] = [...BUILTIN_EXPORT, ...BUILTIN_SUPPLIER]

export const isBuiltin = (t: Pick<Template, 'id'>): boolean => t.id.startsWith('builtin:')
