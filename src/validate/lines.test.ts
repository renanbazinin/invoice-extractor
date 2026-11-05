import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { check, invoice, issueCodes, statuses, type InvoiceBuilder } from './testing'

function header(): InvoiceBuilder {
  return invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
}

describe('line items', () => {
  it('verifies three rows by quantity × unit price and closes them with the subtotal', () => {
    const b = header()
      .line({ description: 'מחשב נייד Dell', quantity: '2', unitPrice: '150.00', amount: '300.00' })
      .line({ description: 'מסך 27"', quantity: '1', unitPrice: '500.00', amount: '500.00' })
      .line({ description: 'כבל HDMI', quantity: '4', unitPrice: '50.00', amount: '200.00' })
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00')
    const out = resolve(b.build())
    expect(out.lineItems.map((l) => l.status)).toEqual(['verified', 'verified', 'verified'])
    expect(out.lineItems[0]!.amount!.checks).toEqual(['line:0:qty*unit=amount', 'sum:lines=subtotal'])
    expect(out.lineItems[0]!.description!.status).toBe('proposed')
    expect(check(out, 'sum:lines=subtotal')).toMatchObject({ status: 'pass', expected: '1000.00', actual: '1000.00' })
    expect(check(out, 'line:2:qty*unit=amount')).toMatchObject({ status: 'pass', expected: '200.00' })
    expect(out.fields.subtotal!.checks).toEqual(expect.arrayContaining(['sum:lines=subtotal', 'sum:subtotal+tax=total']))
  })

  it('accepts a one-cent unit-price rounding (3 × 33.33 = 100.00) as exact', () => {
    const out = resolve(header().line({ description: 'שעת ייעוץ', quantity: '3', unitPrice: '33.33', amount: '100.00' }).build())
    expect(out.lineItems[0]!.status).toBe('verified')
    expect(check(out, 'line:0:qty*unit=amount')).toMatchObject({ status: 'pass', expected: '99.99', actual: '100.00' })
  })

  it('tolerates a larger unit-price rounding (7 × 14.29 = 100.00) without verifying the row', () => {
    const out = resolve(header().line({ description: 'מנוי חודשי', quantity: '7', unitPrice: '14.29', amount: '100.00' }).build())
    expect(out.lineItems[0]!.status).toBe('proposed')
    expect(check(out, 'line:0:qty*unit=amount')!.status).toBe('pass')
    expect(check(out, 'line:0:qty*unit=amount')!.message).toContain('not used to verify')
  })

  it('flags a row whose amount does not match quantity × price', () => {
    const out = resolve(header().line({ description: 'נייר A4', quantity: '2', unitPrice: '150.00', amount: '310.00' }).build())
    expect(out.lineItems[0]!.status).toBe('needs_review')
    expect(out.lineItems[0]!.amount!.status).toBe('needs_review')
    expect(check(out, 'line:0:qty*unit=amount')?.status).toBe('fail')
    expect(issueCodes(out)).toContain('line.arithmetic_failed')
  })

  it('applies a printed line discount percent (2 × 100 − 10% = 180)', () => {
    const out = resolve(header().line({ description: 'כיסא משרדי', quantity: '2', unitPrice: '100.00', discountPercent: '10', amount: '180.00' }).build())
    expect(out.lineItems[0]!.status).toBe('verified')
    expect(out.lineItems[0]!.discount!.status).toBe('verified')
  })

  it('closes lines that include a discount row against subtotal − discount', () => {
    const b = header()
      .line({ description: 'שולחן', quantity: '1', unitPrice: '600.00', amount: '600.00' })
      .line({ description: 'ארון', quantity: '1', unitPrice: '400.00', amount: '400.00' })
      .line({ description: 'הנחת לקוח', amount: '-100.00' })
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .money('discount', '100.00')
      .rate('18')
      .money('tax_amount', '162.00')
      .money('total', '1062.00')
    const out = resolve(b.build())
    expect(check(out, 'sum:lines=subtotal-discount')?.status).toBe('pass')
    expect(out.lineItems[2]!.status).toBe('verified')
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', discount: 'verified', total: 'verified' })
  })

  it('verifies total and tax through the lines when no subtotal is printed, and derives it', () => {
    const b = header()
      .line({ description: 'פיתוח תוכנה', quantity: '10', unitPrice: '80.00', amount: '800.00' })
      .line({ description: 'אחסון', quantity: '1', unitPrice: '200.00', amount: '200.00' })
      .money('tax_amount', '180.00')
      .money('total', '1180.00')
    const out = resolve(b.build())
    expect(check(out, 'sum:lines=total-tax')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ tax_amount: 'verified', total: 'verified' })
    expect(out.derived.find((d) => d.field === 'subtotal')?.normalized).toMatchObject({ amount: '1000.00' })
  })

  it('keeps the subtotal verified when a row is missing, but warns and doubts rows without their own check', () => {
    const b = header()
      .line({ description: 'שירות', quantity: '2', unitPrice: '300.00', amount: '600.00' })
      .line({ description: 'דמי משלוח', amount: '200.00' })
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00')
    const out = resolve(b.build())
    expect(check(out, 'sum:lines=subtotal')?.status).toBe('fail')
    expect(issueCodes(out)).toContain('lines.sum_mismatch')
    expect(out.fields.subtotal!.status).toBe('verified')
    expect(out.lineItems.map((l) => l.status)).toEqual(['verified', 'needs_review'])
  })

  it('verifies amount-only rows through the closure', () => {
    const b = header()
      .line({ description: 'ייעוץ משפטי - אפריל', amount: '700.00' })
      .line({ description: 'ייעוץ משפטי - מאי', amount: '300.00' })
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00')
    const out = resolve(b.build())
    expect(out.lineItems.map((l) => l.status)).toEqual(['verified', 'verified'])
    expect(out.lineItems[0]!.amount!.checks).toEqual(['sum:lines=subtotal'])
  })

  it('does not let tax-inclusive line prices verify a "total" on a tax-exclusive invoice', () => {
    // סה"כ 1,000 was mapped to total; the VAT line and the real total (1,180) were missed. Lines sum to 1,000.
    const b = header()
      .line({ description: 'מוצר א', quantity: '1', unitPrice: '600.00', amount: '600.00' })
      .line({ description: 'מוצר ב', quantity: '1', unitPrice: '400.00', amount: '400.00' })
      .money('total', '1000.00', { label: 'סה"כ', score: 0.6 })
      .textLine('מע"מ 18% 180.00')
      .textLine('סה"כ לתשלום 1,180.00')
    const out = resolve(b.build())
    expect(check(out, 'sum:lines=total')?.status).toBe('pass')
    expect(out.fields.total!.status).toBe('proposed')
  })

  it('lets the lines prove the total when the page prints no tax at all (עוסק פטור)', () => {
    const b = invoice()
      .docType('receipt', { raw: 'קבלה', score: 0.9 })
      .textLine('עוסק פטור - אינו גובה מע"מ')
      .line({ description: 'שיעור פרטי', quantity: '2', unitPrice: '150.00', amount: '300.00' })
      .line({ description: 'חוברת', quantity: '1', unitPrice: '45.00', amount: '45.00' })
      .money('total', '345.00', { label: 'סה"כ לתשלום' })
    const out = resolve(b.build())
    expect(check(out, 'sum:lines=total')?.status).toBe('pass')
    expect(out.fields.total!.status).toBe('verified')
    expect(out.fields.subtotal).toBeUndefined()
  })

  it('does not treat an OCR page without a tax line as tax-free', () => {
    const b = invoice()
      .docType('receipt', { raw: 'קבלה', score: 0.9 })
      .line({ description: 'שיעור פרטי', quantity: '2', unitPrice: '150.00', amount: '300.00' }, { conf: 0.93 })
      .money('total', '300.00', { label: 'סה"כ', conf: 0.93 })
    const out = resolve(b.build())
    expect(out.fields.total!.status).not.toBe('verified')
  })

  it('lets lines prove the total on a receipt that prints the VAT as included', () => {
    const b = invoice()
      .docType('tax_invoice_receipt', { raw: 'חשבונית מס/קבלה', score: 0.9 })
      .line({ description: 'קפה', quantity: '2', unitPrice: '14.75', amount: '29.50' })
      .line({ description: 'מאפה', quantity: '1', unitPrice: '29.50', amount: '29.50' })
      .money('total', '59.00', { label: 'סה"כ לתשלום' })
      .money('tax_amount', '9.00', { label: 'מתוכו מע"מ' })
    const out = resolve(b.build())
    expect(check(out, 'sum:lines=total')?.status).toBe('pass')
    expect(out.fields.total!.status).toBe('verified')
  })

  it('does not treat a cell read twice (unit price = amount, same words) as a check', () => {
    const out = resolve(header().line({ description: 'פריט', quantity: '1', unitPrice: '250.00', amountSharesUnitPrice: true }).build())
    expect(out.lineItems[0]!.status).not.toBe('verified')
  })
})
