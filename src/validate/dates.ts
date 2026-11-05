import type { CanonicalField, NormalizedValue, ValidationCheck } from '../model/types'
import type { DocIndex } from './evidence'
import type { ValueGroup } from './groups'

/**
 * Dates. The danger is 03/04/2026: 3 April for an Israeli or European supplier, 4 March for an
 * American one. A parser can only guess; the document itself usually settles it, because some
 * other date on it is unambiguous (25/04/2026 can only be day-first) and one document uses one
 * convention. Failing that, invoice date ≤ due date can rule one reading out. Otherwise the date
 * stays ambiguous and is never verified.
 */

export type Convention = 'dmy' | 'mdy'

export interface NumericDate {
  a: number
  b: number
  year: number
}

/** "03/04/2026", "3.4.26", "03-04-2026" → its three numbers; null for other shapes (ISO, month names). */
export function numericDate(raw: string): NumericDate | null {
  const m = /(?<!\d)(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/.exec(raw)
  if (!m) return null
  return { a: Number(m[1]), b: Number(m[3]), year: fullYear(Number(m[4])) }
}

function fullYear(y: number): number {
  if (y >= 100) return y
  return y < 70 ? 2000 + y : 1900 + y
}

/** What a printed numeric date says about the day/month order. */
export function conventionOf(d: NumericDate): Convention | 'ambiguous' | 'same' | null {
  const { a, b } = d
  if (a < 1 || b < 1 || a > 31 || b > 31) return null
  if (a > 12 && b <= 12) return 'dmy'
  if (b > 12 && a <= 12) return 'mdy'
  if (a > 12 && b > 12) return null
  return a === b ? 'same' : 'ambiguous'
}

export function isoOf(d: NumericDate, c: Convention): string | null {
  const day = c === 'dmy' ? d.a : d.b
  const month = c === 'dmy' ? d.b : d.a
  if (month < 1 || month > 12 || day < 1) return null
  const dt = new Date(Date.UTC(d.year, month - 1, day))
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null
  return `${String(d.year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const DATE_IN_TEXT = /(?<![\d./-])(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?![\d])/g

export interface ConventionEvidence {
  convention: Convention | null
  /** The unambiguous printed dates that decided it. */
  witnesses: string[]
  /** Both day-first and month-first dates are printed. */
  conflicting: boolean
}

/** The day/month order the document uses, from every unambiguous numeric date printed on it. */
export function documentConvention(rawDates: readonly string[], doc: DocIndex): ConventionEvidence {
  const seen = new Map<Convention, string[]>([
    ['dmy', []],
    ['mdy', []],
  ])
  const consider = (text: string) => {
    const d = numericDate(text)
    if (!d) return
    const c = conventionOf(d)
    if ((c === 'dmy' || c === 'mdy') && isoOf(d, c)) seen.get(c)!.push(text)
  }
  for (const r of rawDates) consider(r)
  for (const line of doc.lineTexts) for (const m of line.matchAll(DATE_IN_TEXT)) consider(m[0])
  const dmy = [...new Set(seen.get('dmy'))]
  const mdy = [...new Set(seen.get('mdy'))]
  if (dmy.length && mdy.length) return { convention: null, witnesses: [...dmy, ...mdy], conflicting: true }
  if (dmy.length) return { convention: 'dmy', witnesses: dmy, conflicting: false }
  if (mdy.length) return { convention: 'mdy', witnesses: mdy, conflicting: false }
  return { convention: null, witnesses: [], conflicting: false }
}

export interface DateReading {
  /** The reading chosen (the parser's, or the one the document settles). */
  iso: string
  /** Every possible reading, chosen one first. */
  readings: string[]
  ambiguous: boolean
  /** How the ambiguity was settled, when it was. */
  resolvedBy: 'convention' | 'order' | null
  /** Unambiguous dates that settled the convention. */
  witnesses: string[]
}

/** The readings of a date group, settled by the document's convention when possible. */
export function readDate(group: ValueGroup, conv: ConventionEvidence): DateReading | null {
  const n = group.rep.normalized
  if (n.kind !== 'date') return null
  const parts = numericDate(group.rep.rawValue)
  const own = parts ? conventionOf(parts) : null
  const readings = [...new Set([n.iso, ...n.alternatives])]
  if (parts && own === 'ambiguous') {
    for (const c of ['dmy', 'mdy'] as const) {
      const iso = isoOf(parts, c)
      if (iso && !readings.includes(iso)) readings.push(iso)
    }
  }
  const ambiguous = readings.length > 1
  if (!ambiguous) return { iso: n.iso, readings, ambiguous: false, resolvedBy: null, witnesses: [] }
  if (parts && conv.convention) {
    const iso = isoOf(parts, conv.convention)
    if (iso) return { iso, readings: [iso, ...readings.filter((r) => r !== iso)], ambiguous: false, resolvedBy: 'convention', witnesses: conv.witnesses }
  }
  return { iso: n.iso, readings, ambiguous: true, resolvedBy: null, witnesses: [] }
}

/**
 * invoice date ≤ due date. When exactly one reading of an ambiguous date keeps that order with an
 * unambiguous partner, the order settles it.
 */
export function settleByOrder(invoice: DateReading | null, due: DateReading | null): void {
  if (!invoice || !due) return
  if (invoice.ambiguous && !due.ambiguous) {
    const ok = invoice.readings.filter((r) => r <= due.iso)
    if (ok.length === 1) settle(invoice, ok[0]!)
  } else if (due.ambiguous && !invoice.ambiguous) {
    const ok = due.readings.filter((r) => r >= invoice.iso)
    if (ok.length === 1) settle(due, ok[0]!)
  }
}

function settle(r: DateReading, iso: string) {
  r.iso = iso
  r.readings = [iso, ...r.readings.filter((x) => x !== iso)]
  r.ambiguous = false
  r.resolvedBy = 'order'
}

export function plausibleYear(iso: string): boolean {
  const y = Number(iso.slice(0, 4))
  return y >= 1990 && y <= 2100
}

/** The normalized value to report: the settled reading, other readings kept only while ambiguous. */
export function normalizedDate(r: DateReading): NormalizedValue {
  return { kind: 'date', iso: r.iso, alternatives: r.ambiguous ? r.readings.slice(1) : [] }
}

export function conventionCheck(field: CanonicalField, raw: string, r: DateReading): ValidationCheck | null {
  if (!r.resolvedBy) return null
  const how =
    r.resolvedBy === 'convention'
      ? `the document's other dates (${r.witnesses.slice(0, 3).join(', ')}) fix the day/month order`
      : 'only this reading keeps invoice date ≤ due date'
  return {
    id: `date:${r.resolvedBy === 'convention' ? 'day-month-order' : 'order-disambiguation'}:${field}`,
    status: 'pass',
    fields: [field],
    expected: r.iso,
    actual: raw,
    message: `"${raw}" is ambiguous; ${how}, so it is ${r.iso} (not ${r.readings.slice(1).join(', ')}).`,
  }
}
