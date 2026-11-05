import { cleanText } from '../../lib/text'
import { expectedKinds, labelScore, type LabelMatch } from '../../semantic'
import { matchLabelsPlus } from './lexicon'

/**
 * What a piece of text says about itself as a label: which lexicon phrases it holds, whether the
 * phrases make up the whole text (an exact label) and how label-like it looks without the
 * lexicon (a trailing colon, few words, no digits). The structure layer pairs labels with values
 * from this alone; meaning is interpretation's job.
 */
export interface LabelAnalysis {
  text: string
  /** Lexicon matches that can head a label (columns only when they also name a field). */
  matches: LabelMatch[]
  /** The longest relevant match, or null for an unknown label. */
  primary: LabelMatch | null
  /** The whole text is a column header phrase ("סכום", "Description", "שם"). */
  columnOnly: boolean
  /** Letter-words not covered by a lexicon phrase or a filler word. */
  extraWords: number
  /** Every letter-word is covered: "סה"כ לפני מע"מ / Net Amount:", "מע"מ (18%):". */
  exact: boolean
  /** Ends (logical order) with a colon. */
  colon: boolean
  /** Digits outside a percentage, a currency mark or parentheses. */
  digits: boolean
  /** Lexicon-free label likeness (src/semantic labelScore), 0..1. */
  shape: number
  wordCount: number
}

/**
 * Words that frame a label without changing what it names ("פרטי לקוח" is "לקוח", "Bank details"
 * is "Bank", "Date of issue" is the date). They never make a label inexact.
 */
const FILLER = new Set([
  'פרטי', 'פרטים', 'של', 'את', 'details', 'detail', 'info', 'information', 'the', 'of', 'de', 'du', 'des', 'der', 'die',
  'das', 'del', 'la', 'le', 'el', 'en', 'in', 'a', 'à', 'no', 'nr', 'n', 'our', 'your', 'su', 'votre', 'notre', 'ihre', 'unser',
  // Deduction words in front of a payment or credit ("Less: deposit received", "בניכוי מקדמה").
  'less', 'minus', 'בניכוי', 'abzüglich', 'moins', 'menos',
])

const LETTER = /\p{L}/u

/**
 * Hebrew OCR misreadings of the abbreviation marks, rewritten to the same length so offsets into
 * the line stay valid: gershayim read as "יי" ("סהייכ", "חייפ", "דואייל") or "'י" ("מע'ימ"), and a
 * geresh read as a final "י" in a short abbreviation ("מסי", "טלי", "רחי"). Used for label matching
 * only, and only on OCR text (or when the printed text matched nothing).
 */
export function ocrRepair(text: string): string {
  return text
    // The mark stands before the last letter of an abbreviation, which is never a final form
    // (מע"מ, not ...ם), so "קיים" and "עדיין" stay as they are.
    .replace(/(?<=[א-ת])(?:יי|'י|י')(?=[אבגדהוזחטיכלמנסעפצקרשת](?![א-ת]))/gu, "''")
    .replace(/(?<![\p{L}])(מס|טל|רח|עמ|סנ|פל)י(?![\p{L}])/gu, "$1'")
}

/** Splits a text into word tokens with their offsets. */
export function tokensOf(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = []
  for (const m of text.matchAll(/\S+/g)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/** A label match that can start a key/value pair (not a bare column header). */
export function isPairingMatch(m: LabelMatch): boolean {
  if (m.kind !== 'column') return true
  return m.also.some((c) => !c.startsWith('col.'))
}

/** Letters-only words of a token ("מע"מ" yes, "(18%)" no, "₪" no). */
function letterWord(tok: string): string | null {
  const w = tok.replace(/^[^\p{L}]+|[^\p{L}"'׳״.]+$/gu, '')
  return LETTER.test(w) ? w : null
}

const CURRENCY_TOKEN = /^(?:[₪$€£¥]|ש"ח|ש״ח|בש"ח|בש״ח|nis|ils|usd|eur|gbp|chf)$/i

/** A date inside a label: numeric (15/08/2026, 01.09.2026) or with a month name (17 Oct 2026). */
const LABEL_DATE = /(?<!\d)\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})(?!\d)|(?<!\d)\d{1,2}\s+\p{L}{3,9}\.?\s+\d{4}(?!\d)/gu

export function analyzeLabel(raw: string, matches?: LabelMatch[]): LabelAnalysis {
  const text = cleanText(raw)
  const all = matches ?? matchLabelsPlus(text)
  const relevant = all.filter(isPairingMatch)
  const tokens = tokensOf(text)
  let extra = 0
  let words = 0
  for (const t of tokens) {
    const w = letterWord(t.text)
    if (!w) continue
    words++
    const covered = all.some((m) => m.start < t.end && t.start < m.end)
    if (covered) continue
    const folded = w.toLowerCase().replace(/[."'׳״]/g, '')
    if (FILLER.has(folded) || CURRENCY_TOKEN.test(w)) continue
    extra++
  }
  const stripped = text
    .replace(/\(?\s*[-+]?\d+(?:[.,]\d+)?\s*%\s*\)?/g, ' ')
    .replace(/%\s*\d+(?:[.,]\d+)?/g, ' ')
  // A date or a parenthesised reference qualifies a label ("מקדמה ששולמה (14/09/2026)", "Less:
  // deposit received 15/08/2026", "בניכוי מקדמה (קבלה 1187)"); it is not the value.
  const digits = /\d/.test(stripped.replace(/\([^()]*\p{L}[^()]*\)/gu, ' ').replace(LABEL_DATE, ' '))
  const primary = relevant[0] ?? null
  return {
    text,
    matches: relevant,
    primary,
    columnOnly: !primary && all.length > 0 && extra === 0 && !digits,
    extraWords: extra,
    exact: !!primary && extra === 0 && !digits,
    colon: /[:：]\s*$/.test(text),
    digits,
    // A rate inside a label ("הנחת מסמך 3%") does not make it less of a label.
    shape: labelScore(stripped.replace(/\s+/g, ' ').trim()),
    wordCount: words,
  }
}

/**
 * How much a whole line reads as a label with its value elsewhere (grid or below), 0..1.
 * Known exact labels score high; a trailing colon makes an unknown text a label; short unknown
 * texts without digits are only possible labels (the pairing geometry must back them up).
 */
export function labelLineScore(a: LabelAnalysis): number {
  if (!a.wordCount) return 0
  if (a.digits) return 0
  if (a.primary && a.exact) return a.primary.strength === 'strong' ? 0.95 : 0.85
  if (a.columnOnly) return 0.8
  if (a.primary && a.extraWords <= 2 && a.colon) return 0.8
  if (a.colon && a.wordCount <= 6) return 0.75
  // A label opens with its key phrase ("סה"כ חשבון נוכחי", "Total in ILS"); a lexicon word in
  // the middle of a text is a name or prose ("Becker Shipping GmbH").
  const leading = a.matches.some((m) => !/[\p{L}\p{N}]/u.test(a.text.slice(0, m.start)))
  if (leading && a.extraWords <= 2 && a.wordCount <= 5) return 0.55
  // A money phrase opening a longer description of the figure ("שולם במעמד פתיחת הכרטיס"):
  // only a possible label, which an amount on its row must confirm.
  if (leading && a.primary && a.extraWords <= 4 && a.wordCount <= 7 && expectedKinds(a.primary.concept)[0] === 'amount') return 0.45
  if (!a.primary && !a.columnOnly && a.wordCount <= 4 && a.shape >= 0.55) return 0.4
  return 0
}
