import { describe, expect, it } from 'vitest'
import { orderLine } from './order'
import { applyAffine, drawingOrder, itemAngle, itemToUnits, multiplyAffine, remapLegacyHebrew, snapAngle, type ItemContext } from './items'

/** pdf.js viewport transform of an A4 page at scale 1, no rotation: y flipped. */
const A4: number[] = [1, 0, 0, -1, 0, 842]
const ctx = (run = 0): ItemContext => {
  let n = 0
  return { viewport: A4, run, font: { ascent: 0.9, descent: -0.2, bold: false }, nextSeq: () => n++ }
}
const read = (str: string, dir: string, width = 100) =>
  orderLine(itemToUnits({ str, dir, transform: [10, 0, 0, 10, 0, 0], width, height: 10, fontName: 'f' }, ctx()), 'rtl')
    .map((w) => w.text)
    .join(' ')

describe('itemToUnits', () => {
  it('places logical char 0 of an RTL run at its right end, units left to right', () => {
    // "סה"כ לתשלום:" drawn from x=100 to x=168 at baseline y=700 (PDF space).
    const units = itemToUnits({ str: 'סה"כ לתשלום:', dir: 'rtl', transform: [12, 0, 0, 12, 100, 700], width: 68, height: 12, fontName: 'f' }, ctx())
    // Drawn left to right: the colon (logically last) first, each Hebrew run in reading order.
    expect(units.map((u) => [u.text, u.cls, u.visual])).toEqual([
      [':', 'O', true],
      ['לתשלום', 'R', false],
      ['סה"כ', 'R', false],
    ])
    const [colon, , first] = units
    expect(first.bbox.x1).toBeCloseTo(168, 5)
    expect(colon.bbox.x0).toBeCloseTo(100, 5)
    expect(colon.wordKey).toBe(units[1].wordKey)
    // Page coordinates: top-left origin, the baseline at 842 - 700.
    expect(first.baseline).toBeCloseTo(142, 5)
    expect(first.bbox.y0).toBeCloseTo(142 - 0.9 * 12, 5)
    expect(first.bbox.y1).toBeCloseTo(142 + 0.2 * 12, 5)
    expect(first).toMatchObject({ cls: 'R', fontSize: 12, visual: false, orient: 0 })
  })

  it('splits an LTR run into words left to right and marks neutrals as drawn (visual)', () => {
    const units = itemToUnits({ str: 'Invoice No 778', dir: 'ltr', transform: [10, 0, 0, 10, 50, 500], width: 70, height: 10, fontName: 'f' }, ctx(3))
    expect(units.map((u) => u.text)).toEqual(['Invoice', 'No', '778'])
    expect(units[0].bbox.x0).toBeCloseTo(50, 5)
    expect(units[2].bbox.x1).toBeCloseTo(120, 5)
    expect(new Set(units.map((u) => u.wordKey)).size).toBe(3)
    expect(units.every((u) => u.run === 3 && u.visual)).toBe(true)
  })

  it('applies NFKC per character (ligatures, Hebrew presentation forms)', () => {
    const units = itemToUnits({ str: 'ﬁne', dir: 'ltr', transform: [10, 0, 0, 10, 0, 0], width: 15, height: 10, fontName: 'f' }, ctx())
    expect(units.map((u) => u.text)).toEqual(['fine'])
    const heb = itemToUnits({ str: 'ﭏ', dir: 'rtl', transform: [10, 0, 0, 10, 0, 0], width: 6, height: 10, fontName: 'f' }, ctx())
    expect(heb.map((u) => u.text)).toEqual(['אל'])
  })

  it('mirrors brackets of a right-to-left run (pdf.js reverses but does not mirror)', () => {
    // Drawn "(הרעה)" → pdf.js gives ")הערה(" (reversed, glyphs as drawn).
    expect(read(')הערה(', 'rtl', 30)).toBe('(הערה)')
  })

  it("undoes pdf.js's direction guess for runs that are mostly neutral", () => {
    // Drawn "____ :המיתח" (RTL paragraph): pdf.js calls it LTR (<30% Hebrew) and gives
    // "____ :חתימה"; the reader recovers the drawing order and reads it right to left.
    expect(drawingOrder('____ :חתימה', 'ltr').join('')).toBe('____ :המיתח')
    expect(read('____ :חתימה', 'ltr')).toBe('חתימה: ____')
  })

  it('locates words of a mixed RTL run (one run per line, as Word-style producers write)', () => {
    // pdf.js turns the drawn run "1,180.00 :םולשתל כ"הס" into logical 'סה"כ לתשלום: 1,180.00'.
    const units = itemToUnits({ str: 'סה"כ לתשלום: 1,180.00', dir: 'rtl', transform: [10, 0, 0, 10, 0, 0], width: 100, height: 10, fontName: 'f' }, ctx())
    expect(units.map((u) => u.text)).toEqual(['1,180.00', ':', 'לתשלום', 'סה"כ'])
    expect(units[0].bbox.x0).toBeCloseTo(0, 5)
    expect(units[3].bbox.x1).toBeCloseTo(100, 5)
    expect(read('סה"כ לתשלום: 1,180.00', 'rtl')).toBe('סה"כ לתשלום: 1,180.00')
  })

  it('reports rotated runs with their angle and no baseline', () => {
    const [u] = itemToUnits({ str: 'Side', dir: 'ltr', transform: [0, 10, -10, 0, 20, 300], width: 20, height: 10, fontName: 'f' }, ctx())
    expect(u.orient).toBe(270)
    expect(u.baseline).toBeNull()
    expect(u.bbox.y1 - u.bbox.y0).toBeCloseTo(20, 5)
  })
})

describe('remapLegacyHebrew', () => {
  it('maps Windows-1255 Hebrew read as Latin-1 back to Hebrew (still in drawing order)', () => {
    // "שלום" drawn right to left is the glyph sequence ם,ו,ל,ש = 0xED 0xE5 0xEC 0xF9.
    expect(remapLegacyHebrew('íåìù')).toBe('םולש')
    expect(remapLegacyHebrew('Café crème')).toBeNull()
    expect(read('íåìù 12', 'ltr')).toBe('12 שלום')
  })
})

describe('affine helpers', () => {
  it('compose like PDF cm and snap angles', () => {
    const m = multiplyAffine([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0])
    expect(applyAffine(m, 1, 1)).toEqual([12, 22])
    expect(snapAngle(-1)).toBe(0)
    expect(snapAngle(91.5)).toBe(90)
    expect(snapAngle(45)).toBe(45)
    expect(itemAngle([12, 0, 0, 12, 0, 0], A4)).toBe(0)
  })
})
