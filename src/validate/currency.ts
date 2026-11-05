import { findCurrencies } from '../semantic'

/**
 * Currency signs that several currencies share: "$" (USD, AUD, CAD, NZD, SGD, HKD, MXN …), "kr"
 * (SEK, NOK, DKK, ISK), "¥" (JPY, CNY), "Fr" (CHF and the CFA francs), and the bare words for them.
 * A reading built only on one of these is the parser's default, not evidence: an Australian
 * invoice prints "$" too. An ISO code (AUD, USD), a prefixed sign (A$, US$) or a sign that belongs
 * to one currency (₪, €, £, ש"ח) can confirm a currency; these cannot.
 *
 * Kept locally until the semantic layer exports its own ambiguity flag (requested).
 */
const FAMILIES: { sign: RegExp; codes: readonly string[] }[] = [
  { sign: /^(\$|dollars?|ב?דולר(ים)?)$/i, codes: ['USD', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD', 'MXN', 'ARS', 'CLP', 'COP', 'TWD', 'FJD', 'JMD', 'TTD', 'BSD', 'BBD', 'LRD', 'NAD'] },
  { sign: /^(kr\.?|kroner?|kronor|krónur)$/i, codes: ['SEK', 'NOK', 'DKK', 'ISK'] },
  { sign: /^(¥|yen|yuan)$/i, codes: ['JPY', 'CNY'] },
  { sign: /^(fr\.?|francs?)$/i, codes: ['CHF', 'XOF', 'XAF', 'XPF'] },
]

function familyOf(raw: string): readonly string[] | null {
  const t = raw.trim()
  return FAMILIES.find((f) => f.sign.test(t))?.codes ?? null
}

/** Whether a printed currency mention is one of the shared signs. */
export function isAmbiguousCurrencyMark(raw: string): boolean {
  return familyOf(raw) !== null
}

/**
 * True when the texts mention a currency only through shared signs (at least one mention, none
 * unambiguous). A text with no currency mention at all says nothing either way.
 */
export function ambiguousCurrencyOnly(texts: readonly string[]): boolean {
  let any = false
  for (const t of texts) {
    for (const m of findCurrencies(t)) {
      any = true
      if (!isAmbiguousCurrencyMark(m.raw)) return false
    }
    // "kr" is not parsed as a currency at all; a bare "kr" next to an amount is still a mention.
    if (/(?<!\p{L})kr\.?(?!\p{L})/iu.test(t)) any = true
  }
  return any
}

export interface SignResolution {
  /** The page names `code` unambiguously (an ISO code, a prefixed sign) and no other currency the sign could be. */
  confirmed: boolean
  /** Other currencies of the sign's family that the page names unambiguously (AUD on a "$" invoice read as USD). */
  rivals: string[]
}

/**
 * Settles a shared sign with the rest of the page: "$" on an invoice that also prints "USD"
 * somewhere ("All amounts in USD") is USD; on one that prints "AUD" it is not USD.
 */
export function resolveSign(code: string, lines: readonly string[]): SignResolution {
  const family = FAMILIES.find((f) => f.codes.includes(code))?.codes ?? [code]
  const named = new Set<string>()
  for (const l of lines) {
    for (const m of findCurrencies(l)) {
      if (!isAmbiguousCurrencyMark(m.raw) && family.includes(m.code)) named.add(m.code)
    }
  }
  const rivals = [...named].filter((c) => c !== code)
  return { confirmed: named.has(code) && !rivals.length, rivals }
}
