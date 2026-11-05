import { cleanText } from '../../lib/text'

/**
 * Payment terms by shape alone: "שוטף + 30", "Net 60", "30 jours fin de mois", "Pago a 60 días",
 * "Due on receipt", "מזומן". Several of these are also lexicon phrases ("due on" is a due-date
 * label), so pairing needs the shape to know that under a terms label they are the value.
 */
const TERMS_SHAPES = [
  /^שוטף(?:\s*\+\s*\d{1,3})?(?:\s*יום|\s*ימים)?$/u,
  /^(?:net|netto|נטו)\s*\+?\s*\d{1,3}(?:\s*days?)?$/iu,
  /^(?:\p{L}+\s+){0,3}\d{1,3}\s*(?:days?|ימים|יום|tage[n]?|jours?|días|dias|giorni|dagen)(?:\s+\p{L}+){0,4}$/iu,
  /^(?:due on receipt|payable on receipt|due upon receipt|immediate(?:ly)?|sofort(?:\s+zahlbar)?|à réception|al contado|מזומן|במזומן|מיידי|תשלום מיידי)$/iu,
]

export function looksLikeTerms(text: string): boolean {
  const t = cleanText(text)
  return t.length <= 50 && TERMS_SHAPES.some((re) => re.test(t))
}
