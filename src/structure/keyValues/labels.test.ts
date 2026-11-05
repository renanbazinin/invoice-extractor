import { describe, expect, it } from 'vitest'
import { analyzeLabel, labelLineScore, ocrRepair } from './labels'

describe('analyzeLabel', () => {
  it('is exact when every word belongs to a lexicon phrase (bilingual and rates allowed)', () => {
    expect(analyzeLabel('סה"כ לפני מע"מ / Net Amount:').exact).toBe(true)
    expect(analyzeLabel('מע"מ (18%):').exact).toBe(true)
    expect(analyzeLabel('פרטי לקוח').exact).toBe(true)
  })

  it('counts unknown words and digits', () => {
    const a = analyzeLabel('סה"כ חיוב נוסף')
    expect(a.exact).toBe(false)
    expect(a.extraWords).toBe(1)
    expect(analyzeLabel('מס\' חברה: 510000037').digits).toBe(true)
  })

  it('marks a bare column header', () => {
    expect(analyzeLabel('Description').columnOnly).toBe(true)
    expect(analyzeLabel('שם').columnOnly).toBe(true)
  })
})

describe('labelLineScore', () => {
  it('scores known exact labels high and colon labels as labels', () => {
    expect(labelLineScore(analyzeLabel('סה"כ לתשלום:'))).toBeGreaterThanOrEqual(0.9)
    expect(labelLineScore(analyzeLabel('Kostenstelle:'))).toBe(0.75)
  })

  it('needs the key phrase at the start of a non-exact label', () => {
    expect(labelLineScore(analyzeLabel('סה"כ חיוב נוסף'))).toBe(0.55)
    // A lexicon word inside a company name does not make it a label.
    expect(labelLineScore(analyzeLabel('Becker Shipping GmbH'))).toBe(0)
  })

  it('never takes a value as a label', () => {
    expect(labelLineScore(analyzeLabel('₪ 4,958.77'))).toBe(0)
    expect(labelLineScore(analyzeLabel('16/02/2025'))).toBe(0)
  })

  it('reads a rate inside a label as part of the label', () => {
    expect(labelLineScore(analyzeLabel('עמלת טיפול 3%'))).toBe(0.4)
  })
})

describe('ocrRepair', () => {
  it('restores OCR-read abbreviation marks without moving offsets', () => {
    for (const [ocr, fixed] of [
      ["סהייכ לפני מע'ימ:", "סה''כ לפני מע''מ:"],
      ['חייפ: 510000045', "ח''פ: 510000045"],
      ['מסי הקצאה', "מס' הקצאה"],
    ]) {
      expect(ocrRepair(ocr)).toBe(fixed)
      expect(ocrRepair(ocr).length).toBe(ocr.length)
    }
  })

  it('leaves ordinary words alone', () => {
    expect(ocrRepair('עדיין קיים')).toBe('עדיין קיים')
  })
})
