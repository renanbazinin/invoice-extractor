import type { ExtractedField, FieldCandidateLite, FieldStatus, LineItem, LineItemCandidate, NormalizedValue, ValidationCheck } from '../model/types'
import { abs, add, dec, div, fromInt, isDecimalString, isZero, mul, round, sub, sum, type Dec } from '../lib/decimal'
import { CUES, OCR } from './policy'
import { gradeDiff, type CheckEval, type Grade, type LineSums } from './arith'
import { toValidationCheck } from './build'
import { hasCue, overlaps, wordIdsOf, type DocIndex } from './evidence'
import { calibrate } from './confidence'

/**
 * Line items: per-row arithmetic (quantity × unit price = amount, with a line discount when one is
 * printed) and the sums the money selection closes against the totals.
 */

export interface RowAnalysis {
  cand: LineItemCandidate
  qty: Dec | null
  unit: Dec | null
  amount: Dec | null
  discountRow: boolean
  shippingRow: boolean
  check: CheckEval | null
  /** The row check used the line discount cell. */
  usedDiscount: boolean
}

export interface LineAnalysis {
  rows: RowAnalysis[]
  /** null when there are no rows or a row has no amount (the lines cannot close). */
  sums: LineSums | null
}

const HUNDRED = fromInt(100)

export function numberOfLite(c: FieldCandidateLite | null): Dec | null {
  if (!c) return null
  const n = c.normalized
  const v = n.kind === 'money' ? n.amount : n.kind === 'decimal' || n.kind === 'percent' ? n.value : null
  return v !== null && isDecimalString(v) ? dec(v) : null
}

function textOfLite(c: FieldCandidateLite | null): string {
  if (!c) return ''
  return c.normalized.kind === 'text' ? c.normalized.value : c.rawValue
}

const liteWords = (c: FieldCandidateLite | null) => new Set(c ? wordIdsOf(c.evidence) : [])

/** Analyzes the rows. `absMode` (credit note) compares magnitudes. */
export function analyzeLines(items: readonly LineItemCandidate[], absMode: boolean): LineAnalysis {
  const rows = items.map((cand) => analyzeRow(cand, absMode))
  if (!rows.length || rows.some((r) => r.amount === null)) return { rows, sums: null }
  const amounts = rows.map((r) => r.amount!)
  const fix = (d: Dec) => (absMode ? abs(d) : d)
  const hasDiscount = rows.some((r) => r.discountRow)
  const hasShipping = rows.some((r) => r.shippingRow)
  return {
    rows,
    sums: {
      all: fix(sum(amounts)),
      withoutDiscountRows: hasDiscount ? fix(sum(rows.filter((r) => !r.discountRow).map((r) => r.amount!))) : null,
      withoutShippingRows: hasShipping ? fix(sum(rows.filter((r) => !r.shippingRow).map((r) => r.amount!))) : null,
      count: rows.length,
      centsSure: rows.every((r) => !r.check || r.check.grade === 'exact'),
      byRate: sumsByRate(rows, fix),
    },
  }
}

/** Σ amounts per printed line VAT rate, when every row prints one and two or more rates differ. */
function sumsByRate(rows: readonly RowAnalysis[], fix: (d: Dec) => Dec): { rate: Dec; sum: Dec }[] | null {
  const byRate = new Map<string, { rate: Dec; amounts: Dec[] }>()
  for (const r of rows) {
    const rate = numberOfLite(r.cand.taxRate)
    if (!rate || rate.units < 0n) return null
    const key = String(Number(`${rate.units}e-${rate.scale}`))
    const entry = byRate.get(key)
    if (entry) entry.amounts.push(r.amount!)
    else byRate.set(key, { rate, amounts: [r.amount!] })
  }
  if (byRate.size < 2) return null
  return [...byRate.values()].map((x) => ({ rate: x.rate, sum: fix(sum(x.amounts)) }))
}

function analyzeRow(cand: LineItemCandidate, absMode: boolean): RowAnalysis {
  const qty = numberOfLite(cand.quantity)
  const unit = numberOfLite(cand.unitPrice)
  const amount = numberOfLite(cand.amount)
  const description = textOfLite(cand.description)
  const discountRow = hasCue(description, CUES.discountRow) || (!absMode && amount !== null && amount.units < 0n)
  const shippingRow = !discountRow && hasCue(description, CUES.shippingRow)
  let check: CheckEval | null = null
  let usedDiscount = false
  if (qty && unit && amount) {
    const r = rowCheck(cand, qty, unit, amount)
    check = r.check
    usedDiscount = r.usedDiscount
  }
  return { cand, qty, unit, amount, discountRow, shippingRow, check, usedDiscount }
}

/**
 * quantity × unit price = amount. The amount is compared to the product rounded to cents: no
 * difference is exact (every cell pinned); one cent is close (a printed unit price is itself
 * rounded, 33.33 for 33.333…, so the row is consistent but a one-cent misread would hide: it
 * verifies only embedded text). A larger difference up to |qty| × half a unit-price step is
 * approximate and never verifies. A line discount (percent or amount) is applied when printed;
 * signs are ignored as a fallback because discount and return rows print them inconsistently.
 */
function rowCheck(cand: LineItemCandidate, qty: Dec, unit: Dec, amount: Dec): { check: CheckEval; usedDiscount: boolean } {
  const product = mul(qty, unit)
  const variants: { expected: Dec; usedDiscount: boolean; note: string }[] = []
  const d = numberOfLite(cand.discount)
  if (d && !isZero(d)) {
    const discounted = cand.discount!.normalized.kind === 'percent' ? div(mul(product, sub(HUNDRED, d)), HUNDRED, 4) : sub(product, abs(d))
    variants.push({ expected: discounted, usedDiscount: true, note: 'line discount applied' })
  }
  variants.push({ expected: product, usedDiscount: false, note: '' })
  const halfStep: Dec = { units: 5n, scale: unit.scale + 1 }
  const wider = add(mul(abs(qty), halfStep), dec('0.01'))

  let best: { grade: Grade; expected: Dec; usedDiscount: boolean; note: string } | null = null
  for (const x of variants) {
    for (const signed of [true, false]) {
      const e = round(signed ? x.expected : abs(x.expected), 2)
      const a = signed ? amount : abs(amount)
      const grade = gradeDiff(abs(sub(e, a)), wider)
      const note = [x.note, signed ? '' : 'signs ignored', grade === 'approx' || grade === 'close' ? 'within unit-price rounding' : ''].filter(Boolean).join('; ')
      const cand2 = { grade, expected: e, usedDiscount: x.usedDiscount, note }
      if (!best || rank(grade) > rank(best.grade)) best = cand2
      if (grade === 'exact') break
    }
    if (best?.grade === 'exact') break
  }
  const b = best!
  // Two cells that are the same printed words prove nothing about each other.
  const independent = !overlaps(liteWords(cand.unitPrice), liteWords(cand.amount)) && !overlaps(liteWords(cand.quantity), liteWords(cand.amount))
  return {
    check: {
      id: `line:${cand.index}:qty*unit=amount`,
      kind: 'strong',
      grade: b.grade,
      fields: [],
      supports: [],
      coarse: [],
      formula: `quantity × unit price${b.usedDiscount ? ' − line discount' : ''} = amount`,
      expected: b.expected,
      actual: amount,
      note: independent ? b.note : [b.note, 'cells share words'].filter(Boolean).join('; '),
    },
    usedDiscount: b.usedDiscount,
  }
}

const rank = (g: Grade) => ({ exact: 3, close: 2, approx: 1, fail: 0 })[g]

/** Row checks are independent only when unit price and amount are different printed words. */
function rowIndependent(row: RowAnalysis): boolean {
  const c = row.cand
  return !overlaps(liteWords(c.unitPrice), liteWords(c.amount)) && !overlaps(liteWords(c.quantity), liteWords(c.amount))
}

export interface LineClosure {
  /** The closure check from the money selection, if one was evaluated. */
  check: CheckEval | null
}

/**
 * Turns analyzed rows into LineItems with statuses:
 * - row check exact (independent cells) → qty, unit, amount verified; row verified; close (one
 *   cent) → the same, but only when the three cells are embedded text;
 * - row check approx → proposed; row check fails → needs_review;
 * - no row check: the amount is verified when the line-sum closure passed (exact, or close on
 *   embedded text); the row is verified only if it has no unchecked quantity/unit;
 * - a failed closure makes rows without their own check needs_review.
 * Descriptions, SKUs, tax rates and extra cells are text nobody can check: at most proposed.
 */
export function buildLineItems(analysis: LineAnalysis, closure: LineClosure, doc: DocIndex): { items: LineItem[]; checks: ValidationCheck[] } {
  const checks: ValidationCheck[] = []
  const closureGrade = closure.check?.grade
  const closureSupports = closureGrade === 'exact' || closureGrade === 'close'
  const closureFail = closureGrade === 'fail'
  const digital = (lite: FieldCandidateLite | null) => !lite || doc.minConfidence(wordIdsOf(lite.evidence)) >= OCR.digital
  const items = analysis.rows.map((row) => {
    const c = row.cand
    const cellsDigital = digital(c.quantity) && digital(c.unitPrice) && digital(c.amount)
    const rowExact = rowIndependent(row) && (row.check?.grade === 'exact' || (row.check?.grade === 'close' && cellsDigital))
    // Exact and every row's own arithmetic exact: the closure pins each unchecked amount to the
    // cent. Otherwise it confirms only embedded-text amounts (role, not digits).
    const closurePass = closureSupports && ((closureGrade === 'exact' && !!analysis.sums?.centsSure) || digital(c.amount))
    if (row.check) checks.push(toRowValidationCheck(row.check))
    const rowCheckIds = row.check && row.check.grade !== 'fail' ? [row.check.id] : []
    const closureIds = closurePass && closure.check ? [closure.check.id] : []

    let numeric: FieldStatus
    if (row.check?.grade === 'fail') numeric = 'needs_review'
    else if (rowExact) numeric = 'verified'
    else if (row.check?.grade === 'approx' || (row.check && !rowExact)) numeric = 'proposed'
    else numeric = closureFail ? 'needs_review' : 'proposed'

    const amountStatus: FieldStatus = numeric === 'verified' || (!row.check && closurePass) ? 'verified' : numeric
    const failed = row.check?.grade === 'fail' ? 1 : 0
    const exactN = (rowExact ? 1 : 0) + (closurePass ? 1 : 0)
    const cell = (lite: FieldCandidateLite | null, status: FieldStatus, ids: string[], exact: number): ExtractedField | null =>
      lite ? liteField(lite, status, ids, exact, failed, doc) : null

    const amount = cell(c.amount, amountStatus, [...rowCheckIds, ...closureIds], exactN)
    const quantity = cell(c.quantity, numeric, rowCheckIds, rowExact ? 1 : 0)
    const unitPrice = cell(c.unitPrice, numeric, rowCheckIds, rowExact ? 1 : 0)
    const discount = cell(c.discount, row.usedDiscount ? numeric : textStatus(c.discount, doc), row.usedDiscount ? rowCheckIds : [], 0)
    const description = cell(c.description, textStatus(c.description, doc), [], 0)
    const taxRate = cell(c.taxRate, textStatus(c.taxRate, doc), [], 0)
    const sku = cell(c.sku, textStatus(c.sku, doc), [], 0)
    const extra: Record<string, ExtractedField> = {}
    for (const [k, v] of Object.entries(c.extra)) extra[k] = liteField(v, textStatus(v, doc), [], 0, 0, doc)

    const numericCells = [amount, quantity, unitPrice].filter((x): x is ExtractedField => x !== null)
    let status: FieldStatus
    if (!amount) status = numericCells.some((x) => x.status === 'needs_review') ? 'needs_review' : 'proposed'
    else if (numericCells.some((x) => x.status === 'needs_review')) status = 'needs_review'
    else if (numericCells.every((x) => x.status === 'verified')) status = 'verified'
    else status = 'proposed'

    const item: LineItem = { index: c.index, row: { ...c.row }, description, quantity, unitPrice, amount, taxRate, discount, sku, extra, status }
    return item
  })
  return { items, checks }
}

function textStatus(lite: FieldCandidateLite | null, doc: DocIndex): FieldStatus {
  if (!lite) return 'proposed'
  return doc.minConfidence(wordIdsOf(lite.evidence)) < OCR.weak ? 'needs_review' : 'proposed'
}

/** Line cells have no interpreter prior; 0.75 stands for "read from the right column". */
const CELL_PRIOR = 0.75

function liteField(lite: FieldCandidateLite, status: FieldStatus, checkIds: string[], exact: number, failed: number, doc: DocIndex): ExtractedField {
  const weakText = doc.minConfidence(wordIdsOf(lite.evidence)) < OCR.weak
  return {
    field: null,
    originalLabel: null,
    labelEvidence: null,
    rawValue: lite.rawValue,
    normalized: lite.normalized as NormalizedValue,
    evidence: lite.evidence,
    confidence: calibrate(CELL_PRIOR, status, { exact, failed, weakText }),
    status,
    method: 'table:cell',
    checks: checkIds,
    alternatives: [],
  }
}

export function toRowValidationCheck(c: CheckEval): ValidationCheck {
  return toValidationCheck(c)
}
