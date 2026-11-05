import type { Span1d } from './assign'
import { collectBody, placeRow, widenColumns, type BodyContext } from './body'
import { TEXT_CONCEPTS, type ColumnDraft, type RowDraft, type TableDraft } from './draft'
import { attachContinuations } from './group'
import { headerCell, isHeaderContinuation, isTitleLine, readHeader, type HeaderReading } from './header'
import { clusterColumns } from './headerless'
import { rowLabel } from './labels'
import { cellOfWords, lineHeight, rowOfCells, type Cell, type VisualRow } from './rows'
import { cellKind, isNumericKind } from './values'

/**
 * Tables that start with a row of column titles: the columns are the titles' extents (plus
 * untitled columns found under them), titles may take two lines (stacked languages, wrapped
 * titles), and the body is read under them until the table ends.
 */

/**
 * The table under the title row `rows[i]`: its columns, an optional second title line, untitled
 * columns, and the body. Null when no item row follows (the titles were something else). `next`
 * is the first page row the table did not take.
 */
export function fromHeader(ctx: BodyContext, rows: readonly VisualRow[], i: number, reading: HeaderReading): { draft: TableDraft; next: number } | null {
  const head = rows[i]
  const lineH = lineHeight(head.cells)
  const columns: ColumnDraft[] = reading.cells
    .map((h) => ({ x0: h.cell.bbox.x0, x1: h.cell.bbox.x1, header: [h.cell], concept: h.column && h.coverage >= 0.5 ? h.column : null }))
    .sort((a, b) => a.x0 - b.x0)
  const headerRows: RowDraft[] = [{ row: head, page: head.page, kind: 'header', cells: columns.map((c) => [...c.header]) }]
  let k = i + 1
  let bottom = head.bbox.y1
  // Stacked titles (a second language under the first).
  if (k < rows.length && rows[k].bbox.y0 - head.bbox.y1 <= 0.8 * lineH && isHeaderContinuation(rows[k], head)) {
    const second = rows[k]
    const perCol = columns.map((): Cell[] => [])
    for (const c of second.cells) {
      let best = 0
      let bestOv = -Infinity
      columns.forEach((col, j) => {
        const ov = Math.min(col.x1, c.bbox.x1) - Math.max(col.x0, c.bbox.x0)
        if (ov > bestOv) {
          bestOv = ov
          best = j
        }
      })
      columns[best].header.push(c)
      perCol[best].push(c)
      if (!columns[best].concept) {
        const h = headerCell(c)
        if (h.column && h.coverage >= 0.5) columns[best].concept = h.column
      }
    }
    headerRows.push({ row: second, page: second.page, kind: 'header', cells: perCol })
    bottom = second.bbox.y1
    k++
  }
  discoverColumns(ctx, rows, k, columns, lineH, bottom, reading.aside)
  for (const h of headerRows) h.cells = columns.map((c) => c.header.filter((x) => h.row.cells.includes(x)))
  const body = collectBody(ctx, rows, k, columns, lineH, bottom, reading.aside)
  if (!body.rows.some((r) => r.kind === 'item')) return null
  widenColumns(columns, body.rows)
  const draft: TableDraft = {
    kind: reading.kind,
    pages: [head.page],
    columns,
    rows: [...headerRows, ...body.rows],
    endedBy: body.endedBy,
    lineHeight: lineH,
    aside: reading.aside,
  }
  // Rows dropped from the end (notes after the last item) go back to the page.
  const taken = trimTail(ctx, draft)
  return { draft, next: k + taken }
}


/**
 * A header printed over two or three lines where no line is a header by itself ("Unit" over
 * "Price" next to a one-line "Description", or titles centred vertically in a tall header cell):
 * consecutive close rows of labels are read as one row, cells stacked in one column joined top
 * to bottom.
 */
export function headerBand(ctx: BodyContext, rows: readonly VisualRow[], i: number): { row: VisualRow; reading: HeaderReading; span: number } | null {
  const first = rows[i]
  // The first line already names a column (a document title or a note above the table does not),
  // and every line of the band is made of titles or short fragments of them.
  if (!isTitleLine(first) || !first.cells.some((c) => headerCell(c).column)) return null
  const band = [first]
  let bottom = first.bbox.y1
  while (band.length < 3 && i + band.length < rows.length) {
    const next = rows[i + band.length]
    // Lines of one title cell are set tight.
    const lineH = Math.min(lineHeight(first.cells), lineHeight(next.cells))
    if (next.bbox.y0 - bottom > 0.5 * lineH || !isTitleLine(next)) break
    // When the next line already reads as the column titles, the lines above join it only as
    // wrapped fragments of titles ("Unit" over "Price"), never as a labelled line of their own
    // ("סיבת הזיכוי הנחה בדיעבד" over "מס'").
    if (readHeader(next) && band.some((r) => r.cells.some((c) => c.text.trim().split(/\s+/).length > 2))) break
    band.push(next)
    bottom = Math.max(bottom, next.bbox.y1)
  }
  // The widest band that reads as a header.
  for (let span = band.length; span >= 2; span--) {
    const row = rowOfCells(stackCells(ctx, band.slice(0, span).flatMap((r) => r.cells)))
    const reading = readHeader(row)
    if (reading) return { row, reading, span }
  }
  return null
}

/** Joins cells that sit one above the other (they overlap horizontally) into one cell, top first. */
function stackCells(ctx: BodyContext, cells: readonly Cell[]): Cell[] {
  const out: Cell[] = []
  for (const c of [...cells].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const j = out.findIndex((o) => {
      const ov = Math.min(o.bbox.x1, c.bbox.x1) - Math.max(o.bbox.x0, c.bbox.x0)
      return ov > 0 && ov >= 0.5 * Math.min(o.bbox.x1 - o.bbox.x0, c.bbox.x1 - c.bbox.x0)
    })
    if (j >= 0) out[j] = cellOfWords(ctx.index, out[j].lineId, [...out[j].wordIds, ...c.wordIds])
    else out.push(c)
  }
  return out
}

/**
 * Columns without a title: cells that line up under no header cell in several of the first body
 * rows (a title the scan lost, an untitled code or line-number column) become columns of their
 * own, so the rows are not cut short or squeezed into a neighbour. A cell is unexplained when no
 * column takes it, or when it has to share a column with another cell of its row (the one
 * farther from the column's title).
 */
function discoverColumns(ctx: BodyContext, rows: readonly VisualRow[], start: number, columns: ColumnDraft[], lineH: number, top: number, aside: readonly Span1d[]): void {
  const strays: Cell[] = []
  let bottom = top
  let sampled = 0
  for (let k = start; k < rows.length && sampled < 6; k++) {
    const row = rows[k]
    if (row.bbox.y0 - bottom > 3 * lineH || readHeader(row) || rowLabel(row.cells)) break
    const placed = placeRow(ctx, row, columns, lineH, aside)
    strays.push(...placed.outside.filter((c) => cellKind(c.text, ctx.fmt) !== 'symbol'))
    placed.cells.forEach((list, j) => {
      if (list.length < 2) return
      const centre = (columns[j].x0 + columns[j].x1) / 2
      const far = [...list].sort((a, b) => Math.abs((b.bbox.x0 + b.bbox.x1) / 2 - centre) - Math.abs((a.bbox.x0 + a.bbox.x1) / 2 - centre))
      strays.push(...far.slice(0, list.length - 1))
    })
    bottom = row.bbox.y1
    sampled++
  }
  for (const k of clusterColumns(strays)) {
    const fromRows = new Set(k.cells.map((c) => Math.round(c.bbox.y0))).size
    if (fromRows < 2) continue
    if (columns.some((c) => Math.min(c.x1, k.x1) - Math.max(c.x0, k.x0) > 0)) continue
    columns.push({ x0: k.x0, x1: k.x1, header: [], concept: null })
  }
  columns.sort((a, b) => a.x0 - b.x0)
}

/** Whether a row has description text of its own (not only numbers or "2 x 9.90"). */
function hasDescription(ctx: BodyContext, d: TableDraft, r: RowDraft): boolean {
  const descCol = d.columns.findIndex((c) => c.concept === 'col.description')
  const cells = descCol >= 0 ? r.cells[descCol] : r.cells.flat()
  return cells.some((c) => cellKind(c.text, ctx.fmt) === 'text')
}

/**
 * Text-only rows become continuations of the item they belong to (by proximity), or 'other'
 * when they belong to none (a heading, a note).
 */
export function settleContinuations(ctx: BodyContext, d: TableDraft): void {
  const groups = d.rows.map((r) => ({ kind: r.kind, page: r.page, bbox: r.row.bbox, hasDescription: hasDescription(ctx, d, r) }))
  for (const a of attachContinuations(groups)) if (a.item < 0) d.rows[a.row].kind = 'other'
}

/**
 * Drops text rows at the end of the body that no item claims (a note or a paragraph after the
 * table), so key/value detection still sees them. Returns how many body rows were kept.
 */
function trimTail(ctx: BodyContext, d: TableDraft): number {
  const header = d.rows.filter((r) => r.kind === 'header').length
  settleContinuations(ctx, d)
  let lastItem = -1
  d.rows.forEach((r, i) => {
    if (r.kind === 'item') lastItem = i
  })
  let end = d.rows.length
  for (let i = lastItem + 1; i < d.rows.length; i++) {
    const r = d.rows[i]
    if (r.kind === 'continuation' || r.kind === 'summary') continue
    if (r.kind === 'other' && r.row.cells.some((c) => cellKind(c.text, ctx.fmt) === 'text') && !isPageRow(ctx, d, r)) {
      end = i
      break
    }
  }
  if (end < d.rows.length) {
    d.rows = d.rows.slice(0, end)
    d.endedBy = 'content'
  }
  return d.rows.length - header
}

/**
 * Page totals and carried-forward rows carry an amount in a numbers column; headings and notes
 * do not (an account number inside a note is text in the text column).
 */
function isPageRow(ctx: BodyContext, d: TableDraft, r: RowDraft): boolean {
  return r.cells.some((list, j) => {
    const concept = d.columns[j].concept
    return !(concept && TEXT_CONCEPTS.has(concept)) && list.some((c) => isNumericKind(cellKind(c.text, ctx.fmt)))
  })
}

