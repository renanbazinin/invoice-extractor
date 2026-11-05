import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { scheduleLabel } from './printed'
import { wholeTerms } from './terms'
import { ambiguousCurrencyOnly, resolveSign } from './currency'
import { check, invoice, issueCodes, statuses, values, wrongVerified } from './testing'

/**
 * What the page prints around the amounts (previous balances, retentions, several VAT rates,
 * payment schedules, no separate tax) and the formats that confirm a value only as a whole
 * (payment terms, currency signs, IBAN vs bank-branch-account, e-mail).
 */

describe('adjustments between total and amount due', () => {
  it('a retention held back: total − retention = due verifies both', () => {
    const b = invoice()
      .docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
      .money('subtotal', '1270049.50', { label: 'סה"כ ביצוע לחשבון זה', score: 0.6 })
      .money('tax_amount', '228608.91', { label: 'מע"מ 18%' })
      .money('total', '1498658.41', { label: 'סה"כ כולל מע"מ' })
      .textLine('בניכוי עיכבון 5% מסכום הביצוע (63,502.48)')
      .money('amount_due', '1435155.93', { label: 'סה"כ לתשלום', id: 'due' })
      .money('total', '1435155.93', { shareWith: 'due', score: 0.8 })
    const out = resolve(b.build())
    expect(check(out, 'sum:total-retention=due')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ total: 'verified', amount_due: 'verified' })
    expect(values(out)).toMatchObject({ total: '1498658.41', amount_due: '1435155.93' })
    expect(out.fields.amount_paid).toBeUndefined()
  })

  it('an exemption from withholding withholds nothing', () => {
    const b = invoice()
      .money('total', '1180.00', { label: 'סה"כ כולל מע"מ', score: 0.8 })
      .textLine('פטור מניכוי במקור 100.00')
      .money('amount_due', '1080.00', { label: 'לתשלום', score: 0.8 })
    const out = resolve(b.build())
    expect(check(out, 'sum:total-withholding=due')).toBeUndefined()
    expect(out.fields.amount_due!.status).not.toBe('verified')
  })

  it('a previous balance that was paid cancels out and proves nothing', () => {
    const b = invoice()
      .docType('utility_bill', { raw: 'חשבון חשמל', score: 0.9 })
      .textLine('יתרה קודמת: 512.92')
      .money('amount_paid', '512.92', { label: 'שולם, תודה' })
      .money('total', '466.29', { label: 'סה"כ', id: 'g', score: 0.6 })
      .money('amount_due', '466.29', { shareWith: 'g', label: 'סה"כ לתשלום' })
    const out = resolve(b.build())
    expect(out.checks.some((c) => c.id.includes('previous_balance'))).toBe(false)
    expect(out.fields.amount_paid?.status).not.toBe('verified')
  })
})

describe('several VAT rates', () => {
  const twoRates = () =>
    invoice()
      .docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
      .line({ description: 'הובלה ימית', quantity: '1', unitPrice: '2850.00', amount: '2850.00', taxRate: '0' })
      .line({ description: 'שחרור מכס', quantity: '1', unitPrice: '1175.00', amount: '1175.00', taxRate: '18' })
      .money('subtotal', '4025.00', { label: 'סה"כ לפני מע"מ' })
      .money('tax_amount', '211.50', { label: 'מע"מ' })
      .money('total', '4236.50', { label: 'סה"כ לתשלום' })
      .rate('18', { label: 'מע"מ 18% על החייב', score: 0.86 })

  it('does not output a single tax rate and checks the tax per rate', () => {
    const out = resolve(twoRates().build())
    expect(out.fields.tax_rate).toBeUndefined()
    expect(issueCodes(out)).toContain('tax.multiple_rates')
    expect(check(out, 'tax:tax=Σ(lines×rate)')?.status).toBe('pass')
    expect(statuses(out)).toMatchObject({ subtotal: 'verified', tax_amount: 'verified', total: 'verified' })
    expect(out.derived.find((d) => d.field === 'tax_rate')).toBeUndefined()
  })

  it('keeps a single rate when every line prints the same one', () => {
    const b = invoice()
      .line({ description: 'א', quantity: '1', unitPrice: '100.00', amount: '100.00', taxRate: '18' })
      .money('subtotal', '100.00')
      .money('tax_amount', '18.00')
      .money('total', '118.00')
      .rate('18')
    expect(resolve(b.build()).fields.tax_rate!.status).toBe('verified')
  })
})

describe('payment schedules are not payments', () => {
  it('drops the advance of a quote', () => {
    const b = invoice()
      .docType('quote', { raw: 'הצעת מחיר', score: 0.9 })
      .money('total', '37760.00', { label: 'סה"כ כולל מע"מ' })
      .money('amount_paid', '11328.00', { label: 'סכום המקדמה (30%)', score: 0.54 })
    const out = resolve(b.build())
    expect(out.fields.amount_paid).toBeUndefined()
    expect(issueCodes(out)).toContain('money.schedule_not_paid')
  })

  it('keeps an advance that was paid on an invoice', () => {
    const b = invoice()
      .money('total', '1180.00', { label: 'סה"כ כולל מע"מ' })
      .money('amount_paid', '354.00', { label: 'מקדמה (30%) ששולמה' })
      .money('amount_due', '826.00', { label: 'יתרה לתשלום' })
    expect(resolve(b.build()).fields.amount_paid).toBeDefined()
  })

  it('tells schedule labels from payments', () => {
    expect(scheduleLabel('סכום המקדמה (30%)')).toBe(true)
    expect(scheduleLabel('מקדמה בחתימה')).toBe(true)
    expect(scheduleLabel('Deposit due on signing')).toBe(true)
    expect(scheduleLabel('מקדמה ששולמה')).toBe(false)
    expect(scheduleLabel('Less: deposit received')).toBe(false)
    expect(scheduleLabel('מקדמה')).toBe(false)
  })
})

describe('formats that must hold for the whole value', () => {
  it('payment terms: the whole value, not a pattern inside a sentence', () => {
    expect(wholeTerms('שוטף + 30')).toBe(true)
    expect(wholeTerms('Net 30')).toBe(true)
    expect(wholeTerms('14 dagen')).toBe(true)
    expect(wholeTerms('30 jours fin de mois')).toBe(true)
    expect(wholeTerms('Due on receipt')).toBe(true)
    expect(wholeTerms('שוטף + 45 מיום אישור החשבון ע"י המפקח')).toBe(true)
    expect(wholeTerms('30% מקדמה בחתימה, יתרה שוטף + 30')).toBe(true)
    expect(wholeTerms('14 dagen. Wij verzoeken u het totaalbedrag vóór 23 oktober 2026')).toBe(false)
    expect(wholeTerms('שוטף + 30, עד 25/05/2026')).toBe(false)
    const out = resolve(invoice().text('payment_terms', '14 dagen. Wij verzoeken u het totaalbedrag vóór 23 oktober 2026', { label: 'Betalingstermijn', score: 0.78 }).build())
    expect(out.fields.payment_terms!.status).toBe('proposed')
  })

  it('currency: "$" alone never verifies; the page may name the ISO code', () => {
    expect(ambiguousCurrencyOnly(['$', '$30,243.40'])).toBe(true)
    expect(ambiguousCurrencyOnly(['US$ 30.00'])).toBe(false)
    expect(resolveSign('USD', ['All amounts in AUD'])).toEqual({ confirmed: false, rivals: ['AUD'] })
    expect(resolveSign('USD', ['Amounts in USD'])).toEqual({ confirmed: true, rivals: [] })
    const dollar = () => invoice().currency('USD', { raw: '$', label: null, method: 'pattern:currency-mark' }).money('total', '30243.40', { raw: '$30,243.40', currency: 'USD' })
    expect(resolve(dollar().build()).fields.currency!.status).toBe('proposed')
    const aud = resolve(dollar().textLine('ABN 51 823 077 461 · All amounts in AUD incl. GST').build())
    expect(aud.fields.currency!.status).toBe('needs_review')
    expect(wrongVerified(aud, { currency: 'AUD' })).toEqual([])
    expect(resolve(dollar().textLine('All amounts in USD').build()).fields.currency!.status).toBe('verified')
  })

  it('currency: an unambiguous sign printed with the verified total confirms it', () => {
    const b = invoice()
      .money('subtotal', '1000.00')
      .money('tax_amount', '180.00')
      .money('total', '1180.00', { id: 'g', raw: '1,180.00 ₪', currency: 'ILS' })
      .currency('ILS', { shareWith: 'g', raw: '₪', label: null, method: 'pattern:currency-mark' })
    expect(resolve(b.build()).fields.currency).toMatchObject({ status: 'verified', checks: ['currency:verified-total'] })
    // Another currency printed on an amount: which one is the document's is open.
    const conv = b.money('total', '318.00', { currency: 'USD', raw: '$318.00', score: 0.6 })
    expect(resolve(conv.build()).fields.currency!.status).not.toBe('verified')
  })

  it('bank account: with an IBAN printed, the bank-branch-account reading is not verified', () => {
    const b = invoice().id('supplier.bank_account', '12-612-000121', { label: 'בנק סניף חשבון', score: 0.78 }).textLine('IBAN: IL03')
    const out = resolve(b.build())
    expect(out.fields['supplier.bank_account']!.status).toBe('needs_review')
    expect(issueCodes(out)).toContain('bank.iban_printed')
  })

  it('bank account: the IBAN wins, and the same account printed as bank-branch-account corroborates it', () => {
    const b = invoice()
      .id('supplier.bank_account', '12-612-000121', { label: 'בנק סניף חשבון', score: 0.82 })
      .id('supplier.bank_account', 'IL640126120000000000121', { label: 'IBAN:', score: 0.7 })
    expect(resolve(b.build()).fields['supplier.bank_account']).toMatchObject({ status: 'verified', rawValue: 'IL640126120000000000121' })
  })

  it('e-mail: the only address on the page, in the verified tax-id block, verifies without a label', () => {
    const block = () =>
      invoice()
        .text('supplier.name', 'אלפא בע"מ', { label: null, block: 'sup', signals: ['role:supplier'] })
        .id('supplier.tax_id', '510000029', { label: 'ח.פ.', block: 'sup' })
        .text('supplier.email', 'office@alpha.co.il', { label: null, block: 'sup', method: 'party:letterhead:pattern', score: 0.72 })
    expect(resolve(block().build()).fields['supplier.email']!.status).toBe('verified')
    expect(resolve(block().textLine('לבירורים: billing@alpha.co.il').build()).fields['supplier.email']!.status).toBe('proposed')
  })

  it('phone: the only labelled phone (a fax aside), in the verified tax-id block, verifies under a weak label', () => {
    const block = () =>
      invoice()
        .id('supplier.tax_id', '510000029', { label: 'ח.פ.', block: 'sup' })
        .text('supplier.phone', '04-0000102', { label: 'מוקד שירות לקוחות', block: 'sup', score: 0.4, signals: [] })
        .textLine('פקס: 04-0000103', { block: 'sup' })
    expect(resolve(block().build()).fields['supplier.phone']!.status).toBe('verified')
    expect(resolve(block().textLine('נייד: 052-0000101', { block: 'sup' }).build()).fields['supplier.phone']!.status).toBe('proposed')
  })

  it("e-mail: a pattern outside the page's marked seller card is someone else's (a marketplace)", () => {
    const b = invoice()
      .textLine('SOLD BY', { block: 'sup' })
      .text('supplier.name', 'Oakbridge Cycle Parts Ltd', { label: null, block: 'sup', signals: ['role:supplier'], method: 'party:marker:first-line' })
    // The item table, then the platform's footer far below the card.
    for (let i = 0; i < 14; i++) b.line({ description: `Item ${i}`, amount: '10.00' })
    b.text('supplier.email', 'help@tradeshelf.example', { label: null, method: 'pattern:email', score: 0.4 })
    const out = resolve(b.build())
    expect(out.fields['supplier.email']).toBeUndefined()
    expect(issueCodes(out)).toContain('contact.not_supplier')
  })
})
