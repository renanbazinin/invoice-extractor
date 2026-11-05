import { describe, expect, it } from 'vitest'
import { senseOf } from './sense'

describe('senseOf', () => {
  it('reads a field phrase as the subject of a label over other words in it', () => {
    const s = senseOf('סה"כ עבודה נוספת')
    expect(s.primary?.concept).toBe('subtotal')
    expect(s.concepts).toContain('total')
    expect(s.exact).toBe(false)
  })

  it('prefers a strong tax-id phrase over a weak number sign', () => {
    expect(senseOf('EIN #:').primary?.concept).toBe('party.tax_id')
  })

  it('reads a document title with a number sign as the document number', () => {
    const s = senseOf("מס' חשבון תקופתי")
    expect(s.primary?.concept).toBe('invoice_number')
    expect(s.exact).toBe(true)
  })

  it('takes both readings of a bilingual totals label', () => {
    const s = senseOf('סכום לתשלום / Total:')
    expect(s.concepts).toEqual(expect.arrayContaining(['amount_due', 'total']))
    expect(s.exact).toBe(true)
  })

  it('does not read a tax word inside a sum label as a tax reading', () => {
    expect(senseOf('סה"כ חיובים לפני מע"מ').concepts).not.toContain('tax')
  })

  it('marks words that change the meaning (a reference to another invoice)', () => {
    const s = senseOf("תשלום עבור חשבונית מס'")
    expect(s.primary?.concept).toBe('invoice_number')
    expect(s.exact).toBe(false)
    expect(s.extraBefore).toBeGreaterThan(0)
  })

  it('tries the Hebrew construct state when nothing matched as printed', () => {
    const s = senseOf('עמלת טיפול 3%')
    expect(s.primary?.concept).toBe('other.charge')
    expect(s.exact).toBe(false)
    expect(s.percent?.value).toBe('3')
  })
})
