import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { check, invoice, issueCodes, statuses, values, wrongVerified, type InvoiceBuilder } from './testing'

/** An Israeli tax invoice header every money scenario shares. */
function header(b: InvoiceBuilder = invoice()): InvoiceBuilder {
  return b.docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
}

/** סה"כ 1,000.00 / מע"מ 18% 180.00 / סה"כ לתשלום 1,180.00 */
function simple(b: InvoiceBuilder = header()): InvoiceBuilder {
  return b
    .money('subtotal', '1000.00', { raw: '1,000.00', label: 'סה"כ לפני מע"מ', score: 0.85 })
    .rate('18', { label: 'מע"מ 18%', score: 0.8 })
    .money('tax_amount', '180.00', { label: 'מע"מ 18%', score: 0.85 })
    .money('total', '1180.00', { id: 'tot', raw: '1,180.00', label: 'סה"כ לתשלום', score: 0.8 })
    .money('amount_due', '1180.00', { shareWith: 'tot', score: 0.7 })
}

const SIMPLE_TRUTH = { subtotal: '1000', tax_rate: '18', tax_amount: '180', total: '1180', amount_due: '1180', discount: null, amount_paid: null, rounding: null }

describe('money: Israeli tax invoices', () => {
  it('verifies subtotal, VAT 18%, tax and total when they close', () => {
    const out = resolve(simple().build())
    expect(values(out)).toMatchObject({ subtotal: '1000.00', tax_rate: '18', tax_amount: '180.00', total: '1180.00', amount_due: '1180.00' })
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', tax_rate: 'verified', tax_amount: 'verified', total: 'verified' })
    expect(check(out, 'sum:subtotal+tax=total')).toMatchObject({ status: 'pass', expected: '1180.00', actual: '1180.00' })
    expect(check(out, 'tax:tax=rate*subtotal')).toMatchObject({ status: 'pass', expected: '180.00', actual: '180.00' })
    expect(out.fields.total!.checks).toContain('sum:subtotal+tax=total')
    expect(out.fields.total!.confidence).toBeGreaterThanOrEqual(0.95)
    expect(wrongVerified(out, SIMPLE_TRUTH)).toEqual([])
  })

  it('verifies "סה"כ לתשלום" as amount_due when it is the same printed figure as a verified total', () => {
    const out = resolve(simple().build())
    expect(out.fields.amount_due!.status).toBe('verified')
    expect(out.fields.amount_due!.evidence).toEqual(out.fields.total!.evidence)
    expect(check(out, 'identity:total=amount_due')?.status).toBe('pass')
  })

  it('does not verify the shared amount_due when the page mentions an advance payment', () => {
    const out = resolve(simple(header().textLine('שולמה מקדמה בהעברה')).build())
    expect(out.fields.total!.status).toBe('verified')
    expect(out.fields.amount_due!.status).toBe('proposed')
  })

  it('ignores a "סה"כ לעמוד" page-subtotal decoy and keeps the closing subtotal verified', () => {
    const b = simple().money('subtotal', '450.00', { label: 'סה"כ לעמוד', score: 0.55 })
    const out = resolve(b.build())
    expect(values(out).subtotal).toBe('1000.00')
    expect(out.fields.subtotal!.status).toBe('verified')
    expect(out.fields.subtotal!.alternatives.map((a) => a.rawValue)).toEqual(['450.00'])
    expect(wrongVerified(out, SIMPLE_TRUTH)).toEqual([])
  })

  it('sends a total to review when arithmetic overrules a much stronger plain "סה"כ" reading', () => {
    const b = header()
      .money('subtotal', '1000.00', { score: 0.8 })
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '590.00', { label: 'סה"כ', score: 0.92 })
      .money('total', '1180.00', { label: 'סה"כ כולל מע"מ', score: 0.7 })
    const out = resolve(b.build())
    expect(values(out).total).toBe('1180.00')
    expect(out.fields.total!.status).toBe('needs_review')
    expect(wrongVerified(out, SIMPLE_TRUTH)).toEqual([])
  })

  it('lets arithmetic beat a stronger "סה"כ לעמוד" total decoy', () => {
    const b = header()
      .money('subtotal', '1000.00', { score: 0.8 })
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '590.00', { label: 'סה"כ לעמוד', score: 0.92 })
      .money('total', '1180.00', { label: 'סה"כ כולל מע"מ', score: 0.7 })
    const out = resolve(b.build())
    expect(values(out).total).toBe('1180.00')
    expect(out.fields.total!.status).toBe('verified')
    expect(out.fields.total!.alternatives[0]!.rawValue).toBe('590.00')
    expect(wrongVerified(out, SIMPLE_TRUTH)).toEqual([])
  })

  it('closes an advance payment: total 1180 − מקדמה 500 = יתרה לתשלום 680', () => {
    const b = header()
      .money('subtotal', '1000.00')
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00', { label: 'סה"כ' })
      .money('amount_paid', '500.00', { label: 'מקדמה ששולמה' })
      .money('amount_due', '680.00', { label: 'יתרה לתשלום' })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ total: 'verified', amount_paid: 'verified', amount_due: 'verified' })
    expect(check(out, 'sum:total-paid=due')).toMatchObject({ status: 'pass', expected: '680.00', actual: '680.00' })
    expect(wrongVerified(out, { total: '1180', amount_paid: '500', amount_due: '680' })).toEqual([])
  })

  it('never verifies a "total" that is really the balance after an unseen advance', () => {
    // The interpreter took "סה"כ לתשלום 680" as the total; the real 1,180 total was missed.
    const b = header()
      .money('subtotal', '1000.00')
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '680.00', { label: 'סה"כ לתשלום', score: 0.7 })
      .money('amount_due', '680.00', { label: 'יתרה לתשלום', score: 0.8 })
    const out = resolve(b.build())
    expect(out.fields.total?.status).not.toBe('verified')
    expect(wrongVerified(out, { total: '1180', amount_due: '680' })).toEqual([])
    expect(issueCodes(out)).toContain('check.failed')
  })

  it('handles a document discount: 1000 − הנחה 100 + מע"מ 162 = 1062', () => {
    const b = header()
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .money('discount', '-100.00', { label: 'הנחה 10%', raw: '-100.00' })
      .rate('18')
      .money('tax_amount', '162.00')
      .money('total', '1062.00', { label: 'סה"כ לתשלום' })
    const out = resolve(b.build())
    expect(values(out)).toMatchObject({ subtotal: '1000.00', discount: '100.00', tax_amount: '162.00', total: '1062.00' })
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', discount: 'verified', tax_amount: 'verified', total: 'verified', tax_rate: 'verified' })
    expect(check(out, 'sum:subtotal-discount+tax=total')?.status).toBe('pass')
    expect(check(out, 'tax:tax=rate*(subtotal-discount)')?.status).toBe('pass')
  })

  it('does not verify the base after a printed but missed discount as the subtotal', () => {
    // "סה"כ נטו 900 + מע"מ 162 = 1062" closes exactly, but "הנחה מסוכמת 100.00" is printed and no
    // candidate holds it: the true subtotal is 1000 (סה"כ ברוטו, read here only as a total).
    const b = header()
      .money('subtotal', '900.00', { label: 'סה"כ נטו', score: 0.6 })
      .textLine('הנחה מסוכמת 100.00')
      .rate('18')
      .money('tax_amount', '162.00', { label: 'מע"מ 18%' })
      .money('total', '1062.00', { label: 'סה"כ לגבייה' })
    const out = resolve(b.build())
    expect(out.fields.subtotal!.status).toBe('needs_review')
    expect(issueCodes(out)).toContain('check.incomplete')
    // The tax and the total are right whichever figure the subtotal is.
    expect(statuses(out)).toMatchObject({ tax_amount: 'verified', total: 'verified' })
  })

  it('still verifies the subtotal when the missed discount is a row of the item lines', () => {
    const b = header()
      .line({ description: 'שירות חודשי', quantity: '1', unitPrice: '1000.00', amount: '1000.00' })
      .line({ description: 'הנחה', amount: '-100.00' })
      .money('subtotal', '900.00', { label: 'סה"כ' })
      .rate('18')
      .money('tax_amount', '162.00')
      .money('total', '1062.00', { label: 'סה"כ לתשלום' })
    const out = resolve(b.build())
    expect(out.fields.subtotal!.status).toBe('verified')
    expect(issueCodes(out)).not.toContain('check.incomplete')
  })

  it('verifies the subtotal when the printed discount is the chosen discount', () => {
    const b = header()
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .money('discount', '100.00', { label: 'הנחה מסוכמת' })
      .rate('18')
      .money('tax_amount', '162.00')
      .money('total', '1062.00', { label: 'סה"כ לתשלום' })
    const out = resolve(b.build())
    expect(out.fields.subtotal!.status).toBe('verified')
    expect(issueCodes(out)).not.toContain('check.incomplete')
  })

  it('keeps the pre-discount subtotal when "סה"כ אחרי הנחה 900" is also a subtotal candidate', () => {
    const b = header()
      .money('subtotal', '1000.00', { label: 'סה"כ', score: 0.8 })
      .money('subtotal', '900.00', { label: 'סה"כ אחרי הנחה', score: 0.45 })
      .money('discount', '100.00', { label: 'הנחה' })
      .rate('18')
      .money('tax_amount', '162.00')
      .money('total', '1062.00')
    const out = resolve(b.build())
    expect(values(out).subtotal).toBe('1000.00')
    expect(out.fields.subtotal!.status).toBe('verified')
    expect(wrongVerified(out, { subtotal: '1000', discount: '100', tax_amount: '162', total: '1062' })).toEqual([])
  })

  it('verifies a tax-inclusive receipt and derives the net amount without putting it in fields', () => {
    const b = invoice()
      .docType('tax_invoice_receipt', { raw: 'חשבונית מס/קבלה', score: 0.9 })
      .money('total', '1180.00', { label: 'סה"כ כולל מע"מ', currency: 'ILS', raw: '1,180.00 ₪' })
      .money('tax_amount', '180.00', { label: 'מתוכו מע"מ 18%' })
      .rate('18', { label: 'מתוכו מע"מ 18%' })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ total: 'verified', tax_amount: 'verified', tax_rate: 'verified' })
    expect(check(out, 'tax:tax=total*rate/(100+rate)')).toMatchObject({ status: 'pass', expected: '180.00' })
    expect(out.fields.subtotal).toBeUndefined()
    expect(out.derived.find((d) => d.field === 'subtotal')).toMatchObject({ normalized: { kind: 'money', amount: '1000.00', currency: 'ILS' }, formula: 'total - tax_amount' })
  })

  it('zero VAT (אילת / export): verifies "מע"מ 0% 0.00" by label, but not 1000 = 1000 by itself', () => {
    const b = header()
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .rate('0', { label: 'מע"מ 0% (אילת)' })
      .money('tax_amount', '0.00', { label: 'מע"מ' })
      .money('total', '1000.00', { label: 'סה"כ לתשלום' })
    const out = resolve(b.build())
    expect(values(out)).toMatchObject({ subtotal: '1000.00', tax_rate: '0', tax_amount: '0.00', total: '1000.00' })
    // With zero tax "subtotal + 0 = total" is only "the two figures are equal": no role proven.
    expect(statuses(out)).toMatchObject({ tax_amount: 'verified', tax_rate: 'verified', subtotal: 'proposed', total: 'proposed' })
    expect(out.fields.tax_amount!.checks).toContain('label:tax_amount')
    expect(check(out, 'sum:subtotal+tax=total')!.message).toContain('corroboration only')
  })

  it('zero VAT with item rows: the rows confirm the subtotal; the equal total stays proposed', () => {
    const b = header()
      .line({ description: 'שירותי ייעוץ - אילת', quantity: '4', unitPrice: '250.00', amount: '1000.00' })
      .money('subtotal', '1000.00', { label: 'סה"כ' })
      .rate('0', { label: 'מע"מ 0% (אילת)' })
      .money('tax_amount', '0.00', { label: 'מע"מ' })
      .money('total', '1000.00', { label: 'סה"כ לתשלום' })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', total: 'proposed', tax_amount: 'verified', tax_rate: 'verified' })
    expect(out.fields.subtotal!.checks).toContain('sum:lines=subtotal')
    // A total equal to the subtotal is derivable, but the printed "total" could be any figure equal to it.
    expect(wrongVerified(out, { subtotal: '1000', total: '1000', tax_amount: '0', tax_rate: '0' })).toEqual([])
  })

  it('does not let a zero "payment" turn total = due into a confirmation', () => {
    // "סה"כ 0.00" offered as amount_paid; the real advance (מקדמה) is weaker.
    const b = header()
      .money('subtotal', '1000.00')
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00', { label: 'סה"כ' })
      .money('amount_paid', '0.00', { label: 'סה"כ', score: 0.85 })
      .money('amount_paid', '500.00', { label: 'מקדמה', score: 0.5 })
      .money('amount_due', '1180.00', { label: 'סה"כ לתשלום', score: 0.9 })
    const out = resolve(b.build())
    expect(out.fields.amount_due?.status).not.toBe('verified')
    expect(out.fields.amount_paid?.status).not.toBe('verified')
    expect(wrongVerified(out, { amount_due: '680', amount_paid: '500' })).toEqual([])
  })

  it('does not verify paid/due whose labels do not name them (two equal installments)', () => {
    const b = header()
      .money('subtotal', '1000.00')
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00')
      .money('amount_paid', '590.00', { label: 'תשלום 1', score: 0.7 })
      .money('amount_due', '590.00', { label: 'תשלום 2', score: 0.7 })
    const out = resolve(b.build())
    expect(check(out, 'sum:total-paid=due')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ total: 'verified', amount_paid: 'proposed', amount_due: 'proposed' })
  })

  it('never verifies a "סה"כ לעמוד" page total, nor lets it vouch for others', () => {
    // A page's own subtotal / VAT / total close among themselves; the document's total was missed.
    const b = header()
      .money('subtotal', '450.00', { label: 'סה"כ לעמוד', score: 0.8 })
      .rate('18')
      .money('tax_amount', '81.00', { label: 'מע"מ לעמוד', score: 0.8 })
      .money('total', '531.00', { label: 'סה"כ לעמוד כולל מע"מ', score: 0.8 })
    const out = resolve(b.build())
    expect(Object.values(out.fields).filter((f) => f!.field !== 'document_type' && f!.status === 'verified')).toEqual([])
  })

  it('does not verify a self-consistent cluster that overrules much stronger readings', () => {
    // Real: subtotal 17,274.14 (strong) and total 20,383.49; tax line missed. A weak decoy
    // cluster 4,156.05 + 748.09 = 4,904.14 closes better.
    const b = header()
      .money('subtotal', '17274.14', { score: 0.93 })
      .money('total', '20383.49', { score: 0.72 })
      .rate('18', { score: 0.6 })
      .money('subtotal', '4156.05', { label: 'סה"כ', score: 0.31 })
      .money('tax_amount', '748.09', { score: 0.7 })
      .money('total', '4904.14', { label: 'סה"כ', score: 0.62 })
    const out = resolve(b.build())
    expect(wrongVerified(out, { subtotal: '17274.14', total: '20383.49', tax_amount: '3109.35', tax_rate: '18' })).toEqual([])
    expect(out.summary.status).toBe('needs_review')
  })

  it('does not trust an exact closure that skips a printed rounding (a misread cent can absorb it)', () => {
    // True: 3076.59 − 307.66 + 498.41 − 0.02 (עיגול) = 3267.32. The discount was OCR-read as 307.68
    // and the rounding line was not extracted, so the closure is exact by accident.
    const b = header()
      .textLine('עיגול אגורות -0.02')
      .money('subtotal', '3076.59', { score: 0.72 })
      .money('discount', '307.68', { label: 'הנחה', score: 0.89, conf: 0.8 })
      .money('tax_amount', '498.41', { score: 0.6 })
      .money('total', '3267.32', { score: 0.7 })
    const out = resolve(b.build())
    expect(out.fields.discount!.status).not.toBe('verified')
    expect(check(out, 'sum:subtotal-discount+tax=total')!.message).toContain('within one rounding step')
  })

  it('does not verify a VAT-exempt document with only סה"כ and סה"כ לתשלום (nothing to check)', () => {
    const b = header()
      .money('subtotal', '1000.00', { label: 'סה"כ', score: 0.7 })
      .money('total', '1000.00', { label: 'סה"כ לתשלום', score: 0.8 })
    const out = resolve(b.build())
    expect(out.fields.subtotal!.status).toBe('proposed')
    expect(out.fields.total!.status).toBe('proposed')
    expect(out.summary.status).not.toBe('verified')
  })

  it('verifies a legacy 17% invoice and notes a 17% rate on a 2026 invoice date', () => {
    const legacy = (date: string) =>
      header()
        .date('invoice_date', date)
        .money('subtotal', '1000.00')
        .rate('17', { label: 'מע"מ 17%' })
        .money('tax_amount', '170.00', { label: 'מע"מ 17%' })
        .money('total', '1170.00')
    const old = resolve(legacy('15/06/2024').build())
    expect(statuses(old)).toMatchObject({ subtotal: 'verified', tax_rate: 'verified', tax_amount: 'verified', total: 'verified' })
    expect(issueCodes(old)).not.toContain('tax.rate_unusual_for_date')
    const late = resolve(legacy('15/06/2026').build())
    expect(late.fields.tax_rate!.status).toBe('verified')
    expect(issueCodes(late)).toContain('tax.rate_unusual_for_date')
  })

  it('derives the subtotal when it is not printed, and never puts it in fields', () => {
    const b = header().rate('18').money('tax_amount', '180.00').money('total', '1180.00')
    const out = resolve(b.build())
    expect(out.fields.subtotal).toBeUndefined()
    expect(statuses(out)).toMatchObject({ tax_amount: 'verified', total: 'verified', tax_rate: 'verified' })
    expect(out.derived).toContainEqual(expect.objectContaining({ field: 'subtotal', normalized: expect.objectContaining({ amount: '1000.00' }), inputs: ['total', 'tax_amount'] }))
  })

  it('derives the tax amount from subtotal × (1 + rate) = total when no tax line is printed', () => {
    const b = header().money('subtotal', '1000.00').rate('18').money('total', '1180.00')
    const out = resolve(b.build())
    expect(check(out, 'tax:total=subtotal*(1+rate)')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', total: 'verified', tax_rate: 'verified' })
    expect(out.derived.find((d) => d.field === 'tax_amount')?.normalized).toMatchObject({ amount: '180.00' })
  })

  it('derives the VAT rate from verified amounts when it is not printed', () => {
    const b = header().money('subtotal', '1000.00').money('tax_amount', '180.00').money('total', '1180.00')
    const out = resolve(b.build())
    expect(out.fields.tax_rate).toBeUndefined()
    expect(out.derived.find((d) => d.field === 'tax_rate')?.normalized).toEqual({ kind: 'percent', value: '18' })
  })

  it('reports an OCR-misread tax (186 for 180) for review and verifies nothing it touches', () => {
    const b = header()
      .money('subtotal', '1000.00', { conf: 0.95 })
      .rate('18')
      .money('tax_amount', '186.00', { conf: 0.55, score: 0.85 })
      .money('total', '1180.00', { conf: 0.95 })
    const out = resolve(b.build())
    expect(values(out).tax_amount).toBe('186.00')
    expect(statuses(out)).toMatchObject({ tax_amount: 'needs_review', subtotal: 'needs_review', total: 'needs_review' })
    expect(check(out, 'sum:subtotal+tax=total')).toMatchObject({ status: 'fail', expected: '1186.00', actual: '1180.00' })
    expect(issueCodes(out)).toEqual(expect.arrayContaining(['check.failed', 'money.rejected_by_arithmetic']))
    expect(out.issues.some((i) => i.severity === 'error')).toBe(true)
    expect(out.summary.status).toBe('needs_review')
    expect(wrongVerified(out, SIMPLE_TRUTH)).toEqual([])
  })

  it('marks conflicting totals with no arithmetic as needs_review with alternatives', () => {
    const b = header()
      .money('total', '1180.00', { label: 'סה"כ לתשלום', score: 0.8 })
      .money('total', '1062.00', { label: 'סה"כ', score: 0.75 })
    const out = resolve(b.build())
    expect(out.fields.total!.status).toBe('needs_review')
    expect(out.fields.total!.alternatives.map((a) => a.rawValue)).toEqual(['1062.00'])
    expect(issueCodes(out)).toContain('conflict.candidates')
  })

  it('rejects a "total" that is the supplier phone number', () => {
    const b = simple(header().id('supplier.phone', '03-5551234', { raw: '03-5551234', label: 'טל\':' }))
      .money('total', '5551234', { raw: '5551234', label: null, method: 'pattern:free-text', score: 0.9 })
    const out = resolve(b.build())
    expect(values(out).total).toBe('1180.00')
    expect(out.fields.total!.status).toBe('verified')
    expect(issueCodes(out)).toContain('money.identifier_collision')
    expect(wrongVerified(out, SIMPLE_TRUTH)).toEqual([])
  })

  it('does not output a lone phone-number "total" at all', () => {
    const b = header()
      .id('supplier.phone', '054-5551234', { raw: '054-5551234', label: 'נייד:' })
      .money('total', '5451234', { raw: '0545551234', label: null, method: 'pattern:free-text', score: 0.6 })
    const out = resolve(b.build())
    expect(out.fields.total).toBeUndefined()
    expect(out.summary.missing).toContain('total')
  })

  it('keeps ILS as the document currency when USD amounts are also printed', () => {
    const b = header()
      .currency('ILS', { label: 'מטבע:', score: 0.85 })
      .money('subtotal', '1000.00', { currency: 'ILS', raw: '1,000.00 ₪' })
      .rate('18')
      .money('tax_amount', '180.00', { currency: 'ILS', raw: '180.00 ₪' })
      .money('total', '1180.00', { currency: 'ILS', raw: '1,180.00 ₪', score: 0.75 })
      .money('total', '320.00', { currency: 'USD', raw: '$320.00', label: 'Total USD', score: 0.85 })
    const out = resolve(b.build())
    expect(values(out)).toMatchObject({ total: '1180.00', currency: 'ILS' })
    expect(statuses(out)).toMatchObject({ total: 'verified', currency: 'verified' })
    expect(issueCodes(out)).toContain('currency.conversion')
  })

  it('refuses to verify when two complete sets of totals both close (ILS and an unlabelled conversion)', () => {
    const b = header()
      .money('subtotal', '1000.00', { score: 0.8 })
      .money('subtotal', '250.00', { score: 0.75 })
      .rate('18')
      .money('tax_amount', '180.00', { score: 0.8 })
      .money('tax_amount', '45.00', { score: 0.75 })
      .money('total', '1180.00', { score: 0.8 })
      .money('total', '295.00', { score: 0.75 })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ subtotal: 'needs_review', tax_amount: 'needs_review', total: 'needs_review' })
    expect(issueCodes(out)).toContain('conflict.arithmetic')
    // The rate fits both readings, but its only check runs through a disputed subtotal.
    expect(out.fields.tax_rate!.status).toBe('proposed')
    expect(out.summary.status).toBe('needs_review')
  })

  it('treats total = amount due on two different printings as corroboration only', () => {
    const b = header().money('total', '1180.00', { label: 'סה"כ', score: 0.8 }).money('amount_due', '1180.00', { label: 'לתשלום', score: 0.8 })
    const out = resolve(b.build())
    expect(check(out, 'sum:total=due')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ total: 'proposed', amount_due: 'proposed' })
  })

  it('closes a rounding line: 100.40 + 18.07 + עיגול 0.03 = 118.50', () => {
    const b = header()
      .money('subtotal', '100.40')
      .rate('18')
      .money('tax_amount', '18.07')
      .money('rounding', '0.03', { label: 'עיגול אגורות' })
      .money('total', '118.50')
    const out = resolve(b.build())
    expect(check(out, 'sum:subtotal+tax+rounding=total')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', tax_amount: 'verified', rounding: 'verified', total: 'verified' })
  })

  it('tolerates an unprinted cash rounding on a receipt but does not verify the total with it', () => {
    const b = invoice()
      .docType('tax_invoice_receipt', { raw: 'חשבונית מס קבלה', score: 0.9 })
      .textLine('אמצעי תשלום: מזומן')
      .money('subtotal', '100.40')
      .rate('18')
      .money('tax_amount', '18.07')
      .money('total', '118.50')
    const out = resolve(b.build())
    const sum = check(out, 'sum:subtotal+tax=total')!
    expect(sum.status).toBe('pass')
    expect(sum.message).toContain('not used to verify')
    expect(out.fields.total!.status).toBe('proposed')
    // The tax still closes exactly with the subtotal and rate.
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', tax_amount: 'verified' })
  })

  it('fails the same 0.03 gap on a non-cash tax invoice', () => {
    const b = header().money('subtotal', '100.40').rate('18').money('tax_amount', '18.07').money('total', '118.50')
    const out = resolve(b.build())
    expect(check(out, 'sum:subtotal+tax=total')?.status).toBe('fail')
    expect(out.fields.total!.status).toBe('needs_review')
  })

  it('verifies a credit note printed with negative amounts, keeping the signs', () => {
    const b = invoice()
      .docType('credit_note', { raw: 'חשבונית זיכוי', score: 0.9 })
      .money('subtotal', '-1000.00')
      .rate('18')
      .money('tax_amount', '-180.00')
      .money('total', '-1180.00')
    const out = resolve(b.build())
    expect(values(out)).toMatchObject({ subtotal: '-1000.00', tax_amount: '-180.00', total: '-1180.00' })
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', tax_amount: 'verified', total: 'verified', tax_rate: 'verified' })
  })

  it('verifies a credit note printed positive, and one with inconsistent signs, by magnitude', () => {
    const positive = invoice().docType('credit_note', { raw: 'חשבונית זיכוי', score: 0.9 }).money('subtotal', '1000.00').rate('18').money('tax_amount', '180.00').money('total', '1180.00')
    expect(statuses(resolve(positive.build()))).toMatchObject({ subtotal: 'verified', total: 'verified' })
    const mixed = invoice().docType('credit_note', { raw: 'חשבונית זיכוי', score: 0.9 }).money('subtotal', '1000.00').rate('18').money('tax_amount', '180.00').money('total', '-1180.00')
    const out = resolve(mixed.build())
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', total: 'verified' })
    expect(values(out).total).toBe('-1180.00')
  })

  it('derives a negative subtotal on a negative credit note', () => {
    const b = invoice().docType('credit_note', { raw: 'חשבונית זיכוי', score: 0.9 }).rate('18').money('tax_amount', '-180.00').money('total', '-1180.00')
    const out = resolve(b.build())
    expect(out.derived.find((d) => d.field === 'subtotal')?.normalized).toMatchObject({ amount: '-1000.00' })
  })

  it('does not verify the same amounts on a positive tax invoice with a flipped sign', () => {
    const b = header().money('subtotal', '1000.00').rate('18').money('tax_amount', '180.00').money('total', '-1180.00')
    const out = resolve(b.build())
    expect(out.fields.total?.status).not.toBe('verified')
  })
})
