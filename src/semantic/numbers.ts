import type { DecimalString } from '../model/types'
import { currencyHits } from './currency'
import { foldValue, originalSpan, type MappedText } from './normalize'
import type { AmountParse, NumberFormat, Span } from './types'

/**
 * Printed numbers → exact decimal strings. Never floats. The one real ambiguity is a lone
 * separator followed by exactly three digits ("1,234" / "1.234"): grouping is the likelier reading
 * on invoices, but the document's own format (inferNumberFormat over all its numbers) decides
 * when known, and the parse says when it was a default (`ambiguous`, `alternative`).
 */

interface NumberReading {
  int: string
  frac: string
  ambiguous: boolean
  alternative: DecimalString | null
}

const SEPARATORS = /[.,' ]/g

/** Thousands groups: a first group of 1-3 digits without a leading zero, then groups of exactly 3. */
function validGroups(intPart: string, sep: string): boolean {
  const groups = intPart.split(sep)
  if (!/^\d{1,3}$/.test(groups[0]) || /^0/.test(groups[0])) return false
  return groups.slice(1).every((g) => /^\d{3}$/.test(g))
}

function decimalString(int: string, frac: string): DecimalString {
  return frac ? `${int}.${frac}` : int
}

/** An integer part with a leading zero ("05", "007") is an id or a phone, not an amount. */
function validInt(int: string): boolean {
  return /^\d+$/.test(int) && !(int.length > 1 && int.startsWith('0'))
}

/**
 * Reads a bare number made of digits and . , ' or space separators. Returns null for anything
 * that is not one consistent number ("31.10.2026", "12 34", "1,23,4").
 */
export function readNumber(body: string, fmt?: NumberFormat): NumberReading | null {
  if (!/^[\d.,' ]+$/.test(body) || !/\d/.test(body)) return null
  if (/^[.,]\d+$/.test(body)) return { int: '0', frac: body.slice(1), ambiguous: false, alternative: null }
  if (!/^\d/.test(body) || !/\d$/.test(body)) return null
  const seps = [...body.matchAll(SEPARATORS)].map((m) => ({ ch: m[0], at: m.index }))
  if (!seps.length) return validInt(body) ? { int: body, frac: '', ambiguous: false, alternative: null } : null
  const kinds = new Set(seps.map((s) => s.ch))
  const last = seps[seps.length - 1]
  if (kinds.size >= 2) {
    // "1,234.56", "1.234,56", "1 234,56", "1'234.56": the last separator is the decimal one.
    if (last.ch !== '.' && last.ch !== ',') return null
    if (seps.filter((s) => s.ch === last.ch).length !== 1) return null
    const groupChars = new Set(seps.slice(0, -1).map((s) => s.ch))
    if (groupChars.size !== 1) return null
    const intPart = body.slice(0, last.at)
    const g = [...groupChars][0]
    if (!validGroups(intPart, g)) return null
    return { int: intPart.split(g).join(''), frac: body.slice(last.at + 1), ambiguous: false, alternative: null }
  }
  const c = last.ch
  if (c === ' ' || c === "'" || seps.length >= 2) {
    // Only grouping: "1 234", "1'234", "1.234.567", "1,234,567".
    return validGroups(body, c) ? { int: body.split(c).join(''), frac: '', ambiguous: false, alternative: null } : null
  }
  const intPart = body.slice(0, last.at)
  const frac = body.slice(last.at + 1)
  if (!validInt(intPart)) return null
  if (frac.length !== 3 || intPart.length > 3 || intPart === '0') {
    return { int: intPart, frac, ambiguous: false, alternative: null }
  }
  // "1,234" / "1.234": three digits after a lone separator.
  const known = fmt && fmt.confidence > 0
  const asDecimal = known ? fmt.decimal === c : false
  const ambiguous = !known || fmt.confidence < 0.5
  return asDecimal
    ? { int: intPart, frac, ambiguous, alternative: intPart + frac }
    : { int: intPart + frac, frac: '', ambiguous, alternative: `${intPart}.${frac}` }
}

/**
 * Blanks out currency mentions (same length, so offsets keep working). A mark without a default
 * code ("kr") is blanked but names no code; `ambiguous` when every mark is a shared one ("$").
 */
function withoutCurrency(v: MappedText): { text: string; codes: string[]; ambiguous: boolean; from: number; to: number } {
  const hits = currencyHits(v)
  let text = v.text
  for (const h of hits) text = text.slice(0, h.from) + ' '.repeat(h.to - h.from) + text.slice(h.to)
  return {
    text,
    codes: [...new Set(hits.filter((h) => h.code).map((h) => h.code))],
    ambiguous: hits.length > 0 && hits.every((h) => h.ambiguous),
    from: hits.length ? Math.min(...hits.map((h) => h.from)) : Infinity,
    to: hits.length ? Math.max(...hits.map((h) => h.to)) : -Infinity,
  }
}

const AMOUNT_SHAPE = /^(\(\s*)?([+-]\s*)?(\d[\d.,' ]*\d|\d|[.,]\d+)((?:[.,]-)?)(\s*-)?(\s*\))?$/

function parseMapped(v: MappedText, fmt: NumberFormat | undefined): AmountParse | null {
  const stripped = withoutCurrency(v)
  if (stripped.codes.length > 1) return null
  const body = stripped.text.trim()
  if (!body) return null
  const m = AMOUNT_SHAPE.exec(body)
  if (!m) return null
  const [, open, sign, num, dashCents, trailingMinus, close] = m
  if (!!open !== !!close) return null
  const signs = [open, sign?.startsWith('-'), trailingMinus].filter(Boolean).length
  if (signs > 1) return null
  const reading = readNumber(num, fmt)
  if (!reading) return null
  if (dashCents && reading.frac) return null
  const negative = signs === 1 && !sign?.startsWith('+')
  const value = decimalString(reading.int, reading.frac)
  const isZero = !/[1-9]/.test(value)
  const lead = stripped.text.length - stripped.text.trimStart().length
  const tail = stripped.text.trimEnd().length
  const from = Math.min(lead, stripped.from)
  const to = Math.max(tail, stripped.to)
  const { start, end } = originalSpan(v, from, to)
  const alt = reading.alternative
  return {
    amount: negative && !isZero ? `-${value}` : value,
    currency: stripped.codes[0] ?? null,
    ...(stripped.ambiguous ? { currencyAmbiguous: true } : {}),
    negative: negative && !isZero,
    decimals: reading.frac.length,
    ambiguous: reading.ambiguous,
    alternative: alt && negative ? `-${alt}` : alt,
    raw: v.source.slice(start, end),
    start,
    end,
  }
}

/**
 * Parses a text that is one amount, optionally with a currency (symbol, code or word, before or
 * after, with or without a space) and a sign: -123.45, 123.45-, (123.45), −123.45. Returns null
 * when the text is anything else: a date, a phone number, a percentage, two numbers, an id with a
 * leading zero. Use findAmounts to scan a line.
 */
export function parseAmount(text: string, fmt?: NumberFormat): AmountParse | null {
  return parseMapped(foldValue(text), fmt)
}

/** True when the original text joins these digits with a no-break or thin space (a grouping sign). */
function joinedByGroupSpace(source: string, from: number, to: number): boolean {
  return /\d[    ]\d/.test(source.slice(from, to))
}

const PERCENT_NEXT = /^(?:%|אחוז|אחוזים|percent|pct|prozent)/i

/**
 * Every amount in a line, left to right (integers included: deciding whether "2026" is money is
 * interpretation's job). Tokens are tried in windows of up to three ("₪ 1,180.00", "1 234,56"),
 * longest first. A space as thousands separator is only accepted when the document format says so
 * or the space is a no-break/thin space, so "2 100.00" (quantity, price) stays two numbers.
 * Numbers next to '%' are percentages, not amounts.
 */
export function findAmounts(text: string, fmt?: NumberFormat): AmountParse[] {
  const v = foldValue(text)
  const tokens: { from: number; to: number }[] = []
  for (const m of v.text.matchAll(/[^\s:|=]+/g)) tokens.push({ from: m.index, to: m.index + m[0].length })
  const out: AmountParse[] = []
  for (let i = 0; i < tokens.length; ) {
    let taken = 0
    for (let n = Math.min(3, tokens.length - i); n >= 1 && !taken; n--) {
      const from = tokens[i].from
      const to = tokens[i + n - 1].to
      const slice: MappedText = {
        text: v.text.slice(from, to),
        start: v.start.slice(from, to),
        end: v.end.slice(from, to),
        source: v.source,
      }
      const p = parseMapped(slice, fmt)
      if (!p) continue
      if (/\d \d/.test(slice.text) && fmt?.group !== ' ' && !joinedByGroupSpace(v.source, p.start, p.end)) continue
      const next = tokens[i + n] ? v.text.slice(tokens[i + n].from, tokens[i + n].to) : ''
      const prev = i > 0 ? v.text.slice(tokens[i - 1].from, tokens[i - 1].to) : ''
      // "% 18" (RTL logical order) is a percent; "18% 180.00" is a percent then an amount.
      if (PERCENT_NEXT.test(next) || (prev.endsWith('%') && !/\d/.test(prev))) continue
      out.push(p)
      taken = n
    }
    i += taken || 1
  }
  return out
}

/**
 * The decimal and grouping separators of a document, voted by all its numbers: "1,234.56" and
 * "1.234,56" are decisive, "12,50" (two decimals) is good evidence, "1.234.567" says grouping,
 * "1,234" says nothing. Dates and other non-numbers are skipped. With no evidence the result is
 * '.' / ',' with confidence 0 (Hebrew and English invoices use '.').
 */
export function inferNumberFormat(samples: readonly string[]): NumberFormat {
  const votes = { '.': 0, ',': 0 }
  const groupVotes = new Map<string, number>()
  const vote = (decimal: '.' | ',', weight: number, group?: string): void => {
    votes[decimal] += weight
    if (group) groupVotes.set(group, (groupVotes.get(group) ?? 0) + weight)
  }
  for (const sample of samples) {
    const v = foldValue(sample)
    for (const m of v.text.matchAll(/(?<![\d.,'/-])\d[\d.,']*\d(?![\d/]|[.,'-]\d)/g)) {
      const tok = m[0]
      const seps = tok.match(/[.,']/g) ?? []
      if (!seps.length) continue
      const kinds = [...new Set(seps)]
      const last = seps[seps.length - 1] as '.' | ',' | "'"
      if (kinds.length >= 2) {
        if (last === "'" || seps.filter((s) => s === last).length !== 1) continue
        const r = readNumber(tok)
        if (r) vote(last, 2, kinds.find((k) => k !== last))
        continue
      }
      if (last === "'") {
        if (readNumber(tok)) groupVotes.set("'", (groupVotes.get("'") ?? 0) + 1)
        continue
      }
      if (seps.length >= 2) {
        if (validGroups(tok, last)) vote(last === '.' ? ',' : '.', 1, last)
        continue
      }
      const frac = tok.length - tok.lastIndexOf(last) - 1
      if (frac === 2) vote(last, 1.5)
      else if (frac === 1 || frac >= 4) vote(last, 0.5)
    }
    for (const m of v.source.matchAll(/\d{1,3}(?:[    ]\d{3})+[.,]\d{1,2}(?!\d)/g)) {
      const dec = m[0].slice(-3).match(/[.,]/)?.[0] as '.' | ',' | undefined
      if (dec) vote(dec, 1, ' ')
    }
  }
  const total = votes['.'] + votes[',']
  const decimal: '.' | ',' = votes[','] > votes['.'] ? ',' : '.'
  let group: NumberFormat['group'] = decimal === '.' ? ',' : '.'
  let bestGroup = 0
  for (const [g, n] of groupVotes) {
    if (g !== decimal && n > bestGroup) {
      bestGroup = n
      group = g as NumberFormat['group']
    }
  }
  if (!total) return { decimal: '.', group: groupVotes.has("'") ? "'" : ',', confidence: 0 }
  const support = Math.max(votes['.'], votes[',']) / total
  const confidence = Math.round(support * (1 - 1 / (1 + total)) * 100) / 100
  return { decimal, group, confidence }
}

export interface PercentParse extends Span {
  value: DecimalString
}

const NUM = '[-+]?\\d+(?:[.,]\\d+)?'
const PERCENT_WORDS = '(?:אחוזים|אחוז|percent|per cent|pct\\.?|prozent|pour ?cent|por ?ciento|per ?cento|procent|por cento)'

function percentValue(num: string): DecimalString | null {
  const s = num.replace(',', '.').replace(/^\+/, '')
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null
  const n = s.replace(/^-/, '')
  if (n.split('.')[0].length > 1 && n.startsWith('0')) return null
  const intPart = Number(n.split('.')[0])
  if (intPart > 100 || (intPart === 100 && /\.\d*[1-9]/.test(n))) return null
  return s
}

/**
 * Finds a percentage in a text: "18%", "18.00 %", "% 18" (RTL logical order), "17 אחוז",
 * "מע"מ 18%". A number glued to '%' wins over one separated by a space; the left side wins ties.
 * Values above 100 are rejected.
 */
export function parsePercent(text: string): PercentParse | null {
  const v = foldValue(text)
  type Hit = { num: string; from: number; to: number; tight: boolean; rank: number }
  const hits: Hit[] = []
  for (const m of v.text.matchAll(new RegExp(`(?<![\\d.,])(${NUM})(\\s?)%`, 'g'))) {
    hits.push({ num: m[1], from: m.index, to: m.index + m[0].length, tight: !m[2], rank: 0 })
  }
  for (const m of v.text.matchAll(new RegExp(`%(\\s?)(${NUM})(?![\\d]|[.,]\\d)`, 'g'))) {
    hits.push({ num: m[2], from: m.index, to: m.index + m[0].length, tight: !m[1], rank: 1 })
  }
  for (const m of v.text.matchAll(new RegExp(`(?<![\\d.,])(${NUM})\\s?${PERCENT_WORDS}(?!\\p{L})`, 'giu'))) {
    hits.push({ num: m[1], from: m.index, to: m.index + m[0].length, tight: true, rank: 2 })
  }
  hits.sort((a, b) => Number(b.tight) - Number(a.tight) || a.rank - b.rank || a.from - b.from)
  for (const h of hits) {
    const value = percentValue(h.num)
    if (value === null) continue
    const { start, end } = originalSpan(v, h.from, h.to)
    return { value, raw: text.slice(start, end), start, end }
  }
  return null
}

export interface QuantityParse extends Span {
  value: DecimalString
  unit: string | null
}

const UNITS =
  `(?:יח'|יח|יחידות|יחידה|שעות|שעה|ש'|ק"ג|קג|גרם|ג'|מ"ר|מ'|מטר|ליטר|ל'|חבילות|חבילה|ימים|יום|` +
  `pcs?\\.?|pieces?|units?|ea\\.?|each|hrs?\\.?|hours?|h|kgs?|g|m2|m²|m|lt?r?s?|l|boxe?s?|pkgs?|sets?|days?|` +
  `stk\\.?|stück|st\\.?|std\\.?|pz\\.?|uds?\\.?|unid\\.?|u\\.?|x)`

/**
 * A quantity cell: a number with an optional unit before or after ("3", "2.5", "1,5", "10 יח'",
 * "3 hrs", "x2"). Negative quantities (returns) are kept.
 */
export function parseQuantity(text: string, fmt?: NumberFormat): QuantityParse | null {
  const v = foldValue(text)
  const t = v.text
  const re = new RegExp(`^(?:x\\s?)?([-+]?)(\\d[\\d.,' ]*\\d|\\d|[.,]\\d+)\\s?(${UNITS})?\\.?$|^(${UNITS})\\s?([-+]?)(\\d[\\d.,' ]*\\d|\\d)$`, 'iu')
  const m = re.exec(t)
  if (!m) return null
  const sign = m[1] ?? m[5] ?? ''
  const num = m[2] ?? m[6]
  const unit = m[3] ?? m[4] ?? null
  if (/\d \d/.test(num) && fmt?.group !== ' ' && !joinedByGroupSpace(text, 0, text.length)) return null
  const r = readNumber(num, fmt)
  if (!r) return null
  const value = decimalString(r.int, r.frac)
  const { start, end } = originalSpan(v, 0, t.length)
  return {
    value: sign === '-' && /[1-9]/.test(value) ? `-${value}` : value,
    unit: unit && unit.toLowerCase() !== 'x' ? unit : null,
    raw: text.slice(start, end),
    start,
    end,
  }
}
