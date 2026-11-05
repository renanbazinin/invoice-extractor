import { evidenceOf, type DocIndex } from '../../lib/docIndex'
import type { CanonicalField, Evidence, ExtractedField, FieldCandidate, NormalizedValue, TextRef } from '../../model/types'

/**
 * Candidates are drafted with word ids only and turned into FieldCandidates in one place, so
 * every value (and label) is evidence on the page: nothing here can produce a value without the
 * words it was read from.
 */
export interface Draft {
  field: CanonicalField
  rawValue: string
  normalized: NormalizedValue
  valueWordIds: string[]
  labelWordIds: string[] | null
  originalLabel: string | null
  score: number
  method: string
  signals: string[]
}

/** Rounds a prior to two decimals and keeps it inside (0, 1). */
export function prior(x: number): number {
  return Math.round(Math.min(0.97, Math.max(0.02, x)) * 100) / 100
}

/** Evidence entries per page (a value printed over two pages is two entries). */
export function evidenceList(index: DocIndex, wordIds: readonly string[]): Evidence[] {
  const byPage = new Map<number, string[]>()
  for (const id of wordIds) {
    const w = index.word.get(id)
    if (!w) continue
    const list = byPage.get(w.page) ?? []
    if (!list.includes(id)) list.push(id)
    byPage.set(w.page, list)
  }
  return [...byPage.values()].map((ids) => evidenceOf(index, ids))
}

export function toCandidate(index: DocIndex, d: Draft, n: number): FieldCandidate | null {
  const evidence = evidenceList(index, d.valueWordIds)
  if (!evidence.length) return null
  const label = d.labelWordIds?.length ? evidenceList(index, d.labelWordIds)[0] ?? null : null
  return {
    id: `f${n}:${d.field}`,
    field: d.field,
    rawValue: d.rawValue,
    normalized: d.normalized,
    evidence,
    label,
    originalLabel: d.originalLabel,
    score: prior(d.score),
    method: d.method,
    signals: [...new Set(d.signals)],
  }
}

/** A labelled value outside (or also inside) the standard fields, as `discovered` wants it. */
export function discoveredField(
  index: DocIndex,
  label: TextRef,
  value: TextRef,
  field: CanonicalField | null,
  normalized: NormalizedValue | null,
  confidence: number,
  method: string,
): ExtractedField {
  return {
    field,
    originalLabel: label.text.replace(/[\s:：]+$/u, '').replace(/^[\s:：]+/u, ''),
    labelEvidence: evidenceOf(index, label.wordIds),
    rawValue: value.text,
    normalized,
    evidence: evidenceList(index, value.wordIds),
    confidence: prior(confidence),
    status: 'proposed',
    method,
    checks: [],
    alternatives: [],
  }
}

/** Word ids of `wordIds` (in order, joined by single spaces) that overlap [start, end) of their text. */
export function wordsOfSpan(index: DocIndex, wordIds: readonly string[], start: number, end: number): string[] {
  const out: string[] = []
  let pos = 0
  for (const id of wordIds) {
    const w = index.word.get(id)
    if (!w) continue
    const s = pos
    const e = pos + w.text.length
    if (e > start && s < end) out.push(id)
    pos = e + 1
  }
  return out
}

/** The text of some words, joined the way TextRef/Evidence texts are. */
export function textOfWords(index: DocIndex, wordIds: readonly string[]): string {
  return wordIds.map((id) => index.word.get(id)?.text ?? '').join(' ')
}
