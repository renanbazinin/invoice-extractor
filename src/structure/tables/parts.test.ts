import { describe, expect, it } from 'vitest'
import { assignCells } from './assign'
import { attachContinuations, type GroupRow } from './group'
import { headerCell, readHeader } from './header'
import { looksLikePayment, rowLabel } from './labels'
import type { Cell, VisualRow } from './rows'
import { cellKind, looseAmount, parseQxP } from './values'

const box = (x0: number, x1: number, y0 = 0, y1 = 10) => ({ x0, x1, y0, y1 })
const cell = (text: string, x0 = 0, x1 = 50, y0 = 0): Cell => ({ page: 1, lineId: 'l', wordIds: [], text, bbox: box(x0, x1, y0, y0 + 10) })
const row = (...cells: Cell[]): VisualRow => ({ page: 1, cells, bbox: box(Math.min(...cells.map((c) => c.bbox.x0)), Math.max(...cells.map((c) => c.bbox.x1))) })

describe('parseQxP', () => {
  it('reads quantity × price in its printed order', () => {
    const q = parseQxP('1.250 x 9.90')!
    expect([q.qty.raw, q.price.raw]).toEqual(['1.250', '9.90'])
    expect(parseQxP('3 @ 5.00')!.qty.raw).toBe('3')
    expect(parseQxP('2×₪9.90')!.price.raw).toBe('9.90')
  })

  it('reads the order an RTL page shows when the numbers are not isolated ("x price qty")', () => {
    const q = parseQxP('x 17.00 5.00')!
    expect([q.qty.raw, q.price.raw]).toEqual(['5.00', '17.00'])
  })

  it('rejects sizes and anything else', () => {
    expect(parseQxP('60x60')).toBeNull()
    expect(parseQxP('לוח מחיק 90x120')).toBeNull()
    expect(parseQxP('12.50')).toBeNull()
  })
})

describe('cellKind', () => {
  it('tells money, numbers, codes, percents, dates and text apart', () => {
    expect(cellKind('₪ 81.80')).toBe('money')
    expect(cellKind('7.038,00 €', { decimal: ',', group: '.', confidence: 1 })).toBe('money')
    expect(cellKind('3')).toBe('number')
    expect(cellKind("10 יח'")).toBe('number')
    expect(cellKind('SK-7556')).toBe('code')
    expect(cellKind('5179801380624')).toBe('code')
    expect(cellKind('18%')).toBe('percent')
    expect(cellKind('18/03/2025')).toBe('date')
    expect(cellKind('לוחות גבס 12.5 מ"מ')).toBe('text')
    expect(cellKind('4.500 x 9.44')).toBe('qxp')
    expect(cellKind('ILS')).toBe('symbol')
  })

  it('reads an amount next to a scan\'s stray letters, never two numbers or a long label', () => {
    expect(looseAmount('ספט 4,271.20')?.amount).toBe('4271.20')
    expect(looseAmount('סה"כ לתשלום 1,000.00')).toBeNull()
    expect(looseAmount('2 x 4.00')).toBeNull()
  })
})

describe('assignCells', () => {
  const cols = [box(40, 60), box(150, 200), box(290, 306), box(440, 462)]
  const opts = { skipCost: 120, shareCost: 100 }

  it('keeps the order of cells and columns, even when a cell is nearer a neighbour\'s title', () => {
    // A right-aligned description far from its centred title.
    const cells = [box(40, 80), box(150, 180), box(288, 300), box(470, 553)]
    expect(assignCells(cells, cols, opts)).toEqual([0, 1, 2, 3])
  })

  it('leaves out a cell far beyond every column', () => {
    expect(assignCells([box(40, 80), box(900, 950)], cols, opts)).toEqual([0, -1])
  })
})

describe('attachContinuations', () => {
  const r = (kind: GroupRow['kind'], y0: number, y1: number, hasDescription = true): GroupRow => ({ kind, page: 1, bbox: box(0, 100, y0, y1), hasDescription })

  it('attaches a line under its item, and a name above a row without one', () => {
    const rows = [r('item', 100, 110), r('continuation', 112, 121), r('continuation', 135, 143), r('item', 147, 155, false)]
    expect(attachContinuations(rows)).toEqual([
      { row: 1, item: 0 },
      { row: 2, item: 3 },
    ])
  })

  it('attaches lines around numbers centred in a tall cell', () => {
    const rows = [r('continuation', 100, 110), r('item', 106, 116, false), r('continuation', 113, 123)]
    expect(attachContinuations(rows).map((a) => a.item)).toEqual([1, 1])
  })

  it('leaves a heading between items unattached', () => {
    const rows = [r('item', 100, 110), r('continuation', 125, 135), r('item', 140, 150)]
    expect(attachContinuations(rows)).toEqual([{ row: 1, item: -1 }])
  })

  it('attaches a first line printed tight above numbers on the last line of a description', () => {
    const rows = [r('item', 100, 110), r('continuation', 125, 135), r('item', 137, 147)]
    expect(attachContinuations(rows)).toEqual([{ row: 1, item: 2 }])
  })
})

describe('headers and labels', () => {
  it('reads the column concept of a title, preferring the column reading of "סה"כ"', () => {
    expect(headerCell(cell('סה"כ')).column).toBe('col.line_amount')
    expect(headerCell(cell('קוד פריט / Item')).column).toBe('col.sku')
    expect(headerCell(cell("יח' מידה")).column).toBe('col.unit')
  })

  it('recognises item and payments headers, not a totals bar', () => {
    expect(readHeader(row(cell('Amount', 500), cell('Qty', 300), cell('Description', 40)))?.kind).toBe('items')
    expect(readHeader(row(cell('סכום'), cell('תאריך'), cell("מס' צ'ק"), cell('אמצעי תשלום')))?.kind).toBe('payments')
    expect(readHeader(row(cell('סה"כ כולל מע"מ'), cell('מע"מ'), cell('סכום ביניים')))).toBeNull()
    expect(readHeader(row(cell('תיאור'), cell('81.80')))).toBeNull()
  })

  it('labels totals, page totals and payments', () => {
    expect(rowLabel([cell('סה"כ ללא מע"מ:'), cell('4,958.77')])?.kind).toBe('summary')
    expect(rowLabel([cell('סה"כ חיוב לתקופה')])?.kind).toBe('summary')
    expect(rowLabel([cell('מועבר לעמוד הבא')])?.kind).toBe('page')
    expect(rowLabel([cell('הנחה')])?.soft).toBe(true)
    expect(rowLabel([cell('כיסא משרדי ארגונומי')])).toBeNull()
    expect(looksLikePayment('ויזה ****9994')).toBe(true)
    expect(looksLikePayment('Transport Tel Aviv - Haifa')).toBe(false)
  })
})
