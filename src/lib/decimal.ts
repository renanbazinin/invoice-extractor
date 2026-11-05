import type { DecimalString } from '../model/types'

/**
 * Exact decimal arithmetic for money. A value is an integer of units at a scale:
 * { units: 118000n, scale: 2 } is 1180.00. Floats never touch amounts.
 */
export interface Dec {
  units: bigint
  scale: number
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/

export function isDecimalString(s: string): boolean {
  return DECIMAL.test(s)
}

/** Parses a canonical decimal string ("-1180.50"). Throws on anything else: parse printed
 *  amounts with the semantic normalizers first. */
export function dec(s: DecimalString): Dec {
  const m = DECIMAL.exec(s)
  if (!m) throw new Error(`Not a decimal string: ${JSON.stringify(s)}`)
  const frac = m[3] ?? ''
  const units = BigInt(m[2] + frac) * (m[1] ? -1n : 1n)
  return { units, scale: frac.length }
}

export function fromInt(n: number | bigint): Dec {
  return { units: BigInt(n), scale: 0 }
}

function rescale(a: Dec, scale: number): bigint {
  return a.units * 10n ** BigInt(scale - a.scale)
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [rescale(a, scale), rescale(b, scale), scale]
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b)
  return { units: x + y, scale }
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b)
  return { units: x - y, scale }
}

export function mul(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale }
}

export function neg(a: Dec): Dec {
  return { units: -a.units, scale: a.scale }
}

export function sum(values: Dec[]): Dec {
  return values.reduce(add, fromInt(0))
}

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function eq(a: Dec, b: Dec): boolean {
  return cmp(a, b) === 0
}

export function abs(a: Dec): Dec {
  return a.units < 0n ? neg(a) : a
}

export function isZero(a: Dec): boolean {
  return a.units === 0n
}

/** |a - b| <= tolerance. */
export function near(a: Dec, b: Dec, tolerance: Dec): boolean {
  return cmp(abs(sub(a, b)), abs(tolerance)) <= 0
}

/** Rounds half away from zero to `scale` decimals. */
export function round(a: Dec, scale: number): Dec {
  if (a.scale <= scale) return { units: rescale(a, scale), scale }
  const factor = 10n ** BigInt(a.scale - scale)
  const q = a.units / factor
  const r = a.units % factor
  const half = factor / 2n
  const absR = r < 0n ? -r : r
  const up = absR > half || (absR === half && factor % 2n === 0n)
  return { units: up ? q + (a.units < 0n ? -1n : 1n) : q, scale }
}

/** a / b rounded to `scale` decimals. */
export function div(a: Dec, b: Dec, scale: number): Dec {
  if (b.units === 0n) throw new Error('Division by zero')
  // a/b = (a.units / 10^a.scale) / (b.units / 10^b.scale); compute with 2 guard digits then round.
  const guard = scale + 2
  const num = a.units * 10n ** BigInt(guard + b.scale)
  const den = b.units * 10n ** BigInt(a.scale)
  return round({ units: num / den, scale: guard }, scale)
}

/** Canonical string: trailing zeros kept to at least `minScale` decimals (default: as stored). */
export function str(a: Dec, minScale = a.scale): DecimalString {
  const v = a.scale < minScale ? { units: rescale(a, minScale), scale: minScale } : a
  const negative = v.units < 0n
  const digits = (negative ? -v.units : v.units).toString().padStart(v.scale + 1, '0')
  const int = v.scale ? digits.slice(0, -v.scale) : digits
  const frac = v.scale ? `.${digits.slice(-v.scale)}` : ''
  return `${negative ? '-' : ''}${int}${frac}`
}

/** Drops trailing fractional zeros: 1180.50 → 1180.5, 18.00 → 18. For comparisons and keys. */
export function canonical(a: Dec | DecimalString): DecimalString {
  const v = typeof a === 'string' ? dec(a) : a
  let { units, scale } = v
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n
    scale--
  }
  return str({ units, scale })
}

/** Numerically equal decimal strings ("18" and "18.00"). */
export function sameDecimal(a: DecimalString, b: DecimalString): boolean {
  return eq(dec(a), dec(b))
}
