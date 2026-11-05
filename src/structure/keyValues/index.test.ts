import { describe, expect, it } from 'vitest'
import { indexDocument } from '../../lib/docIndex'
import type { KeyValue } from '../../model/types'
import { findKeyValues } from './index'
import { buildDoc, type LineSpec } from './testing'

function kvs(specs: LineSpec[]): { layout: string; label: string; value: string }[] {
  const doc = buildDoc(specs)
  return findKeyValues(indexDocument(doc), { excludeLineIds: new Set() }).map((k: KeyValue) => ({ layout: k.layout, label: k.label.text, value: k.value.text }))
}

describe('findKeyValues: grid', () => {
  it('pairs a Hebrew label with the value to its left (RTL reading side)', () => {
    const got = kvs([
      { text: 'סה"כ ללא מע"מ:', x0: 172, x1: 229, y: 457 },
      { text: 'מע"מ (18%):', x0: 181, x1: 229, y: 474 },
      { text: '₪ 4,958.77', x0: 42, x1: 87, y: 457 },
      { text: '₪ 892.58', x0: 42, x1: 79, y: 474 },
    ])
    expect(got).toContainEqual({ layout: 'grid', label: 'סה"כ ללא מע"מ:', value: '₪ 4,958.77' })
    expect(got).toContainEqual({ layout: 'grid', label: 'מע"מ (18%):', value: '₪ 892.58' })
  })

  it('pairs an English label with the value to its right (LTR)', () => {
    const got = kvs([
      { text: 'Invoice #', x0: 466, x1: 509, y: 140 },
      { text: '600901', x0: 539, x1: 569, y: 140 },
    ])
    expect(got).toEqual([{ layout: 'grid', label: 'Invoice #', value: '600901' }])
  })

  it('pairs every label of a meta grid row with its own value', () => {
    const got = kvs([
      { text: "מס' חשבונית", x0: 507, x1: 552, y: 138 },
      { text: '6769', x0: 471, x1: 491, y: 138 },
      { text: 'תאריך מסמך', x0: 225, x1: 271, y: 138 },
      { text: '04/08/25', x0: 178, x1: 213, y: 138 },
    ])
    expect(got).toEqual([
      { layout: 'grid', label: "מס' חשבונית", value: '6769' },
      { layout: 'grid', label: 'תאריך מסמך', value: '04/08/25' },
    ])
  })

  it('does not pair the cells of a table row', () => {
    const got = kvs([
      { text: "צ'ק", x0: 542, x1: 553, y: 563 },
      { text: '14', x0: 436, x1: 446, y: 563 },
      { text: '496', x0: 397, x1: 412, y: 563 },
      { text: '773338', x0: 344, x1: 373, y: 563 },
    ])
    expect(got).toEqual([])
  })

  it('reads a label wrapped over lines as one label', () => {
    const got = kvs([
      { text: 'Total', x0: 395, x1: 419, y: 75, block: 'b1' },
      { text: 'before', x0: 395, x1: 426, y: 89, block: 'b1' },
      { text: 'VAT:', x0: 395, x1: 417, y: 102, block: 'b1' },
      { text: 'NIS 58,421.35', x0: 448, x1: 520, y: 89 },
    ])
    expect(got).toEqual([{ layout: 'grid', label: 'Total before VAT:', value: 'NIS 58,421.35' }])
  })
})

describe('findKeyValues: wrapped values', () => {
  it('reads a value wrapped over two lines beside a centred label as one value', () => {
    const got = kvs([
      { text: 'שם החברה', x0: 498, x1: 552, y: 103, size: 11 },
      { text: 'כתובת', x0: 518, x1: 552, y: 141, size: 11 },
      { text: 'רח\' ויצמן 130, חיפה', x0: 317, x1: 445, y: 141, size: 11 },
      { text: 'טלפון', x0: 518, x1: 552, y: 192, size: 11 },
      { text: '03-0000106', x0: 378, x1: 445, y: 192, size: 11 },
      { text: 'חשמל ותאורה חרמון', x0: 330, x1: 445, y: 96, size: 11, block: 'n' },
      { text: 'בע"מ', x0: 418, x1: 445, y: 111, size: 11, block: 'n' },
    ])
    expect(got).toContainEqual({ layout: 'grid', label: 'שם החברה', value: 'חשמל ותאורה חרמון בע"מ' })
  })
})

describe('findKeyValues: below', () => {
  it('pairs a card label with the value under it', () => {
    const got = kvs([
      { text: 'מספר חשבונית', x0: 507, x1: 551, y: 88, size: 7.5 },
      { text: '20251310', x0: 508, x1: 551, y: 100, size: 9.8, bold: true },
      { text: 'תאריך חשבונית', x0: 400, x1: 445, y: 88, size: 7.5 },
      { text: '10/01/2025', x0: 397, x1: 445, y: 100, size: 9.8, bold: true },
    ])
    expect(got).toContainEqual({ layout: 'below', label: 'מספר חשבונית', value: '20251310' })
    expect(got).toContainEqual({ layout: 'below', label: 'תאריך חשבונית', value: '10/01/2025' })
  })

  it('does not pair a table header with its first row', () => {
    const got = kvs([
      { text: 'תיאור', x0: 442, x1: 462, y: 226 },
      { text: 'כמות', x0: 289, x1: 306, y: 226 },
      { text: 'סה"כ', x0: 42, x1: 61, y: 226 },
      { text: 'לוחות גבס', x0: 484, x1: 553, y: 247 },
      { text: '2', x0: 289, x1: 294, y: 247 },
      { text: '₪ 81.80', x0: 42, x1: 74, y: 247 },
      { text: 'חול מחצבה', x0: 496, x1: 553, y: 268 },
      { text: '1', x0: 289, x1: 294, y: 268 },
      { text: '₪ 302.70', x0: 42, x1: 79, y: 268 },
    ])
    expect(got.filter((k) => k.layout === 'below')).toEqual([])
  })
})

describe('findKeyValues: inline', () => {
  it('reads label and value of one line', () => {
    expect(kvs([{ text: 'תאריך: 16/02/2025', x0: 143, x1: 214, y: 35 }])).toEqual([{ layout: 'inline', label: 'תאריך:', value: '16/02/2025' }])
  })
})

describe('findKeyValues: unfamiliar layouts', () => {
  it('pairs a stacked Hebrew/English label with the number printed at the other edge of its cell', () => {
    const got = kvs([
      { text: "חשבונית מס מס'", x0: 499, x1: 547, y: 188, size: 9, block: 'k1' },
      { text: 'INVOICE NO.', x0: 497, x1: 547, y: 197, size: 7.5, block: 'k1' },
      { text: '26-118273', x0: 430, x1: 477, y: 205, size: 11, bold: true, dir: 'ltr' },
      { text: 'תאריך', x0: 402, x1: 420, y: 188, size: 9, block: 'k2' },
      { text: 'DATE', x0: 399, x1: 419, y: 197, size: 7.5, block: 'k2' },
      { text: '21/10/2026', x0: 303, x1: 353, y: 205, size: 11, bold: true },
    ])
    expect(got.find((k) => k.value === '26-118273')?.label).toContain("חשבונית מס מס'")
    expect(got.find((k) => k.value === '21/10/2026')?.label).toContain('תאריך')
  })

  it('ends a meta grid at its value column, before the addressee box on the same row', () => {
    const got = kvs([
      { text: "מס' חשבונית / Invoice No.", x0: 461, x1: 556, y: 143, size: 8.8 },
      { text: 'תאריך / Date', x0: 509, x1: 556, y: 157, size: 8.8 },
      { text: "מס' הזמנה / Order No.", x0: 474, x1: 556, y: 171, size: 8.8 },
      { text: 'EX-26-0457', x0: 307, x1: 353, y: 143, size: 8.8, dir: 'ltr' },
      { text: '18/10/2026', x0: 307, x1: 351, y: 157, size: 8.8 },
      { text: 'RVG-PO-1042', x0: 307, x1: 364, y: 171, size: 8.8, dir: 'ltr' },
      { text: 'Rift Valley Growers Co-operative Society Ltd', x0: 40, x1: 227, y: 146, size: 8.8 },
    ])
    expect(got).toContainEqual({ layout: 'grid', label: "מס' חשבונית / Invoice No.", value: 'EX-26-0457' })
  })

  it('pairs an advance whose label carries a date with the amount in the next cell', () => {
    const got = kvs([
      { text: 'מקדמה ששולמה (14/09/2026) / ADVANCE DEPOSIT', x0: 142, x1: 336, y: 648, size: 11 },
      { text: '-1,000.00', x0: 40, x1: 85, y: 648, size: 11 },
    ])
    expect(got).toContainEqual({ layout: 'grid', label: 'מקדמה ששולמה (14/09/2026) / ADVANCE DEPOSIT', value: '-1,000.00' })
  })

  it('does not take a letter-spaced party heading for a name label', () => {
    const got = kvs([
      { text: 'S U P P L I E R', x0: 48, x1: 85, y: 107, size: 7.4 },
      { text: 'C U S TO M E R', x0: 228, x1: 272, y: 107, size: 7.4 },
      { text: 'Vltava Precision s.r.o.', x0: 48, x1: 140, y: 120, size: 9.3 },
      { text: 'Nordhafen Maschinenbau GmbH', x0: 228, x1: 372, y: 120, size: 9.3 },
      { text: 'Date of issue', x0: 409, x1: 462, y: 109, size: 9.3 },
      { text: '2026-10-12', x0: 480, x1: 530, y: 109, size: 9.3 },
    ])
    expect(got.some((k) => k.label === 'Vltava Precision s.r.o.')).toBe(false)
  })
})
