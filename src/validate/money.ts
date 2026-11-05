import type { CanonicalField, FieldStatus } from '../model/types'
import { abs, cmp, dec, isDecimalString, isZero, sub, type Dec } from '../lib/decimal'
import { CUES, MIN_VERIFIABLE_AMOUNT, OCR, PRIOR, SEARCH, SIGNAL, WEIGHT } from './policy'
import {
  evaluateMoneyChecks,
  implausibilities,
  MONEY_VARS,
  supportOf,
  type ArithContext,
  type ArithValues,
  type CheckEval,
  type MoneyVar,
} from './arith'
import { foldCues, hasCue, mentionsWord, overlaps, type DocIndex } from './evidence'
import type { ValueGroup } from './groups'

/**
 * Joint selection of the money fields. Each field is either one of its top value groups or absent;
 * every combination is scored as
 *
 *   Σ ln(prior of the chosen group)  +  Σ ln(PRIOR.absent) for absent fields
 *   + Σ WEIGHT[check kind][grade]    − implausible magnitudes
 *
 * so a strong candidate is dropped only when the arithmetic clearly prefers a world without it,
 * and a weak one is picked only when it closes a check. The combination with the best score wins.
 * Two printed figures may not share words, except total and amount_due (one "סה"כ לתשלום" line
 * is often both).
 */

export interface MoneyOption {
  v: MoneyVar
  group: ValueGroup
  /** As used in arithmetic (see ArithValue). */
  value: Dec
  logPrior: number
  inclusive: boolean
  /** Its words are embedded text (confidence >= OCR.digital): the digits cannot be misread. */
  digital: boolean
  /**
   * Below MIN_VERIFIABLE_AMOUNT (rounding and rate excepted): a small figure can close a rounding
   * gap or a zero sum wherever it is printed, so arithmetic cannot confirm its role.
   */
  small: boolean
  /**
   * Coarse support (role confirmed, last digit not) may verify this option: digital, not small,
   * and for the total no printed rounding line makes a figure a few agorot away a plausible rival.
   */
  coarseOk: boolean
  /** A rounding candidate whose label says rounding (עיגול / rounding). */
  roundingLabel: boolean
  /** Labelled as a per-page or carried-forward figure: never verified, never vouches. */
  pageTotal: boolean
}

export interface MoneySelection {
  /** Final assignment: the winning combination plus rescued fields. */
  chosen: Map<MoneyVar, MoneyOption>
  /** Fields the winning combination left out but whose candidate is too strong to drop silently. */
  rescued: Set<MoneyVar>
  /** Other values of a chosen field that also satisfy the checks (blocks verification). */
  competitors: Map<MoneyVar, MoneyOption[]>
  /** Checks on the final assignment: what is reported. */
  checks: CheckEval[]
  /** All options considered per field (best prior first). */
  options: Map<MoneyVar, MoneyOption[]>
  combinations: number
  /** True when options had to be dropped to stay under SEARCH.maxCombos. */
  truncated: boolean
  linesDigital: boolean
}

export interface MoneyInput {
  groups: Map<CanonicalField, ValueGroup[]>
  /** Credit note: compare absolute values (amounts may be printed negative or positive). */
  absMode: boolean
  ctx: ArithContext
  doc: DocIndex
  /** Every line amount is embedded text (for coarse support from the line closure). */
  linesDigital: boolean
}

/** Smallest amount arithmetic may verify on its own (see MoneyOption.small). */
const MIN_VERIFIABLE = dec(MIN_VERIFIABLE_AMOUNT)
const SMALL_EXEMPT = new Set<MoneyVar>(['rounding', 'tax_rate'])

const SIGNED_IN_ABS_MODE = new Set<MoneyVar>(['rounding', 'tax_rate', 'discount'])

/** Builds the options of one field: its top groups with a usable number. */
export function moneyOptions(v: MoneyVar, groups: readonly ValueGroup[], absMode: boolean, doc: DocIndex, roundingPrinted: boolean): MoneyOption[] {
  const out: MoneyOption[] = []
  for (const group of groups) {
    if (group.prior < PRIOR.floor) continue
    const raw = numberOf(group)
    if (raw === null) continue
    let value = dec(raw)
    // Discount is defined as a positive number; on a credit note signs are a printing convention.
    if (v === 'discount' || (absMode && !SIGNED_IN_ABS_MODE.has(v))) value = abs(value)
    const digital = doc.minConfidence(group.wordIds) >= OCR.digital
    const small = isZero(value) || (!SMALL_EXEMPT.has(v) && cmp(abs(value), MIN_VERIFIABLE) < 0)
    out.push({
      v,
      group,
      value,
      logPrior: Math.log(Math.max(group.prior, 1e-6)),
      inclusive: v === 'tax_amount' && isInclusiveTax(group),
      digital,
      small,
      // Once a rounding is printed, figures before and after it sit a few agorot apart: a check
      // that is only sure to the cent can no longer tell them apart.
      coarseOk: digital && !small && !roundingPrinted,
      roundingLabel: v === 'rounding' && group.candidates.some((c) => hasCue(c.originalLabel, CUES.rounding)),
      pageTotal: group.candidates.every((c) => hasCue(c.originalLabel, CUES.pageTotal)),
    })
    if (out.length >= SEARCH.topK) break
  }
  return out
}

function numberOf(group: ValueGroup): string | null {
  const n = group.rep.normalized
  const v = n.kind === 'money' ? n.amount : n.kind === 'percent' || n.kind === 'decimal' ? n.value : null
  return v !== null && isDecimalString(v) ? v : null
}

/** "מתוכו מע"מ", "VAT included": the tax is part of the printed total. */
export function isInclusiveTax(group: ValueGroup): boolean {
  return group.candidates.some((c) => c.signals.includes(SIGNAL.taxInclusive) || hasCue(c.originalLabel, CUES.taxInclusive))
}

const MAY_SHARE = (a: MoneyVar, b: MoneyVar) => (a === 'total' && b === 'amount_due') || (a === 'amount_due' && b === 'total')

function conflicts(a: MoneyOption, b: MoneyOption): boolean {
  return !MAY_SHARE(a.v, b.v) && overlaps(a.group.wordIds, b.group.wordIds)
}

export function toValues(assign: Iterable<MoneyOption>): ArithValues {
  const v: ArithValues = {}
  for (const o of assign) v[o.v] = { value: o.value, wordIds: o.group.wordIds, inclusive: o.inclusive }
  return v
}

/** The search score of one evaluated combination (see the module comment). */
export function scoreOf(chosen: readonly (MoneyOption | null)[], checks: readonly CheckEval[], values: ArithValues): number {
  let s = 0
  const logAbsent = Math.log(PRIOR.absent)
  for (const o of chosen) s += o ? o.logPrior : logAbsent
  for (const c of checks) s += WEIGHT[c.kind][c.grade]
  return s + implausibilities(values) * WEIGHT.implausible
}

/** What a confirmation needs besides the check itself: the other values it was computed with. */
export interface Assignment {
  options: ReadonlyMap<MoneyVar, MoneyOption>
  linesDigital: boolean
}

/**
 * Whether the check confirms the option: precisely (pinned to the cent), or coarsely (role only)
 * when the option and every other input of the check are embedded text: with OCR anywhere in the
 * check, a misread elsewhere plus a decoy here could close it within a cent.
 */
export function confirms(c: CheckEval, o: MoneyOption, a: Assignment): boolean {
  if (o.small) return false
  if (o.v === 'rounding' && !o.roundingLabel) return false
  const s = supportOf(c, o.v)
  if (s === 'precise') return true
  if (s !== 'coarse' || !o.coarseOk) return false
  if (c.id.startsWith('sum:lines') && !a.linesDigital) return false
  return c.fields.every((f) => {
    const other = a.options.get(f as MoneyVar)
    return !other || other.digital
  })
}

/** A check confirms the option, and nothing involving it fails. */
function satisfies(o: MoneyOption, checks: readonly CheckEval[], a: Assignment): boolean {
  let supported = false
  for (const c of checks) {
    if (!c.fields.includes(o.v)) continue
    if (c.grade === 'fail') return false
    if (confirms(c, o, a)) supported = true
  }
  return supported
}

function assignmentOf(list: Iterable<MoneyOption>, linesDigital: boolean): Assignment {
  const options = new Map<MoneyVar, MoneyOption>()
  for (const o of list) options.set(o.v, o)
  return { options, linesDigital }
}

interface Consistent {
  score: number
  assign: MoneyOption[]
}

export function selectMoney(input: MoneyInput): MoneySelection {
  const options = new Map<MoneyVar, MoneyOption[]>()
  const roundingPrinted = (input.groups.get('rounding')?.length ?? 0) > 0 || !!input.ctx.roundingMentioned
  for (const v of MONEY_VARS) {
    const opts = moneyOptions(v, input.groups.get(v) ?? [], input.absMode, input.doc, roundingPrinted)
    if (opts.length) options.set(v, opts)
  }
  const truncated = capCombinations(options)
  const vars = MONEY_VARS.filter((v) => options.has(v))

  const chosen: (MoneyOption | null)[] = vars.map(() => null)
  let best: { score: number; assign: MoneyOption[] } = { score: -Infinity, assign: [] }
  const bestConsistent = new Map<MoneyOption, Consistent>()
  let combinations = 0

  const visit = () => {
    combinations++
    const assign = chosen.filter((o): o is MoneyOption => o !== null)
    const values = toValues(assign)
    const checks = evaluateMoneyChecks(values, input.ctx)
    const score = scoreOf(chosen, checks, values)
    if (score > best.score) best = { score, assign }
    const a = assignmentOf(assign, input.linesDigital)
    for (const o of assign) {
      if (!satisfies(o, checks, a)) continue
      const prev = bestConsistent.get(o)
      if (!prev || score > prev.score) bestConsistent.set(o, { score, assign })
    }
  }
  const dfs = (i: number) => {
    if (i === vars.length) return visit()
    chosen[i] = null
    dfs(i + 1)
    for (const o of options.get(vars[i]!)!) {
      let ok = true
      for (let j = 0; j < i && ok; j++) if (chosen[j] && conflicts(chosen[j]!, o)) ok = false
      if (!ok) continue
      chosen[i] = o
      dfs(i + 1)
    }
    chosen[i] = null
  }
  dfs(0)

  const final = new Map<MoneyVar, MoneyOption>()
  for (const o of best.assign) final.set(o.v, o)

  // Competitors: another value of the same field that is confirmed in a consistent combination
  // that is a real alternative explanation of the page: it keeps every strong figure the winner
  // uses, or it uses a strong figure the winner leaves unexplained. (A combination that only
  // drops a strong figure, like "subtotal after discount" without the printed discount, is not.)
  const inBest = new Set(best.assign)
  const strongVars = best.assign.filter((o) => o.group.prior >= PRIOR.rescueMin).map((o) => o.v)
  const competitors = new Map<MoneyVar, MoneyOption[]>()
  for (const o of best.assign) {
    const rivals: MoneyOption[] = []
    for (const alt of options.get(o.v) ?? []) {
      if (alt === o || alt.group.prior < PRIOR.competitorMin) continue
      const entry = bestConsistent.get(alt)
      const keepsStrong = !!entry && strongVars.every((sv) => entry.assign.some((a) => a.v === sv))
      const explainsMore = !!entry && entry.assign.some((a) => a.group.prior >= PRIOR.rescueMin && !inBest.has(a))
      if (keepsStrong || explainsMore || substitutionSatisfies(best.assign, o, alt, input)) rivals.push(alt)
    }
    if (rivals.length) competitors.set(o.v, rivals)
  }

  // Rescue: a strong printed candidate the arithmetic left out is reported (needs_review), so a
  // misread figure reaches a person instead of disappearing.
  const rescued = new Set<MoneyVar>()
  for (const v of vars) {
    if (final.has(v)) continue
    const top = options.get(v)![0]!
    if (top.group.prior < PRIOR.rescueMin) continue
    if ([...final.values()].some((o) => conflicts(o, top))) continue
    final.set(v, top)
    rescued.add(v)
  }

  const checks = evaluateMoneyChecks(toValues(final.values()), input.ctx)
  return { chosen: final, rescued, competitors, checks, options, combinations, truncated, linesDigital: input.linesDigital }
}

function substitutionSatisfies(assign: readonly MoneyOption[], o: MoneyOption, alt: MoneyOption, input: MoneyInput): boolean {
  const others = assign.filter((a) => a !== o)
  if (others.some((a) => conflicts(a, alt))) return false
  const list = [...others, alt]
  const checks = evaluateMoneyChecks(toValues(list), input.ctx)
  return satisfies(alt, checks, assignmentOf(list, input.linesDigital))
}

/** Drops the weakest options of the most crowded field until the search is small enough. */
function capCombinations(options: Map<MoneyVar, MoneyOption[]>): boolean {
  let truncated = false
  const product = () => [...options.values()].reduce((p, l) => p * (l.length + 1), 1)
  while (product() > SEARCH.maxCombos) {
    let worst: MoneyOption[] | null = null
    for (const l of options.values()) if (l.length > 1 && (!worst || l.length > worst.length)) worst = l
    if (!worst) break
    worst.pop()
    truncated = true
  }
  return truncated
}

// ---------------------------------------------------------------------------------------------
// Statuses

export interface MoneyDecision {
  v: MoneyVar
  option: MoneyOption
  status: FieldStatus
  /** Passing checks (any passing grade) that involve the field. */
  passed: CheckEval[]
  failed: CheckEval[]
  exactSupport: number
  competitor: boolean
  conflict: boolean
  rescued: boolean
  reasons: string[]
}

export interface MoneyStatusContext {
  doc: DocIndex
  /** Prior of the strongest amount_paid group (0 when none): blocks the amount_due identity rule. */
  paymentPrior: number
  /** Discounts printed outside the item lines (printedDiscounts), as positive amounts. */
  discounts: readonly Dec[]
}

const PAYMENT_CUES = foldCues(CUES.payment)

/**
 * Applies STATUS_POLICY.money / .rate to the selection. Order matters: failures first, then
 * competitors, then confirmation, then the prior-only cases.
 */
export function decideMoney(sel: MoneySelection, sctx: MoneyStatusContext): Map<MoneyVar, MoneyDecision> {
  const out = new Map<MoneyVar, MoneyDecision>()
  const order = [...sel.chosen.keys()].sort((a, b) => (a === 'amount_due' ? 1 : 0) - (b === 'amount_due' ? 1 : 0))
  const assignment = assignmentOf(sel.chosen.values(), sel.linesDigital)
  // A check confirms a field only through values that can vouch for it (STATUS_POLICY.money (2)):
  // if another reading of the subtotal also closes, "subtotal + tax = total" no longer confirms
  // the tax either.
  const overruled = new Set<MoneyVar>()
  const discount = sel.chosen.get('discount')
  const linesPinSubtotal = sel.checks.some((c) => c.id === 'sum:lines=subtotal' && c.grade === 'exact')
  // STATUS_POLICY.money (7): a printed discount the chosen amounts leave out makes the equation
  // incomplete. "Taxable amount 42,104 + VAT = total" closes exactly when the 2,000 discount above
  // it is missed, so the figure taken for the subtotal may be the base after the discount.
  const unheldDiscount = sctx.discounts.some((d) => !discount || cmp(abs(discount.value), d) !== 0)
  for (const [v, o] of sel.chosen) {
    // "סה"כ חייב במע"מ" / "Base HT" next to "סה"כ לפני הנחה" / "Total HT brut": the base after the
    // chosen discount is another printed figure, not a rival reading of the subtotal. Only when its
    // label says so, and the subtotal is the lines' sum or labelled as before the discount.
    const afterDiscount = (a: MoneyOption) =>
      v === 'subtotal' &&
      !!discount &&
      !discount.small &&
      cmp(a.value, sub(o.value, discount.value)) === 0 &&
      a.group.candidates.some((c) => hasCue(c.originalLabel, CUES.afterDiscount)) &&
      (linesPinSubtotal || o.group.candidates.some((c) => hasCue(c.originalLabel, CUES.beforeDiscount)))
    const rivals = (sel.options.get(v) ?? []).filter((a) => a !== o && !afterDiscount(a))
    if (rivals.some((a) => a.group.prior >= Math.max(PRIOR.rescueMin, o.group.prior + PRIOR.overrideMargin))) overruled.add(v)
  }
  const contested = new Set<MoneyVar>([
    ...sel.competitors.keys(),
    ...overruled,
    ...sel.rescued,
    ...[...sel.chosen.values()].filter((o) => o.pageTotal).map((o) => o.v),
    // A value in a failing check is doubtful whatever else it closes with.
    ...sel.checks.filter((c) => c.grade === 'fail' && c.kind !== 'soft').flatMap((c) => c.fields as MoneyVar[]),
    ...duplicatedValues(sel.chosen),
  ])
  // A zero or a few agorot cannot vouch either: "total − 0.00 = due" is just "total = due".
  const small = new Set<MoneyVar>([...sel.chosen.values()].filter((o) => o.small).map((o) => o.v))
  const undisputed = (c: CheckEval, v: MoneyVar) => c.fields.every((f) => f === v || (!contested.has(f as MoneyVar) && !small.has(f as MoneyVar)))
  for (const v of order) {
    const option = sel.chosen.get(v)!
    const involving = sel.checks.filter((c) => c.fields.includes(v))
    const passed = involving.filter((c) => c.grade !== 'fail')
    const failed = involving.filter((c) => c.grade === 'fail')
    // A zero (or a few agorot) takes part in a sum without changing it much: arithmetic confirms
    // the value but not that this printed figure is the field. Small values need a label (below).
    const exact = involving.filter((c) => confirms(c, option, assignment) && undisputed(c, v))
    const strongExact = exact.filter((c) => c.kind === 'strong')
    const hardFails = failed.filter((c) => c.kind !== 'soft')
    const softFails = failed.filter((c) => c.kind === 'soft')
    const competitor = (sel.competitors.get(v)?.length ?? 0) > 0
    const alts = (sel.options.get(v) ?? []).filter((o) => o !== option)
    const conflict = alts.some((a) => a.group.prior >= Math.max(PRIOR.conflictMin, option.group.prior - PRIOR.conflictMargin))
    const rescued = sel.rescued.has(v)
    const reasons: string[] = []
    let status: FieldStatus
    if (rescued) {
      status = 'needs_review'
      reasons.push('rejected-by-arithmetic')
    } else if (hardFails.length) {
      status = 'needs_review'
      reasons.push(...hardFails.map((c) => `failed:${c.id}`))
    } else if (softFails.length && !strongExact.length) {
      status = 'needs_review'
      reasons.push(...softFails.map((c) => `failed:${c.id}`))
    } else if (competitor) {
      status = 'needs_review'
      reasons.push('competitor-satisfies-checks')
    } else if (overruled.has(v)) {
      status = 'needs_review'
      reasons.push('stronger-candidate-overruled')
    } else if (v === 'subtotal' && unheldDiscount && !linesPinSubtotal) {
      status = 'needs_review'
      reasons.push('discount-printed-not-held')
    } else if (option.pageTotal) {
      status = 'proposed'
      reasons.push('page-total-label')
    } else if (exact.length && paymentRoleUnconfirmed(v, option)) {
      status = conflict ? 'needs_review' : 'proposed'
      reasons.push('payment-role-not-in-label')
    } else if (exact.length) {
      status = 'verified'
    } else if (option.small && smallByLabel(option, passed, competitor || conflict, sctx)) {
      status = 'verified'
      reasons.push('small-amount-confirmed-by-label')
    } else if (v === 'amount_due' && dueSharesVerifiedTotal(sel, out, sctx)) {
      status = 'verified'
      reasons.push('same-figure-as-verified-total')
    } else if (conflict) {
      status = 'needs_review'
      reasons.push('conflicting-candidates')
    } else if (option.group.prior < PRIOR.proposedMin) {
      status = 'needs_review'
      reasons.push('weak-prior')
    } else if (sctx.doc.minConfidence(option.group.wordIds) < OCR.weak) {
      status = 'needs_review'
      reasons.push('weak-text')
    } else {
      status = 'proposed'
    }
    out.set(v, { v, option, status, passed, failed, exactSupport: exact.length, competitor, conflict, rescued, reasons })
  }
  return out
}

/**
 * Two different money fields holding the same amount (from different printings) are suspect: the
 * printed figures of a page satisfy subtotal + tax = total, so the total offered as a "subtotal"
 * and the tax offered as a "discount" still give the right base. Except total = amount_due.
 */
function duplicatedValues(chosen: ReadonlyMap<MoneyVar, MoneyOption>): MoneyVar[] {
  const list = [...chosen.values()].filter((o) => o.v !== 'tax_rate' && !isZero(o.value))
  const out = new Set<MoneyVar>()
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!
      const b = list[j]!
      if (MAY_SHARE(a.v, b.v) || cmp(abs(a.value), abs(b.value)) !== 0) continue
      out.add(a.v)
      out.add(b.v)
    }
  }
  return [...out]
}

/**
 * Label cues this layer checks itself for the roles arithmetic cannot settle: small amounts, and
 * paid/due (total − paid = due also closes with the tax and subtotal, or two half payments).
 */
const ROLE_CUES: Partial<Record<MoneyVar, readonly string[]>> = {
  discount: CUES.discountRow,
  rounding: CUES.rounding,
  tax_amount: CUES.tax,
  tax_rate: CUES.tax,
  amount_paid: CUES.payment,
  amount_due: CUES.payable,
}

/** Some candidate of the option has a label naming the field's role. */
function labelNamesRole(option: MoneyOption): boolean {
  const cues = ROLE_CUES[option.v]
  return !!cues && option.group.candidates.some((c) => hasCue(c.originalLabel, cues))
}

/**
 * A printed zero or small amount (מע"מ 0.00 on an Eilat invoice) is verified when an exact check
 * pins its value (so the value is right) and a strong label that names the role says what it is
 * (so the role is right). Never for subtotal or total: a zero there is not an invoice.
 */
function smallByLabel(option: MoneyOption, passed: readonly CheckEval[], contested: boolean, sctx: MoneyStatusContext): boolean {
  if (contested || !ROLE_CUES[option.v]) return false
  if (!passed.some((c) => c.grade === 'exact' && c.supports.includes(option.v))) return false
  const g = option.group
  const strong = g.candidates.some((c) => c.label !== null && !c.method.startsWith('pattern:') && c.signals.some((s) => (SIGNAL.strongLabel as readonly string[]).includes(s)))
  return strong && labelNamesRole(option) && g.prior >= PRIOR.strongLabel && sctx.doc.minConfidence(g.wordIds) >= OCR.labelOnly
}

/**
 * total − paid = due also closes with paid and due swapped, with (tax, subtotal) or with two half
 * payments, so for these two the arithmetic cannot confirm the role: the label must name it
 * (מקדמה/שולם for paid, לתשלום/יתרה for due) and not name the other one.
 */
function paymentRoleUnconfirmed(v: MoneyVar, option: MoneyOption): boolean {
  if (v !== 'amount_paid' && v !== 'amount_due') return false
  return !labelNamesRole(option)
}

/**
 * One printed "סה"כ לתשלום" figure is both total and amount_due. Its value is confirmed through
 * the verified total; its role through the payable label and the absence of any payment.
 */
function dueSharesVerifiedTotal(sel: MoneySelection, decided: Map<MoneyVar, MoneyDecision>, sctx: MoneyStatusContext): boolean {
  const total = decided.get('total')
  const due = sel.chosen.get('amount_due')
  if (!total || !due || total.status !== 'verified') return false
  if (sctx.paymentPrior >= PRIOR.competitorMin || sel.chosen.has('amount_paid')) return false
  // Another amount-due reading, or a payment/advance printed anywhere: the figure may be the total only.
  if ((sel.options.get('amount_due') ?? []).some((o) => o !== due && o.group.prior >= PRIOR.competitorMin)) return false
  if (mentionsWord(sctx.doc.foldedLines, PAYMENT_CUES)) return false
  const identity = sel.checks.find((c) => c.id === 'identity:total=amount_due')
  if (!identity || identity.grade !== 'exact') return false
  return due.group.candidates.some((c) => hasCue(c.originalLabel, CUES.payable))
}
