import type { ExtractedField, FieldStatus, NormalizedValue, ValidationCheck } from '../model/types'
import { abs, dec, isDecimalString, str } from '../lib/decimal'
import { money, type CheckEval } from './arith'
import { round3 } from './confidence'
import type { ValueGroup } from './groups'

/** Output shapes: ExtractedField from a chosen group, ValidationCheck from an arithmetic check. */

export function extractedField(
  group: ValueGroup,
  normalized: NormalizedValue,
  status: FieldStatus,
  confidence: number,
  checkIds: readonly string[],
  alternatives: readonly ValueGroup[],
): ExtractedField {
  return {
    field: group.field,
    originalLabel: group.rep.originalLabel,
    labelEvidence: group.rep.label,
    rawValue: group.rep.rawValue,
    normalized,
    evidence: group.evidence,
    confidence,
    status,
    method: group.rep.method,
    checks: [...new Set(checkIds)],
    alternatives: alternatives.map((a) => ({
      rawValue: a.rep.rawValue,
      normalized: a.rep.normalized,
      evidence: a.evidence,
      confidence: round3(Math.min(a.prior, confidence)),
    })),
  }
}

/** Discount is a positive number by definition, however it is printed ("-100.00", "(100)"). */
export function positiveMoney(n: NormalizedValue): NormalizedValue {
  if (n.kind !== 'money' || !isDecimalString(n.amount)) return n
  const d = dec(n.amount)
  return d.units < 0n ? { ...n, amount: str(abs(d)) } : n
}

export function toValidationCheck(c: CheckEval): ValidationCheck {
  const exp = money(c.expected)
  const act = money(c.actual)
  const tail = [
    c.grade === 'approx' ? 'within rounding tolerance; not used to verify' : '',
    c.grade === 'close' ? 'within one rounding step: confirms roles, verifies only embedded text' : '',
    c.kind === 'corroboration' && c.grade !== 'fail' ? 'corroboration only' : '',
    c.note,
  ]
    .filter(Boolean)
    .join('; ')
  return {
    id: c.id,
    status: c.grade === 'fail' ? 'fail' : 'pass',
    fields: c.fields,
    expected: exp,
    actual: act,
    message: `${c.formula}: expected ${exp}, printed ${act}${tail ? ` (${tail})` : ''}`,
  }
}
