import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { invoice, issueCodes } from './testing'
import { compatibleTypes, titleRemainder, typeChangingWords } from './title'

describe('document titles', () => {
  it('accounts for type phrases, copy marks, number signs and numbers', () => {
    expect(titleRemainder('חשבונית מס (מקור)')).toEqual({ rest: '', types: ['tax_invoice'] })
    expect(titleRemainder("חשבונית מס / קבלה מס' 7683")).toEqual({ rest: '', types: ['tax_invoice_receipt'] })
    expect(titleRemainder('Tax Invoice No. 2026/0388').rest).toBe('')
    expect(titleRemainder('DEBIT NOTE · מקור')).toEqual({ rest: '', types: ['debit_note'] })
    expect(titleRemainder('חיוב').rest).toBe('חיוב')
  })

  it('blocks only on words that change the type, not on descriptive words or document numbers', () => {
    expect(typeChangingWords(titleRemainder('חשבון חשמל תקופתי').rest)).toEqual([])
    expect(typeChangingWords(titleRemainder('חשבונית מס מרכזת שירותי תקשורת').rest)).toEqual([])
    expect(titleRemainder('חשבונית מס INV-26-0412').rest).toBe('')
    expect(typeChangingWords(titleRemainder('חשבונית חיוב').rest)).toEqual([])
    expect(typeChangingWords('חיוב')).toEqual(['חיוב'])
    expect(typeChangingWords('טיוטה')).toEqual(['טיוטה'])
    expect(typeChangingWords('Invoice DRAFT')).toEqual(['draft'])
  })

  it('treats a generic title as compatible with a more specific one, not the other way round', () => {
    expect(compatibleTypes('tax_invoice', 'invoice')).toBe(true)
    expect(compatibleTypes('tax_invoice_receipt', 'receipt')).toBe(true)
    expect(compatibleTypes('invoice', 'debit_note')).toBe(false)
    expect(compatibleTypes('tax_invoice', 'receipt')).toBe(false)
  })

  it('does not verify a title that another line of its block contradicts', () => {
    // "חשבונית" | "חיוב" split into two lines, with "DEBIT NOTE · מקור" under them.
    const out = resolve(invoice().docType('invoice', { raw: 'חשבונית', score: 0.9, block: 't' }).textLine('DEBIT NOTE · מקור', { block: 't' }).build())
    expect(out.fields.document_type!.status).toBe('needs_review')
    expect(issueCodes(out)).toContain('title.conflicting_type')
  })

  it('does not verify a title with words the type does not explain', () => {
    const out = resolve(invoice().docType('invoice', { raw: 'חשבונית', score: 0.9, block: 't' }).textLine('חיוב', { block: 't' }).build())
    expect(out.fields.document_type!.status).not.toBe('verified')
    expect(issueCodes(out)).toContain('title.unexplained')
  })

  it('verifies a bilingual title of compatible types', () => {
    const out = resolve(invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9, block: 't' }).textLine('TAX INVOICE · ORIGINAL', { block: 't' }).build())
    expect(out.fields.document_type!.status).toBe('verified')
  })

  it('does not verify an OCR-read title: OCR can drop a whole word of it', () => {
    const out = resolve(invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9, conf: 0.95 }).build())
    expect(out.fields.document_type!.status).toBe('proposed')
  })
})
