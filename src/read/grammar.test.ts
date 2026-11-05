import { describe, expect, it } from 'vitest'
import type { Unit, UnitClass } from './model'
import { numericDateKey, repairDateOrder } from './grammar'
import { layoutPage } from './layout'

const fix = (text: string): string =>
  repairDateOrder(text.split(' ').map((t) => ({ text: t })))
    .map((w) => w.text)
    .join(' ')

describe('repairDateOrder (date grammar after a right-to-left reading)', () => {
  it('puts the day of a Hebrew month-name date back in front of the month', () => {
    // An LTR cell "24 ביולי 2026" in a Hebrew page reads back as "ביולי 2026 24".
    expect(fix('ביולי 2026 24')).toBe('24 ביולי 2026')
    expect(fix('אפריל 2025 21')).toBe('21 אפריל 2025')
    expect(fix('מאי 2025 3')).toBe('3 מאי 2025')
    expect(fix("אוג' 2025 3")).toBe("3 אוג' 2025")
  })

  it('keeps a time after its date', () => {
    expect(fix('אוגוסט 2025 17:47 23')).toBe('23 אוגוסט 2025 17:47')
    // "17:47 23 אוגוסט 2025" set LTR reads back with both numbers moved, reversed.
    expect(fix('אוגוסט 2025 23 17:47')).toBe('17:47 23 אוגוסט 2025')
  })

  it('repairs a date after its label and a range of month-name dates', () => {
    expect(fix('תאריך אחרון לתשלום: באוגוסט 2026 7')).toBe('תאריך אחרון לתשלום: 7 באוגוסט 2026')
    expect(fix('במאי 2026 - 19 ביולי 2026 27')).toBe('27 במאי 2026 - 19 ביולי 2026')
    // The end date's year wrapped onto the next line.
    expect(fix('אפריל 2026 - 13 יוני 17')).toBe('17 אפריל 2026 - 13 יוני')
  })

  it('puts the earlier date of a numeric range first', () => {
    expect(fix('23/2/2026 - 30/12/2025')).toBe('30/12/2025 - 23/2/2026')
    expect(fix('תקופה: 01.01.26 - 06.11.25')).toBe('תקופה: 06.11.25 - 01.01.26')
    expect(fix('01/09/2026 - 30/09/2026')).toBe('01/09/2026 - 30/09/2026')
  })

  it('puts the earlier date of a range written without spaces first', () => {
    expect(fix('30/09/2026–01/09/2026')).toBe('01/09/2026–30/09/2026')
    expect(fix('תקופה 01/09/2026-30/09/2026')).toBe('תקופה 01/09/2026-30/09/2026')
  })

  it('puts a time after the numeric date it belongs to', () => {
    expect(fix('12:30 31/10/2026')).toBe('31/10/2026 12:30')
    expect(fix('תאריך: 14:44 01/06/2026')).toBe('תאריך: 01/06/2026 14:44')
    expect(fix('31/10/2026 12:30')).toBe('31/10/2026 12:30')
  })

  it('leaves well-formed dates and other numbers alone', () => {
    for (const s of ['24 ביולי 2026', '27 במאי 2026 - 19 ביולי 2026', 'יולי 2026', 'מאי 2025 3 4', 'כמות 3 מחיר 2025 12', 'סה"כ 1,180.00 ₪', '200 - 100', '10:00 - 12:00'])
      expect(fix(s)).toBe(s)
  })

  it('returns the same array when nothing changes', () => {
    const words = [{ text: 'תאריך:' }, { text: '31/10/2026' }]
    expect(repairDateOrder(words)).toBe(words)
  })
})

describe('numericDateKey', () => {
  it('reads day-first and ISO-like numeric dates', () => {
    expect(numericDateKey('30/12/2025')).toBe(20251230)
    expect(numericDateKey('1.3.26')).toBe(20260301)
    expect(numericDateKey('2026-01-29')).toBe(20260129)
    expect(numericDateKey('31/13/2025')).toBeNull()
    expect(numericDateKey('12.50')).toBeNull()
  })
})

describe('layoutPage applies the date grammar to right-to-left lines', () => {
  /** Units laid out left to right with a space between them, as a PDF draws them. */
  const units = (spec: [string, UnitClass][]): Unit[] => {
    let x = 100
    return spec.map(([text, cls], i) => {
      const w = text.length * 5
      const u: Unit = {
        text,
        cls,
        bbox: { x0: x, y0: 100, x1: x + w, y1: 110 },
        baseline: 108,
        fontSize: 10,
        bold: false,
        source: 'pdf',
        confidence: 1,
        wordKey: `k${i}`,
        run: i,
        visual: cls !== 'R',
        orient: 0,
        seq: i,
      }
      x += w + 2.5
      return u
    })
  }

  it('reads an LTR date cell of a Hebrew page as written', () => {
    // "תאריך: 24 ביולי 2026" with the date in an LTR isolate is drawn "24 2026 ביולי תאריך:".
    const page = layoutPage({
      number: 1,
      width: 595,
      height: 842,
      source: 'pdf',
      units: units([
        ['24', 'N'],
        ['2026', 'N'],
        ['ביולי', 'R'],
        ['תאריך:', 'R'],
      ]),
      rules: [],
    })
    expect(page.lines.map((l) => l.text)).toEqual(['תאריך: 24 ביולי 2026'])
  })
})
