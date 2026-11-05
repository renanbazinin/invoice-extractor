import { describe, expect, it } from 'vitest'
import { findCurrencies, parseCurrency } from './currency'
import { findAmounts, inferNumberFormat, parseAmount, parsePercent, parseQuantity, readNumber } from './numbers'
import type { NumberFormat } from './types'

const amount = (text: string, fmt?: NumberFormat): string | null => parseAmount(text, fmt)?.amount ?? null
const EU: NumberFormat = { decimal: ',', group: '.', confidence: 0.9 }
const US: NumberFormat = { decimal: '.', group: ',', confidence: 0.9 }

describe('parseAmount: number formats', () => {
  it('reads grouping and decimal separators exactly', () => {
    expect(amount('1,234.56')).toBe('1234.56')
    expect(amount('1.234,56')).toBe('1234.56')
    expect(amount('1 234,56')).toBe('1234.56')
    expect(amount('1 234,56')).toBe('1234.56')
    expect(amount('1 234,56')).toBe('1234.56')
    expect(amount("1'234.56")).toBe('1234.56')
    expect(amount('1’234.56')).toBe('1234.56')
    expect(amount('1,234,567.89')).toBe('1234567.89')
    expect(amount('1.234.567')).toBe('1234567')
    expect(amount('1234')).toBe('1234')
    expect(amount('.50')).toBe('0.50')
    expect(amount('0.50')).toBe('0.50')
    expect(amount('12,5')).toBe('12.5')
    expect(amount('1180.00')).toBe('1180.00')
  })

  it('keeps the printed decimals (no float rounding)', () => {
    expect(amount('0.10')).toBe('0.10')
    expect(amount('99999999999999.99')).toBe('99999999999999.99')
    expect(parseAmount('1,180.00')?.decimals).toBe(2)
  })

  it('flags 1,234 / 1.234 as ambiguous and resolves them with the document format', () => {
    const p = parseAmount('1,234')!
    expect(p.amount).toBe('1234')
    expect(p.ambiguous).toBe(true)
    expect(p.alternative).toBe('1.234')
    expect(amount('1.234', EU)).toBe('1234')
    expect(amount('1,234', EU)).toBe('1.234')
    expect(amount('1,234', US)).toBe('1234')
    expect(parseAmount('1,234', US)?.ambiguous).toBe(false)
    expect(parseAmount('0,250')?.ambiguous).toBe(false)
    expect(amount('0,250')).toBe('0.250')
  })

  it('lets evidence beat the document format', () => {
    expect(amount('12.50', EU)).toBe('12.50')
    expect(amount('1,234.56', EU)).toBe('1234.56')
  })

  it('handles every kind of minus sign', () => {
    expect(amount('-123.45')).toBe('-123.45')
    expect(amount('123.45-')).toBe('-123.45')
    expect(amount('(123.45)')).toBe('-123.45')
    expect(amount('−123.45')).toBe('-123.45')
    expect(amount('- 123.45 ₪')).toBe('-123.45')
    expect(amount('-0.00')).toBe('0.00')
    expect(parseAmount('(123.45)')?.negative).toBe(true)
    expect(amount('(123.45')).toBeNull()
    expect(amount('-(123.45)')).toBeNull()
  })

  it('reads currencies before or after, with or without spaces', () => {
    expect(parseAmount('₪1,180.00')).toMatchObject({ amount: '1180.00', currency: 'ILS' })
    expect(parseAmount('1,180.00 ₪')).toMatchObject({ amount: '1180.00', currency: 'ILS' })
    expect(parseAmount('1,180.00 ש"ח')).toMatchObject({ amount: '1180.00', currency: 'ILS' })
    expect(parseAmount('1,180.00 ש״ח')).toMatchObject({ amount: '1180.00', currency: 'ILS' })
    expect(parseAmount("1,180.00 ש''ח")).toMatchObject({ amount: '1180.00', currency: 'ILS' })
    expect(parseAmount('500 שח')).toMatchObject({ amount: '500', currency: 'ILS' })
    expect(parseAmount('NIS 500')).toMatchObject({ amount: '500', currency: 'ILS' })
    expect(parseAmount('US$ 12.50')).toMatchObject({ amount: '12.50', currency: 'USD' })
    expect(parseAmount('$12.50')).toMatchObject({ amount: '12.50', currency: 'USD' })
    expect(parseAmount('€ 1.234,56')).toMatchObject({ amount: '1234.56', currency: 'EUR' })
    expect(parseAmount('1.234,56 EUR')).toMatchObject({ amount: '1234.56', currency: 'EUR' })
    expect(parseAmount('£12')).toMatchObject({ amount: '12', currency: 'GBP' })
    expect(parseAmount('CHF 1’250.50')).toMatchObject({ amount: '1250.50', currency: 'CHF' })
    expect(parseAmount('Fr. 12.-')).toMatchObject({ amount: '12', currency: 'CHF' })
  })

  it('returns the span as printed', () => {
    const p = parseAmount('  ₪ 1,180.00 ')!
    expect(p.raw).toBe('₪ 1,180.00')
    expect(p.start).toBe(2)
  })

  it('rejects things that are not one amount', () => {
    expect(amount('03-1234567')).toBeNull()
    expect(amount('0501234567')).toBeNull()
    expect(amount('18%')).toBeNull()
    expect(amount('31/10/2026')).toBeNull()
    expect(amount('31.10.2026')).toBeNull()
    expect(amount('12 34')).toBeNull()
    expect(amount('1,23,4')).toBeNull()
    expect(amount('100 USD 200')).toBeNull()
    expect(amount('100 € $')).toBeNull()
    expect(amount('סה"כ 100')).toBeNull()
    expect(amount('')).toBeNull()
    expect(amount('INV-100')).toBeNull()
  })
})

describe('readNumber', () => {
  it('validates thousands groups', () => {
    expect(readNumber('1,234,567')?.int).toBe('1234567')
    expect(readNumber('12,34,567')).toBeNull()
    expect(readNumber('1.234,567.8')).toBeNull()
  })
})

describe('findAmounts', () => {
  it('scans a Hebrew summary line', () => {
    const found = findAmounts('סה"כ לתשלום 1,180.00 ₪ מע"מ 18% 180.00')
    expect(found.map((a) => a.amount)).toEqual(['1180.00', '180.00'])
    expect(found[0].currency).toBe('ILS')
  })

  it('skips phones, dates and percentages and keeps space-separated numbers apart', () => {
    expect(findAmounts("טל' 03-1234567 תאריך 31/10/2026").map((a) => a.amount)).toEqual([])
    expect(findAmounts('2 100.00 200.00').map((a) => a.amount)).toEqual(['2', '100.00', '200.00'])
    expect(findAmounts('2 100,00', { decimal: ',', group: ' ', confidence: 0.8 }).map((a) => a.amount)).toEqual(['2100.00'])
    expect(findAmounts('1 234,56 €').map((a) => a.amount)).toEqual(['1234.56'])
    expect(findAmounts('% 18 180.00').map((a) => a.amount)).toEqual(['180.00'])
    expect(findAmounts('17 אחוז').map((a) => a.amount)).toEqual([])
  })

  it('reads amounts glued to a colon label', () => {
    expect(findAmounts('Total:1,180.00').map((a) => a.amount)).toEqual(['1180.00'])
  })
})

describe('inferNumberFormat', () => {
  it('votes from the whole document', () => {
    expect(inferNumberFormat(['1.234,56', '12,50', 'Datum 31.10.2026', '3,00'])).toMatchObject({ decimal: ',', group: '.' })
    expect(inferNumberFormat(['1,180.00', '180.00'])).toMatchObject({ decimal: '.', group: ',' })
    expect(inferNumberFormat(['1 234,56', '10,00'])).toMatchObject({ decimal: ',', group: ' ' })
    expect(inferNumberFormat(["1'234.50", '20.00'])).toMatchObject({ decimal: '.', group: "'" })
    expect(inferNumberFormat(['1.234.567'])).toMatchObject({ decimal: ',', group: '.' })
  })

  it('says when nothing decided it', () => {
    expect(inferNumberFormat(['1,234', 'hello', "03-1234567"])).toEqual({ decimal: '.', group: ',', confidence: 0 })
    expect(inferNumberFormat([]).confidence).toBe(0)
    expect(inferNumberFormat(['1,180.00', '180.00', '1,000.00']).confidence).toBeGreaterThan(0.6)
  })
})

describe('parsePercent', () => {
  it('reads percentages in Hebrew and Latin spellings', () => {
    expect(parsePercent('18%')?.value).toBe('18')
    expect(parsePercent('18.00 %')?.value).toBe('18.00')
    expect(parsePercent('% 18')?.value).toBe('18')
    expect(parsePercent('%18')?.value).toBe('18')
    expect(parsePercent('17 אחוז')?.value).toBe('17')
    expect(parsePercent('18 אחוזים')?.value).toBe('18')
    expect(parsePercent('מע"מ 18%')).toMatchObject({ value: '18', raw: '18%', start: 5 })
    expect(parsePercent('18,5%')?.value).toBe('18.5')
    expect(parsePercent('19 Prozent')?.value).toBe('19')
    expect(parsePercent('0%')?.value).toBe('0')
  })

  it('binds % to the glued number', () => {
    expect(parsePercent('מע"מ 18% 180.00')?.value).toBe('18')
    expect(parsePercent('180.00 %18')?.value).toBe('18')
  })

  it('rejects non-percentages', () => {
    expect(parsePercent('18')).toBeNull()
    expect(parsePercent('150%')).toBeNull()
    expect(parsePercent('מע"מ')).toBeNull()
  })
})

describe('parseQuantity', () => {
  it('reads quantities with units', () => {
    expect(parseQuantity('3')?.value).toBe('3')
    expect(parseQuantity('2.5')?.value).toBe('2.5')
    expect(parseQuantity('1,5')?.value).toBe('1.5')
    expect(parseQuantity("10 יח'")).toMatchObject({ value: '10', unit: "יח'" })
    expect(parseQuantity('3 שעות')).toMatchObject({ value: '3', unit: 'שעות' })
    expect(parseQuantity('3 hrs')).toMatchObject({ value: '3', unit: 'hrs' })
    expect(parseQuantity('x2')).toMatchObject({ value: '2', unit: null })
    expect(parseQuantity('-1')?.value).toBe('-1')
    expect(parseQuantity('ten')).toBeNull()
    expect(parseQuantity('2 100')).toBeNull()
  })
})

describe('parseCurrency', () => {
  it('maps symbols, codes and words to ISO 4217', () => {
    expect(parseCurrency('₪')).toBe('ILS')
    expect(parseCurrency('ש"ח')).toBe('ILS')
    expect(parseCurrency('ש״ח')).toBe('ILS')
    expect(parseCurrency('שקלים חדשים')).toBe('ILS')
    expect(parseCurrency('סה"כ בש"ח')).toBe('ILS')
    expect(parseCurrency('NIS')).toBe('ILS')
    expect(parseCurrency('ILS')).toBe('ILS')
    expect(parseCurrency('US$')).toBe('USD')
    expect(parseCurrency('$')).toBe('USD')
    expect(parseCurrency('דולר')).toBe('USD')
    expect(parseCurrency('€')).toBe('EUR')
    expect(parseCurrency('יורו')).toBe('EUR')
    expect(parseCurrency('אירו')).toBe('EUR')
    expect(parseCurrency('£')).toBe('GBP')
    expect(parseCurrency('ליש"ט')).toBe('GBP')
    expect(parseCurrency('CHF')).toBe('CHF')
    expect(parseCurrency('¥')).toBe('JPY')
    expect(parseCurrency('A$ 10')).toBe('AUD')
    expect(parseCurrency('usd')).toBe('USD')
  })

  it('does not see currencies inside words', () => {
    expect(parseCurrency('שחור')).toBeNull()
    expect(parseCurrency('Europe')).toBeNull()
    expect(parseCurrency('hello')).toBeNull()
    expect(parseCurrency('the euro zone')).toBe('EUR')
    expect(parseCurrency('kr 100')).toBeNull()
  })

  it('lists every mention with its span', () => {
    const m = findCurrencies('100 ₪ = 27 USD')
    expect(m.map((c) => c.code)).toEqual(['ILS', 'USD'])
    expect(m[1]).toMatchObject({ raw: 'USD', start: 11, end: 14 })
  })
})
