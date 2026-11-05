import { abs, dec, str } from '../../lib/decimal'
import type { CanonicalField, MoneyField } from '../../model/types'
import type { FieldsContext, Pair } from './context'
import { wordsOfSpan, type Draft } from './draft'
import { fieldsOf, mentions, senseOf } from './sense'
import { isDateRange, looksLikeTerms, readDate, readIdentifier, readMoney, readPercent, readText, type Found } from './values'

/**
 * Standard fields read from key/values: document numbers, dates, terms, money and the tax rate.
 * Party attributes are parties.ts's. The prior encodes how cleanly the label names the field
 * (strong/weak lexicon phrase, exact or with extra words, primary or secondary reading) and how
 * reliable the pairing is; validation chooses among the candidates.
 */

const MONEY_CONCEPTS = new Set(['subtotal', 'discount', 'tax', 'tax_amount', 'total', 'total_due', 'amount_paid', 'amount_due', 'rounding'])
const DATE_CONCEPTS = new Set(['invoice_date', 'due_date', 'delivery_date'])
const ID_CONCEPTS = new Set(['invoice_number', 'po_number', 'allocation_number'])

/** Hebrew/English/European cues of VAT that is included in the printed total. */
const INCLUSIVE = /מתוכו|מתוכם|מזה|כולל\s*מע|כלול|incl|includ|of which|inkl|enthalten|dont|incluid|inclus/i

/** Label prior: strong exact ≈ 0.9, weak exact ≈ 0.6, minus extra words, scaled by the pairing. */
export function labelPrior(pair: Pair, primary: boolean): number {
  const s = pair.sense
  let p = s.strong ? 0.9 : 0.62
  // Other words change what a label names ("תאריך חשבונית מקור" is another invoice's date).
  p -= s.extraWords === 0 ? 0 : s.extraWords === 1 ? 0.3 : 0.45
  p -= 0.05 * Math.min(2, s.extraBefore)
  if (!primary) p -= 0.15
  return p * (0.8 + 0.2 * pair.score)
}

function signalsFor(pair: Pair, primary: boolean): string[] {
  const s = pair.sense
  if (!s.strong || !primary) return []
  if (s.exact) return ['label:exact']
  return []
}

function method(pair: Pair): string {
  return `kv:${pair.layout}`
}

function valueIds(fc: FieldsContext, pair: Pair, start: number, end: number): string[] {
  return wordsOfSpan(fc.index, pair.value.wordIds, start, end)
}

function isPrimary(pair: Pair, concept: string): boolean {
  return pair.sense.primary?.concept === concept
}

// ---------------------------------------------------------------------------------------------
// Identifiers, dates, terms

export function metaDrafts(fc: FieldsContext): Draft[] {
  const out: Draft[] = []
  const bareDates = new Set<number>()
  for (const pair of fc.pairs) {
    const sense = pair.sense
    if (!sense.primary) continue
    const concepts = sense.concepts
    for (const c of concepts.filter((x) => ID_CONCEPTS.has(x))) {
      const field = c as 'invoice_number' | 'po_number' | 'allocation_number'
      // An identifier label with other words around it names another document's number
      // ("תשלום עבור חשבונית מס'", "Original invoice no.").
      if (!sense.exact) continue
      if (field === 'invoice_number' && !sense.strong && pair.layout === 'inline' && pair.score < 0.9) continue
      const id = readIdentifier(pair.value.text)
      if (!id) continue
      if (field === 'allocation_number' && !/^\d{6,12}$/.test(id.value.replace(/[\s-]/g, ''))) continue
      const primary = isPrimary(pair, c)
      out.push({
        field,
        rawValue: id.value,
        normalized: { kind: 'id', value: id.value, scheme: null, checksum: null },
        valueWordIds: valueIds(fc, pair, id.start, id.end),
        labelWordIds: pair.label.wordIds,
        originalLabel: sense.text,
        score: labelPrior(pair, primary),
        method: method(pair),
        signals: signalsFor(pair, primary),
      })
    }
    const dateConcepts = concepts.filter((x) => DATE_CONCEPTS.has(x))
    // "מועד התשלום: 19/3/2026": a payment-terms label in front of a date names the due date.
    if (!dateConcepts.length && concepts.includes('payment_terms')) {
      const d = readDate(pair.value.text, fc.dateOrder)
      if (d?.value.whole) dateConcepts.push('due_date')
    }
    for (const c of dateConcepts) {
      if (isDateRange(pair.value.text, fc.dateOrder)) continue
      const d = readDate(pair.value.text, fc.dateOrder)
      if (!d) continue
      const primary = isPrimary(pair, c) || c === 'due_date'
      let score = labelPrior(pair, primary)
      if (!d.value.whole) score -= 0.15
      if (c === 'invoice_date' && sense.exact && !sense.strong && d.value.whole && headerPair(fc, pair)) bareDates.add(out.length)
      out.push({
        field: c as CanonicalField,
        rawValue: d.raw,
        normalized: { kind: 'date', iso: d.value.iso, alternatives: d.value.alternatives },
        valueWordIds: valueIds(fc, pair, d.start, d.end),
        labelWordIds: pair.label.wordIds,
        originalLabel: sense.text,
        score,
        method: method(pair),
        signals: isPrimary(pair, c) ? signalsFor(pair, true) : [],
      })
    }
    out.push(...termsDrafts(fc, pair))
  }
  // A bare "תאריך:" / "Date:" in the document's header names the issue date, unless a specific
  // issue-date label is printed too (then the bare one may be anything and stays weak).
  const specific = out.some((d) => d.field === 'invoice_date' && d.signals.includes('label:exact'))
  if (!specific) for (const i of bareDates) out[i]!.score = Math.max(out[i]!.score, 0.76)
  // Unknown labels ("תנאים:", "Règlement:") in front of a value shaped like payment terms.
  for (const pair of fc.pairs) {
    if (pair.sense.primary || !looksLikeTerms(pair.value.text)) continue
    const t = readText(pair.value.text)!
    out.push({
      field: 'payment_terms',
      rawValue: t.value,
      normalized: { kind: 'text', value: t.value },
      valueWordIds: valueIds(fc, pair, t.start, t.end),
      labelWordIds: pair.label.wordIds,
      originalLabel: pair.sense.text,
      score: 0.45,
      method: method(pair),
      signals: [],
    })
  }
  return out
}

/**
 * Payment terms under a terms label, or under a due-date label whose value is terms rather than
 * a date ("מועד תשלום: מזומן").
 */
function termsDrafts(fc: FieldsContext, pair: Pair): Draft[] {
  const sense = pair.sense
  const termsLabel = sense.concepts.includes('payment_terms')
  const dueLabel = sense.concepts.includes('due_date')
  // "Forma de pago: Transferencia bancaria a 30 días": a payment-method label over a value
  // that states a term.
  const methodLabel = sense.primary?.concept === 'other.payment_method'
  if (!termsLabel && !dueLabel && !methodLabel) return []
  const whole = readText(pair.value.text)
  if (!whole) return []
  const date = readDate(pair.value.text, fc.dateOrder)
  if (date?.value.whole || readMoney(pair.value.text, fc.ctx.numberFormat)?.value.currency) return []
  const t = termsSentence(whole)
  const shaped = looksLikeTerms(t.value)
  if (!termsLabel && !shaped) return []
  // A label is not a value ("Terms of Payment" over "Valid until").
  const valueSense = senseOf(t.value)
  if (!shaped && valueSense.exact && valueSense.primary?.concept !== 'other.payment_method') return []
  const primary = termsLabel && isPrimary(pair, 'payment_terms')
  let score = termsLabel ? labelPrior(pair, primary) : methodLabel && !dueLabel ? 0.5 : 0.6
  if (termsLabel && !shaped) score -= 0.1
  return [
    {
      field: 'payment_terms',
      rawValue: t.value,
      normalized: { kind: 'text', value: t.value },
      valueWordIds: valueIds(fc, pair, t.start, t.end),
      labelWordIds: pair.label.wordIds,
      originalLabel: sense.text,
      score,
      method: method(pair),
      signals: termsLabel ? signalsFor(pair, primary) : [],
    },
  ]
}

/**
 * The terms in a value that runs on into prose ("14 dagen. Wij verzoeken u het totaalbedrag vóór
 * 23 oktober 2026 …"): the first sentence, when it alone has the shape of payment terms. The
 * value then ends where the terms expression ends, not where the line does.
 */
export function termsSentence(t: Found<string>): Found<string> {
  if (looksLikeTerms(t.value)) return t
  const m = /^(.*?\S)\s*[.;!](?=\s+\S|\s*$)/u.exec(t.value)
  if (!m || !looksLikeTerms(m[1]!)) return t
  const v = m[1]!
  return { value: v, raw: v, start: t.start, end: t.start + v.length }
}

/** On page 1, in its upper half, outside tables: where a document prints its own meta data. */
function headerPair(fc: FieldsContext, pair: Pair): boolean {
  const page = fc.index.doc.pages.find((p) => p.number === pair.page)
  if (!page || pair.page !== fc.index.doc.pages[0]?.number) return false
  if ([...pair.labelLineIds, ...pair.valueLineIds].some((id) => fc.itemLineIds.has(id) || fc.paymentLineIds.has(id))) return false
  return pair.label.bbox.y0 < 0.45 * page.height
}

/** "אסמכתא 73-60708": a reference number is the document's own number when nothing else is. */
export function referenceDrafts(fc: FieldsContext): Draft[] {
  const out: Draft[] = []
  for (const pair of fc.pairs) {
    if (pair.sense.primary?.concept !== 'other.reference' || !pair.sense.exact) continue
    if (fc.paymentLineIds.has(pair.valueLineIds[0] ?? '')) continue
    const id = readIdentifier(pair.value.text)
    if (!id) continue
    out.push({
      field: 'invoice_number',
      rawValue: id.value,
      normalized: { kind: 'id', value: id.value, scheme: null, checksum: null },
      valueWordIds: valueIds(fc, pair, id.start, id.end),
      labelWordIds: pair.label.wordIds,
      originalLabel: pair.sense.text,
      score: 0.4,
      method: method(pair),
      signals: [],
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Money

const POSITIVE = new Set<MoneyField>(['discount', 'amount_paid'])

/** Words saying money has actually changed hands (paid, received), not that it is due. */
const PAID = /שולם|ששולם|ששולמה|ששולמו|שהתקבל|התקבל|התקבלה|נתקבל|received|paid|bezahlt|erhalten|payé|reçu|pagad|recibid|ricevut|betaald|ontvangen/i

/**
 * An advance that is asked for, not one that was paid: "סכום המקדמה (30%)" on a quote, "Deposit
 * (30%) – upon confirmation" on a proforma. A quote or proforma has had nothing paid against it
 * unless the label says so, and an advance stated as a share of the total is a payment schedule.
 */
function scheduledAdvance(fc: FieldsContext, label: string): boolean {
  if (PAID.test(label)) return false
  return fc.docType === 'quote' || fc.docType === 'proforma' || /\d\s*%/.test(label)
}
/** What is left after payments, not the document's value. */
const BALANCE = /יתרה|יתרת|נותר|balance|outstanding|remaining|restbetrag|offener|solde|saldo|reste|pendiente|residuo|openstaand/i

function moneyFieldsOf(pair: Pair): { field: MoneyField; concept: string; primary: boolean }[] {
  const out: { field: MoneyField; concept: string; primary: boolean }[] = []
  for (const c of pair.sense.concepts) {
    if (!MONEY_CONCEPTS.has(c)) continue
    for (const f of fieldsOf(c)) {
      if (f === 'tax_rate') continue
      if (out.some((x) => x.field === f)) continue
      out.push({ field: f as MoneyField, concept: c, primary: isPrimary(pair, c) })
    }
  }
  return out
}

/** "before/without/excluding VAT", "net": words that make a sum the amount before tax. */
const PRE_TAX = /(?:לפני|ללא|לא כולל|before|excl\.?|excluding|without|ohne|hors|sin|senza|zonder)\s+(?:\S+\s+)?(?:מע"מ|מע״מ|מעמ|vat|tax|mwst|ust|tva|iva|btw|gst)|נטו|\bnet\b|netto|\bht\b/i

/** A bare sum word ("סה"כ"): either the net sum or the grand total; arithmetic decides. */
function bareSum(pair: Pair): boolean {
  const p = pair.sense.primary
  return !!p && p.concept === 'subtotal' && p.strength === 'weak' && p.also.includes('total')
}

/** The page prints a tax figure: without one, a lone sum is the total (nothing separates a net sum). */
function printsTax(fc: FieldsContext): boolean {
  return fc.pairs.some((p) => p.sense.concepts.some((c) => c === 'tax' || c === 'tax_amount') && !!readMoney(p.value.text, fc.ctx.numberFormat))
}

/** The page prints a document discount: a sum above it is the amount before the discount. */
function printsDiscount(fc: FieldsContext): boolean {
  return fc.pairs.some((p) => p.sense.primary?.concept === 'discount' && !!readMoney(p.value.text, fc.ctx.numberFormat))
}

/**
 * "סה"כ לאחר הנחה" / "Total after discount": without tax on the page it is what the document
 * comes to (its total); with tax it is the taxed base, neither the subtotal nor the total.
 */
function afterDiscountTargets(pair: Pair, taxed: boolean): { field: MoneyField; concept: string; primary: boolean }[] {
  if (taxed || pair.sense.primary?.concept !== 'other.after_discount') return []
  return [{ field: 'total', concept: 'total', primary: false }]
}

export function moneyDrafts(fc: FieldsContext): Draft[] {
  const out: Draft[] = []
  const receipt = fc.docType === 'receipt'
  const taxed = printsTax(fc)
  const discounted = printsDiscount(fc)
  for (const pair of fc.pairs) {
    const sense = pair.sense
    if (!sense.primary) continue
    if (sense.primary.kind === 'trap') continue
    let targets = moneyFieldsOf(pair)
    if (!targets.length) targets = afterDiscountTargets(pair, taxed)
    const rateLabel = sense.concepts.some((c) => c === 'tax' || c === 'tax_rate' || c === 'tax_amount')
    if (rateLabel) out.push(...rateDrafts(fc, pair))
    if (!targets.length) continue
    const m = readMoney(pair.value.text, fc.ctx.numberFormat)
    if (!m) continue
    // A bare rate is not an amount ("שיעור מע"מ 18%").
    if (readPercent(pair.value.text) && !m.value.currency && m.value.decimals === 0) continue
    const ids = valueIds(fc, pair, m.start, m.end)
    if (!ids.length) continue
    const ocrText = ids.some((id) => fc.index.word.get(id)?.source === 'ocr')
    const inclusive = INCLUSIVE.test(sense.text)
    const bare = bareSum(pair)
    if (bare) {
      // A qualified sum: "סה"כ חיובים לפני מע"מ" is the net sum, "סה"כ קנייה" / "סה"כ חשבון
      // נוכחי" the document's total; a bare "סה"כ" is either, but only beside a printed tax or
      // discount (something must separate the net sum from the total).
      const net = !sense.exact && PRE_TAX.test(sense.text)
      const both = sense.exact && (taxed || discounted)
      targets = net
        ? [{ field: 'subtotal', concept: 'subtotal', primary: true }]
        : [{ field: 'total', concept: 'total', primary: true }, ...(both ? [{ field: 'subtotal' as MoneyField, concept: 'subtotal', primary: true }] : [])]
    }
    const weakTotal = targets.length === 1 && targets[0]!.field === 'total' && !sense.strong && !bare
    const list = [...targets]
    // A generic "Total"/"Gross amount" may be the net sum; a payment total on a receipt is its total.
    if (weakTotal && taxed) list.push({ field: 'subtotal', concept: 'subtotal', primary: false })
    const hasTotal = targets.some((t) => t.field === 'total')
    const paidTotal = receipt && targets.some((t) => t.field === 'amount_paid') && !hasTotal
    // "לתשלום" / "Amount due": with nothing paid, the payable figure is the whole document's value.
    const payableTotal = !hasTotal && targets.some((t) => t.field === 'amount_due') && !BALANCE.test(sense.text)
    if (paidTotal || payableTotal) list.push({ field: 'total', concept: 'total', primary: false })
    for (const t of list) {
      if (t.field === 'amount_paid' && scheduledAdvance(fc, sense.text)) continue
      let amount = m.value.amount
      if (POSITIVE.has(t.field)) amount = str(abs(dec(amount)))
      let score = labelPrior(pair, t.primary)
      if (weakTotal && t.field === 'subtotal') score = 0.22
      if (bare && !sense.exact) score = (PRE_TAX.test(sense.text) ? 0.6 : 0.45) * (0.8 + 0.2 * pair.score)
      // The total is printed on every invoice, a net sum only sometimes.
      if (bare && sense.exact && t.field === 'subtotal') score -= 0.08
      // A pure receipt's payments total is its total (what was received); as a payment it is moot.
      if (t.field === 'total' && !hasTotal) score = paidTotal ? labelPrior(pair, true) : 0.3
      if (paidTotal && t.field === 'amount_paid') score -= 0.3
      if (m.value.decimals !== 2 && !m.value.currency) score -= 0.1
      // OCR breaks long figures into pieces ("0 ₪" out of "18,688.30"): a cent-less amount read by
      // OCR among cent-bearing ones is more likely a fragment than the figure.
      if (m.value.decimals === 0 && ocrText) score *= 0.5
      const signals = signalsFor(pair, t.primary)
      if (t.field === 'tax_amount' && inclusive) signals.push('tax:inclusive')
      out.push({
        field: t.field,
        rawValue: m.raw,
        normalized: { kind: 'money', amount, currency: m.value.currency },
        valueWordIds: ids,
        labelWordIds: pair.label.wordIds,
        originalLabel: sense.text,
        score,
        method: method(pair),
        signals,
      })
    }
  }
  return out
}

/** The VAT rate: a percent in a tax label ("מע"מ (18%)") or as the value of a rate label. */
function rateDrafts(fc: FieldsContext, pair: Pair): Draft[] {
  const sense = pair.sense
  if (mentions(sense, 'trap.tax_withholding', 'trap.exempt')) return []
  const inValue = readPercent(pair.value.text)
  const inLabel = sense.percent
  const rate = inValue ?? (inLabel ? { value: inLabel.value, raw: inLabel.raw, start: inLabel.start, end: inLabel.end } : null)
  if (!rate) return []
  const fromValue = !!inValue
  let ids = fromValue ? valueIds(fc, pair, rate.start, rate.end) : wordsOfSpan(fc.index, pair.label.wordIds, rate.start, rate.end)
  // The label text was cleaned of a trailing colon only, so offsets match the label words.
  if (!ids.length) ids = fromValue ? pair.value.wordIds : pair.label.wordIds
  const primary = sense.concepts[0] === 'tax_rate' || sense.concepts[0] === 'tax'
  return [
    {
      field: 'tax_rate',
      rawValue: rate.raw,
      normalized: { kind: 'percent', value: rate.value },
      valueWordIds: ids,
      labelWordIds: pair.label.wordIds,
      originalLabel: sense.text,
      score: labelPrior(pair, primary) - (sense.strong ? 0 : 0.1),
      method: fromValue ? method(pair) : `${method(pair)}:label-rate`,
      signals: signalsFor(pair, primary),
    },
  ]
}
