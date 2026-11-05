import { describe, expect, it } from 'vitest'
import type { DocumentModel, ExtractedField } from '../../model/types'
import { analyzeStructure } from '../../structure'
import { buildDoc } from '../../structure/keyValues/testing'
import { resolve } from '../../validate'
import { leadingPartyNoun } from '../../validate/parties'
import { interpret } from '../index'

/**
 * A party noun printed flush against a name ("לקוח הדמו בע"מ", "Client Focus Ltd.") reads as a
 * label + name or as one name, and nothing on the page tells which. Such a name is never
 * verified. Under a heading of the same party ("לכבוד") the noun is part of the name.
 */
function extract(doc: DocumentModel): Partial<Record<string, ExtractedField>> {
  const structure = analyzeStructure(doc)
  const meaning = interpret(doc, structure)
  return resolve({ document: doc, candidates: meaning.candidates, lineItems: meaning.lineItems }).fields
}

const SUPPLIER = [
  { text: 'סטודיו הדמו בע"מ', x0: 470, x1: 559, y: 40, size: 16, bold: true, block: 's' },
  { text: 'ח.פ. 515555555', x0: 490, x1: 559, y: 62, block: 's' },
  { text: 'טל\' 03-1234567', x0: 495, x1: 559, y: 74, block: 's' },
  { text: 'חשבונית מס', x0: 60, x1: 130, y: 40, size: 18, bold: true, block: 't' },
]

describe('names that start with a party noun', () => {
  it('keeps the noun in the name under a heading of the same party, and does not verify it', () => {
    const fields = extract(
      buildDoc([
        ...SUPPLIER,
        { text: 'לכבוד', x0: 530, x1: 559, y: 110, size: 8, block: 'c' },
        { text: 'לקוח הדמו בע"מ', x0: 480, x1: 559, y: 122, size: 11, bold: true, block: 'c' },
        { text: 'ח.פ. 522222223', x0: 495, x1: 559, y: 136, block: 'c' },
      ]),
    )
    expect(fields['customer.name']?.rawValue).toBe('לקוח הדמו בע"מ')
    expect(fields['customer.name']?.status).not.toBe('verified')
  })

  it('does not verify a name read after a party noun printed flush against it', () => {
    const fields = extract(
      buildDoc([
        ...SUPPLIER,
        { text: 'לקוח הדמו בע"מ', x0: 480, x1: 559, y: 122, size: 11, bold: true, block: 'c' },
        { text: 'ח.פ. 522222223', x0: 495, x1: 559, y: 136, block: 'c' },
      ]),
    )
    expect(fields['customer.name']?.status).not.toBe('verified')
  })

  it('still verifies a name after a salutation or a colon', () => {
    for (const line of ['לכבוד מגן מוצרי נייר בע"מ', 'לקוח: מגן מוצרי נייר בע"מ']) {
      const fields = extract(
        buildDoc([
          ...SUPPLIER,
          { text: line, x0: 440, x1: 559, y: 122, size: 11, block: 'c' },
          { text: 'ח.פ. 522222223', x0: 495, x1: 559, y: 136, block: 'c' },
        ]),
      )
      expect(fields['customer.name']?.rawValue, line).toBe('מגן מוצרי נייר בע"מ')
      expect(fields['customer.name']?.status, line).toBe('verified')
    }
  })

  it('finds the party noun a name starts with', () => {
    expect(leadingPartyNoun('לקוח הדמו בע"מ')).toBe('לקוח')
    expect(leadingPartyNoun('Client Focus Ltd.')).toBe('client')
    expect(leadingPartyNoun('Supplier Hub Ltd')).toBe('supplier')
    expect(leadingPartyNoun('לקוחות פלוס בע"מ')).toBeNull()
    expect(leadingPartyNoun('מגן מוצרי נייר בע"מ')).toBeNull()
    expect(leadingPartyNoun('Customer')).toBeNull()
  })
})
