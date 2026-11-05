import { cleanText } from '../../lib/text'
import type { CanonicalField } from '../../model/types'
import { getConcept, parsePercent, type LabelMatch, type PercentParse } from '../../semantic'
import { matchLabelsPlus as matchLabels } from '../../structure/keyValues/lexicon'
import { ocrRepair } from '../../structure/keyValues/labels'

/**
 * What a printed label means: the lexicon concepts it names, and how cleanly. A label is exact
 * when every word of it belongs to phrases naming the same thing ("סה"כ לפני מע"מ / Net Amount",
 * "מע"מ (18%)"); words of other concepts or unknown words make it a description of something
 * else ("תשלום עבור חשבונית מס'" names a paid invoice, not this one).
 */
export interface LabelSense {
  text: string
  /** Every lexicon match, best first. */
  matches: LabelMatch[]
  /** The match the label is about (the longest, field-like ones first), or null. */
  primary: LabelMatch | null
  /** Concepts the label can name, best first: the primary, its `also`, compatible matches. */
  concepts: string[]
  /** Letter-words outside the primary's family of phrases (filler words excepted). */
  extraWords: number
  /** Extra words printed before the primary phrase ("בגין חשבונית", "Total in ILS" has none). */
  extraBefore: number
  exact: boolean
  strong: boolean
  /** A rate printed inside the label ("מע"מ (18%)", "Tax 8.875%"). */
  percent: PercentParse | null
}

const FILLER = new Set([
  'פרטי', 'פרטים', 'של', 'details', 'detail', 'info', 'information', 'the', 'of', 'de', 'du', 'des', 'der', 'die', 'das',
  'del', 'la', 'le', 'el', 'a', 'à', 'our', 'your', 'su', 'votre', 'notre', 'ihre', 'unser', 'in', 'en',
  // Deduction words in front of a payment or credit ("Less: deposit received", "בניכוי מקדמה").
  'less', 'minus', 'בניכוי', 'abzüglich', 'moins', 'menos',
])
const CURRENCY_WORD = /^(?:ש"ח|ש״ח|בש"ח|בש״ח|nis|ils|usd|eur|gbp|chf|₪|\$|€|£)$/i

/** Tax phrases qualify a sum when they come after it ("סה"כ לפני מע"מ"). */
const TAX = new Set(['tax', 'tax_amount', 'tax_rate'])
const MONEY = new Set(['subtotal', 'discount', 'tax', 'tax_amount', 'tax_rate', 'total', 'total_due', 'amount_paid', 'amount_due', 'rounding'])

/**
 * Concepts of the same family: their phrases may share one label ("מס' חשבונית / Invoice No.",
 * "סכום לתשלום / Total"). Money labels are one family: a bilingual totals label may name the
 * figure differently in each language, and arithmetic tells the readings apart.
 */
function family(c: string): string {
  if (MONEY.has(c)) return 'money'
  const spec = getConcept(c)
  if (!spec) return c
  if (spec.kind === 'party_attr' || spec.kind === 'role') return c.split('.')[0] + ':' + spec.fields.join(',')
  return spec.fields.length ? [...spec.fields].sort().join(',') : c
}

/** Number-sign words ("מס'", "No.", "Nr.", "#"). */
const NUMBER_SIGN = /^(?:מס['׳"]?|מספר|no\.?|nr\.?|n[°º]\.?|#|num\.?|number|nummer|núm\.?|numéro|numero)$/i

/**
 * "מס' חשבון תקופתי", "Rechnung Nr.": a document title with a number sign names the document's
 * own number, whatever the type is called (the lexicon lists the common ones; this covers the rest).
 */
function titleNumberSense(text: string, matches: readonly LabelMatch[]): LabelMatch | null {
  const doc = matches.find((m) => m.kind === 'doctype')
  if (!doc) return null
  const rest = wordsOf(text).filter((w) => !(doc.start < w.end && w.start < doc.end))
  if (!rest.length || !rest.every((w) => NUMBER_SIGN.test(w.w) || NUMBER_SIGN.test(w.w + "'"))) return null
  const spec = getConcept('invoice_number')!
  return { ...doc, concept: spec.id, kind: spec.kind, fields: spec.fields, also: [], strength: 'strong', exact: true, start: 0, end: text.length }
}

/**
 * Hebrew construct state: "הנחת מסמך", "יתרת חוב", "תעודת משלוח" end the head noun in ת where the
 * lexicon lists it with ה. Tried only when the label matched nothing as printed.
 */
function constructVariant(text: string): string | null {
  const v = text.replace(/(?<=[א-ת]{2})ת(?=\s|$)/u, 'ה')
  return v !== text ? v : null
}

function wordsOf(text: string): { w: string; start: number; end: number }[] {
  const out: { w: string; start: number; end: number }[] = []
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0].replace(/^[^\p{L}]+|[^\p{L}"'׳״.]+$/gu, '')
    if (/\p{L}/u.test(w)) out.push({ w, start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * Rank of a match as the subject of a label: strong field phrases first, then other strong
 * phrases, then weak ones ("EIN #" is a tax id, not a weak "#" number), document types and
 * columns last.
 */
function kindRank(m: LabelMatch): number {
  const weak = m.strength === 'weak' ? 2 : 0
  switch (m.kind) {
    case 'field':
      return weak
    case 'party_attr':
    case 'role':
    case 'trap':
    case 'other':
      return 1 + weak
    case 'doctype':
      return 4
    default:
      return 5
  }
}

export function senseOf(rawLabel: string): LabelSense {
  const text = cleanText(rawLabel).replace(/[\s:：]+$/u, '')
  let matches = matchLabels(text)
  let construct = false
  // OCR'd abbreviation marks ("סהייכ", "חייפ"): the repaired text keeps every offset.
  if (!matches.length && ocrRepair(text) !== text) matches = matchLabels(ocrRepair(text))
  if (!matches.length) {
    const v = constructVariant(text)
    if (v) {
      matches = matchLabels(v)
      construct = matches.length > 0
    }
  }
  const titled = titleNumberSense(text, matches)
  if (titled) matches = [titled, ...matches.filter((m) => m.end <= titled.start || m.start >= titled.end)]
  const usable = matches.filter((m) => m.kind !== 'column' || m.also.some((c) => !c.startsWith('col.')))
  // A column phrase that also names a field ("Amount" is a column and a total) reads as the field.
  const promoted = usable.map((m) => {
    if (m.kind !== 'column') return m
    const field = m.also.find((c) => !c.startsWith('col.'))!
    const spec = getConcept(field)!
    return { ...m, concept: field, kind: spec.kind, fields: spec.fields, also: m.also.filter((c) => c !== field) }
  })
  // The label is about its field phrase when it has one ("סה"כ חשבון נוכחי" is a total, whatever
  // "חשבון" means elsewhere); among equals, the longest phrase.
  let primary =
    [...promoted].sort((a, b) => kindRank(a) - kindRank(b) || b.end - b.start - b.prefix.length - (a.end - a.start - a.prefix.length) || a.start - b.start)[0] ?? null
  // A field phrase that opens the label is its head over a later non-field phrase ("סה"כ חיוב
  // לתקופה" is a total, "לתקופה" only qualifies it); traps keep their veto.
  const opens = (m: LabelMatch) => !/[\p{L}\p{N}]/u.test(text.slice(0, m.start))
  if (primary && primary.kind !== 'field' && primary.kind !== 'trap' && !opens(primary)) {
    const lead = promoted.find((m) => m.kind === 'field' && opens(m))
    if (lead) primary = lead
  }
  // A tax phrase after a sum phrase qualifies it
  // ("סה"כ חיובים לפני מע"מ" is a sum before tax, not a tax).
  if (primary && TAX.has(primary.concept)) {
    const lead = promoted.find((m) => m !== primary && MONEY.has(m.concept) && !/[\p{L}\p{N}]/u.test(text.slice(0, m.start)))
    if (lead && /[\p{L}\p{N}]/u.test(text.slice(0, primary.start))) primary = lead
  }
  const fam = primary ? family(primary.concept) : null
  const covering = primary ? promoted.filter((m) => m === primary || family(m.concept) === fam || primary.also.includes(m.concept)) : []
  let extra = 0
  let before = 0
  for (const w of wordsOf(text)) {
    if (covering.some((m) => m.start < w.end && w.start < m.end)) continue
    const folded = w.w.toLowerCase().replace(/[."'׳״]/g, '')
    if (FILLER.has(folded) || CURRENCY_WORD.test(w.w)) continue
    extra++
    if (primary && w.end <= primary.start) before++
  }
  const concepts: string[] = []
  // Another phrase of the family is another reading only in a bilingual label ("סכום לתשלום /
  // Total"); in one language it qualifies the head ("סה"כ חיובים לפני מע"מ" is not a tax).
  const bilingual = /[א-ת]/.test(text) && /[a-z]{2}/i.test(text)
  if (primary) {
    concepts.push(primary.concept, ...primary.also)
    if (bilingual) for (const m of covering) if (!concepts.includes(m.concept)) concepts.push(m.concept)
  }
  return {
    text,
    matches,
    primary,
    concepts: concepts.filter((c) => !c.startsWith('col.')),
    // A construct-state reading is a guess at the printed word: never exact.
    extraWords: extra + (construct ? 1 : 0),
    extraBefore: before,
    exact: !!primary && extra === 0 && !construct,
    strong: !!primary && covering.some((m) => m.strength === 'strong'),
    percent: parsePercent(text),
  }
}

/** Canonical fields a concept names. */
export function fieldsOf(concept: string): readonly CanonicalField[] {
  return getConcept(concept)?.fields ?? []
}

/** Whether the label (any match) belongs to one of these concepts. */
export function mentions(sense: LabelSense, ...concepts: string[]): boolean {
  return sense.matches.some((m) => concepts.includes(m.concept) || m.also.some((a) => concepts.includes(a)))
}
