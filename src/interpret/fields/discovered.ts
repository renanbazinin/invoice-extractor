import type { CanonicalField, ExtractedField, NormalizedValue } from '../../model/types'
import { looksLikeIdentifier, parseAmount, parseDate, parsePercent } from '../../semantic'
import type { FieldsContext, Pair } from './context'
import { discoveredField, type Draft } from './draft'

/**
 * Every labelled value on the page, as printed: meter and project numbers, periods, delivery
 * notes, customer numbers… Values read as a standard field keep that field (and its
 * normalization); the rest get `field: null` and a normalization by shape.
 */

/** Normalization by shape alone: a date, an amount, a percent, an id, else text. */
export function normalizeByShape(fc: FieldsContext, text: string): NormalizedValue {
  const date = parseDate(text, { order: fc.dateOrder })
  if (date?.whole) return { kind: 'date', iso: date.iso, alternatives: date.alternatives }
  const pct = parsePercent(text)
  if (pct && pct.raw.length >= text.trim().length - 1) return { kind: 'percent', value: pct.value }
  const amount = parseAmount(text, fc.ctx.numberFormat)
  if (amount && (amount.decimals > 0 || amount.currency)) return { kind: 'money', amount: amount.amount, currency: amount.currency }
  if (looksLikeIdentifier(text)) return { kind: 'id', value: text.trim().replace(/^[#:]+\s*/, ''), scheme: null, checksum: null }
  return { kind: 'text', value: text.trim() }
}

export function discoveredFields(fc: FieldsContext, drafts: readonly Draft[]): ExtractedField[] {
  const out: ExtractedField[] = []
  const byValue = new Map<string, Draft>()
  for (const d of drafts) {
    const key = [...d.valueWordIds].sort().join(',')
    const prev = byValue.get(key)
    if (!prev || d.score > prev.score) byValue.set(key, d)
  }
  for (const p of fc.pairs) {
    if (!/[\p{L}\p{N}]/u.test(p.value.text)) continue
    const mapped = draftOfPair(p, drafts, byValue)
    const field: CanonicalField | null = mapped?.field ?? null
    const normalized = mapped?.normalized ?? normalizeByShape(fc, p.value.text)
    const confidence = p.score * (p.sense.primary ? 0.9 : 0.7)
    const f = discoveredField(fc.index, p.label, p.value, field, normalized, confidence, `kv:${p.layout}`)
    const period = periodInOrder(fc, p.value.text)
    if (period) {
      f.rawValue = period
      f.normalized = { kind: 'text', value: period }
    }
    out.push(f)
  }
  return out
}

/**
 * "23/2/2026 - 30/12/2025": a period read end-first. In a Hebrew line the two dates are separate
 * left-to-right runs and the reader's ordering can swap them; a period runs from the earlier date
 * to the later one, so the dates are put back in that order (same words, same characters).
 */
export function periodInOrder(fc: FieldsContext, text: string): string | null {
  const m = /^\s*(\S+)\s*([-–—])\s*(\S+)\s*$/u.exec(text)
  if (!m) return null
  const a = parseDate(m[1]!, { order: fc.dateOrder })
  const b = parseDate(m[3]!, { order: fc.dateOrder })
  if (!a?.whole || !b?.whole || a.iso <= b.iso) return null
  return `${m[3]} ${m[2]} ${m[1]}`
}

/** The best standard-field draft read from this pair's value words, if any. */
function draftOfPair(p: Pair, drafts: readonly Draft[], byValue: Map<string, Draft>): Draft | null {
  const labelKey = p.label.wordIds.join(',')
  const values = new Set(p.value.wordIds)
  let best: Draft | null = null
  for (const d of drafts) {
    if (d.labelWordIds?.join(',') !== labelKey) continue
    if (!d.valueWordIds.every((id) => values.has(id))) continue
    if (!best || d.score > best.score) best = d
  }
  return best ?? byValue.get([...p.value.wordIds].sort().join(',')) ?? null
}
