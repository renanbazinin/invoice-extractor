import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { ibanChecksum, israeliIdChecksum, checkIdentifier } from './checksum'
import { hasLegalSuffix } from './parties'
import { check, invoice, issueCodes, statuses, values, wrongVerified } from './testing'

describe('checksums', () => {
  it('accepts valid Israeli ח.פ / ע.מ / ת.ז numbers', () => {
    for (const id of ['510000029', '512345679', '559876545', '580123453', '516000007', '030000020']) expect(israeliIdChecksum(id)).toBe(true)
    expect(israeliIdChecksum('51-000002-9')).toBe(true)
    expect(israeliIdChecksum('30112346')).toBe(true) // ת.ז without its leading zero
  })

  it('rejects every single-digit change and malformed values', () => {
    const good = '510000029'
    for (let i = 0; i < 9; i++) {
      for (let d = 0; d < 10; d++) {
        const bad = good.slice(0, i) + d + good.slice(i + 1)
        if (bad !== good) expect(israeliIdChecksum(bad)).toBe(false)
      }
    }
    expect(israeliIdChecksum('000000000')).toBe(false)
    expect(israeliIdChecksum('12345')).toBeNull()
    expect(israeliIdChecksum('DE123456789')).toBeNull()
  })

  it('checks IBANs with mod 97 and the country length', () => {
    expect(ibanChecksum('IL34 0128 0000 0000 0123 456')).toBe(true)
    expect(ibanChecksum('DE89370400440532013000')).toBe(true)
    expect(ibanChecksum('IL35 0128 0000 0000 0123 456')).toBe(false)
    expect(ibanChecksum('IL3401280000000001234')).toBe(false)
    expect(ibanChecksum('12-345-678901')).toBeNull()
  })

  it('applies the Israeli scheme to a bare 9-digit number only in an Israeli context', () => {
    expect(checkIdentifier('510000020', { scheme: null, checksum: null }, true)).toMatchObject({ scheme: 'il-id', valid: false })
    expect(checkIdentifier('123456789', { scheme: null, checksum: null }, false)).toMatchObject({ scheme: null, valid: null })
    expect(checkIdentifier('123456789', { scheme: 'il-company', checksum: true }, false)).toMatchObject({ scheme: 'il-id', valid: false })
  })
})

describe('identifiers', () => {
  it('verifies a single invoice number under a strong label', () => {
    const out = resolve(invoice().id('invoice_number', '10234', { label: 'חשבונית מס מס\'', score: 0.85 }).build())
    expect(out.fields.invoice_number).toMatchObject({ status: 'verified', checks: ['unique-label:invoice_number'] })
  })

  it('marks conflicting invoice numbers needs_review with the alternative', () => {
    const b = invoice().id('invoice_number', '10234', { label: 'מספר חשבונית:', score: 0.8 }).id('invoice_number', '4500123', { label: 'מספר:', score: 0.75 })
    const out = resolve(b.build())
    expect(out.fields.invoice_number!.status).toBe('needs_review')
    expect(out.fields.invoice_number!.alternatives.map((a) => a.rawValue)).toEqual(['4500123'])
    expect(issueCodes(out)).toContain('conflict.candidates')
  })

  it('does not verify an invoice number when a weaker reading still competes', () => {
    const b = invoice().id('invoice_number', '10234', { score: 0.85 }).id('invoice_number', '10284', { label: null, method: 'pattern:free-text', score: 0.3 })
    const out = resolve(b.build())
    expect(out.fields.invoice_number!.status).toBe('proposed')
  })

  it('treats the same invoice number printed twice as corroboration', () => {
    const b = invoice().id('invoice_number', '10234', { score: 0.85 }).id('invoice_number', '10234', { label: 'Invoice No.', score: 0.7 })
    expect(resolve(b.build()).fields.invoice_number!.status).toBe('verified')
  })

  it('does not verify an OCR-read invoice number with middling confidence', () => {
    const out = resolve(invoice().id('invoice_number', '10234', { conf: 0.8, score: 0.9 }).build())
    expect(out.fields.invoice_number!.status).toBe('proposed')
  })

  it('does not verify a malformed invoice number (a date)', () => {
    const out = resolve(invoice().id('invoice_number', '25/04/2026', { raw: '25/04/2026', score: 0.9 }).build())
    expect(out.fields.invoice_number!.status).toBe('needs_review')
  })

  it('prefers a checksum-valid ח.פ over a stronger invalid reading and verifies it', () => {
    const b = invoice()
      .id('supplier.tax_id', '510000020', { label: 'ח.פ.', score: 0.85, conf: 0.7 })
      .id('supplier.tax_id', '510000029', { label: 'עוסק מורשה', score: 0.7 })
    const out = resolve(b.build())
    expect(values(out)['supplier.tax_id']).toBe('510000029')
    expect(out.fields['supplier.tax_id']).toMatchObject({ status: 'verified', checks: ['checksum:supplier.tax_id'] })
    expect(out.fields['supplier.tax_id']!.alternatives[0]!.rawValue).toBe('510000020')
  })

  it('marks a lone checksum-invalid ח.פ needs_review with a warning', () => {
    const out = resolve(invoice().id('supplier.tax_id', '510000020', { label: 'ח.פ.', score: 0.9 }).build())
    expect(out.fields['supplier.tax_id']!.status).toBe('needs_review')
    expect(check(out, 'checksum:supplier.tax_id')?.status).toBe('fail')
    expect(issueCodes(out)).toContain('id.checksum_failed')
  })

  it('does not verify a valid ח.פ that is also read as the customer\'s', () => {
    const b = invoice().id('supplier.tax_id', '510000029', { label: 'ח.פ.', score: 0.8 }).id('customer.tax_id', '510000029', { label: 'ח.פ. לקוח', score: 0.6 })
    const out = resolve(b.build())
    expect(out.fields['supplier.tax_id']!.status).toBe('needs_review')
    expect(issueCodes(out)).toContain('role.conflict')
  })

  it('verifies two different checksum-valid ids for supplier and customer', () => {
    const b = invoice().id('supplier.tax_id', '510000029', { label: 'ח.פ.' }).id('customer.tax_id', '512345679', { label: 'ח.פ. לקוח' })
    expect(statuses(resolve(b.build()))).toMatchObject({ 'supplier.tax_id': 'verified', 'customer.tax_id': 'verified' })
  })

  it('lets a document title that contains the number ("חשבונית מס 10234") share its words with invoice_number', () => {
    const b = invoice().id('invoice_number', '10234', { id: 'num', score: 0.85 }).docType('tax_invoice', { shareWith: 'num', score: 0.9 })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ invoice_number: 'verified', document_type: 'verified' })
    expect(issueCodes(out)).not.toContain('role.conflict')
  })

  it('verifies a מספר הקצאה (allocation number) under its label', () => {
    const out = resolve(invoice().id('allocation_number', '123456789', { label: 'מספר הקצאה:', score: 0.85 }).build())
    expect(out.fields.allocation_number!.status).toBe('verified')
  })

  it('verifies a valid IBAN and flags an invalid one', () => {
    const ok = resolve(invoice().id('supplier.bank_account', 'IL340128000000000123456', { label: 'IBAN:' }).build())
    expect(ok.fields['supplier.bank_account']).toMatchObject({ status: 'verified', checks: ['checksum:supplier.bank_account'] })
    const bad = resolve(invoice().id('supplier.bank_account', 'IL350128000000000123456', { label: 'IBAN:' }).build())
    expect(bad.fields['supplier.bank_account']!.status).toBe('needs_review')
  })

  it('verifies an Israeli bank-branch-account under a strong label (no checksum known)', () => {
    const out = resolve(invoice().id('supplier.bank_account', '12-345-123456', { label: 'בנק הפועלים סניף חשבון', score: 0.8 }).build())
    expect(out.fields['supplier.bank_account']!.status).toBe('verified')
    expect(out.fields['supplier.bank_account']!.checks).toEqual(['unique-label:supplier.bank_account'])
  })

  it('does not verify an OCR-read party id by letterhead position alone', () => {
    // A scan may have lost the "לכבוד" above it (or garbled the real supplier id).
    const out = resolve(invoice().id('supplier.tax_id', '510000029', { label: 'ח.פ.', conf: 0.85 }).build())
    expect(out.fields['supplier.tax_id']!.status).not.toBe('verified')
    expect(issueCodes(out)).toContain('role.ocr_unmarked_id')
  })

  it('verifies an OCR-read party id under a marker of its own party that survived OCR', () => {
    const out = resolve(
      invoice()
        .textLine('לכבוד', { block: 'cust', conf: 0.9 })
        .id('customer.tax_id', '510000029', { label: 'ח.פ.', conf: 0.95, block: 'cust' })
        .build(),
    )
    expect(out.fields['customer.tax_id']!.status).toBe('verified')
  })

  it("drops the payer's account debited by a standing order", () => {
    // "החיוב יבוצע מחשבון הלקוח: בנק 10 · סניף 905 · חשבון 0071533": the customer's account.
    const out = resolve(invoice().id('supplier.bank_account', '10-905-0000118', { label: 'החיוב יבוצע מחשבון הלקוח: בנק סניף חשבון', score: 0.78 }).build())
    expect(out.fields['supplier.bank_account']).toBeUndefined()
    expect(issueCodes(out)).toContain('bank.payer_account')
  })

  it("keeps the supplier's own account when the payer's is printed too", () => {
    const out = resolve(
      invoice()
        .id('supplier.bank_account', '12-600-000119', { label: 'חיוב מחשבון הלקוח: בנק סניף ח-ן', score: 0.8 })
        .id('supplier.bank_account', '20-262-00116', { label: 'לתשלום בהעברה לחשבון: בנק סניף ח-ן', score: 0.7 })
        .build(),
    )
    expect(out.fields['supplier.bank_account']!.normalized).toMatchObject({ value: '2026200116' })
    expect(issueCodes(out)).toContain('bank.payer_account')
  })
})

describe('party names and other text', () => {
  /** The supplier block: name line, then ח.פ line, in one visual block. */
  const supplierBlock = (name: string, taxId = '510000029', nameOpts = {}) =>
    invoice()
      .docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
      .text('supplier.name', name, { label: null, signals: ['role:supplier'], block: 'sup', score: 0.8, ...nameOpts })
      .id('supplier.tax_id', taxId, { label: 'ח.פ.', block: 'sup' })

  it('recognises legal-entity suffixes', () => {
    expect(hasLegalSuffix('אלקטרו-טק בע"מ')).toBe(true)
    expect(hasLegalSuffix('אלקטרו-טק בע״מ')).toBe(true)
    expect(hasLegalSuffix('Acme Ltd.')).toBe(true)
    expect(hasLegalSuffix('Müller GmbH')).toBe(true)
    expect(hasLegalSuffix('עמותת ידידים (ע"ר)')).toBe(true)
    expect(hasLegalSuffix('Sagi Cohen')).toBe(false)
    expect(hasLegalSuffix('Saga Studio')).toBe(false)
  })

  it('verifies a supplier name with the full chain of role evidence', () => {
    const out = resolve(supplierBlock('אלקטרו-טק מערכות בע"מ').build())
    expect(out.fields['supplier.name']).toMatchObject({ status: 'verified', checks: ['role:supplier.name'] })
  })

  it('keeps the name proposed when the ח.פ in its block fails the checksum', () => {
    const out = resolve(supplierBlock('אלקטרו-טק מערכות בע"מ', '510000020').build())
    expect(out.fields['supplier.name']!.status).toBe('proposed')
  })

  it('keeps a name without a legal suffix (maybe the trading name) proposed', () => {
    expect(resolve(supplierBlock('אלקטרו-טק').build()).fields['supplier.name']!.status).toBe('proposed')
  })

  it('keeps a name that is only part of its printed line proposed', () => {
    const out = resolve(supplierBlock('מערכות בע"מ', '510000029', { trailing: 'סניף תל אביב' }).build())
    expect(out.fields['supplier.name']!.status).toBe('proposed')
  })

  it('keeps a name outside the tax-id block proposed', () => {
    const b = invoice()
      .text('supplier.name', 'אלקטרו-טק בע"מ', { label: null, signals: ['role:supplier'], block: 'a', score: 0.8 })
      .id('supplier.tax_id', '510000029', { label: 'ח.פ.', block: 'b' })
    expect(resolve(b.build()).fields['supplier.name']!.status).toBe('proposed')
  })

  it('marks two competing supplier names needs_review', () => {
    const b = supplierBlock('אלקטרו-טק בע"מ').text('supplier.name', 'שופרסל בע"מ', { label: 'לכבוד', score: 0.7 })
    expect(resolve(b.build()).fields['supplier.name']!.status).toBe('needs_review')
  })

  it('flags supplier and customer with the same name', () => {
    const b = supplierBlock('אלקטרו-טק בע"מ').text('customer.name', 'אלקטרו-טק בע"מ', { label: 'לכבוד:', score: 0.6 })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ 'supplier.name': 'needs_review', 'customer.name': 'needs_review' })
    expect(issueCodes(out)).toContain('role.conflict')
  })

  it('never verifies an address', () => {
    const out = resolve(invoice().text('supplier.address', 'רחוב הברזל 30, תל אביב 6971005', { label: 'כתובת:', score: 0.95 }).build())
    expect(out.fields['supplier.address']!.status).toBe('proposed')
  })

  it('verifies payment terms "שוטף + 30" under its label, not free text', () => {
    expect(resolve(invoice().text('payment_terms', 'שוטף + 30', { label: 'תנאי תשלום:', score: 0.85 }).build()).fields.payment_terms!.status).toBe('verified')
    expect(resolve(invoice().text('payment_terms', 'לפי הסכם', { label: 'תנאי תשלום:', score: 0.85 }).build()).fields.payment_terms!.status).toBe('proposed')
  })

  it('verifies a supplier phone in the verified tax-id block, and not a bare one', () => {
    const inBlock = supplierBlock('אלקטרו-טק בע"מ').id('supplier.phone', '03-5551234', { raw: '03-5551234', label: 'טל\':', block: 'sup', signals: ['label:exact'] })
    expect(resolve(inBlock.build()).fields['supplier.phone']!.status).toBe('verified')
    const bare = invoice().id('supplier.phone', '03-5551234', { raw: '03-5551234', label: 'טל\':' })
    expect(resolve(bare.build()).fields['supplier.phone']!.status).toBe('proposed')
  })

  it('verifies the document type from a single strong title and not with two titles', () => {
    expect(resolve(invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 }).build()).fields.document_type!.status).toBe('verified')
    const two = invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.8 }).docType('tax_invoice_receipt', { raw: 'חשבונית מס/קבלה', score: 0.75 })
    expect(resolve(two.build()).fields.document_type!.status).toBe('needs_review')
  })

  it('verifies the currency only when the amounts print the same currency', () => {
    const b = invoice().currency('ILS', { label: 'מטבע:' }).money('total', '1180.00', { currency: 'ILS', raw: '₪1,180.00' })
    const out = resolve(b.build())
    expect(out.fields.currency).toMatchObject({ status: 'verified', checks: ['currency:amounts'] })
    const alone = resolve(invoice().currency('ILS', { label: 'מטבע:' }).money('total', '1180.00').build())
    expect(alone.fields.currency!.status).toBe('proposed')
    expect(wrongVerified(out, { currency: 'ILS' })).toEqual([])
  })

  it('derives the currency from the ₪ sign when no currency label is printed', () => {
    const out = resolve(invoice().money('total', '1180.00', { currency: 'ILS', raw: '1,180.00 ₪' }).build())
    expect(out.fields.currency).toBeUndefined()
    expect(out.derived.find((d) => d.field === 'currency')?.normalized).toEqual({ kind: 'currency', code: 'ILS' })
  })
})
