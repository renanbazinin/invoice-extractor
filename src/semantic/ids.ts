import { cleanText } from '../lib/text'
import { parseDate } from './dates'
import { foldLabel, foldValue, originalSpan } from './normalize'
import { parsePercent } from './numbers'
import type { Span } from './types'

// ---------------------------------------------------------------------------------------------
// Tax ids

export type TaxIdScheme = 'IL' | 'EU_VAT' | 'GB_VAT' | 'CH_UID' | 'NO_VAT' | 'US_EIN' | 'FR_SIRET' | 'AU_ABN' | 'CN_USCC'

export interface TaxIdParse extends Span {
  /** As printed minus spaces, dashes, dots and slashes, upper case (what ground truth stores). */
  value: string
  /** For comparison: Israeli ids padded to 9 digits ("12345678" → "012345678"). */
  canonical: string
  scheme: TaxIdScheme | null
  country: string | null
  /** true/false when the scheme has a check digit we verify, null otherwise. */
  checksum: boolean | null
}

export interface TaxIdHint {
  scheme?: TaxIdScheme
  /** ISO country of the issuer, when known (e.g. from the label language or address). */
  country?: string
}

const digitsOf = (s: string): number[] => [...s].map(Number)

/**
 * Israeli ids (ח.פ / ע.מ / ת.ז) share one check digit: weights 1,2,1,2,... over the 9 digits
 * (shorter ids are left-padded with zeros), products above 9 replaced by the sum of their digits,
 * total divisible by 10.
 */
export function isValidIsraeliId(id: string): boolean {
  const d = id.replace(/\D/g, '')
  if (!d.length || d.length > 9 || /^0+$/.test(d)) return false
  const sum = digitsOf(d.padStart(9, '0')).reduce((acc, n, i) => {
    const p = n * (i % 2 === 0 ? 1 : 2)
    return acc + (p > 9 ? p - 9 : p)
  }, 0)
  return sum % 10 === 0
}

function luhn(d: string): boolean {
  let sum = 0
  digitsOf(d)
    .reverse()
    .forEach((n, i) => {
      const p = i % 2 === 1 ? n * 2 : n
      sum += p > 9 ? p - 9 : p
    })
  return sum % 10 === 0
}

function weighted(d: string, weights: number[]): number {
  return weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0)
}

/** ISO 7064 mod 97-10 over an alphanumeric string (letters A=10 ... Z=35). */
function mod97(s: string): number {
  let r = 0
  for (const ch of s) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const c of v) r = (r * 10 + Number(c)) % 97
  }
  return r
}

const VAT_FORMATS: Record<string, RegExp> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DE: /^\d{9}$/,
  DK: /^\d{8}$/, EE: /^\d{9}$/, EL: /^\d{9}$/, GR: /^\d{9}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^\d{8}$/,
  FR: /^[0-9A-Z]{2}\d{9}$/, HR: /^\d{11}$/, HU: /^\d{8}$/, IE: /^\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/, IT: /^\d{11}$/,
  LT: /^(?:\d{9}|\d{12})$/, LU: /^\d{8}$/, LV: /^\d{11}$/, MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/,
  PT: /^\d{9}$/, RO: /^\d{2,10}$/, SE: /^\d{10}01$/, SI: /^\d{8}$/, SK: /^\d{10}$/,
  GB: /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/, XI: /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
  CHE: /^\d{9}(?:MWST|TVA|IVA)?$/, NO: /^\d{9}(?:MVA)?$/,
}

/** Check digits of the VAT numbers whose algorithm is short and public; null where we don't check. */
function vatChecksum(country: string, n: string): boolean | null {
  switch (country) {
    case 'IT':
      return luhn(n)
    case 'FR':
      return /^\d{2}/.test(n) ? Number(n.slice(0, 2)) === (12 + 3 * (Number(n.slice(2)) % 97)) % 97 : null
    case 'BE':
      return 97 - (Number(n.slice(0, 8)) % 97) === Number(n.slice(8))
    case 'PT': {
      const r = 11 - (weighted(n, [9, 8, 7, 6, 5, 4, 3, 2]) % 11)
      return (r >= 10 ? 0 : r) === Number(n[8])
    }
    case 'PL': {
      const r = weighted(n, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11
      return r !== 10 && r === Number(n[9])
    }
    case 'DK':
      return weighted(n, [2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0
    case 'FI': {
      const r = weighted(n, [7, 9, 10, 5, 8, 4, 2]) % 11
      return r !== 1 && (r === 0 ? 0 : 11 - r) === Number(n[7])
    }
    case 'GB':
    case 'XI': {
      if (!/^\d{9}/.test(n)) return null
      const total = weighted(n, [8, 7, 6, 5, 4, 3, 2]) + Number(n.slice(7, 9))
      return total % 97 === 0 || (total + 55) % 97 === 0
    }
    case 'NL': {
      const d = n.slice(0, 9)
      const r = weighted(d, [9, 8, 7, 6, 5, 4, 3, 2]) % 11
      return r === Number(d[8]) || mod97(`NL${n}`) === 1
    }
    case 'CHE': {
      const r = 11 - (weighted(n, [5, 4, 3, 2, 7, 6, 5, 4]) % 11)
      return r !== 10 && (r === 11 ? 0 : r) === Number(n[8])
    }
    case 'NO': {
      const r = 11 - (weighted(n, [3, 2, 7, 6, 5, 4, 3, 2]) % 11)
      return r !== 10 && (r === 11 ? 0 : r) === Number(n[8])
    }
    default:
      return null
  }
}

interface Hit {
  value: string
  canonical: string
  scheme: TaxIdScheme | null
  country: string | null
  checksum: boolean | null
  from: number
  to: number
}

/** Prefixed VAT numbers (DE123456789, GB 123 4567 89, CHE-123.456.789 MWST, NL123456789B01). */
function findPrefixedVat(t: string): Hit[] {
  const out: Hit[] = []
  for (const m of t.matchAll(/(?<![\p{L}\p{N}])(CHE|[A-Z]{2})[\s.-]?(?=[0-9A-Z])/gu)) {
    const country = m[1]
    const format = VAT_FORMATS[country]
    if (!format) continue
    const compact: { ch: string; at: number; afterSep: boolean }[] = []
    let sep = false
    for (let i = m.index + m[0].length; i < t.length; i++) {
      const ch = t[i]
      if (/[0-9A-Z]/.test(ch)) {
        compact.push({ ch, at: i, afterSep: sep })
        sep = false
      } else if (/[\s.-]/.test(ch) && !sep && /[0-9]/.test(t[i + 1] ?? '')) sep = true
      else if (/[\s.-]/.test(ch) && !sep && country === 'CHE' && /^\s?(?:MWST|TVA|IVA)/.test(t.slice(i))) sep = true
      else break
    }
    const s = compact.map((c) => c.ch).join('')
    for (let len = s.length; len > 0; len--) {
      if (len < s.length && !compact[len].afterSep) continue
      const n = s.slice(0, len)
      if (!format.test(n)) continue
      const scheme: TaxIdScheme = country === 'GB' || country === 'XI' ? 'GB_VAT' : country === 'CHE' ? 'CH_UID' : country === 'NO' ? 'NO_VAT' : 'EU_VAT'
      const value = `${country}${n}`
      // Swiss "MWST"/"TVA" and Norwegian "MVA" suffixes are not part of the checked digits.
      const core = country === 'CHE' || country === 'NO' ? n.replace(/[A-Z]+$/, '') : n
      out.push({
        value,
        canonical: value,
        scheme,
        country: country === 'CHE' ? 'CH' : country === 'EL' ? 'GR' : country,
        checksum: vatChecksum(country, core),
        from: m.index,
        to: compact[len - 1].at + 1,
      })
      break
    }
  }
  return out
}

/** Australian Business Number: 11 digits, (first digit - 1) and weights 10,1,3,...,19, sum mod 89 = 0. */
function validAbn(d: string): boolean {
  if (!/^\d{11}$/.test(d)) return false
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
  const sum = [...d].reduce((acc, ch, i) => acc + (Number(ch) - (i === 0 ? 1 : 0)) * w[i], 0)
  return sum % 89 === 0
}

/**
 * ABNs as printed ("51 823 077 461", or 11 digits after "ABN"). Only a valid check digit makes
 * one: 11-digit numbers are common (Italian VAT, phone numbers), a passing ABN check is not.
 */
function findAbns(t: string): Hit[] {
  const out: Hit[] = []
  for (const m of t.matchAll(/(?<![\p{N}])(\d{2}) (\d{3}) (\d{3}) (\d{3})(?![\p{N}])|(?<=ABN[\s.:#]{0,3})(\d{11})(?![\p{N}])/gu)) {
    const d = m[0].replace(/\D/g, '')
    if (!validAbn(d)) continue
    out.push({ value: d, canonical: d, scheme: 'AU_ABN', country: 'AU', checksum: true, from: m.index, to: m.index + m[0].length })
  }
  return out
}

const USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY'
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]

/** China's Unified Social Credit Code (统一社会信用代码): 18 characters, GB 32100 mod-31 check. */
function findUscc(t: string): Hit[] {
  const out: Hit[] = []
  for (const m of t.matchAll(/(?<![0-9A-Z])[0-9A-HJ-NP-RTUW-Y]{2}\d{6}[0-9A-HJ-NP-RTUW-Y]{10}(?![0-9A-Z])/g)) {
    const s = m[0]
    const sum = USCC_WEIGHTS.reduce((acc, w, i) => acc + USCC_CHARS.indexOf(s[i]) * w, 0)
    if (USCC_CHARS[(31 - (sum % 31)) % 31] !== s[17]) continue
    out.push({ value: s, canonical: s, scheme: 'CN_USCC', country: 'CN', checksum: true, from: m.index, to: m.index + s.length })
  }
  return out
}

/** Digit runs that may be an Israeli id: 8 or 9 digits, separated by - . / or nothing. */
function findIsraeliIds(t: string): Hit[] {
  const out: Hit[] = []
  for (const m of t.matchAll(/(?<![\p{L}\p{N}.,/-])\d[\d./-]*\d(?![\p{L}\p{N}]|[.,/-]\d)/gu)) {
    const piece = m[0]
    if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(piece)) continue
    if (/^0\d-\d{7}$|^05\d-\d{7}$|^0\d{1,2}-\d{3}-\d{4}$/.test(piece)) continue
    if (/[.,]\d{2}$/.test(piece) && !/-/.test(piece)) continue
    const digits = piece.replace(/\D/g, '')
    if (digits.length !== 8 && digits.length !== 9) continue
    out.push({ value: digits, canonical: digits.padStart(9, '0'), scheme: 'IL', country: 'IL', checksum: isValidIsraeliId(digits), from: m.index, to: m.index + piece.length })
  }
  return out.sort((a, b) => Number(b.checksum) - Number(a.checksum) || b.value.length - a.value.length || a.from - b.from)
}

/**
 * Finds a tax / company id in a text (labels around it are fine): prefixed EU, UK, Swiss and
 * Norwegian VAT numbers (format, plus the check digit where it is short: IT FR BE PT PL DK FI GB NL
 * CH NO), US EINs (12-3456789), French SIRET (Luhn), Australian ABNs and Chinese Unified Social
 * Credit Codes (only with a valid check digit), and Israeli 9-digit ids with the official check
 * digit (8-digit ת.ז numbers are padded in `canonical`, `value` stays as printed). Without a
 * hint, a bare 8-9 digit number is read as Israeli. With a hint and no known shape, the longest
 * digit-bearing token is returned with scheme null.
 */
export function parseTaxId(text: string, hint: TaxIdHint = {}): TaxIdParse | null {
  const v = foldValue(text)
  const t = v.text
  const wantsIl = hint.scheme === 'IL' || hint.country === 'IL'
  const hits: Hit[] = []
  if (!wantsIl) hits.push(...findPrefixedVat(t))
  if (!hits.length && !wantsIl) {
    for (const m of t.matchAll(/(?<![\p{N}-])(\d{2})-(\d{7})(?![\p{N}]|-\d)/gu)) {
      // 0X-XXXXXXX is an Israeli landline far more often than an EIN; only a US hint makes it one.
      if (m[1].startsWith('0') && hint.scheme !== 'US_EIN' && hint.country !== 'US') continue
      hits.push({ value: m[1] + m[2], canonical: m[1] + m[2], scheme: 'US_EIN', country: 'US', checksum: null, from: m.index, to: m.index + m[0].length })
    }
    if (hint.scheme === 'US_EIN' && !hits.length) {
      for (const m of t.matchAll(/(?<![\p{N}])\d{9}(?![\p{N}])/gu)) hits.push({ value: m[0], canonical: m[0], scheme: 'US_EIN', country: 'US', checksum: null, from: m.index, to: m.index + 9 })
    }
  }
  if (!hits.length && !wantsIl && (hint.scheme === 'FR_SIRET' || hint.country === 'FR' || !hint.scheme)) {
    for (const m of t.matchAll(/(?<![\p{N}])\d{3} ?\d{3} ?\d{3} ?\d{5}(?![\p{N}])/gu)) {
      const d = m[0].replace(/\D/g, '')
      hits.push({ value: d, canonical: d, scheme: 'FR_SIRET', country: 'FR', checksum: luhn(d), from: m.index, to: m.index + m[0].length })
    }
  }
  if (!hits.length && !wantsIl && (!hint.country || hint.country === 'AU') && (!hint.scheme || hint.scheme === 'AU_ABN')) hits.push(...findAbns(t))
  if (!hits.length && !wantsIl && (!hint.country || hint.country === 'CN') && (!hint.scheme || hint.scheme === 'CN_USCC')) hits.push(...findUscc(t))
  const foreign = hint.scheme && hint.scheme !== 'IL'
  if (!hits.length && !foreign && (!hint.country || wantsIl)) hits.push(...findIsraeliIds(t))
  if (!hits.length && (hint.scheme || hint.country)) {
    // A trailing check letter stays with the id ("P051234567X", a Kenyan PIN).
    const best = [...t.matchAll(/[\p{L}\p{N}][\p{L}\p{N}./ -]*\p{N}\p{L}{0,2}(?!\p{L})/gu)]
      .map((m) => ({ m, digits: m[0].replace(/\D/g, '').length }))
      .filter((x) => x.digits >= 5)
      .sort((a, b) => b.digits - a.digits)[0]
    if (best) {
      const value = best.m[0].replace(/[\s./-]/g, '').toUpperCase()
      hits.push({ value, canonical: value, scheme: null, country: hint.country ?? null, checksum: null, from: best.m.index, to: best.m.index + best.m[0].length })
    }
  }
  const h = hits[0]
  if (!h) return null
  const { start, end } = originalSpan(v, h.from, h.to)
  return { value: h.value, canonical: h.canonical, scheme: h.scheme, country: h.country, checksum: h.checksum, raw: text.slice(start, end), start, end }
}

/**
 * Tax-id label words that name one country's scheme, folded ("ABN" is Australian, "KRA PIN"
 * Kenyan, "Unified Social Credit Code" Chinese). Interpretation can pass the country as the
 * TaxIdHint of a value printed under such a label, whatever language the label is in.
 */
const LABEL_COUNTRY: Record<string, string> = {
  abn: 'AU', acn: 'AU', 'gst/hst no.': 'CA', 'hst no.': 'CA', 'kra pin': 'KE', 'pin no.': 'KE',
  'unified social credit code': 'CN', uscc: 'CN', gstin: 'IN', ein: 'US', fein: 'US', trn: 'AE', dic: 'CZ', nip: 'PL',
  uid: 'CH', ide: 'CH', rfc: 'MX', cuit: 'AR', rut: 'CL', cnpj: 'BR', cpf: 'BR', nipc: 'PT', 'p.iva': 'IT',
  'partita iva': 'IT', 'codice fiscale': 'IT', 'ust-idnr.': 'DE', 'umsatzsteuer-id': 'DE', steuernummer: 'DE',
  'btw-nummer': 'NL', 'tva intracom.': 'FR', 'no. tva intracom.': 'FR', 'tva intracommunautaire': 'FR',
}

/** The country a tax-id label phrase implies (a LabelMatch's `phrase`), or null. */
export function taxIdCountryOfLabel(phrase: string): string | null {
  return LABEL_COUNTRY[foldLabel(phrase).text] ?? null
}

// ---------------------------------------------------------------------------------------------
// IBAN and Israeli bank accounts

const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27,
  GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21,
  LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28,
  PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20,
}

export interface IbanParse extends Span {
  /** Compact, upper case: "IL620108000000099999999". */
  value: string
  country: string
  /** mod 97 = 1 and the country's length. */
  checksum: boolean
  lengthOk: boolean
}

/** Finds an IBAN (printed in groups or not) and checks it: country length and mod 97. */
export function parseIban(text: string): IbanParse | null {
  const v = foldValue(text)
  const t = v.text.toUpperCase()
  for (const m of t.matchAll(/(?<![A-Z0-9])([A-Z]{2})\s?(\d{2})/g)) {
    const country = m[1]
    const want = IBAN_LENGTHS[country]
    const chars: { ch: string; at: number }[] = []
    for (const c of country + m[2]) chars.push({ ch: c, at: -1 })
    for (let i = m.index + m[0].length; i < t.length && chars.length < (want ?? 34); i++) {
      if (/[A-Z0-9]/.test(t[i])) chars.push({ ch: t[i], at: i })
      else if (!/[\s-]/.test(t[i]) || !/[A-Z0-9]/.test(t[i + 1] ?? '')) break
    }
    if (chars.length < 15) continue
    const value = chars.map((c) => c.ch).join('')
    const lengthOk = want ? value.length === want : value.length >= 15 && value.length <= 34
    const checksum = lengthOk && mod97(value.slice(4) + value.slice(0, 4)) === 1
    const last = chars[chars.length - 1].at
    const { start, end } = originalSpan(v, m.index, last + 1)
    return { value, country, checksum, lengthOk, raw: text.slice(start, end), start, end }
  }
  return null
}

/** Israeli bank codes by (folded) name, Hebrew and English. */
export const ISRAELI_BANKS: Record<string, number> = {
  'לאומי': 10, 'הפועלים': 12, 'פועלים': 12, 'דיסקונט': 11, 'מזרחי טפחות': 20, 'מזרחי-טפחות': 20, 'מזרחי': 20,
  'הבינלאומי': 31, 'בינלאומי': 31, 'יהב': 4, 'מרכנתיל': 17, 'אוצר החייל': 14, 'מסד': 46, 'ירושלים': 54,
  'איגוד': 13, 'פאג"י': 52, 'פועלי אגודת ישראל': 52, 'הדואר': 9, 'דואר': 9, 'וואן זירו': 18, 'one zero': 18,
  'סיטיבנק': 22, 'יו-בנק': 26, 'יובנק': 26, 'leumi': 10, 'hapoalim': 12, 'poalim': 12, 'discount': 11,
  'mizrahi': 20, 'mizrahi tefahot': 20, 'first international': 31, 'fibi': 31, 'yahav': 4, 'mercantile': 17,
  'otsar hahayal': 14, 'massad': 46, 'jerusalem': 54, 'citibank': 22, 'u-bank': 26,
}
const BANK_CODES = new Set([4, 9, 10, 11, 12, 13, 14, 17, 18, 20, 22, 23, 26, 31, 34, 46, 52, 54, 59, 68, 99])

export interface BankAccountParse extends Span {
  /** 'bank-branch-account' digits as printed, e.g. "12-345-123456". */
  value: string
  bank: string
  branch: string
  account: string
  bankName: string | null
}

const STOP = `(?!סניף|סנ'|branch|חשבון|ח-ן|ח"ן|ח\\.ן|account|acct|a/c)`
/**
 * The word "bank" as a whole word, with the Hebrew prefixes and article it takes ("הבנק
 * הבינלאומי", "בבנק לאומי", "לבנק"), never inside another word ("בנקאית: בנק ..." is "bank
 * transfer: bank ...", and the bank is the second one).
 */
const BANK_HEAD = `(?:(?<!\\p{L})[ובלמ]?ה?בנק|(?<!\\p{L})bank)(?!\\p{L})(?: (?:מס['".]?|מספר|no\\.?|code|number))?\\s*[:-]?\\s*`
/** "בנק לאומי (10)", "בנק: 12": a bank number, possibly after the bank's name. */
const BANK_RE = new RegExp(`${BANK_HEAD}((?:${STOP}[^\\d:])*?)\\(?\\s*(\\d{1,3})\\s*\\)?(?!\\d)`, 'u')
/** "בנק הפועלים סניף ...": a bank name only, numbered through ISRAELI_BANKS. */
const BANK_NAME_RE = new RegExp(`${BANK_HEAD}((?:${STOP}[^\\d:])+)`, 'gu')

/** The bank code of a printed bank name ("הבינלאומי", "מזרחי טפחות", "Leumi"), longest name first. */
function bankCodeOf(name: string): { code: string; name: string } | null {
  const known = Object.keys(ISRAELI_BANKS)
    .filter((n) => new RegExp(`(?<!\\p{L})(?:[ובלמ]?ה?)?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'u').test(name))
    .sort((a, b) => b.length - a.length)[0]
  return known ? { code: String(ISRAELI_BANKS[known]), name: known } : null
}
const BRANCH_RE = new RegExp(`(?<!\\p{L})(?:סניף|סנ'|branch)(?: (?:מס['".]?|מספר|no\\.?|code|number|#))?\\s*[:-]?\\s*(?:(?:${STOP}[^\\d:]){0,25}?\\(\\s*)?(\\d{1,4})(?!\\d)`, 'u')
const ACCOUNT_RE = /(?<!\p{L})(?:מספר חשבון|מס['".]? חשבון|ח-ן|ח"ן|ח\.ן|חשבון|חש'|account(?: no\.?| number| #)?|acct\.?(?: no\.?)?|a\/c(?: no\.?)?)\s*(?:מס['".]?|מספר|no\.?|#)?\s*[:-]?\s*(\d[\d/-]{2,20}\d|\d{3,})(?!\d)/u

/**
 * An Israeli bank account as bank-branch-account, from labelled forms ("בנק לאומי (10) סניף 800
 * חשבון 123456", "בנק: 12 סניף: 345 ח-ן: 123456", "Bank Hapoalim branch 600 account 12345") or the
 * compact "12-345-123456" (only with a known bank code and an account of 5+ digits, so phone
 * numbers like 04-123-4567 are not taken). A bank named but not numbered gets its code from
 * ISRAELI_BANKS.
 */
export function parseIsraeliBankAccount(text: string): BankAccountParse | null {
  const v = foldLabel(text)
  const t = v.text
  // A numbered bank first; else the first bank word followed by a name we can number.
  const named = [...t.matchAll(BANK_NAME_RE)].find((m) => bankCodeOf(m[1]))
  const bank = BANK_RE.exec(t) ?? named ?? null
  const branch = BRANCH_RE.exec(t)
  const account = ACCOUNT_RE.exec(t)
  if (bank && branch && account) {
    const name = bank[1].trim().replace(/[()]/g, '').trim()
    const known = bankCodeOf(name)?.name
    const code = bank[2] ?? (known ? String(ISRAELI_BANKS[known]) : null)
    if (code) {
      const acc = account[1].replace(/\D/g, '')
      const from = Math.min(bank.index, branch.index, account.index)
      const to = Math.max(bank.index + bank[0].length, branch.index + branch[0].length, account.index + account[0].length)
      const { start, end } = originalSpan(v, from, to)
      return { value: `${code}-${branch[1]}-${acc}`, bank: code, branch: branch[1], account: acc, bankName: known ?? (name || null), raw: text.slice(start, end), start, end }
    }
  }
  for (const m of t.matchAll(/(?<![\d-])(\d{1,3})[-/ ](\d{3})[-/ ](\d{5,13})(?![\d-])/g)) {
    if (!BANK_CODES.has(Number(m[1]))) continue
    const { start, end } = originalSpan(v, m.index, m.index + m[0].length)
    return { value: `${m[1]}-${m[2]}-${m[3]}`, bank: m[1], branch: m[2], account: m[3], bankName: null, raw: text.slice(start, end), start, end }
  }
  return null
}

export type BankAccountScheme = 'IBAN' | 'IL' | 'GB_SORT_CODE' | 'AU_BSB' | 'ACCOUNT'

export interface AnyBankAccountParse extends Span {
  /** What `supplier.bank_account` stores: the IBAN, else bank/branch/sort code and account joined by '-'. */
  value: string
  scheme: BankAccountScheme
  /** IBAN mod 97; null where no check applies. */
  checksum: boolean | null
}

const SORT_CODE_RE = /(?<!\p{L})sort[ -]?code\s*[:.#]?\s*(\d{2})[ -](\d{2})[ -](\d{2})(?!\d)/u
const BSB_RE = /(?<!\p{L})bsb(?: no\.?| number)?\s*[:.#]?\s*(\d{3})[ -]?(\d{3})(?!\d)/u
/** An account number after an account word, digits possibly grouped by spaces ("3901 0000 0000 0000 120"). */
const ANY_ACCOUNT_RE =
  /(?<!\p{L})(?:account|acct\.?|acc\.?|a\/c|konto|kontonummer|compte|cuenta|conto|rekening|rekeningnummer|ח-ן|ח"ן)(?: (?:no\.?|nr\.?|number|#|n°|מס['"]?|מספר))?\s*[:.#]?\s*(\d(?:[\d]| (?=\d)){4,30})(?![\d])/u

/**
 * A bank account in any common printed form, the most specific first: an IBAN (when its length
 * fits the country), an Israeli bank-branch-account, a UK sort code with its account ("20-45-77-
 * 00000125"), an Australian BSB with its account ("083-417-000000126"), or the digits after an
 * account word ("A/C No.: 3901 0000 0000 0000 120", "Account: 4800000113"; a US routing number is
 * not part of the account). The field definition prefers the IBAN whenever one is printed.
 */
export function parseBankAccount(text: string): AnyBankAccountParse | null {
  const iban = parseIban(text)
  if (iban?.lengthOk) return { value: iban.value, scheme: 'IBAN', checksum: iban.checksum, raw: iban.raw, start: iban.start, end: iban.end }
  const il = parseIsraeliBankAccount(text)
  if (il) return { value: il.value, scheme: 'IL', checksum: null, raw: il.raw, start: il.start, end: il.end }
  const v = foldLabel(text)
  const t = v.text
  const account = ANY_ACCOUNT_RE.exec(t)
  const digits = account ? account[1].replace(/\D/g, '') : ''
  const okAccount = digits.length >= 5 && digits.length <= 24
  const span = (from: number, to: number) => {
    const { start, end } = originalSpan(v, from, to)
    return { raw: text.slice(start, end), start, end }
  }
  const sort = SORT_CODE_RE.exec(t)
  if (sort && account && okAccount && digits.length >= 6 && digits.length <= 10) {
    const from = Math.min(sort.index, account.index)
    const to = Math.max(sort.index + sort[0].length, account.index + account[0].length)
    return { value: `${sort[1]}-${sort[2]}-${sort[3]}-${digits}`, scheme: 'GB_SORT_CODE', checksum: null, ...span(from, to) }
  }
  const bsb = BSB_RE.exec(t)
  if (bsb && account && okAccount && digits.length <= 10) {
    const from = Math.min(bsb.index, account.index)
    const to = Math.max(bsb.index + bsb[0].length, account.index + account[0].length)
    return { value: `${bsb[1]}-${bsb[2]}-${digits}`, scheme: 'AU_BSB', checksum: null, ...span(from, to) }
  }
  if (account && okAccount) return { value: digits, scheme: 'ACCOUNT', checksum: null, ...span(account.index, account.index + account[0].length) }
  return null
}

// ---------------------------------------------------------------------------------------------
// E-mail and phone

export interface EmailParse extends Span {
  /** As printed without spaces. */
  value: string
}

/** Finds an e-mail address (also with OCR spaces around '@'). */
export function parseEmail(text: string): EmailParse | null {
  const v = foldValue(text)
  const m = /(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]*\s?@\s?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w@])/.exec(v.text)
  if (!m) return null
  const { start, end } = originalSpan(v, m.index, m.index + m[0].length)
  return { value: m[0].replace(/\s/g, ''), raw: text.slice(start, end), start, end }
}

/** 'national': another country's number in its national form ("0113 496 0582", "04 72 00 01 08"). */
export type PhoneKind = 'mobile' | 'landline' | 'voip' | 'tollfree' | 'star' | 'intl' | 'national'

export interface PhoneParse extends Span {
  /** Normalized digits: Israeli numbers in national form with the leading 0 ("031234567"),
   *  star numbers as "*2700", other international numbers as "+" and digits, other national
   *  numbers as their digits with the trunk 0 ("01134960582"). */
  value: string
  country: string | null
  kind: PhoneKind
}

function israeliNational(d: string): PhoneKind | null {
  if (/^05\d{8}$/.test(d)) return 'mobile'
  if (/^07\d{8}$/.test(d)) return 'voip'
  if (/^0[2-489]\d{7}$/.test(d)) return 'landline'
  return null
}

function phoneReading(s: string): { value: string; country: string | null; kind: PhoneKind } | null {
  if (/^\*\d{3,5}$|^\d{3,5}\*$/.test(s)) return { value: `*${s.replace(/\D/g, '')}`, country: 'IL', kind: 'star' }
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(s)) return null
  if (/\*/.test(s)) return null
  const plus = s.startsWith('+')
  let d = s.replace(/\(0\)/, '').replace(/\D/g, '')
  const separated = /[\s().-]/.test(s)
  if (!plus && d.startsWith('00') && (separated || d.startsWith('00972'))) d = d.slice(2)
  else if (!plus && d.startsWith('00')) return null
  const intl = plus || (s.replace(/\D/g, '').startsWith('00'))
  // No country code starts with 0: "0000 0441 987" is a run of an IBAN or an account, not "00" + a number.
  if (intl && d.startsWith('0')) return null
  if (intl || (d.startsWith('972') && (d.length === 11 || d.length === 12))) {
    if (d.startsWith('972')) {
      const national = `0${d.slice(3).replace(/^0/, '')}`
      const kind = israeliNational(national)
      return kind ? { value: national, country: 'IL', kind } : null
    }
    if (!intl) return null
    if (d.length < 8 || d.length > 15) return null
    return { value: `+${d}`, country: d.startsWith('1') ? 'US' : null, kind: 'intl' }
  }
  if (/^1(?:800|700|599|801|809)\d{6}$/.test(d)) return { value: d, country: 'IL', kind: 'tollfree' }
  const il = israeliNational(d)
  if (il) return { value: d, country: 'IL', kind: il }
  if (/^\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}$/.test(s) || /^1[\s.-]\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}$/.test(s)) {
    return { value: d, country: 'US', kind: d.startsWith('1800') || d.startsWith('800') ? 'tollfree' : 'landline' }
  }
  // Other countries' national numbers, grouped as printed: a trunk 0 and 10-11 digits ("0113 496
  // 0582" UK, "04 72 00 01 08" FR, "030 000 0109" NL, "(03) 5550 0182" AU), or the Spanish
  // 9-digit 3-2-2-2 grouping ("963 00 01 10"). The grouping is required, so a bare digit run (an
  // account, an id) is never a phone; 3-3-3 groups are left alone (SIREN, ACN).
  const groups = s.replace(/[()]/g, ' ').trim().split(/[\s.-]+/).filter(Boolean)
  if (groups.length >= 2 && groups.every((g) => /^\d{2,6}$/.test(g))) {
    if (/^0[1-9]\d{8,9}$/.test(d)) return { value: d, country: null, kind: 'national' }
    if (/^[6-9]\d{8}$/.test(d) && /^\d{3}(?: \d{2}){3}$/.test(s)) return { value: d, country: 'ES', kind: 'national' }
  }
  return null
}

/** Every phone number in a text, left to right. */
export function findPhones(text: string): PhoneParse[] {
  const v = foldValue(text)
  const tokens = [...v.text.matchAll(/\S+/g)].map((m) => ({ s: m[0], from: m.index, to: m.index + m[0].length }))
  const phoneish = (s: string): boolean => /^[+(]?[\d().*/-]*\d[\d().*/-]*$/.test(s) && !/[.,]\d{2}$/.test(s.replace(/\d{3}\.\d{4}$/, ''))
  const out: PhoneParse[] = []
  for (let i = 0; i < tokens.length; ) {
    let taken = 0
    for (let n = Math.min(5, tokens.length - i); n >= 1 && !taken; n--) {
      const win = tokens.slice(i, i + n)
      if (!win.every((w) => phoneish(w.s))) continue
      const s = v.text.slice(win[0].from, win[n - 1].to).replace(/^[(:]|[):,;.]$/g, (c) => (c === '(' || c === ')' ? c : ''))
      const r = phoneReading(s.replace(/[:,;]$/, ''))
      if (!r) continue
      const { start, end } = originalSpan(v, win[0].from, win[n - 1].to)
      out.push({ ...r, raw: text.slice(start, end), start, end })
      taken = n
    }
    i += taken || 1
  }
  return out
}

/**
 * The first phone number in a text: Israeli 0X-XXXXXXX, 05X-XXXXXXX, 07X-XXXXXXX, 1-800-XXX-XXX,
 * *XXXX, +972 (0)3 ..., other '+' international numbers, US (XXX) XXX-XXXX. Amounts, dates and
 * plain ids do not qualify (an Israeli number must start with 0, 972 or a 1-800 style prefix).
 */
export function parsePhone(text: string): PhoneParse | null {
  return findPhones(text)[0] ?? null
}

// ---------------------------------------------------------------------------------------------
// Identifiers

/**
 * Whether a text looks like a document number (invoice/order/allocation number): one token or two,
 * with digits, optionally letters and - / _ . # separators, and not a date, an amount with cents,
 * a thousands-grouped number, a percentage, an e-mail or a formatted phone number.
 */
export function looksLikeIdentifier(text: string): boolean {
  const t = cleanText(text).replace(/^[#№:]+\s*/, '').replace(/[:]+$/, '')
  if (!t || t.length > 32 || !/\d/.test(t)) return false
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\-/_.#]*(?: [\p{L}\p{N}\-/_.#]+)?$/u.test(t)) return false
  const letters = (t.match(/\p{L}/gu) ?? []).length
  if (letters > 10) return false
  if (parseEmail(t) || parsePercent(t)) return false
  if (parseDate(t)?.whole) return false
  if (/^-?\d{1,3}(?:[,.' ]\d{3})*[.,]\d{1,2}$/.test(t) || /^\d+[.,]\d{1,2}$/.test(t)) return false
  if (/^\d{1,3}(?:,\d{3})+$/.test(t)) return false
  if (!letters && /[\s()-]/.test(t)) {
    const p = parsePhone(t)
    if (p && p.raw.length === t.length && p.kind !== 'intl') return false
  }
  return true
}
