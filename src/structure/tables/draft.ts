import type { TableRowKind } from '../../model/types'
import type { Cell, VisualRow } from './rows'

/** A column while a table is being built. */
export interface ColumnDraft {
  /** Current horizontal extent (the header's, widened by the cells assigned to it). */
  x0: number
  x1: number
  /** Header cells (one per header line), top first. */
  header: Cell[]
  /** Lexicon column concept of the header ('col.quantity'…), or null when unknown/absent. */
  concept: string | null
}

export interface RowDraft {
  row: VisualRow
  page: number
  kind: TableRowKind
  /** Cells per column (usually zero or one). */
  cells: Cell[][]
}

export type TableKind = 'items' | 'payments' | 'headerless'

export interface TableDraft {
  kind: TableKind
  pages: number[]
  columns: ColumnDraft[]
  rows: RowDraft[]
  /** Why the body stopped: a totals block, the end of the page, a gap, other content, another header. */
  endedBy: 'summary' | 'page' | 'gap' | 'content' | 'header'
  /** Typical text height in the table. */
  lineHeight: number
  /** Extents of a side box printed beside the table (its cells are not the table's). */
  aside?: { x0: number; x1: number }[]
}

/** Concepts whose columns hold numbers (amounts, prices, quantities, rates). */
export const NUMERIC_CONCEPTS: ReadonlySet<string> = new Set(['col.line_amount', 'col.unit_price', 'col.quantity', 'col.discount', 'col.tax_rate'])

/** Concepts whose columns hold text or codes. */
export const TEXT_CONCEPTS: ReadonlySet<string> = new Set(['col.description', 'col.sku', 'col.unit', 'col.line_number'])
