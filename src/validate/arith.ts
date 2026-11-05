import type { CanonicalField } from '../model/types'
import { abs, add, cmp, dec, div, fromInt, isZero, mul, round, str, sub, type Dec } from '../lib/decimal'
import { MAX_TAX_RATE, TOLERANCE } from './policy'
import { overlaps } from './evidence'

/**
 * The money constraints, as pure functions over one assignment of values. The joint selection
 * calls them for every combination it scores and once more for the final report, so the checks
 * that pick values and the checks that are reported are the same code.
 *
 * Precision matters as much as passing. A check verifies a field only if a one-cent change of that
 * field would break it:
 *  - `supports` lists the fields a check pins to the cent when it closes with no difference at all
 *    (subtotal + tax = total: any misread digit shows);
 *  - `coarse` lists fields the check pins only to within rounding (tax = 17% × subtotal cannot
 *    tell 44,387.44 from 44,387.47). Coarse support confirms the field's role but not its last
 *    digits, so it can only verify text that cannot be misread (an embedded PDF text layer).
 * A check that closes within one rounding step ('close') gives every field coarse support only.
 */

export type MoneyVar = 'subtotal' | 'discount' | 'tax_amount' | 'tax_rate' | 'total' | 'amount_paid' | 'amount_due' | 'rounding'

/** Enumeration order: the fields most constraints touch first. */
export const MONEY_VARS: readonly MoneyVar[] = ['total', 'subtotal', 'tax_amount', 'tax_rate', 'discount', 'amount_due', 'amount_paid', 'rounding']

export interface ArithValue {
  /** As used in arithmetic: discount positive; absolute values on a credit note. */
  value: Dec
  wordIds: ReadonlySet<string>
  /** tax printed as "of which VAT" (מתוכו מע"מ): the document's prices include tax. */
  inclusive?: boolean
}

export type ArithValues = Partial<Record<MoneyVar, ArithValue>>

/**
 * exact: no difference. close: within one rounding step (0.01). approx: within a wider, documented
 * tolerance (per-line rounding, cash rounding) — passes but never verifies. fail.
 */
export type Grade = 'exact' | 'close' | 'approx' | 'fail'

/**
 * strong: a closure between independent printed values (verifies, fails loudly).
 * soft: the line-sum closure (verifies; a failure is more often a missed row than a wrong total).
 * corroboration: an equality of two printings that does not prove the field's role (never verifies).
 * identity: the same printed figure used for two fields (no information).
 * sanity: a range check (tax at most 30% of its base); it can only fail, never verify.
 */
export type CheckKind = 'strong' | 'soft' | 'corroboration' | 'identity' | 'sanity'

export interface CheckEval {
  id: string
  kind: CheckKind
  grade: Grade
  /** Every field the check reads. */
  fields: CanonicalField[]
  /** Fields an exact pass pins to the cent. */
  supports: CanonicalField[]
  /** Fields a pass pins only to within rounding (role confirmed, last digits not). */
  coarse: CanonicalField[]
  /** e.g. 'subtotal - discount + tax_amount = total' */
  formula: string
  expected: Dec
  actual: Dec
  note: string
}

export interface LineSums {
  /** Σ of every item row's amount. */
  all: Dec
  /** Σ without rows that are discounts (הנחה / discount / negative amounts). */
  withoutDiscountRows: Dec | null
  /** Σ without shipping/handling rows. */
  withoutShippingRows: Dec | null
  count: number
  /**
   * Every row that has quantity × unit price closes exactly. When a row is off by a cent, the
   * rows' sum is uncertain by that much and confirms totals only coarsely.
   */
  centsSure: boolean
  /** Σ line amounts per printed VAT rate, when every row prints its rate and two or more differ. */
  byRate?: { rate: Dec; sum: Dec }[] | null
}

export interface ArithContext {
  lines: LineSums | null
  /** A printed rounding line or cash payment exists: rounded totals (±0.05) pass, without verifying. */
  cash: boolean
  /** Item rows, for per-line tax rounding. */
  lineCount: number
  /**
   * The page mentions a rounding (עיגול). A closure through the total that leaves the rounding
   * out can then be exact only by coincidence (a misread cent absorbing it), so it is at best
   * 'close'.
   */
  roundingMentioned?: boolean
  /**
   * Printed adjustments between the total and the amount due that no field holds: a previous
   * balance carried in (due = total + previous) or a retention / tax withheld (due = total −
   * retention). See printed.ts.
   */
  adjustments?: readonly { sign: 'add' | 'sub'; kind: string; value: Dec; label: string; wordIds: readonly string[] }[]
  /**
   * The page prints no tax separately (exempt dealer, "כולל מע"מ"): the lines then sum to the total
   * itself, so Σ lines = total confirms the total. See printed.ts.
   */
  noSeparateTax?: boolean
}

const STEP = dec(TOLERANCE.step)
const CASH = dec(TOLERANCE.cash)
const HUNDRED = fromInt(100)
/** A rate step of 0.5 points moves the tax by at least a cent only on a base of 2.00 or more. */
const MIN_BASE_FOR_RATE = fromInt(2)

/** n rounding steps of 0.01. */
function steps(n: number): Dec {
  return { units: BigInt(n), scale: 2 }
}

function maxDec(a: Dec | null, b: Dec | null): Dec | null {
  if (!a) return b
  if (!b) return a
  return cmp(a, b) >= 0 ? a : b
}

export function gradeDiff(diff: Dec, wider: Dec | null): Grade {
  if (isZero(diff)) return 'exact'
  if (cmp(diff, STEP) <= 0) return 'close'
  if (wider && cmp(diff, wider) <= 0) return 'approx'
  return 'fail'
}

export const passes = (g: Grade) => g !== 'fail'

/** Caps an exact grade at 'close' when a mentioned rounding is not part of the closure. */
function capForRounding(grade: Grade, R: ArithValue | undefined, ctx: ArithContext): Grade {
  return grade === 'exact' && !R && ctx.roundingMentioned ? 'close' : grade
}

/** The fields a check confirms to the cent (precise) or only by role (coarse), given its grade. */
export function supportOf(c: CheckEval, field: CanonicalField): 'precise' | 'coarse' | null {
  if (c.grade === 'exact') return c.supports.includes(field) ? 'precise' : c.coarse.includes(field) ? 'coarse' : null
  if (c.grade === 'close') return c.supports.includes(field) || c.coarse.includes(field) ? 'coarse' : null
  return null
}

/** Evaluates every money constraint whose inputs are present. */
export function evaluateMoneyChecks(v: ArithValues, ctx: ArithContext): CheckEval[] {
  const out: CheckEval[] = []
  for (const check of [checkSum, checkRate, checkImpliedTotal, checkPayment, checkLines, checkTaxShare, checkRatedTax]) {
    const r = check(v, ctx)
    if (Array.isArray(r)) out.push(...r)
    else if (r) out.push(r)
  }
  return out
}

/** subtotal − discount + tax (+ rounding) = total. Every term is pinned to the cent. */
function checkSum(v: ArithValues, ctx: ArithContext): CheckEval | null {
  const { subtotal: S, discount: D, tax_amount: T, total: G, rounding: R } = v
  if (!S || !T || !G) return null
  let lhs = add(S.value, T.value)
  if (D) lhs = sub(lhs, D.value)
  if (R) lhs = add(lhs, R.value)
  const nSteps = 1 + (D ? 1 : 0) + (R ? 1 : 0)
  let wider: Dec | null = nSteps > 1 ? steps(nSteps) : null
  if (ctx.cash && !R) wider = maxDec(wider, CASH)
  const fields: CanonicalField[] = ['subtotal', ...(D ? (['discount'] as const) : []), 'tax_amount', ...(R ? (['rounding'] as const) : []), 'total']
  // With zero tax and no adjustment the sum is just "subtotal = total": two printings of one
  // figure agree, which proves the reading, not the roles (a page total equals itself too).
  const equality = isZero(T.value) && (!D || isZero(D.value)) && (!R || isZero(R.value))
  return {
    id: `sum:subtotal${D ? '-discount' : ''}+tax${R ? '+rounding' : ''}=total`,
    kind: equality ? 'corroboration' : 'strong',
    grade: capForRounding(gradeDiff(abs(sub(lhs, G.value)), wider), R, ctx),
    fields,
    supports: equality ? [] : withoutCancelling(fields, S, D),
    coarse: [],
    formula: `subtotal${D ? ' - discount' : ''} + tax_amount${R ? ' + rounding' : ''} = total`,
    expected: lhs,
    actual: G.value,
    note: ctx.cash && !R ? 'cash rounding up to 0.05 tolerated' : '',
  }
}

/**
 * tax = rate × (subtotal − discount), or, without a subtotal, tax = total × rate / (100 + rate)
 * (the tax-inclusive form; also right for exclusive invoices since total = base + tax). The tax
 * and the rate are pinned; the base only coarsely (a few cents of base move the tax by < 1 cent).
 * A zero rate says nothing about the base, a tiny base nothing about the rate.
 */
function checkRate(v: ArithValues, ctx: ArithContext): CheckEval | null {
  const { tax_rate: r, tax_amount: T, subtotal: S, discount: D, total: G, rounding: R } = v
  if (!r || !T) return null
  const wider = ctx.lineCount > 1 ? steps(ctx.lineCount) : null
  const rateOk = (base: Dec) => cmp(abs(base), MIN_BASE_FOR_RATE) >= 0
  if (S) {
    const base = D ? sub(S.value, D.value) : S.value
    const expected = div(mul(base, r.value), HUNDRED, 2)
    const baseFields: CanonicalField[] = ['subtotal', ...(D ? (['discount'] as const) : [])]
    return {
      id: D ? 'tax:tax=rate*(subtotal-discount)' : 'tax:tax=rate*subtotal',
      kind: 'strong',
      grade: gradeDiff(abs(sub(expected, T.value)), wider),
      fields: ['tax_amount', 'tax_rate', ...baseFields],
      supports: ['tax_amount', ...(rateOk(base) ? (['tax_rate'] as const) : [])],
      // The rate pins the base, i.e. subtotal − discount: with a discount neither is pinned alone.
      coarse: isZero(r.value) || D ? [] : baseFields,
      formula: D ? 'tax_amount = (subtotal - discount) × tax_rate / 100' : 'tax_amount = subtotal × tax_rate / 100',
      expected,
      actual: T.value,
      note: wider ? `per-line rounding up to ${str(wider)} tolerated` : '',
    }
  }
  if (!G) return null
  const gross = R ? sub(G.value, R.value) : G.value
  const expected = div(mul(gross, r.value), add(HUNDRED, r.value), 2)
  return {
    id: 'tax:tax=total*rate/(100+rate)',
    kind: 'strong',
    grade: capForRounding(gradeDiff(abs(sub(expected, T.value)), wider), R, ctx),
    fields: ['tax_amount', 'tax_rate', 'total', ...(R ? (['rounding'] as const) : [])],
    supports: ['tax_amount', ...(rateOk(gross) ? (['tax_rate'] as const) : [])],
    coarse: isZero(r.value) ? [] : ['total', ...(R ? (['rounding'] as const) : [])],
    formula: `tax_amount = ${R ? '(total - rounding)' : 'total'} × tax_rate / (100 + tax_rate)`,
    expected,
    actual: T.value,
    note: T.inclusive ? 'tax printed as included in the total' : '',
  }
}

/**
 * Without a printed tax amount: total = (subtotal − discount) × (1 + rate) (+ rounding). Since
 * multiplying by 1 + rate moves the result by at least a cent per cent of base, every input is
 * pinned.
 */
function checkImpliedTotal(v: ArithValues, ctx: ArithContext): CheckEval | null {
  const { tax_rate: r, tax_amount: T, subtotal: S, discount: D, total: G, rounding: R } = v
  if (T || !r || !S || !G) return null
  const base = D ? sub(S.value, D.value) : S.value
  let expected = round(div(mul(base, add(HUNDRED, r.value)), HUNDRED, 4), 2)
  if (R) expected = add(expected, R.value)
  const fields: CanonicalField[] = ['subtotal', ...(D ? (['discount'] as const) : []), 'tax_rate', ...(R ? (['rounding'] as const) : []), 'total']
  // A zero rate without adjustments makes this "subtotal = total" (see checkSum): it pins the
  // rate, not the two figures.
  const equality = isZero(r.value) && !D && !R
  const rateField: CanonicalField[] = cmp(abs(base), MIN_BASE_FOR_RATE) >= 0 ? ['tax_rate'] : []
  return {
    id: D ? 'tax:total=(subtotal-discount)*(1+rate)' : 'tax:total=subtotal*(1+rate)',
    kind: equality ? 'corroboration' : 'strong',
    grade: capForRounding(gradeDiff(abs(sub(expected, G.value)), ctx.cash && !R ? CASH : null), R, ctx),
    fields,
    supports: equality ? rateField : withoutCancelling(fields, S, D).filter((f) => f !== 'tax_rate' || rateField.length > 0),
    coarse: [],
    formula: `total = (subtotal${D ? ' - discount' : ''}) × (1 + tax_rate/100)${R ? ' + rounding' : ''}`,
    expected,
    actual: G.value,
    note: 'no tax amount printed',
  }
}

/**
 * total − paid = due. Without a payment, total = due is only a corroboration: two printings of
 * the same figure agree, which proves the reading but not that the figure is the total (it could
 * be a balance after an unseen advance). The same printed figure used for both is an identity.
 */
function checkPayment(v: ArithValues, ctx: ArithContext): CheckEval | null {
  const { total: G, amount_paid: P, amount_due: A } = v
  if (!G || !A) return null
  const adjusted = checkAdjusted(G, P, A, ctx)
  if (adjusted) return adjusted
  if (P) {
    const expected = sub(G.value, P.value)
    return {
      id: 'sum:total-paid=due',
      kind: 'strong',
      grade: gradeDiff(abs(sub(expected, A.value)), null),
      fields: ['total', 'amount_paid', 'amount_due'],
      supports: ['total', 'amount_paid', 'amount_due'],
      coarse: [],
      formula: 'total - amount_paid = amount_due',
      expected,
      actual: A.value,
      note: '',
    }
  }
  const same = overlaps(G.wordIds, A.wordIds)
  return {
    id: same ? 'identity:total=amount_due' : 'sum:total=due',
    kind: same ? 'identity' : 'corroboration',
    grade: gradeDiff(abs(sub(G.value, A.value)), null),
    fields: ['total', 'amount_due'],
    supports: [],
    coarse: [],
    formula: 'total = amount_due (no payment printed)',
    expected: G.value,
    actual: A.value,
    note: same ? 'one printed figure is both the total and the amount due' : 'two printings agree; this does not prove which figure is the total',
  }
}

/**
 * total (− paid) ± a printed adjustment = due: a utility bill adds the previous debt to the
 * period's total, a contractor's invoice holds back a retention, a withholding certificate deducts
 * tax at source. The adjustment is printed under its own label (it is not a field), so only an
 * exact closure counts, and then it pins the total, the payment and the due like a payment does.
 */
function checkAdjusted(G: ArithValue, P: ArithValue | undefined, A: ArithValue, ctx: ArithContext): CheckEval | null {
  const base = P ? sub(G.value, P.value) : G.value
  for (const adj of ctx.adjustments ?? []) {
    const words = new Set(adj.wordIds)
    if (overlaps(words, A.wordIds) || overlaps(words, G.wordIds) || (P && overlaps(words, P.wordIds))) continue
    // "previous balance 512.92 … paid 512.92": the two cancel, and what is left (total = due)
    // proves no role.
    if (P && cmp(abs(P.value), adj.value) === 0) continue
    const expected = adj.sign === 'add' ? add(base, adj.value) : sub(base, adj.value)
    if (!isZero(sub(expected, A.value))) continue
    const fields: CanonicalField[] = ['total', ...(P ? (['amount_paid'] as const) : []), 'amount_due']
    const op = adj.sign === 'add' ? '+' : '-'
    return {
      id: `sum:total${P ? '-paid' : ''}${op}${adj.kind}=due`,
      kind: 'strong',
      grade: 'exact',
      fields,
      supports: fields,
      coarse: [],
      formula: `total${P ? ' - amount_paid' : ''} ${op} ${adj.kind.replace('_', ' ')} = amount_due`,
      expected,
      actual: A.value,
      note: `${adj.kind.replace('_', ' ')} ${money(adj.value)} printed ("${adj.label.slice(0, 60)}")`,
    }
  }
  return null
}

/**
 * Several VAT rates (lines at 0% and 18%): no single rate exists, so the tax is checked against
 * the per-rate bases, Σ rate × Σ lines at that rate (prices before tax), or Σ lines × rate / (100 +
 * rate) when the lines include it. It rests on the lines, so it is soft, like the line sum.
 */
function checkRatedTax(v: ArithValues, ctx: ArithContext): CheckEval | null {
  const groups = ctx.lines?.byRate
  const { tax_rate: r, tax_amount: T } = v
  if (r || !T || !groups || groups.length < 2) return null
  const excl = groups.reduce((acc, x) => add(acc, div(mul(x.sum, x.rate), HUNDRED, 2)), fromInt(0))
  const incl = groups.reduce((acc, x) => add(acc, div(mul(x.sum, x.rate), add(HUNDRED, x.rate), 2)), fromInt(0))
  const wider = steps(groups.length)
  const gE = gradeDiff(abs(sub(excl, T.value)), wider)
  const gI = gradeDiff(abs(sub(incl, T.value)), wider)
  const useIncl = rankGrade(gI) > rankGrade(gE)
  const grade = useIncl ? gI : gE
  const centsSure = !!ctx.lines?.centsSure
  return {
    id: useIncl ? 'tax:tax=Σ(lines×rate/(100+rate))' : 'tax:tax=Σ(lines×rate)',
    kind: 'soft',
    grade,
    fields: ['tax_amount'],
    supports: centsSure ? ['tax_amount'] : [],
    coarse: centsSure ? [] : ['tax_amount'],
    formula: `tax_amount = Σ over rates of (lines at the rate) × rate${useIncl ? ' / (100 + rate)' : ' / 100'}`,
    expected: useIncl ? incl : excl,
    actual: T.value,
    note: `${groups.length} rates: ${groups.map((x) => `${str(x.rate)}%`).join(', ')}`,
  }
}

function rankGrade(g: Grade): number {
  return { exact: 3, close: 2, approx: 1, fail: 0 }[g]
}

interface LineVariant {
  id: string
  sum: Dec
  target: Dec
  fields: CanonicalField[]
  supports: CanonicalField[]
  kind: CheckKind
  formula: string
}

/**
 * Σ line amounts against the totals. Several printed conventions are legitimate, so the first
 * variant that closes is reported; if none does, the most natural one is reported as failing.
 * Σ lines = total proves the total only when the document is visibly tax-inclusive (tax printed as
 * "included", or zero tax), otherwise the "total" could be a subtotal printed with a bare סה"כ.
 */
function checkLines(v: ArithValues, ctx: ArithContext): CheckEval[] | null {
  const L = ctx.lines
  if (!L || L.count === 0) return null
  const { subtotal: S, discount: D, tax_amount: T, total: G, rounding: R } = v
  const variants: LineVariant[] = []
  // A printed document discount is either one of the rows (the rows then sum to subtotal −
  // discount) or not (the rows sum to the subtotal before it). Which one is decided by whether a
  // discount row exists, never by whichever happens to close.
  const discountRows = L.withoutDiscountRows !== null
  const variant = (id: string, sum: Dec, target: Dec, fields: CanonicalField[], formula: string, supports = fields): void => {
    variants.push({ id, sum, target, fields, supports, kind: 'soft', formula })
  }
  if (S) {
    if (!D || !discountRows) variant('sum:lines=subtotal', L.all, S.value, ['subtotal'], 'Σ line amounts = subtotal')
    if (D && discountRows) {
      const f: CanonicalField[] = ['subtotal', 'discount']
      variant('sum:lines=subtotal-discount', L.all, sub(S.value, D.value), f, 'Σ line amounts (with the discount row) = subtotal - discount', withoutCancelling(f, S, D))
    }
    if (discountRows) variant('sum:lines(without discount rows)=subtotal', L.withoutDiscountRows!, S.value, ['subtotal'], 'Σ line amounts without discount rows = subtotal')
    if (L.withoutShippingRows && !discountRows) {
      variant('sum:lines(without shipping rows)=subtotal', L.withoutShippingRows, S.value, ['subtotal'], 'Σ line amounts without shipping rows = subtotal')
    }
  } else if (G && T) {
    let net = sub(G.value, T.value)
    if (R) net = sub(net, R.value)
    const fields: CanonicalField[] = ['total', 'tax_amount', ...(R ? (['rounding'] as const) : [])]
    const minusR = R ? ' - rounding' : ''
    if (!D || discountRows) variant('sum:lines=total-tax', L.all, net, fields, `Σ line amounts = total - tax_amount${minusR}`)
    if (D) {
      const f2: CanonicalField[] = [...fields, 'discount']
      if (!discountRows) variant('sum:lines=total-tax+discount', L.all, add(net, D.value), f2, `Σ line amounts = total - tax_amount${minusR} + discount`)
      else variant('sum:lines(without discount rows)=total-tax+discount', L.withoutDiscountRows!, add(net, D.value), f2, `Σ line amounts without discount rows = total - tax_amount${minusR} + discount`)
    }
  }
  if (G) {
    // Only a tax printed as "of which VAT" shows the line prices include it; a zero tax or rate
    // could itself be a stray 0.00, so it does not count as evidence here. A page that prints no
    // tax at all (exempt dealer, "כולל מע"מ" only) has nothing between the lines and the total.
    const inclusive = (!!T && !!T.inclusive && !isZero(T.value)) || (!T && !!ctx.noSeparateTax)
    const beforeDiscount = D && !discountRows
    let target = beforeDiscount ? add(G.value, D.value) : G.value
    if (R) target = sub(target, R.value)
    const fields: CanonicalField[] = ['total', ...(beforeDiscount ? (['discount'] as const) : []), ...(R ? (['rounding'] as const) : []), ...(T ? (['tax_amount'] as const) : [])]
    variants.push({
      id: `sum:lines=total${beforeDiscount ? '+discount' : ''}${R ? '-rounding' : ''}`,
      sum: L.all,
      target,
      fields,
      supports: inclusive ? fields.filter((f) => f !== 'tax_amount') : [],
      kind: inclusive ? 'soft' : 'corroboration',
      formula: `Σ line amounts = total${beforeDiscount ? ' + discount' : ''}${R ? ' - rounding' : ''} (prices include tax)`,
    })
  }
  if (!variants.length) return null

  const wider = L.count > 1 ? steps(L.count) : null
  const graded = variants.map((x) => {
    const g = gradeDiff(abs(sub(x.sum, x.target)), wider)
    return { x, grade: x.fields.includes('total') ? capForRounding(g, R, ctx) : g }
  })
  const order: Grade[] = ['exact', 'close', 'approx']
  const pick = order.map((g) => graded.find((x) => x.grade === g)).find((x) => x) ?? graded[0]!
  const toEval = (p: (typeof graded)[number]): CheckEval => ({
    id: p.x.id,
    // A failed closure is always soft: the lines are the likelier culprit.
    kind: p.grade === 'fail' ? 'soft' : p.x.kind,
    grade: p.grade,
    fields: p.x.fields,
    supports: L.centsSure ? p.x.supports : [],
    coarse: L.centsSure ? [] : p.x.supports,
    formula: p.x.formula,
    expected: p.x.sum,
    actual: p.x.target,
    note: `${L.count} line${L.count === 1 ? '' : 's'}`,
  })
  // On a zero-tax or tax-inclusive page the lines can also close against the total itself: an
  // independent confirmation of the total, reported next to the subtotal closure.
  const alsoTotal = graded.find((g) => g !== pick && g.x.id.startsWith('sum:lines=total') && g.x.supports.length > 0 && (g.grade === 'exact' || g.grade === 'close'))
  return alsoTotal && pick.grade !== 'fail' ? [toEval(pick), toEval(alsoTotal)] : [toEval(pick)]
}

/**
 * Without a printed rate, nothing stops two unrelated figures from closing subtotal + tax = total
 * (two installments of half the total, a swapped subtotal and tax). No VAT system charges more
 * than MAX_TAX_RATE, so a tax above that share of its base is not a tax.
 */
function checkTaxShare(v: ArithValues, _ctx: ArithContext): CheckEval | null {
  const { tax_rate: r, tax_amount: T, subtotal: S, discount: D, total: G, rounding: R } = v
  if (r || !T) return null
  let base: Dec | null = null
  if (S) base = D ? sub(S.value, D.value) : S.value
  else if (G) base = sub(R ? sub(G.value, R.value) : G.value, T.value)
  if (!base) return null
  const limit = add(div(mul(abs(base), dec(MAX_TAX_RATE)), HUNDRED, 2), STEP)
  const ok = cmp(abs(T.value), limit) <= 0
  return {
    id: 'tax:share<=30%',
    kind: 'sanity',
    grade: ok ? 'exact' : 'fail',
    fields: ['tax_amount', ...(S ? (['subtotal'] as const) : (['total'] as const))],
    supports: [],
    coarse: [],
    formula: `tax_amount <= ${MAX_TAX_RATE}% of its base`,
    expected: limit,
    actual: abs(T.value),
    note: 'no tax rate printed; range check only',
  }
}

/**
 * subtotal − discount = 0 (a "discount" that is the subtotal printed again) satisfies any check
 * whatever the subtotal is: the two only confirm each other, so neither is supported.
 */
function withoutCancelling(fields: CanonicalField[], S: ArithValue | undefined, D: ArithValue | undefined): CanonicalField[] {
  if (!S || !D || !isZero(sub(S.value, D.value))) return fields
  return fields.filter((f) => f !== 'subtotal' && f !== 'discount')
}

/**
 * Implausible magnitudes: not checks (nothing is printed to compare) but strong hints in the
 * search. Values are already absolute on a credit note, so a negative total means a sign that
 * contradicts the document.
 */
export function implausibilities(v: ArithValues): number {
  const { subtotal: S, discount: D, tax_amount: T, total: G } = v
  let n = 0
  if (S && T && cmp(abs(T.value), abs(S.value)) > 0) n++
  if (G && T && cmp(abs(T.value), abs(G.value)) > 0) n++
  if (S && D && !isZero(S.value) && cmp(abs(D.value), abs(S.value)) >= 0) n++
  if (G && G.value.units < 0n) n++
  return n
}

/** Two decimals for messages. */
export function money(x: Dec): string {
  return str(round(x, 2), 2)
}
