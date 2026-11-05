import { cleanText } from '../../lib/text'
import { findAmounts, parseDate, parseEmail, parsePhone } from '../../semantic'
import { matchLabelsPlus as matchLabels } from '../../structure/keyValues/lexicon'

/**
 * Text shapes of party blocks: which line is an address, which a name. Multilingual street and
 * postal vocabulary only; no names of places or companies.
 */

/** Street/postal words (Hebrew, English, German, French, Spanish, Italian, Dutch, Portuguese). */
const STREET =
  /(?:^|[\s,(])(?:רח['׳]|רחוב|שד['׳]|שדרות|שדרת|דרך|ת\.\s?ד\.?|ת"ד|תא דואר|כיכר|סמטת|סמ['׳]|מיקוד|קומה|אזור תעשייה|א\.ת\.?|street|st\.|road|rd\.?|avenue|ave\.?|blvd\.?|boulevard|lane|ln\.|drive|dr\.|way|suite|floor|p\.?\s?o\.?\s?box|platz|allee|gasse|weg|calle|c\/|avda\.?|avenida|plaza|paseo|carrer|rue|chemin|place|via|viale|piazza|corso|laan|straat|plein|rua|quai|(?:unit|level|bldg\.?|building)(?=\s+\d)|(?:business|industrial|retail|science|technology) (?:park|estate|zone|centre|center)|trading estate|אזור התעשייה|פארק תעשיות)(?=[\s,.\d]|$)/i
/** German compounds carry the street word inside ("Industriestraße"). */
const STREET_INSIDE = /stra(?:ß|ss)e|str\.(?=\s|\d)|gasse\b|weg\b/i
/**
 * A postal code with a word next to it: 5 digits (US/DE/FR/ES/IT), 7 digits (IL), "3581 CV" (NL),
 * UK outward/inward codes, "617 00" (CZ/SK/SE/GR), an Australian state and postcode ("VIC 3000").
 */
const ZIP = /(?:^|[\s,])(?:\d{5}|\d{7}|\d{4}\s?[A-Z]{2}|[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}|\d{3}\s\d{2}|(?:NSW|VIC|QLD|TAS|ACT|SA|WA|NT)\s\d{4})(?=[\s,]|$)/
/** "הגפן 137", "Calle Mayor, 81", "5826 Industrial Way": a street name with a house number. */
const HOUSE = /^[^\d,]{3,30}\s\d{1,4}[א-תa-z]?(?:[,/\s]|$)|^\d{1,5}\s[^\d,]{3,}|,\s?\d{1,4}(?:\s|,|$)/u

export function looksLikeContact(text: string): boolean {
  if (parseEmail(text) || /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:co\.il|org\.il|com|org|net|io|de|fr|es|it|nl|eu|co)\b/i.test(text)) return true
  const p = parsePhone(text)
  return !!p && p.raw.replace(/\D/g, '').length >= 7 && p.raw.length >= text.replace(/[^\d()+\-\s]/g, '').trim().length - 2
}

/** Labels that may lead a segment of a party block without being part of its text. */
function hasLabelHead(text: string): boolean {
  const m = matchLabels(text)[0]
  if (!m || m.start > 1) return false
  if (m.concept === 'party.address') return false
  return m.kind !== 'column' || /[:：]/.test(text.slice(m.end, m.end + 3))
}

/** How much a text reads as (part of) a postal address, 0..1. */
export function addressScore(raw: string): number {
  const text = cleanText(raw)
  if (!/\p{L}/u.test(text) || text.length > 90) return 0
  if (looksLikeContact(text) || hasLabelHead(text)) return 0
  if (/@|:/.test(text)) return 0
  // "עבור חשבונית 77879", "ILS 43,473.68": a document reference or an amount is not an address.
  if (matchLabels(text).some((m) => m.kind === 'doctype' || m.kind === 'field')) return 0
  if (findAmounts(text).some((a) => a.decimals === 2 || a.currency)) return 0
  // "Harbor Lane Logistics Ltd.", "מוסך דרך הבשמים בע"מ": a street word inside a company name.
  if (hasLegalSuffix(text) && !ZIP.test(text) && !/\d{1,4}\s*,/.test(text)) return 0
  // "24 October 2026", "15/08/2026": a date has a number and a word, but is not an address.
  const date = parseDate(text)
  if (date && date.raw.length >= text.replace(/[\s,.]+$/, '').length - 2) return 0
  if (STREET.test(text) || STREET_INSIDE.test(text)) return 0.9
  if (ZIP.test(text) && /\p{L}{2,}/u.test(text)) return 0.75
  if (HOUSE.test(text) && text.split(/\s+/).length <= 7) return 0.65
  return 0
}

/** A short letters-only line after a street line: the city ("ראשון לציון", "בני ברק"). */
export function cityLike(raw: string): boolean {
  const text = cleanText(raw)
  if (!/^[\p{L}\s'"׳״.,()-]+$/u.test(text) || looksLikeContact(text) || /\p{L}\.\p{L}/u.test(text)) return false
  const words = text.split(/\s+/).length
  return words >= 1 && words <= 3 && text.length <= 30 && !hasLabelHead(text)
}

/** Legal-entity suffixes: a name with one is the legal name. */
const LEGAL = /בע["״']?מ|בע״ם|\(ע["״]ר\)|ע["״]ר\b|חל["״]צ|שותפות|ושות['׳]|אגודה שיתופית|\b(?:ltd|limited|inc|llc|llp|plc|pty|pte|gmbh|mbb|ag|kg|kgaa|ohg|ug|sarl|s\.?a\.?r\.?l|sàrl|sas|sasu|eurl|snc|s\.a\.|sa|bv|b\.v\.|nv|n\.v\.|spa|s\.p\.a\.|srl|s\.r\.l\.|s\.r\.o\.|s\.l\.|sl|corp|corporation|co\.)(?![\p{L}])/iu

export function hasLegalSuffix(text: string): boolean {
  return LEGAL.test(text)
}

/** Words that introduce the owner of a trading name, or end the text before a name. */
const OWNER_CUT = /["“”״]|[,:;]\s|(?<![\p{L}])(?:שבבעלות|בבעלות|באמצעות|מופעלת? על ידי|של|הוא|היא|owned by|operated by|trading name of|trading as|is a|by|von|par|de)(?![\p{L}])/giu

/**
 * The legal entity a line names in a sentence that also mentions the trading name ("השם המסחרי
 * "קפה שחור-לבן" הוא בבעלות נ.ע. משקאות ושיווק (2019) בע"מ, ח.פ. …", "Kestrel is a trading name
 * of Kestrel Ridge Pty Ltd"): the words before the legal suffix back to the word that introduces
 * the owner. Returns its span in the text, or null.
 */
export function legalOwner(text: string, tradingName: string): { start: number; end: number } | null {
  const fold = (t: string) => cleanText(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  if (!fold(tradingName) || !fold(text).includes(fold(tradingName))) return null
  const suffix = new RegExp(LEGAL.source, 'giu')
  const more = new RegExp(`^\\s*(?:&\\s*co\\.?\\s*)?(?:${LEGAL.source})`, 'iu')
  for (const m of text.matchAll(suffix)) {
    let end = m.index + m[0].length
    // "Pty Ltd", "GmbH & Co. KG": the suffix may be several words.
    for (let x = more.exec(text.slice(end)); x; x = more.exec(text.slice(end))) end += x[0].length
    const before = text.slice(0, m.index)
    let start = 0
    for (const c of before.matchAll(OWNER_CUT)) start = c.index + c[0].length
    const span = text.slice(start, end).trim()
    if (!span || fold(span) === fold(tradingName) || nameScore(span) === 0) continue
    const s = text.indexOf(span, start)
    return { start: s, end: s + span.length }
  }
  return null
}

/** The text is nothing but a legal suffix ("KG", "Ltd.", "בע"מ"): the tail of a wrapped name. */
export function onlySuffix(text: string): boolean {
  const t = cleanText(text)
  return hasLegalSuffix(t) && !/\p{L}/u.test(t.replace(new RegExp(LEGAL.source, 'giu'), ''))
}

/** Words that open a label or a heading (details of…, name of…), never a party's name. */
const FRAMING = /^(?:פרטי|פרטים|שם|details|name|nom|nombre|naam|nome|angaben|daten)(?:\s|$)/iu

/** A line that can be a party name: words, not an address, a contact line, a label or a sentence. */
export function nameScore(raw: string): number {
  const text = cleanText(raw).replace(/^[:\-–\s]+|[:\-–\s]+$/g, '')
  if (!text || !/\p{L}{2,}/u.test(text)) return 0
  if (looksLikeContact(text) || /[:@]/.test(text)) return 0
  const words = text.split(/\s+/)
  if (words.length > 8 || text.length > 70) return 0
  // "שם האורח", "פרטי האירוע", "Name of guest": a heading or label, never a name.
  if (FRAMING.test(text)) return 0
  // Digits only inside parentheses ("(2008)") or as a short token; ids and amounts are not names.
  const digits = text.replace(/\(\d+\)/g, '').replace(/\D/g, '').length
  if (digits > 2) return hasLegalSuffix(text) ? 0.5 : 0
  if (addressScore(text) >= 0.65) return 0
  const m = matchLabels(text)
  const covered = m.reduce((n, x) => n + (x.end - x.start), 0)
  if (m.length && covered >= text.replace(/\s/g, '').length * 0.6 && !hasLegalSuffix(text)) return 0
  return hasLegalSuffix(text) ? 0.95 : 0.7
}
