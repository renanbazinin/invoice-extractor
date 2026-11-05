import { add, dec, eq, fromInt, type Dec } from '../../lib/decimal'
import { parseAmount } from '../../semantic'
import { collectBody, placeRow, type BodyContext } from './body'
import type { RowDraft, TableDraft } from './draft'
import { rowLabel } from './labels'
import type { VisualRow } from './rows'
import { cellKind, isNumericKind } from './values'

/**
 * Tables that run over several pages. A table that stops at the end of a page without its totals
 * and a table at the top of the next page with the same column titles (the repeated header) are
 * one table; its pages are listed in order and its rows concatenated. Rows at the foot of a page
 * that only repeat the running sum ("סה"כ לעמוד", "להעברה", "Übertrag") are not the document's
 * totals: they become 'other' and the table goes on.
 */
export function mergeAcrossPages(ctx: BodyContext, drafts: readonly TableDraft[]): TableDraft[] {
  const sorted = [...drafts].sort((a, b) => a.pages[0] - b.pages[0] || a.rows[0].row.bbox.y0 - b.rows[0].row.bbox.y0)
  const out: TableDraft[] = []
  const firstOnPage = new Map<number, TableDraft>()
  for (const d of sorted) if (!firstOnPage.has(d.pages[0])) firstOnPage.set(d.pages[0], d)
  for (const d of sorted) {
    const prev = out[out.length - 1]
    if (prev && firstOnPage.get(d.pages[0]) === d && continues(ctx, prev, d)) {
      for (const r of pageFoot(ctx, prev) ?? []) r.kind = 'other'
      prev.rows.push(...d.rows)
      for (const p of d.pages) if (!prev.pages.includes(p)) prev.pages.push(p)
      prev.endedBy = d.endedBy
      continue
    }
    out.push(d)
  }
  return out
}

/** Same kind, next page, no document totals yet, and the same column titles in the same order. */
function continues(ctx: BodyContext, a: TableDraft, b: TableDraft): boolean {
  if (b.pages[0] !== a.pages[a.pages.length - 1] + 1) return false
  if (a.kind !== b.kind || a.kind === 'headerless') return false
  if (!pageFoot(ctx, a)) return false
  if (a.columns.length !== b.columns.length) return false
  let same = 0
  a.columns.forEach((c, i) => {
    if (c.concept === b.columns[i].concept) same++
  })
  return same >= Math.max(2, a.columns.length - 1)
}

/**
 * The rows after the last item of a table when every one of them repeats the running sum (of the
 * whole table so far or of its last page): a page foot. Null when a row says anything else (a
 * VAT line, a total that differs: the document's totals).
 */
function pageFoot(ctx: BodyContext, d: TableDraft): RowDraft[] | null {
  const amountCol = d.columns.findIndex((c) => c.concept === 'col.line_amount')
  let last = -1
  d.rows.forEach((r, i) => {
    if (r.kind === 'item') last = i
  })
  const tail = d.rows.slice(last + 1).filter((r) => r.kind === 'summary' || r.kind === 'other')
  const summaries = tail.filter((r) => r.kind === 'summary')
  if (!summaries.length) return tail
  if (amountCol < 0) return null
  const lastPage = d.rows[last]?.page
  let total: Dec = fromInt(0)
  let pageSum: Dec = fromInt(0)
  for (const r of d.rows.slice(0, last + 1)) {
    if (r.kind !== 'item') continue
    const a = amountOf(ctx, r, amountCol)
    if (!a) continue
    total = add(total, a)
    if (r.page === lastPage) pageSum = add(pageSum, a)
  }
  for (const r of summaries) {
    const a = amountOf(ctx, r, amountCol)
    if (!a || !(eq(a, total) || eq(a, pageSum))) return null
  }
  return tail
}

function amountOf(ctx: BodyContext, r: RowDraft, col: number): Dec | null {
  const cell = r.cells[col]?.[0]
  const p = cell ? parseAmount(cell.text, ctx.fmt) : null
  return p ? dec(p.amount) : null
}

/**
 * The rows at the top of a page that go on with a table from the previous page that printed no
 * titles again: the first rows that fit the table's columns as items (numbers in at least two of
 * its number columns, every cell over a column), with the carried-forward line just above them.
 */
export function continueTable(ctx: BodyContext, open: TableDraft, rows: readonly VisualRow[], limit: number): { draft: TableDraft; start: number; next: number } | null {
  const columns = open.columns.map((c) => ({ ...c, header: [...c.header] }))
  const lineH = open.lineHeight
  const numeric = new Set(['col.line_amount', 'col.unit_price', 'col.quantity'])
  let s = -1
  for (let k = 0; k < Math.min(limit, 10); k++) {
    const placed = placeRow(ctx, rows[k], columns, lineH, open.aside)
    if (placed.outside.length) continue
    const numbers = placed.cells.filter((list, j) => numeric.has(columns[j].concept ?? '') && list.some((c) => isNumericKind(cellKind(c.text, ctx.fmt)))).length
    const fits = placed.cells.every((list, j) => list.every((c) => Math.min(columns[j].x1, c.bbox.x1) - Math.max(columns[j].x0, c.bbox.x0) > 0))
    if (numbers >= 2 && fits) {
      s = k
      break
    }
  }
  if (s < 0) return null
  let start = s
  while (start > 0 && rowLabel(rows[start - 1].cells)?.kind === 'page') start--
  const body = collectBody(ctx, rows, start, columns, lineH, rows[start].bbox.y0 - lineH, open.aside)
  if (!body.rows.some((r) => r.kind === 'item')) return null
  const draft: TableDraft = { kind: open.kind, pages: [rows[start].page], columns, rows: body.rows, endedBy: body.endedBy, lineHeight: lineH, aside: open.aside }
  return { draft, start, next: start + body.rows.length }
}
