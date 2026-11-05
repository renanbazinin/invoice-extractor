import type { DocIndex } from '../../lib/docIndex'
import type { Table } from '../../model/types'
import { inferNumberFormat } from '../../semantic'
import type { BodyContext } from './body'
import { deskewIndex } from './deskew'
import { foldDetailRows } from './details'
import type { TableDraft } from './draft'
import { readHeader, splitTitles } from './header'
import { findHeaderless } from './headerless'
import { toTable } from './output'
import { continueTable, mergeAcrossPages } from './pages'
import { visualRows } from './rows'
import { cellKind } from './values'
import { fromHeader, headerBand, settleContinuations } from './titled'
import { demoteRunningTotals } from './totals'

export { attachContinuations, type Attachment, type GroupRow } from './group'
export { cellKind, embeddedQxP, isNumericKind, looseAmount, parseQxP, type CellKind, type QxPParse } from './values'

/**
 * Tables of a document (layer 2). Per page: visual rows are rebuilt from the reader's lines; a
 * row of column titles (lexicon-assisted, see header.ts) starts a table whose columns are the
 * titles' extents (titles the reader joined into one line are cut apart first); body rows are
 * placed into the columns in order and classified (item, continuation, summary, other) until the
 * table ends; section headings and section subtotals inside the body do not end it. Item lists
 * without titles are found by arithmetic (headerless.ts). A table that goes on over the next page
 * (with its titles repeated, or with rows that fit its columns) is one table. A till receipt's
 * "q × p" line under its item is a detail of that item (details.ts). Roles: items, payments,
 * tax, other.
 */
export function findTables(index: DocIndex): Table[] {
  // Geometry is read on an un-skewed view of scanned pages; evidence comes from the real words.
  const work = deskewIndex(index)
  const ctx: BodyContext = { index: work, fmt: inferNumberFormat(index.doc.lines.map((l) => l.text)) }
  const drafts: TableDraft[] = []
  // A titled table that ran into the end of the previous page and may go on without its titles.
  let open: TableDraft | null = null
  for (const page of index.doc.pages) {
    const rows = visualRows(work, page.number).map((r) => splitTitles(work, r))
    const lines = index.pageLines.get(page.number) ?? []
    const rtl = lines.filter((l) => l.dir === 'rtl').length * 2 >= lines.length && lines.length > 0
    const used = new Set<number>()
    const firstHeader = rows.findIndex((r) => readHeader(r))
    const carried: ReturnType<typeof continueTable> = open && open.pages[open.pages.length - 1] === page.number - 1 ? continueTable(ctx, open, rows, firstHeader < 0 ? rows.length : firstHeader) : null
    if (carried) {
      drafts.push(carried.draft)
      for (let k = carried.start; k < carried.next; k++) used.add(k)
    }
    open = null
    let i: number = carried ? carried.next : 0
    while (i < rows.length) {
      const reading = readHeader(rows[i])
      let built: ReturnType<typeof fromHeader> = reading ? fromHeader(ctx, rows, i, reading) : null
      let extra = 0
      if (!built) {
        // Titles of two or three lines whose lines are not headers on their own.
        const band = headerBand(ctx, rows, i)
        if (band) {
          const view = [...rows.slice(0, i), band.row, ...rows.slice(i + band.span)]
          built = fromHeader(ctx, view, i, band.reading)
          extra = band.span - 1
        }
      }
      if (!built) {
        i++
        continue
      }
      drafts.push(built.draft)
      for (let k = i; k < built.next + extra; k++) used.add(k)
      i = built.next + extra
      open = built.draft.endedBy === 'summary' || built.draft.endedBy === 'header' ? null : built.draft
    }
    if (carried && !open && carried.draft.endedBy !== 'summary' && carried.draft.endedBy !== 'header') open = carried.draft
    drafts.push(...findHeaderless(ctx, rows, used, rtl))
  }
  const merged = mergeAcrossPages(ctx, drafts)
  for (const d of merged) {
    foldDetailRows(ctx, d)
    demoteRunningTotals(ctx, d)
    settleContinuations(ctx, d)
  }
  const kept = merged.filter((d) => d.rows.some((r) => r.kind === 'item'))
  return kept.map((d, n) => toTable(index, d, n))
}

/**
 * Lines inside table bodies: header, item, continuation and other rows that carry a figure (page
 * totals, carried-forward figures, section subtotals: never the document's totals). Summary rows
 * are left to key/value detection, since the document's totals are label/value pairs, and so are
 * headings without figures: a section heading can name a labelled fact ("Albarán ALB-26-3381 de
 * 02/10/2026") that is not part of any line.
 */
export function tableBodyLineIds(index: DocIndex, tables: readonly Table[]): Set<string> {
  const out = new Set<string>()
  const fmt = inferNumberFormat(index.doc.lines.map((l) => l.text))
  for (const t of tables) {
    for (const r of t.rows) {
      if (r.kind === 'summary') continue
      if (r.kind === 'other' && !r.cells.some((c) => c && ['money', 'number', 'percent', 'qxp'].includes(cellKind(c.text, fmt)))) continue
      for (const c of r.cells) for (const id of c?.wordIds ?? []) out.add(index.word.get(id)!.lineId)
    }
    for (const col of t.columns) for (const id of col.header?.wordIds ?? []) out.add(index.word.get(id)!.lineId)
  }
  return out
}
