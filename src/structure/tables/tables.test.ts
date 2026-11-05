import { describe, expect, it } from 'vitest'
import { indexDocument } from '../../lib/docIndex'
import type { Table } from '../../model/types'
import { findTables, tableBodyLineIds } from './index'
import { PageBuilder } from './testing'

const kinds = (t: Table): string[] => t.rows.map((r) => r.kind)
const texts = (t: Table, kind: string): string[] =>
  t.rows.filter((r) => r.kind === kind).map((r) => r.cells.map((c) => c?.text ?? '').filter(Boolean).join(' | '))

/** An RTL invoice: description on the right, amount on the left (as Hebrew invoices print). */
function hebrewInvoice(): PageBuilder {
  const b = new PageBuilder()
  b.line('חשבונית מס 1234', 250, 60)
  b.line('לכבוד: לקוח בע"מ', 555, 90, { right: true })
  b.row(120, [['סה"כ', 40], ['מחיר ליחידה', 150], ['כמות', 290], ['תיאור', 460]])
  b.row(140, [['₪ 81.80', 40], ['40.90', 150], ['2', 290], ['לוחות גבס', 555, true]])
  b.row(160, [['₪ 33.07', 40], ['66.14', 150], ['0.5', 290], ['עבודת טייח', 555, true]])
  b.line('עבור חודש ספטמבר', 555, 171, { right: true })
  b.row(190, [['₪ 302.70', 40], ['151.35', 150], ['2', 290], ['חול מחצבה', 555, true]])
  b.row(230, [['₪ 417.57', 40], ['סה"כ ללא מע"מ:', 150]])
  b.row(246, [['₪ 75.16', 40], ['מע"מ 18%:', 150]])
  b.row(262, [['₪ 492.73', 40], ['סה"כ כולל:', 150]])
  b.line('חתימה: ____', 555, 320, { right: true })
  return b
}

describe('findTables', () => {
  it('reads an RTL item table: header, items, a continuation line and the totals under it', () => {
    const doc = hebrewInvoice().build()
    const [t] = findTables(indexDocument(doc))
    expect(t.role).toBe('items')
    expect(kinds(t)).toEqual(['header', 'item', 'item', 'continuation', 'item', 'summary', 'summary', 'summary'])
    expect(texts(t, 'continuation')).toEqual(['עבור חודש ספטמבר'])
    expect(t.columns.map((c) => c.header?.text)).toEqual(['סה"כ', 'מחיר ליחידה', 'כמות', 'תיאור'])
    // The description cells (right-aligned, far from the centred title) are in the description column.
    expect(t.rows[1].cells[3]?.text).toBe('לוחות גבס')
  })

  it('hides the table body from key/value detection but leaves the totals', () => {
    const doc = hebrewInvoice().build()
    const index = indexDocument(doc)
    const ids = tableBodyLineIds(index, findTables(index))
    const textOf = (id: string) => index.line.get(id)!.text
    const hidden = [...ids].map(textOf)
    expect(hidden).toContain('לוחות גבס')
    expect(hidden).toContain('עבור חודש ספטמבר')
    expect(hidden).toContain('תיאור')
    expect(hidden).not.toContain('סה"כ ללא מע"מ:')
    expect(hidden).not.toContain('₪ 492.73')
    expect(hidden).not.toContain('לכבוד: לקוח בע"מ')
  })

  it('does not take a totals bar (labels row over amounts row) for an item table', () => {
    const b = new PageBuilder()
    b.row(100, [['סה"כ כולל מע"מ', 40], ['מע"מ', 150], ['שיעור מע"מ', 240], ['הנחה כללית', 330], ['סכום ביניים', 450]])
    b.row(118, [['ILS 5,685.97', 40], ['ILS 867.35', 150], ['18%', 240], ['-ILS 362.69', 330], ['ILS 5,181.31', 450]])
    expect(findTables(indexDocument(b.build()))).toEqual([])
  })

  it('does not take a label-above meta grid for a table', () => {
    const b = new PageBuilder()
    b.row(100, [['סכום לתשלום', 40], ['תאריך אספקה', 150], ['תאריך חשבונית', 300], ['מספר חשבונית', 450]])
    b.row(115, [['25,396.90', 40], ['29/12/2024', 150], ['10/01/2025', 300], ['20251310', 450]])
    expect(findTables(indexDocument(b.build()))).toEqual([])
  })

  it('reads an LTR table whose descriptions start far left of a centred title', () => {
    const b = new PageBuilder()
    b.row(240, [['Item Description', 140], ['Qty', 342], ['Price', 420], ['Amount', 525]])
    b.row(260, [['Printed PVC sign', 41], ['4.5', 354, true], ['130.00', 440, true], ['585.00', 554, true]])
    b.row(280, [['A2 poster print', 41], ['2', 354, true], ['40.84', 440, true], ['81.68', 554, true]])
    b.row(310, [['Sub-total:', 368], ['NIS 666.68', 554, true]])
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t)).toEqual(['header', 'item', 'item', 'summary'])
    expect(t.rows[1].cells[0]?.text).toBe('Printed PVC sign')
  })

  it('classifies a receipt payments table', () => {
    const b = new PageBuilder()
    b.row(100, [['סכום', 40], ['תאריך', 150], ["מס' צ'ק", 260], ['בנק', 380], ['אמצעי תשלום', 470]])
    b.row(120, [['₪ 6,252.00', 40], ['27-04-2025', 150], ['9916873', 260], ['12', 380], ['המחאה', 555, true]])
    b.row(140, [['₪ 14,587.86', 40], ['26-02-2025', 150], ['170000012', 260], ['העברה בנקאית', 555, true]])
    b.row(160, [['₪ 20,839.86', 40], ['סה"כ שולם:', 555, true]])
    const [t] = findTables(indexDocument(b.build()))
    expect(t.role).toBe('payments')
    expect(kinds(t)).toEqual(['header', 'item', 'item', 'summary'])
  })

  it('joins a table that goes on over the next page with a repeated header, and keeps page totals out of the items', () => {
    const b = new PageBuilder()
    const header = (y: number, page: number) => b.row(y, [['סכום', 40], ['מחיר', 120], ['כמות', 185], ['פרטים', 310]], { page })
    header(100, 1)
    b.row(120, [['100.00', 40], ['50.00', 120], ['2', 185], ['פילטר שמן', 400, true]])
    b.row(135, [['30.00', 40], ['10.00', 120], ['3', 185], ['נוזל קירור', 400, true]])
    b.row(150, [['130.00', 40], ['סה"כ בעמוד זה', 555, true]])
    b.row(165, [['130.00', 40], ['מועבר לעמוד הבא', 555, true]])
    header(60, 2)
    b.row(80, [['130.00', 40], ['מהעברה', 555, true]], { page: 2 })
    b.row(95, [['20.00', 40], ['20.00', 120], ['1', 185], ['פילטר אוויר', 400, true]], { page: 2 })
    b.row(130, [['₪ 150.00', 40], ['סכום ביניים:', 230]], { page: 2 })
    const tables = findTables(indexDocument(b.build()))
    expect(tables).toHaveLength(1)
    const [t] = tables
    expect(t.pages).toEqual([1, 2])
    expect(kinds(t)).toEqual(['header', 'item', 'item', 'other', 'other', 'header', 'other', 'item', 'summary'])
  })

  it('finds a till receipt list without a header and proves it by its total', () => {
    const b = new PageBuilder(227, 371)
    b.line('קבלה', 100, 40)
    b.row(60, [['15.90', 11], ['מיץ תפוזים 1 ליטר', 216, true]], { h: 8, cw: 4 })
    b.line('בננות', 216, 73, { right: true, h: 8, cw: 4 })
    b.row(85, [['42.48', 11], ['4.500 x 9.44', 216, true]], { h: 8, cw: 4 })
    b.row(98, [['8.90', 11], ['לחם אחיד פרוס', 216, true]], { h: 8, cw: 4 })
    b.row(125, [['67.28 NIS', 11], ['לתשלום', 216, true]], { h: 8, cw: 4 })
    b.row(140, [['70.00 NIS', 11], ['מזומן', 216, true]], { h: 8, cw: 4 })
    const [t] = findTables(indexDocument(b.build()))
    expect(t.role).toBe('items')
    expect(kinds(t)).toEqual(['item', 'continuation', 'item', 'item', 'summary'])
  })

  it('does not take payment lines that add up to the paid total for items', () => {
    const b = new PageBuilder(227, 371)
    b.row(60, [['329.30', 11], ['לתשלום', 216, true]], { h: 8, cw: 4 })
    b.row(80, [['132.00', 11], ['ביט', 216, true]], { h: 8, cw: 4 })
    b.row(92, [['99.00', 11], ["צ'ק 8106589", 216, true]], { h: 8, cw: 4 })
    b.row(104, [['98.30', 11], ['ויזה ****9994', 216, true]], { h: 8, cw: 4 })
    b.row(120, [['329.30', 11], ['שולם', 216, true]], { h: 8, cw: 4 })
    const tables = findTables(indexDocument(b.build()))
    expect(tables.filter((t) => t.role === 'items')).toEqual([])
  })

  it('reads titles printed over two lines, none of which is a header alone', () => {
    const b = new PageBuilder()
    b.row(100, [['Unit', 400], ['Line', 500]])
    b.row(106, [['Description', 40], ['Hours', 300]])
    b.row(110, [['Price', 400], ['Total', 500]])
    b.row(130, [['Design work', 40], ['3', 330, true], ['80.00', 430, true], ['240.00', 530, true]])
    b.row(150, [['Hosting', 40], ['1', 330, true], ['20.00', 430, true], ['20.00', 530, true]])
    const [t] = findTables(indexDocument(b.build()))
    expect(t.columns.map((c) => c.header?.text)).toEqual(['Description', 'Hours', 'Unit Price', 'Line Total'])
    expect(kinds(t)).toEqual(['header', 'item', 'item'])
  })

  it('ends the body at a totals line whose label the lexicon does not know but which sits outside the description column', () => {
    const b = new PageBuilder()
    b.row(100, [['Description', 40], ['Qty', 330], ['Price', 420], ['Amount', 520]])
    b.row(120, [['Design work', 40], ['3', 345, true], ['80.00', 445, true], ['240.00', 550, true]])
    b.row(150, [['Gesamt zzgl. Fracht', 330], ['265.00', 550, true]])
    b.row(165, [['Endbetrag inkl. allem', 330], ['300.00', 550, true]])
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t)).toEqual(['header', 'item', 'summary', 'summary'])
  })

  it('goes on over a page whose foot repeats the running sum under an unknown label', () => {
    const b = new PageBuilder()
    const header = (y: number, page: number) => b.row(y, [['סכום', 40], ['מחיר', 120], ['כמות', 185], ['פרטים', 310]], { page })
    header(100, 1)
    b.row(120, [['100.00', 40], ['50.00', 120], ['2', 185], ['פילטר שמן', 400, true]])
    b.row(135, [['30.00', 40], ['10.00', 120], ['3', 185], ['נוזל קירור', 400, true]])
    b.row(150, [['130.00', 40], ['להעברה', 555, true]])
    header(60, 2)
    b.row(80, [['20.00', 40], ['20.00', 120], ['1', 185], ['פילטר אוויר', 400, true]], { page: 2 })
    b.row(110, [['₪ 150.00', 40], ['סכום ביניים:', 230]], { page: 2 })
    const tables = findTables(indexDocument(b.build()))
    expect(tables).toHaveLength(1)
    expect(kinds(tables[0])).toEqual(['header', 'item', 'item', 'other', 'header', 'item', 'summary'])
  })

  it('goes on over a page that does not print the titles again', () => {
    const b = new PageBuilder()
    b.row(100, [['Description', 40], ['Qty', 330], ['Price', 420], ['Amount', 520]])
    b.row(120, [['Design work', 40], ['3', 345, true], ['80.00', 445, true], ['240.00', 550, true]])
    b.row(140, [['Hosting', 40], ['1', 345, true], ['20.00', 445, true], ['20.00', 550, true]])
    b.line('Page 2 of 2', 260, 30, { page: 2 })
    b.row(60, [['Support hours', 40], ['2', 345, true], ['50.00', 445, true], ['100.00', 550, true]], { page: 2 })
    b.row(90, [['Subtotal:', 400], ['360.00', 550, true]], { page: 2 })
    const tables = findTables(indexDocument(b.build()))
    expect(tables).toHaveLength(1)
    expect(tables[0].pages).toEqual([1, 2])
    expect(kinds(tables[0])).toEqual(['header', 'item', 'item', 'item', 'summary'])
  })

  it('leaves a lone list of label/value pairs alone', () => {
    const b = new PageBuilder()
    b.row(100, [['269.53', 40], ['חשבון קודם:', 555, true]])
    b.row(115, [['269.53', 40], ['שולם, תודה:', 555, true]])
    b.row(130, [['0.00', 40], ['יתרה:', 555, true]])
    expect(findTables(indexDocument(b.build()))).toEqual([])
  })
})
