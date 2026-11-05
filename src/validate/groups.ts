import type { CanonicalField, Evidence, FieldCandidate, NormalizedValue } from '../model/types'
import { canonical, isDecimalString } from '../lib/decimal'
import { foldForMatch } from '../lib/text'
import { wordIdsOf } from './evidence'

/**
 * All candidates of one field that read the same value. The same amount printed in the totals box
 * and again in the header is one reading seen twice (corroboration), not two competing readings,
 * so validation chooses between groups, never between duplicate candidates.
 */
export interface ValueGroup {
  /** `${field}#${n}`, stable within one resolve() call. */
  id: string
  field: CanonicalField
  /** Comparison key of the value (see valueKey). */
  key: string
  /** Best first. */
  candidates: FieldCandidate[]
  /** The best candidate: its raw text, label and method represent the group. */
  rep: FieldCandidate
  /** Combined prior after adjustments (see combinePriors). */
  prior: number
  /** Every word any candidate of the group was read from. */
  wordIds: ReadonlySet<string>
  /** Every evidence entry, the representative's first, without duplicates. */
  evidence: Evidence[]
  /** Why the prior was lowered, e.g. 'currency-mismatch'. */
  notes: string[]
}

/**
 * The key two readings must share to be "the same value". Money/percent/decimal compare
 * numerically, dates by ISO day, ids without separators and case, text folded without spaces and
 * punctuation. Returns null for a malformed normalized value (it is dropped with an issue).
 */
export function valueKey(n: NormalizedValue): string | null {
  switch (n.kind) {
    case 'money':
      return isDecimalString(n.amount) ? `m:${canonical(n.amount)}` : null
    case 'percent':
      return isDecimalString(n.value) ? `p:${canonical(n.value)}` : null
    case 'decimal':
      return isDecimalString(n.value) ? `d:${canonical(n.value)}` : null
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(n.iso) ? `t:${n.iso}` : null
    case 'currency':
      return n.code ? `c:${n.code.toUpperCase()}` : null
    case 'document_type':
      return `k:${n.value}`
    case 'id': {
      const v = n.value.replace(/[\s\-./]/g, '').toUpperCase()
      return v ? `i:${v}` : null
    }
    case 'text': {
      const v = foldForMatch(n.value).replace(/[\s\p{P}\p{S}]/gu, '')
      return v ? `x:${v}` : null
    }
  }
}

/**
 * Duplicates corroborate but are not independent (the same software printed both), so they only
 * add a little: best + 30% of the remaining room times the noisy-or of the others. Two 0.6
 * readings give 0.672, not 0.84.
 */
export function combinePriors(scores: readonly number[]): number {
  if (!scores.length) return 0
  const sorted = [...scores].sort((a, b) => b - a)
  const top = clamp01(sorted[0]!)
  const othersNone = sorted.slice(1).reduce((acc, p) => acc * (1 - clamp01(p)), 1)
  return top + (1 - top) * 0.3 * (1 - othersNone)
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

export interface GroupingResult {
  byField: Map<CanonicalField, ValueGroup[]>
  /** Candidates whose normalized value could not be keyed. */
  malformed: FieldCandidate[]
}

/**
 * Groups candidates per field and value, sorted by combined prior (best first).
 *
 * @param scoreOf the adjusted prior of each candidate (see priors.ts)
 * @param notesOf why the candidate's prior was adjusted
 */
export function groupCandidates(
  candidates: readonly FieldCandidate[],
  scoreOf: (c: FieldCandidate) => number,
  notesOf: (c: FieldCandidate) => readonly string[] = () => [],
): GroupingResult {
  const buckets = new Map<CanonicalField, Map<string, FieldCandidate[]>>()
  const malformed: FieldCandidate[] = []
  for (const c of candidates) {
    const key = valueKey(c.normalized)
    if (key === null) {
      malformed.push(c)
      continue
    }
    let perField = buckets.get(c.field)
    if (!perField) buckets.set(c.field, (perField = new Map()))
    const list = perField.get(key)
    if (list) list.push(c)
    else perField.set(key, [c])
  }

  const byField = new Map<CanonicalField, ValueGroup[]>()
  for (const [field, perField] of buckets) {
    const groups: ValueGroup[] = []
    for (const [key, list] of perField) {
      const sorted = [...list].sort((a, b) => scoreOf(b) - scoreOf(a) || a.id.localeCompare(b.id))
      const rep = sorted[0]!
      groups.push({
        id: '',
        field,
        key,
        candidates: sorted,
        rep,
        prior: combinePriors(sorted.map(scoreOf)),
        wordIds: new Set(sorted.flatMap((c) => wordIdsOf(c.evidence))),
        evidence: dedupeEvidence(sorted.flatMap((c) => c.evidence)),
        notes: [...new Set(sorted.flatMap((c) => notesOf(c)))],
      })
    }
    groups.sort((a, b) => b.prior - a.prior || a.key.localeCompare(b.key))
    groups.forEach((g, i) => (g.id = `${field}#${i}`))
    byField.set(field, groups)
  }
  return { byField, malformed }
}

function dedupeEvidence(list: readonly Evidence[]): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const e of list) {
    const k = `${e.page}:${e.wordIds.join(',')}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}
