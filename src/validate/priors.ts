import type { FieldCandidate, Issue } from '../model/types'
import { MONEY_FIELDS } from '../model/types'
import { abs, cmp, dec, isDecimalString } from '../lib/decimal'
import { CUES, KNOWN_TAX_RATES, MAX_TAX_RATE, PRIOR_FACTOR, TOLERANCE } from './policy'
import { hasCue, overlaps, wordIdsOf } from './evidence'
import { clamp01 } from './groups'

/**
 * Adjusts the interpreter's priors with knowledge that needs the whole candidate set: the document
 * currency, identifiers whose digits an amount repeats, and value ranges. These are penalties on
 * the prior, never vetoes: arithmetic can still pick a penalised value if it closes exactly.
 */

export interface CurrencyContext {
  /** The document currency (ISO 4217), or null when nothing says. */
  main: string | null
  source: 'field' | 'amounts' | null
  /** Other currencies printed on amounts (a conversion such as USD + ILS). */
  others: string[]
}

export interface PriorAdjustments {
  scoreOf(c: FieldCandidate): number
  notesOf(c: FieldCandidate): readonly string[]
  currency: CurrencyContext
  issues: Issue[]
}

const MONEY = new Set<string>(MONEY_FIELDS)
const MAIN_AMOUNTS = new Set<string>(['total', 'subtotal', 'amount_due', 'tax_amount'])
const IDENTIFIER_FIELDS = new Set<string>([
  'supplier.phone',
  'supplier.tax_id',
  'customer.tax_id',
  'invoice_number',
  'po_number',
  'allocation_number',
  'supplier.bank_account',
])

export function adjustPriors(candidates: readonly FieldCandidate[]): PriorAdjustments {
  const score = new Map<string, number>()
  const notes = new Map<string, string[]>()
  const issues: Issue[] = []
  for (const c of candidates) score.set(c.id, clamp01(c.score))
  const note = (c: FieldCandidate, n: string, factor: number) => {
    score.set(c.id, (score.get(c.id) ?? 0) * factor)
    notes.set(c.id, [...(notes.get(c.id) ?? []), n])
  }

  const currency = documentCurrency(candidates)

  // One document currency. A printed conversion keeps the main currency and is reported.
  const converted = new Set<string>()
  for (const c of candidates) {
    if (!MONEY.has(c.field) || c.normalized.kind !== 'money') continue
    const cur = c.normalized.currency
    if (cur && currency.main && cur.toUpperCase() !== currency.main) {
      note(c, 'currency-mismatch', PRIOR_FACTOR.currencyMismatch)
      if (MAIN_AMOUNTS.has(c.field) && c.score >= 0.5) converted.add(cur.toUpperCase())
    }
  }
  if (converted.size) {
    issues.push({
      severity: 'info',
      code: 'currency.conversion',
      message: `Amounts are also printed in ${[...converted].join(', ')}; ${currency.main} is kept as the document currency.`,
      fields: ['currency'],
    })
  }

  // Per-page sums and carried-forward balances are not the document's figures.
  for (const c of candidates) {
    if (MONEY.has(c.field) && hasCue(c.originalLabel, CUES.pageTotal)) note(c, 'page-total-label', PRIOR_FACTOR.pageTotal)
  }

  // An amount that repeats a phone number, tax id or document number is that identifier.
  const identifiers = candidates.filter((c) => IDENTIFIER_FIELDS.has(c.field))
  for (const c of candidates) {
    if (!MONEY.has(c.field) || c.normalized.kind !== 'money') continue
    const hit = identifiers.find((id) => collides(c, id))
    if (hit) {
      note(c, `identifier-collision:${hit.field}`, PRIOR_FACTOR.identifierCollision)
      issues.push({
        severity: 'info',
        code: 'money.identifier_collision',
        message: `"${c.rawValue}" (${c.field} candidate) is the same text as the ${hit.field} "${hit.rawValue}"; it is not used as an amount.`,
        fields: [c.field],
      })
    } else if (looksLikeIdentifier(c.rawValue)) {
      note(c, 'looks-like-identifier', PRIOR_FACTOR.looksLikeIdentifier)
    }
    if (c.field === 'rounding' && isDecimalString(c.normalized.amount)) {
      if (cmp(abs(dec(c.normalized.amount)), dec(TOLERANCE.maxRounding)) >= 0) note(c, 'rounding-too-large', PRIOR_FACTOR.roundingTooLarge)
    }
  }

  for (const c of candidates) {
    if (c.field !== 'tax_rate') continue
    const v = rateValue(c)
    if (v === null || v.startsWith('-') || cmp(dec(v), dec(MAX_TAX_RATE)) > 0) note(c, 'implausible-rate', 0)
    else if (!KNOWN_TAX_RATES.some((k) => cmp(dec(k), dec(v)) === 0)) note(c, 'unknown-rate', PRIOR_FACTOR.unknownRate)
  }

  return {
    scoreOf: (c) => score.get(c.id) ?? 0,
    notesOf: (c) => notes.get(c.id) ?? [],
    currency,
    issues,
  }
}

/** The percent value of a tax-rate candidate, or null. */
export function rateValue(c: FieldCandidate): string | null {
  const n = c.normalized
  const v = n.kind === 'percent' || n.kind === 'decimal' ? n.value : null
  return v !== null && isDecimalString(v) ? v : null
}

/**
 * The currency field's best code, else the code most printed on the main amounts (weighted by
 * prior). A field candidate wins because a "מטבע: USD" label is more specific than a ₪ sign.
 */
export function documentCurrency(candidates: readonly FieldCandidate[]): CurrencyContext {
  const fromField = weightedTop(
    candidates.filter((c) => c.field === 'currency' && c.normalized.kind === 'currency'),
    (c) => (c.normalized.kind === 'currency' ? c.normalized.code : null),
  )
  const amountCodes = (c: FieldCandidate) => (c.normalized.kind === 'money' ? c.normalized.currency : null)
  const amounts = candidates.filter((c) => MAIN_AMOUNTS.has(c.field))
  const fromAmounts = weightedTop(amounts, amountCodes)
  const main = fromField ?? fromAmounts
  const others = [
    ...new Set(
      amounts
        .map(amountCodes)
        .filter((x): x is string => !!x)
        .map((x) => x.toUpperCase())
        .filter((x) => x !== main),
    ),
  ]
  return { main, source: fromField ? 'field' : fromAmounts ? 'amounts' : null, others }
}

function weightedTop(list: readonly FieldCandidate[], codeOf: (c: FieldCandidate) => string | null): string | null {
  const weight = new Map<string, number>()
  for (const c of list) {
    const code = codeOf(c)?.toUpperCase()
    if (code) weight.set(code, (weight.get(code) ?? 0) + clamp01(c.score))
  }
  let best: string | null = null
  let bestW = 0
  for (const [code, w] of weight) {
    if (w > bestW || (w === bestW && best !== null && code < best)) {
      best = code
      bestW = w
    }
  }
  return best
}

/** The same words, or the same 6+ significant digits, as an identifier candidate. */
function collides(money: FieldCandidate, id: FieldCandidate): boolean {
  if (overlaps(new Set(wordIdsOf(money.evidence)), new Set(wordIdsOf(id.evidence)))) return true
  const m = significantDigits(money.rawValue)
  const i = significantDigits(id.normalized.kind === 'id' || id.normalized.kind === 'text' ? id.normalized.value : id.rawValue)
  if (m.length < 6 || i.length < 6) return false
  if (m === i) return true
  // "5551234" read off "03-5551234": the amount is the tail of the identifier.
  return m.length >= 7 && i.endsWith(m)
}

/** Digits without leading zeros and without a trailing ".00"-style fraction of zeros. */
function significantDigits(raw: string): string {
  const noZeroFraction = raw.replace(/[.,]0{1,2}(?!\d)/, '')
  return noZeroFraction.replace(/\D/g, '').replace(/^0+/, '')
}

/** 7+ bare digits, or a phone shape: printed amounts have separators or decimals at that size. */
export function looksLikeIdentifier(raw: string): boolean {
  const t = raw.replace(/[₪$€£¥]|ש"ח|ש״ח|NIS|ILS|USD|EUR/gi, '').trim()
  if (/^\d{7,}$/.test(t)) return true
  if (/^0\d{1,2}-\d{7}$/.test(t) || /^05\d-?\d{7}$/.test(t)) return true
  return /^\+\d{1,3}[-\s]?\d{1,3}[-\s]?\d{3}[-\s]?\d{3,4}$/.test(t)
}
