import { describe, expect, it } from 'vitest'
import { indexDocument } from '../../lib/docIndex'
import type { Table } from '../../model/types'
import { findTables, tableBodyLineIds } from './index'
import { PageBuilder } from './testing'
import { cellKind, parseQxP } from './values'
import { visualRows } from './rows'

const kinds = (t: Table): string[] => t.rows.map((r) => r.kind)
const rowText = (t: Table, i: number): string =>
  t.rows[i].cells
    .map((c) => c?.text ?? '')
    .filter(Boolean)
    .join(' | ')

describe('sections inside a table', () => {
  /** Delivery notes grouped in one invoice: a heading across the row, lines, a section subtotal. */
  function grouped(): PageBuilder {
    const b = new PageBuilder()
    b.row(100, [['סה"כ', 40], ['מחיר יח\'', 130], ['כמות', 220], ['תיאור הפריט', 400], ['#', 545]])
    b.line("תעודת משלוח מס' 70412 מיום 03/09/2026", 558, 116, { right: true })
    b.row(132, [['100.00', 40], ['10.00', 130], ['10', 220], ['בלוק בטון', 530, true], ['1', 545]])
    b.row(148, [['50.00', 40], ['25.00', 130], ['2', 220], ['מלט אפור', 530, true], ['2', 545]])
    b.row(164, [['150.00', 40], ['סה"כ לתעודה 70412', 558, true]])
    b.line("תעודת משלוח מס' 70433 מיום 10/09/2026", 558, 180, { right: true })
    b.row(196, [['300.00', 40], ['150.00', 130], ['2', 220], ['ברזל בניין', 530, true], ['3', 545]])
    b.row(212, [['20.00', 40], ['20.00', 130], ['1', 220], ['חוטי קשירה', 530, true], ['4', 545]])
    b.row(228, [['320.00', 40], ['סה"כ לתעודה 70433', 558, true]])
    b.row(250, [['470.00', 40], ['סה"כ לפני מע"מ', 300]])
    b.row(266, [['84.60', 40], ['מע"מ 18%', 300]])
    b.row(282, [['554.60', 40], ['סה"כ כולל מע"מ', 300]])
    return b
  }

  it('keeps reading under section headings and section subtotals', () => {
    const [t] = findTables(indexDocument(grouped().build()))
    expect(kinds(t)).toEqual(['header', 'other', 'item', 'item', 'other', 'other', 'item', 'item', 'other', 'summary', 'summary', 'summary'])
    expect(rowText(t, 4)).toContain('150.00')
  })

  it('hides section subtotals from key/value detection but leaves the document totals', () => {
    const index = indexDocument(grouped().build())
    const hidden = [...tableBodyLineIds(index, findTables(index))].map((id) => index.line.get(id)!.text)
    expect(hidden).toContain('סה"כ לתעודה 70412')
    expect(hidden).toContain('סה"כ לתעודה 70433')
    expect(hidden).not.toContain('סה"כ לפני מע"מ')
  })

  it('does not take a subtotal that does not add up its section for a section subtotal', () => {
    const b = new PageBuilder()
    b.row(100, [['סה"כ', 40], ['מחיר יח\'', 130], ['כמות', 220], ['תיאור', 400]])
    b.row(120, [['100.00', 40], ['10.00', 130], ['10', 220], ['בלוק בטון', 530, true]])
    b.row(136, [['50.00', 40], ['25.00', 130], ['2', 220], ['מלט אפור', 530, true]])
    b.row(152, [['999.00', 40], ['סה"כ', 530, true]])
    b.row(168, [['300.00', 40], ['150.00', 130], ['2', 220], ['ברזל בניין', 530, true]])
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t)).toEqual(['header', 'item', 'item', 'summary'])
  })

  it('reads a heading with a clause number in an untitled-concept column', () => {
    const b = new PageBuilder()
    b.row(100, [['סה"כ ₪', 40], ['מחיר יחידה', 110], ['כמות', 200], ['תיאור העבודה', 380], ['סעיף', 540]])
    b.row(116, [['עבודות עפר', 520, true], ['01', 550]])
    b.row(130, [['17,325.00', 40], ['42.00', 110], ['412.5', 200], ['חפירה כללית', 520, true], ['01.010', 540]])
    b.row(144, [['10,788.00', 40], ['58.00', 110], ['186', 200], ['מילוי חוזר', 520, true], ['01.020', 540]])
    b.row(158, [['שונות', 520, true], ['99', 550]])
    b.row(172, [['9,500.00', 40], ['9,500.00', 110], ['1', 200], ['התארגנות באתר', 520, true], ['99.010', 540]])
    b.row(200, [['37,613.00', 40], ['סה"כ ביצוע', 200]])
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t)).toEqual(['header', 'other', 'item', 'item', 'other', 'item', 'summary'])
  })

  it('reads a shipping word without a figure as a description line, not a total', () => {
    const b = new PageBuilder()
    b.row(100, [['סכום', 40], ['מחיר', 130], ['כמות', 220], ['שירות / Service', 400]])
    b.row(120, [['2,850.00', 40], ['2,850.00', 130], ['1', 220], ['הובלה ימית', 530, true]])
    b.line('Ocean freight', 530, 131, { right: true })
    b.row(150, [['145.00', 40], ['145.00', 130], ['1', 220], ['ביטוח מטען', 530, true]])
    b.row(180, [['2,995.00', 40], ['סה"כ', 300]])
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t)).toEqual(['header', 'item', 'continuation', 'item', 'summary'])
  })
})

describe('column titles', () => {
  it('cuts titles the reader joined into one line at their wide gaps', () => {
    const b = new PageBuilder()
    b.row(100, [['Pos.', 40], ['Bezeichnung', 100]], { cw: 5 })
    b.line('Menge Einheit Einzelpreis USt.', 300, 100, { gap: 12 })
    b.line('Gesamtpreis', 520, 100)
    b.row(120, [['1', 40], ['Bürodrehstuhl ergonomisch', 100], ['1.556,00', 520]])
    b.line('4 Stk.', 310, 120, { gap: 30 })
    b.line('389,00 19 %', 403, 120, { gap: 12 })
    b.row(140, [['2', 40], ['Schreibtisch', 100], ['1.299,00', 520]])
    b.line('2 Stk.', 310, 140, { gap: 30 })
    b.line('649,50 19 %', 403, 140, { gap: 12 })
    b.row(170, [['Nettobetrag', 300], ['2.855,00 €', 520]])
    const [t] = findTables(indexDocument(b.build()))
    expect(t.columns.map((c) => c.header?.text)).toEqual(['Pos.', 'Bezeichnung', 'Menge', 'Einheit', 'Einzelpreis', 'USt.', 'Gesamtpreis'])
    expect(rowText(t, 1)).toBe('1 | Bürodrehstuhl ergonomisch | 4 | Stk. | 389,00 | 19 % | 1.556,00')
  })

  it('keeps one title whose words are set with ordinary spaces whole', () => {
    const b = new PageBuilder()
    b.row(100, [['Description', 40], ['Qty (pcs/pairs)', 300], ['Unit price', 400], ['Amount', 500]])
    b.row(120, [['Hinge', 40], ['12', 320], ['0.42', 410], ['5.04', 510]])
    const [t] = findTables(indexDocument(b.build()))
    expect(t.columns.map((c) => c.header?.text)).toEqual(['Description', 'Qty (pcs/pairs)', 'Unit price', 'Amount'])
  })

  it('does not stack a title or a labelled line above the table into its column titles', () => {
    const b = new PageBuilder()
    b.line('חשבונית זיכוי (מקור)', 351, 146, { right: true })
    b.line('סיבת הזיכוי הנחה בדיעבד', 559, 166, { right: true })
    b.row(172, [['סה"כ', 42], ['מחיר ליחידה', 139], ['כמות', 248], ['פירוט', 405], ["מס'", 517]])
    b.row(190, [['₪2009.00', 42], ['200.90', 139], ['10.000', 248], ['הובלת משטחים', 507, true], ['1', 517]])
    b.row(206, [['₪7301.90', 42], ['7301.90', 139], ['1.000', 248], ['דמי שילוח ימי', 507, true], ['2', 517]])
    b.row(230, [['₪9310.90', 44], ['סכום ביניים', 227, true]])
    const index = indexDocument(b.build())
    const [t] = findTables(index)
    expect(t.rows.filter((r) => r.kind === 'header')).toHaveLength(1)
    expect(t.columns.map((c) => c.header?.text)).toEqual(['סה"כ', 'מחיר ליחידה', 'כמות', 'פירוט', "מס'"])
    const hidden = [...tableBodyLineIds(index, [t])].map((id) => index.line.get(id)!.text)
    expect(hidden).not.toContain('חשבונית זיכוי (מקור)')
    expect(hidden).not.toContain('סיבת הזיכוי הנחה בדיעבד')
  })

  it('names a "#" column by its symbol', () => {
    const b = new PageBuilder()
    b.row(100, [['סה"כ', 40], ['כמות', 220], ['תיאור', 400], ['#', 545]])
    b.line('כותרת לקבוצה של שורות', 558, 116, { right: true })
    b.row(132, [['100.00', 40], ['10', 220], ['בלוק בטון', 530, true], ['1', 545]])
    const [t] = findTables(indexDocument(b.build()))
    // The heading reaches over "#": a text column, so the heading does not end the table.
    expect(kinds(t)).toEqual(['header', 'other', 'item'])
  })

  it('leaves a side box printed beside the titles out of the table', () => {
    const b = new PageBuilder()
    b.row(100, [['B A N K', 26], ['OMSCHRIJVING', 216], ['AANTAL', 356], ['PRIJS', 430], ['BEDRAG', 508]])
    b.row(116, [['IBAN NL77 RABO 0000 0001 24', 26], ['Warmtepomp lucht/water 8', 216], ['1', 370], ['€ 6.450,00', 430], ['€ 6.450,00', 508]])
    b.row(128, [['BIC RABONL2U', 26], ['kW incl. buitenunit', 216]])
    b.row(150, [['Installatie', 216], ['16', 370], ['€ 72,50', 430], ['€ 1.160,00', 508]])
    b.row(180, [['Subtotaal excl. btw', 330], ['€ 7.610,00', 508]])
    const index = indexDocument(b.build())
    const [t] = findTables(index)
    expect(t.columns.map((c) => c.header?.text)).toEqual(['OMSCHRIJVING', 'AANTAL', 'PRIJS', 'BEDRAG'])
    expect(kinds(t)).toEqual(['header', 'item', 'continuation', 'item', 'summary'])
    const hidden = [...tableBodyLineIds(index, [t])].map((id) => index.line.get(id)!.text)
    expect(hidden).not.toContain('IBAN NL77 RABO 0000 0001 24')
    expect(hidden).not.toContain('B A N K')
  })
})

describe('quantity × price', () => {
  it('parses units and doubled signs', () => {
    const fuel = parseQxP('41.20 L @ 7.15')!
    expect([fuel.qty.raw, fuel.price.raw]).toEqual(['41.20', '7.15'])
    const till = parseQxP('1 x @ 14.90')!
    expect([till.qty.raw, till.price.raw]).toEqual(['1', '14.90'])
    expect(parseQxP('60 cm x 60')).toBeNull()
  })

  it('glues "41.20 | L | @ | 7.15" read as separate lines into one cell in visual order', () => {
    const b = new PageBuilder(215, 400)
    b.line('294.58', 10, 100, { h: 8, cw: 4 })
    b.line('41.20', 132, 100, { h: 8, cw: 4 })
    b.line('L', 163, 100, { h: 8, cw: 4 })
    b.line('@', 174, 100, { h: 8, cw: 4 })
    b.line('7.15', 185, 100, { h: 8, cw: 4 })
    const index = indexDocument(b.build())
    const [row] = visualRows(index, 1)
    expect(row.cells.map((c) => c.text)).toEqual(['294.58', '41.20 L @ 7.15'])
    expect(cellKind(row.cells[1].text)).toBe('qxp')
  })

  it('folds a till receipt\'s "q × p + barcode" line under the line it multiplies out to', () => {
    const b = new PageBuilder(227, 500)
    b.row(60, [['סכום', 11], ['פריט', 216, true]], { h: 8, cw: 4 })
    b.row(75, [['13.24', 11], ['חלב 3% שומן', 216, true]], { h: 8, cw: 4 })
    b.row(84, [['2 × 6.62', 11], ['7290000111018', 216, true]], { h: 8, cw: 4 })
    b.row(97, [['8.94', 11], ['לחם אחיד', 216, true]], { h: 8, cw: 4 })
    b.row(106, [['1 × 8.94', 11], ['7290002345176', 216, true]], { h: 8, cw: 4 })
    b.row(130, [['22.18', 11], ['סה"כ לתשלום', 216, true]], { h: 8, cw: 4 })
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t)).toEqual(['header', 'item', 'continuation', 'item', 'continuation', 'summary'])
  })
})

describe('header-less lists', () => {
  it('finds a list whose items carry a smaller note line, with the total set further below', () => {
    const b = new PageBuilder()
    b.row(329, [['Brand identity refresh, logo', 68], ['£2,400.00', 528, true]], { h: 11 })
    b.line('Two rounds of revisions included', 68, 345, { h: 9 })
    b.row(374, [['Packaging artwork', 68], ['£1,350.00', 528, true]], { h: 11 })
    b.line('Print-ready files', 68, 390, { h: 9 })
    b.row(419, [['Spot illustrations', 68], ['£900.00', 528, true]], { h: 11 })
    b.row(474, [['TOTAL DUE', 360], ['£4,650.00', 528, true]], { h: 16 })
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t).filter((k) => k === 'item')).toHaveLength(3)
  })

  it('reads a till receipt without titles whose lines carry a "q × p + barcode" line under them', () => {
    const b = new PageBuilder(227, 500)
    b.row(75, [['13.24', 11], ['חלב 3% שומן', 216, true]], { h: 8, cw: 4 })
    b.row(84, [['2 × 6.62', 11], ['7290000111018', 216, true]], { h: 8, cw: 4 })
    b.row(97, [['9.30', 11], ['עגבניות שרי', 216, true]], { h: 8, cw: 4 })
    b.row(106, [['× 12.40 0.750', 11], ['2000000124063', 216, true]], { h: 8, cw: 4 })
    b.row(119, [['8.94', 11], ['לחם אחיד', 216, true]], { h: 8, cw: 4 })
    b.row(128, [['1 × 8.94', 11], ['7290002345176', 216, true]], { h: 8, cw: 4 })
    b.row(150, [['31.48', 11], ['סה"כ לתשלום', 216, true]], { h: 8, cw: 4 })
    const [t] = findTables(indexDocument(b.build()))
    expect(kinds(t)).toEqual(['item', 'continuation', 'item', 'continuation', 'item', 'continuation', 'summary'])
  })

  it('does not take a VAT breakdown that adds up to the VAT total for a list of items', () => {
    const b = new PageBuilder()
    b.row(500, [['Nettobetrag', 301], ['3.640,40 €', 536, true]])
    b.row(515, [['zzgl. 19 % USt. auf 3.093,00 €', 301], ['587,67 €', 536, true]])
    b.row(530, [['zzgl. 7 % USt. auf 547,40 €', 301], ['38,32 €', 536, true]])
    b.row(546, [['Summe USt.', 301], ['625,99 €', 536, true]])
    expect(findTables(indexDocument(b.build()))).toEqual([])
  })
})
