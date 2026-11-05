import { foldForMatch } from '../lib/text'
import { CUES } from './policy'

/**
 * Payment terms are verified by their form ("שוטף + 30", "Net 30", "14 dagen"), so the form must be
 * the WHOLE value, not a pattern found somewhere inside it: "14 dagen. Wij verzoeken u het
 * totaalbedrag vóór 23 oktober 2026" contains a terms pattern but is a sentence that swallowed the
 * next one. A terms value:
 *
 *  - is short (at most 10 words) and starts no second sentence;
 *  - holds no date, year or amount (those are other fields: the due date, a sum);
 *  - is made of clauses (split at , ; and "then") that each say something about paying: a terms
 *    pattern, or a schedule word ("30% מקדמה בחתימה, יתרה שוטף + 30").
 *
 * A qualifier such as "מיום אישור החשבון ע"י המפקח" or "fin de mois" may follow the pattern.
 */

const MAX_WORDS = 10
const MAX_CHARS = 64

/** Words of a payment schedule: an advance, a deposit, the balance, a share of the total. */
const SCHEDULE = /מקדמה|יתרה|יתרת|בחתימה|עם ההזמנה|advance|deposit|balance|upfront|on signing|on order|anzahlung|restbetrag|acompte|solde|anticipo|saldo|aanbetaling|restant|\d+\s*%/

export function wholeTerms(value: string): boolean {
  const v = foldForMatch(value).trim().replace(/^[\s:;,.\-–]+|[\s:;,.\-–]+$/g, '')
  if (!v || v.length > MAX_CHARS || v.split(/\s+/).length > MAX_WORDS) return false
  if (!CUES.terms.some((re) => re.test(v))) return false
  // A new sentence ("14 dagen. Wij verzoeken …").
  if (/[.!?]\s+\p{L}/u.test(v)) return false
  // A date or an amount is another field (due date, total), not part of the terms.
  if (/\d{1,4}[./-]\d{1,2}[./-]\d{2,4}/.test(v) || /\b(19|20)\d{2}\b/.test(v) || /\d[\d,.']*[.,]\d{2}(?!\d)/.test(v)) return false
  return v
    .split(/[,;]|\bthen\b|\bdann\b|\bpuis\b/)
    .map((c) => c.trim())
    .filter(Boolean)
    .every((c) => CUES.terms.some((re) => re.test(c)) || SCHEDULE.test(c))
}
