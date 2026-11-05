import { describe, expect, it } from 'vitest'
import { splitToken, wordClass } from './units'

const chars = (s: string) => [...s].map((ch, i) => ({ ch, s: i, t: i + 1 }))
const split = (s: string, logicalRtl = false) => splitToken(chars(s), logicalRtl).map((p) => `${p.cls}:${p.text}`)

describe('splitToken', () => {
  it('keeps numbers with their separators and terminators whole', () => {
    expect(split('1,180.00')).toEqual(['N:1,180.00'])
    expect(split('31/10/2026')).toEqual(['N:31/10/2026'])
    expect(split('03-1234567')).toEqual(['N:03-1234567'])
    expect(split('18%')).toEqual(['N:18%'])
    expect(split('₪1,180.00')).toEqual(['N:₪1,180.00'])
  })

  it('splits signs and brackets off numbers, so the line can move them', () => {
    expect(split('300.00-')).toEqual(['N:300.00', 'O:-'])
    expect(split('(100.00)')).toEqual(['O:(', 'N:100.00', 'O:)'])
    expect(split('+972-3-1234567')).toEqual(['O:+', 'N:972-3-1234567'])
  })

  it('splits a code into its Latin and number parts, and keeps inner punctuation of words', () => {
    expect(split('ABC-12')).toEqual(['L:ABC', 'O:-', 'N:12'])
    expect(split('e.g.')).toEqual(['L:e.g', 'O:.'])
    expect(split("O'Brien")).toEqual(["L:O'Brien"])
    expect(split('סה"כ')).toEqual(['R:סה"כ'])
  })

  it('keeps a word from a pdf.js RTL run whole (it is already logical)', () => {
    expect(split('לתשלום:', true)).toEqual(['R:לתשלום:'])
    expect(split('ב-12', true)).toEqual(['R:ב-12'])
    expect(split('(5)', true)).toEqual(['O:(', 'N:5', 'O:)'])
  })

  it('reports the extent of each piece', () => {
    const [a, b] = splitToken(chars('ABC12'), false)
    expect([a.s, a.t, b.s, b.t]).toEqual([0, 3, 3, 5])
  })

  it('drops invisible characters', () => {
    expect(split('‏תאריך‎')).toEqual(['R:תאריך'])
  })
})

describe('wordClass', () => {
  it('classifies whole OCR words', () => {
    expect(wordClass('תאריך:')).toBe('R')
    expect(wordClass('INV-778')).toBe('L')
    expect(wordClass('1,180.00')).toBe('N')
    expect(wordClass('₪')).toBe('O')
  })
})
