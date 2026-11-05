/**
 * Scores one extraction result against its ground truth, following the matching rules in
 * docs/ARCHITECTURE.md ("Matching rules used by the scorer"), and aggregates document scores
 * into the per-field report printed by eval/run.ts.
 *
 * Values are compared on what a consumer of the API reads: the normalized value when the
 * extractor produced one, otherwise the raw text. A field marked `verified` that is wrong (or that
 * should not exist at all) is counted separately, because that is the one failure the extractor
 * must never have.
 */
import { isDecimalString, sameDecimal } from '../src/lib/decimal'
import { foldForMatch } from '../src/lib/text'
import {
  CANONICAL_FIELDS,
  type CanonicalField,
  type ExtractedField,
  type ExtractionResult,
  type FieldStatus,
  type GroundTruth,
  type LineItem,
  type NormalizedValue,
} from '../src/model/types'

// ---------------------------------------------------------------------------------------------
// Normalisation and similarity

export type FieldKind = 'money' | 'percent' | 'date' | 'currency' | 'document_type' | 'id' | 'text' | 'phone' | 'address'

const KINDS: Record<CanonicalField, FieldKind> = {
  document_type: 'document_type',
  invoice_number: 'id',
  invoice_date: 'date',
  due_date: 'date',
  delivery_date: 'date',
  po_number: 'id',
  allocation_number: 'id',
  currency: 'currency',
  subtotal: 'money',
  discount: 'money',
  tax_rate: 'percent',
  tax_amount: 'money',
  total: 'money',
  amount_paid: 'money',
  amount_due: 'money',
  rounding: 'money',
  payment_terms: 'text',
  'supplier.name': 'text',
  'supplier.tax_id': 'id',
  'supplier.address': 'address',
  'supplier.phone': 'phone',
  'supplier.email': 'text',
  'supplier.bank_account': 'id',
  'customer.name': 'text',
  'customer.tax_id': 'id',
  'customer.address': 'address',
}

export function fieldKind(field: CanonicalField): FieldKind {
  return KINDS[field]
}

/** Ids: spaces, dashes, dots and slashes removed, case-folded. */
export function normalizeId(s: string): string {
  return s.normalize('NFKC').replace(/[\s  \-‐-―−./\\]/g, '').toLowerCase()
}

/** Names, terms, emails: foldForMatch, then punctuation, symbols and spaces removed. */
export function normalizeText(s: string): string {
  return foldForMatch(s).replace(/[\p{P}\p{S}\s]/gu, '')
}

/** Phones: digits only; an international 972 / 00972 prefix equals a leading 0. */
export function normalizePhone(s: string): string {
  let d = s.replace(/\D/g, '')
  if (d.startsWith('00972')) d = `0${d.slice(5)}`
  else if (d.startsWith('972')) d = `0${d.slice(3)}`
  if (d.startsWith('00')) d = d.slice(1)
  return d
}

export function tokens(s: string): Set<string> {
  return new Set(
    foldForMatch(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  )
}

/**
 * Token-set similarity: the Dice coefficient (F1) of the two token sets, 2|A∩B| / (|A|+|B|).
 * Dice rather than Jaccard so that one missing or one extra token in a five-token address still
 * passes 0.8, while a different street or city does not.
 */
export function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size && !tb.size) return 1
  if (!ta.size || !tb.size) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return (2 * common) / (ta.size + tb.size)
}

export const ADDRESS_THRESHOLD = 0.8
export const DESCRIPTION_THRESHOLD = 0.8

/** The value a consumer reads from a field: the normalized value, else the raw text. */
export function comparable(f: { rawValue: string; normalized: NormalizedValue | null }): string {
  const n = f.normalized
  if (!n) return f.rawValue
  switch (n.kind) {
    case 'money':
      return n.amount
    case 'percent':
    case 'decimal':
      return n.value
    case 'date':
      return n.iso
    case 'currency':
      return n.code
    case 'document_type':
      return n.value
    case 'id':
      return n.value
    case 'text':
      return n.value
  }
}

function numericEqual(expected: string, got: string): boolean {
  return isDecimalString(expected) && isDecimalString(got) && sameDecimal(expected, got)
}

/** True when an extracted value matches the expected one under the field's matching rule. */
export function valueMatches(field: CanonicalField, expected: string, got: { rawValue: string; normalized: NormalizedValue | null }): boolean {
  const v = comparable(got)
  switch (fieldKind(field)) {
    case 'money':
    case 'percent':
      return !!got.normalized && numericEqual(expected, v)
    case 'date':
      return got.normalized?.kind === 'date' && got.normalized.iso === expected
    case 'currency':
      return v.trim().toUpperCase() === expected.toUpperCase()
    case 'document_type':
      return v === expected
    case 'id':
      return normalizeId(v) === normalizeId(expected)
    case 'text':
      return normalizeText(v) === normalizeText(expected)
    case 'phone':
      return normalizePhone(v) !== '' && normalizePhone(v) === normalizePhone(expected)
    case 'address':
      return tokenSimilarity(v, expected) >= ADDRESS_THRESHOLD
  }
}

/**
 * A printed number in any of the corpus formats ("1,234.50", "1.234,50 €", "₪ 1 234,50") as a
 * canonical decimal, or null. Used only for extras, whose truth values are stored as printed.
 */
export function looseNumber(s: string): string | null {
  const t = s.replace(/[^\d,.\-]/g, '')
  // A minus only at either end ("-12.50", or "12.50-" as RTL printouts show it); inside, it is an id.
  if (!/\d/.test(t) || !/^-?[\d.,]+-?$/.test(t)) return null
  const neg = t.includes('-')
  const body = t.replace(/-/g, '')
  const lastDot = body.lastIndexOf('.')
  const lastComma = body.lastIndexOf(',')
  let int = body
  let frac = ''
  const sep = Math.max(lastDot, lastComma)
  if (sep >= 0) {
    const after = body.slice(sep + 1)
    const both = lastDot >= 0 && lastComma >= 0
    // A single separator followed by exactly three digits is a thousands separator ("1,234").
    if (both || (after.length !== 3 && after.length > 0)) {
      int = body.slice(0, sep)
      frac = after
    }
  }
  int = int.replace(/[.,]/g, '')
  if (!/^\d+$/.test(int) || (frac && !/^\d+$/.test(frac))) return null
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`
}

function looseEqual(expected: string, got: string): boolean {
  const a = normalizeText(expected)
  const b = normalizeText(got)
  if (a && a === b) return true
  const na = looseNumber(expected)
  const nb = looseNumber(got)
  // Numbers only when the truth is essentially a number (no letters), so "PRJ-1234" ≠ "1234".
  return !!na && !!nb && !/\p{L}/u.test(expected.replace(/(ILS|NIS|USD|EUR|ש"ח|ש״ח)/g, '')) && sameDecimal(na, nb)
}

function normLabel(s: string): string {
  return foldForMatch(s)
    .replace(/[\s:：.\-–]+$/u, '')
    .replace(/^[\s:：.\-–]+/u, '')
    .replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------------------------------------
// Document score

export type Outcome = 'correct' | 'wrong' | 'missed' | 'hallucinated' | 'absent_ok' | 'unscored'

export interface FieldScore {
  field: CanonicalField
  outcome: Outcome
  expected: string | null
  /** The extracted value as compared (normalized when available). */
  got: string | null
  gotRaw: string | null
  status: FieldStatus | null
  verified: boolean
  method: string | null
  confidence: number | null
  evidence: string | null
  label: string | null
  checks: string[]
  /** For a wrong/missed field: the expected value was among the alternatives. */
  inAlternatives: boolean
}

export interface LineMatch {
  truth: number
  /** Index into result.lineItems, or null when nothing aligned. */
  got: number | null
  full: boolean
  description: boolean
  amount: boolean
  quantity: boolean | null
  unitPrice: boolean | null
}

export interface LineItemScore {
  expected: number
  extracted: number
  /** Truth lines matched on every attribute the truth has. */
  matched: number
  matches: LineMatch[]
}

export interface ExtraMatch {
  label: string
  value: string
  found: boolean
  gotLabel: string | null
  gotValue: string | null
  /** A discovered field had the label but a different value. */
  labelOnly: boolean
}

export interface ExtraScore {
  expected: number
  found: number
  details: ExtraMatch[]
}

export interface DocCounts {
  truth: number
  found: number
  correct: number
  wrong: number
  missed: number
  verified: number
  verifiedCorrect: number
  verifiedWrong: number
  absent: number
  hallucinated: number
  hallucinatedVerified: number
}

export interface DocScore {
  id: string
  file: string
  error: string | null
  fields: FieldScore[]
  counts: DocCounts
  lineItems: LineItemScore
  extras: ExtraScore
  summaryStatus: FieldStatus | null
}

function evidenceText(f: ExtractedField): string | null {
  return f.evidence.length ? f.evidence.map((e) => e.text).join(' | ') : null
}

function scoreField(field: CanonicalField, truth: GroundTruth, result: ExtractionResult | null): FieldScore {
  const expected = truth.fields[field] ?? null
  const absent = truth.absent.includes(field)
  const got = result?.fields[field] ?? null
  const base: FieldScore = {
    field,
    outcome: 'unscored',
    expected,
    got: got ? comparable(got) : null,
    gotRaw: got?.rawValue ?? null,
    status: got?.status ?? null,
    verified: got?.status === 'verified',
    method: got?.method ?? null,
    confidence: got?.confidence ?? null,
    evidence: got ? evidenceText(got) : null,
    label: got?.originalLabel ?? null,
    checks: got?.checks ?? [],
    inAlternatives: false,
  }
  if (expected !== null) {
    if (!got) return { ...base, outcome: 'missed' }
    // A bilingual document can print the same fact twice (a Hebrew and an English legal name);
    // the truth then lists the other printing as acceptable.
    const accepted = [expected, ...(truth.alternatives?.[field] ?? [])]
    const ok = accepted.some((e) => valueMatches(field, e, got))
    const inAlternatives = !ok && got.alternatives.some((a) => accepted.some((e) => valueMatches(field, e, a)))
    return { ...base, outcome: ok ? 'correct' : 'wrong', inAlternatives }
  }
  if (absent) return { ...base, outcome: got ? 'hallucinated' : 'absent_ok' }
  return base
}

function lineAttr(f: ExtractedField | null): { rawValue: string; normalized: NormalizedValue | null } | null {
  return f ? { rawValue: f.rawValue, normalized: f.normalized } : null
}

function numberMatches(expected: string, f: ExtractedField | null): boolean {
  const a = lineAttr(f)
  return !!a && !!a.normalized && numericEqual(expected, comparable(a))
}

export function descriptionMatches(expected: string, got: string): boolean {
  return normalizeText(expected) === normalizeText(got) || tokenSimilarity(expected, got) >= DESCRIPTION_THRESHOLD
}

function compareLine(t: GroundTruth['lineItems'][number], e: LineItem): Omit<LineMatch, 'truth' | 'got'> {
  const description = !!e.description && descriptionMatches(t.description, comparable(e.description))
  const amount = t.amount === undefined ? true : numberMatches(t.amount, e.amount)
  const quantity = t.quantity === undefined ? null : numberMatches(t.quantity, e.quantity)
  const unitPrice = t.unitPrice === undefined ? null : numberMatches(t.unitPrice, e.unitPrice)
  const full = description && amount && quantity !== false && unitPrice !== false
  return { full, description, amount, quantity, unitPrice }
}

/**
 * Aligns truth lines and extracted lines in order (an LCS-style dynamic programme), preferring
 * full matches and otherwise lines that agree on the amount or the description, so a single
 * missing or extra row does not shift every following line out of alignment.
 */
export function scoreLineItems(truthLines: GroundTruth['lineItems'], got: LineItem[]): LineItemScore {
  const n = truthLines.length
  const m = got.length
  const cmp = truthLines.map((t) => got.map((e) => compareLine(t, e)))
  const weight = (i: number, j: number): number => {
    const c = cmp[i][j]
    return c.full ? 4 : (c.amount && truthLines[i].amount !== undefined ? 1 : 0) + (c.description ? 1 : 0)
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const w = weight(i, j)
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], w > 0 ? w + dp[i + 1][j + 1] : 0)
    }
  const matches: LineMatch[] = truthLines.map((_, i) => ({ truth: i, got: null, full: false, description: false, amount: false, quantity: null, unitPrice: null }))
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const w = weight(i, j)
    if (w > 0 && dp[i][j] === w + dp[i + 1][j + 1]) {
      matches[i] = { truth: i, got: j, ...cmp[i][j] }
      i++
      j++
    } else if (dp[i][j] === dp[i + 1][j]) i++
    else j++
  }
  return { expected: n, extracted: m, matched: matches.filter((x) => x.full).length, matches }
}

export function scoreExtras(truthExtras: GroundTruth['extra'], discovered: ExtractedField[]): ExtraScore {
  const details = truthExtras.map((x): ExtraMatch => {
    const want = normLabel(x.label)
    const labelled = discovered.filter((d) => {
      const have = normLabel(d.originalLabel ?? '')
      return have !== '' && (have === want || have.includes(want))
    })
    const hit = labelled.find((d) => looseEqual(x.value, d.rawValue) || looseEqual(x.value, comparable(d)))
    return {
      label: x.label,
      value: x.value,
      found: !!hit,
      gotLabel: (hit ?? labelled[0])?.originalLabel ?? null,
      gotValue: (hit ?? labelled[0])?.rawValue ?? null,
      labelOnly: !hit && labelled.length > 0,
    }
  })
  return { expected: details.length, found: details.filter((d) => d.found).length, details }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Scores one document. A null result (crash, timeout) scores every truth field as missed. */
export function scoreDocument(result: ExtractionResult | null, truth: GroundTruth, error?: unknown): DocScore {
  const usable = result && typeof result === 'object' && result.fields ? result : null
  const fields = CANONICAL_FIELDS.map((f) => scoreField(f, truth, usable))
  const scored = fields.filter((f) => f.outcome !== 'unscored')
  const count = (pred: (f: FieldScore) => boolean): number => scored.filter(pred).length
  const counts: DocCounts = {
    truth: count((f) => f.expected !== null),
    found: count((f) => f.expected !== null && f.outcome !== 'missed'),
    correct: count((f) => f.outcome === 'correct'),
    wrong: count((f) => f.outcome === 'wrong'),
    missed: count((f) => f.outcome === 'missed'),
    verified: count((f) => f.expected !== null && f.verified),
    verifiedCorrect: count((f) => f.outcome === 'correct' && f.verified),
    verifiedWrong: count((f) => f.outcome === 'wrong' && f.verified),
    absent: count((f) => f.outcome === 'hallucinated' || f.outcome === 'absent_ok'),
    hallucinated: count((f) => f.outcome === 'hallucinated'),
    hallucinatedVerified: count((f) => f.outcome === 'hallucinated' && f.verified),
  }
  return {
    id: truth.id,
    file: truth.file,
    error: error !== undefined ? errorText(error) : usable ? null : result ? 'result has no fields' : 'no result',
    fields,
    counts,
    lineItems: scoreLineItems(truth.lineItems, usable?.lineItems ?? []),
    extras: scoreExtras(truth.extra, usable?.discovered ?? []),
    summaryStatus: usable?.summary?.status ?? null,
  }
}

// ---------------------------------------------------------------------------------------------
// Aggregation

export interface FieldStats {
  field: CanonicalField
  /** Documents whose truth has the field. */
  n: number
  found: number
  correct: number
  wrong: number
  missed: number
  verified: number
  verifiedCorrect: number
  verifiedWrong: number
  /** Documents where the field is declared absent. */
  absentN: number
  hallucinated: number
  hallucinatedVerified: number
  accuracy: number | null
  /** Correct verified / all verified (hallucinated verified values included). */
  verifiedPrecision: number | null
  /** Correct and verified / n. */
  autoRate: number | null
}

export interface Aggregate {
  documents: number
  errors: number
  fields: FieldStats[]
  total: Omit<FieldStats, 'field'>
  lineItems: { expected: number; extracted: number; matched: number; recall: number | null; precision: number | null }
  extras: { expected: number; found: number; recall: number | null }
  /** Documents whose every truth field is correct, with no hallucination. */
  perfectDocuments: number
}

const ratio = (a: number, b: number): number | null => (b ? a / b : null)

function stats(scores: FieldScore[]): Omit<FieldStats, 'field'> {
  const c = (pred: (f: FieldScore) => boolean): number => scores.filter(pred).length
  const n = c((f) => f.expected !== null)
  const correct = c((f) => f.outcome === 'correct')
  const verified = c((f) => f.expected !== null && f.verified)
  const verifiedCorrect = c((f) => f.outcome === 'correct' && f.verified)
  const hallucinatedVerified = c((f) => f.outcome === 'hallucinated' && f.verified)
  return {
    n,
    found: c((f) => f.expected !== null && f.outcome !== 'missed'),
    correct,
    wrong: c((f) => f.outcome === 'wrong'),
    missed: c((f) => f.outcome === 'missed'),
    verified,
    verifiedCorrect,
    verifiedWrong: c((f) => f.outcome === 'wrong' && f.verified),
    absentN: c((f) => f.outcome === 'hallucinated' || f.outcome === 'absent_ok'),
    hallucinated: c((f) => f.outcome === 'hallucinated'),
    hallucinatedVerified,
    accuracy: ratio(correct, n),
    verifiedPrecision: ratio(verifiedCorrect, verified + hallucinatedVerified),
    autoRate: ratio(verifiedCorrect, n),
  }
}

export function aggregate(docs: DocScore[]): Aggregate {
  const all = docs.flatMap((d) => d.fields)
  const fields = CANONICAL_FIELDS.map((field) => ({ field, ...stats(all.filter((f) => f.field === field)) }))
  const li = docs.reduce((a, d) => ({ expected: a.expected + d.lineItems.expected, extracted: a.extracted + d.lineItems.extracted, matched: a.matched + d.lineItems.matched }), { expected: 0, extracted: 0, matched: 0 })
  const ex = docs.reduce((a, d) => ({ expected: a.expected + d.extras.expected, found: a.found + d.extras.found }), { expected: 0, found: 0 })
  return {
    documents: docs.length,
    errors: docs.filter((d) => d.error).length,
    fields,
    total: stats(all),
    lineItems: { ...li, recall: ratio(li.matched, li.expected), precision: ratio(li.matched, li.extracted) },
    extras: { ...ex, recall: ratio(ex.found, ex.expected) },
    perfectDocuments: docs.filter((d) => !d.error && d.counts.correct === d.counts.truth && d.counts.hallucinated === 0).length,
  }
}

/**
 * How bad a document is, for the "worst documents" list: a wrong verified value or a verified
 * hallucination weighs most, then crashes, then plain errors and misses.
 */
export function badness(d: DocScore): number {
  return (d.error ? 50 : 0) + 20 * (d.counts.verifiedWrong + d.counts.hallucinatedVerified) + 3 * (d.counts.wrong + d.counts.hallucinated) + d.counts.missed + (d.lineItems.expected - d.lineItems.matched) * 0.25
}
