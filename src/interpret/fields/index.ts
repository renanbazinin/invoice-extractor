import { wordsInSpan } from '../../lib/docIndex'
import type { ExtractedField, FieldCandidate, Structure } from '../../model/types'
import type { DocContext } from '../context'
import type { LineItemInterpretation } from '../lineItems'
import { buildFieldsContext, type FieldsContext } from './context'
import { currencyDrafts, resolveDollars } from './currency'
import { discoveredFields } from './discovered'
import { toCandidate, type Draft } from './draft'
import { metaDrafts, moneyDrafts, referenceDrafts } from './kvFields'
import { partyDrafts } from './parties'
import { documentTypeDrafts, titleLines, titleNumberDrafts, type TitleLine } from './title'
import { readDate } from './values'

export interface FieldInterpretation {
  candidates: FieldCandidate[]
  discovered: ExtractedField[]
  usedLineIds: string[]
}

/**
 * Header, parties, document meta, totals and discovered fields. Owned by the fields team.
 *
 * Order matters only where one reading informs another: the title first (a receipt's payment
 * total is its total), then key/values (numbers, dates, terms, money), the currency (marks on the
 * money found), parties, and finally every labelled value for `discovered`.
 */
export function interpretFields(ctx: DocContext, structure: Structure, items: LineItemInterpretation): FieldInterpretation {
  const fc = buildFieldsContext(ctx, structure, items)
  const titles = titleLines(fc)
  const docDrafts = documentTypeDrafts(fc, titles)
  const top = docDrafts[0]?.normalized
  fc.docType = top?.kind === 'document_type' ? top.value : null

  const drafts: Draft[] = [...docDrafts, ...titleNumberDrafts(fc, titles), ...metaDrafts(fc)]
  if (!drafts.some((d) => d.field === 'invoice_number' && d.score >= 0.5)) drafts.push(...referenceDrafts(fc))
  if (!drafts.some((d) => d.field === 'invoice_date')) drafts.push(...titleDateDrafts(fc, titles))
  const money = resolveDollars(fc, moneyDrafts(fc))
  drafts.push(...money, ...currencyDrafts(fc, money))
  const parties = partyDrafts(fc, titles[0]?.line ?? null)
  drafts.push(...parties.drafts)

  const unique = dedupe(drafts)
  const candidates = unique.map((d, i) => toCandidate(fc.index, d, i + 1)).filter((c): c is FieldCandidate => !!c)
  const discovered = discoveredFields(fc, unique)
  return { candidates, discovered, usedLineIds: usedLines(fc, unique, discovered, parties.usedLineIds) }
}

/** One draft per field and printed words: the same reading found twice is not corroboration. */
function dedupe(drafts: readonly Draft[]): Draft[] {
  const best = new Map<string, Draft>()
  for (const d of drafts) {
    const key = `${d.field}|${[...d.valueWordIds].sort().join(',')}|${JSON.stringify(d.normalized)}`
    const prev = best.get(key)
    if (!prev || d.score > prev.score) best.set(key, prev ? { ...d, signals: [...new Set([...d.signals, ...prev.signals])] } : d)
  }
  return [...best.values()]
}

/**
 * A date printed next to the title without a label ("חשבונית מס 123 · 16/02/2025"): a weak
 * invoice-date reading when no labelled one exists.
 */
function titleDateDrafts(fc: FieldsContext, titles: readonly TitleLine[]): Draft[] {
  const t = titles[0]
  if (!t) return []
  const page = fc.index.pageLines.get(t.line.page) ?? []
  const near = page.filter((l) => Math.abs(l.bbox.y0 - t.line.bbox.y0) <= 40 && !fc.itemLineIds.has(l.id))
  for (const l of near) {
    const d = readDate(l.text, fc.dateOrder)
    if (!d) continue
    const ids = wordsInSpan(fc.index, l, d.start, d.end)
    if (!ids.length) continue
    return [
      {
        field: 'invoice_date',
        rawValue: d.raw,
        normalized: { kind: 'date', iso: d.value.iso, alternatives: d.value.alternatives },
        valueWordIds: ids,
        labelWordIds: null,
        originalLabel: null,
        score: 0.25,
        method: 'pattern:date-near-title',
        signals: [],
      },
    ]
  }
  return []
}

function usedLines(fc: FieldsContext, drafts: readonly Draft[], discovered: readonly ExtractedField[], partyLines: readonly string[]): string[] {
  const out = new Set<string>(partyLines)
  const add = (ids: readonly string[] | null) => {
    for (const id of ids ?? []) {
      const l = fc.index.word.get(id)?.lineId
      if (l) out.add(l)
    }
  }
  for (const d of drafts) {
    add(d.valueWordIds)
    add(d.labelWordIds)
  }
  for (const f of discovered) {
    add(f.labelEvidence?.wordIds ?? null)
    add(f.evidence.flatMap((e) => e.wordIds))
  }
  return [...out]
}
