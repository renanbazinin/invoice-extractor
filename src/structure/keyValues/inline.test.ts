import { describe, expect, it } from 'vitest'
import { matchLabels } from '../../semantic'
import { inlinePairs, labelColons, segmentsOf } from './inline'

function pairs(text: string): [string, string][] {
  return inlinePairs(text, matchLabels(text)).map((p) => [text.slice(p.label.start, p.label.end), text.slice(p.value.start, p.value.end)])
}

describe('segmentsOf', () => {
  it('splits a contact strip at bars and middle dots', () => {
    const t = "טל': 08-0000104 | דוא\"ל: a@b.co.il · www.b.co.il"
    expect(segmentsOf(t).map((s) => t.slice(s.start, s.end).trim())).toEqual(["טל': 08-0000104", 'דוא"ל: a@b.co.il', 'www.b.co.il'])
  })
})

describe('labelColons', () => {
  it('ignores the colon of a time', () => {
    const t = 'שעה: 18:23'
    expect(labelColons(t, 0, t.length)).toEqual([3])
  })
})

describe('inlinePairs', () => {
  it('reads several pairs of one line', () => {
    expect(pairs("טל': 08-0000104 | דוא\"ל: sales@dekel.example")).toEqual([
      ["טל'", '08-0000104'],
      ['דוא"ל', 'sales@dekel.example'],
    ])
  })

  it('keeps an unknown label whole up to its colon', () => {
    expect(pairs("מס' קופה: 3")).toEqual([["מס' קופה", '3']])
    expect(pairs('Exchange rate : 1 USD = 3.5980 ILS')).toEqual([['Exchange rate', '1 USD = 3.5980 ILS']])
  })

  it('keeps the full printed label of a reference to another document', () => {
    expect(pairs("תשלום עבור חשבונית מס': 16802")).toEqual([["תשלום עבור חשבונית מס'", '16802']])
    expect(pairs('בגין חשבונית 5344')).toEqual([['בגין חשבונית', '5344']])
  })

  it('splits colon-labelled pairs that follow one another without separators', () => {
    expect(pairs('תאריך: 16/02/2025 שעה: 10:30')).toEqual([
      ['תאריך', '16/02/2025'],
      ['שעה', '10:30'],
    ])
  })

  it('does not pair prose, addresses, times or two labels side by side', () => {
    expect(pairs('חשבונית זו הופקה באופן ממוחשב')).toEqual([])
    expect(pairs('רחוב האלה 90')).toEqual([])
    expect(pairs('15:21 28.02.2026')).toEqual([])
    expect(pairs("מס' צ'ק / אסמכתא")).toEqual([])
  })

  it('takes a terms word as the value of a terms label', () => {
    expect(pairs('תנאי תשלום שוטף')).toEqual([['תנאי תשלום', 'שוטף']])
    expect(pairs('תנאי תשלום 30 יום')).toEqual([['תנאי תשלום', '30 יום']])
  })

  it('does not split a terms value at a lexicon word inside it', () => {
    expect(pairs('שוטף + 30')).toEqual([])
    expect(pairs('Pago a 60 días')).toEqual([])
  })

  it('does not take a city and zip code for a label and a value', () => {
    expect(pairs('קריית שמונה 1105385')).toEqual([])
  })
})
