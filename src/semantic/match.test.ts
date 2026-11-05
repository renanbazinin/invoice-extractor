import { describe, expect, it } from 'vitest'
import { bestLabel, classifyDocumentType, labelScore, matchLabels } from './match'

/** The concept of the best match, or null. */
const concept = (text: string): string | null => bestLabel(text)?.concept ?? null

describe('matchLabels: Hebrew field labels', () => {
  it('finds invoice-number labels in their common spellings', () => {
    expect(concept('מספר חשבונית')).toBe('invoice_number')
    expect(concept("מס' חשבונית")).toBe('invoice_number')
    expect(concept('מס׳ חשבונית:')).toBe('invoice_number')
    expect(concept("חשבונית מס מס' 12345")).toBe('invoice_number')
    expect(concept('חשבונית מס מספר')).toBe('invoice_number')
    expect(concept("חשבונית מס/קבלה מס' 77")).toBe('invoice_number')
    expect(concept('מספר מסמך')).toBe('invoice_number')
  })

  it('treats geresh, gershayim, two apostrophes and no punctuation alike', () => {
    for (const t of ['מע"מ', 'מע״מ', "מע''מ", 'מעמ', 'מע”מ']) expect(concept(t), t).toBe('tax')
    for (const t of ['ח.פ.', 'ח"פ', 'ח״פ', 'ח.פ', 'חפ', 'ח. פ.']) expect(concept(t), t).toBe('party.tax_id')
    for (const t of ['סה"כ לפני מע"מ', 'סה״כ לפני מע״מ', 'סהכ לפני מעמ']) expect(concept(t), t).toBe('subtotal')
  })

  it('handles one-letter Hebrew prefixes and reports them', () => {
    const m = bestLabel('והמע"מ')!
    expect(m.concept).toBe('tax')
    expect(m.prefix).toBe('וה')
    expect(m.text).toBe('והמע"מ')
    expect(bestLabel('בתאריך')?.concept).toBe('invoice_date')
    expect(bestLabel('בתאריך')?.prefix).toBe('ב')
    expect(bestLabel('ללקוח')?.concept).toBe('role.customer')
    expect(bestLabel('וההנחה')?.concept).toBe('discount')
  })

  it('keeps לתשלום as its own phrase, not ל + תשלום', () => {
    const m = bestLabel('לתשלום')!
    expect(m.concept).toBe('amount_due')
    expect(m.prefix).toBe('')
    expect(concept('יתרה לתשלום')).toBe('amount_due')
    expect(concept('לתשלום עד')).toBe('due_date')
  })

  it('reads סה"כ לתשלום as total and amount due, and plain סה"כ as weak with alternatives', () => {
    const due = bestLabel('סה"כ לתשלום')!
    expect(due.concept).toBe('total_due')
    expect(due.fields).toEqual(['total', 'amount_due'])
    const plain = bestLabel('סה"כ:')!
    expect(plain.concept).toBe('subtotal')
    expect(plain.strength).toBe('weak')
    expect(plain.also).toContain('total')
    expect(plain.also).toContain('col.line_amount')
  })

  it('distinguishes total, subtotal and tax amount labels', () => {
    expect(concept('סה"כ כולל מע"מ')).toBe('total')
    expect(concept('סה"כ ללא מע"מ')).toBe('subtotal')
    expect(concept('סכום מע"מ')).toBe('tax_amount')
    expect(concept('מע"מ 18%')).toBe('tax')
    expect(concept('שיעור מע"מ')).toBe('tax_rate')
    expect(concept('עיגול אגורות')).toBe('rounding')
    expect(concept('מקדמה')).toBe('amount_paid')
    expect(concept('תנאי תשלום')).toBe('payment_terms')
    expect(concept('מספר הקצאה')).toBe('allocation_number')
    expect(concept('מספר הזמנה')).toBe('po_number')
    expect(concept('תאריך פירעון')).toBe('due_date')
    expect(concept('תאריך אספקה')).toBe('delivery_date')
  })

  it('adds the article to later words: תאריך החשבונית = תאריך חשבונית', () => {
    expect(concept('תאריך החשבונית')).toBe('invoice_date')
    expect(concept('סה"כ לפני המע"מ')).toBe('subtotal')
  })

  it("never reads מס' (number sign) as מס (tax)", () => {
    expect(bestLabel("מס' 12")?.concept).toBe('invoice_number')
    expect(bestLabel("מס' 12")?.strength).toBe('weak')
    expect(bestLabel('מס')?.concept).toBe('tax')
    expect(bestLabel('ניכוי מס במקור')?.concept).toBe('trap.tax_withholding')
  })
})

describe('matchLabels: parties, contacts, banks', () => {
  it('finds supplier and customer markers', () => {
    expect(concept('לכבוד')).toBe('role.customer')
    expect(concept('שם הלקוח')).toBe('customer.name')
    expect(concept('ספק')).toBe('role.supplier')
    expect(concept('נותן השירות')).toBe('role.supplier')
    expect(concept('כתובת למשלוח')).toBe('role.ship_to')
    expect(concept('Bill to:')).toBe('role.customer')
    expect(concept('Issued by')).toBe('role.supplier')
    expect(concept('Rechnungsempfänger')).toBe('role.customer')
    expect(concept('Rechnungsempfanger')).toBe('role.customer')
  })

  it('keeps phone and fax apart', () => {
    const m = matchLabels("טל' 03-1234567 פקס 03-7654321")
    expect(m.map((x) => x.concept)).toEqual(['party.phone', 'trap.fax'])
    expect(m[0].text).toBe("טל'")
    expect(concept('Fax:')).toBe('trap.fax')
    expect(concept('נייד')).toBe('party.phone')
  })

  it('finds tax-id, e-mail, address and bank labels', () => {
    expect(concept('עוסק מורשה')).toBe('party.tax_id')
    expect(concept("מס' עוסק מורשה")).toBe('party.tax_id')
    expect(concept('ת.ז.')).toBe('party.tax_id')
    expect(concept('דוא"ל')).toBe('party.email')
    expect(concept('דואל')).toBe('party.email')
    expect(concept('כתובת')).toBe('party.address')
    expect(concept('סניף')).toBe('party.bank_branch')
    expect(concept('ח-ן')).toBe('party.account_number')
    expect(concept('IBAN')).toBe('party.iban')
    expect(concept('USt-IdNr.')).toBe('party.tax_id')
    expect(concept('P.IVA')).toBe('party.tax_id')
    expect(concept('VAT Reg No.')).toBe('party.tax_id')
  })

  it("does not read עמ' (page) as ע.מ (tax id)", () => {
    expect(concept("עמ' 1 מתוך 2")).toBe('trap.page_number')
    expect(concept('ע.מ. 123456782')).toBe('party.tax_id')
  })

  it('matches upper-case acronyms only in upper case', () => {
    expect(concept('EIN: 12-3456789')).toBe('party.tax_id')
    expect(matchLabels('Ein Angebot').some((m) => m.concept === 'party.tax_id')).toBe(false)
    expect(concept('CIF: B12345678')).toBe('party.tax_id')
  })
})

describe('matchLabels: traps win by length', () => {
  it('rejects the look-alikes of targets', () => {
    expect(concept('סה"כ לעמוד')).toBe('trap.page_subtotal')
    expect(concept('מועבר לעמוד הבא')).toBe('trap.carried_forward')
    expect(concept('יתרה קודמת')).toBe('trap.previous_balance')
    expect(concept('מחיר לפני הנחה')).toBe('trap.price_before_discount')
    expect(concept('תעודת משלוח')).toBe('trap.delivery_note')
    expect(concept('מספר לקוח')).toBe('trap.customer_number')
    expect(concept('מספר חוזה')).toBe('trap.contract_number')
    expect(concept('מספר מונה')).toBe('trap.meter_number')
    expect(concept('העתק נאמן למקור')).toBe('trap.copy_mark')
    expect(concept('תאריך הזמנה')).toBe('trap.order_date')
    expect(concept('סה"כ כמות')).toBe('trap.total_quantity')
    expect(concept('Page total')).toBe('trap.page_subtotal')
    expect(concept('Previous balance')).toBe('trap.previous_balance')
    expect(concept('Customer No.')).toBe('trap.customer_number')
    expect(concept('Delivery note')).toBe('trap.delivery_note')
    expect(concept('Copy')).toBe('trap.copy_mark')
  })

  it('reads software footers as their own role', () => {
    expect(concept('הופק באמצעות חשבונית ירוקה')).toBe('role.software')
  })
})

describe('matchLabels: English and other languages', () => {
  it('folds No. / # / Nr. / N° / Number', () => {
    for (const t of ['Invoice No.', 'Invoice No', 'Invoice #', 'Invoice Number', 'Invoice Nr.', 'Inv. No', 'INVOICE NO:']) {
      expect(concept(t), t).toBe('invoice_number')
    }
    expect(concept('Rechnung Nr.')).toBe('invoice_number')
    expect(concept('Rechnungsnummer')).toBe('invoice_number')
    expect(concept('N° de facture')).toBe('invoice_number')
    expect(concept('Factura nº')).toBe('invoice_number')
    expect(concept('Factuurnummer')).toBe('invoice_number')
    expect(concept('Numero fattura')).toBe('invoice_number')
  })

  it('finds summary labels', () => {
    expect(concept('Subtotal')).toBe('subtotal')
    expect(concept('Sub-total')).toBe('subtotal')
    expect(concept('Total HT')).toBe('subtotal')
    expect(concept('Zwischensumme')).toBe('subtotal')
    expect(concept('Base imponible')).toBe('subtotal')
    expect(concept('Total TTC')).toBe('total')
    expect(concept('Grand Total')).toBe('total')
    expect(concept('Gesamtbetrag')).toBe('total')
    expect(concept('Balance due')).toBe('amount_due')
    expect(concept('Amount Due')).toBe('amount_due')
    expect(concept('Total due')).toBe('total_due')
    expect(concept('Less: deposit')).toBe('amount_paid')
    expect(concept('MwSt.')).toBe('tax')
    expect(concept('TVA')).toBe('tax')
    expect(concept('BTW')).toBe('tax')
    expect(concept('Total (incl. VAT)')).toBe('total')
    expect(bestLabel('Total')?.strength).toBe('weak')
  })

  it('finds line-item column headers', () => {
    expect(concept('תיאור')).toBe('col.description')
    expect(concept('כמות')).toBe('col.quantity')
    expect(concept("מחיר ליח'")).toBe('col.unit_price')
    expect(concept('מק"ט')).toBe('col.sku')
    expect(concept('Qty')).toBe('col.quantity')
    expect(concept('Unit Price')).toBe('col.unit_price')
    expect(concept('Description')).toBe('col.description')
    expect(concept('Bezeichnung')).toBe('col.description')
    expect(concept('Désignation')).toBe('col.description')
    expect(concept('Art.-Nr.')).toBe('col.sku')
  })
})

describe('matchLabels: spans and exactness', () => {
  it('returns offsets into the text as given, prefix included', () => {
    const text = '  תאריך הפקה: 31/10/2026'
    const m = bestLabel(text)!
    expect(m.concept).toBe('invoice_date')
    expect(text.slice(m.start, m.end)).toBe('תאריך הפקה')
    expect(m.exact).toBe(false)
    expect(bestLabel('תאריך הפקה:')!.exact).toBe(true)
  })

  it('returns non-overlapping matches, longest first', () => {
    const m = matchLabels('מספר חשבונית 1001 תאריך 31/10/2026 לכבוד')
    // Same length: the strong "לכבוד" ranks before the weak "תאריך".
    expect(m.map((x) => x.concept)).toEqual(['invoice_number', 'role.customer', 'invoice_date'])
    for (let i = 1; i < m.length; i++) expect(m[i].end - m[i].start).toBeLessThanOrEqual(m[i - 1].end - m[i - 1].start)
  })

  it('does not match inside words', () => {
    expect(matchLabels('Totalitarian')).toEqual([])
    expect(matchLabels('מסמכים').some((m) => m.concept === 'tax')).toBe(false)
  })
})

describe('classifyDocumentType', () => {
  const type = (t: string): string | null => classifyDocumentType(t)?.type ?? null

  it('prefers the longest Hebrew title', () => {
    expect(type('חשבונית מס')).toBe('tax_invoice')
    expect(type('חשבונית מס קבלה')).toBe('tax_invoice_receipt')
    expect(type('חשבונית מס/קבלה')).toBe('tax_invoice_receipt')
    expect(type('חשבונית מס - קבלה מקור')).toBe('tax_invoice_receipt')
    expect(type('חשבונית זיכוי')).toBe('credit_note')
    expect(type('חשבונית')).toBe('invoice')
    expect(type('קבלה')).toBe('receipt')
    expect(type('חשבון עסקה')).toBe('transaction_account')
    expect(type('הצעת מחיר')).toBe('quote')
    expect(type('חשבונית פרופורמה')).toBe('proforma')
    expect(type('חשבון חשמל תקופתי')).toBe('utility_bill')
  })

  it('reads a title with the number on the same line', () => {
    expect(type("חשבונית מס מס' 12345")).toBe('tax_invoice')
    expect(classifyDocumentType("חשבונית מס' 123")).toMatchObject({ type: 'tax_invoice', strength: 'weak' })
  })

  it('ignores title words inside other labels and copy marks', () => {
    expect(type('מספר חשבונית 1001')).toBeNull()
    expect(type('Invoice date: 31/10/2026')).toBeNull()
    expect(type('מקור')).toBeNull()
    expect(type('העתק')).toBeNull()
  })

  it('reads English and European titles', () => {
    expect(type('TAX INVOICE')).toBe('tax_invoice')
    expect(type('Credit Note')).toBe('credit_note')
    expect(type('Invoice')).toBe('invoice')
    expect(type('Rechnung')).toBe('invoice')
    expect(type('Facture')).toBe('invoice')
    expect(type('Gutschrift')).toBe('credit_note')
    expect(type('Proforma Invoice')).toBe('proforma')
    expect(type('Debit Note')).toBe('debit_note')
  })
})

describe('labelScore', () => {
  it('scores label-like text high and values low', () => {
    expect(labelScore('תאריך:')).toBeGreaterThan(0.8)
    expect(labelScore('Lieferzeitpunkt:')).toBeGreaterThan(0.7)
    expect(labelScore('שדה לא מוכר:')).toBeGreaterThan(0.7)
    expect(labelScore('1,180.00')).toBe(0)
    expect(labelScore('info@acme.co.il')).toBeLessThan(0.4)
    expect(labelScore('This is a long sentence of free text that explains the terms of the agreement')).toBeLessThan(0.3)
    expect(labelScore('INV-2026-0042')).toBeLessThan(0.5)
  })
})
