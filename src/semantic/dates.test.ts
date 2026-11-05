import { describe, expect, it } from 'vitest'
import { findDates, inferDateOrder, parseDate } from './dates'

const iso = (text: string, hints?: Parameters<typeof parseDate>[1]): string | null => parseDate(text, hints)?.iso ?? null

describe('parseDate: numeric', () => {
  it('reads day-first numeric dates', () => {
    expect(iso('31/10/2026')).toBe('2026-10-31')
    expect(iso('31.10.26')).toBe('2026-10-31')
    expect(iso('31-10-2026')).toBe('2026-10-31')
    expect(iso('31/10/26')).toBe('2026-10-31')
    expect(iso('1.11.2026')).toBe('2026-11-01')
    expect(iso('01/11/2026')).toBe('2026-11-01')
    expect(iso('31 / 10 / 2026')).toBe('2026-10-31')
  })

  it('reads ISO year-first dates', () => {
    expect(parseDate('2026-10-31')).toMatchObject({ iso: '2026-10-31', order: 'YMD', format: 'YYYY-MM-DD', ambiguous: false })
    expect(iso('2026/10/31')).toBe('2026-10-31')
  })

  it('keeps the other reading of an ambiguous date', () => {
    const d = parseDate('03/04/2026')!
    expect(d.iso).toBe('2026-04-03')
    expect(d.alternatives).toEqual(['2026-03-04'])
    expect(d.ambiguous).toBe(true)
    expect(parseDate('05/05/2026')?.alternatives).toEqual([])
  })

  it('uses month-first only with evidence, and falls back when the calendar says so', () => {
    expect(iso('03/04/2026', { order: 'MDY' })).toBe('2026-03-04')
    expect(iso('03/04/2026', { locale: 'en-US' })).toBe('2026-03-04')
    expect(iso('03/04/2026', { locale: 'en-GB' })).toBe('2026-04-03')
    expect(parseDate('10/31/2026')).toMatchObject({ iso: '2026-10-31', order: 'MDY', ambiguous: false })
    expect(iso('31/10/2026', { order: 'MDY' })).toBe('2026-10-31')
  })

  it('validates the calendar', () => {
    expect(parseDate('31/02/2026')).toBeNull()
    expect(parseDate('29/02/2026')).toBeNull()
    expect(iso('29/02/2024')).toBe('2024-02-29')
    expect(parseDate('31/04/2026')).toBeNull()
    expect(parseDate('00/10/2026')).toBeNull()
    expect(parseDate('12/13/14/2026')).toBeNull()
    expect(parseDate('31/10')).toBeNull()
  })

  it('reads two-digit years as 20xx', () => {
    expect(iso('01.01.99')).toBe('2099-01-01')
    expect(iso('15/08/05')).toBe('2005-08-15')
  })

  it('does not take numbers that are not dates', () => {
    expect(parseDate('03-1234567')).toBeNull()
    expect(parseDate('1,234.56')).toBeNull()
    expect(parseDate('INV2026/10/31')).toBeNull()
    expect(parseDate('1.2.3.4')).toBeNull()
  })
})

describe('parseDate: month names', () => {
  it('reads Hebrew month names with and without the ב prefix', () => {
    expect(iso('31 באוקטובר 2026')).toBe('2026-10-31')
    expect(iso('31 בדצמבר, 2026')).toBe('2026-12-31')
    expect(iso('1 ינואר 2027')).toBe('2027-01-01')
    expect(iso("15 אוג' 2026")).toBe('2026-08-15')
    expect(iso('3 במרץ 2026')).toBe('2026-03-03')
    expect(iso('3 במרס 2026')).toBe('2026-03-03')
    expect(iso('20 בפברואר 2026')).toBe('2026-02-20')
    expect(iso('אוקטובר 31, 2026')).toBe('2026-10-31')
  })

  it('reads English and European month names', () => {
    expect(iso('Oct 31, 2026')).toBe('2026-10-31')
    expect(iso('October 31st, 2026')).toBe('2026-10-31')
    expect(iso('31 October 2026')).toBe('2026-10-31')
    expect(iso('31-Oct-26')).toBe('2026-10-31')
    expect(iso('31. Oktober 2026')).toBe('2026-10-31')
    expect(iso('1. März 2026')).toBe('2026-03-01')
    expect(iso('31 octobre 2026')).toBe('2026-10-31')
    expect(iso('1er février 2026')).toBe('2026-02-01')
    expect(iso('31 de octubre de 2026')).toBe('2026-10-31')
    expect(iso('31 ottobre 2026')).toBe('2026-10-31')
    expect(iso('5 mei 2026')).toBe('2026-05-05')
    expect(iso('31 de outubro de 2026')).toBe('2026-10-31')
    expect(parseDate('30 February 2026')).toBeNull()
  })
})

describe('parseDate: spans', () => {
  it('finds the date inside a labelled line and says it is not the whole text', () => {
    const d = parseDate('תאריך: 15/08/2026')!
    expect(d).toMatchObject({ iso: '2026-08-15', raw: '15/08/2026', start: 7, end: 17, whole: false })
    expect(parseDate('15/08/2026 14:30')?.whole).toBe(true)
    expect(parseDate(' 15/08/2026 ')?.whole).toBe(true)
  })

  it('finds every date in a line', () => {
    const all = findDates('תקופה 01/10/2026 - 31/10/2026')
    expect(all.map((d) => d.iso)).toEqual(['2026-10-01', '2026-10-31'])
  })
})

describe('inferDateOrder', () => {
  it('needs a component above 12 to decide', () => {
    expect(inferDateOrder(['10/31/2026', '11/15/2026'])).toMatchObject({ order: 'MDY', mdyVotes: 2 })
    expect(inferDateOrder(['31/10/2026', '01/11/2026'])).toMatchObject({ order: 'DMY', dmyVotes: 1 })
    expect(inferDateOrder(['01/02/2026', '2026-10-31'])).toEqual({ order: 'DMY', confidence: 0, dmyVotes: 0, mdyVotes: 0 })
    expect(inferDateOrder(['31.10.2026', '25.11.2026', '30.12.2026']).confidence).toBeGreaterThan(0.7)
  })
})
