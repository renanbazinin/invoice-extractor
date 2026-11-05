import { describe, expect, it } from 'vitest'
import {
  findPhones,
  isValidIsraeliId,
  looksLikeIdentifier,
  parseEmail,
  parseIban,
  parseIsraeliBankAccount,
  parsePhone,
  parseTaxId,
} from './ids'

describe('Israeli ids', () => {
  it('checks the official check digit', () => {
    expect(isValidIsraeliId('123456782')).toBe(true)
    expect(isValidIsraeliId('516123452')).toBe(true)
    expect(isValidIsraeliId('520000019')).toBe(true)
    expect(isValidIsraeliId('123456789')).toBe(false)
    expect(isValidIsraeliId('516123453')).toBe(false)
    expect(isValidIsraeliId('30000012')).toBe(true)
    expect(isValidIsraeliId('000000000')).toBe(false)
    expect(isValidIsraeliId('1234567890')).toBe(false)
  })

  it('finds ח.פ / ע.מ / ת.ז numbers next to their labels', () => {
    expect(parseTaxId('ח.פ. 516123452')).toMatchObject({ value: '516123452', scheme: 'IL', checksum: true, raw: '516123452', start: 5 })
    expect(parseTaxId('ע.מ: 51-612345-2')).toMatchObject({ value: '516123452', checksum: true })
    expect(parseTaxId('עוסק מורשה 516123453')).toMatchObject({ value: '516123453', checksum: false })
  })

  it('pads an 8-digit ת.ז in canonical only (value stays as printed)', () => {
    expect(parseTaxId('ת.ז. 30000012')).toMatchObject({ value: '30000012', canonical: '030000012', checksum: true })
  })

  it('prefers a valid id over an invalid one on the same line', () => {
    expect(parseTaxId('514567893 / 514567890')?.value).toBe('514567890')
  })

  it('does not read phones or dates as ids', () => {
    expect(parseTaxId('03-1234567')).toBeNull()
    expect(parseTaxId('050-1234567')).toBeNull()
    expect(parseTaxId('31.10.2026')).toBeNull()
    expect(parseTaxId('1,180.00')).toBeNull()
  })
})

describe('foreign tax ids', () => {
  it('reads prefixed VAT numbers and checks the easy check digits', () => {
    expect(parseTaxId('USt-IdNr. DE123456789')).toMatchObject({ value: 'DE123456789', scheme: 'EU_VAT', country: 'DE', checksum: null })
    expect(parseTaxId('P.IVA IT 00743110157')).toMatchObject({ value: 'IT00743110157', checksum: true })
    expect(parseTaxId('FR40303265045')).toMatchObject({ country: 'FR', checksum: true })
    expect(parseTaxId('FR41303265045')?.checksum).toBe(false)
    expect(parseTaxId('BE0123456749')?.checksum).toBe(true)
    expect(parseTaxId('VAT Reg No: GB 999 9999 73')).toMatchObject({ value: 'GB999999973', scheme: 'GB_VAT', checksum: true })
    expect(parseTaxId('NL004495445B01')).toMatchObject({ country: 'NL', checksum: true })
    expect(parseTaxId('CHE-123.456.788 MWST')).toMatchObject({ scheme: 'CH_UID', country: 'CH', checksum: true })
    expect(parseTaxId('DE 123 456 789 Bank')).toMatchObject({ value: 'DE123456789', raw: 'DE 123 456 789' })
  })

  it('reads US EINs, but 0X-XXXXXXX only with a US hint', () => {
    expect(parseTaxId('EIN 12-3456789')).toMatchObject({ value: '123456789', scheme: 'US_EIN' })
    expect(parseTaxId('03-1234567', { country: 'US' })).toMatchObject({ scheme: 'US_EIN' })
  })

  it('does not take lower-case words as country prefixes', () => {
    expect(parseTaxId('factura de 123456789', { country: 'ES' })?.scheme).toBeNull()
  })
})

describe('parseIban', () => {
  it('checks mod 97 and the country length', () => {
    expect(parseIban('IL62 0108 0000 0009 9999 999')).toMatchObject({ value: 'IL620108000000099999999', country: 'IL', checksum: true, lengthOk: true })
    expect(parseIban('IBAN: DE89 3704 0044 0532 0130 00')).toMatchObject({ value: 'DE89370400440532013000', checksum: true, start: 6 })
    expect(parseIban('GB29 NWBK 6016 1331 9268 19')?.checksum).toBe(true)
    expect(parseIban('IL62 0108 0000 0009 9999 998')?.checksum).toBe(false)
    expect(parseIban('il620108000000099999999')?.checksum).toBe(true)
    expect(parseIban('IL62 0108 0000 0009 9999 999 סניף 800')?.value).toBe('IL620108000000099999999')
    expect(parseIban('03-1234567')).toBeNull()
  })
})

describe('parseIsraeliBankAccount', () => {
  it('reads labelled Hebrew forms', () => {
    expect(parseIsraeliBankAccount('בנק לאומי (10) סניף 800 חשבון 123456')).toMatchObject({ value: '10-800-123456', bankName: 'לאומי' })
    expect(parseIsraeliBankAccount('בנק: 12 סניף: 345 ח-ן: 123456')?.value).toBe('12-345-123456')
    expect(parseIsraeliBankAccount('בנק הפועלים סניף 600 מס\' חשבון 98765')?.value).toBe('12-600-98765')
    expect(parseIsraeliBankAccount('בנק דיסקונט, סניף 123, ח"ן 1234567')?.value).toBe('11-123-1234567')
    expect(parseIsraeliBankAccount('Bank Hapoalim branch 600 account 12345')?.value).toBe('12-600-12345')
  })

  it('reads the compact form only with a known bank code', () => {
    expect(parseIsraeliBankAccount('12-345-123456')).toMatchObject({ bank: '12', branch: '345', account: '123456' })
    expect(parseIsraeliBankAccount('04-123-4567')).toBeNull()
    expect(parseIsraeliBankAccount('77-123-456789')).toBeNull()
  })
})

describe('parseEmail', () => {
  it('finds addresses inside labels', () => {
    expect(parseEmail('דוא"ל: info@acme.co.il.')).toMatchObject({ value: 'info@acme.co.il', start: 7 })
    expect(parseEmail('billing @ example.com')?.value).toBe('billing@example.com')
    expect(parseEmail('www.acme.co.il')).toBeNull()
    expect(parseEmail('a@b')).toBeNull()
  })
})

describe('parsePhone', () => {
  it('normalizes Israeli numbers to national digits', () => {
    expect(parsePhone("טל' 03-1234567")).toMatchObject({ value: '031234567', kind: 'landline', raw: '03-1234567' })
    expect(parsePhone('050-1234567')).toMatchObject({ value: '0501234567', kind: 'mobile' })
    expect(parsePhone('054 123 4567')).toMatchObject({ value: '0541234567', kind: 'mobile' })
    expect(parsePhone('077-1234567')?.kind).toBe('voip')
    expect(parsePhone('+972-3-1234567')).toMatchObject({ value: '031234567', country: 'IL' })
    expect(parsePhone('+972 (0)50 123 4567')?.value).toBe('0501234567')
    expect(parsePhone('972501234567')?.value).toBe('0501234567')
    expect(parsePhone('1-800-123-456')).toMatchObject({ value: '1800123456', kind: 'tollfree' })
    expect(parsePhone('*2700')).toMatchObject({ value: '*2700', kind: 'star' })
    expect(parsePhone('2700*')?.value).toBe('*2700')
  })

  it('reads international and US numbers', () => {
    expect(parsePhone('+44 20 7946 0958')).toMatchObject({ value: '+442079460958', kind: 'intl' })
    expect(parsePhone('(212) 555-1234')).toMatchObject({ value: '2125551234', country: 'US' })
  })

  it('does not take amounts, years, dates or ids', () => {
    expect(parsePhone('1234.56')).toBeNull()
    expect(parsePhone('2026')).toBeNull()
    expect(parsePhone('31-10-2026')).toBeNull()
    expect(parsePhone('0123456789')).toBeNull()
    expect(parsePhone('1,180.00')).toBeNull()
    expect(parsePhone('514567890')).toBeNull()
  })

  it('separates a phone from a fax on one line', () => {
    expect(findPhones("טל' 03-1234567 פקס 03-7654321").map((p) => p.value)).toEqual(['031234567', '037654321'])
  })
})

describe('looksLikeIdentifier', () => {
  it('accepts invoice-number-like tokens', () => {
    for (const t of ['INV-2026-0042', '12345', '2026/17', 'A12', '0012', 'חשב-1001', '#5531']) expect(looksLikeIdentifier(t), t).toBe(true)
  })

  it('rejects dates, amounts, percents, phones and words', () => {
    for (const t of ['31/10/2026', '1,180.00', '12.50', '18%', '03-1234567', 'hello', '', 'info@acme.co.il', '1,234,567']) {
      expect(looksLikeIdentifier(t), t).toBe(false)
    }
  })
})
