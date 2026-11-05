import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { idClassOf, labelParty, lineMarker } from './roles'
import { invoice, issueCodes, statuses, wrongVerified } from './testing'

/**
 * A checksum proves an id was read right, never whose it is. These are the shapes of the
 * hand-written invoices where the interpreter's role guess was wrong and the checksum alone would
 * have verified it.
 */

const SUP = '510000029'
const CUS = '512345679'
const OTHER = '516000007'

describe('role markers', () => {
  it('reads headings and inline markers, Hebrew first', () => {
    expect(lineMarker('לכבוד')).toBe('customer')
    expect(lineMarker("לכב' אינטגרה ייעוץ הנדסי בע\"מ")).toBe('customer')
    expect(lineMarker('לכבוד: קשת אספקה משרדית בע"מ')).toBe('customer')
    expect(lineMarker('לקוח:')).toBe('customer')
    expect(lineMarker('פרטי לקוח / Bill To')).toBe('customer')
    expect(lineMarker('B I L L TO')).toBe('customer')
    expect(lineMarker('C U S TO M E R')).toBe('customer')
    expect(lineMarker('ספק')).toBe('supplier')
    expect(lineMarker('SOLD BY')).toBe('supplier')
  })

  it('does not read running text or service lines as markers', () => {
    expect(lineMarker('מוקד שירות לקוחות: 04-0000102')).toBeNull()
    expect(lineMarker('Customer service: 1-800-555-0100')).toBeNull()
    expect(lineMarker('From 01/08/2026 to 30/09/2026')).toBeNull()
    expect(lineMarker('לקוחות יקרים, שימו לב')).toBeNull()
  })

  it('reads "מאת" as the payer on a receipt', () => {
    expect(lineMarker('מאת: ברוש מאפיות בע"מ')).toBe('supplier')
    expect(lineMarker('מאת: ברוש מאפיות בע"מ', true)).toBe('customer')
    expect(lineMarker('מאת כרמל שיפוצים בע"מ', true)).toBe('customer')
  })

  it('reads the party a label names', () => {
    expect(labelParty('ח.פ. לקוח')).toBe('customer')
    expect(labelParty('ח.פ.')).toBeNull()
  })

  it('tells a company register number from a tax number', () => {
    expect(idClassOf('Company No.')).toBe('register')
    expect(idClassOf('HRB')).toBe('register')
    expect(idClassOf('KvK')).toBe('register')
    expect(idClassOf('VAT number')).toBe('tax')
    expect(idClassOf('ח.פ.')).toBe('tax')
  })
})

describe('party ids: a checksum proves validity, not ownership', () => {
  it("does not verify the customer's ח.פ under \"לכב'\" offered as the supplier's (letterhead guess)", () => {
    const b = invoice()
      .docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
      .textLine("לכב'", { block: 'cus' })
      .text('supplier.name', 'אינטגרה ייעוץ הנדסי בע"מ', { label: null, block: 'cus', signals: ['role:supplier'], method: 'party:letterhead:name-line', score: 0.84 })
      .id('supplier.tax_id', CUS, { label: 'ח.פ.', block: 'cus', method: 'party:letterhead:label', score: 0.86 })
      .textLine(`השם המסחרי בבעלות נ.ע. משקאות ושיווק בע"מ, ח.פ. ${SUP}, רח' הקלייה 4, לוד`)
    const out = resolve(b.build())
    expect(out.fields['supplier.tax_id']!.status).toBe('needs_review')
    expect(out.fields['supplier.name']!.status).not.toBe('verified')
    expect(issueCodes(out)).toContain('role.other_party_marker')
    expect(wrongVerified(out, { 'supplier.tax_id': SUP, 'supplier.name': 'נ.ע. משקאות ושיווק בע"מ' })).toEqual([])
  })

  it('does not verify an unmarked letterhead id when another ח.פ is printed in the fine print', () => {
    const b = invoice()
      .id('supplier.tax_id', CUS, { label: 'ח.פ.', block: 'top', method: 'party:letterhead:label', signals: ['role:supplier'] })
      .textLine(`המותג בבעלות אלפא בע"מ, ח.פ. ${SUP}`)
    const out = resolve(b.build())
    expect(out.fields['supplier.tax_id']!.status).toBe('proposed')
    expect(issueCodes(out)).toContain('role.unmarked_id')
  })

  it("verifies the letterhead id when the only other id is under the customer's marker", () => {
    const b = invoice()
      .id('supplier.tax_id', SUP, { label: 'ח.פ.', block: 'sup', method: 'party:letterhead:label', signals: ['role:supplier'] })
      .textLine('לכבוד', { block: 'cus' })
      .id('customer.tax_id', CUS, { label: 'ח.פ.', block: 'cus', method: 'party:marker:label' })
    expect(statuses(resolve(b.build()))).toMatchObject({ 'supplier.tax_id': 'verified', 'customer.tax_id': 'verified' })
  })

  it('needs an explicit marker for both ids when neither block is marked', () => {
    const b = invoice()
      .id('supplier.tax_id', SUP, { label: 'ח.פ.', block: 'sup', method: 'party:letterhead:label' })
      .id('customer.tax_id', CUS, { label: 'ח.פ.', block: 'cus', method: 'party:unmarked:label' })
    expect(statuses(resolve(b.build()))).toMatchObject({ 'supplier.tax_id': 'proposed', 'customer.tax_id': 'proposed' })
  })

  it('reads the addressee line ("לידי:") as the customer block', () => {
    const b = invoice()
      .id('supplier.tax_id', SUP, { label: 'ח.פ.', block: 'sup', method: 'party:letterhead:label' })
      .id('customer.tax_id', CUS, { label: 'ח.פ.', block: 'cus', method: 'party:unmarked:label' })
      .textLine('לידי: רונית גבאי', { block: 'cus' })
    expect(statuses(resolve(b.build()))).toMatchObject({ 'supplier.tax_id': 'verified', 'customer.tax_id': 'verified' })
  })

  it('does not verify either of two ids printed under the same supplier marker', () => {
    const b = invoice()
      .textLine('ספק', { block: 'sup' })
      .id('supplier.tax_id', SUP, { label: 'ח.פ.', block: 'sup' })
      .textLine(`ע.מ. ${OTHER}`, { block: 'sup' })
    const out = resolve(b.build())
    expect(out.fields['supplier.tax_id']!.status).toBe('needs_review')
    expect(issueCodes(out)).toContain('role.competing_id')
  })

  it('lets a VAT number win over a company register number of the same card', () => {
    const b = invoice()
      .textLine('SOLD BY', { block: 'sup' })
      .id('supplier.tax_id', 'GB381726537', { label: 'VAT number:', block: 'sup', scheme: 'GB_VAT', checksum: true })
      .id('supplier.tax_id', '11593024', { label: 'Company No.', block: 'sup', score: 0.66 })
    expect(resolve(b.build()).fields['supplier.tax_id']).toMatchObject({ status: 'verified', rawValue: 'GB381726537' })
  })
})

describe('party names', () => {
  it('never verifies one of two legal names of the same party printed in two scripts', () => {
    const b = invoice()
      .text('supplier.name', 'נטף-אור מערכות השקיה בע"מ', { label: null, block: 'sup', signals: ['role:supplier'], score: 0.84 })
      .id('supplier.tax_id', SUP, { label: 'ח.פ.', block: 'sup' })
      .textLine('Netaf-Or Irrigation Systems Ltd.', { block: 'sup' })
    const out = resolve(b.build())
    expect(out.fields['supplier.tax_id']!.status).toBe('verified')
    expect(out.fields['supplier.name']!.status).toBe('proposed')
    expect(issueCodes(out)).toContain('name.bilingual')
  })

  it('accepts a name that is a whole "·"-separated piece of its line', () => {
    const b = invoice()
      .text('supplier.name', 'קווים-נט תקשורת בע"מ', { label: null, block: 'sup', signals: ['role:supplier'], score: 0.84, trailing: `· ח.פ. ${SUP}` })
      .id('supplier.tax_id', SUP, { label: 'ח.פ.', block: 'sup' })
    expect(resolve(b.build()).fields['supplier.name']!.status).toBe('verified')
  })
})
