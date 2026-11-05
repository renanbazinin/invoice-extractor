/**
 * The shared contract between the layers. Every layer reads and writes these types only, so a
 * layer can be rebuilt without touching the others.
 *
 *   read       bytes → DocumentModel            (text + positions + reading order, nothing more)
 *   structure  DocumentModel → Structure        (label/value pairs, tables, blocks)
 *   interpret  DocumentModel + Structure → FieldCandidate[] + LineItemCandidate[] + discovered
 *   validate   candidates → resolved fields, derived values, checks, issues, statuses
 *
 * Coordinates: PDF points (1/72 in), origin at the top-left of the page as displayed (rotation
 * applied), y grows downwards. OCR pixels are converted to points before they leave the reader.
 */

// ---------------------------------------------------------------------------------------------
// Layer 1: reading

export interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type Direction = 'ltr' | 'rtl'
export type TextSource = 'pdf' | 'ocr'

export interface Word {
  /** Stable within one document: `p{page}w{n}`. */
  id: string
  /** 1-based. */
  page: number
  /** Logical (reading) order characters, NFC, bidi control characters removed. */
  text: string
  bbox: BBox
  /** Direction of the word's strong characters; null for digits, punctuation and symbols only. */
  dir: Direction | null
  source: TextSource
  /** 1 for embedded PDF text; the OCR engine's word confidence (0..1) otherwise. */
  confidence: number
  /** Approximate glyph height in points. */
  fontSize: number
  bold: boolean
  lineId: string
}

/**
 * A run of words on one baseline with no wide gap inside it. A wide horizontal gap (a column
 * break, a tab stop between a label and a far-away value, a table cell boundary) ends the line,
 * so one visual row of a table or a two-column header is several lines with the same y. The
 * structure layer pairs them up again by geometry.
 */
export interface Line {
  /** `p{page}l{n}`, numbered in reading order. */
  id: string
  page: number
  /** Words in logical order (for an RTL line: the right-most word first). */
  wordIds: string[]
  /** The words joined in logical order with single spaces. */
  text: string
  bbox: BBox
  /** Base (paragraph) direction of the line. */
  dir: Direction
  blockId: string
}

/** A visually separated region: a run of lines that belong together (an address, a box, a paragraph). */
export interface Block {
  id: string
  page: number
  lineIds: string[]
  bbox: BBox
}

export interface Page {
  /** 1-based. */
  number: number
  width: number
  height: number
  /** Where this page's words came from. */
  source: TextSource
  lineIds: string[]
  blockIds: string[]
}

export interface DocumentModel {
  pages: Page[]
  words: Word[]
  lines: Line[]
  blocks: Block[]
  meta: {
    fileName: string | null
    mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/tiff' | 'image/webp' | 'text/plain'
    pageCount: number
    /** 'embedded' when every page had a usable text layer, 'ocr' when none had, else 'mixed'. */
    textLayer: 'embedded' | 'ocr' | 'mixed'
    /** Scripts seen, by share of letters, e.g. ['hebrew', 'latin']. */
    scripts: string[]
    producer: string | null
    warnings: string[]
  }
}

/** A reference to some text on the page, the unit of evidence. */
export interface TextRef {
  page: number
  wordIds: string[]
  text: string
  bbox: BBox
}

// ---------------------------------------------------------------------------------------------
// Layer 2: structure

export type KeyValueLayout =
  /** "Invoice no: 123" — value after the label on the same line (reading order). */
  | 'inline'
  /** Label on one line, value on the line(s) directly below, aligned with it. */
  | 'below'
  /** Label and value in separate columns of a grid/box (e.g. a label column and a value column). */
  | 'grid'

export interface KeyValue {
  id: string
  label: TextRef
  value: TextRef
  layout: KeyValueLayout
  /** Structural confidence that `value` belongs to `label` (0..1), independent of meaning. */
  score: number
}

export interface TableColumn {
  index: number
  /** Horizontal extent of the column. */
  x0: number
  x1: number
  header: TextRef | null
}

export type TableRowKind = 'header' | 'item' | 'continuation' | 'summary' | 'other'

export interface TableRow {
  index: number
  page: number
  kind: TableRowKind
  /** One entry per column; null when the cell is empty. */
  cells: (TextRef | null)[]
  bbox: BBox
}

export interface Table {
  id: string
  /** What the table lists: the invoice lines, payments received (receipts), a tax breakdown, or
   *  something else (meter readings, delivery notes, usage history). */
  role: 'items' | 'payments' | 'tax' | 'other'
  /** Pages the table spans, in order. */
  pages: number[]
  columns: TableColumn[]
  rows: TableRow[]
  bbox: BBox
  score: number
}

export interface Structure {
  keyValues: KeyValue[]
  tables: Table[]
}

// ---------------------------------------------------------------------------------------------
// Layer 3: meaning

/**
 * The standard invoice concepts. Party fields are dotted. Field meanings are strict: `total` is
 * the invoice's full value including tax; `amount_due` is what is still payable (total minus
 * prepayments/credits); they are different fields even when equal on a given invoice.
 */
export const CANONICAL_FIELDS = [
  'document_type',
  'invoice_number',
  'invoice_date',
  'due_date',
  'delivery_date',
  'po_number',
  /** Israel Tax Authority allocation number (מספר הקצאה). */
  'allocation_number',
  'currency',
  'subtotal',
  'discount',
  'tax_rate',
  'tax_amount',
  'total',
  'amount_paid',
  'amount_due',
  'rounding',
  'payment_terms',
  'supplier.name',
  'supplier.tax_id',
  'supplier.address',
  'supplier.phone',
  'supplier.email',
  'supplier.bank_account',
  'customer.name',
  'customer.tax_id',
  'customer.address',
] as const

export type CanonicalField = (typeof CANONICAL_FIELDS)[number]

export const MONEY_FIELDS = ['subtotal', 'discount', 'tax_amount', 'total', 'amount_paid', 'amount_due', 'rounding'] as const
export type MoneyField = (typeof MONEY_FIELDS)[number]

export const DOCUMENT_TYPES = [
  'invoice',
  'tax_invoice',
  'tax_invoice_receipt',
  'receipt',
  'credit_note',
  'debit_note',
  'proforma',
  'quote',
  'transaction_account',
  'utility_bill',
] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** Exact decimal as a string: optional '-', digits, optional '.digits'. Never a JS float. */
export type DecimalString = string

export type NormalizedValue =
  | { kind: 'money'; amount: DecimalString; currency: string | null }
  | { kind: 'percent'; value: DecimalString }
  | { kind: 'decimal'; value: DecimalString }
  /** `alternatives` holds other readings when the format is ambiguous (03/04/2026). */
  | { kind: 'date'; iso: string; alternatives: string[] }
  | { kind: 'currency'; code: string }
  | { kind: 'document_type'; value: DocumentType }
  /** Tax/company ids: digits/letters only; `checksum` is true/false when a scheme applies, else null. */
  | { kind: 'id'; value: string; scheme: string | null; checksum: boolean | null }
  | { kind: 'text'; value: string }

export interface Evidence {
  page: number
  wordIds: string[]
  text: string
  bbox: BBox
}

/** One possible reading of a standard field, before validation chooses. */
export interface FieldCandidate {
  id: string
  field: CanonicalField
  rawValue: string
  normalized: NormalizedValue
  /** Where the value is written. Empty only for values that are not on the document (never here). */
  evidence: Evidence[]
  /** The label it was read from, if any. */
  label: Evidence | null
  originalLabel: string | null
  /** Prior belief from interpretation (label match strength, layout, position, format), 0..1. */
  score: number
  /** How it was found, e.g. 'kv:inline', 'table:summary-row', 'header:top-block', 'pattern:free-text'. */
  method: string
  /** Short machine-readable reasons, e.g. 'label:exact', 'near:total-block', 'format:checksum-ok'. */
  signals: string[]
}

export interface LineItemCandidate {
  index: number
  row: TextRef
  description: FieldCandidateLite | null
  quantity: FieldCandidateLite | null
  unitPrice: FieldCandidateLite | null
  amount: FieldCandidateLite | null
  taxRate: FieldCandidateLite | null
  discount: FieldCandidateLite | null
  sku: FieldCandidateLite | null
  /** The remaining cells, keyed by the column header as printed (or `col{n}`). */
  extra: Record<string, FieldCandidateLite>
}

export interface FieldCandidateLite {
  rawValue: string
  normalized: NormalizedValue
  evidence: Evidence[]
}

// ---------------------------------------------------------------------------------------------
// Layer 4: validation and the final result

export type FieldStatus =
  /** Found on the document AND independently confirmed (arithmetic closure, checksum, unique
   *  unambiguous label with a well-formed value, …). Verified values must never be wrong. */
  | 'verified'
  /** Found on the document and plausible, but nothing independent confirms it. */
  | 'proposed'
  /** Conflicting candidates, a failed check, or a weak/ambiguous reading. A person should look. */
  | 'needs_review'

export interface ExtractedField {
  /** null for a discovered field whose meaning is unknown. */
  field: CanonicalField | null
  originalLabel: string | null
  labelEvidence: Evidence | null
  rawValue: string
  normalized: NormalizedValue | null
  evidence: Evidence[]
  confidence: number
  status: FieldStatus
  method: string
  /** Ids of validation checks that passed and involve this field. */
  checks: string[]
  /** Other readings that were considered, best first. */
  alternatives: { rawValue: string; normalized: NormalizedValue | null; evidence: Evidence[]; confidence: number }[]
}

export interface LineItem {
  index: number
  row: Evidence
  description: ExtractedField | null
  quantity: ExtractedField | null
  unitPrice: ExtractedField | null
  amount: ExtractedField | null
  taxRate: ExtractedField | null
  discount: ExtractedField | null
  sku: ExtractedField | null
  extra: Record<string, ExtractedField>
  status: FieldStatus
}

/** A value computed from other values, never written on the document. Kept apart on purpose. */
export interface DerivedValue {
  field: CanonicalField
  normalized: NormalizedValue
  /** e.g. 'total - amount_paid'. */
  formula: string
  inputs: CanonicalField[]
  note: string
}

export interface ValidationCheck {
  /** e.g. 'sum:subtotal+tax=total'. */
  id: string
  status: 'pass' | 'fail' | 'skipped'
  fields: CanonicalField[]
  expected: string | null
  actual: string | null
  message: string
}

export interface Issue {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  fields: CanonicalField[]
}

export interface ExtractionResult {
  schemaVersion: 1
  /** A: what is written, where. */
  document: DocumentModel
  structure: Structure
  /** B: the standard fields that were found. Missing keys were not found. */
  fields: Partial<Record<CanonicalField, ExtractedField>>
  lineItems: LineItem[]
  /** C: every other labelled value on the document, with a canonical meaning when one was recognised. */
  discovered: ExtractedField[]
  /** Line ids whose text ended up in no field, line item or discovered value. */
  unclassifiedLineIds: string[]
  derived: DerivedValue[]
  checks: ValidationCheck[]
  issues: Issue[]
  summary: {
    /** 'verified' only when every found standard field is verified and no error issue exists. */
    status: FieldStatus
    confidence: number
    missing: CanonicalField[]
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation

/**
 * Ground truth for one test document. Values are written the way the normalizer should produce
 * them: money/percent as plain decimals ("1180.00", "18"), dates ISO, currency ISO 4217, ids as
 * printed minus spaces/dashes, text as printed (whitespace collapsed).
 */
export interface GroundTruth {
  id: string
  /** PDF/image path relative to the truth file. */
  file: string
  languages: string[]
  /** What makes this document interesting (layout, terminology, traps). */
  notes: string
  fields: Partial<Record<CanonicalField, string>>
  /** Fields that are NOT on the document, so extracting anything for them is a hallucination. */
  absent: CanonicalField[]
  lineItems: { description: string; quantity?: string; unitPrice?: string; amount?: string }[]
  /** Labelled values outside the standard schema that must show up in `discovered`. */
  extra: { label: string; value: string }[]
  /**
   * Other printings of the same fact that are equally correct, e.g. the Hebrew and the English
   * legal name on a bilingual invoice. Only for genuinely duplicated facts, never for guesses.
   */
  alternatives?: Partial<Record<CanonicalField, string[]>>
}
