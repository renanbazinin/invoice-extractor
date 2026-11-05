import { describe, expect, it } from 'vitest'
import type { DocumentModel } from '../model/types'
import { dec } from '../lib/decimal'
import { CALIBRATION, STATUS_POLICY, resolve } from './index'
import { evaluateMoneyChecks, type ArithValues } from './arith'
import { looksLikeIdentifier } from './priors'
import { check, invoice, issueCodes, statuses, values, wrongVerified, type InvoiceBuilder } from './testing'

/**
 * A complete חשבונית מס from an Israeli supplier, the way the interpreter hands it over: header
 * block with the supplier's legal name and ח.פ, customer block, document number and dates, three
 * item rows and the totals box.
 */
function fullHebrewInvoice(): InvoiceBuilder {
  return invoice()
    .docType('tax_invoice', { raw: 'חשבונית מס', score: 0.92 })
    .text('supplier.name', 'אור-טל מערכות מיזוג בע"מ', { label: null, signals: ['role:supplier'], block: 'sup', score: 0.85 })
    .id('supplier.tax_id', '510000029', { label: 'ח.פ.', block: 'sup', score: 0.9 })
    .text('supplier.address', 'רח\' המלאכה 12, חולון 5885112', { label: null, block: 'sup', score: 0.7 })
    .text('customer.name', 'מסעדת הים התיכון בע"מ', { label: 'לכבוד:', score: 0.75 })
    .id('invoice_number', '2026-0457', { raw: '2026/0457', label: 'חשבונית מס מס\'', score: 0.9 })
    .date('invoice_date', '25/04/2026', { label: 'תאריך:', score: 0.88 })
    .date('due_date', '25/05/2026', { label: 'לתשלום עד:', score: 0.8 })
    .id('allocation_number', '102345678', { label: 'מספר הקצאה:', score: 0.85 })
    .line({ description: 'מזגן עילי 1.5 כ"ס', quantity: '2', unitPrice: '2,450.00'.replace(',', ''), amount: '4900.00' })
    .line({ description: 'התקנה', quantity: '2', unitPrice: '350.00', amount: '700.00' })
    .line({ description: 'צנרת נחושת (מטר)', quantity: '8', unitPrice: '50.00', amount: '400.00' })
    .money('subtotal', '6000.00', { raw: '6,000.00', label: 'סה"כ לפני מע"מ', score: 0.85 })
    .rate('18', { label: 'מע"מ 18%', score: 0.85 })
    .money('tax_amount', '1080.00', { raw: '1,080.00', label: 'מע"מ 18%', score: 0.85 })
    .money('total', '7080.00', { id: 'tot', raw: '7,080.00', label: 'סה"כ לתשלום', score: 0.85, currency: 'ILS' })
    .money('amount_due', '7080.00', { shareWith: 'tot', score: 0.7 })
}

describe('resolve: whole documents', () => {
  it('verifies a complete Hebrew tax invoice field by field, except the address', () => {
    const out = resolve(fullHebrewInvoice().build())
    expect(values(out)).toMatchObject({
      document_type: 'tax_invoice',
      'supplier.name': 'אור-טל מערכות מיזוג בע"מ',
      'supplier.tax_id': '510000029',
      invoice_number: '20260457',
      invoice_date: '2026-04-25',
      due_date: '2026-05-25',
      allocation_number: '102345678',
      subtotal: '6000.00',
      tax_rate: '18',
      tax_amount: '1080.00',
      total: '7080.00',
      amount_due: '7080.00',
    })
    const s = statuses(out)
    for (const f of ['document_type', 'supplier.name', 'supplier.tax_id', 'invoice_number', 'invoice_date', 'due_date', 'allocation_number', 'subtotal', 'tax_rate', 'tax_amount', 'total', 'amount_due'] as const) {
      expect(s[f], f).toBe('verified')
    }
    expect(s['supplier.address']).toBe('proposed')
    expect(s['customer.name']).toBe('proposed')
    expect(out.lineItems.map((l) => l.status)).toEqual(['verified', 'verified', 'verified'])
    expect(out.issues.filter((i) => i.severity !== 'info')).toEqual([])
    // An address can never be verified, so the document as a whole is 'proposed'.
    expect(out.summary).toMatchObject({ status: 'proposed', missing: [] })
    expect(out.summary.confidence).toBeGreaterThan(0.85)
    // No currency label, but the total is printed with ₪: the currency is derived, not a field.
    expect(out.fields.currency).toBeUndefined()
    expect(out.derived.find((d) => d.field === 'currency')?.normalized).toEqual({ kind: 'currency', code: 'ILS' })
  })

  it('reports the whole document verified when every found field is verified', () => {
    const b = invoice()
      .docType('tax_invoice', { raw: 'חשבונית מס', score: 0.92 })
      .text('supplier.name', 'גל-אור הנדסה בע"מ', { label: null, signals: ['role:supplier'], block: 'sup', score: 0.85 })
      .id('supplier.tax_id', '516000007', { label: 'ח.פ.', block: 'sup', score: 0.9 })
      .id('invoice_number', '88412', { score: 0.9 })
      .date('invoice_date', '14/09/2026', { score: 0.88 })
      .money('subtotal', '250.00')
      .rate('18')
      .money('tax_amount', '45.00')
      .money('total', '295.00')
    const out = resolve(b.build())
    expect(out.summary.status).toBe('verified')
    expect(out.summary.confidence).toBeGreaterThanOrEqual(0.95)
  })

  it('lists missing core fields as issues and in summary.missing', () => {
    const out = resolve(invoice().money('total', '1180.00', { score: 0.8 }).build())
    expect(out.summary.missing).toEqual(['invoice_number', 'invoice_date', 'supplier.name'])
    expect(issueCodes(out).filter((c) => c === 'missing.core')).toHaveLength(3)
    expect(out.summary.status).toBe('proposed')
  })

  it('returns an empty, honest result for a document with no candidates', () => {
    const doc: DocumentModel = {
      pages: [],
      words: [],
      lines: [],
      blocks: [],
      meta: { fileName: null, mimeType: 'application/pdf', pageCount: 0, textLayer: 'embedded', scripts: [], producer: null, warnings: [] },
    }
    const out = resolve({ document: doc, candidates: [], lineItems: [] })
    expect(out.fields).toEqual({})
    expect(out.lineItems).toEqual([])
    expect(out.summary).toEqual({ status: 'needs_review', confidence: 0, missing: ['invoice_number', 'invoice_date', 'total', 'supplier.name'] })
  })

  it('keeps every confidence inside the band of its status', () => {
    const out = resolve(fullHebrewInvoice().money('total', '7100.00', { label: 'סה"כ', score: 0.5 }).build())
    for (const f of Object.values(out.fields)) {
      const [lo, hi] = CALIBRATION.band[f!.status]
      expect(f!.confidence, f!.field ?? '').toBeGreaterThanOrEqual(lo)
      expect(f!.confidence, f!.field ?? '').toBeLessThanOrEqual(hi)
    }
  })

  it('drops a malformed candidate with a warning instead of crashing', () => {
    const b = invoice().money('total', '1180.00')
    const input = b.build()
    input.candidates.push({ ...input.candidates[0]!, id: 'bad', normalized: { kind: 'money', amount: '1,180.00', currency: null } })
    const out = resolve(input)
    expect(values(out).total).toBe('1180.00')
    expect(issueCodes(out)).toContain('candidate.malformed')
  })

  it('handles a mixed Hebrew/English invoice from a foreign supplier billed in USD', () => {
    const b = invoice()
      .docType('invoice', { raw: 'Invoice', score: 0.85 })
      .id('invoice_number', 'INV-2026-114', { label: 'Invoice No.', score: 0.85 })
      .date('invoice_date', '2026-04-03', { label: 'Invoice date', score: 0.85 })
      .text('customer.name', 'טבע תעשיות בע"מ', { label: 'Bill to', score: 0.7 })
      .currency('USD', { label: 'Currency', score: 0.8 })
      .line({ description: 'SaaS subscription (annual)', quantity: '1', unitPrice: '1200.00', amount: '1200.00' })
      .money('subtotal', '1200.00', { label: 'Subtotal', currency: 'USD', raw: '$1,200.00' })
      .money('tax_amount', '0.00', { label: 'VAT (reverse charge)', currency: 'USD', raw: '$0.00' })
      .money('total', '1200.00', { label: 'Total due', currency: 'USD', raw: '$1,200.00' })
    const out = resolve(b.build())
    expect(values(out)).toMatchObject({ currency: 'USD', total: '1200.00', invoice_date: '2026-04-03', invoice_number: 'INV2026114' })
    expect(statuses(out)).toMatchObject({ invoice_number: 'verified', invoice_date: 'verified', currency: 'verified', subtotal: 'verified' })
    expect(wrongVerified(out, { total: '1200', subtotal: '1200', tax_amount: '0', currency: 'USD' })).toEqual([])
  })

  it('stays fast and bounded with many candidates per field', () => {
    const b = invoice()
    for (let i = 0; i < 12; i++) {
      for (const f of ['subtotal', 'tax_amount', 'total', 'amount_due', 'amount_paid', 'discount'] as const) b.money(f, `${1000 + i * 37}.${10 + i}`, { score: 0.3 + i / 40 })
    }
    b.money('subtotal', '1000.00', { score: 0.9 }).rate('18').money('tax_amount', '180.00', { score: 0.9 }).money('total', '1180.00', { score: 0.9 })
    const t0 = performance.now()
    const out = resolve(b.build())
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(values(out)).toMatchObject({ subtotal: '1000.00', tax_amount: '180.00', total: '1180.00' })
    expect(wrongVerified(out, { subtotal: '1000', tax_amount: '180', total: '1180', amount_paid: null, amount_due: null, discount: null })).toEqual([])
  })

  it('documents the status policy for every kind of field', () => {
    for (const p of Object.values(STATUS_POLICY)) {
      expect(p.verified.length).toBeGreaterThan(20)
      expect(['verified', 'proposed']).toContain(p.max)
    }
    expect(STATUS_POLICY.address.max).toBe('proposed')
  })
})

describe('arithmetic checks', () => {
  const v = (o: Record<string, string>): ArithValues => {
    const out: ArithValues = {}
    let n = 0
    for (const [k, x] of Object.entries(o)) out[k as keyof ArithValues] = { value: dec(x), wordIds: new Set([`w${n++}`]) }
    return out
  }
  const ctx = { lines: null, cash: false, lineCount: 0 }

  it('pins every term of an exact sum and only the tax (not the base) through the rate', () => {
    const checks = evaluateMoneyChecks(v({ subtotal: '1000.00', tax_rate: '18', tax_amount: '180.00', total: '1180.00' }), ctx)
    const sum = checks.find((c) => c.id === 'sum:subtotal+tax=total')!
    expect(sum).toMatchObject({ grade: 'exact', supports: ['subtotal', 'tax_amount', 'total'] })
    const rate = checks.find((c) => c.id === 'tax:tax=rate*subtotal')!
    expect(rate).toMatchObject({ grade: 'exact', supports: ['tax_amount', 'tax_rate'], coarse: ['subtotal'] })
  })

  it('grades a one-cent gap as close (role only) and a two-cent gap as a failure', () => {
    expect(evaluateMoneyChecks(v({ subtotal: '1000.00', tax_amount: '180.00', total: '1180.01' }), ctx)[0]!.grade).toBe('close')
    expect(evaluateMoneyChecks(v({ subtotal: '1000.00', tax_amount: '180.00', total: '1180.02' }), ctx)[0]!.grade).toBe('fail')
  })

  it('treats subtotal + 0 = total as an equality that confirms no role', () => {
    const sum = evaluateMoneyChecks(v({ subtotal: '1000.00', tax_amount: '0.00', total: '1000.00' }), ctx)[0]!
    expect(sum).toMatchObject({ kind: 'corroboration', supports: [] })
  })

  it('rejects a tax above 30% of its base when no rate is printed', () => {
    const share = evaluateMoneyChecks(v({ subtotal: '500.00', tax_amount: '500.00', total: '1000.00' }), ctx).find((c) => c.id === 'tax:share<=30%')!
    expect(share.grade).toBe('fail')
  })

  it('recognises phone-shaped "amounts"', () => {
    expect(looksLikeIdentifier('0545551234')).toBe(true)
    expect(looksLikeIdentifier('03-5551234')).toBe(true)
    expect(looksLikeIdentifier('1,180.00')).toBe(false)
    expect(looksLikeIdentifier('5551234')).toBe(true)
    expect(check).toBeTypeOf('function')
  })
})
