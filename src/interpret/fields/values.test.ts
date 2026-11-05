import { describe, expect, it } from 'vitest'
import { looksLikeTerms, readBankAccount, readDate, readIdentifier, readMoney } from './values'

const fmt = { decimal: '.', group: ',', confidence: 0 } as const

describe('readMoney', () => {
  it('reads an amount with its currency mark and span', () => {
    const m = readMoney('ש"ח 25,396.90', fmt)!
    expect(m.value.amount).toBe('25396.90')
    expect(m.value.currency).toBe('ILS')
  })

  it('finds the amount inside words', () => {
    expect(readMoney('סך של ₪ 20,839.86', fmt)!.value.amount).toBe('20839.86')
  })
})

describe('readDate', () => {
  it('puts back a day the bidi ordering moved behind the year', () => {
    const d = readDate('אפריל 2025 21', 'DMY')!
    expect(d.value.iso).toBe('2025-04-21')
    expect(d.raw).toBe('אפריל 2025 21')
    expect(readDate('אוגוסט 2025 17:47 23', 'DMY')!.value.iso).toBe('2025-08-23')
  })

  it('keeps the alternative of an ambiguous date', () => {
    expect(readDate('03/04/2026', 'DMY')!.value.alternatives).toEqual(['2026-03-04'])
  })
})

describe('readIdentifier', () => {
  it('skips number signs and stops at words', () => {
    expect(readIdentifier('Nr. 2026-3219')!.value).toBe('2026-3219')
    expect(readIdentifier('940976 (העתק)')!.value).toBe('940976')
    expect(readIdentifier('an.')).toBeNull()
    expect(readIdentifier('16/02/2025')).toBeNull()
  })
})

describe('readBankAccount', () => {
  it('prefers a valid IBAN and reads spelled-out Israeli accounts', () => {
    expect(readBankAccount('IBAN: IL94 0043 1800 0000 0000 122')!.value.scheme).toBe('iban')
    expect(readBankAccount('בנק מזרחי טפחות (20), סניף 284, חשבון 00000115')!.value.value).toBe('20-284-00000115')
  })
})

describe('looksLikeTerms', () => {
  it('knows payment-terms shapes in several languages', () => {
    for (const t of ['שוטף + 30', 'Net 60', '30 jours fin de mois', 'Due on receipt', 'מזומן']) expect(looksLikeTerms(t)).toBe(true)
    expect(looksLikeTerms('16/02/2025')).toBe(false)
    expect(looksLikeTerms('אבי שרון')).toBe(false)
  })
})
