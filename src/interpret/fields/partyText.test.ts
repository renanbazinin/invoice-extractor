import { describe, expect, it } from 'vitest'
import { addressScore, cityLike, hasLegalSuffix, legalOwner, nameScore, onlySuffix } from './partyText'

describe('addressScore', () => {
  it('recognises street lines, postal codes and house numbers in several languages', () => {
    expect(addressScore("רח' הברזל 6")).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('ת.ד. 5834, חולון 5800064')).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('Industriestraße 98')).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('50803 Köln')).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('5826 Industrial Way')).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('החשמונאים 129')).toBeGreaterThanOrEqual(0.65)
  })

  it('rejects names, contacts, references and amounts', () => {
    expect(addressScore('חומרי בניין דקל בע"מ')).toBe(0)
    expect(addressScore("טל': 08-0000104")).toBe(0)
    expect(addressScore('עבור חשבונית 77879')).toBe(0)
    expect(addressScore('ILS 43,473.68')).toBe(0)
    expect(addressScore('www.dekel-pro.co.il')).toBe(0)
  })
})

describe('cityLike', () => {
  it('takes a short place line and refuses a web address', () => {
    expect(cityLike('ראשון לציון')).toBe(true)
    expect(cityLike('www.alon.co.il')).toBe(false)
  })
})

describe('names', () => {
  it('scores legal names highest and refuses labels, contacts and ids', () => {
    expect(nameScore('ספיר הובלות (2008) בע"מ')).toBe(0.95)
    expect(nameScore('עדי מזרחי')).toBe(0.7)
    expect(nameScore('טל: 03-1234567')).toBe(0)
    expect(nameScore('510000037')).toBe(0)
  })

  it('knows legal suffixes and a suffix alone', () => {
    expect(hasLegalSuffix('Vogel Partners GmbH & Co.')).toBe(true)
    expect(onlySuffix('KG')).toBe(true)
    expect(onlySuffix('Partners KG')).toBe(false)
  })
})

describe('party text shapes on unfamiliar layouts', () => {
  it('reads a company name with a street word in it as a name, not an address', () => {
    expect(addressScore('Harbor Lane Logistics (2009) Ltd.')).toBe(0)
    expect(nameScore('Harbor Lane Logistics (2009) Ltd.')).toBeGreaterThan(0.9)
    expect(nameScore('מוסך דרך הבשמים בע"מ')).toBeGreaterThan(0.9)
  })

  it('knows more legal forms (mbB, s.r.o., Pty Ltd, ושות\')', () => {
    expect(hasLegalSuffix('Kanzlei Weidner & Partner mbB')).toBe(true)
    expect(hasLegalSuffix('Vltava Precision s.r.o.')).toBe(true)
    expect(hasLegalSuffix('Kestrel Ridge Advisory Pty Ltd')).toBe(true)
    expect(hasLegalSuffix("גולדנברג, קפלן ושות' - רואי חשבון")).toBe(true)
  })

  it('reads foreign postal formats and business-park lines as addresses, and dates as nothing', () => {
    expect(addressScore('617 00 Brno, Czech Republic')).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('Melbourne VIC 3000')).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('Unit 3B, Hartwell Business Park')).toBeGreaterThanOrEqual(0.65)
    expect(addressScore('24 October 2026')).toBe(0)
    expect(addressScore('Park Hotel')).toBe(0)
  })

  it('never takes a heading or a label for a name', () => {
    expect(nameScore('שם האורח')).toBe(0)
    expect(nameScore('פרטי האירוע')).toBe(0)
    expect(nameScore('Name of guest')).toBe(0)
  })
})

describe('legalOwner', () => {
  it('finds the legal entity a line names together with the trading name', () => {
    const he = 'השם המסחרי "קפה שחור-לבן" הוא בבעלות נ.ע. משקאות ושיווק (2019) בע"מ, ח.פ. 510000052, רח\' הקלייה 4, לוד 7124004.'
    const a = legalOwner(he, 'קפה שחור-לבן')!
    expect(he.slice(a.start, a.end)).toBe('נ.ע. משקאות ושיווק (2019) בע"מ')
    const en = 'Kestrel is a trading name of Kestrel Ridge Advisory Pty Ltd, ACN 823 077 461.'
    const b = legalOwner(en, 'Kestrel')!
    expect(en.slice(b.start, b.end)).toBe('Kestrel Ridge Advisory Pty Ltd')
  })

  it('needs the trading name on the line', () => {
    expect(legalOwner('Printed by Acme Print Ltd', 'Kestrel')).toBeNull()
  })
})
