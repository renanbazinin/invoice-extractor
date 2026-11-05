import { cleanText } from '../../lib/text'
import type { NumberFormat } from '../../semantic'
import {
  findAmounts,
  findDates,
  looksLikeIdentifier,
  parseAmount,
  parseDate,
  parseEmail,
  parseIban,
  parseIsraeliBankAccount,
  parsePercent,
  parsePhone,
  parseTaxId,
  type AmountParse,
  type TaxIdHint,
} from '../../semantic'

/**
 * Readers that find one value of a kind inside a value text and say where it is (character
 * span), so the candidate's evidence is exactly the words of the value and not its neighbours.
 */

export interface Found<T> {
  value: T
  raw: string
  start: number
  end: number
}

/**
 * The amount of a value text: the whole text when it is one amount, else the best amount in it
 * (with cents or a currency mark; the last one when tied: "סך של ₪ 20,839.86").
 */
export function readMoney(text: string, fmt: NumberFormat): Found<AmountParse> | null {
  const whole = parseAmount(text, fmt)
  if (whole) return { value: whole, raw: whole.raw, start: whole.start, end: whole.end }
  const all = findAmounts(text, fmt)
  if (!all.length) return null
  const quality = (a: AmountParse) => (a.decimals === 2 ? 2 : a.decimals ? 1 : 0) + (a.currency ? 1 : 0)
  let best = all[0]!
  for (const a of all) if (quality(a) >= quality(best)) best = a
  return { value: best, raw: best.raw, start: best.start, end: best.end }
}

export interface DateValue {
  iso: string
  alternatives: string[]
  ambiguous: boolean
  whole: boolean
}

/** The first date of a value text, read with the document's day/month order. */
export function readDate(text: string, order: 'DMY' | 'MDY'): Found<DateValue> | null {
  const d = parseDate(text, { order })
  if (d) return { value: { iso: d.iso, alternatives: d.alternatives, ambiguous: d.ambiguous, whole: d.whole }, raw: d.raw, start: d.start, end: d.end }
  return readDayLast(text, order)
}

/**
 * "אפריל 2025 21", "ביולי 2026 24": a day-month-year date whose day number the reader's bidi
 * ordering moved behind the year (the numbers are separate LTR runs in a Hebrew line). No locale
 * prints month, year, day, so the day is put back in front and the text parsed again; the
 * evidence is the same words.
 */
function readDayLast(text: string, order: 'DMY' | 'MDY'): Found<DateValue> | null {
  const m = /^(\s*)(\S*\p{L}\S*)\s+(\d{4})\s+(?:(\d{1,2}:\d{2}(?::\d{2})?)\s+)?(\d{1,2})(\s*)$/u.exec(text)
  if (!m) return null
  const [, lead, month, year, time, day] = m
  const d = parseDate(`${day} ${month} ${year}${time ? ` ${time}` : ''}`, { order })
  if (!d || !/\p{L}/u.test(d.raw)) return null
  const start = lead!.length
  const end = text.trimEnd().length
  return { value: { iso: d.iso, alternatives: d.alternatives, ambiguous: d.ambiguous, whole: true }, raw: text.slice(start, end), start, end }
}

/** Payment terms by shape (shared with the structure layer, which pairs terms values). */
export { looksLikeTerms } from '../../structure/keyValues/terms'

/** Two dates in one value: a period ("30/12/2025 - 23/2/2026"), not a single date. */
export function isDateRange(text: string, order: 'DMY' | 'MDY'): boolean {
  return findDates(text, { order }).length >= 2
}

export function readPercent(text: string): Found<string> | null {
  const p = parsePercent(text)
  return p ? { value: p.value, raw: p.raw, start: p.start, end: p.end } : null
}

/** Number-sign tokens that can sit between a label and the number ("Nr. 2026-3219", "מס' 7683"). */
const NUMBER_SIGN = /^(?:no\.?|nr\.?|n[°º]\.?|#|num\.?|number|nummer|n\.|מס['׳"]?|מספר|מס)$/i

/**
 * The document-number-like token of a value text: "7683", "2025/9776", "INV-2026-6431" (not a
 * date, not an amount with cents, not a phone number). Leading number signs are skipped.
 */
export function readIdentifier(text: string): Found<string> | null {
  for (const m of text.matchAll(/\S+/g)) {
    const tok = m[0]
    if (NUMBER_SIGN.test(tok) || /^[:#(]+$/.test(tok)) continue
    const core = tok.replace(/^[#:(\[]+/, '').replace(/[)\],.;:]+$/, '')
    if (!core || !/\d/.test(core)) {
      // Words between the label and the number end the search (a sentence, not a value).
      if (/\p{L}{2,}/u.test(tok)) return null
      continue
    }
    if (!looksLikeIdentifier(core)) return null
    const start = m.index + tok.indexOf(core)
    return { value: core, raw: core, start, end: start + core.length }
  }
  return null
}

export interface TaxIdValue {
  value: string
  scheme: string | null
  checksum: boolean | null
}

export function readTaxId(text: string, hint: TaxIdHint = {}): Found<TaxIdValue> | null {
  const p = parseTaxId(text, hint)
  if (!p) return null
  return { value: { value: p.value, scheme: p.scheme, checksum: p.checksum }, raw: p.raw, start: p.start, end: p.end }
}

export function readPhone(text: string): Found<string> | null {
  const p = parsePhone(text)
  return p ? { value: p.value, raw: p.raw, start: p.start, end: p.end } : null
}

export function readEmail(text: string): Found<string> | null {
  const p = parseEmail(text)
  return p ? { value: p.value, raw: p.raw, start: p.start, end: p.end } : null
}

export interface BankValue {
  value: string
  scheme: 'iban' | 'bank-branch-account'
  checksum: boolean | null
}

/** An IBAN (preferred: it is what the field wants when printed), else an Israeli bank-branch-account. */
export function readBankAccount(text: string): Found<BankValue> | null {
  const iban = parseIban(text)
  if (iban && iban.lengthOk) return { value: { value: iban.value, scheme: 'iban', checksum: iban.checksum }, raw: iban.raw, start: iban.start, end: iban.end }
  const prepared = bankWords(text)
  const il = parseIsraeliBankAccount(prepared)
  if (il) return { value: { value: il.value, scheme: 'bank-branch-account', checksum: null }, raw: text.slice(il.start, il.end), start: il.start, end: il.end }
  return null
}

/**
 * Same-length rewrite for the bank-account parser: "הבנק הבינלאומי", "לבנק לאומי", "בבנק 20" name
 * the bank behind a one-letter prefix (the article, to, in), and "בנקאית" (banking, as in "העברה בנקאית") is not the word "bank".
 * Offsets are kept, so the parse still points at the printed characters.
 */
function bankWords(text: string): string {
  return text
    .replace(/(?<!\p{L})[והבלמש]{1,3}(?=בנק(?!\p{L}))/gu, (m) => ' '.repeat(m.length))
    .replace(/בנקא(?:י|ית|יים|יות)(?!\p{L})/gu, (m) => '_'.repeat(m.length))
}

/** Plain text of a value: cleaned, without leading/trailing separators. */
export function readText(text: string): Found<string> | null {
  const t = cleanText(text)
  const m = /^[\s:：\-–—|·•,;]*(.*?)[\s:：\-–—|·•,;]*$/u.exec(t)
  const v = m?.[1] ?? ''
  if (!/[\p{L}\p{N}]/u.test(v)) return null
  const start = t.indexOf(v)
  return { value: v, raw: v, start, end: start + v.length }
}
