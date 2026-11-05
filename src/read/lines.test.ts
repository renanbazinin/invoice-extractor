import { describe, expect, it } from 'vitest'
import type { Rule, Unit } from './model'
import { groupLines, ruleBetween, sameRow, WIDE_GAP_EM } from './lines'

let seq = 0
/** A unit at x (left edge) on a baseline, width in points; 12 pt Arial-like box. */
function u(text: string, x: number, w: number, baseline = 100, size = 12, extra: Partial<Unit> = {}): Unit {
  return {
    text,
    bbox: { x0: x, y0: baseline - 0.9 * size, x1: x + w, y1: baseline + 0.21 * size },
    baseline,
    fontSize: size,
    bold: false,
    cls: /\d/.test(text) ? 'N' : /[א-ת]/.test(text) ? 'R' : 'L',
    source: 'pdf',
    confidence: 1,
    wordKey: `k${seq}`,
    run: seq++,
    visual: true,
    orient: 0,
    seq,
    ...extra,
  }
}

const texts = (units: Unit[], rules: Rule[] = []) =>
  groupLines(units, rules)
    .map((l) => l.units.map((x) => x.text).join(' '))
    .sort()

describe('groupLines', () => {
  it('joins normal word spacing and splits wide gaps', () => {
    const em = 12
    const words = [u('Invoice', 0, 40), u('No:', 40 + 0.3 * em, 18), u('778', 58 + 0.35 * em + 0.3 * em, 18)]
    expect(texts(words)).toEqual(['Invoice No: 778'])
    const far = [u('Total', 0, 30), u('100.00', 30 + 1.5 * em, 36)]
    expect(texts(far)).toEqual(['100.00', 'Total'])
    expect(WIDE_GAP_EM).toBeGreaterThan(0.6)
    expect(WIDE_GAP_EM).toBeLessThan(1.2)
  })

  it('keeps superscripts and subscripts on their line', () => {
    const x = u('x', 0, 6, 100, 12)
    const sup = u('2', 6, 5, 95.25, 10)
    const word = u('מילה', 14, 23, 100, 12)
    const sub = u('2', 40, 5, 103.1, 10)
    expect(texts([x, sup, word, sub])).toEqual(['x 2 מילה 2'])
  })

  it('does not merge two columns whose baselines differ', () => {
    const left = [u('a1', 0, 20, 100), u('a2', 0, 20, 114), u('a3', 0, 20, 128)]
    const right = [u('b1', 22, 20, 106), u('b2', 22, 20, 120)]
    const lines = groupLines([...left, ...right])
    expect(lines).toHaveLength(5)
  })

  it('does not merge stacked lines with tight leading', () => {
    const lines = groupLines([u('one', 0, 20, 100), u('two', 22, 20, 111), u('three', 0, 30, 111)])
    expect(lines.map((l) => l.units.map((x) => x.text).join(' ')).sort()).toEqual(['one', 'three two'])
  })

  it('splits at a vertical ruling line even when the gap is narrow', () => {
    const a = u('3', 0, 6)
    const b = u('100.00', 10, 34)
    const rule: Rule = { x0: 7.5, x1: 8.25, y0: 80, y1: 110, axis: 'v' }
    expect(ruleBetween(a.bbox, b.bbox, [rule])).toBe(true)
    expect(texts([a, b])).toEqual(['3 100.00'])
    expect(texts([a, b], [rule])).toEqual(['100.00', '3'])
  })

  it('keeps rotated text on lines of its own, in source order', () => {
    const side = [u('Printed', 0, 10, 300, 8, { orient: 90, run: 99, seq: 1 }), u('by', 0, 10, 330, 8, { orient: 90, run: 99, seq: 2 })]
    const lines = groupLines([u('Total', 100, 30), ...side])
    const rotated = lines.find((l) => l.fixedOrder)!
    expect(rotated.units.map((x) => x.text)).toEqual(['Printed', 'by'])
  })

  it('compares OCR boxes by their centres (no baseline)', () => {
    const a = u('סה"כ', 0, 30, 100, 12, { baseline: null, source: 'ocr' })
    const b = u('1,180.00', 34, 40, 102, 12, { baseline: null, source: 'ocr' })
    expect(sameRow(a, b)).toBe(true)
    const c = u('next', 0, 30, 114, 12, { baseline: null, source: 'ocr' })
    expect(sameRow(a, c)).toBe(false)
  })
})
