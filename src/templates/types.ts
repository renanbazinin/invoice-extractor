/**
 * Templates sit after the four layers and never change what they found. There are two kinds:
 *
 *   export    where the data goes: which values, in which columns, in which file format.
 *   supplier  what one supplier's invoices need: values its layout hides from the generic
 *             reader (a label it prints, a box on the page), fixed facts (its legal name), and
 *             the export template its invoices go to.
 *
 * A template is plain JSON, so templates can be stored, copied ("forked") and shared as files.
 * Values a template supplies are never 'verified': the template is a person's rule about a
 * layout, not an independent check of this document.
 */
import type { BBox, CanonicalField } from '../model/types'

export type TemplateKind = 'export' | 'supplier'

interface TemplateBase {
  /** 'builtin:<slug>' for templates shipped with the app, otherwise a random id. */
  id: string
  kind: TemplateKind
  name: string
  description: string
  /** The template this one was copied from, if any. */
  forkedFrom?: string
  /** ISO time of the last change (user templates). */
  updated?: string
}

// ---------------------------------------------------------------------------------------------
// Export templates

export type LineProp = 'index' | 'description' | 'quantity' | 'unitPrice' | 'amount' | 'taxRate' | 'discount' | 'sku'
export type MetaProp = 'fileName' | 'pageCount' | 'status' | 'confidence' | 'textLayer' | 'supplierTemplate' | 'lineCount'
/** What a field column shows: the value, the text as printed, its status, or its confidence. */
export type FieldPart = 'value' | 'raw' | 'status' | 'confidence'

export type ColumnSource =
  | { type: 'field'; field: CanonicalField; part?: FieldPart }
  | { type: 'line'; prop: LineProp }
  | { type: 'meta'; prop: MetaProp }
  | { type: 'constant'; value: string }
  /** A labelled value outside the standard fields, by its printed label ("מספר רכב"). */
  | { type: 'other'; label: string }

export interface Column {
  header: string
  source: ColumnSource
}

export interface ExportOptions {
  /** How dates are written. Excel files get real dates in this display format. */
  dateFormat: 'iso' | 'dd/mm/yyyy' | 'mm/dd/yyyy'
  /** Decimal separator for numbers in text formats (CSV, JSON keep numbers as numbers). */
  decimal: '.' | ','
  /** CSV only. */
  delimiter: ',' | ';' | '\t'
  /** What to do with values that are not verified: export them, or leave the cell empty. */
  unverified: 'keep' | 'blank'
  /** Add a "<column> status" column after every field column. */
  statusColumns: boolean
  /** Excel only: colour cells whose value is not verified (amber: proposed, red: needs review). */
  highlight: boolean
}

export interface ExportTemplate extends TemplateBase {
  kind: 'export'
  format: 'csv' | 'xlsx' | 'json'
  /** One row per document, or one per line item (document values repeat on each line). */
  rows: 'invoice' | 'line'
  columns: Column[]
  options: ExportOptions
}

// ---------------------------------------------------------------------------------------------
// Supplier templates

/** A box on a page, as fractions of the page's width and height (0..1). */
export interface PageBox {
  page: number
  box: BBox
}

export interface SupplierTemplate extends TemplateBase {
  kind: 'supplier'
  /** The template applies to a document that prints one of these tax ids, or names. */
  match: { taxIds: string[]; names: string[] }
  /** Facts about the supplier that hold on every invoice ("supplier.name" → its legal name). */
  fixed: Partial<Record<CanonicalField, string>>
  /** Printed labels this supplier uses for a field ("אסמכתא" → invoice_number). */
  labels: { label: string; field: CanonicalField }[]
  /** Where this supplier prints a field, taught by clicking the words on one of its invoices. */
  regions: ({ field: CanonicalField } & PageBox)[]
  /** The export template this supplier's invoices go to, or null for the default one. */
  exportTemplateId: string | null
}

export type Template = ExportTemplate | SupplierTemplate
