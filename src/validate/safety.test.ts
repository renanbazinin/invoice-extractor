import { describe, expect, it } from 'vitest'
import type { CanonicalField } from '../model/types'
import { add, dec, div, fromInt, mul, sameDecimal, str, sub, type Dec } from '../lib/decimal'
import { resolve } from './index'
import { invoice, wrongVerified, type InvoiceBuilder } from './testing'

/**
 * Property test for the one promise that matters: nothing wrong is ever verified. Random Israeli
 * invoices are generated with their true amounts, then handed over the way a noisy interpreter
 * would: fields missing, priors random, digits misread, decoys with random amounts, and role
 * confusions (the subtotal also offered as the total, the total offered as the amount due, …).
 * Every verified field must equal the truth, a field that is not on the document must never be
 * verified, and every derived value must be right. (Sweeps of 40,000 seeds per generator were
 * run during development with no violation; the test keeps 1,000 each to stay fast.) The third
 * generator covers the classes the hand-written invoices exposed (printedClasses).
 */

/** mulberry32: small, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Money = 'subtotal' | 'discount' | 'tax_amount' | 'total' | 'amount_paid' | 'amount_due' | 'rounding'

interface Case {
  build: InvoiceBuilder
  truth: Partial<Record<CanonicalField, string | null>>
}

const cents = (n: number): Dec => ({ units: BigInt(Math.round(n)), scale: 2 })

function generate(seed: number): Case {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const chance = (p: number) => r() < p
  const prior = () => Math.round((0.4 + r() * 0.55) * 100) / 100

  const rate = pick(['18', '18', '18', '17', '0'])
  const S = cents(1000 + Math.floor(r() * 5_000_000))
  const D = chance(0.25) ? div(mul(S, fromInt(pick([5, 10, 15]))), fromInt(100), 2) : null
  const base = D ? sub(S, D) : S
  const T = div(mul(base, dec(rate)), fromInt(100), 2)
  const R = chance(0.15) ? cents(pick([-4, -3, -2, -1, 1, 2, 3, 4])) : null
  let G = add(base, T)
  if (R) G = add(G, R)
  const P = chance(0.2) ? cents(Math.floor(Number(G.units) * (0.2 + r() * 0.5))) : null
  const A = P ? sub(G, P) : G

  const truth: Case['truth'] = {
    subtotal: str(S),
    discount: D ? str(D) : null,
    tax_amount: str(T),
    tax_rate: rate,
    total: str(G),
    amount_paid: P ? str(P) : null,
    rounding: R ? str(R) : null,
    // amount_due is only a field when a payable figure is printed; judged below when printed.
  }
  const real: Partial<Record<Money, Dec>> = { subtotal: S, tax_amount: T, total: G }
  if (D) real.discount = D
  if (R) real.rounding = R
  if (P) real.amount_paid = P

  const b = invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
  const misread = chance(0.3) ? pick(Object.keys(real) as Money[]) : null
  const amount = (d: Dec) => str(d)
  const garble = (d: Dec): string => {
    const s = str(d)
    const digits = [...s].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0)
    const i = pick(digits)
    const nd = String((Number(s[i]) + 1 + Math.floor(r() * 8)) % 10)
    return s.slice(0, i) + nd + s.slice(i + 1)
  }
  const include: Record<Money, number> = { subtotal: 0.8, discount: 0.9, tax_amount: 0.85, total: 0.95, amount_paid: 0.9, amount_due: 0.7, rounding: 0.9 }
  const printedLabel: Record<Money, string> = { subtotal: 'סה"כ לפני מע"מ', discount: 'הנחה', tax_amount: 'מע"מ', total: 'סה"כ', amount_paid: 'מקדמה', amount_due: 'יתרה לתשלום', rounding: 'עיגול אגורות' }
  for (const [field, value] of Object.entries(real) as [Money, Dec][]) {
    if (!chance(include[field])) {
      // Printed on the page, missed by the interpreter.
      b.textLine(`${printedLabel[field]} ${str(value)}`)
      continue
    }
    const v = field === misread ? garble(value) : amount(value)
    b.money(field, v, { id: `real-${field}`, score: prior(), conf: field === misread ? 0.6 : 1, label: field === 'total' && !P ? 'סה"כ לתשלום' : undefined })
    if (chance(0.15)) b.money(field, v, { score: prior(), label: 'סה"כ' })
  }
  if (chance(0.7)) b.rate(rate, { score: prior() })
  // Amount due: printed when there is a payment, or (sometimes) as the very same "סה"כ לתשלום" figure.
  if (P && chance(include.amount_due)) {
    b.money('amount_due', amount(A), { score: prior() })
    truth.amount_due = str(A)
  } else if (!P && chance(0.4) && b.build().candidates.some((c) => c.id === 'real-total')) {
    b.money('amount_due', b.candidate('real-total').normalized.kind === 'money' ? (b.candidate('real-total').normalized as { amount: string }).amount : amount(A), { shareWith: 'real-total', score: prior() })
    truth.amount_due = str(A)
  } else {
    truth.amount_due = P ? str(A) : null
  }

  // Decoys: random amounts and role confusions.
  const decoys = Math.floor(r() * 3)
  const fields: Money[] = ['subtotal', 'discount', 'tax_amount', 'total', 'amount_paid', 'amount_due', 'rounding']
  for (let i = 0; i < decoys; i++) {
    const f = pick(fields)
    const kind = r()
    let v: string
    if (kind < 0.4) v = amount(cents(100 + Math.floor(r() * 3_000_000)))
    else if (kind < 0.8) v = amount(pick(Object.values(real)))
    else v = amount(div(G, fromInt(2), 2))
    b.money(f, v, { score: Math.round((0.25 + r() * 0.65) * 100) / 100, label: pick(['סה"כ', 'סה"כ לעמוד', 'סכום', null]) })
  }
  if (chance(0.1)) b.rate(pick(['17', '18', '0']), { score: prior(), label: 'מע"מ' })

  // Lines: sometimes, summing to the subtotal (or, with a discount row, to subtotal − discount).
  if (chance(0.4)) {
    const n = 1 + Math.floor(r() * 4)
    let left = S.units
    for (let i = 0; i < n; i++) {
      const units = i === n - 1 ? left : BigInt(Math.floor(Number(left) * (0.2 + r() * 0.5)))
      left -= units
      const amt: Dec = { units, scale: 2 }
      const qty = pick([1, 2, 4, 5])
      const exact = units % BigInt(qty) === 0n
      b.line(exact ? { description: `פריט ${i + 1}`, quantity: String(qty), unitPrice: str({ units: units / BigInt(qty), scale: 2 }), amount: str(amt) } : { description: `פריט ${i + 1}`, amount: str(amt) })
    }
    if (D && chance(0.5)) b.line({ description: 'הנחה', amount: str({ units: -D.units, scale: 2 }) })
    if (chance(0.15)) b.line({ description: 'פריט שהוחמץ', amount: '123.45' }) // a row that is not really there
  }
  return { build: b, truth }
}


/**
 * A harsher generator: OCR on whole documents, the same words offered as two fields, swapped
 * paid/due labels, a self-consistent decoy triple (page totals at the same VAT rate), two equal
 * installments, the pre-advance "סה"כ לתשלום" offered as amount due, line amounts off by a cent.
 */
function adversarial(seed: number): Case {
  const r = rng(seed * 7919 + 13)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const chance = (p: number) => r() < p
  const prior = () => Math.round((0.3 + r() * 0.65) * 100) / 100
  const ocr = chance(0.4)
  const conf = () => (ocr ? Math.round((0.8 + r() * 0.2) * 100) / 100 : 1)
  const rate = pick(['18', '18', '17', '0'])
  const S = cents(100 + Math.floor(r() * 2_000_000))
  const D = chance(0.25) ? div(mul(S, fromInt(pick([5, 10, 15]))), fromInt(100), 2) : null
  const base = D ? sub(S, D) : S
  const T = div(mul(base, dec(rate)), fromInt(100), 2)
  const R = chance(0.15) ? cents(pick([-4, -3, -2, -1, 1, 2, 3, 4])) : null
  let G = add(base, T)
  if (R) G = add(G, R)
  const P = chance(0.25) ? cents(Math.floor(Number(G.units) * (0.2 + r() * 0.5))) : null
  const A = P ? sub(G, P) : G
  const truth: Case['truth'] = {
    subtotal: str(S),
    discount: D ? str(D) : null,
    tax_amount: str(T),
    tax_rate: rate,
    total: str(G),
    amount_paid: P ? str(P) : null,
    rounding: R ? str(R) : null,
    amount_due: P ? str(A) : null,
  }
  const b = invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
  const labels: Record<Money, string> = { subtotal: 'סה"כ לפני מע"מ', discount: 'הנחה', tax_amount: 'מע"מ', total: 'סה"כ כולל מע"מ', amount_paid: 'מקדמה', amount_due: 'יתרה לתשלום', rounding: 'עיגול אגורות' }
  const real: Partial<Record<Money, Dec>> = { subtotal: S, tax_amount: T, total: G }
  if (D) real.discount = D
  if (R) real.rounding = R
  if (P) {
    real.amount_paid = P
    real.amount_due = A
  }
  const swapPA = P && chance(0.1)
  for (const [f, v] of Object.entries(real) as [Money, Dec][]) {
    if (chance(0.15)) {
      b.textLine(`${labels[f]} ${str(v)}`)
      continue
    }
    let field: Money = f
    if (swapPA && f === 'amount_paid') field = 'amount_due'
    else if (swapPA && f === 'amount_due') field = 'amount_paid'
    b.money(field, str(v), { id: `r-${f}`, score: prior(), conf: conf(), label: labels[f] })
    // same words offered as another field
    if (chance(0.1)) b.money(pick(['subtotal', 'total', 'amount_due', 'tax_amount'] as Money[]), str(v), { shareWith: `r-${f}`, score: prior() })
  }
  if (!P && chance(0.5)) {
    const tot = b.build().candidates.find((c) => c.id === 'r-total')
    if (tot) {
      b.money('amount_due', str(G), { shareWith: 'r-total', score: prior(), label: 'סה"כ לתשלום' })
      truth.amount_due = str(G)
    }
  }
  if (P && chance(0.3)) {
    // The "סה"כ לתשלום" figure before the advance, mis-offered as amount_due.
    b.money('amount_due', str(G), { score: prior(), label: 'סה"כ לתשלום' })
  }
  if (chance(0.8)) b.rate(rate, { score: prior(), conf: conf() })
  // A consistent decoy triple (page totals / another currency).
  if (chance(0.2)) {
    const S2 = cents(100 + Math.floor(r() * 2_000_000))
    const T2 = div(mul(S2, dec(rate)), fromInt(100), 2)
    b.money('subtotal', str(S2), { score: prior(), label: 'סה"כ לעמוד' })
    b.money('tax_amount', str(T2), { score: prior(), label: 'מע"מ' })
    b.money('total', str(add(S2, T2)), { score: prior(), label: 'סה"כ' })
  }
  // Two equal installments.
  if (chance(0.15)) {
    const half = div(G, fromInt(2), 2)
    b.money(pick(['amount_paid', 'amount_due', 'subtotal', 'tax_amount'] as Money[]), str(half), { score: prior(), label: 'תשלום 1' })
    b.money(pick(['amount_paid', 'amount_due', 'discount'] as Money[]), str(sub(G, half)), { score: prior(), label: 'תשלום 2' })
  }
  // Random decoys.
  for (let i = Math.floor(r() * 3); i > 0; i--) {
    const f = pick(['subtotal', 'discount', 'tax_amount', 'total', 'amount_paid', 'amount_due', 'rounding'] as Money[])
    const v = chance(0.5) ? str(pick(Object.values(real))) : str(cents(Math.floor(r() * 3_000_000)))
    b.money(f, v, { score: prior(), label: pick(['סה"כ', 'סכום', null]), signals: [] })
  }
  // Misread one real value (OCR).
  if (chance(0.25)) {
    const f = pick(Object.keys(real) as Money[])
    const s = str(real[f]!)
    const idx = [...s].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0)
    const i = pick(idx)
    const bad = s.slice(0, i) + String((Number(s[i]) + 1 + Math.floor(r() * 8)) % 10) + s.slice(i + 1)
    b.money(f, bad, { score: prior(), conf: 0.55 + r() * 0.4, label: labels[f] })
  }
  // Lines.
  if (chance(0.4)) {
    const n = 1 + Math.floor(r() * 4)
    let left = S.units
    for (let i = 0; i < n; i++) {
      const units = i === n - 1 ? left : BigInt(Math.floor(Number(left) * (0.2 + r() * 0.5)))
      left -= units
      const qty = pick([1, 2, 3, 4])
      const unit = units / BigInt(qty)
      const amt = chance(0.1) ? str({ units: units + 1n, scale: 2 }) : str({ units, scale: 2 })
      b.line({ description: `פריט ${i}`, quantity: String(qty), unitPrice: str({ units: unit, scale: 2 }), amount: amt }, { conf: conf() })
    }
  }
  return { build: b, truth }
}

/** A random valid Israeli ID-family number (9 digits, check digit computed). */
function validId(r: () => number): string {
  const d = Array.from({ length: 8 }, (_, i) => (i === 0 ? 5 : Math.floor(r() * 10)))
  let total = 0
  for (let i = 0; i < 8; i++) {
    const p = d[i]! * (i % 2 === 0 ? 1 : 2)
    total += p > 9 ? p - 9 : p
  }
  return [...d, (10 - (total % 10)) % 10].join('')
}

/**
 * The classes the hand-written invoices exposed, mixed at random:
 *  - two checksum-valid party ids: the customer's under "לכבוד"/"לכב'" (or unmarked) offered as the
 *    supplier's by a letterhead guess, the supplier's only in the fine print, roles swapped;
 *  - "$" amounts on invoices whose currency is AUD/CAD (named elsewhere on the page or not);
 *  - lines at two VAT rates (tax_rate absent by definition), with a single rate still offered;
 *  - a utility bill whose amount due adds a printed previous balance;
 *  - a contractor's invoice that holds back a printed retention;
 *  - a quote whose "advance (30%)" is a schedule item, not a payment.
 */
function printedClasses(seed: number): Case & { mustBeAbsent: CanonicalField[] } {
  const r = rng(seed * 104729 + 31)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const chance = (p: number) => r() < p
  const prior = () => Math.round((0.4 + r() * 0.55) * 100) / 100
  const mustBeAbsent: CanonicalField[] = []
  const quote = chance(0.15)
  const utility = !quote && chance(0.2)
  const b = invoice().docType(quote ? 'quote' : utility ? 'utility_bill' : 'tax_invoice', { raw: quote ? 'הצעת מחיר' : utility ? 'חשבון חשמל' : 'חשבונית מס', score: 0.9 })
  const truth: Case['truth'] = {}

  // Parties.
  const sup = validId(r)
  let cus = validId(r)
  while (cus === sup) cus = validId(r)
  truth['supplier.tax_id'] = sup
  truth['customer.tax_id'] = cus
  truth['supplier.name'] = 'אלפא שירותים בע"מ'
  truth['customer.name'] = 'בטא מסחר בע"מ'
  const layout = pick(['clean', 'customer-as-letterhead', 'fineprint', 'swapped', 'unmarked'] as const)
  const marker = pick(['לכבוד', "לכב'", 'לקוח:', null])
  const sigSup = pick([['role:supplier'], [], ['label:exact', 'role:supplier']])
  if (layout !== 'customer-as-letterhead' && layout !== 'fineprint') {
    b.text('supplier.name', 'אלפא שירותים בע"מ', { label: null, block: 'sup', score: prior(), signals: sigSup, method: 'party:letterhead:name-line' })
  }
  if (layout === 'clean' || layout === 'unmarked') {
    b.id('supplier.tax_id', sup, { block: 'sup', label: 'ח.פ.', score: prior(), signals: sigSup, method: 'party:letterhead:label' })
  }
  if (marker && layout !== 'unmarked') b.textLine(marker, { block: 'cus' })
  if (layout === 'customer-as-letterhead' || layout === 'fineprint') {
    // The interpreter's letterhead guess picked the addressee block.
    b.text('supplier.name', 'בטא מסחר בע"מ', { label: null, block: 'cus', score: prior(), signals: sigSup, method: 'party:letterhead:name-line' })
    b.id('supplier.tax_id', cus, { block: 'cus', label: 'ח.פ.', score: prior(), signals: sigSup, method: 'party:letterhead:label' })
    if (layout === 'fineprint') b.textLine(`השם המסחרי בבעלות אלפא שירותים בע"מ, ח.פ. ${sup}`)
    else b.textLine(`ח.פ. ${sup}`, { block: 'foot' })
  } else if (layout === 'swapped') {
    b.id('supplier.tax_id', cus, { block: 'cus', label: 'ח.פ.', score: prior(), signals: sigSup, method: 'party:letterhead:label' })
    b.id('customer.tax_id', sup, { block: 'sup2', label: 'ח.פ.', score: prior(), signals: ['role:customer'], method: 'party:marker:label' })
  } else {
    b.text('customer.name', 'בטא מסחר בע"מ', { label: null, block: 'cus', score: prior(), signals: ['role:customer'], method: 'party:marker:first-line' })
    b.id('customer.tax_id', cus, { block: 'cus', label: 'ח.פ.', score: prior(), signals: ['role:customer'], method: 'party:marker:label' })
  }

  // Contacts: the supplier's phone and e-mail in its block, a fax and a mobile beside them (the
  // office line under "טל'" stays the main phone), sometimes a second e-mail of the supplier (then
  // which address is "the" contact is open: the truth names the other one, so verifying either
  // would be a guess), and the customer's own contacts.
  if (chance(0.6)) {
    const labelled = chance(0.5)
    b.text('supplier.phone', '03-5551234', { label: labelled ? "טל'" : 'מוקד', block: 'sup', score: labelled ? prior() : 0.45, method: 'party:letterhead:label', signals: labelled ? sigSup : [] })
    if (chance(0.3)) b.textLine("פקס: 03-5551235", { block: 'sup' })
    if (chance(0.25)) b.textLine('נייד: 052-1234567', { block: pick(['sup', 'foot2']) })
    truth['supplier.phone'] = '03-5551234'
    if (chance(0.3)) b.textLine("טל': 04-8889999", { block: 'cus' })
  }
  if (chance(0.6)) {
    b.text('supplier.email', 'office@alpha.co.il', { label: null, block: 'sup', method: 'party:letterhead:pattern', score: 0.72 })
    const second = chance(0.25)
    if (second) b.textLine('billing@alpha.co.il', { block: pick(['sup', 'foot2']) })
    truth['supplier.email'] = second ? 'billing@alpha.co.il' : 'office@alpha.co.il'
    if (chance(0.3)) b.textLine('דוא"ל: buyer@beta.co.il', { block: 'cus' })
  }

  // Currency: "$" on the amounts.
  const dollar = chance(0.3)
  const cur = dollar ? pick(['USD', 'AUD', 'CAD']) : 'ILS'
  if (dollar) {
    truth.currency = cur
    // The page may name the currency elsewhere ("All amounts in AUD"); the "$" parse says USD.
    const named = pick([null, cur])
    if (named) b.textLine(`All amounts in ${named}`)
    b.currency('USD', { raw: '$', label: null, method: 'pattern:currency-mark', score: prior() })
  }
  const sign = (s: string) => (dollar ? `$${s}` : `${s} ₪`)

  // Lines and VAT, possibly at two rates.
  const multi = !quote && chance(0.3)
  const n = 2 + Math.floor(r() * 3)
  const amounts = Array.from({ length: n }, () => cents(1000 + Math.floor(r() * 500_000)))
  const rates = amounts.map((_, i) => (multi ? (i % 2 === 0 ? '0' : '18') : '18'))
  const S = amounts.reduce((a, x) => add(a, x), fromInt(0))
  let T = fromInt(0)
  if (multi) {
    for (const rate of ['0', '18']) {
      const base = amounts.filter((_, i) => rates[i] === rate).reduce((a, x) => add(a, x), fromInt(0))
      T = add(T, div(mul(base, dec(rate)), fromInt(100), 2))
    }
    truth.tax_rate = null
    mustBeAbsent.push('tax_rate')
  } else {
    T = div(mul(S, dec('18')), fromInt(100), 2)
    truth.tax_rate = '18'
  }
  const G = add(S, T)
  truth.subtotal = str(S)
  truth.tax_amount = str(T)
  truth.total = str(G)
  amounts.forEach((a, i) => b.line({ description: `פריט ${i + 1}`, quantity: '1', unitPrice: str(a), amount: str(a), taxRate: multi || chance(0.3) ? rates[i] : undefined }))
  if (chance(0.85)) b.money('subtotal', str(S), { score: prior(), label: 'סה"כ לפני מע"מ' })
  if (chance(0.9)) b.money('tax_amount', str(T), { score: prior(), label: multi ? 'מע"מ' : 'מע"מ 18%' })
  b.money('total', str(G), { id: 'g', score: prior(), raw: sign(str(G)), currency: dollar ? 'USD' : 'ILS', label: 'סה"כ כולל מע"מ' })
  if (multi ? chance(0.8) : chance(0.6)) b.rate('18', { score: prior(), label: 'מע"מ' })

  // Between total and due.
  truth.amount_paid = null
  if (utility) {
    const prev = cents(100 + Math.floor(r() * 300_000))
    b.textLine(pick(['חוב קודם', 'יתרה קודמת', 'יתרה מחשבון קודם']), { block: 'prev' })
    b.textLine(str(prev), { block: 'prev2' })
    if (chance(0.5)) b.textLine(`${pick(['יתרה קודמת', 'חוב קודם'])} ${str(prev)}`)
    // Either the previous balance is still owed (due = total + previous), or it was paid (a
    // payment equal to it is printed and the due is the period's total).
    const paidPrev = chance(0.3)
    const due = paidPrev ? G : add(G, prev)
    truth.amount_due = str(due)
    b.money('amount_due', str(due), { id: 'due', score: prior(), label: paidPrev ? 'סה"כ לתשלום' : 'לתשלום' })
    // Decoys: the due offered as the total (same printed words).
    if (chance(0.5)) b.money('total', str(due), { shareWith: 'due', score: 0.3 })
    if (paidPrev) {
      b.money('amount_paid', str(prev), { score: prior(), label: 'שולם, תודה' })
      truth.amount_paid = str(prev)
    }
  } else if (!quote && chance(0.3)) {
    const ret = div(mul(S, fromInt(5)), fromInt(100), 2)
    const due = sub(G, ret)
    b.textLine('בניכוי עיכבון 5% מסכום הביצוע')
    b.textLine(`(${str(ret)})`)
    b.money('amount_due', str(due), { id: 'due', score: prior(), label: 'סה"כ לתשלום' })
    if (chance(0.5)) b.money('total', str(due), { shareWith: 'due', score: prior() })
    if (chance(0.3)) b.money('amount_paid', str(ret), { score: prior(), label: 'עיכבון' })
    truth.amount_due = str(due)
  } else if (quote) {
    const adv = div(mul(G, fromInt(30)), fromInt(100), 2)
    b.money('amount_paid', str(adv), { score: prior(), label: pick(['סכום המקדמה (30%)', 'מקדמה בחתימה', 'מקדמה 30%']) })
    b.money('amount_due', str(sub(G, adv)), { score: prior(), label: 'יתרה לתשלום' })
    mustBeAbsent.push('amount_paid')
  }
  return { build: b, truth, mustBeAbsent }
}

/**
 * A subtotal printed twice, before and after a document discount ("סה"כ לפני הנחה", "הנחה",
 * "סה"כ חייב במע"מ"), with the after-discount base the stronger reading; and the trap the other
 * way: no discount on the invoice, but a "discount" figure and a subtotal + discount figure that
 * close the same sums.
 */
function discountBase(seed: number): Case {
  const r = rng(seed * 15485863 + 101)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const chance = (p: number) => r() < p
  const prior = (lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) * 100) / 100
  const real = chance(0.6)
  const S = cents(10_000 + Math.floor(r() * 2_000_000))
  const D = real ? div(mul(S, fromInt(pick([2, 5, 10]))), fromInt(100), 2) : cents(500 + Math.floor(r() * 50_000))
  const base = real ? sub(S, D) : S
  const T = div(mul(base, dec('18')), fromInt(100), 2)
  const G = add(base, T)
  const b = invoice().docType('tax_invoice', { raw: 'חשבונית מס', score: 0.9 })
  const truth: Case['truth'] = { subtotal: str(S), discount: real ? str(D) : null, tax_amount: str(T), total: str(G), tax_rate: '18' }
  if (real) {
    b.money('subtotal', str(S), { score: prior(0.4, 0.75), label: pick(['סה"כ לפני הנחה', 'סה"כ שורות', 'סה"כ']) })
    b.money('discount', str(D), { score: prior(0.5, 0.95), label: 'הנחה' })
    b.money('subtotal', str(base), { score: prior(0.7, 0.95), label: pick(['סה"כ חייב במע"מ', 'סה"כ אחרי הנחה', 'סה"כ']) })
    if (chance(0.6)) b.line({ description: 'פריט', quantity: '1', unitPrice: str(S), amount: str(S) })
  } else {
    // The real subtotal (the lines' sum), a decoy "discount" (a saving already inside the prices)
    // and a decoy list-price figure: a page that printed "before discount" and a discount with
    // lines summing to it would have a real discount, so the decoy carries no such label.
    b.money('subtotal', str(S), { score: prior(0.7, 0.95), label: pick(['סה"כ חייב במע"מ', 'סה"כ']) })
    b.money('discount', str(D), { score: prior(0.3, 0.95), label: pick(['הנחה', 'הנחת לקוח']) })
    b.money('subtotal', str(add(S, D)), { score: prior(0.3, 0.75), label: pick(['מחיר מחירון', 'סה"כ']) })
    if (chance(0.5)) b.line({ description: 'פריט', quantity: '1', unitPrice: str(S), amount: str(S) })
  }
  b.money('tax_amount', str(T), { score: prior(0.5, 0.95), label: 'מע"מ 18%' })
  b.money('total', str(G), { score: prior(0.5, 0.95), label: 'סה"כ לתשלום' })
  if (chance(0.7)) b.rate('18', { score: prior(0.5, 0.95) })
  return { build: b, truth }
}

describe('safety: nothing wrong is ever verified', () => {
  const sweep = (gen: (seed: number) => Case & { mustBeAbsent?: CanonicalField[] }, seeds: number): number => {
    let verified = 0
    let fieldsSeen = 0
    for (let seed = 1; seed <= seeds; seed++) {
      const { build, truth, mustBeAbsent } = gen(seed)
      const out = resolve(build.build())
      expect(wrongVerified(out, truth), `seed ${seed}`).toEqual([])
      // Values that are not on the document must not appear at all (not only not be verified).
      for (const f of mustBeAbsent ?? []) expect(out.fields[f], `seed ${seed} ${f}`).toBeUndefined()
      for (const d of out.derived) {
        const t = truth[d.field]
        if (d.normalized.kind === 'money' && t) expect(sameDecimal(d.normalized.amount, t), `seed ${seed} derived ${d.field} ${d.normalized.amount} vs ${t}`).toBe(true)
        if (d.normalized.kind === 'percent' && t) expect(sameDecimal(d.normalized.value, t), `seed ${seed} derived rate`).toBe(true)
      }
      for (const f of Object.values(out.fields)) {
        fieldsSeen++
        if (f!.status === 'verified') verified++
      }
    }
    return verified / fieldsSeen
  }

  // Each sweep resolves 1000 whole invoices (tens of milliseconds each, mostly lexicon scans of the
  // page text), so it needs more than the default per-test time.
  const SWEEP_MS = 240_000

  it('holds over 1000 noisy random Israeli invoices', () => {
    // The property must not hold vacuously: most fields still get verified.
    expect(sweep(generate, 1000)).toBeGreaterThan(0.4)
  }, SWEEP_MS)

  it('holds over 1000 adversarial invoices (decoy clusters, permuted roles, OCR)', () => {
    expect(sweep(adversarial, 1000)).toBeGreaterThan(0.3)
  }, SWEEP_MS)

  it('holds over 1000 invoices with two party ids, "$", several VAT rates, previous balances, retentions and quotes', () => {
    expect(sweep(printedClasses, 1000)).toBeGreaterThan(0.3)
  }, SWEEP_MS)

  it('holds over 1000 invoices with a subtotal before and after a discount, and its decoy twin', () => {
    expect(sweep(discountBase, 1000)).toBeGreaterThan(0.3)
  }, SWEEP_MS)
})
