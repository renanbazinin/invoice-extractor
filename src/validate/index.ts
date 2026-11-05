import type {
  CanonicalField,
  DerivedValue,
  DocumentModel,
  DocumentType,
  ExtractedField,
  ExtractionResult,
  FieldCandidate,
  FieldStatus,
  Issue,
  LineItem,
  LineItemCandidate,
  ValidationCheck,
} from '../model/types'
import { CANONICAL_FIELDS } from '../model/types'
import { CORE_FIELDS, CUES, IL_VAT_HISTORY, OCR, PRIOR, SIGNAL } from './policy'
import { foldCues, indexDocument } from './evidence'
import { adjustPriors } from './priors'
import { groupCandidates, type ValueGroup } from './groups'
import { MONEY_VARS, type ArithContext, type MoneyVar } from './arith'
import { decideMoney, selectMoney, type MoneyDecision, type MoneySelection } from './money'
import { analyzeLines, buildLineItems } from './lines'
import { documentConvention, readDate, settleByOrder, type DateReading } from './dates'
import { rankGroups, resolveClaims, type Choice, type Decision } from './single'
import {
  decideAddress,
  decideContact,
  decideCurrency,
  decideDate,
  decideDocumentType,
  decideIdentifier,
  decideTerms,
  type DecideContext,
} from './decide'
import { decideName } from './parties'
import { calibrate, round3 } from './confidence'
import { extractedField, positiveMoney, toValidationCheck } from './build'
import { deriveValues } from './derived'
import { noSeparateTax, printedAdjustments, printedDiscounts, printedRates, schedulePayments } from './printed'
import { str } from '../lib/decimal'

export interface ResolveInput {
  document: DocumentModel
  candidates: FieldCandidate[]
  lineItems: LineItemCandidate[]
}

export interface ResolveOutput {
  fields: Partial<Record<CanonicalField, ExtractedField>>
  lineItems: LineItem[]
  derived: DerivedValue[]
  checks: ValidationCheck[]
  issues: Issue[]
  summary: ExtractionResult['summary']
}

export { STATUS_POLICY, PRIOR, OCR, TOLERANCE, CALIBRATION } from './policy'

const MONEY_SET = new Set<CanonicalField>(MONEY_VARS)
const DATE_FIELDS: CanonicalField[] = ['invoice_date', 'due_date', 'delivery_date']

/**
 * Layer 4: chooses among candidates, checks them against each other, and sets statuses.
 *
 *  1. adjust priors with whole-document knowledge (currency, identifier collisions, ranges);
 *  2. group duplicate readings; choose single-value fields, then stop two fields claiming one text;
 *  3. document type first (a credit note changes how signs are compared);
 *  4. money: joint selection over all money fields + tax rate + line sums, then statuses;
 *  5. dates (day/month convention, order), identifiers, contacts, codes, terms, addresses, names;
 *  6. line items, derived values, issues, summary.
 *
 * Every status rule is in policy.ts (STATUS_POLICY); this function only sequences them.
 */
export function resolve(input: ResolveInput): ResolveOutput {
  const doc = indexDocument(input.document)
  const issues: Issue[] = []
  const checks: ValidationCheck[] = []
  const fields: Partial<Record<CanonicalField, ExtractedField>> = {}

  const adj = adjustPriors(input.candidates)
  issues.push(...adj.issues)
  const { byField, malformed } = groupCandidates(input.candidates, adj.scoreOf, adj.notesOf)
  for (const c of malformed) {
    issues.push({ severity: 'warning', code: 'candidate.malformed', message: `${c.field} candidate "${c.rawValue}" has an unusable normalized value.`, fields: [c.field] })
  }
  const israeli = doc.hebrew || adj.currency.main === 'ILS'

  // Single-value fields: rank, then settle competing claims on the same words.
  const choices: Choice[] = CANONICAL_FIELDS.filter((f) => !MONEY_SET.has(f) && byField.has(f)).map((field) => ({
    field,
    ranked: rankGroups(field, byField.get(field)!, israeli),
    index: 0,
    roleConflict: null,
  }))
  issues.push(...resolveClaims(choices))
  const choiceOf = new Map(choices.filter((c) => c.index >= 0).map((c) => [c.field, c]))
  const decided = new Map<CanonicalField, Decision>()
  const dctx: DecideContext = { doc, israeli, groups: byField, decided }
  const decide = (f: CanonicalField, fn: (c: Choice) => Decision) => {
    const c = choiceOf.get(f)
    if (c) decided.set(f, fn(c))
  }

  decide('document_type', (c) => decideDocumentType(c, dctx))
  const docType = documentTypeOf(decided.get('document_type'))
  dctx.receipt = docType === 'receipt' || docType === 'tax_invoice_receipt'
  const absMode = docType === 'credit_note'

  // Money. What the page prints around the amounts can change what they mean (printed.ts).
  const moneyGroups = moneyCandidates(byField, docType, input.lineItems, issues)
  const lines = analyzeLines(input.lineItems, absMode)
  const ctx: ArithContext = {
    lines: lines.sums,
    cash: cashContext(input.candidates, byField, docType, doc.mentions(foldCues(CUES.cash))),
    lineCount: lines.rows.length,
    roundingMentioned: doc.mentions(foldCues(CUES.rounding)),
    adjustments: printedAdjustments(doc),
    noSeparateTax: noSeparateTax(doc, byField),
  }
  const linesDigital = input.lineItems.every((l) => !l.amount || doc.minConfidence(l.amount.evidence.flatMap((e) => e.wordIds)) >= OCR.digital)
  const sel = selectMoney({ groups: moneyGroups, absMode, ctx, doc, linesDigital })
  const itemWordIds = new Set(input.lineItems.flatMap((l) => l.row.wordIds))
  const discounts = printedDiscounts(doc, itemWordIds)
  const money = decideMoney(sel, { doc, paymentPrior: moneyGroups.get('amount_paid')?.[0]?.prior ?? 0, discounts })
  checks.push(...sel.checks.map(toValidationCheck), ...skippedMoneyChecks(sel))
  issues.push(...moneyIssues(sel, money, moneyGroups))
  if (money.get('subtotal')?.reasons.includes('discount-printed-not-held')) {
    issues.push({
      severity: 'warning',
      code: 'check.incomplete',
      message: `A discount of ${discounts.map((d) => str(d)).join(' / ')} is printed but not part of the chosen amounts: "${money.get('subtotal')!.option.group.rep.rawValue}" may be the amount after the discount rather than the subtotal.`,
      fields: ['subtotal', 'discount'],
    })
  }
  for (const [v, d] of money) {
    fields[v] = moneyField(d, sel)
    if (d.reasons.includes('small-amount-confirmed-by-label')) {
      const id = `label:${v}`
      checks.push({ id, status: 'pass', fields: [v], expected: null, actual: d.option.group.rep.rawValue, message: `${v} is a small printed amount: the amounts around it close exactly and the strong label "${d.option.group.rep.originalLabel ?? ''}" names it.` })
      fields[v]!.checks.push(id)
    }
  }

  // Dates.
  const conv = documentConvention(
    DATE_FIELDS.flatMap((f) => byField.get(f) ?? []).flatMap((g) => g.candidates.map((c) => c.rawValue)),
    doc,
  )
  if (conv.conflicting) {
    issues.push({ severity: 'warning', code: 'date.conflicting_conventions', message: `Both day-first and month-first dates are printed (${conv.witnesses.join(', ')}).`, fields: DATE_FIELDS.filter((f) => choiceOf.has(f)) })
  }
  const readings = new Map<CanonicalField, DateReading>()
  for (const f of DATE_FIELDS) {
    const c = choiceOf.get(f)
    const r = c ? readDate(c.ranked[c.index]!, conv) : null
    if (r) readings.set(f, r)
  }
  settleByOrder(readings.get('invoice_date') ?? null, readings.get('due_date') ?? null)
  const orderCheck = dateOrderCheck(readings.get('invoice_date'), readings.get('due_date'))
  if (orderCheck) {
    checks.push(orderCheck)
    if (orderCheck.status === 'fail') issues.push({ severity: 'warning', code: 'date.order', message: orderCheck.message, fields: orderCheck.fields })
  }
  for (const f of DATE_FIELDS) {
    const reading = readings.get(f)
    if (!reading) continue
    const orderFailed = orderCheck?.status === 'fail' && orderCheck.fields.includes(f) ? orderCheck : null
    decide(f, (c) => decideDate(c, dctx, { reading, orderFailed, isoOf: (g) => readDate(g, conv)?.iso ?? null }))
  }

  // Identifiers (tax ids before contacts and names, which lean on them), then the rest.
  for (const f of ['supplier.tax_id', 'customer.tax_id', 'invoice_number', 'po_number', 'allocation_number', 'supplier.bank_account'] as const) {
    decide(f, (c) => decideIdentifier(c, dctx))
  }
  decide('supplier.phone', (c) => decideContact(c, dctx))
  decide('supplier.email', (c) => decideContact(c, dctx))
  decide('payment_terms', (c) => decideTerms(c, dctx))
  decide('supplier.address', (c) => decideAddress(c, dctx))
  decide('customer.address', (c) => decideAddress(c, dctx))
  const amountCurrencies = [...money.values()]
    .filter((d) => !d.rescued && d.v !== 'tax_rate')
    .map((d) => ({
      field: d.v as CanonicalField,
      currency: d.option.group.rep.normalized.kind === 'money' ? d.option.group.rep.normalized.currency : null,
      wordIds: d.option.group.wordIds,
      labelWordIds: new Set(d.option.group.candidates.flatMap((c) => c.label?.wordIds ?? [])),
      raw: d.option.group.rep.rawValue,
      verified: d.status === 'verified',
    }))
  decide('currency', (c) => decideCurrency(c, dctx, amountCurrencies, adj.currency.others))
  decide('supplier.name', (c) => decideName(c, dctx))
  decide('customer.name', (c) => decideName(c, dctx))
  samePartyNames(decided, issues)

  for (const [f, d] of decided) {
    if (d.drop) {
      issues.push(d.drop)
      continue
    }
    fields[f] = decisionField(d, doc.minConfidence(d.group.wordIds))
    checks.push(...d.report.filter((c) => !checks.some((x) => x.id === c.id)))
    issues.push(...d.issues)
  }
  issues.push(...rateHistoryIssues(fields, israeli))

  // Line items. The closure confirms the rows only against totals that are themselves verified.
  const closureCheck = sel.checks.find((c) => c.id.startsWith('sum:lines')) ?? null
  const totalsVerified = closureCheck?.fields.every((f) => fields[f]?.status === 'verified') ?? false
  const closure = closureCheck && !totalsVerified && closureCheck.grade !== 'fail' ? { ...closureCheck, grade: 'approx' as const } : closureCheck
  const built = buildLineItems(lines, { check: closure }, doc)
  checks.push(...built.checks)
  for (const c of built.checks.filter((x) => x.status === 'fail')) {
    issues.push({ severity: 'warning', code: 'line.arithmetic_failed', message: c.message, fields: [] })
  }

  const derived = deriveValues({
    money,
    present: new Set(Object.keys(fields) as CanonicalField[]),
    absMode,
    amountCurrencies,
    unheldDiscount: doc.mentions(foldCues(CUES.discountRow)),
    unheldRounding: doc.mentions(foldCues(CUES.rounding)),
    // A previous balance or a retention between total and due makes "due = total − paid" wrong.
    unheldAdjustment: (ctx.adjustments?.length ?? 0) > 0,
    // Several VAT rates: no single rate to derive.
    multiRate: !moneyGroups.has('tax_rate') && byField.has('tax_rate'),
  })

  const missing = CORE_FIELDS.filter((f) => !fields[f])
  for (const f of missing) {
    const d = derived.find((x) => x.field === f)
    issues.push({
      severity: 'warning',
      code: 'missing.core',
      message: `${f} was not found on the document${d ? ` (a value is derivable: ${d.formula})` : ''}.`,
      fields: [f],
    })
  }

  return { fields, lineItems: built.items, derived, checks, issues: dedupeIssues(issues), summary: summarize(fields, issues, missing) }
}

// ---------------------------------------------------------------------------------------------

/**
 * The money candidates the joint selection may use. Two classes are taken out before it runs,
 * because the arithmetic would happily close with them:
 *  - an "advance" on a quote or proforma, or under a schedule label ("סכום המקדמה (30%)"): money
 *    to be paid, not a payment (amount_paid would be a hallucination);
 *  - a single tax rate when the invoice prints several (lines at 0% and 18%): tax_rate is then
 *    absent by definition, and the tax is checked per rate instead (arith.checkRatedTax).
 */
function moneyCandidates(byField: Map<CanonicalField, ValueGroup[]>, docType: DocumentType | null, lineItems: readonly LineItemCandidate[], issues: Issue[]): Map<CanonicalField, ValueGroup[]> {
  const out = new Map(byField)
  const paid = byField.get('amount_paid') ?? []
  const schedule = schedulePayments(paid, docType)
  if (schedule.length) {
    const keep = paid.filter((g) => !schedule.includes(g))
    if (keep.length) out.set('amount_paid', keep)
    else out.delete('amount_paid')
    issues.push({
      severity: 'info',
      code: 'money.schedule_not_paid',
      message: `${schedule.map((g) => `"${g.rep.rawValue}" (${g.rep.originalLabel ?? 'no label'})`).join(', ')}: ${docType === 'quote' || docType === 'proforma' ? `nothing is paid on a ${docType}` : 'an advance to be paid, not a payment'}; not used as amount_paid.`,
      fields: ['amount_paid'],
    })
  }
  const rates = printedRates(lineItems, byField)
  if (rates.length >= 2 && out.has('tax_rate')) {
    out.delete('tax_rate')
    issues.push({ severity: 'info', code: 'tax.multiple_rates', message: `Several VAT rates are printed (${rates.map((r) => `${r}%`).join(', ')}): there is no single tax rate.`, fields: ['tax_rate'] })
  }
  return out
}

function documentTypeOf(d: Decision | undefined): DocumentType | null {
  return d && d.normalized.kind === 'document_type' ? d.normalized.value : null
}

/**
 * Cash context: a printed rounding line candidate, a receipt, an explicit signal, or a cash word on
 * the page. It only widens the tolerance for rounded totals to ±0.05, which never verifies.
 */
function cashContext(candidates: readonly FieldCandidate[], byField: Map<CanonicalField, ValueGroup[]>, docType: DocumentType | null, mentionsCash: boolean): boolean {
  return (
    byField.has('rounding') ||
    docType === 'receipt' ||
    docType === 'tax_invoice_receipt' ||
    candidates.some((c) => c.signals.includes(SIGNAL.cash)) ||
    mentionsCash
  )
}

function moneyField(d: MoneyDecision, sel: MoneySelection): ExtractedField {
  const g = d.option.group
  const normalized = d.v === 'discount' ? positiveMoney(g.rep.normalized) : g.rep.normalized
  const exact = d.exactSupport
  const approx = d.passed.length - d.exactSupport
  const confidence = calibrate(g.prior, d.status, { exact, approx, failed: d.failed.length, competitor: d.competitor || d.conflict, weakText: false })
  const alternatives = (sel.options.get(d.v) ?? []).filter((o) => o !== d.option).map((o) => o.group)
  const passedIds = d.passed.map((c) => c.id)
  return extractedField(g, normalized, d.status, confidence, passedIds, alternatives)
}

function decisionField(d: Decision, textConfidence: number): ExtractedField {
  const confidence = calibrate(d.group.prior * Math.max(textConfidence, 0.5), d.status, {
    exact: d.exact,
    failed: d.failed,
    competitor: d.competitor,
    ambiguous: d.ambiguous,
    weakText: d.weakText,
  })
  return extractedField(d.group, d.normalized, d.status, confidence, d.passed.map((c) => c.id), d.alternatives)
}

/** Main checks that could not run because an input is missing: reported so a reviewer sees why. */
function skippedMoneyChecks(sel: MoneySelection): ValidationCheck[] {
  const has = (v: MoneyVar) => sel.chosen.has(v)
  const out: ValidationCheck[] = []
  const ran = (prefix: string) => sel.checks.some((c) => c.id.startsWith(prefix))
  if (!ran('sum:subtotal') && has('total') && (has('subtotal') || has('tax_amount'))) {
    const miss = (['subtotal', 'tax_amount'] as const).filter((v) => !has(v))
    out.push({ id: 'sum:subtotal+tax=total', status: 'skipped', fields: ['subtotal', 'tax_amount', 'total'], expected: null, actual: null, message: `not checked: ${miss.join(', ')} not found` })
  }
  if (!ran('tax:') && has('tax_rate') && !has('tax_amount')) {
    out.push({ id: 'tax:tax=rate*subtotal', status: 'skipped', fields: ['tax_rate', 'tax_amount', 'subtotal'], expected: null, actual: null, message: 'not checked: the base or tax amount was not found' })
  }
  return out
}

function moneyIssues(sel: MoneySelection, money: Map<MoneyVar, MoneyDecision>, byField: Map<CanonicalField, ValueGroup[]>): Issue[] {
  const out: Issue[] = []
  for (const c of sel.checks) {
    if (c.grade !== 'fail') continue
    const v = toValidationCheck(c)
    out.push(
      c.kind === 'soft'
        ? { severity: 'warning', code: 'lines.sum_mismatch', message: v.message, fields: c.fields }
        : { severity: 'error', code: 'check.failed', message: v.message, fields: c.fields },
    )
  }
  for (const [v, d] of money) {
    const raw = d.option.group.rep.rawValue
    if (d.rescued) {
      out.push({ severity: 'warning', code: 'money.rejected_by_arithmetic', message: `${v} "${raw}" does not fit the other amounts; reported for review.`, fields: [v] })
    }
    if (d.competitor) {
      const rivals = sel.competitors.get(v)!.map((o) => `"${o.group.rep.rawValue}"`).join(', ')
      out.push({ severity: 'warning', code: 'conflict.arithmetic', message: `${v}: "${raw}" and ${rivals} both satisfy the arithmetic.`, fields: [v] })
    } else if (d.conflict && d.status === 'needs_review' && !d.failed.length && !d.rescued) {
      const rivals = (sel.options.get(v) ?? []).filter((o) => o !== d.option && o.group.prior >= PRIOR.competitorMin).map((o) => `"${o.group.rep.rawValue}"`)
      out.push({ severity: 'warning', code: 'conflict.candidates', message: `${v}: "${raw}" competes with ${rivals.join(', ')} and no check decides.`, fields: [v] })
    }
  }
  for (const v of MONEY_VARS) {
    if (money.has(v)) continue
    const top = byField.get(v)?.[0]
    if (top && top.prior >= PRIOR.proposedMin) {
      out.push({ severity: 'info', code: 'money.candidate_dropped', message: `${v} candidate "${top.rep.rawValue}" was left out: it does not fit the other amounts.`, fields: [v] })
    }
  }
  if (sel.truncated) out.push({ severity: 'info', code: 'money.search_truncated', message: 'Too many amount candidates; the weakest were not considered.', fields: [] })
  return out
}

function dateOrderCheck(invoice: DateReading | undefined, due: DateReading | undefined): ValidationCheck | null {
  if (!invoice || !due || invoice.ambiguous || due.ambiguous) return null
  const ok = invoice.iso <= due.iso
  return {
    id: 'date:invoice_date<=due_date',
    status: ok ? 'pass' : 'fail',
    fields: ['invoice_date', 'due_date'],
    expected: `invoice_date <= due_date`,
    actual: `${invoice.iso} / ${due.iso}`,
    message: ok ? `invoice date ${invoice.iso} is not after due date ${due.iso}` : `invoice date ${invoice.iso} is after due date ${due.iso}`,
  }
}

/** Supplier and customer with the same name: one of the roles is wrong. */
function samePartyNames(decided: Map<CanonicalField, Decision>, issues: Issue[]) {
  const s = decided.get('supplier.name')
  const c = decided.get('customer.name')
  if (!s || !c || s.group.key !== c.group.key) return
  for (const d of [s, c]) {
    d.status = 'needs_review'
    d.competitor = true
    d.passed = []
  }
  issues.push({ severity: 'warning', code: 'role.conflict', message: `Supplier and customer have the same name "${s.group.rep.rawValue}".`, fields: ['supplier.name', 'customer.name'] })
}

/** Israeli VAT changed over time; a rate that does not match the invoice date is worth a note. */
function rateHistoryIssues(fields: Partial<Record<CanonicalField, ExtractedField>>, israeli: boolean): Issue[] {
  const rate = fields.tax_rate?.normalized
  const date = fields.invoice_date?.normalized
  if (!israeli || rate?.kind !== 'percent' || date?.kind !== 'date' || date.alternatives.length) return []
  if (Number(rate.value) === 0) return []
  const period = IL_VAT_HISTORY.find((p) => date.iso >= p.from)
  if (!period || Number(period.rate) === Number(rate.value)) return []
  return [
    {
      severity: 'info',
      code: 'tax.rate_unusual_for_date',
      message: `VAT ${rate.value}% on an invoice dated ${date.iso}; the Israeli standard rate then was ${period.rate}%.`,
      fields: ['tax_rate', 'invoice_date'],
    },
  ]
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const k = `${i.severity}|${i.code}|${i.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * summary.status: 'verified' only when every found standard field is verified, no error issue
 * exists and no core field is missing; 'needs_review' when any field needs review or an error
 * exists; else 'proposed'.
 * summary.confidence: the mean field confidence (core fields count double), times 0.9 per
 * missing core field and 0.75 per error. 0 when nothing was found.
 */
export function summarize(fields: Partial<Record<CanonicalField, ExtractedField>>, issues: readonly Issue[], missing: CanonicalField[]): ExtractionResult['summary'] {
  const found = Object.values(fields).filter((f): f is ExtractedField => !!f)
  const errors = issues.filter((i) => i.severity === 'error').length
  let status: FieldStatus
  if (!found.length || errors || found.some((f) => f.status === 'needs_review')) status = 'needs_review'
  else if (found.every((f) => f.status === 'verified') && !missing.length) status = 'verified'
  else status = 'proposed'
  let confidence = 0
  if (found.length) {
    let w = 0
    let s = 0
    for (const f of found) {
      const weight = f.field && CORE_FIELDS.includes(f.field) ? 2 : 1
      w += weight
      s += weight * f.confidence
    }
    confidence = (s / w) * 0.9 ** missing.length * 0.75 ** errors
  }
  return { status, confidence: round3(confidence), missing }
}
