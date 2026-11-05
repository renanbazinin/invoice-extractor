import type { CanonicalField, DerivedValue } from '../model/types'
import { abs, add, cmp, dec, div, fromInt, isZero, mul, neg, str, sub, type Dec } from '../lib/decimal'
import { KNOWN_TAX_RATES, TOLERANCE } from './policy'
import type { MoneyVar } from './arith'
import type { MoneyDecision } from './money'

/**
 * Values that are not printed but follow from verified ones. They go to `derived` with their
 * formula and never into `fields` (ARCHITECTURE ground rule 2). Only verified inputs are used:
 * a derived value is exactly as trustworthy as what it is computed from.
 */

export interface DeriveInput {
  money: Map<MoneyVar, MoneyDecision>
  /** Fields present in the output (a derived value is only produced for a missing field). */
  present: ReadonlySet<CanonicalField>
  /** Credit note: arithmetic ran on magnitudes; results take the printed sign of the total. */
  absMode: boolean
  /** Explicit currencies printed on the chosen amounts (for a missing currency field). */
  amountCurrencies: { field: CanonicalField; currency: string | null }[]
  /**
   * The page mentions a discount / a rounding that no chosen field holds. A formula that would
   * treat the missing adjustment as zero is then not trusted.
   */
  unheldDiscount: boolean
  unheldRounding: boolean
  /** A previous balance / retention is printed between total and due: due ≠ total − paid. */
  unheldAdjustment?: boolean
  /** Several VAT rates are printed: there is no single rate to derive. */
  multiRate?: boolean
}

const STEP = dec(TOLERANCE.step)
const HUNDRED = fromInt(100)

export function deriveValues(input: DeriveInput): DerivedValue[] {
  const { money, present } = input
  const out: DerivedValue[] = []
  const ok = (v: MoneyVar) => money.get(v)?.status === 'verified'
  const okOrAbsent = (v: MoneyVar) => !money.has(v) || ok(v)
  const val = (v: MoneyVar): Dec => money.get(v)!.option.value
  const opt = (v: MoneyVar): Dec | null => (money.has(v) ? val(v) : null)
  const negative = input.absMode && [...money.values()].some((d) => (d.v === 'total' || d.v === 'subtotal') && amountOf(d).units < 0n)
  const signed = (d: Dec) => (negative ? neg(d) : d)
  const missing = (f: CanonicalField) => !present.has(f)
  const moneyOut = (field: MoneyVar, d: Dec, formula: string, inputs: MoneyVar[], note: string) =>
    out.push({ field, normalized: { kind: 'money', amount: str(signed(d), 2), currency: currencyOf(input) }, formula, inputs, note })

  const D = opt('discount')
  const R = opt('rounding')
  // An adjustment printed but not extracted would make every "absent = 0" formula wrong.
  const adjOk = okOrAbsent('discount') && okOrAbsent('rounding') && !(input.unheldDiscount && !D) && !(input.unheldRounding && !R)
  const adjInputs = (): MoneyVar[] => [...(D ? (['discount'] as const) : []), ...(R ? (['rounding'] as const) : [])]

  if (missing('subtotal') && ok('total') && ok('tax_amount') && adjOk) {
    let s = sub(val('total'), val('tax_amount'))
    if (R) s = sub(s, R)
    if (D) s = add(s, D)
    moneyOut('subtotal', s, `total - tax_amount${R ? ' - rounding' : ''}${D ? ' + discount' : ''}`, ['total', 'tax_amount', ...adjInputs()], 'not printed; computed from verified totals')
  }
  if (missing('tax_amount') && ok('total') && ok('subtotal') && adjOk) {
    let t = sub(val('total'), val('subtotal'))
    if (D) t = add(t, D)
    if (R) t = sub(t, R)
    moneyOut('tax_amount', t, `total - subtotal${D ? ' + discount' : ''}${R ? ' - rounding' : ''}`, ['total', 'subtotal', ...adjInputs()], 'not printed; computed from verified totals')
  }
  if (missing('total')) {
    if (ok('subtotal') && ok('tax_amount') && adjOk) {
      let g = add(val('subtotal'), val('tax_amount'))
      if (D) g = sub(g, D)
      if (R) g = add(g, R)
      moneyOut('total', g, `subtotal${D ? ' - discount' : ''} + tax_amount${R ? ' + rounding' : ''}`, ['subtotal', 'tax_amount', ...adjInputs()], 'not printed; computed from verified amounts')
    } else if (ok('amount_due') && ok('amount_paid') && !input.unheldAdjustment) {
      moneyOut('total', add(val('amount_due'), val('amount_paid')), 'amount_due + amount_paid', ['amount_due', 'amount_paid'], 'not printed; computed from verified amounts')
    }
  }
  if (missing('amount_due') && ok('total') && ok('amount_paid') && !input.unheldAdjustment) {
    moneyOut('amount_due', sub(val('total'), val('amount_paid')), 'total - amount_paid', ['total', 'amount_paid'], 'no payable figure printed; computed from verified amounts')
  }
  if (missing('tax_rate') && ok('tax_amount') && !input.multiRate) {
    const rate = impliedRate(input)
    if (rate) out.push(rate)
  }
  if (missing('currency')) {
    const codes = [...new Set(input.amountCurrencies.map((a) => a.currency?.toUpperCase()).filter((x): x is string => !!x))]
    if (codes.length === 1) {
      out.push({
        field: 'currency',
        normalized: { kind: 'currency', code: codes[0]! },
        formula: 'currency printed on the amounts',
        inputs: input.amountCurrencies.filter((a) => a.currency).map((a) => a.field),
        note: 'no currency label; taken from the currency sign of the amounts',
      })
    }
  }
  return out
}

function amountOf(d: MoneyDecision): Dec {
  const n = d.option.group.rep.normalized
  return n.kind === 'money' ? dec(n.amount) : d.option.value
}

function currencyOf(input: DeriveInput): string | null {
  const codes = [...new Set(input.amountCurrencies.map((a) => a.currency?.toUpperCase()).filter((x): x is string => !!x))]
  return codes.length === 1 ? codes[0]! : null
}

/**
 * The single known VAT rate that reproduces the verified tax from the verified base. Several
 * matching rates (tiny amounts) or none: no derived rate.
 */
function impliedRate(input: DeriveInput): DerivedValue | null {
  const { money } = input
  const ok = (v: MoneyVar) => money.get(v)?.status === 'verified'
  const okOrAbsent = (v: MoneyVar) => !money.has(v) || ok(v)
  const T = money.get('tax_amount')!.option.value
  let base: Dec | null = null
  let formula = ''
  let inputs: MoneyVar[] = []
  if (ok('subtotal') && okOrAbsent('discount')) {
    base = money.get('subtotal')!.option.value
    const D = money.get('discount')?.option.value
    if (D) base = sub(base, D)
    formula = D ? 'tax_amount / (subtotal - discount) × 100' : 'tax_amount / subtotal × 100'
    inputs = ['tax_amount', 'subtotal', ...(D ? (['discount'] as const) : [])]
  } else if (ok('total') && okOrAbsent('rounding')) {
    base = sub(money.get('total')!.option.value, T)
    const R = money.get('rounding')?.option.value
    if (R) base = sub(base, R)
    formula = 'tax_amount / (total - tax_amount) × 100'
    inputs = ['tax_amount', 'total', ...(R ? (['rounding'] as const) : [])]
  }
  if (!base || isZero(base)) return null
  const matches = KNOWN_TAX_RATES.filter((k) => cmp(abs(sub(div(mul(abs(base!), dec(k)), HUNDRED, 2), abs(T))), STEP) <= 0)
  if (matches.length !== 1) return null
  return {
    field: 'tax_rate',
    normalized: { kind: 'percent', value: matches[0]! },
    formula,
    inputs,
    note: `no rate printed; ${matches[0]}% is the only standard rate that reproduces the verified tax`,
  }
}
