import { describe, expect, it } from 'vitest'
import type { OcrWord } from './ocr'
import { calibrateConfidence, MISREAD_CONFIDENCE, misreadFigure, NEIGHBOUR_CONFIDENCE, skewFromWords, splitGlued, straighten, suspiciousFigure, wellFormedFigure } from './ocrpage'

/** An OCR word with a box `w` px wide and `h` px tall at (x, y). */
const word = (text: string, x: number, y: number, w: number, h = 20, confidence = 0.95, line = 0): OcrWord => ({
  text,
  bbox: { x0: x, y0: y, x1: x + w, y1: y + h },
  confidence,
  line,
})

describe('straighten / skewFromWords', () => {
  it('puts the words of a skewed row back on one level', () => {
    const angle = Math.atan(0.018)
    // A row descending to the right at a slope of 0.018 on a 1600 px wide page.
    const row = [0, 400, 800, 1200].map((x, i) => word(`w${i}`, x, 500 + 0.018 * x, 100))
    const level = straighten(row, angle, 1600, 2200)
    const ys = level.map((w) => (w.bbox.y0 + w.bbox.y1) / 2)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
    // Box sizes do not change.
    expect(level[0].bbox.x1 - level[0].bbox.x0).toBeCloseTo(100)
  })

  it('leaves an unskewed page as it is', () => {
    const row = [word('a', 0, 10, 50)]
    expect(straighten(row, 0.0001, 100, 100)[0].bbox).toEqual(row[0].bbox)
  })

  it('measures the skew from the words of tesseract lines', () => {
    const words: OcrWord[] = []
    for (let line = 0; line < 6; line++) for (let k = 0; k < 4; k++) words.push(word('ab', k * 300, 100 + line * 60 + k * 300 * 0.02, 120, 20, 0.9, line))
    expect(Math.tan(skewFromWords(words))).toBeCloseTo(0.02, 3)
  })
})

describe('figures', () => {
  it('knows what a printed figure looks like', () => {
    for (const t of ['1,180.00', '-235.00', '₪2,514.00', '18%', '31/10/2026', '2026-01-29', '14:32', '03-1234567', '+972-3-0000107', '₪', '12'])
      expect(wellFormedFigure(t)).toBe(true)
    for (const t of ['.12.03', '5,', '0,', '1,00.5', '21.107.2025']) expect(wellFormedFigure(t)).toBe(false)
  })

  it('suspects a figure that reads short for its box or carries a glued letter', () => {
    // "0" in a box five characters wide: the "10.00" it stands for lost digits.
    expect(suspiciousFigure(word('0', 0, 0, 75, 15))).toBe(true)
    expect(suspiciousFigure(word('10.00', 0, 0, 75, 15))).toBe(false)
    expect(suspiciousFigure(word('ה50', 0, 0, 40, 15))).toBe(true)
    expect(suspiciousFigure(word('סה"כ', 0, 0, 80, 15))).toBe(false)
    expect(suspiciousFigure(word('.12.03', 0, 0, 60, 15, 0.5))).toBe(true)
  })

  it('caps the confidence of a misread figure and of the words beside it', () => {
    // "50-26795" read as "ה50" and "795": the second piece looks fine but is not the number.
    const words = [word('795', 290, 100, 60, 22, 0.9), word('ה50', 200, 100, 55, 22, 0.82), word('תאריך', 600, 100, 80, 22, 0.95)]
    expect(misreadFigure(words[1])).toBe(true)
    const out = calibrateConfidence(words)
    expect(out[1].confidence).toBe(MISREAD_CONFIDENCE)
    expect(out[0].confidence).toBe(NEIGHBOUR_CONFIDENCE)
    // A word far along the row keeps its own confidence.
    expect(out[2].confidence).toBe(0.95)
    // The input is not modified.
    expect(words[0].confidence).toBe(0.9)
  })
})

describe('splitGlued', () => {
  it('splits a Hebrew word glued to a number, the Hebrew on the right', () => {
    const [heb, num] = splitGlued([word('יוני2023', 0, 0, 80)])
    expect(heb.text).toBe('יוני')
    expect(num.text).toBe('2023')
    expect(heb.bbox.x0).toBeGreaterThanOrEqual(num.bbox.x1)
    expect(splitGlued([word('מסי3417', 0, 0, 70)]).map((w) => w.text)).toEqual(['מסי', '3417'])
  })

  it('keeps a one-letter prefix on its number and leaves other words alone', () => {
    for (const t of ['ב2026', 'ה-50', '2026', 'שוטף+30', 'מס\'', 'A4']) expect(splitGlued([word(t, 0, 0, 50)]).map((w) => w.text)).toEqual([t])
  })
})
