import { describe, expect, it } from 'vitest'
import type { DocumentModel, FieldCandidateLite } from '../../model/types'
import { indexDocument } from '../../lib/docIndex'
import { findTables } from '../../structure/tables'
import { PageBuilder } from '../../structure/tables/testing'
import { buildContext } from '../context'
import { interpretLineItems } from './index'

function run(doc: DocumentModel) {
  const tables = findTables(indexDocument(doc))
  return interpretLineItems(buildContext(doc), { keyValues: [], tables })
}

const val = (c: FieldCandidateLite | null): string | null => {
  if (!c) return null
  const n = c.normalized
  return n.kind === 'money' ? n.amount : n.kind === 'decimal' || n.kind === 'percent' ? n.value : n.kind === 'text' ? n.value : null
}

describe('interpretLineItems', () => {
  it('reads an RTL table: amounts with a currency mark, quantities, a description with its second line', () => {
    const b = new PageBuilder()
    b.row(120, [['סה"כ', 40], ['מחיר ליחידה', 150], ['כמות', 290], ['תיאור', 460]])
    b.row(140, [['₪ 81.80', 40], ['40.90', 150], ['2', 290], ['לוחות גבס', 555, true]])
    b.row(160, [['33.07 ₪', 40], ['66.14', 150], ['0.5', 290], ['עבודת טייח', 555, true]])
    b.line('עבור חודש ספטמבר', 555, 171, { right: true })
    b.row(200, [['₪ 114.87', 40], ['סה"כ:', 150]])
    const doc = b.build()
    const r = run(doc)
    expect(r.lineItems).toHaveLength(2)
    const [a, c] = r.lineItems
    expect([val(a.description), val(a.quantity), val(a.unitPrice), val(a.amount)]).toEqual(['לוחות גבס', '2', '40.90', '81.80'])
    expect(a.amount!.normalized).toEqual({ kind: 'money', amount: '81.80', currency: 'ILS' })
    expect(val(c.description)).toBe('עבודת טייח עבור חודש ספטמבר')
    expect(c.description!.evidence).toHaveLength(2)
    // Evidence points at the document's words.
    const words = new Set(doc.words.map((w) => w.id))
    expect(c.amount!.evidence.flatMap((e) => e.wordIds).every((id) => words.has(id))).toBe(true)
    expect(r.mainTableId).toBe('t1')
    // The header and body lines are used; the totals line is not.
    const used = new Set(r.usedLineIds.map((id) => doc.lines.find((l) => l.id === id)!.text))
    expect(used.has('עבור חודש ספטמבר')).toBe(true)
    expect(used.has('סה"כ:')).toBe(false)
  })

  it('reads a till receipt: the name above "q x p", the numbers inside it as evidence of their own', () => {
    const b = new PageBuilder(227, 371)
    b.row(60, [['15.90', 11], ['מיץ תפוזים 1 ליטר', 216, true]], { h: 8, cw: 4 })
    b.line('בננות', 216, 73, { right: true, h: 8, cw: 4 })
    b.row(85, [['42.48', 11], ['4.500 x 9.44', 216, true]], { h: 8, cw: 4 })
    b.row(110, [['58.38', 11], ['לתשלום', 216, true]], { h: 8, cw: 4 })
    const r = run(b.build())
    expect(r.lineItems.map((l) => [val(l.description), val(l.quantity), val(l.unitPrice), val(l.amount)])).toEqual([
      ['מיץ תפוזים 1 ליטר', null, null, '15.90'],
      ['בננות', '4.500', '9.44', '42.48'],
    ])
    expect(r.lineItems[1].quantity!.evidence[0].text).toBe('4.500')
    expect(r.lineItems[1].unitPrice!.evidence[0].text).toBe('9.44')
  })

  it('splits "name q x p" printed in one cell', () => {
    const b = new PageBuilder(227, 371)
    b.row(60, [['11.80', 11], ['במבה 80 גרם 2 x 5.90', 216, true]], { h: 8, cw: 4 })
    b.row(72, [['7.00', 11], ['לחם אחיד', 216, true]], { h: 8, cw: 4 })
    b.row(95, [['18.80', 11], ['סה"כ לתשלום', 216, true]], { h: 8, cw: 4 })
    const [a, c] = run(b.build()).lineItems
    expect([val(a.description), val(a.quantity), val(a.unitPrice), val(a.amount)]).toEqual(['במבה 80 גרם', '2', '5.90', '11.80'])
    expect(a.quantity!.evidence[0].text).toBe('2')
    expect(val(c.description)).toBe('לחם אחיד')
  })

  it('lets arithmetic name the columns a title does not ("יח\'" holding units, an untitled rate column)', () => {
    const b = new PageBuilder()
    b.row(100, [['סה"כ', 40], ['תעריף', 150], ["יח'", 240], ['כמות', 300], ['פריט', 460]])
    b.row(120, [['1,102.58', 40], ['1,102.58', 150], ["קומפ'", 240], ['1.00', 300], ['פינוי פסולת', 555, true]])
    b.row(140, [['59.00', 40], ['5.90', 150], ['שעה', 240], ['10.00', 300], ['שעת עבודה', 555, true]])
    const [a, c] = run(b.build()).lineItems
    expect([val(a.quantity), val(a.unitPrice), val(a.amount)]).toEqual(['1.00', '1102.58', '1102.58'])
    expect([val(c.quantity), val(c.unitPrice), val(c.amount)]).toEqual(['10.00', '5.90', '59.00'])
    expect(Object.values(c.extra).map((e) => e.rawValue)).toEqual(['שעה'])
  })

  it('reads a percent line discount', () => {
    const b = new PageBuilder()
    b.row(100, [['סכום', 40], ['% הנחה', 120], ['מחיר', 200], ['כמות', 290], ['תיאור', 460]])
    b.row(120, [['34,983.55', 40], ['10%', 120], ['12,956.87', 200], ['3.00', 290], ['גיוס ומיון', 555, true]])
    b.row(140, [['6,906.00', 40], ['6,906.00', 200], ['1.00', 290], ['ניתוח שוק', 555, true]])
    const [a, c] = run(b.build()).lineItems
    expect(a.discount!.normalized).toEqual({ kind: 'percent', value: '10' })
    expect(val(a.amount)).toBe('34983.55')
    expect(c.discount).toBeNull()
  })

  it('takes no items from a payments table', () => {
    const b = new PageBuilder()
    b.row(100, [['סכום', 40], ['תאריך', 150], ['פרטים', 300], ['אמצעי תשלום', 470]])
    b.row(120, [['₪ 6,252.00', 40], ['27-04-2025', 150], ['9916873', 300], ['המחאה', 555, true]])
    b.row(140, [['₪ 6,252.00', 40], ['סה"כ שולם:', 555, true]])
    expect(run(b.build()).lineItems).toEqual([])
  })
  it('keeps the translation printed under every name of a bilingual table out of the description', () => {
    const b = new PageBuilder()
    b.row(100, [['סכום', 40], ['מחיר', 130], ['כמות', 220], ['תיאור Description', 400]])
    b.row(120, [['2,670.00', 40], ['890.00', 130], ['3', 220], ['לינה – חדר זוגי', 555, true]])
    b.line('Double Room', 555, 131, { right: true })
    b.row(150, [['412.00', 40], ['412.00', 130], ['1', 220], ['מסעדה – ארוחת ערב', 555, true]])
    b.line('Restaurant – Dinner', 555, 161, { right: true })
    b.row(190, [['3,082.00', 40], ['סה"כ', 300]])
    const items = run(b.build()).lineItems
    expect(items.map((l) => val(l.description))).toEqual(['לינה – חדר זוגי', 'מסעדה – ארוחת ערב'])
    expect(val(items[0].extra.Description)).toBe('Double Room')
  })

  it('keeps a note in the other script under one name as part of its description', () => {
    const b = new PageBuilder()
    b.row(100, [['Amount / סכום', 40], ['Qty / כמות', 220], ['שם פריט / Service', 400]])
    b.row(120, [['118.80', 40], ['10', 220], ['Lever arch file 8 cm', 450]])
    b.line('לפי הצעת מחיר 2291', 555, 131, { right: true })
    b.row(150, [['20.00', 40], ['1', 220], ['Ball pen blue', 450]])
    b.row(170, [['30.00', 40], ['1', 220], ['Copy paper', 450]])
    b.row(200, [['168.80', 40], ['סה"כ', 300]])
    const items = run(b.build()).lineItems
    expect(val(items[0].description)).toBe('Lever arch file 8 cm לפי הצעת מחיר 2291')
  })

  it('keeps labelled detail lines ("Packing: …", "SKU …") as extra values, not description', () => {
    const b = new PageBuilder()
    b.row(100, [['Description', 40], ['Qty', 300], ['Unit price', 380], ['Amount', 480]])
    b.row(120, [['Soft-close cabinet hinge', 40], ['12,000', 300], ['0.42', 380], ['5,040.00', 480]])
    b.line('Packing: 200 per ctn', 40, 131)
    b.row(150, [['Hydraulic disc brake pads', 40], ['24', 300], ['7.25', 380], ['174.00', 480]])
    b.line('SKU OCP-BP-R02', 40, 161)
    b.row(190, [['Subtotal', 380], ['5,214.00', 480]])
    const [a, c] = run(b.build()).lineItems
    expect(val(a.description)).toBe('Soft-close cabinet hinge')
    expect(val(a.extra.Packing)).toBe('200 per ctn')
    expect(val(c.description)).toBe('Hydraulic disc brake pads')
    expect(val(c.sku)).toBe('OCP-BP-R02')
  })

  it('reads a till receipt detail line ("q × p" and the barcode) into the line above it', () => {
    const b = new PageBuilder(227, 500)
    b.row(60, [['סכום', 11], ['פריט', 216, true]], { h: 8, cw: 4 })
    b.row(75, [['13.24', 11], ['חלב 3% שומן', 216, true]], { h: 8, cw: 4 })
    b.row(84, [['2 × 6.62', 11], ['7290000111018', 216, true]], { h: 8, cw: 4 })
    b.row(97, [['9.30', 11], ['עגבניות שרי (שקילה)', 216, true]], { h: 8, cw: 4 })
    b.row(106, [['× 12.40 0.750', 11], ['2000000124063', 216, true]], { h: 8, cw: 4 })
    b.row(130, [['22.54', 11], ['סה"כ לתשלום', 216, true]], { h: 8, cw: 4 })
    const items = run(b.build()).lineItems
    expect(items.map((l) => [val(l.description), val(l.quantity), val(l.unitPrice), val(l.amount), val(l.sku)])).toEqual([
      ['חלב 3% שומן', '2', '6.62', '13.24', '7290000111018'],
      ['עגבניות שרי (שקילה)', '0.750', '12.40', '9.30', '2000000124063'],
    ])
  })

  it('takes a figure equal to quantity × price as the amount whatever its column title says', () => {
    const b = new PageBuilder(227, 500)
    b.row(60, [['כמות x מחיר = סה"כ', 11], ['פריט', 216, true]], { h: 8, cw: 4 })
    b.line('צלילת היכרות', 216, 75, { right: true, h: 8, cw: 4 })
    b.row(85, [['1,160.00', 11], ['4 x 290.00', 207, true]], { h: 8, cw: 4 })
    b.line('השכרת ציוד', 216, 97, { right: true, h: 8, cw: 4 })
    b.row(107, [['270.00', 11], ['6 x 45.00', 207, true]], { h: 8, cw: 4 })
    b.row(130, [['1,430.00', 11], ['סה"כ פריטים:', 216, true]], { h: 8, cw: 4 })
    const items = run(b.build()).lineItems
    expect(items.map((l) => [val(l.description), val(l.quantity), val(l.unitPrice), val(l.amount)])).toEqual([
      ['צלילת היכרות', '4', '290.00', '1160.00'],
      ['השכרת ציוד', '6', '45.00', '270.00'],
    ])
  })
})
