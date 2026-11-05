import { evidenceOf, type DocIndex } from '../../lib/docIndex'
import { union } from '../../lib/geometry'
import type { Table, TableColumn, TableRow, TextRef } from '../../model/types'
import type { TableDraft } from './draft'
import { tableRole } from './role'
import type { Cell } from './rows'

/** Drafts → the contract's Table: cells as TextRefs built from the document's real words. */

/** The words of a column's cells in a row, top to bottom and in reading order. */
function joinCells(index: DocIndex, cells: readonly Cell[], rtl: boolean): TextRef | null {
  if (!cells.length) return null
  const sorted = [...cells].sort((a, b) => a.bbox.y0 - b.bbox.y0 || (rtl ? b.bbox.x1 - a.bbox.x1 : a.bbox.x0 - b.bbox.x0))
  return evidenceOf(index, sorted.flatMap((c) => c.wordIds))
}

/** Structural confidence: titled tables with known column concepts and an amount column score higher. */
function tableScore(d: TableDraft): number {
  if (d.kind === 'headerless') return 0.6
  const strong = d.columns.filter((c) => c.concept && c.header.length).length
  const amount = d.columns.some((c) => c.concept === 'col.line_amount') ? 0.1 : 0
  return Math.min(0.95, 0.5 + 0.1 * Math.min(3, strong) + amount)
}

/** A draft as the contract's Table (ids t1, t2, … in document order). */
export function toTable(index: DocIndex, d: TableDraft, n: number): Table {
  const rtl = d.rows.some((r) => r.row.cells.some((c) => index.line.get(c.lineId)?.dir === 'rtl'))
  const columns: TableColumn[] = d.columns.map((c, i) => ({ index: i, x0: c.x0, x1: c.x1, header: joinCells(index, c.header, rtl) }))
  const rows: TableRow[] = d.rows.map((r, i) => {
    const cells = r.cells.map((list) => joinCells(index, list, rtl))
    const boxes = cells.filter((c): c is TextRef => !!c).map((c) => c.bbox)
    return { index: i, page: r.page, kind: r.kind, cells, bbox: boxes.length ? union(boxes) : r.row.bbox }
  })
  const first = rows.filter((r) => r.page === d.pages[0]).map((r) => r.bbox)
  return { id: `t${n + 1}`, role: tableRole(d), pages: [...d.pages], columns, rows, bbox: union(first), score: tableScore(d) }
}
