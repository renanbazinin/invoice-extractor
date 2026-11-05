import { describe, expect, it } from 'vitest'
import type { CanonicalField, DocumentModel, FieldCandidate } from '../../model/types'
import { analyzeStructure } from '../../structure'
import { buildDoc } from '../../structure/keyValues/testing'
import { buildContext } from '../context'
import { interpretLineItems } from '../lineItems'
import { interpretFields } from './index'
import { termsSentence } from './kvFields'
import { domainOf, foreignAccount, loosePhone } from './parties'

/**
 * Layouts the generated corpus does not have: numbers beside the title, addressee abbreviations,
 * scheduled advances, bare dollar signs, footers naming the legal entity, foreign bank formats.
 */

function run(doc: DocumentModel) {
  const structure = analyzeStructure(doc)
  const ctx = buildContext(doc)
  return interpretFields(ctx, structure, interpretLineItems(ctx, structure)).candidates
}

function best(cands: FieldCandidate[], field: CanonicalField): FieldCandidate | undefined {
  return cands.filter((c) => c.field === field).sort((a, b) => b.score - a.score)[0]
}

function value(c: FieldCandidate | undefined): string | undefined {
  if (!c) return undefined
  const n = c.normalized
  return n.kind === 'money' ? n.amount : n.kind === 'currency' ? n.code : n.kind === 'document_type' ? n.value : n.kind === 'id' || n.kind === 'text' ? n.value : undefined
}

describe('title numbers on their own line', () => {
  it('reads "מס\' 40187" under the title as the document number, with the title as its label', () => {
    const c = run(
      buildDoc([
        { text: 'עדי ברקוביץ', x0: 413, x1: 500, y: 39, size: 16.5, bold: true, block: 'a' },
        { text: 'עוסק מורשה 030000046', x0: 413, x1: 500, y: 76, block: 'a' },
        { text: 'חשבונית מס / קבלה', x0: 42, x1: 176, y: 40, size: 15, bold: true, block: 't' },
        { text: "מס' 40187", x0: 42, x1: 92, y: 60, size: 11.3, block: 't' },
        { text: 'מקור', x0: 50, x1: 66, y: 79, size: 8.3, block: 't' },
      ]),
    )
    const n = best(c, 'invoice_number')
    expect(value(n)).toBe('40187')
    expect(n?.method).toBe('header:title-number')
    expect(n?.originalLabel).toContain('חשבונית מס')
  })

  it('reads a number beside the title across its translation', () => {
    const c = run(
      buildDoc([
        { text: 'חשבונית מס (מקור)', x0: 405, x1: 553, y: 123, size: 20, bold: true },
        { text: 'Tax Invoice (Original)', x0: 316, x1: 401, y: 131, size: 8.4, bold: true },
        { text: "מס' No. 2026-1183", x0: 43, x1: 131, y: 131, size: 13, bold: true },
      ]),
    )
    expect(value(best(c, 'invoice_number'))).toBe('2026-1183')
  })
})

describe('party markers', () => {
  it('reads a block under "לכב\'" as the customer, so its ח.פ is not the supplier\'s', () => {
    const c = run(
      buildDoc([
        { text: 'קפה שחור-לבן', x0: 353, x1: 502, y: 41, size: 30, block: 'a' },
        { text: 'חשבונית מס', x0: 473, x1: 550, y: 109, size: 19.5 },
        { text: "לכב'", x0: 367, x1: 380, y: 106, size: 7.9, block: 'c' },
        { text: 'אינטגרה ייעוץ הנדסי בע"מ', x0: 289, x1: 381, y: 120, size: 9.4, bold: true, block: 'c' },
        { text: 'ח.פ. 510000078', x0: 321, x1: 381, y: 135, size: 9.4, block: 'c' },
        { text: "רח' הברוש 18, הוד השרון 4524118", x0: 259, x1: 381, y: 150, size: 9.4, block: 'c' },
      ]),
    )
    expect(value(best(c, 'customer.tax_id'))).toBe('510000078')
    expect(c.some((x) => x.field === 'supplier.tax_id' && value(x) === '510000078')).toBe(false)
    expect(value(best(c, 'customer.name'))).toBe('אינטגרה ייעוץ הנדסי בע"מ')
  })
})

describe('advances on quotes', () => {
  it('does not read a required advance as an amount paid', () => {
    const c = run(
      buildDoc([
        { text: 'הצעת מחיר', x0: 450, x1: 550, y: 60, size: 18, bold: true },
        { text: 'סכום המקדמה (30%):', x0: 430, x1: 556, y: 552 },
        { text: '11,328.00 ₪', x0: 300, x1: 360, y: 552 },
      ]),
    )
    expect(c.some((x) => x.field === 'amount_paid')).toBe(false)
  })
})

describe('currency signs shared by several currencies', () => {
  it('reads "$" as the dollar the page names (AUD in a column header)', () => {
    const c = run(
      buildDoc([
        { text: 'TAX INVOICE', x0: 432, x1: 552, y: 44, size: 20, bold: true },
        { text: 'ABN 51 823 077 461', x0: 475, x1: 553, y: 66 },
        { text: 'AMOUNT (AUD)', x0: 464, x1: 529, y: 250, bold: true },
        { text: 'Total (incl. GST)', x0: 297, x1: 368, y: 400, bold: true },
        { text: '$30,243.40', x0: 497, x1: 549, y: 400, bold: true },
      ]),
    )
    expect(value(best(c, 'currency'))).toBe('AUD')
    const total = c.find((x) => x.field === 'total')
    expect(total?.normalized.kind === 'money' && total.normalized.currency).toBe('AUD')
  })
})

describe('the legal entity behind a trading name', () => {
  it('reads the owner and its address from the fine print', () => {
    const c = run(
      buildDoc([
        { text: 'קפה שחור-לבן', x0: 353, x1: 502, y: 41, size: 30, block: 'a' },
        { text: 'b2b@shachor-lavan.example', x0: 300, x1: 500, y: 75, block: 'a', dir: 'ltr' },
        { text: 'חשבונית מס', x0: 473, x1: 550, y: 140, size: 19.5 },
        {
          text: 'השם המסחרי "קפה שחור-לבן" הוא בבעלות נ.ע. משקאות ושיווק (2019) בע"מ, ח.פ. 510000052, רח\' הקלייה 4, לוד 7124004.',
          x0: 202,
          x1: 550,
          y: 483,
          size: 7.5,
        },
      ]),
    )
    expect(value(best(c, 'supplier.name'))).toBe('נ.ע. משקאות ושיווק (2019) בע"מ')
    expect(value(best(c, 'supplier.address'))).toBe("רח' הקלייה 4, לוד 7124004")
  })
})

describe('value readers', () => {
  it('ends payment terms where the terms end, not where the sentence does', () => {
    const t = termsSentence({ value: '14 dagen. Wij verzoeken u het totaalbedrag vóór 23 oktober 2026', raw: '', start: 0, end: 0 })
    expect(t.value).toBe('14 dagen')
    expect(termsSentence({ value: 'שוטף + 30', raw: '', start: 0, end: 0 }).value).toBe('שוטף + 30')
  })

  it('reads UK, Australian and plain account numbers in the bank-branch-account form', () => {
    expect(foreignAccount('Bank transfer to M Vintersen, sort code 20-45-77, account 00000125.', true)?.value.value).toBe('20-45-77-00000125')
    expect(foreignAccount('BSB 083-417 Account 000 000 126', true)?.value.value).toBe('083-417-000000126')
    expect(foreignAccount('Account: 4800000113', true)?.value.value).toBe('4800000113')
    // Outside a bank-payment context a bare account number is someone else's (a customer account).
    expect(foreignAccount('Account: 4800000113', false)).toBeNull()
  })

  it('reads national phone formats only where a phone is announced', () => {
    expect(loosePhone('0113 496 0582')?.value).toBe('0113 496 0582')
    expect(loosePhone('(03) 5550 0182')?.value).toBe('(03) 5550 0182')
    expect(loosePhone('+86 574 0000 0112')?.value).toBe('+86 574 0000 0112')
    expect(loosePhone('12 34')).toBeNull()
  })

  it('matches an e-mail domain to a Latin company name', () => {
    expect(domainOf('accounts@lumenspire.example', 'Lumenspire Analytics Ltd.')).toBe(true)
    expect(domainOf('help@tradeshelf.example', 'Oakbridge Cycle Parts Ltd')).toBe(false)
  })
})
