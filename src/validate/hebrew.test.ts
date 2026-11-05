import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { check, invoice, issueCodes, statuses, values, wrongVerified } from './testing'

/**
 * Forms Israeli suppliers actually send, beyond the plain חשבונית מס: receipts with a payment
 * table, utility bills with a previous balance, exempt dealers, scans, gershayim variants, short
 * dates, and the ambiguous bare סה"כ.
 */
describe('Hebrew document forms', () => {
  it('חשבונית מס/קבלה paid in full: יתרה לתשלום 0.00 is verified by label, the payment equal to the total is not', () => {
    const b = invoice()
      .docType('tax_invoice_receipt', { raw: 'חשבונית מס/קבלה', score: 0.9 })
      .money('subtotal', '1000.00')
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00', { label: 'סה"כ כולל מע"מ' })
      .money('amount_paid', '1180.00', { label: 'שולם בכרטיס אשראי' })
      .money('amount_due', '0.00', { label: 'יתרה לתשלום' })
    const out = resolve(b.build())
    expect(check(out, 'sum:total-paid=due')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ total: 'verified', amount_due: 'verified', amount_paid: 'proposed' })
    expect(out.fields.amount_due!.checks).toContain('label:amount_due')
    expect(wrongVerified(out, { total: '1180', amount_paid: '1180', amount_due: '0' })).toEqual([])
  })

  it('חשבון חשמל with a printed previous balance: total + previous debt = amount due', () => {
    const b = invoice()
      .docType('utility_bill', { raw: 'חשבון חשמל לתקופה', score: 0.85 })
      .textLine('יתרה מחשבון קודם 120.00')
      .money('total', '450.30', { label: 'סה"כ חיובים בתקופה', score: 0.7 })
      .money('amount_due', '570.30', { label: 'סה"כ לתשלום', score: 0.85 })
    const out = resolve(b.build())
    expect(check(out, 'sum:total+previous_balance=due')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ total: 'verified', amount_due: 'verified' })
    // due ≠ total − paid here: nothing may be derived from that formula.
    expect(out.derived.find((d) => d.field === 'amount_paid')).toBeUndefined()
  })

  it('חשבון חשמל whose previous balance does not close: total ≠ amount due is sent to review', () => {
    const b = invoice()
      .docType('utility_bill', { raw: 'חשבון חשמל לתקופה', score: 0.85 })
      .textLine('יתרה מחשבון קודם 125.00')
      .money('total', '450.30', { label: 'סה"כ חיובים בתקופה', score: 0.7 })
      .money('amount_due', '570.30', { label: 'סה"כ לתשלום', score: 0.85 })
    const out = resolve(b.build())
    expect(check(out, 'sum:total=due')?.status).toBe('fail')
    expect(statuses(out)).toMatchObject({ total: 'needs_review', amount_due: 'needs_review' })
    expect(out.summary.status).toBe('needs_review')
  })

  it('קבלה from an עוסק פטור with only a total: proposed, nothing to confirm it', () => {
    const b = invoice()
      .docType('receipt', { raw: 'קבלה', score: 0.9 })
      .text('supplier.name', 'יוסי כהן - שיעורים פרטיים', { label: null, signals: ['role:supplier'], score: 0.75 })
      .id('supplier.tax_id', '030000020', { label: 'עוסק פטור מס\'', score: 0.85 })
      .money('total', '350.00', { label: 'סה"כ', score: 0.85 })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ total: 'proposed', 'supplier.tax_id': 'verified', 'supplier.name': 'proposed' })
    expect(out.derived).toEqual([])
  })

  it('a scanned (OCR) invoice: arithmetic still verifies amounts, labels alone no longer verify ids and dates', () => {
    const conf = 0.85
    const b = invoice()
      .docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9, conf })
      .id('invoice_number', '31007', { score: 0.9, conf })
      .date('invoice_date', '25/04/2026', { score: 0.9, conf })
      .id('supplier.tax_id', '510000029', { label: 'ח.פ.', conf })
      .money('subtotal', '2500.00', { conf })
      .rate('18', { conf })
      .money('tax_amount', '450.00', { conf })
      .money('total', '2950.00', { conf })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({
      subtotal: 'verified',
      tax_amount: 'verified',
      total: 'verified',
      tax_rate: 'verified',
      // The checksum survives OCR, but whose number it is does not: with no supplier marker, a lost
      // "לכבוד" could make the customer's id look like the letterhead's.
      'supplier.tax_id': 'proposed',
      invoice_number: 'proposed',
      invoice_date: 'proposed',
      document_type: 'proposed',
    })
  })

  it('reads labels written with real gershayim (מע״מ, סה״כ) like ASCII quotes', () => {
    const b = invoice()
      .money('subtotal', '1000.00', { label: 'סה״כ' })
      .rate('0', { label: 'מע״מ 0%' })
      .money('tax_amount', '0.00', { label: 'מע״מ' })
      .money('discount', '0.00', { label: 'הנחה' })
      .money('total', '1000.00', { label: 'סה״כ לתשלום' })
    const out = resolve(b.build())
    expect(statuses(out)).toMatchObject({ tax_amount: 'verified', tax_rate: 'verified' })
  })

  it('a ת.ז of a sole proprietor (עוסק מורשה) is checked like a ח.פ', () => {
    expect(resolve(invoice().id('supplier.tax_id', '030000020', { label: 'עוסק מורשה', score: 0.8 }).build()).fields['supplier.tax_id']!.status).toBe('verified')
    expect(resolve(invoice().id('supplier.tax_id', '030000021', { label: 'עוסק מורשה', score: 0.8 }).build()).fields['supplier.tax_id']!.status).toBe('needs_review')
  })

  it('short Israeli dates (25.04.26) are verified; 03.04.26 waits for another date', () => {
    expect(resolve(invoice().date('invoice_date', '25.04.26', { score: 0.85 }).build()).fields.invoice_date).toMatchObject({ status: 'verified', normalized: { iso: '2026-04-25' } })
    const amb = resolve(invoice().date('invoice_date', '03.04.26', { score: 0.85 }).build())
    expect(amb.fields.invoice_date!.status).toBe('proposed')
    const settled = resolve(invoice().date('invoice_date', '03.04.26', { score: 0.85 }).date('due_date', '30.04.26', { score: 0.8 }).build())
    expect(settled.fields.invoice_date).toMatchObject({ status: 'verified', normalized: { iso: '2026-04-03' } })
  })

  it('an ambiguous bare "סה"כ" offered as both subtotal and total is settled by the VAT line', () => {
    const b = invoice()
      .money('subtotal', '1000.00', { id: 's1', label: 'סה"כ', score: 0.6 })
      .money('total', '1000.00', { shareWith: 's1', score: 0.4 })
      .money('total', '1180.00', { id: 't2', label: 'סה"כ', score: 0.6 })
      .money('subtotal', '1180.00', { shareWith: 't2', score: 0.4 })
      .rate('18')
      .money('tax_amount', '180.00', { label: 'מע"מ 18%' })
    const out = resolve(b.build())
    expect(values(out)).toMatchObject({ subtotal: '1000.00', total: '1180.00' })
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', total: 'verified', tax_amount: 'verified' })
  })

  it('payment terms in common Hebrew forms', () => {
    for (const t of ['שוטף + 30', 'שוטף+60', 'שוטף 90', 'מזומן']) {
      expect(resolve(invoice().text('payment_terms', t, { label: 'תנאי תשלום:', score: 0.85 }).build()).fields.payment_terms!.status, t).toBe('verified')
    }
  })

  it('an advance printed only as text keeps "סה"כ לתשלום" from being verified as amount due', () => {
    const b = invoice()
      .textLine('בניכוי מקדמה ששולמה 500.00')
      .money('subtotal', '1000.00')
      .rate('18')
      .money('tax_amount', '180.00')
      .money('total', '1180.00', { id: 'tot', label: 'סה"כ לתשלום' })
      .money('amount_due', '1180.00', { shareWith: 'tot', score: 0.7 })
    const out = resolve(b.build())
    expect(out.fields.total!.status).toBe('verified')
    expect(out.fields.amount_due!.status).toBe('proposed')
  })

  it('a Hebrew credit note (חשבונית זיכוי) referencing an invoice: amounts verified, number not confused', () => {
    const b = invoice()
      .docType('credit_note', { raw: 'חשבונית זיכוי', score: 0.9 })
      .id('invoice_number', '5021', { label: 'חשבונית זיכוי מס\'', score: 0.85 })
      .id('invoice_number', '4987', { label: 'בגין חשבונית מס\'', score: 0.45 })
      .money('subtotal', '-250.00')
      .rate('18')
      .money('tax_amount', '-45.00')
      .money('total', '-295.00')
    const out = resolve(b.build())
    expect(values(out).invoice_number).toBe('5021')
    expect(out.fields.invoice_number!.status).toBe('proposed') // the referenced number still competes
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', total: 'verified' })
    expect(issueCodes(out)).not.toContain('check.failed')
  })
})
