import { foldLabel, originalSpan } from './normalize'
import type { DateOrder, Span } from './types'

/**
 * Printed dates → ISO. Numeric dates are day-first (Israel, Europe) unless the caller passes
 * evidence for month-first (inferDateOrder over the document, or an en-US locale); a reading the
 * calendar rejects falls back to the other order. Ambiguous readings (03/04/2026) keep the other
 * valid reading in `alternatives`, so validation can refuse to verify them. Two-digit years are
 * 20xx.
 */

export interface DateParse extends Span {
  iso: string
  /** Other valid readings of the same text (other day/month order). */
  alternatives: string[]
  /** e.g. 'DD/MM/YYYY', 'D MMMM YYYY'. */
  format: string
  order: DateOrder
  /** The other order would also give a valid date. */
  ambiguous: boolean
  /** The date is the whole text (apart from spaces and punctuation). */
  whole: boolean
}

export interface DateHints {
  order?: DateOrder
  /** BCP 47 tag; 'en-US' (and other -US tags) means month-first. */
  locale?: string
}

/** Month names, folded (lower case, no accents, geresh as '), per language; the regex alternation
 *  below is sorted longest first so "אוקטובר" wins over "אוק'". */
const MONTHS: Record<string, number> = {}
const addMonths = (names: string[][]): void =>
  names.forEach((list, i) => list.forEach((n) => (MONTHS[foldLabel(n).text] = i + 1)))

addMonths([
  ['ינואר', "ינו'", 'ינו'],
  ['פברואר', 'פבואר', "פבר'", 'פבר'],
  ['מרץ', 'מרס', "מרץ'"],
  ['אפריל', "אפר'", 'אפר'],
  ['מאי'],
  ['יוני', "יונ'"],
  ['יולי', "יול'"],
  ['אוגוסט', "אוג'", 'אוג'],
  ['ספטמבר', "ספט'", 'ספט'],
  ['אוקטובר', 'אוקטבר', "אוק'", 'אוק'],
  ['נובמבר', "נוב'", 'נוב'],
  ['דצמבר', "דצמ'", 'דצמ'],
])
addMonths([
  ['january', 'jan', 'januar', 'jänner', 'janvier', 'janv', 'enero', 'ene', 'gennaio', 'gen', 'januari', 'janeiro'],
  ['february', 'feb', 'februar', 'feber', 'février', 'févr', 'fevr', 'febrero', 'febbraio', 'februari', 'fevereiro', 'fev'],
  ['march', 'mar', 'märz', 'maerz', 'mär', 'mars', 'marzo', 'maart', 'mrt', 'março'],
  ['april', 'apr', 'avril', 'avr', 'abril', 'abr', 'aprile'],
  ['may', 'mai', 'mayo', 'maggio', 'mag', 'mei', 'maio'],
  ['june', 'jun', 'juni', 'juin', 'junio', 'giugno', 'giu', 'junho'],
  ['july', 'jul', 'juli', 'juillet', 'juil', 'julio', 'luglio', 'lug', 'julho'],
  ['august', 'aug', 'août', 'aout', 'agosto', 'ago', 'augustus'],
  ['september', 'sep', 'sept', 'septembre', 'septiembre', 'setiembre', 'settembre', 'set', 'setembro'],
  ['october', 'oct', 'oktober', 'okt', 'octobre', 'octubre', 'ottobre', 'ott', 'outubro', 'out'],
  ['november', 'nov', 'novembre', 'noviembre', 'novembro'],
  ['december', 'dec', 'dezember', 'dez', 'décembre', 'déc', 'diciembre', 'dic', 'dicembre', 'dezembro'],
])

const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/\./g, '\\.'))
  .join('|')

/** A month name, with an optional Hebrew ב/ל prefix ("באוקטובר") and an abbreviation dot. */
const MONTH = `(?:[בל]-?)?(${MONTH_RE})\\.?`
const DAY = '(\\d{1,2})(?:st|nd|rd|th|er|º|°|o|\\.)?'
const YEAR = '(\\d{4}|\\d{2})'
const GAP = '[\\s\\-./,]*'
const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'

const PATTERNS: { re: RegExp; kind: 'dmy-text' | 'mdy-text' | 'numeric' }[] = [
  { re: new RegExp(`${B}${DAY}${GAP}(?:de\\s+)?${MONTH}${GAP}(?:de\\s+|del\\s+)?${YEAR}${E}`, 'gu'), kind: 'dmy-text' },
  { re: new RegExp(`${B}${MONTH}\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${E}`, 'gu'), kind: 'mdy-text' },
  { re: /(?<![\p{L}\p{N}]|\d[./-])(\d{1,4}) ?([./-]) ?(\d{1,2}) ?\2 ?(\d{1,4})(?![\p{L}\p{N}]|[./-]\d)/gu, kind: 'numeric' },
]

function isValid(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1) return false
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return d <= days[m - 1]
}

function year(text: string): number {
  return text.length === 2 ? 2000 + Number(text) : Number(text)
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function preferredOrder(hints: DateHints | undefined): 'DMY' | 'MDY' {
  if (hints?.order && hints.order !== 'YMD') return hints.order
  if (hints?.locale && /-US$/i.test(hints.locale)) return 'MDY'
  return 'DMY'
}

interface Reading {
  iso: string
  alternatives: string[]
  format: string
  order: DateOrder
  ambiguous: boolean
}

function numericReading(a: string, sep: string, b: string, c: string, hints?: DateHints): Reading | null {
  if (a.length === 4) {
    if (c.length > 2) return null
    const [y, m, d] = [Number(a), Number(b), Number(c)]
    return isValid(y, m, d) ? { iso: iso(y, m, d), alternatives: [], format: `YYYY${sep}MM${sep}DD`, order: 'YMD', ambiguous: false } : null
  }
  if (a.length > 2 || (c.length !== 2 && c.length !== 4)) return null
  const y = year(c)
  const yfmt = c.length === 4 ? 'YYYY' : 'YY'
  const dmy = isValid(y, Number(b), Number(a)) ? iso(y, Number(b), Number(a)) : null
  const mdy = isValid(y, Number(a), Number(b)) ? iso(y, Number(a), Number(b)) : null
  const prefer = preferredOrder(hints)
  const dmyFmt = `DD${sep}MM${sep}${yfmt}`
  const mdyFmt = `MM${sep}DD${sep}${yfmt}`
  const pick = (first: 'DMY' | 'MDY'): Reading | null => {
    const main = first === 'DMY' ? dmy : mdy
    const other = first === 'DMY' ? mdy : dmy
    if (!main) return null
    const alternatives = other && other !== main ? [other] : []
    return { iso: main, alternatives, format: first === 'DMY' ? dmyFmt : mdyFmt, order: first, ambiguous: alternatives.length > 0 }
  }
  return pick(prefer) ?? pick(prefer === 'DMY' ? 'MDY' : 'DMY')
}

function textReading(d: string, monthName: string, y: string, kind: 'dmy-text' | 'mdy-text'): Reading | null {
  const m = MONTHS[monthName]
  const yy = year(y)
  if (!m || !isValid(yy, m, Number(d))) return null
  const format = kind === 'dmy-text' ? `D MMMM ${y.length === 4 ? 'YYYY' : 'YY'}` : 'MMMM D, YYYY'
  return { iso: iso(yy, m, Number(d)), alternatives: [], format, order: kind === 'dmy-text' ? 'DMY' : 'MDY', ambiguous: false }
}

/** All dates in a text, left to right (a numeric date the calendar rejects, like 31/02/2026, is skipped). */
export function findDates(text: string, hints?: DateHints): DateParse[] {
  const v = foldLabel(text)
  const found: (Reading & { from: number; to: number })[] = []
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    for (const m of v.text.matchAll(p.re)) {
      const r =
        p.kind === 'numeric'
          ? numericReading(m[1], m[2], m[3], m[4], hints)
          : p.kind === 'dmy-text'
            ? textReading(m[1], m[2], m[3], p.kind)
            : textReading(m[2], m[1], m[3], p.kind)
      if (r) found.push({ ...r, from: m.index, to: m.index + m[0].length })
    }
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to)
  const out: DateParse[] = []
  let lastEnd = -1
  for (const f of found) {
    if (f.from < lastEnd) continue
    lastEnd = f.to
    const { start, end } = originalSpan(v, f.from, f.to)
    const rest = v.text.slice(0, f.from) + v.text.slice(f.to)
    out.push({
      iso: f.iso,
      alternatives: f.alternatives,
      format: f.format,
      order: f.order,
      ambiguous: f.ambiguous,
      whole: !/[\p{L}\p{N}]/u.test(rest.replace(/\d{1,2}:\d{2}(?::\d{2})?/, '')),
      raw: text.slice(start, end),
      start,
      end,
    })
  }
  return out
}

/**
 * The first date in a text: 31/10/2026, 31.10.26, 31-10-2026, 2026-10-31, 1.11.2026,
 * "31 באוקטובר 2026", "31 בדצמבר, 2026", "Oct 31, 2026", "31-Oct-26", "31. Oktober 2026",
 * "31 de octubre de 2026". A trailing time is allowed. Invalid calendar dates give null.
 */
export function parseDate(text: string, hints?: DateHints): DateParse | null {
  return findDates(text, hints)[0] ?? null
}

export interface DateOrderInference {
  /** 'DMY' when nothing decides (the default for Hebrew and European documents). */
  order: 'DMY' | 'MDY'
  /** 0 with no evidence. */
  confidence: number
  dmyVotes: number
  mdyVotes: number
}

/**
 * Day-first or month-first, from a document's numeric dates: a first component above 12 is a day
 * (DMY), a second component above 12 is a day (MDY). Without such a date the answer is DMY with
 * confidence 0: month-first needs evidence.
 */
export function inferDateOrder(samples: readonly string[]): DateOrderInference {
  let dmy = 0
  let mdy = 0
  const re = /(?<![\p{L}\p{N}]|\d[./-])(\d{1,2}) ?([./-]) ?(\d{1,2}) ?\2 ?(\d{2}|\d{4})(?![\p{L}\p{N}]|[./-]\d)/gu
  for (const s of samples) {
    for (const m of foldLabel(s).text.matchAll(re)) {
      const a = Number(m[1])
      const b = Number(m[3])
      if (a > 12 && b <= 12 && b >= 1) dmy++
      else if (b > 12 && a <= 12 && a >= 1) mdy++
    }
  }
  const total = dmy + mdy
  if (!total) return { order: 'DMY', confidence: 0, dmyVotes: 0, mdyVotes: 0 }
  const order = mdy > dmy ? 'MDY' : 'DMY'
  const support = Math.max(dmy, mdy) / total
  return { order, confidence: Math.round(support * (1 - 1 / (1 + total)) * 100) / 100, dmyVotes: dmy, mdyVotes: mdy }
}
