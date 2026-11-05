/**
 * End-to-end reader tests on Chrome-rendered fixtures (see __fixtures__/build.ts). Expected
 * texts are the logical text of the HTML sources, so they check both line splitting and bidi.
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { BBox, DocumentModel, Line } from '../model/types'
import { contains } from '../lib/geometry'
import { readDocument, ReadError } from './index'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))
const read = (name: string, opts = {}) => readDocument(fixture(name), { fileName: name, ...opts })
const texts = (doc: DocumentModel, page?: number) => doc.lines.filter((l) => page === undefined || l.page === page).map((l) => l.text)
const lineByText = (doc: DocumentModel, text: string): Line => {
  const l = doc.lines.find((x) => x.text === text)
  if (!l) throw new Error(`no line "${text}"`)
  return l
}
const midY = (b: BBox) => (b.y0 + b.y1) / 2

/** Structural invariants every DocumentModel must satisfy. */
function checkInvariants(doc: DocumentModel): void {
  const words = new Map(doc.words.map((w) => [w.id, w]))
  const lines = new Map(doc.lines.map((l) => [l.id, l]))
  for (const page of doc.pages) {
    const pageBox = { x0: 0, y0: 0, x1: page.width, y1: page.height }
    page.lineIds.forEach((id, i) => expect(id).toBe(`p${page.number}l${i + 1}`))
    expect(page.blockIds.flatMap((b) => doc.blocks.find((x) => x.id === b)!.lineIds)).toEqual(page.lineIds)
    for (const id of page.lineIds) {
      const line = lines.get(id)!
      expect(line.text).toBe(line.wordIds.map((w) => words.get(w)!.text).join(' '))
      expect(contains(pageBox, line.bbox, 1)).toBe(true)
      for (const wid of line.wordIds) {
        const w = words.get(wid)!
        expect(w.lineId).toBe(line.id)
        expect(w.text).not.toMatch(/\s|[‎‏‪-‮]/u)
        expect(w.text).toBe(w.text.normalize('NFC'))
        expect(contains(line.bbox, w.bbox, 0.5)).toBe(true)
      }
    }
  }
  for (const w of doc.words) expect(w.id).toBe(`p${w.page}w${doc.words.filter((x) => x.page === w.page).indexOf(w) + 1}`)
}

describe('Hebrew RTL invoice (he-invoice.pdf)', () => {
  let doc: DocumentModel
  beforeAll(async () => {
    doc = await read('he-invoice.pdf')
  })

  it('reads every line in logical order and in reading order', () => {
    expect(texts(doc)).toEqual([
      'אבג מערכות מידע בע"מ',
      'ח.פ. 512345678',
      'רחוב הרצל 12, תל אביב 6100000',
      "טל' 03-1234567 | info@abc-systems.co.il",
      'חשבונית מס 2026-0042',
      'תאריך: 31/10/2026',
      'מספר חשבונית Invoice No 12345 לפי הזמנה',
      'לכבוד: חברת הדוגמה בע"מ, ח.פ. 520000001',
      // Bordered table: one line per cell, rows top-down, cells right to left.
      'מק"ט',
      'תיאור',
      'כמות',
      'מחיר',
      'סה"כ',
      'ABC-12',
      'שירות ייעוץ (שעות)',
      '10',
      '100.00',
      '1,000.00',
      'DSC-5',
      'הנחת לקוח',
      '1',
      '-300.00',
      '-300.00',
      // Totals box: labels on the right, values far to the left (separate lines and blocks).
      'סה"כ לפני מע"מ',
      'מע"מ 18%',
      'סה"כ לתשלום: 826.00 ₪',
      '700.00',
      '126.00',
      'תנאי תשלום: שוטף + 30',
      'סה"כ לתשלום: 1,180.00 ₪',
      'המסמך הופק ע"י מערכת ABC Billing',
    ])
  })

  it('splits a label and its far-away value into two lines on the same row', () => {
    const label = lineByText(doc, 'סה"כ לפני מע"מ')
    const value = lineByText(doc, '700.00')
    expect(Math.abs(midY(label.bbox) - midY(value.bbox))).toBeLessThan(1)
    expect(label.bbox.x0).toBeGreaterThan(value.bbox.x1)
    expect(label.blockId).not.toBe(value.blockId)
  })

  it('gives words in logical order with RTL boxes right to left', () => {
    const line = lineByText(doc, 'סה"כ לתשלום: 1,180.00 ₪')
    const ws = line.wordIds.map((id) => doc.words.find((w) => w.id === id)!)
    expect(ws.map((w) => w.text)).toEqual(['סה"כ', 'לתשלום:', '1,180.00', '₪'])
    expect(ws.map((w) => w.dir)).toEqual(['rtl', 'rtl', null, null])
    for (let i = 1; i < ws.length; i++) expect(ws[i].bbox.x1).toBeLessThanOrEqual(ws[i - 1].bbox.x0 + 0.5)
    expect(line.dir).toBe('rtl')
    expect(lineByText(doc, 'ABC-12').dir).toBe('ltr')
  })

  it('has sane coordinates, sizes and styles', () => {
    expect(doc.pages[0]).toMatchObject({ number: 1, source: 'pdf' })
    expect(doc.pages[0].width).toBeCloseTo(595, 0)
    expect(doc.pages[0].height).toBeCloseTo(842, 0)
    checkInvariants(doc)
    const title = lineByText(doc, 'אבג מערכות מידע בע"מ')
    const titleWords = doc.words.filter((w) => w.lineId === title.id)
    expect(titleWords.every((w) => w.bold && Math.abs(w.fontSize - 18) < 0.05)).toBe(true)
    const body = doc.words.find((w) => w.text === '512345678')!
    expect(body).toMatchObject({ bold: false, source: 'pdf', confidence: 1 })
    expect(body.fontSize).toBeCloseTo(11, 1)
    // Right-aligned page: Hebrew lines end at the right margin (15 mm ≈ 42.5 pt).
    expect(title.bbox.x1).toBeCloseTo(595 - 42.5, 0)
    // Table rows: all cells of a row share the row's vertical position.
    const row = ['ABC-12', 'שירות ייעוץ (שעות)', '10', '100.00', '1,000.00'].map((t) => lineByText(doc, t))
    for (const l of row) expect(Math.abs(midY(l.bbox) - midY(row[0].bbox))).toBeLessThan(0.5)
  })

  it('fills meta', () => {
    expect(doc.meta).toMatchObject({ fileName: 'he-invoice.pdf', mimeType: 'application/pdf', pageCount: 1, textLayer: 'embedded', scripts: ['hebrew', 'latin'], warnings: [] })
    expect(doc.meta.producer).toMatch(/Skia/)
  })
})

describe('English LTR invoice (en-invoice.pdf)', () => {
  it('reads lines in logical order, a Hebrew name inside English included', async () => {
    const doc = await read('en-invoice.pdf')
    checkInvariants(doc)
    expect(texts(doc)).toEqual([
      'ACME Software Ltd.',
      'VAT Reg. No. GB123456789',
      '12 High Street, London EC1A 1BB',
      'TAX INVOICE',
      'Invoice No: INV-2026-0042',
      'Date: 31/10/2026',
      'Customer: אבג מערכות בע"מ (Israel)',
      // Borderless table with tight rows: one block per column, read left to right.
      'Description',
      'Consulting services',
      'Discount',
      'Qty',
      '10',
      '1',
      'Unit price',
      '100.00',
      '-50.00',
      'Amount',
      '1,000.00',
      '-50.00',
      'Subtotal',
      'VAT 20%',
      'Total due',
      '950.00',
      '190.00',
      '£1,140.00',
    ])
    expect(lineByText(doc, 'Customer: אבג מערכות בע"מ (Israel)').dir).toBe('ltr')
    expect(doc.meta.scripts).toEqual(['latin', 'hebrew'])
  })
})

describe('two-column header (two-column.pdf)', () => {
  it('makes each column a block and reads the right column first', async () => {
    const doc = await read('two-column.pdf')
    checkInvariants(doc)
    const blocks = doc.blocks.map((b) => b.lineIds.map((id) => doc.lines.find((l) => l.id === id)!.text))
    expect(blocks).toEqual([
      ['ספק: אבג מערכות בע"מ', 'ח.פ. 512345678', 'רחוב הרצל 12, תל אביב', "טל' 03-1234567"],
      ['לקוח: חברת הדוגמה בע"מ', 'ח.פ. 520000001', 'שדרות רוטשילד 1, תל אביב', "טל' 03-7654321"],
      ['תאריך הפקה:'],
      ['31/10/2026'],
      ['הערות: התשלום יבוצע בהעברה בנקאית לחשבון הספק בתוך 30 יום ממועד הפקת החשבונית.'],
    ])
    // Same baselines across the columns, yet separate lines.
    expect(midY(lineByText(doc, 'ח.פ. 512345678').bbox)).toBeCloseTo(midY(lineByText(doc, 'ח.פ. 520000001').bbox), 1)
    const bold = doc.words.filter((w) => w.bold).map((w) => w.text)
    expect(bold).toEqual(['ספק:', 'אבג', 'מערכות', 'בע"מ', 'לקוח:', 'חברת', 'הדוגמה', 'בע"מ'])
  })
})

describe('tables (tables.pdf)', () => {
  let doc: DocumentModel
  beforeAll(async () => {
    doc = await read('tables.pdf')
  })

  it('splits every cell of a bordered table into its own line, rows in RTL order', () => {
    checkInvariants(doc)
    expect(texts(doc).slice(0, 13)).toEqual([
      'טבלה עם מסגרת',
      'תיאור',
      'כמות',
      'מחיר יחידה',
      'סה"כ',
      'מחשב נייד Dell XPS 13',
      '2',
      '3,500.00',
      '7,000.00',
      'עכבר אלחוטי',
      '5',
      '45.90',
      '229.50',
    ])
  })

  it('splits the cells of a borderless table on whitespace alone', () => {
    const rows = [
      ['תיאור', 'כמות', 'מחיר יחידה', 'סה"כ'],
      ['מקלדת עברית/אנגלית', '3', '120.00', '360.00'],
      ['כבל HDMI 2 מטר', '10', '19.90', '199.00'],
    ]
    const plainTop = lineByText(doc, 'טבלה ללא מסגרת').bbox.y1
    for (const row of rows) {
      const cells = row.map((t) => doc.lines.find((l) => l.text === t && l.bbox.y0 > plainTop)!)
      expect(cells.every(Boolean)).toBe(true)
      // Same row, right to left.
      for (let i = 1; i < cells.length; i++) {
        expect(Math.abs(midY(cells[i].bbox) - midY(cells[0].bbox))).toBeLessThan(0.5)
        expect(cells[i].bbox.x1).toBeLessThan(cells[i - 1].bbox.x0)
      }
    }
  })
})

describe('two pages (two-pages.pdf)', () => {
  it('numbers ids per page and keeps each page its own text', async () => {
    const doc = await read('two-pages.pdf')
    checkInvariants(doc)
    expect(doc.meta.pageCount).toBe(2)
    expect(texts(doc, 1)).toEqual(['חשבונית מס 7788 עמוד 1 מתוך 2', 'שורה ראשונה בעמוד הראשון'])
    expect(texts(doc, 2)).toEqual(['עמוד 2 מתוך 2', 'סה"כ לתשלום: 2,360.00 ₪'])
    expect(doc.pages[1].lineIds).toEqual(['p2l1', 'p2l2'])
    expect(doc.words.filter((w) => w.page === 2)[0].id).toBe('p2w1')
    expect(doc.blocks.map((b) => b.id)).toEqual(['p1b1', 'p2b1'])
  })
})

describe('page geometry variants', () => {
  let base: DocumentModel
  beforeAll(async () => {
    base = await read('he-invoice.pdf')
  })

  for (const [file, warnings] of [
    ['he-invoice-rot90.pdf', []],
    ['he-invoice-offset.pdf', []],
    ['he-invoice-sideways.pdf', ['rotated-text-page-1']],
  ] as const) {
    it(`${file}: same lines at the same places as the upright original`, async () => {
      const doc = await read(file)
      expect(doc.meta.warnings).toEqual(warnings)
      expect(doc.pages[0].width).toBeCloseTo(base.pages[0].width, 1)
      expect(doc.pages[0].height).toBeCloseTo(base.pages[0].height, 1)
      expect(texts(doc)).toEqual(texts(base))
      doc.lines.forEach((l, i) => {
        const b = base.lines[i].bbox
        for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(l.bbox[k]).toBeCloseTo(b[k], 1)
      })
    })
  }

  it('reads a landscape page', async () => {
    const doc = await read('landscape.pdf')
    expect(doc.pages[0].width).toBeGreaterThan(doc.pages[0].height)
    expect(texts(doc)).toEqual(['חשבונית מס 555', 'סה"כ לתשלום: 99.90 ₪', 'Invoice 555'])
    expect(lineByText(doc, 'Invoice 555').bbox.x0).toBeLessThan(100)
  })
})

describe('password-protected PDF (encrypted.pdf)', () => {
  it('throws a clear error without or with a wrong password', async () => {
    await expect(read('encrypted.pdf')).rejects.toMatchObject({ name: 'ReadError', code: 'password-required' })
    await expect(read('encrypted.pdf', { password: 'nope' })).rejects.toMatchObject({ code: 'password-incorrect' })
    await expect(read('encrypted.pdf')).rejects.toBeInstanceOf(ReadError)
  })

  it('reads it with the right password', async () => {
    const doc = await read('encrypted.pdf', { password: 'secret' })
    expect(texts(doc)).toEqual(['Invoice INV-1 Total 118.00'])
  })
})

describe('inputs without OCR', () => {
  it('reports an image-only PDF as text-less when OCR is off', async () => {
    const doc = await read('scanned.pdf', { ocr: 'never' })
    expect(doc.words).toEqual([])
    expect(doc.pages[0]).toMatchObject({ source: 'pdf', lineIds: [] })
    expect(doc.meta.warnings).toEqual(['no-text-layer-page-1', 'no-text'])
  })

  it('rejects bytes of an unknown type', async () => {
    await expect(readDocument(new Uint8Array([0, 159, 146, 150, 0, 0]))).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('reads plain UTF-8 text in its own (logical) order, splitting at wide spaces', async () => {
    const doc = await readDocument(new TextEncoder().encode('חשבונית מס 12 Invoice\nסה"כ:      1,180.00 ₪\n\nTotal:    100.00'))
    expect(doc.meta).toMatchObject({ mimeType: 'text/plain', textLayer: 'embedded', pageCount: 1 })
    expect(texts(doc)).toEqual(['חשבונית מס 12 Invoice', 'סה"כ:', '1,180.00 ₪', 'Total:', '100.00'])
    expect(lineByText(doc, 'סה"כ:').bbox.x0).toBeGreaterThan(lineByText(doc, '1,180.00 ₪').bbox.x1)
    checkInvariants(doc)
  })
})
