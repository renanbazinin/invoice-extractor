import { findAmounts, findCurrencies, looksLikeIdentifier, parseAmount, parseDate, parsePercent, parseQuantity, type AmountParse, type NumberFormat } from '../../semantic'

/**
 * What a table cell holds, judged from its text alone. Tables are recognised by the shape of
 * their columns (text, money, quantities, codes), so this is deliberately coarse.
 */
export type CellKind =
  /** An amount with cents or a currency mark: "81.80", "₪ 1,234.00", "7.038,00 €". */
  | 'money'
  /** A bare number without cents: a quantity, a count, an integer price ("3", "2.5", "10 יח'"). */
  | 'number'
  | 'percent'
  /** "quantity × unit price" in one cell ("2 x 9.90"), as on till receipts. */
  | 'qxp'
  | 'date'
  /** An article code or another identifier ("SK-7556", "9779340012345"). */
  | 'code'
  | 'text'
  /** Punctuation or symbols only ("-", "₪"). */
  | 'symbol'

const LETTER = /\p{L}/u
const DIGIT = /\d/

/** A number token as printed: digits with . , ' or (no-break) space separators, optional sign. */
const NUM = String.raw`[-+−]?\d[\d.,'  ]*\d|[-+−]?\d`
const TIMES = String.raw`[x×X*@]`

export interface QxPParse {
  /** Offsets into the text. */
  qty: { raw: string; start: number; end: number }
  price: { raw: string; start: number; end: number }
}

/** A unit of measure printed between the quantity and the sign ("41.20 L @ 7.15", "1.250 ק"ג x 12.90"). */
const UNIT = String.raw`[A-Za-zא-ת][A-Za-zא-ת'"׳״.]{0,5}`
const PLAIN_QXP = new RegExp(String.raw`^\s*(${NUM})(\s*)${TIMES}(?:\s*${TIMES})?(\s*)(${NUM})\s*$`, 'du')
const UNIT_QXP = new RegExp(String.raw`^\s*(${NUM})\s*(${UNIT})\s*${TIMES}(?:\s*${TIMES})?\s*(${NUM})\s*$`, 'du')
const BROKEN_QXP = new RegExp(String.raw`^\s*${TIMES}\s*(${NUM})\s+(${NUM})\s*$`, 'du')

function group(text: string, m: RegExpExecArray, i: number): { raw: string; start: number; end: number } {
  const [start, end] = m.indices![i]!
  return { raw: text.slice(start, end), start, end }
}

/**
 * "quantity × unit price" printed in one cell: "2 x 9.90", "1.250 X 12.90", "3 @ 5.00", "2×₪9.90",
 * fuel and weighed goods with the unit after the quantity ("41.20 L @ 7.15") and till printouts
 * that double the sign ("1 x @ 14.90"). Also the form a right-to-left page shows when the numbers
 * are not bidi-isolated: logical "5 x 17.00" is displayed (and read back) as "x 17.00 5" — the
 * price follows the sign and the quantity comes last. Returns null for anything else; a size such
 * as "60x60" (two integers glued to the sign) or "60 cm x 60" (a unit but no price with cents) is
 * a dimension, not a multiplication.
 */
export function parseQxP(text: string): QxPParse | null {
  // Currency marks are blanked with spaces of the same length, so offsets stay valid.
  const t = text.replace(/[₪$€£]|ש"ח|NIS|ILS|USD|EUR/g, (s) => ' '.repeat(s.length))
  const plain = PLAIN_QXP.exec(t)
  if (plain) {
    const qty = group(text, plain, 1)
    const price = group(text, plain, 4)
    const glued = !plain[2] && !plain[3]
    if (glued && !/[.,]/.test(qty.raw + price.raw)) return null
    return { qty, price }
  }
  const unit = UNIT_QXP.exec(t)
  // With a unit the price must look like money (cents), so a size "60 cm x 60" is not one.
  if (unit && /[.,]\d{2,}$/.test(unit[3])) return { qty: group(text, unit, 1), price: group(text, unit, 3) }
  const broken = BROKEN_QXP.exec(t)
  if (broken) return { price: group(text, broken, 1), qty: group(text, broken, 2) }
  return null
}

const TRAILING_QXP = new RegExp(String.raw`(?:^|\s)(${NUM})\s+${TIMES}\s+(${NUM})\s*$`, 'du')
const LEADING_QXP = new RegExp(String.raw`^\s*(${NUM})\s+${TIMES}\s+(${NUM})(?=\s+\S)`, 'du')

/**
 * "quantity × price" at the end or the start of a longer cell ("במבה 80 גרם 2 x 5.90"), with
 * spaces around the sign (so "90x120" inside a name is not one). Returns the numbers and the
 * span of the rest (the name).
 */
export function embeddedQxP(text: string): (QxPParse & { rest: { start: number; end: number } }) | null {
  const t = text.replace(/[₪$€£]/g, ' ')
  const tail = TRAILING_QXP.exec(t)
  if (tail && /\p{L}/u.test(t.slice(0, tail.index))) {
    const qty = group(text, tail, 1)
    return { qty, price: group(text, tail, 2), rest: { start: 0, end: tail.index } }
  }
  const head = LEADING_QXP.exec(t)
  if (head) {
    const price = group(text, head, 2)
    if (/\p{L}/u.test(t.slice(price.end))) return { qty: group(text, head, 1), price, rest: { start: price.end, end: text.length } }
  }
  return null
}

/** True when the cell's text is "quantity × price" (see parseQxP). */
export const isQxP = (text: string): boolean => parseQxP(text) !== null

/**
 * The kind of a cell's text. Identifiers are told from amounts by shape: long digit runs without
 * separators (barcodes, 7+ digits) and letter/digit codes are codes; an amount needs cents or a
 * currency mark to be money, a bare integer is a number (it may still be money in a money column).
 */
export function cellKind(text: string, fmt?: NumberFormat): CellKind {
  const t = text.trim()
  if (!t) return 'symbol'
  const letters = LETTER.test(t)
  const digits = DIGIT.test(t)
  if (!letters && !digits) return 'symbol'
  if (digits) {
    const pct = parsePercent(t)
    if (pct && !/[\p{L}\d]/u.test(t.slice(0, pct.start) + t.slice(pct.end))) return 'percent'
    if (parseQxP(t)) return 'qxp'
    const date = parseDate(t)
    if (date?.whole && /[/.\-]/.test(t) && !parseAmount(t, fmt)) return 'date'
    const amount = parseAmount(t, fmt)
    if (amount) {
      const bare = t.replace(/[\s,.'’]/g, '')
      if (!amount.currency && amount.decimals === 0 && /^\d{7,}$/.test(bare)) return 'code'
      if (amount.decimals === 2 || amount.currency || amount.decimals > 2) return 'money'
      return 'number'
    }
    if (date?.whole) return 'date'
    const qty = parseQuantity(t, fmt)
    if (qty && qty.raw.length >= t.length - 1) return 'number'
    if (!/\s/.test(t) && looksLikeIdentifier(t)) return 'code'
    if (looseAmount(t, fmt)) return 'money'
  }
  if (letters) return currencyOnly(t) ? 'symbol' : 'text'
  return looksLikeIdentifier(t) ? 'code' : 'symbol'
}

/**
 * An amount with cents next to a short stray word, as a scan reads a currency code it could not
 * recognise ("ספט 4,271.20" for "USD 4,271.20"): exactly one amount with two decimals and at most
 * four other letters. Quantities with a unit ("2.50 kg") are read as quantities before this.
 */
export function looseAmount(text: string, fmt?: NumberFormat): AmountParse | null {
  const found = findAmounts(text, fmt).filter((a) => a.decimals === 2)
  if (found.length !== 1) return null
  const a = found[0]
  const rest = text.slice(0, a.start) + text.slice(a.end)
  if (/\d/.test(rest) || (rest.match(/\p{L}/gu) ?? []).length > 4) return null
  return a
}

/** A currency mark written as letters ("ILS", "ש"ח", "NIS", "EUR") and nothing else. */
function currencyOnly(text: string): boolean {
  let rest = text
  for (const c of findCurrencies(text)) rest = rest.replace(c.raw, '')
  return rest !== text && !/[\p{L}\p{N}]/u.test(rest)
}

/** Numeric kinds that can stand in a quantity, price or amount column. */
export const isNumericKind = (k: CellKind): boolean => k === 'money' || k === 'number' || k === 'percent' || k === 'qxp'

/** The currency printed in a text, if exactly one is. */
export function currencyOf(text: string): string | null {
  const codes = [...new Set(findCurrencies(text).map((c) => c.code))]
  return codes.length === 1 ? codes[0] : null
}
