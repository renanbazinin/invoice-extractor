import { describe, expect, it } from 'vitest'
import { currencyAmbiguity, currencyFromLocaleCues, findCurrencies, parseCurrency } from './currency'
import { findPhones, parseBankAccount, parseIsraeliBankAccount, parsePhone, parseTaxId, taxIdCountryOfLabel, looksLikeIdentifier } from './ids'
import { bestLabel, classifyDocumentType, matchLabels } from './match'
import { findAmounts, parseAmount } from './numbers'

/**
 * Generalization beyond the generated corpus: vocabulary and morphology seen on hand-written
 * invoices of independent authors, requests of the other layers, and guards against readings
 * that only looked right on regular documents.
 */

const concept = (text: string): string | null => bestLabel(text)?.concept ?? null
const concepts = (text: string): string[] =>
  matchLabels(text)
    .sort((a, b) => a.start - b.start)
    .map((m) => m.concept)

describe('requests of the other layers', () => {
  it('reads page carry-overs and page sums as traps', () => {
    expect(concept('מהעברה')).toBe('trap.carried_forward')
    expect(concept('להעברה')).toBe('trap.carried_forward')
    expect(concept('העברה מעמוד קודם')).toBe('trap.carried_forward')
    expect(concept('סה"כ להעברה')).toBe('trap.carried_forward')
    expect(concept('סיכום עמוד')).toBe('trap.page_subtotal')
    // A bank transfer is still a payment method, and transfer details are bank details.
    expect(concept('העברה בנקאית')).toBe('other.payment_method')
    expect(concept('פרטים להעברה בנקאית')).toBe('party.bank_account')
    expect(concept('חשבון דולרי להעברה')).toBe('party.bank_account')
  })

  it('reads utility consumption as a quantity column', () => {
    expect(concept('צריכה')).toBe('col.quantity')
    expect(concept('צריכה בקוט"ש')).toBe('col.quantity')
  })

  it('reads the totals of bills, receipts and credit notes', () => {
    for (const t of ['סה"כ קנייה', 'סה"כ חיוב לתקופה', 'סה"כ חיובים לתקופה', 'סה"כ חשבון נוכחי', 'סה"כ חיובים לתקופה כולל מע"מ', 'סכום החשבון', 'סך כל העסקה', 'סה"כ ברוטו']) {
      expect(concept(t), t).toBe('total')
    }
    // Sums that are the subtotal on one invoice and the total on another read like a bare
    // "סה"כ": weak subtotal with the total in `also`, and arithmetic decides.
    for (const t of ['סה"כ חייב', 'סה"כ חיובים', 'סה"כ טיפולים', 'סה"כ ביצוע לחשבון זה', 'סה"כ']) {
      const m = bestLabel(t)!
      expect(m.concept, t).toBe('subtotal')
      expect(m.strength, t).toBe('weak')
      expect(m.also, t).toContain('total')
      expect(m.exact, t).toBe(true)
    }
    // Whatever is summed, a sum including VAT is the total and a sum before VAT the subtotal.
    expect(concept('סה"כ זיכוי כולל מע"מ')).toBe('total')
    expect(concept('סה"כ האירוע כולל מע"מ')).toBe('total')
    expect(concept('סה"כ זיכוי לפני מע"מ')).toBe('subtotal')
    expect(concept('סה"כ חיובים לפני מע"מ')).toBe('subtotal')
    expect(concept('חייב במע"מ')).toBe('subtotal')
    // The wildcard never stands for a tax word: VAT payable stays VAT.
    expect(concept('סה"כ מע"מ לתשלום')).not.toBe('total_due')
  })

  it('lists "Gross Amount" under subtotal and total (pre-tax in US usage)', () => {
    const m = bestLabel('Gross Amount:')!
    expect(m.concept).toBe('subtotal')
    expect(m.strength).toBe('weak')
    expect(m.also).toContain('total')
    expect(concept('Gross')).toBe('total')
  })

  it('adds invoice-number, terms, paid and discount labels', () => {
    expect(concept('No. de documento')).toBe('invoice_number')
    expect(concept('Nº de documento')).toBe('invoice_number')
    expect(concept('תנאים')).toBe('payment_terms')
    expect(concept('Règlement')).toBe('payment_terms')
    expect(concept('סה"כ תשלומים')).toBe('amount_paid')
    expect(concept('תשלומים')).toBe('amount_paid')
    expect(bestLabel('תשלומים')?.strength).toBe('weak')
    // "בתשלומים" is "in instalments", not a payment.
    expect(concepts('עסקה בתשלומים')).not.toContain('amount_paid')
    for (const t of ['הנחת מסמך', 'הנחת מועדון', 'הנחת קבוצה', 'הנחת מנוי', 'הנחה מיוחדת', 'Framework discount', 'Remise commerciale']) {
      expect(concept(t), t).toBe('discount')
      expect(bestLabel(t)?.exact, t).toBe(true)
    }
  })

  it('reads party labels', () => {
    expect(concept('שם החברה')).toBe('supplier.name')
    expect(concept('שם העוסק')).toBe('supplier.name')
    expect(concept('פרטי לקוח')).toBe('role.customer')
    expect(bestLabel('פרטי לקוח')?.exact).toBe(true)
    expect(concept("פל'")).toBe('party.phone')
    expect(concept('הזמנות ושירות')).toBe('party.phone')
    expect(concept('להזמנות')).toBe('party.phone')
    expect(concept('T: 0113 496 0582')).toBe('party.phone')
    expect(concept('T:')).toBe('party.phone')
    expect(concepts('Unit 3B, Hartwell')).not.toContain('party.phone')
    expect(concept('N° TVA intracom. : FR 08 790000012')).toBe('party.tax_id')
    expect(concept('TVA intracom.')).toBe('party.tax_id')
  })

  it("reads לכב' and לכ' as strong customer markers", () => {
    for (const t of ["לכב'", 'לכב׳', "לכ'", "לכב': מלונות חוף הכרמל ניהול בע\"מ"]) {
      const m = bestLabel(t)!
      expect(m.concept, t).toBe('role.customer')
      expect(m.strength, t).toBe('strong')
    }
  })

  it('reads service bills as utility bills', () => {
    const type = (t: string) => classifyDocumentType(t)?.type ?? null
    expect(type('חשבון שירותי תקשורת לעסקים')).toBe('utility_bill')
    expect(type('חשבון שירותי מים')).toBe('utility_bill')
    expect(type('החשבון החודשי שלך – ספטמבר 2026')).toBe('utility_bill')
    expect(type('חשבון דו-חודשי · מקור')).toBe('utility_bill')
    expect(type('הודעת חיוב לתקופה נובמבר–דצמבר 2026')).toBe('utility_bill')
    expect(type('חשבונית מס מרכזת 26/1185')).toBe('tax_invoice')
    // A debit note is still a debit note.
    expect(type('הודעת חיוב')).toBe('debit_note')
  })

  it('has a payment-date concept apart from delivery and due dates', () => {
    expect(concept('תאריך ערך')).toBe('due_date')
    expect(bestLabel('תאריך ערך')?.also).toContain('other.payment_date')
    expect(bestLabel('ת. ערך')?.also).toContain('other.payment_date')
    expect(bestLabel('תאריך פירעון')?.also).toContain('other.payment_date')
    expect(concepts('ת. ערך')).not.toContain('delivery_date')
    expect(concept('Payment date')).toBe('other.payment_date')
    expect(concept('Date paid')).toBe('other.payment_date')
  })

  it('tells a payment schedule from an amount already paid', () => {
    for (const t of ['סכום המקדמה (30%)', 'מקדמה (30%)', 'מקדמה 30%', '30% מקדמה', 'Deposit required', 'Deposit (30%)', 'Anzahlung fällig', 'Anzahlung 30 %']) {
      expect(concept(t), t).toBe('other.payment_schedule')
    }
    for (const t of ['מקדמה', 'מקדמה ששולמה', 'מקדמה ששולמה (העברה בנקאית 10/09/2026)', 'Deposit received', 'Less deposit', 'Less: deposit received 15/08/2026', 'Deposit', 'Less: paid on account']) {
      expect(concept(t), t).toBe('amount_paid')
    }
  })
})

describe('guards against false readings', () => {
  it('does not split ordinary words into prefix + label', () => {
    expect(matchLabels('קריית שמונה')).toEqual([])
    expect(matchLabels('מספק')).toEqual([])
    expect(matchLabels('הממונה על הגבייה').some((m) => m.concept === 'trap.meter_number')).toBe(false)
    expect(matchLabels('למען הסדר הטוב').some((m) => m.concept === 'party.address')).toBe(false)
    // The real prefixed labels still match.
    expect(concept('במונה')).toBe('trap.meter_number')
    expect(concept('והספק')).toBe('role.supplier')
  })

  it('reads a prefixed אתר as a place, not a website', () => {
    expect(concepts('ביקור באתר')).toEqual([])
    expect(concepts('הובלה לאתר הלקוח')).not.toContain('party.website')
    expect(concept('אתר: www.supplier.co.il')).toBe('party.website')
  })

  it('reads a prefixed חשבון as the bill, not a bank account', () => {
    expect(concepts('סיכום החשבון')).not.toContain('party.account_number')
    expect(concepts('חיובים בחשבון זה')).not.toContain('party.account_number')
    expect(concept('חשבון: 123456')).toBe('party.account_number')
  })

  it('does not read a hyphenated Hebrew compound as a label', () => {
    expect(matchLabels('דור-אל סטודיו לעיצוב בע"מ').some((m) => m.concept === 'role.customer')).toBe(false)
    expect(matchLabels('אל-פסק 3KVA און-ליין').some((m) => m.concept === 'role.customer')).toBe(false)
    expect(concept('אל: דור-אל סטודיו')).toBe('role.customer')
  })

  it("keeps Portuguese 'pago' out of Spanish payment phrases", () => {
    expect(matchLabels('Pago a 60 días').some((m) => m.concept === 'amount_paid')).toBe(false)
    expect(concept('Forma de pago')).toBe('other.payment_method')
    expect(concept('Valor pago')).toBe('amount_paid')
    expect(concept('Pagado')).toBe('amount_paid')
  })

  it('does not read a column word inside a name or a description as a column title', () => {
    expect(matchLabels('Acme Services Ltd.')).toEqual([])
    expect(matchLabels('Brightloom Data Services, Inc.').some((m) => m.kind === 'column')).toBe(false)
    expect(matchLabels('Calibration service on site').some((m) => m.kind === 'column')).toBe(false)
    expect(matchLabels('Unit 3B, Hartwell Business Park').some((m) => m.kind === 'column')).toBe(false)
    expect(matchLabels('בית קלייה · שירות למשרדים').some((m) => m.kind === 'column')).toBe(false)
    // Column titles, alone or as a header line, still read.
    expect(concept('Services')).toBe('col.description')
    expect(concept('Unit')).toBe('col.unit')
    expect(concept('Unit Price FOB Ningbo (USD)')).toBe('col.unit_price')
    expect(concepts('פריט כמות מחיר סכום')).toEqual(['col.description', 'col.quantity', 'col.unit_price', 'col.line_amount'])
  })

  it('keeps business-register numbers apart from tax ids', () => {
    for (const t of ['SIRET', 'RCS Lyon B', 'HRB 184522', 'Amtsgericht Charlottenburg', 'KvK', 'ACN', 'Company ID (IČO)']) {
      expect(concept(t), t).toBe('other.company_reg')
    }
    expect(concept('USt-IdNr.')).toBe('party.tax_id')
    expect(concept('VAT ID (DIČ)')).toBe('party.tax_id')
    expect(bestLabel('Steuernummer')?.strength).toBe('weak')
  })

  it('keeps look-alike numbers away from the invoice number', () => {
    for (const [t, c] of [
      ['מספר משתתפים', 'other.headcount'], ['מספר רכב', 'other.vehicle'], ['מספר רישוי', 'other.vehicle'],
      ['מספר עסקה', 'other.pos'], ['מספר קו', 'trap.customer_number'], ["מס' פוליו", 'other.stay'],
      ["מס' עבודה", 'other.project'], ["מס' קריאת שירות", 'other.project'], ['B/L No.', 'other.shipment'],
      ['Confirmation No.', 'other.stay'], ['Folio No.', 'other.stay'], ['מספר אריזות', 'other.shipment'],
    ] as const) {
      expect(concept(t), t).toBe(c)
    }
  })

  it('keeps weights, exchange rates and converted totals away from money fields', () => {
    expect(concept('Net weight')).toBe('other.shipment')
    expect(concept('משקל נטו')).toBe('other.shipment')
    expect(concept('Gross weight')).toBe('other.shipment')
    expect(concept('שער יציג ליום 26/10/2026')).toBe('other.exchange_rate')
    expect(concept('Rep. exchange rate')).toBe('other.exchange_rate')
    expect(concept('שווה ערך בש"ח')).toBe('other.converted_amount')
    expect(concept('NIS equivalent (reference only)')).toBe('other.converted_amount')
    expect(concept('General terms')).toBe('other.general_terms')
    expect(concept('Valid until')).toBe('other.valid_until')
    expect(concept('בתוקף עד')).toBe('other.valid_until')
    expect(concept('בניכוי עיכבון 5%')).toBe('other.retention')
  })
})

describe('Israeli bank accounts', () => {
  it('reads the bank with an article or a prefix', () => {
    expect(parseIsraeliBankAccount('הבנק הבינלאומי, סניף 872, ח-ן 00114')?.value).toBe('31-872-00114')
    expect(parseIsraeliBankAccount('בהעברה בנקאית: בנק מזרחי טפחות, סניף 262, ח-ן 00116')?.value).toBe('20-262-00116')
    expect(parseIsraeliBankAccount('העברה בנקאית: בנק 12 · סניף 612 · חשבון 000121')?.value).toBe('12-612-000121')
    expect(parseIsraeliBankAccount('בבנק לאומי סניף 800 חשבון 123456')?.value).toBe('10-800-123456')
  })

  it('does not read the word bank inside another word', () => {
    expect(parseIsraeliBankAccount('העברה בנקאית סניף 12 חשבון 123456')).toBeNull()
  })
})

describe('bank accounts of other countries', () => {
  it('reads UK sort codes, Australian BSBs and plain account numbers', () => {
    expect(parseBankAccount('Bank transfer to M Vintersen, sort code 20-45-77, account 00000125.')?.value).toBe('20-45-77-00000125')
    expect(parseBankAccount('Account name: Kestrel Ridge Advisory Pty Ltd BSB 083-417 Account 000 000 126')?.value).toBe('083-417-000000126')
    expect(parseBankAccount('Routing (ABA): 026013576 Account: 4800000113')?.value).toBe('4800000113')
    expect(parseBankAccount('A/C No.: 3901 0000 0000 0000 120')?.value).toBe('3901000000000000120')
  })

  it('prefers the IBAN, then the Israeli form', () => {
    expect(parseBankAccount('Sort code: 40-12-76 Account No: 00000123 IBAN: GB91 NRBK 4012 7600 0001 23')).toMatchObject({ scheme: 'IBAN', value: 'GB91NRBK40127600000123' })
    expect(parseBankAccount('בנק לאומי סניף 800 חשבון 123456')).toMatchObject({ scheme: 'IL', value: '10-800-123456' })
    expect(parseBankAccount('Account ID ACCT-00731')).toBeNull()
  })
})

describe('currency marks shared by several currencies', () => {
  it('flags $, ¥, Fr. and dollars as ambiguous and keeps their default', () => {
    const [m] = findCurrencies('$1,250.00')
    expect(m).toMatchObject({ code: 'USD', ambiguous: true })
    expect(m.candidates).toEqual(expect.arrayContaining(['USD', 'AUD', 'CAD', 'NZD']))
    expect(findCurrencies('¥ 12,000')[0]).toMatchObject({ code: 'JPY', ambiguous: true })
    expect(findCurrencies('Fr. 120.00')[0]).toMatchObject({ code: 'CHF', ambiguous: true })
    expect(findCurrencies('120 dollars')[0]).toMatchObject({ code: 'USD', ambiguous: true })
    for (const t of ['US$ 10', 'A$ 10', '₪ 10', '10 EUR', '10 ש"ח', '10 US dollars', '10 דולר ארה"ב', 'SFr. 10']) {
      expect(findCurrencies(t)[0]?.ambiguous, t).toBe(false)
    }
    expect(findCurrencies('10 דולר אוסטרלי')[0]?.code).toBe('AUD')
    expect(parseCurrency('$')).toBe('USD')
  })

  it('answers currencyAmbiguity for a printed mark', () => {
    expect(currencyAmbiguity('$')).toEqual(expect.arrayContaining(['USD', 'AUD', 'CAD']))
    expect(currencyAmbiguity('¥')).toEqual(['JPY', 'CNY'])
    expect(currencyAmbiguity('kr')).toEqual(['SEK', 'NOK', 'DKK', 'ISK'])
    expect(currencyAmbiguity('US$')).toBeNull()
    expect(currencyAmbiguity('AUD')).toBeNull()
    expect(currencyAmbiguity('₪')).toBeNull()
    expect(currencyAmbiguity('hello')).toBeNull()
  })

  it('flags amounts read with an ambiguous mark, and parses kr amounts without a code', () => {
    expect(parseAmount('$1,250.00')).toMatchObject({ amount: '1250.00', currency: 'USD', currencyAmbiguous: true })
    expect(parseAmount('1,250.00 USD')?.currencyAmbiguous).toBeUndefined()
    expect(parseAmount('1.234,00 kr', { decimal: ',', group: '.', confidence: 1 })).toMatchObject({ amount: '1234.00', currency: null, currencyAmbiguous: true })
    expect(findCurrencies('Summa 1.234,00 kr')).toEqual([])
  })

  it('reads ISO codes only as whole tokens', () => {
    expect(findCurrencies('CLP-20 שלה לצינור 20 מ"מ')).toEqual([])
    expect(findCurrencies('BALL PEN, blue')).toEqual([])
    expect(findCurrencies('PEN 1,250.00')[0]?.code).toBe('PEN')
    expect(findCurrencies('1,250.00 TRY')[0]?.code).toBe('TRY')
    expect(findCurrencies('Total EUR 10.00')[0]?.code).toBe('EUR')
  })

  it('picks the currency from locale cues', () => {
    const au = ['Kestrel Ridge Advisory Pty Ltd · ABN 51 823 077 461', 'Level 9, 47 Flinders Lane, Melbourne VIC 3000', 'GST 10%']
    expect(currencyFromLocaleCues(au, currencyAmbiguity('$')!)).toMatchObject({ code: 'AUD', decisive: true })
    expect(currencyFromLocaleCues(['77 Water Street, Brooklyn, NY 11249', 'Sales tax (NY 8.875%)'], currencyAmbiguity('$')!)).toMatchObject({ code: 'USD', decisive: true })
    expect(currencyFromLocaleCues(['Toronto, ON M5V 2T6', 'GST/HST No. 123456789 RT0001'], currencyAmbiguity('$')!)).toMatchObject({ code: 'CAD', decisive: true })
    expect(currencyFromLocaleCues(['Auckland 1010, New Zealand', 'GST No. 123-456-789'], currencyAmbiguity('$')!)?.code).toBe('NZD')
    expect(currencyFromLocaleCues(['ח.פ. 510000052', 'מע"מ 18%'])?.code).toBe('ILS')
    expect(currencyFromLocaleCues(['Unified Social Credit Code 91330212MA2GQ8XW58'], ['JPY', 'CNY'])?.code).toBe('CNY')
    expect(currencyFromLocaleCues(['Org.nr 556677-8899, Sverige'], ['SEK', 'NOK', 'DKK', 'ISK'])?.code).toBe('SEK')
    expect(currencyFromLocaleCues(['Thank you for your business'], currencyAmbiguity('$')!)).toBeNull()
  })
})

describe('phones of other countries', () => {
  it('reads grouped national numbers', () => {
    expect(parsePhone('0113 496 0582')).toMatchObject({ value: '01134960582', kind: 'national' })
    expect(parsePhone('04 72 00 01 08')?.value).toBe('0472000108')
    expect(parsePhone('030 000 0109')?.value).toBe('0300000109')
    expect(parsePhone('07700 900412')?.value).toBe('07700900412')
    expect(parsePhone('(03) 5550 0182')?.value).toBe('0355500182')
    expect(parsePhone('Tel. 963 00 01 10')).toMatchObject({ value: '963000110', country: 'ES' })
    // Israeli numbers keep their own reading.
    expect(parsePhone('03-1234567')).toMatchObject({ value: '031234567', kind: 'landline' })
  })

  it('does not read ids, accounts or dates as phones', () => {
    expect(parsePhone('823 077 461')).toBeNull()
    expect(parsePhone('812 345 676')).toBeNull()
    expect(parsePhone('51 823 077 461')).toBeNull()
    expect(parsePhone('01 02 2026')).toBeNull()
    expect(parsePhone('0000 0441 987')).toBeNull()
    expect(parsePhone('1,234.56')).toBeNull()
    expect(findPhones('IBAN: IL64 0126 1200 0000 0000 121')).toEqual([])
    expect(looksLikeIdentifier('2026-0688')).toBe(true)
  })
})

describe('tax ids of other countries', () => {
  it('reads Australian ABNs with a valid check digit', () => {
    expect(parseTaxId('ABN 51 823 077 461')).toMatchObject({ value: '51823077461', scheme: 'AU_ABN', checksum: true })
    expect(parseTaxId('ABN: 84712059306')).toMatchObject({ value: '84712059306', scheme: 'AU_ABN' })
    expect(parseTaxId('51 823 077 462')?.scheme).not.toBe('AU_ABN')
  })

  it("reads China's Unified Social Credit Code", () => {
    expect(parseTaxId('Unified Social Credit Code: 91330212MA2GQ8XW58')).toMatchObject({ value: '91330212MA2GQ8XW58', scheme: 'CN_USCC', checksum: true })
    expect(parseTaxId('91330212MA2GQ8XW59')?.scheme).not.toBe('CN_USCC')
  })

  it('keeps a trailing check letter under a hinted label', () => {
    expect(parseTaxId('P051234567X', { country: 'KE' })?.value).toBe('P051234567X')
  })

  it('names the country of country-specific tax-id labels', () => {
    expect(taxIdCountryOfLabel('ABN')).toBe('AU')
    expect(taxIdCountryOfLabel('KRA PIN')).toBe('KE')
    expect(taxIdCountryOfLabel('Unified Social Credit Code')).toBe('CN')
    expect(taxIdCountryOfLabel('DIČ')).toBe('CZ')
    expect(taxIdCountryOfLabel('VAT No.')).toBeNull()
    expect(concept('KRA PIN')).toBe('party.tax_id')
    expect(concept('Unified Social Credit Code')).toBe('party.tax_id')
  })
})

describe('labels mined from hand-written invoices', () => {
  it.each([
    ['סכום החשבון', 'total'],
    ['הסכום לתשלום', 'amount_due'],
    ['סך כל העסקה', 'total'],
    ['מס ערך מוסף', 'tax'],
    ['סה"כ חייב', 'subtotal'],
    ['מחיר נטו', 'col.unit_price'],
    ['ת. אספקה', 'delivery_date'],
    ['ת.אספקה', 'delivery_date'],
    ['ת. ביצוע העבודה', 'delivery_date'],
    ['תאריך מסירה', 'delivery_date'],
    ['סופק בתאריך', 'delivery_date'],
    ['תאריך האירוע', 'delivery_date'],
    ['אסמכתא', 'other.reference'],
    ['שם המזמין', 'customer.name'],
    ['סכום ביניים', 'subtotal'],
    ['סה"כ שולם', 'amount_paid'],
    ['סה"כ התקבל', 'amount_paid'],
    ['תאריך פרעון', 'due_date'],
    ['מטבע החשבון', 'currency'],
    ['הזמנתכם מס\'', 'po_number'],
    ["מס' הזמנה שלכם", 'po_number'],
    ['מזמין העבודה', 'role.customer'],
    ['פרטי המחזיק בנכס', 'role.customer'],
    ['פרטי העוסק', 'role.supplier'],
    ['הנפיק', 'role.supplier'],
    ['לתשלום בהעברה בנקאית', 'party.bank_account'],
    ['Net', 'subtotal'],
    ['Tax', 'tax'],
    ['Tax point', 'delivery_date'],
    ['Date of taxable supply', 'delivery_date'],
    ['Date de réalisation', 'delivery_date'],
    ['Datum uitvoering', 'delivery_date'],
    ['Leistungsdatum', 'delivery_date'],
    ['Te betalen', 'amount_due'],
    ['Net à payer', 'total_due'],
    ['Base imponible', 'subtotal'],
    ['Cuota IVA', 'tax_amount'],
    ['BALANCE DUE', 'amount_due'],
    ['PI No.', 'invoice_number'],
    ["Buyer's Order No.", 'po_number'],
    ['Uw ordernummer', 'po_number'],
    ['Datos del cliente', 'role.customer'],
    ['Customer Company No.', 'customer.tax_id'],
    ['Wire transfer details', 'party.bank_account'],
    ['Site address', 'role.ship_to'],
    ['Ship to / Service location', 'role.ship_to'],
    ['Payable to', 'role.supplier'],
    ['Marketplace operator', 'role.payment_processor'],
    ['Authorised signature', 'other.signature'],
    ['שם המקבל', 'other.signature'],
    ['הנדון', 'other.subject'],
    ['סכום במילים', 'other.in_words'],
  ])('%s → %s', (text, c) => {
    expect(concept(text)).toBe(c)
  })

  it('reads the abbreviated date word only before another word', () => {
    expect(concept('ת. הפקה')).toBe('invoice_date')
    expect(concepts('ת.ד. 123')).toEqual(['party.address'])
    expect(concepts('ת.ז. 030000038')).toEqual(['party.tax_id'])
  })

  it('keeps amounts in lines with the new labels', () => {
    expect(findAmounts('סה"כ חיובים לתקופה כולל מע"מ 1,234.50 ₪').map((a) => a.amount)).toEqual(['1234.50'])
  })
})

describe('amounts printed for information only', () => {
  it('reads late-payment, estimate, savings and change amounts as traps', () => {
    expect(concept('לתשלום לאחר המועד (כולל הפרשי הצמדה וריבית)')).toBe('trap.non_payable')
    expect(concept('חיוב שנתי משוער')).toBe('trap.non_payable')
    expect(concept('חסכת היום במבצעים')).toBe('trap.non_payable')
    expect(concept('עודף')).toBe('trap.non_payable')
    expect(concept('Amount after due date')).toBe('trap.non_payable')
    // The payable amount itself is unchanged.
    expect(concept('לתשלום')).toBe('amount_due')
    expect(concept('הפרשי אגורות')).toBe('rounding')
    expect(concept('הופקה ב-31.10.2026')).toBe('invoice_date')
  })
})

describe('sums around the rounding line', () => {
  it('reads the sum before rounding as its own concept', () => {
    expect(concept('סה"כ לפני עיגול')).toBe('other.before_rounding')
    expect(concept('עיגול אגורות')).toBe('rounding')
    expect(concepts('Tax point (date of supply)')).toEqual(['delivery_date', 'delivery_date'])
  })
})

describe('phrases the other layers kept locally', () => {
  it('reads them from the lexicon', () => {
    expect(concept('חשבון עבור')).toBe('role.customer')
    expect(concept('מזמין העבודה')).toBe('role.customer')
    expect(concept('פרטי המחזיק בנכס')).toBe('role.customer')
    expect(concept('פרטי העוסק')).toBe('role.supplier')
    expect(concept('שם העוסק')).toBe('supplier.name')
    // A title "invoice for ..." still names the document, not the customer.
    expect(classifyDocumentType('חשבונית עבור שירותי ייעוץ')?.type).toBe('invoice')
  })
})

describe('discount phrases inside a one-line table header', () => {
  it('do not swallow the neighbouring column title', () => {
    expect(concepts('Item Qty Price Discount Total')).toEqual(['col.description', 'col.quantity', 'col.unit_price', 'discount', 'total'])
    expect(concepts('Désignation Qté Prix Remise Montant')).toEqual(['col.description', 'col.quantity', 'col.unit_price', 'discount', 'col.line_amount'])
  })
})

describe('instalments', () => {
  it('reads a number of card instalments apart from payments received', () => {
    expect(concept('3 תשלומים')).toBe('other.installments')
    expect(concept('****6290 · 3 תשלומים · אישור 552910')).toBe('other.installments')
    expect(concept('תשלומים: 1')).toBe('other.installments')
    expect(concept("מס' תשלומים")).toBe('other.installments')
    expect(concept('עסקה בתשלומים')).toBe('other.installments')
    expect(concept('תשלומים')).toBe('amount_paid')
    expect(concept('תשלומים: 1,250.00')).toBe('amount_paid')
    expect(concept('סה"כ תשלומים')).toBe('amount_paid')
  })
})
