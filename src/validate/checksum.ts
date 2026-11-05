/**
 * Check digits that validation can confirm on its own. A passing checksum is the strongest evidence
 * that an identifier was read correctly: the Israeli scheme catches every single-digit error and
 * most adjacent swaps, which are exactly the mistakes OCR makes. It says nothing about the role
 * (supplier vs customer), so callers still guard that separately.
 */

/** Separators people print inside identifiers. */
const SEPARATORS = /[\s.\-/]/g

/**
 * Israeli ID family: ת.ז (person), ח.פ (company), ע.מ (licensed dealer), עמותה. Nine digits with
 * weights 1,2,1,2…; a product above 9 contributes its digit sum; the total is divisible by 10.
 * ת.ז is often printed without its leading zeros, so 7–8 digits are left-padded.
 * Returns null when the value is not shaped like one (so the scheme does not apply).
 */
export function israeliIdChecksum(value: string): boolean | null {
  const digits = value.replace(SEPARATORS, '')
  if (!/^\d{7,9}$/.test(digits)) return null
  const d = digits.padStart(9, '0')
  if (/^0+$/.test(d)) return false
  let total = 0
  for (let i = 0; i < 9; i++) {
    const p = Number(d[i]) * (i % 2 === 0 ? 1 : 2)
    total += p > 9 ? p - 9 : p
  }
  return total % 10 === 0
}

/** IBAN lengths for the countries an Israeli/European invoice is likely to show. Others: 15..34. */
const IBAN_LENGTH: Record<string, number> = {
  IL: 23, DE: 22, GB: 22, FR: 27, ES: 24, IT: 27, NL: 18, BE: 16, AT: 20, CH: 21, PL: 28, PT: 25,
  IE: 22, LU: 20, SE: 24, DK: 18, FI: 18, NO: 15, CY: 28, GR: 27, AE: 23, TR: 26,
}

/** ISO 13616 mod-97 check. Returns null when the value is not shaped like an IBAN. */
export function ibanChecksum(value: string): boolean | null {
  const s = value.replace(SEPARATORS, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return null
  const expectedLength = IBAN_LENGTH[s.slice(0, 2)]
  if (expectedLength !== undefined && s.length !== expectedLength) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
    for (const c of digits) rem = (rem * 10 + Number(c)) % 97
  }
  return rem === 1
}

export type ChecksumScheme = 'il-id' | 'iban'

export interface ChecksumResult {
  scheme: ChecksumScheme | string | null
  /** true/false when a scheme applies, null when none does. */
  valid: boolean | null
  /** True when this layer computed it; false when it is the semantic layer's verdict for a scheme we don't know. */
  recomputed: boolean
}

/**
 * Decides which scheme applies to an identifier and checks it. Our own computation wins over the
 * candidate's `checksum` flag for the schemes we know; for others the parser's verdict is used as is.
 *
 * @param israeli whether the document is Israeli (Hebrew text, ILS, or an Israeli id label): a bare
 *   9-digit number is then a ח.פ/ע.מ, while elsewhere it may be a US EIN or similar.
 */
export function checkIdentifier(
  value: string,
  given: { scheme: string | null; checksum: boolean | null },
  israeli: boolean,
): ChecksumResult {
  const iban = ibanChecksum(value)
  if (iban !== null || (given.scheme !== null && /iban/i.test(given.scheme))) {
    return { scheme: 'iban', valid: iban ?? false, recomputed: true }
  }
  const givenIsraeli = given.scheme !== null && /^(il|isr)/i.test(given.scheme)
  if (givenIsraeli || (given.scheme === null && israeli)) {
    const il = israeliIdChecksum(value)
    if (il !== null) return { scheme: 'il-id', valid: il, recomputed: true }
    if (givenIsraeli) return { scheme: 'il-id', valid: false, recomputed: true }
  }
  if (given.scheme !== null) return { scheme: given.scheme, valid: given.checksum, recomputed: false }
  return { scheme: null, valid: null, recomputed: false }
}
