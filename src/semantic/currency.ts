import { foldValue, originalSpan, type MappedText } from './normalize'
import type { Span } from './types'

/**
 * Currency mentions: symbols, ISO codes, and the words printed next to amounts. ₪ / ש"ח (in every
 * geresh/gershayim spelling, also "בש"ח") / NIS are ILS; a prefixed dollar (US$, A$, C$, NZ$,
 * HK$, S$, R$) names its currency.
 *
 * Some marks are shared by several currencies: "$" (USD, AUD, CAD, NZD, SGD, HKD, MXN, …), "¥"
 * (JPY or CNY), "Fr." (CHF or the CFA francs), "kr" (SEK, NOK, DKK, ISK), a bare "dollars". Such a
 * mention keeps its customary default code (so existing callers keep working) but is flagged
 * `ambiguous` with its `candidates`; `currencyFromLocaleCues` picks among them from what else the
 * document says (ABN/GST/Australia → AUD, a US state and ZIP → USD, …), and validation must not
 * verify a currency read only from an ambiguous mark. "kr" has no customary default, so it is
 * never reported as a currency: it is only blanked out of amounts ("1.234,00 kr" still parses).
 *
 * ISO codes are whole tokens: not glued to a hyphen ("CLP-20" is an article number) and, for
 * codes that are also English words (PEN, TRY, MAD, RUB, …), only next to a number.
 */

interface CurrencyToken {
  source: string
  /** '' for an ambiguous mark without a customary default ("kr"): blanked in amounts, never reported. */
  code: string
  /** Letters must match case exactly (ISO codes: "EUR" is a code, "eur" is not). */
  exactCase: boolean
  /** Other currencies the same mark names; absent when the mark names one currency only. */
  candidates?: readonly string[]
}

const ISO_CODES = [
  'ILS', 'NIS', 'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CNY', 'RMB', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'SEK', 'NOK',
  'DKK', 'ISK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'RSD', 'TRY', 'RUB', 'UAH', 'INR', 'BRL', 'MXN', 'ARS',
  'CLP', 'COP', 'PEN', 'ZAR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'EGP', 'JOD', 'MAD', 'TND', 'KRW', 'THB',
  'TWD', 'PHP', 'IDR', 'MYR', 'VND',
]
const ALIASES: Record<string, string> = { NIS: 'ILS', RMB: 'CNY' }
/** Codes that are also ordinary upper-case words or common article-code fragments. */
const WORDLIKE = new Set(['PEN', 'PHP', 'MAD', 'TRY', 'COP', 'RON', 'RUB', 'SAR', 'ARS', 'CLP', 'TND', 'BHD', 'OMR', 'IDR'])

/** Currencies written with a bare "$". */
export const DOLLAR_CURRENCIES: readonly string[] = ['USD', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'MXN', 'TWD', 'ARS', 'CLP', 'COP']
const DOLLAR_WORD: readonly string[] = ['USD', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'TWD']
const YEN_SIGN: readonly string[] = ['JPY', 'CNY']
const FRANC: readonly string[] = ['CHF', 'XOF', 'XAF', 'XPF']
const KRONA: readonly string[] = ['SEK', 'NOK', 'DKK', 'ISK']

function isoToken(c: string): CurrencyToken {
  const near = WORDLIKE.has(c) ? `(?:(?<=\\d\\s?)${c}|${c}(?=\\s?[-+(]?\\d))` : c
  return { source: `(?<![\\p{L}-])${near}(?![\\p{L}]|-[\\p{L}\\p{N}])`, code: ALIASES[c] ?? c, exactCase: true }
}

const TOKENS: CurrencyToken[] = [
  { source: '(?<!\\p{L})(?:US ?\\$|U\\.S\\. ?\\$)', code: 'USD', exactCase: true },
  { source: '(?<!\\p{L})AU?\\$', code: 'AUD', exactCase: true },
  { source: '(?<!\\p{L})(?:CA?\\$|CAD\\$)', code: 'CAD', exactCase: true },
  { source: '(?<!\\p{L})NZ\\$', code: 'NZD', exactCase: true },
  { source: '(?<!\\p{L})HK\\$', code: 'HKD', exactCase: true },
  { source: '(?<!\\p{L})SG?\\$', code: 'SGD', exactCase: true },
  { source: '(?<!\\p{L})R\\$', code: 'BRL', exactCase: true },
  { source: '(?<!\\p{L})MX\\$', code: 'MXN', exactCase: true },
  { source: '₪', code: 'ILS', exactCase: false },
  { source: `(?<!\\p{L})ב?ש(?:"|'|\\.|)ח\\.?(?!\\p{L})`, code: 'ILS', exactCase: false },
  { source: `(?<!\\p{L})(?:ב?שקלים(?: חדשים)?|ב?שקל(?: חדש)?|ש"ח חדשים|אג'|אגורות)(?!\\p{L})`, code: 'ILS', exactCase: false },
  { source: '(?<!\\p{L})(?:new israeli )?shekels?(?!\\p{L})', code: 'ILS', exactCase: false },
  { source: '\\$', code: 'USD', exactCase: false, candidates: DOLLAR_CURRENCIES },
  { source: `(?<!\\p{L})(?:ב?דולר(?:ים)? (?:ארה"ב|אמריקאי(?:ם)?|ארצות הברית)|(?:us|u\\.s\\.|american) dollars?)(?!\\p{L})`, code: 'USD', exactCase: false },
  { source: `(?<!\\p{L})ב?דולר(?:ים)? אוסטרלי(?:ם)?(?!\\p{L})|(?<!\\p{L})australian dollars?(?!\\p{L})`, code: 'AUD', exactCase: false },
  { source: `(?<!\\p{L})ב?דולר(?:ים)? קנדי(?:ים)?(?!\\p{L})|(?<!\\p{L})canadian dollars?(?!\\p{L})`, code: 'CAD', exactCase: false },
  { source: `(?<!\\p{L})new zealand dollars?(?!\\p{L})`, code: 'NZD', exactCase: false },
  { source: `(?<!\\p{L})singapore dollars?(?!\\p{L})`, code: 'SGD', exactCase: false },
  { source: `(?<!\\p{L})hong kong dollars?(?!\\p{L})`, code: 'HKD', exactCase: false },
  { source: `(?<!\\p{L})(?:ב?דולר(?:ים)?|dollars?)(?!\\p{L})`, code: 'USD', exactCase: false, candidates: DOLLAR_WORD },
  { source: '€', code: 'EUR', exactCase: false },
  { source: '(?<!\\p{L})(?:ב?אירו|ב?יורו|euros?)(?!\\p{L})', code: 'EUR', exactCase: false },
  { source: '£', code: 'GBP', exactCase: false },
  { source: `(?<!\\p{L})(?:ליש"ט|לירות שטרלינג|לירה שטרלינג|pounds? sterling)(?!\\p{L})`, code: 'GBP', exactCase: false },
  { source: '(?<!\\p{L})SFr\\.?(?!\\p{L})', code: 'CHF', exactCase: true },
  { source: '(?<!\\p{L})Fr\\.(?!\\p{L})', code: 'CHF', exactCase: true, candidates: FRANC },
  { source: '(?<!\\p{L})(?:franken|francs? suisses?|swiss francs?)(?!\\p{L})', code: 'CHF', exactCase: false },
  { source: '¥|￥', code: 'JPY', exactCase: false, candidates: YEN_SIGN },
  { source: '円|(?<!\\p{L})yen(?!\\p{L})', code: 'JPY', exactCase: false },
  { source: '元|(?<!\\p{L})yuan(?!\\p{L})', code: 'CNY', exactCase: false },
  { source: '(?<!\\p{L})kr\\.?(?!\\p{L})', code: '', exactCase: false, candidates: KRONA },
  { source: '₹', code: 'INR', exactCase: false },
  { source: '₽', code: 'RUB', exactCase: false },
  { source: '₺', code: 'TRY', exactCase: false },
  { source: '₩', code: 'KRW', exactCase: false },
  { source: '(?<!\\p{L})zł(?!\\p{L})', code: 'PLN', exactCase: false },
  { source: '(?<!\\p{L})Kč(?!\\p{L})', code: 'CZK', exactCase: false },
  ...ISO_CODES.map(isoToken),
]

const COMPILED = TOKENS.map((t) => ({ ...t, re: new RegExp(t.source, t.exactCase ? 'gu' : 'giu') }))

/** A currency mention in prepared (folded) coordinates. */
export interface CurrencyHit {
  /** '' for a mark with no customary default ("kr"). */
  code: string
  from: number
  to: number
  /** The mark is shared by several currencies ("$", "¥", "kr", "Fr."). */
  ambiguous: boolean
  /** The currencies the mark can name, the default first; [code] when unambiguous. */
  candidates: readonly string[]
}

/** Currency mentions in a prepared text, non-overlapping, longest first at a position, in text order. */
export function currencyHits(v: MappedText): CurrencyHit[] {
  const all: CurrencyHit[] = []
  for (const t of COMPILED) {
    t.re.lastIndex = 0
    for (const m of v.text.matchAll(t.re)) {
      if (!m[0]) continue
      all.push({ code: t.code, from: m.index, to: m.index + m[0].length, ambiguous: !!t.candidates, candidates: t.candidates ?? [t.code] })
    }
  }
  all.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from)
  const out: CurrencyHit[] = []
  for (const h of all) if (!out.some((o) => h.from < o.to && o.from < h.to)) out.push(h)
  return out.sort((a, b) => a.from - b.from)
}

export interface CurrencyMention extends Span {
  code: string
  /** The mark is shared by several currencies ("$", "¥", "Fr.", "dollars"): `code` is only the default. */
  ambiguous: boolean
  /** The currencies the mark can name, `code` first; [code] when unambiguous. */
  candidates: readonly string[]
}

/** Every currency mention in a text, in order (marks without a default code, like "kr", are left out). */
export function findCurrencies(text: string): CurrencyMention[] {
  const v = foldValue(text)
  return currencyHits(v)
    .filter((h) => h.code)
    .map((h) => {
      const { start, end } = originalSpan(v, h.from, h.to)
      return { code: h.code, raw: text.slice(start, end), start, end, ambiguous: h.ambiguous, candidates: h.candidates }
    })
}

/**
 * The ISO 4217 code of the first currency mentioned in a text ("₪" → ILS, "ש״ח" → ILS, "US$" →
 * USD), or null. A text that is only a code in lower case ("usd") is accepted too. An ambiguous
 * mark ("$") returns its default; use currencyAmbiguity to know whether it was one.
 */
export function parseCurrency(text: string): string | null {
  const hit = findCurrencies(text)[0]
  if (hit) return hit.code
  const t = text.trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(t) && ISO_CODES.includes(t)) return ALIASES[t] ?? t
  return null
}

/**
 * The candidate currencies of a printed currency mark when it is ambiguous ("$" → USD, AUD, CAD,
 * …; "¥" → JPY, CNY; "kr" → SEK, NOK, DKK, ISK; "Fr." → CHF, XOF, …), or null when the mark names
 * one currency ("US$", "₪", "EUR", "A$") or is no currency mark at all.
 */
export function currencyAmbiguity(raw: string): readonly string[] | null {
  const hits = currencyHits(foldValue(raw.trim()))
  if (!hits.length) return null
  if (hits.some((h) => !h.ambiguous)) return null
  return hits[0].candidates
}

// ---------------------------------------------------------------------------------------------
// Locale cues

interface Cue {
  re: RegExp
  /** Votes per currency. */
  votes: Record<string, number>
}

const cue = (re: RegExp, votes: Record<string, number>): Cue => ({ re, votes })

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'
const CA_PROVINCES = 'AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT'
const AU_STATES = 'NSW|VIC|QLD|TAS|ACT|NT|SA|WA'

/**
 * What a document says about where it was issued: business-number names (ABN, NZBN, UEN, EIN,
 * ח.פ), sales-tax names (GST/HST, מע"מ), postal formats (a US state and ZIP, an Australian state and
 * postcode, a Canadian postal code), country names, dialling codes. Weights favour the specific:
 * "GST" alone is shared by AU, NZ, CA, SG and only tips a balance.
 */
const CUES: Cue[] = [
  // Australia
  cue(/(?<![\p{L}])ABN(?![\p{L}])/gu, { AUD: 3 }),
  cue(/(?<![\p{L}])(?:ACN|ARBN)(?![\p{L}])/gu, { AUD: 2 }),
  cue(/(?<![\p{L}])BSB(?![\p{L}])/gu, { AUD: 3 }),
  cue(/(?<![\p{L}])Pty\.? ?Ltd(?![\p{L}])/giu, { AUD: 2 }),
  cue(/(?<![\p{L}])Australi(?:a|an)(?![\p{L}])/giu, { AUD: 2 }),
  cue(new RegExp(`(?<![\\p{L}])(?:${AU_STATES}) \\d{4}(?![\\d])`, 'gu'), { AUD: 2.5 }),
  cue(/\+61(?!\d)/gu, { AUD: 2 }),
  // Canada
  cue(/(?<![\p{L}])(?:GST\/HST|HST|QST|PST)(?![\p{L}])/gu, { CAD: 2.5 }),
  cue(/(?<![\p{L}])Canad(?:a|ian)(?![\p{L}])/giu, { CAD: 2 }),
  cue(new RegExp(`(?<![\\p{L}])(?:${CA_PROVINCES}) [A-Z]\\d[A-Z] ?\\d[A-Z]\\d(?![\\p{L}\\d])`, 'gu'), { CAD: 3 }),
  cue(/(?<![\p{L}\d])[A-Z]\d[A-Z] \d[A-Z]\d(?![\p{L}\d])/gu, { CAD: 1.5 }),
  cue(/(?<!\d)\d{9} ?RT ?\d{4}(?!\d)/gu, { CAD: 3 }),
  // New Zealand, Singapore, Hong Kong, Mexico
  cue(/(?<![\p{L}])(?:New Zealand|Aotearoa)(?![\p{L}])/giu, { NZD: 2.5 }),
  cue(/(?<![\p{L}])(?:NZBN|IRD)(?![\p{L}])/gu, { NZD: 2.5 }),
  cue(/\+64(?!\d)/gu, { NZD: 2 }),
  cue(/(?<![\p{L}])Singapore(?![\p{L}])/giu, { SGD: 2.5 }),
  cue(/(?<![\p{L}])UEN(?![\p{L}])/gu, { SGD: 2.5 }),
  cue(/\+65(?!\d)/gu, { SGD: 2 }),
  cue(/(?<![\p{L}])Hong Kong(?![\p{L}])/giu, { HKD: 2.5 }),
  cue(/\+852(?!\d)/gu, { HKD: 2 }),
  cue(/(?<![\p{L}])M[eé]xico(?![\p{L}])/giu, { MXN: 2 }),
  cue(/(?<![\p{L}])(?:RFC|CFDI)(?![\p{L}])/gu, { MXN: 2.5 }),
  cue(/(?<![\p{L}])GST(?![\p{L}/])/gu, { AUD: 0.5, NZD: 0.5, SGD: 0.5, CAD: 0.3 }),
  // United States
  cue(new RegExp(`(?<![\\p{L}])(?:${US_STATES}) \\d{5}(?:-\\d{4})?(?![\\d])`, 'gu'), { USD: 3 }),
  cue(/(?<![\p{L}])(?:USA|U\.S\.A\.?|United States(?: of America)?)(?![\p{L}])/gu, { USD: 2 }),
  cue(/(?<![\p{L}])(?:EIN|FEIN)(?![\p{L}])/gu, { USD: 2 }),
  cue(/(?<![\p{L}])(?:sales tax|ACH|ABA|routing)(?![\p{L}])/giu, { USD: 1 }),
  cue(/\+1[\s.-]?\(?[2-9]\d{2}/gu, { USD: 1, CAD: 1 }),
  // Israel
  cue(/(?<![\p{L}])(?:ח["״.]?פ|ע["״.]?מ|עוסק מורשה|מע["״]?מ)(?![\p{L}])/gu, { ILS: 2 }),
  cue(/(?<![\p{L}])(?:Israel|ישראל)(?![\p{L}])/giu, { ILS: 1.5 }),
  cue(/\+972|(?<![\d-])0(?:5\d|[2-489]|7\d)-\d{7}(?!\d)/gu, { ILS: 1.5 }),
  // Yen / yuan
  cue(/(?<![\p{L}])Japan(?:ese)?(?![\p{L}])|日本|株式会社|消費税|〒|\+81(?!\d)/giu, { JPY: 2.5 }),
  cue(/(?<![\p{L}])(?:China|PRC|RMB)(?![\p{L}])|中国|有限公司|增值税|发票|\+86(?!\d)|Unified Social Credit/giu, { CNY: 2.5 }),
  // Kronor / kroner / krónur
  cue(/(?<![\p{L}])(?:Sweden|Sverige)(?![\p{L}])|\+46(?!\d)|Bankgiro|Plusgiro|(?<![\p{L}])SE\d{12}(?!\d)/giu, { SEK: 2.5 }),
  cue(/(?<![\p{L}])(?:Norway|Norge)(?![\p{L}])|\+47(?!\d)|(?<![\p{L}])MVA(?![\p{L}])|Foretaksregisteret/giu, { NOK: 2.5 }),
  cue(/(?<![\p{L}])(?:Denmark|Danmark)(?![\p{L}])|\+45(?!\d)|(?<![\p{L}])CVR(?![\p{L}])/giu, { DKK: 2.5 }),
  cue(/(?<![\p{L}])(?:Iceland|Ísland)(?![\p{L}])|\+354(?!\d)|kennitala/giu, { ISK: 2.5 }),
  // Francs
  cue(/(?<![\p{L}])(?:Switzerland|Schweiz|Suisse|Svizzera)(?![\p{L}])|(?<![\p{L}])CHE[-\s]?\d{3}|(?<![\p{L}])MWST(?![\p{L}])|\+41(?!\d)/giu, { CHF: 2.5 }),
  cue(/S[ée]n[ée]gal|C[ôo]te d['’]Ivoire|Burkina|(?<![\p{L}])Mali(?![\p{L}])|(?<![\p{L}])Togo|B[ée]nin|BCEAO|UEMOA/giu, { XOF: 2.5 }),
  cue(/Cameroun|Cameroon|Gabon|(?<![\p{L}])Tchad|CEMAC|BEAC/giu, { XAF: 2.5 }),
]

export interface LocaleCurrency {
  code: string
  /** Sum of the cue weights for `code`. */
  score: number
  /** The cue texts that voted for it, as printed ("ABN", "TAS 7004"). */
  cues: string[]
  /** No other candidate reached half of `score`, and the score is at least 2 (one specific cue). */
  decisive: boolean
}

/**
 * The currency a document's locale points to, from cues anywhere in its texts (lines or the whole
 * page): ABN/BSB/Australia/an Australian state and postcode → AUD; GST/HST/Canada/a Canadian
 * postal code → CAD; NZ, SG, HK, MX likewise; a US state and ZIP/USA/EIN → USD; ח.פ/מע"מ/+972 →
 * ILS; Japan → JPY, China → CNY; Nordic and Swiss/CFA cues for "kr" and "Fr.". With `candidates`
 * (e.g. the candidates of an ambiguous "$"), only those currencies are considered. Returns null
 * when nothing votes.
 */
export function currencyFromLocaleCues(texts: readonly string[], candidates?: readonly string[]): LocaleCurrency | null {
  const score = new Map<string, number>()
  const cues = new Map<string, string[]>()
  const allowed = candidates ? new Set(candidates) : null
  for (const text of texts) {
    for (const c of CUES) {
      c.re.lastIndex = 0
      const found = [...text.matchAll(c.re)]
      if (!found.length) continue
      for (const [code, w] of Object.entries(c.votes)) {
        if (allowed && !allowed.has(code)) continue
        // A cue repeated on the page (an address printed twice) counts once more at most.
        score.set(code, (score.get(code) ?? 0) + w * Math.min(found.length, 2))
        const list = cues.get(code) ?? []
        for (const m of found) if (!list.includes(m[0]) && list.length < 6) list.push(m[0])
        cues.set(code, list)
      }
    }
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1])
  if (!ranked.length) return null
  const [code, s] = ranked[0]
  const second = ranked[1]?.[1] ?? 0
  return { code, score: Math.round(s * 100) / 100, cues: cues.get(code) ?? [], decisive: s >= 2 && second < s / 2 }
}
