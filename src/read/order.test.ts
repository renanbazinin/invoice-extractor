import { describe, expect, it } from 'vitest'
import type { Unit, UnitClass } from './model'
import { directionCue, lineBaseDirection, orderLine, reportedDirection, resolveLevels, visualToLogical } from './order'

/**
 * Builds units laid out left to right (visual order) from a compact spec: each entry is
 * [text, class] and words are separated by '|' entries meaning "whitespace here"; consecutive
 * entries without '|' touch (same source word).
 */
function line(spec: (string | [string, UnitClass, boolean?])[]): Unit[] {
  const units: Unit[] = []
  let x = 0
  let word = 0
  for (const e of spec) {
    if (e === '|') {
      x += 3
      word++
      continue
    }
    const [text, cls, visual = cls !== 'R'] = e as [string, UnitClass, boolean?]
    const w = text.length * 6
    units.push({
      text,
      cls,
      bbox: { x0: x, y0: 0, x1: x + w, y1: 12 },
      baseline: 10,
      fontSize: 12,
      bold: false,
      source: 'pdf',
      confidence: 1,
      wordKey: `w${word}`,
      run: 0,
      visual,
      orient: 0,
      seq: units.length,
    })
    x += w
  }
  return units
}

const text = (units: Unit[], base: 'ltr' | 'rtl'): string =>
  orderLine(units, base)
    .map((w) => w.text)
    .join(' ')

describe('orderLine (bidi at word level)', () => {
  it('reads an RTL total line right to left, keeping the number and the shekel sign after it', () => {
    // As drawn: ₪ 1,180.00 לתשלום: סה"כ
    const u = line([['₪', 'O'], '|', ['1,180.00', 'N'], '|', ['לתשלום:', 'R'], '|', ['סה"כ', 'R']])
    expect(text(u, 'rtl')).toBe('סה"כ לתשלום: 1,180.00 ₪')
  })

  it('keeps a Latin code inside Hebrew in its own order', () => {
    // ABC-12 is three touching units drawn left to right.
    const u = line([['ABC', 'L'], ['-', 'O'], ['12', 'N'], '|', ['מק"ט', 'R']])
    expect(text(u, 'rtl')).toBe('מק"ט ABC-12')
  })

  it('keeps an English phrase inside a Hebrew line in order', () => {
    const u = line([['הזמנה', 'R'], '|', ['לפי', 'R'], '|', ['Invoice', 'L'], '|', ['No', 'L'], '|', ['12345', 'N'], '|', ['חשבונית', 'R'], '|', ['מספר', 'R']])
    expect(text(u, 'rtl')).toBe('מספר חשבונית Invoice No 12345 לפי הזמנה')
  })

  it('reads separate numbers of an RTL line right to left (each number is its own LTR island)', () => {
    // "תאריך 31/10/2026 12:30" is drawn as 12:30 31/10/2026 תאריך.
    const u = line([['12:30', 'N'], '|', ['31/10/2026', 'N'], '|', ['תאריך', 'R']])
    expect(text(u, 'rtl')).toBe('תאריך 31/10/2026 12:30')
    expect(text(line([['200', 'N'], '|', ['-', 'O'], '|', ['100', 'N']]), 'rtl')).toBe('100 - 200')
  })

  it('moves a minus drawn after a number in RTL text back in front of it', () => {
    expect(text(line([['300.00', 'N'], ['-', 'O']]), 'rtl')).toBe('-300.00')
    // Written inside an LTR cell the minus is already in front: keep it.
    expect(text(line([['-', 'O'], ['300.00', 'N']]), 'rtl')).toBe('-300.00')
    // Sign and currency symbol on the left of a number read only left to right.
    expect(text(line([['-₪', 'O'], '|', ['6,562.67', 'N']]), 'rtl')).toBe('-₪ 6,562.67')
    expect(text(line([['₪-', 'O'], ['0.41', 'N']]), 'rtl')).toBe('₪-0.41')
    // A currency symbol alone stays a separate neutral (the spec's total line).
    expect(text(line([['₪', 'O'], '|', ['1,180.00', 'N']]), 'rtl')).toBe('1,180.00 ₪')
  })

  it('keeps a bracket pair that sits inside a Latin run (bidi rule N0)', () => {
    // "A4 copy paper 80gsm (500 sheets)" in an RTL paragraph is drawn as one LTR run.
    const u = line([['A4', 'L'], '|', ['paper', 'L'], '|', ['(', 'O'], ['500', 'N'], '|', ['sheets', 'L'], [')', 'O']])
    expect(text(u, 'rtl')).toBe('A4 paper (500 sheets)')
  })

  it('mirrors brackets drawn around a number in RTL text', () => {
    // The glyph drawn at the left is "(" but it is the closing bracket of logical "(100.00)".
    expect(text(line([['(', 'O'], ['100.00', 'N'], [')', 'O']]), 'rtl')).toBe('(100.00)')
    expect(text(line([['(', 'O'], ['ABC', 'L'], [')', 'O'], '|', ['ספק', 'R']]), 'rtl')).toBe('ספק (ABC)')
    // A lone glyph ")" drawn left of a number is the mirrored "(" written after it.
    expect(text(line([[')', 'O'], ['5', 'N'], '|', ['סעיף', 'R']]), 'rtl')).toBe('סעיף 5(')
  })

  it('reads an English label drawn with its colon on the left as "Invoice No:"', () => {
    const u = line([[':', 'O'], ['Invoice', 'L'], '|', ['No', 'L']])
    expect(lineBaseDirection(u, 'rtl')).toBe('rtl')
    expect(text(u, lineBaseDirection(u, 'rtl'))).toBe('Invoice No:')
    // The same units on an LTR page are just LTR text.
    expect(lineBaseDirection(u, 'ltr')).toBe('ltr')
  })

  it('treats a number set off by a delimiter from a Latin run as its own field', () => {
    // "טל' 03-1234567 | info@x.co.il" is drawn as info@x.co.il | 03-1234567 טל'
    const u = line([['info@x.co.il', 'L'], '|', ['|', 'O'], '|', ['03-1234567', 'N'], '|', ["טל'", 'R']])
    expect(text(u, 'rtl')).toBe("טל' 03-1234567 | info@x.co.il")
  })

  it('reads a label colon glued to the left of a Latin word as the end of that label', () => {
    // "הזמנת רכש / Your PO: 4500-2291" with the PO number in an LTR span is drawn
    // "4500-2291 :Your PO / רכש הזמנת".
    const u = line([['4500-2291', 'N'], '|', [':', 'O'], ['Your', 'L'], '|', ['PO', 'L'], '|', ['/', 'O'], '|', ['רכש', 'R'], '|', ['הזמנת', 'R']])
    expect(text(u, 'rtl')).toBe('הזמנת רכש / Your PO: 4500-2291')
    // A Latin-only line drawn like that was set RTL, even inside an LTR block.
    const iban = line([['IL22', 'L'], '|', ['0310', 'N'], '|', ['214', 'N'], '|', [':', 'O'], ['IBAN', 'L']])
    expect(lineBaseDirection(iban, 'ltr')).toBe('rtl')
    expect(text(iban, lineBaseDirection(iban, 'ltr'))).toBe('IBAN: IL22 0310 214')
    // Glued on both sides it is part of a token, not a label end.
    const url = line([['http', 'L'], [':', 'O'], ['//x.co', 'L']])
    expect(lineBaseDirection(url, 'ltr')).toBe('ltr')
  })

  it('keeps a unit mark after its number (40\' is forty feet)', () => {
    // "מכולה 40' HC" in an RTL paragraph is drawn "HC '40 מכולה".
    expect(text(line([['HC', 'L'], '|', ["'", 'O'], ['40', 'N'], '|', ['מכולה', 'R']]), 'rtl')).toBe("מכולה 40' HC")
    // "FCL 40'" set in an LTR span is drawn as written.
    expect(text(line([['FCL', 'L'], '|', ['40', 'N'], ["'", 'O'], '|', ['ימית', 'R']]), 'rtl')).toBe("ימית FCL 40'")
  })

  it('reads numbers joined by an operator as drawn ("2 × 6.62" in an LTR cell)', () => {
    expect(text(line([['2', 'N'], '|', ['×', 'O'], '|', ['6.62', 'N']]), 'rtl')).toBe('2 × 6.62')
    expect(text(line([['13.24', 'N'], '|', ['2', 'N'], '|', ['×', 'O'], '|', ['6.62', 'N'], '|', ['חלב', 'R']]), 'rtl')).toBe('חלב 2 × 6.62 13.24')
    // A dash is a range or a field separator, not an operator: still read right to left.
    expect(text(line([['200', 'N'], '|', ['-', 'O'], '|', ['100', 'N']]), 'rtl')).toBe('100 - 200')
  })

  it('keeps an arithmetic expression together (an operator is not a field delimiter)', () => {
    const u = line([['(', 'O'], ['USD', 'L'], '|', ['2,150.00', 'N'], '|', ['×', 'O'], '|', ['3.712', 'N'], [')', 'O'], '|', ['חיפה', 'R']])
    expect(text(u, 'rtl')).toBe('חיפה (USD 2,150.00 × 3.712)')
  })

  it('reverses a Hebrew run inside an English line', () => {
    // "Customer: אבג מערכות בע"מ (Israel)" — Hebrew words are each logical, drawn right to left.
    const u = line([['Customer', 'L'], [':', 'O'], '|', ['בע"מ', 'R'], '|', ['מערכות', 'R'], '|', ['אבג', 'R'], '|', ['(', 'O'], ['Israel', 'L'], [')', 'O']])
    expect(lineBaseDirection(u, 'ltr')).toBe('ltr')
    expect(text(u, 'ltr')).toBe('Customer: אבג מערכות בע"מ (Israel)')
  })

  it('keeps numbers inside a Hebrew run of an English line in their own order', () => {
    const u = line([['Ref', 'L'], '|', ['12', 'N'], '|', ['הרצל', 'R'], '|', ['רחוב', 'R']])
    expect(text(u, 'ltr')).toBe('Ref רחוב הרצל 12')
  })

  it('glues touching runs into one word and keeps spaced ones apart', () => {
    const words = orderLine(line([['30', 'N'], ['שוטף+', 'R', false]]), 'rtl')
    expect(words.map((w) => w.text)).toEqual(['שוטף+30'])
    const two = orderLine(line([['30', 'N'], '|', ['שוטף', 'R']]), 'rtl')
    expect(two.map((w) => w.text)).toEqual(['שוטף', '30'])
  })

  it('word boxes cover their units and word direction follows the letters', () => {
    const words = orderLine(line([['ABC', 'L'], ['-', 'O'], ['12', 'N'], '|', ['מק"ט', 'R']]), 'rtl')
    expect(words[0]).toMatchObject({ text: 'מק"ט', dir: 'rtl' })
    expect(words[1]).toMatchObject({ text: 'ABC-12', dir: 'ltr', bbox: { x0: 0, x1: 36 } })
    expect(orderLine(line([['1,180.00', 'N']]), 'rtl')[0].dir).toBeNull()
  })
})

describe('lineBaseDirection', () => {
  const u = (cls: UnitClass[]) => line(cls.flatMap((c, i) => (i ? ['|', [`x${i}`, c]] : [[`x${i}`, c]]) as never))
  it('orders Hebrew-only lines RTL and everything else by the paragraph context', () => {
    expect(lineBaseDirection(u(['R', 'R']), 'ltr')).toBe('rtl')
    expect(lineBaseDirection(u(['L', 'L']), 'rtl')).toBe('rtl')
    expect(lineBaseDirection(u(['L', 'L']), 'ltr')).toBe('ltr')
    expect(lineBaseDirection(u(['R', 'L']), 'rtl')).toBe('rtl')
    expect(lineBaseDirection(u(['R', 'L']), 'ltr')).toBe('ltr')
    expect(lineBaseDirection(u(['N', 'N']), 'rtl')).toBe('rtl')
    expect(lineBaseDirection(u(['N']), 'ltr')).toBe('ltr')
  })

  it('reports Latin-only lines as LTR whatever paragraph they sit in', () => {
    expect(reportedDirection(u(['L', 'N']), 'rtl')).toBe('ltr')
    expect(reportedDirection(u(['R', 'L']), 'rtl')).toBe('rtl')
    expect(reportedDirection(u(['N']), 'rtl')).toBe('rtl')
  })

  it('orders an English line of an RTL paragraph with its displaced neutral', () => {
    // "Invoice #" in an RTL paragraph is drawn "# Invoice".
    expect(text(line([['#', 'O'], '|', ['Invoice', 'L']]), 'rtl')).toBe('Invoice #')
    // "* Prices include VAT" is drawn "Prices include VAT *".
    expect(text(line([['Prices', 'L'], '|', ['include', 'L'], '|', ['VAT', 'L'], '|', ['*', 'O']]), 'rtl')).toBe('* Prices include VAT')
    // Set in an LTR cell (isolated), "Net Amount:" keeps its colon on the right.
    expect(text(line([['Net', 'L'], '|', ['Amount', 'L'], [':', 'O']]), 'rtl')).toBe('Net Amount:')
  })
})

describe('directionCue', () => {
  it('reads paragraph direction from displaced neutrals', () => {
    expect(directionCue(line([[':', 'O'], ['Net', 'L'], '|', ['Amount', 'L']]))).toBe('rtl')
    expect(directionCue(line([['Net', 'L'], '|', ['Amount', 'L'], [':', 'O']]))).toBeNull()
    // "מחיר ליח'" set LTR: the apostrophe is a separate run drawn right of the Hebrew run.
    const ltrHebrew = line([['ליח', 'R'], '|', ['מחיר', 'R'], ["'", 'O']])
    expect(directionCue(ltrHebrew)).toBe('ltr')
    expect(text(ltrHebrew, lineBaseDirection(ltrHebrew, 'rtl'))).toBe("מחיר ליח'")
    expect(directionCue(line([['ליח', 'R'], '|', ['מחיר', 'R']]))).toBeNull()
  })
})

describe('resolveLevels', () => {
  it('assigns UBA levels at word level', () => {
    const units = line([['₪', 'O'], '|', ['1,180.00', 'N'], '|', ['סה"כ', 'R']])
    expect(resolveLevels(units, [false, false], 'rtl')).toEqual({ units: [1, 2, 1], gaps: [1, 1] })
    const latin = line([['Invoice', 'L'], '|', ['No', 'L'], '|', ['5', 'N'], '|', ['א', 'R']])
    expect(resolveLevels(latin, [false, false, false], 'rtl')).toEqual({ units: [2, 2, 2, 1], gaps: [2, 2, 1] })
  })
})

describe('visualToLogical', () => {
  /** Rule L2 as the standard states it: reverse from the highest level down to the lowest odd one. */
  function forward(levels: number[]): { order: number[]; levels: number[] } {
    const idx = levels.map((_, i) => i)
    const lv = [...levels]
    const minOdd = Math.min(...lv) | 1
    for (let level = Math.max(...lv); level >= minOdd; level--) {
      for (let k = 0; k < lv.length; ) {
        if (lv[k] < level) {
          k++
          continue
        }
        let e = k
        while (e + 1 < lv.length && lv[e + 1] >= level) e++
        idx.splice(k, e - k + 1, ...idx.slice(k, e + 1).reverse())
        lv.splice(k, e - k + 1, ...lv.slice(k, e + 1).reverse())
        k = e + 1
      }
    }
    return { order: idx, levels: lv }
  }

  it('undoes rule L2 for every level pattern up to length 7', () => {
    let seed = 7
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let t = 0; t < 2000; t++) {
      const n = 1 + Math.floor(rand() * 7)
      const logicalLevels = Array.from({ length: n }, () => Math.floor(rand() * 4))
      const { order: visual, levels: visualLevels } = forward(logicalLevels)
      const back = visualToLogical(visualLevels).map((v) => visual[v])
      expect(back).toEqual(logicalLevels.map((_, i) => i))
    }
  })
})

describe('brackets around numbers in RTL text', () => {
  it('reads "(03) 9684447" drawn as 9684447 (03)', () => {
    const u = line([['9684447', 'N'], '|', ['(', 'O'], ['03', 'N'], [')', 'O'], '|', ['פקס', 'R']])
    expect(text(u, 'rtl')).toBe('פקס (03) 9684447')
  })
})

describe('a Latin run followed by a bracketed number', () => {
  it('reads "מע"מ (18%) / VAT (18%):" (the first bracket pair belongs to the Hebrew side)', () => {
    const u = line([[':', 'O'], ['VAT', 'L'], '|', ['(', 'O'], ['18%', 'N'], [')', 'O'], '|', ['/', 'O'], '|', ['(', 'O'], ['18%', 'N'], [')', 'O'], '|', ['מע"מ', 'R']])
    expect(text(u, 'rtl')).toBe('מע"מ (18%) / VAT (18%):')
  })
})

describe('Hebrew header set LTR', () => {
  it('reads "מס\' / #" from an LTR cell', () => {
    const u = line([['מס', 'R'], ["'", 'O'], '|', ['/', 'O'], '|', ['#', 'O']])
    expect(directionCue(u)).toBe('ltr')
    expect(text(u, lineBaseDirection(u, 'rtl'))).toBe("מס' / #")
  })
})

describe('mixed header set LTR', () => {
  it('reads "Rate / מחיר ליח\'" from an LTR cell', () => {
    const u = line([['Rate', 'L'], '|', ['/', 'O'], '|', ['ליח', 'R'], '|', ['מחיר', 'R'], ["'", 'O']])
    expect(lineBaseDirection(u, 'rtl')).toBe('ltr')
    expect(text(u, 'ltr')).toBe("Rate / מחיר ליח'")
  })
})
