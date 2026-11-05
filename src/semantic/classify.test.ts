import { describe, expect, it } from 'vitest'
import { classifyValue, expectedKinds } from './classify'

const top = (text: string, concept?: string): string | undefined => classifyValue(text, { concept })[0]?.kind
const kinds = (text: string, concept?: string): string[] => classifyValue(text, { concept }).map((g) => g.kind)

describe('classifyValue', () => {
  it('ranks the obvious reading first without context', () => {
    expect(top('1,180.00 ₪')).toBe('amount')
    expect(top('31/10/2026')).toBe('date')
    expect(top('18%')).toBe('percent')
    expect(top('info@acme.co.il')).toBe('email')
    expect(top('IL62 0108 0000 0009 9999 999')).toBe('iban')
    expect(top('03-1234567')).toBe('phone')
    expect(top('INV-2026-0042')).toBe('id')
    expect(top('ACME בע"מ')).toBe('text')
    expect(top('₪')).toBe('currency')
  })

  it('never offers an amount for a percentage, a date or a formatted phone', () => {
    expect(kinds('18%')).not.toContain('amount')
    expect(kinds('31/10/2026')).not.toContain('amount')
    expect(kinds('03-1234567')).not.toContain('amount')
  })

  it('lets the label decide: a phone label makes digits a phone, not an amount', () => {
    const g = classifyValue('0501234567', { concept: 'party.phone' })
    expect(g[0].kind).toBe('phone')
    expect(g[0].value).toBe('0501234567')
    expect(g.find((x) => x.kind === 'amount')).toBeUndefined()
    expect(top('03-1234567', 'trap.fax')).toBe('phone')
  })

  it('reads a valid Israeli id as a tax id under a tax-id label', () => {
    const g = classifyValue('516123452', { concept: 'party.tax_id' })
    expect(g[0]).toMatchObject({ kind: 'tax_id', value: '516123452' })
  })

  it('prefers an identifier for invoice numbers and an amount for totals', () => {
    expect(top('12345', 'invoice_number')).toBe('id')
    expect(top('12345', 'total')).toBe('amount')
    expect(top('1,180.00', 'total')).toBe('amount')
    expect(top('18%', 'tax')).toBe('percent')
    expect(top('180.00', 'tax')).toBe('amount')
  })

  it('uses the document number format', () => {
    const g = classifyValue('1.234', { concept: 'total', numberFormat: { decimal: ',', group: '.', confidence: 0.9 } })
    expect(g[0]).toMatchObject({ kind: 'amount', value: '1234' })
    const h = classifyValue('1,234', { concept: 'total', numberFormat: { decimal: ',', group: '.', confidence: 0.9 } })
    expect(h[0]).toMatchObject({ kind: 'amount', value: '1.234' })
  })

  it('exposes what a concept expects', () => {
    expect(expectedKinds('invoice_date')).toEqual(['date'])
    expect(expectedKinds('party.phone')).toEqual(['phone'])
    expect(expectedKinds('nope')).toEqual([])
  })
})
