import { describe, expect, it } from 'vitest'
import { classifyValue, type ValueGuess } from './classify'
import { parseCurrency } from './currency'
import { findDates } from './dates'
import { findPhones, parseIban, parseIsraeliBankAccount, parseTaxId } from './ids'
import { bestLabel, classifyDocumentType, matchLabels } from './match'
import { findAmounts, parsePercent } from './numbers'

/**
 * Lines as Israeli suppliers print them (several invoicing systems, utilities, freelancers, OCR
 * noise), in logical order as the reader produces them. Each case runs the label matcher and then
 * the value classifier on what follows the label, the way interpretation pairs an inline key/value.
 */

interface Read {
  concept: string | null
  value: ValueGuess | undefined
}

function read(line: string): Read {
  const m = bestLabel(line)
  if (!m) return { concept: null, value: undefined }
  // Strip the label/value separator, but not a minus sign glued to the value.
  const rest = line.slice(m.end).replace(/^[\s:：|]+/, '').replace(/^-\s+/, '')
  return { concept: m.concept, value: rest ? classifyValue(rest, { concept: m.concept })[0] : undefined }
}

/** Concepts in the order they appear on the line. */
const inOrder = (line: string): string[] =>
  matchLabels(line)
    .sort((a, b) => a.start - b.start)
    .map((m) => m.concept)

describe('Hebrew invoices: header lines', () => {
  it.each([
    ['מספר: 20231', 'invoice_number', 'id', '20231'],
    ["חשבונית מס מס' 1001", 'invoice_number', 'id', '1001'],
    ["חשבונית מס/קבלה מס' 20231", 'invoice_number', 'id', '20231'],
    ["קבלה מס' 300", 'invoice_number', 'id', '300'],
    ["חשבונית זיכוי מס' 55", 'invoice_number', 'id', '55'],
    ['תאריך: 31/10/2026', 'invoice_date', 'date', '2026-10-31'],
    ['תאריך הפקה 31.10.26', 'invoice_date', 'date', '2026-10-31'],
    ['תאריך החשבונית: 31 באוקטובר 2026', 'invoice_date', 'date', '2026-10-31'],
    ['לתשלום עד 15/11/2026', 'due_date', 'date', '2026-11-15'],
    ['תאריך פירעון: 30.11.2026', 'due_date', 'date', '2026-11-30'],
    ['תאריך אספקה 29/10/2026', 'delivery_date', 'date', '2026-10-29'],
    ["מס' הזמנה: PO-778", 'po_number', 'id', 'PO-778'],
    ['הזמנת רכש 4500012345', 'po_number', 'id', '4500012345'],
    ['מספר הקצאה: 123456789', 'allocation_number', 'id', '123456789'],
    ['ע.מ/ח.פ: 516123452', 'party.tax_id', 'tax_id', '516123452'],
    ["עוסק מורשה מס' 516123452", 'party.tax_id', 'tax_id', '516123452'],
    ['ח"פ 51-612345-2', 'party.tax_id', 'tax_id', '516123452'],
    ['עוסק פטור 30000012', 'party.tax_id', 'tax_id', '30000012'],
    ['מטבע: ש"ח', 'currency', 'currency', 'ILS'],
  ])('%s', (line, concept, kind, value) => {
    const r = read(line)
    expect(r.concept).toBe(concept)
    expect(r.value?.kind).toBe(kind)
    expect(r.value?.value).toBe(value)
  })

  it('reads the title on lines that also carry the number or a copy mark', () => {
    expect(classifyDocumentType('חשבונית מס / קבלה 20231')?.type).toBe('tax_invoice_receipt')
    expect(classifyDocumentType('חשבונית מס מקור')?.type).toBe('tax_invoice')
    expect(inOrder('חשבונית מס מקור')).toEqual(['doc.tax_invoice', 'trap.copy_mark'])
    expect(classifyDocumentType("קבלה מס' 300")?.type).toBe('receipt')
    expect(classifyDocumentType("חשבונית זיכוי מס' 55")?.type).toBe('credit_note')
    expect(classifyDocumentType('חשבון חשמל תקופתי')?.type).toBe('utility_bill')
    expect(classifyDocumentType('בס"ד')).toBeNull()
    expect(bestLabel('בס"ד')?.concept).toBe('trap.blessing')
  })

  it('finds the parties', () => {
    expect(read('לכבוד: ישראלי שירותים בע"מ')).toMatchObject({ concept: 'role.customer', value: { kind: 'text' } })
    expect(read('שם הלקוח: חברת הדוגמה בע"מ').concept).toBe('customer.name')
    expect(read('פרטי לקוח').concept).toBe('role.customer')
    expect(read('התקבל מאת: דנה כהן').concept).toBe('role.customer')
    expect(read('ספק: אלקטרו-טק בע"מ').concept).toBe('role.supplier')
    expect(read('הופקה באמצעות חשבונית ירוקה').concept).toBe('role.software')
    expect(read("מס' לקוח: 4455").concept).toBe('trap.customer_number')
    expect(read('ת. משלוח 5566').concept).toBe('trap.delivery_note')
  })
})

describe('Hebrew invoices: totals block', () => {
  it.each([
    ['סה"כ: 1,000.00 ₪', 'subtotal', '1000.00'],
    ['סה"כ לפני מע"מ 1,000.00', 'subtotal', '1000.00'],
    ['סכום לפני מע"מ: 1000', 'subtotal', '1000'],
    ['סה"כ לפני הנחה 1,200.00', 'subtotal', '1200.00'],
    ['סה"כ אחרי הנחה 1,080.00', 'other.after_discount', '1080.00'],
    ['סה"כ כולל מע"מ 1,263.20', 'total', '1263.20'],
    ['סה"כ לתשלום: 1,180.00 ₪', 'total_due', '1180.00'],
    ["סה''כ לתשלום 1,180.00", 'total_due', '1180.00'],
    ['סה"כ   לתשלום   1,180.00 ש"ח', 'total_due', '1180.00'],
    ['יתרה לתשלום 0.00', 'amount_due', '0.00'],
    ['שולם: 2,500.00 ₪', 'amount_paid', '2500.00'],
    ['מקדמה 500.00-', 'amount_paid', '-500.00'],
    ['עיגול אגורות -0.40', 'rounding', '-0.40'],
    ['סכום מע"מ 180.00', 'tax_amount', '180.00'],
    ['סה"כ זיכוי: 1,180.00-', 'total', '-1180.00'],
    ['יתרה קודמת 250.00', 'trap.previous_balance', '250.00'],
    ['מועבר לעמוד הבא: 5,000.00', 'trap.carried_forward', '5000.00'],
    ['סה"כ לעמוד 5,000.00', 'trap.page_subtotal', '5000.00'],
  ])('%s', (line, concept, value) => {
    const r = read(line)
    expect(r.concept).toBe(concept)
    expect(r.value).toMatchObject({ kind: 'amount', value })
  })

  it('splits a VAT line into its rate and its amount', () => {
    for (const line of ['מע"מ 18%: 180.00 ₪', 'מע"מ 18% 180.00', 'מע״מ % 18 180.00', 'מעמ 18% 180.00']) {
      // 'מע"מ %' is itself a VAT-rate label; both name the tax.
      expect(['tax', 'tax_rate'], line).toContain(bestLabel(line)?.concept)
      expect(parsePercent(line)?.value, line).toBe('18')
      expect(findAmounts(line).map((a) => a.amount), line).toEqual(['180.00'])
    }
  })

  it('reads a discount line with both a rate and an amount', () => {
    const line = 'הנחה 10% 120.00'
    expect(bestLabel(line)?.concept).toBe('discount')
    expect(parsePercent(line)?.value).toBe('10')
    expect(findAmounts(line).map((a) => a.amount)).toEqual(['120.00'])
  })

  it('reads the payment terms and the payment method', () => {
    expect(read('תנאי תשלום: שוטף + 30')).toMatchObject({ concept: 'payment_terms', value: { kind: 'text' } })
    expect(read('אמצעי תשלום: העברה בנקאית').concept).toBe('other.payment_method')
    expect(inOrder('שולם במזומן 1,180.00')).toEqual(['amount_paid', 'other.payment_method'])
  })
})

describe('Hebrew invoices: contact and bank details', () => {
  it('tells the phone from the fax and the mobile', () => {
    const line = "טל': 03-1234567 פקס: 03-1234568 נייד: 052-1234567"
    expect(inOrder(line)).toEqual(['party.phone', 'trap.fax', 'party.phone'])
    expect(findPhones(line).map((p) => p.value)).toEqual(['031234567', '031234568', '0521234567'])
    expect(read('נייד 052-1234567').value).toMatchObject({ kind: 'phone', value: '0521234567' })
    expect(read('טלפון: 1-700-500-500').value).toMatchObject({ kind: 'phone', value: '1700500500' })
    expect(read('מוקד: *2700').value).toMatchObject({ kind: 'phone', value: '*2700' })
  })

  it('reads e-mail and address labels', () => {
    expect(read('דוא"ל: billing@supplier.co.il').value).toMatchObject({ kind: 'email', value: 'billing@supplier.co.il' })
    expect(read('אימייל: billing@supplier.co.il').concept).toBe('party.email')
    expect(read('כתובת: רחוב הרצל 1, תל אביב').concept).toBe('party.address')
  })

  it('reads the bank block', () => {
    const line = 'פרטי חשבון להעברה: בנק הפועלים (12) סניף 532 חשבון 123456'
    expect(bestLabel(line)?.concept).toBe('party.bank_account')
    expect(parseIsraeliBankAccount(line)?.value).toBe('12-532-123456')
    expect(parseIsraeliBankAccount('בנק לאומי סניף 800 מספר חשבון 1234567')?.value).toBe('10-800-1234567')
    expect(read('IBAN: IL62 0108 0000 0009 9999 999').value).toMatchObject({ kind: 'iban', value: 'IL620108000000099999999' })
    expect(parseIban('מספר IBAN: IL62-0108-0000-0009-9999-999')?.checksum).toBe(true)
  })
})

describe('Hebrew invoices: tables and pages', () => {
  it('reads line-item headers from different systems', () => {
    expect(inOrder("מק\"ט תיאור כמות מחיר ליח' הנחה % סה\"כ")).toEqual([
      'col.sku', 'col.description', 'col.quantity', 'col.unit_price', 'col.discount', 'subtotal',
    ])
    expect(inOrder('פריט כמות מחיר סכום')).toEqual(['col.description', 'col.quantity', 'col.unit_price', 'col.line_amount'])
    expect(inOrder("קוד פריט | שם פריט | יח' | מחיר יחידה | סה\"כ שורה")).toEqual([
      'col.sku', 'col.description', 'col.quantity', 'col.unit_price', 'col.line_amount',
    ])
    expect(matchLabels('סה"כ').find((m) => m.concept === 'subtotal')?.also).toContain('col.line_amount')
  })

  it('reads page furniture as traps', () => {
    expect(bestLabel('עמוד 1 מתוך 2')?.concept).toBe('trap.page_number')
    expect(bestLabel('העתק נאמן למקור')?.concept).toBe('trap.copy_mark')
    expect(read('מספר חוזה: 346123456').concept).toBe('trap.contract_number')
    expect(read('מספר מונה 12345678').concept).toBe('trap.meter_number')
  })

  it('reads a billing period with two dates', () => {
    const line = 'תקופת חיוב 01/09/2026 - 31/10/2026'
    expect(bestLabel(line)?.concept).toBe('other.period')
    expect(findDates(line).map((d) => d.iso)).toEqual(['2026-09-01', '2026-10-31'])
  })
})

describe('Hebrew invoices: currency and ids in running text', () => {
  it('finds ILS in all its spellings', () => {
    for (const t of ['₪', 'ש"ח', 'ש״ח', "ש''ח", 'שח', 'בש"ח', 'שקלים', 'NIS']) expect(parseCurrency(`1,180.00 ${t}`), t).toBe('ILS')
  })

  it('finds a supplier id in a footer line', () => {
    expect(parseTaxId('א.ב. שירותים בע"מ ח.פ. 516123452 רח\' הרצל 1 תל אביב טל\' 03-1234567')).toMatchObject({ value: '516123452', checksum: true })
  })
})

describe('Hebrew invoices: more label spellings seen across suppliers', () => {
  it.each([
    ['חשבונית מס מס׳: 2026-0042', 'invoice_number'],
    ['מספר חשבונית מס/קבלה', 'invoice_number'],
    ['מס׳ קבלה', 'invoice_number'],
    ['תאריך מסמך', 'invoice_date'],
    // A value date is a payment date (also: other.payment_date), never a supply date.
    ['ת. ערך', 'due_date'],
    ["עוסק מס' 516123452", 'party.tax_id'],
    ['עוסק פטור מס׳', 'party.tax_id'],
    ['מספר ח.פ.', 'party.tax_id'],
    ['מספר חברה', 'party.tax_id'],
    ['ת"ז', 'party.tax_id'],
    ['טלפון לבירורים', 'party.phone'],
    ['פרטי העסק', 'role.supplier'],
    ['קוד לקוח', 'trap.customer_number'],
    ['כתובת לחשבונית', 'customer.address'],
    ['סה"כ חייב מע"מ', 'subtotal'],
    ['סה"כ פטור ממע"מ', 'trap.exempt'],
    ['סך הכל לתשלום', 'total_due'],
    ['סה"כ אחרי מע"מ', 'total'],
    ['יתרת חוב', 'amount_due'],
    ['חוב קודם', 'trap.previous_balance'],
    ['נוכה במקור', 'trap.tax_withholding'],
    ["צ'ק מס' 123", 'other.reference'],
    ["מס' אסמכתא 778899", 'other.reference'],
    ['מספר פרויקט', 'other.project'],
    ['דמי משלוח', 'other.charge'],
    ['פיקדון', 'other.charge'],
    ['מספר תעודת משלוח', 'trap.delivery_note'],
    ['מחיר כולל מע"מ', 'col.unit_price'],
    ['תעריף לשעה', 'col.unit_price'],
    ['אחוז הנחה', 'col.discount'],
  ])('%s → %s', (line, concept) => {
    expect(bestLabel(line)?.concept).toBe(concept)
  })

  it('finds nothing in plain sentences without labels', () => {
    expect(matchLabels('תודה שבחרתם בנו')).toEqual([])
    expect(matchLabels('אתר: www.invoice-online.co.il').map((m) => m.concept)).toEqual(['party.website'])
  })
})
