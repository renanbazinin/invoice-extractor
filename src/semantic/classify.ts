import { cleanText } from '../lib/text'
import { getConcept } from './concepts'
import { findCurrencies } from './currency'
import { parseDate, type DateHints } from './dates'
import { looksLikeIdentifier, parseEmail, parseIban, parseIsraeliBankAccount, parsePhone, parseTaxId } from './ids'
import { parseAmount, parsePercent, parseQuantity } from './numbers'
import type { NumberFormat, Span, ValueKind } from './types'

/**
 * What a piece of text could be, ranked. Interpretation uses it to pair a label with a plausible
 * value: the label's concept says what it expects ("טל'" expects a phone), and a reading that fits
 * the expectation is lifted while unrelated numeric readings are pushed down, so "03-1234567"
 * after "טל'" is a phone and never an amount, and "18%" is a percent and never an amount.
 */

export interface ValueGuess {
  kind: ValueKind
  /** 0..1, comparable across kinds of the same text. */
  score: number
  /** The normalized value for this reading (decimal, ISO date, digits, code, ...). */
  value: string
  /** The reading covers the whole text (apart from punctuation). */
  whole: boolean
}

export interface ValueContext {
  /** The lexicon concept of the label in front of the value. */
  concept?: string
  /** Explicit expectations; overrides the concept's. */
  expect?: readonly ValueKind[]
  numberFormat?: NumberFormat
  dateHints?: DateHints
}

/** The value kinds a concept's label is followed by (empty for an unknown concept). */
export function expectedKinds(conceptId: string): readonly ValueKind[] {
  return getConcept(conceptId)?.values ?? []
}

const NUMERIC: ReadonlySet<ValueKind> = new Set(['amount', 'quantity', 'percent', 'date', 'phone', 'id', 'tax_id', 'iban', 'bank_account'])

function covers(text: string, span: Span | null): boolean {
  if (!span) return false
  const rest = text.slice(0, span.start) + text.slice(span.end)
  return !/[\p{L}\p{N}]/u.test(rest)
}

function rawGuesses(text: string, ctx: ValueContext): ValueGuess[] {
  const out: ValueGuess[] = []
  const add = (kind: ValueKind, score: number, value: string, whole: boolean): void => {
    out.push({ kind, score: whole ? score : score * 0.45, value, whole })
  }
  const email = parseEmail(text)
  if (email) add('email', 0.98, email.value, covers(text, email))
  const iban = parseIban(text)
  if (iban) add('iban', iban.checksum ? 0.97 : 0.5, iban.value, covers(text, iban))
  const date = parseDate(text, ctx.dateHints)
  if (date) add('date', date.ambiguous ? 0.8 : 0.92, date.iso, covers(text, date))
  const percent = parsePercent(text)
  if (percent) add('percent', 0.9, percent.value, covers(text, percent))
  const phone = parsePhone(text)
  if (phone) {
    const formatted = /[\s().-]/.test(phone.raw) || phone.kind === 'star' || phone.kind === 'intl'
    add('phone', formatted ? 0.85 : 0.6, phone.value, covers(text, phone))
  }
  const bank = parseIsraeliBankAccount(text)
  if (bank) add('bank_account', /\p{L}/u.test(bank.raw) ? 0.85 : 0.6, bank.value, covers(text, bank))
  const tax = parseTaxId(text)
  if (tax) {
    const base = tax.checksum === false ? 0.2 : tax.scheme === 'IL' ? 0.65 : tax.checksum ? 0.9 : 0.6
    add('tax_id', base, tax.value, covers(text, tax))
  }
  const amount = parseAmount(text, ctx.numberFormat)
  if (amount) {
    let s = amount.decimals === 2 ? 0.85 : amount.decimals ? 0.6 : 0.5
    if (amount.currency) s += 0.08
    if (amount.ambiguous) s -= 0.1
    add('amount', s, amount.amount, true)
  }
  const qty = parseQuantity(text, ctx.numberFormat)
  if (qty) add('quantity', qty.unit ? 0.5 : 0.35, qty.value, true)
  const currencies = findCurrencies(text)
  if (currencies.length && !/\p{N}/u.test(text)) add('currency', 0.9, currencies[0].code, covers(text, currencies[0]))
  if (looksLikeIdentifier(text)) {
    const t = cleanText(text)
    const digits = (t.match(/\d/g) ?? []).length
    const s = /\p{L}/u.test(t) ? 0.7 : digits >= 4 ? 0.6 : 0.35
    add('id', s, t.replace(/^[#№:]+\s*/, ''), true)
  }
  const t = cleanText(text)
  const letters = (t.match(/\p{L}/gu) ?? []).length
  const nonSpace = t.replace(/\s/g, '').length || 1
  if (letters) add('text', 0.2 + 0.6 * (letters / nonSpace) + (/\d/.test(t) ? 0 : 0.1), t, true)
  return out
}

/**
 * Ranked readings of a value text: amount, date, percent, id, tax_id, phone, email, iban,
 * bank_account, currency, quantity, text. With a context (the label's concept or explicit
 * expectations), expected kinds are boosted and other numeric kinds halved; a text that reads as
 * a phone under a phone label loses its amount reading almost entirely.
 */
export function classifyValue(text: string, ctx: ValueContext = {}): ValueGuess[] {
  const guesses = rawGuesses(text, ctx)
  const expected = ctx.expect ?? (ctx.concept ? expectedKinds(ctx.concept) : [])
  if (expected.length) {
    const hasExpected = guesses.some((g) => expected.includes(g.kind))
    for (const g of guesses) {
      const i = expected.indexOf(g.kind)
      if (i >= 0) g.score = Math.min(1, g.score * 1.25 + 0.1 - 0.03 * i)
      else if (g.kind === 'id' && expected.includes('tax_id')) g.score = Math.min(1, g.score * 1.1)
      else if (NUMERIC.has(g.kind) && hasExpected) g.score *= 0.5
    }
    if (expected.includes('phone') && guesses.some((g) => g.kind === 'phone')) {
      for (const g of guesses) if (g.kind === 'amount' || g.kind === 'quantity') g.score *= 0.2
    }
  }
  return guesses
    .map((g) => ({ ...g, score: Math.round(g.score * 1000) / 1000 }))
    .filter((g) => g.score >= 0.05)
    .sort((a, b) => b.score - a.score)
}
