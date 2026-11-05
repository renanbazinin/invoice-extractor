/**
 * Hebrew abbreviation marks as OCR misreads them.
 *
 * Hebrew abbreviations carry a gershayim (סה"כ, מע"מ, ח"פ) or a geresh (מס', טל', רח'), small
 * raised strokes that tesseract confuses with a yod or with quote marks: "סהייכ", "סה'יכ",
 * 'סה""כ' for סה"כ, "מסי" for מס'. Noise also turns a letter of these short words into a similar
 * one (ע read as צ: "בצ"מ"; ס as ז: "זה"כ"). Labels are matched by text downstream, so an
 * unrecognized "סהייכ" is a lost total.
 *
 * Only words that turn into a known abbreviation are rewritten, and only when the misread form
 * is not itself a word: the repair uses a closed list of the abbreviations invoices use, and the
 * few geresh forms whose misreading is a common word or name (טלי, עמי, גבי) need the context of
 * a label (a colon, or a number after them).
 */

/** Abbreviations written with gershayim, as letters before and after the mark. */
const GERSHAYIM = [
  'סה"כ', 'מע"מ', 'בע"מ', 'ח"פ', 'ע"מ', 'ש"ח', 'דוא"ל', 'מק"ט', 'ת"ז', 'ד"ר', 'עו"ד', 'רו"ח', 'מנכ"ל', 'סמנכ"ל',
  'ק"ג', 'מ"ר', 'מ"ק', 'ס"מ', 'מ"מ', 'ק"מ', 'מ"ל', 'קוט"ש', 'קו"ש', 'ת"ד', 'ע"י', 'ע"ר', 'חל"צ', 'מס"ב', 'אג"ח',
  'כנ"ל', 'הנ"ל', 'ת"א', 'פ"ת', 'ר"ג', 'ב"ש', 'ראשל"צ', 'מ"א', 'יח"ל', 'בס"ד', 'שו"ת', 'ז"א', 'וכו"',
  // Not invoice labels, but words a misread letter must not turn into one (דו"ח is not רו"ח).
  'דו"ח', 'ע"ח', 'ח"כ', 'ב"ה', 'ר"ח', 'ע"ש', 'נ"ב', 'ז"ל',
]
/** Abbreviations written with a geresh at the end (or inside: צ'ק). */
const GERESH = ["מס'", "רח'", "יח'", "ליח'", "קומפ'", "שד'", "סנ'", "חש'", "מח'", "אג'", "פקס'", "צ'ק", "טל'", "עמ'", "גב'"]
/** Geresh abbreviations whose misreading with a final yod is also a common word or name. */
const AMBIGUOUS_GERESH = new Set(["טל'", "עמ'", "גב'"])

const PREFIX = /^([ובלהמש]?)(.*)$/u
const gershayimSet = new Set(GERSHAYIM)
const gereshSet = new Set(GERESH)

/** What OCR makes of a gershayim between two Hebrew letters. */
const GERSHAYIM_MISREAD = /(?<=[א-ת])(?:יי|'י|י'|''|""|'"|"'|'"'|"''|''"|״|”|“|'י'|"י|י")(?=[א-ת])/u
/** A geresh misread as a final yod (מסי) or doubled (מס''). */
const FINAL_GERESH_MISREAD = /(?:י|'')$/u

/**
 * The abbreviation an OCR'd word stands for, or the word unchanged. `labelContext` says the word
 * is followed by a colon or a number (as a label is), which licenses the ambiguous geresh forms.
 */
export function normalizeAbbreviation(word: string, labelContext = false): string {
  // Keep punctuation around the word as it is ("סהייכ:" → 'סה"כ:').
  const m = /^([("'״]*)(.*?)([:.,;)]*)$/u.exec(word)
  if (!m || !/[א-ת]/u.test(m[2])) return word
  const [, lead, core, trail] = m
  const fixed = fixCore(core, labelContext || trail.startsWith(':'))
  return fixed === null ? word : lead + fixed + trail
}

function fixCore(core: string, labelContext: boolean): string | null {
  const [, prefix, rest] = PREFIX.exec(core)!
  for (const [p, body] of prefix ? [['', core], [prefix, rest]] : [['', core]]) {
    // Already an abbreviation as written.
    if (gershayimSet.has(body) || gereshSet.has(body)) return null
    const g = gershayimFix(body)
    if (g) return p + g
    const r = gereshFix(body, labelContext)
    if (r) return p + r
  }
  return null
}

function gershayimFix(body: string): string | null {
  const candidate = GERSHAYIM_MISREAD.test(body) ? body.replace(GERSHAYIM_MISREAD, '"') : body
  if (!candidate.includes('"')) return null
  if (candidate !== body && gershayimSet.has(candidate)) return candidate
  // A misread letter on top of a mark read as yods is one guess too many (חייב is not ח"כ).
  return /['"״׳]/u.test(body) ? confusable(candidate) : null
}

/** Letters a noisy scan turns into others (ע read as צ, ס as ז, כ as ב, ד/ר, ה/ח). */
const CONFUSED: Record<string, string> = { צ: 'ע', ז: 'ס', ב: 'כ', ד: 'ר', ר: 'ד', ה: 'ח', ח: 'ה' }

/**
 * The one gershayim abbreviation a single misread letter away from `word` ("בצ"מ" → בע"מ,
 * "זה"כ" → סה"כ), or null when there is none or more than one.
 */
function confusable(word: string): string | null {
  const chars = [...word]
  const found = new Set<string>()
  chars.forEach((ch, i) => {
    const to = CONFUSED[ch]
    if (!to) return
    const v = [...chars.slice(0, i), to, ...chars.slice(i + 1)].join('')
    if (gershayimSet.has(v)) found.add(v)
  })
  return found.size === 1 ? [...found][0] : null
}

function gereshFix(body: string, labelContext: boolean): string | null {
  if (!FINAL_GERESH_MISREAD.test(body)) {
    // צ'ק misread as ציק.
    const inner = body.replace(/^(\p{L})י(\p{L})$/u, "$1'$2")
    return inner !== body && gereshSet.has(inner) && !AMBIGUOUS_GERESH.has(inner) ? inner : null
  }
  const candidate = body.replace(FINAL_GERESH_MISREAD, "'")
  if (!gereshSet.has(candidate)) return null
  if (AMBIGUOUS_GERESH.has(candidate) && !labelContext) return null
  return candidate
}

/**
 * Normalizes the abbreviations of a sequence of OCR words (one text line in tesseract's logical
 * order), giving each word the label context of its successor.
 */
export function normalizeAbbreviations(words: readonly string[]): string[] {
  return words.map((w, i) => normalizeAbbreviation(w, /^\d/u.test(words[i + 1] ?? '')))
}
