import type { FieldStatus } from '../model/types'
import { CALIBRATION } from './policy'

/**
 * ExtractedField.confidence. The prior is moved in log-odds space by what validation learned
 * (each exact independent check multiplies the odds by e^2.5 ≈ 12, a failure divides them by
 * e^3 ≈ 20, …), then clamped into the band of the field's status so the two never disagree: a
 * verified field is always ≥ 0.95 and a needs_review one ≤ 0.6. The bands carry the calibration
 * promise (verified values are expected to be right essentially always); within a band the order
 * of values is meaningful, the absolute number is a ranking aid.
 */
export interface CalibrationInput {
  exact?: number
  approx?: number
  failed?: number
  competitor?: boolean
  ambiguous?: boolean
  weakText?: boolean
}

export function calibrate(prior: number, status: FieldStatus, f: CalibrationInput = {}): number {
  const p = Math.min(0.98, Math.max(0.02, Number.isFinite(prior) ? prior : 0.02))
  let logit = Math.log(p / (1 - p))
  logit += (f.exact ?? 0) * CALIBRATION.exactCheck
  logit += (f.approx ?? 0) * CALIBRATION.approxCheck
  logit += (f.failed ?? 0) * CALIBRATION.failedCheck
  if (f.competitor) logit += CALIBRATION.competitor
  if (f.ambiguous) logit += CALIBRATION.ambiguous
  if (f.weakText) logit += CALIBRATION.weakText
  const raw = 1 / (1 + Math.exp(-logit))
  const [lo, hi] = CALIBRATION.band[status]
  return round3(Math.min(hi, Math.max(lo, raw)))
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
