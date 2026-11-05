import { describe, expect, it } from 'vitest'
import { classifyDocumentTypePlus, despace, matchLabelsPlus } from './lexicon'

const concepts = (text: string) => matchLabelsPlus(text).map((m) => m.concept)

describe('despace', () => {
  it('joins letter-spaced headings back into words, keeping the breaks a phrase needs', () => {
    expect(despace('I N V O I C E')?.text).toBe('INVOICE')
    expect(despace('C U S TO M E R')?.text).toBe('CUSTOMER')
    expect(despace('D E L I V E R TO')?.text).toBe('DELIVER TO')
    expect(despace('P R O F O R M A I N V O I C E')?.text).toBe('PROFORMA INVOICE')
    expect(despace('* * * ח ש ב ו נ י ת ז י כ ו י * * *')?.text).toBe('* * * חשבונית זיכוי * * *')
  })

  it('joins a kerning split of an upper-case heading', () => {
    expect(despace('FAC TUURNUMMER')?.text).toBe('FACTUURNUMMER')
    expect(despace('TOTA L')?.text).toBe('TOTAL')
  })

  it('leaves text the lexicon already reads, and unknown spaced letters, alone', () => {
    expect(despace('INVOICE NO')).toBeNull()
    expect(despace('Invoice No.')).toBeNull()
    expect(despace('H A I F A')).toBeNull()
    expect(despace('A B C Ltd')).toBeNull()
  })
})

describe('matchLabelsPlus', () => {
  it('maps matches of a letter-spaced heading back to the printed characters', () => {
    const [m] = matchLabelsPlus('S U P P L I E R')
    expect(m?.concept).toBe('role.supplier')
    expect(m?.start).toBe(0)
    expect(m?.end).toBe('S U P P L I E R'.length)
    expect(m?.text).toBe('S U P P L I E R')
  })

  it('reads the customer-marker abbreviation and party phrases the lexicon lacks', () => {
    expect(concepts("לכב'")).toEqual(['role.customer'])
    expect(concepts("לכב': מלונות חוף הכרמל בע\"מ")[0]).toBe('role.customer')
    expect(concepts('מזמין העבודה')).toEqual(['role.customer'])
    expect(concepts('פרטי המחזיק בנכס')).toEqual(['role.customer'])
    expect(concepts('חשבון עבור')).toEqual(['role.customer'])
    expect(concepts('פרטי העוסק')).toEqual(['role.supplier'])
  })
})

describe('classifyDocumentTypePlus', () => {
  it('classifies letter-spaced titles with offsets into the printed text', () => {
    const m = classifyDocumentTypePlus('P R O F O R M A I N V O I C E')
    expect(m?.type).toBe('proforma')
    expect(m?.start).toBe(0)
    expect(classifyDocumentTypePlus('* * * ח ש ב ו נ י ת ז י כ ו י * * *')?.type).toBe('credit_note')
  })
})
