import { describe, expect, it } from 'vitest'
import { normalizeAbbreviation, normalizeAbbreviations } from './abbrev'

describe('normalizeAbbreviation (OCR misreadings of geresh/gershayim)', () => {
  it('restores a gershayim read as yods or quote marks', () => {
    expect(normalizeAbbreviation('סהייכ')).toBe('סה"כ')
    expect(normalizeAbbreviation("סה'יכ")).toBe('סה"כ')
    expect(normalizeAbbreviation('סה""כ')).toBe('סה"כ')
    expect(normalizeAbbreviation('סה\'"כ')).toBe('סה"כ')
    expect(normalizeAbbreviation('חייפ:')).toBe('ח"פ:')
    expect(normalizeAbbreviation("מע'ימ:")).toBe('מע"מ:')
    expect(normalizeAbbreviation('מעיימ')).toBe('מע"מ')
    expect(normalizeAbbreviation('מע\'"\'מ')).toBe('מע"מ')
    expect(normalizeAbbreviation('בע"ימ')).toBe('בע"מ')
    expect(normalizeAbbreviation('דואייל:')).toBe('דוא"ל:')
    expect(normalizeAbbreviation('שייח')).toBe('ש"ח')
  })

  it('restores one misread letter of an abbreviation (ע read as צ, ס as ז)', () => {
    expect(normalizeAbbreviation('בצ"מ')).toBe('בע"מ')
    expect(normalizeAbbreviation('מצ"מ:')).toBe('מע"מ:')
    expect(normalizeAbbreviation('זה"כ')).toBe('סה"כ')
    expect(normalizeAbbreviation('מנב"ל')).toBe('מנכ"ל')
    expect(normalizeAbbreviation("מצ'ימ")).toBe('מע"מ')
    // A known word a letter away from an abbreviation stays itself.
    expect(normalizeAbbreviation('דו"ח')).toBe('דו"ח')
  })

  it('keeps a one-letter prefix', () => {
    expect(normalizeAbbreviation('וסהייכ')).toBe('וסה"כ')
    expect(normalizeAbbreviation('המעיימ')).toBe('המע"מ')
  })

  it('restores a geresh read as a final yod', () => {
    expect(normalizeAbbreviation('מסי')).toBe("מס'")
    expect(normalizeAbbreviation('רחי')).toBe("רח'")
    expect(normalizeAbbreviation('קומפי')).toBe("קומפ'")
    expect(normalizeAbbreviation('ציק')).toBe("צ'ק")
    expect(normalizeAbbreviation('מסי:')).toBe("מס':")
  })

  it('needs a label context for misreadings that are also names', () => {
    expect(normalizeAbbreviation('טלי')).toBe('טלי')
    expect(normalizeAbbreviation('טלי:')).toBe("טל':")
    expect(normalizeAbbreviation('טלי', true)).toBe("טל'")
    expect(normalizeAbbreviations(['טלי', '03-1234567'])).toEqual(["טל'", '03-1234567'])
    expect(normalizeAbbreviations(['טלי', 'כהן'])).toEqual(['טלי', 'כהן'])
  })

  it('leaves ordinary words and correct abbreviations alone', () => {
    for (const w of ['חייב', 'שייך', 'סייג', 'עמי', 'גבי', 'מחיר', 'סה"כ', "מס'", 'שיח', 'ריהוט', 'Total', '1,180.00', 'צבי', 'חיים'])
      expect(normalizeAbbreviation(w)).toBe(w)
  })
})
