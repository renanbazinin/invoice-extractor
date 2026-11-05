/**
 * Supplier templates: which one fits a document, and what it changes.
 *
 * A template matches when the document prints one of its tax ids (anywhere, in any grouping:
 * "51-555555-5", "515555555"), or else when one of its names is printed. A tax id match beats a
 * name match, and the first template in the list wins a tie (callers list user templates first).
 *
 * Each rule yields a value for a field: the words inside a box taught on one of the supplier's
 * invoices, the value printed after one of its own labels, or a fixed fact. Then:
 *
 *   - the extractor read the same value: it stands ('needs_review' becomes 'proposed');
 *   - the extractor read nothing, or something unconfirmed: the template's value, 'proposed';
 *   - the extractor verified a different value: the template's value, 'needs_review', with the
 *     extractor's reading kept as the alternative (one of the two is wrong, a person decides).
 *
 * A template value is never 'verified': a template is a rule about a layout, and layouts change.
 */
import type { BBox, CanonicalField, DocumentModel, Evidence, ExtractedField, ExtractionResult, NormalizedValue, Word } from '../model/types'
import { foldForMatch } from '../lib/text'
import { buildContext } from '../interpret/context'
import { normalizeFor, sameValue } from './values'
import type { SupplierTemplate } from './types'

export interface TemplateNote {
  field: CanonicalField
  rule: 'fixed' | 'label' | 'region'
  /** 'same': the extractor agrees; 'filled': nothing was found; 'replaced': it read another value. */
  outcome: 'same' | 'filled' | 'replaced'
  message: string
}

export interface AppliedTemplate {
  template: SupplierTemplate
  /** How the template was chosen. */
  matchedBy: 'tax_id' | 'name' | 'manual'
  /** The result's fields with the template's values in place. */
  fields: Partial<Record<CanonicalField, ExtractedField>>
  notes: TemplateNote[]
}

/** Every number printed with at most single separators between digits ("51-555555-5" → "515555555"). */
function printedNumbers(doc: DocumentModel): Set<string> {
  const out = new Set<string>()
  for (const l of doc.lines)
    for (const m of l.text.matchAll(/\d(?:\d|[-./ ](?=\d))*/g)) {
      const all = m[0].replace(/\D/g, '')
      if (all.length >= 5) out.add(all)
      for (const part of m[0].split(' ')) {
        const p = part.replace(/\D/g, '')
        if (p.length >= 5) out.add(p)
      }
    }
  return out
}

/** Israeli ids are compared on 9 digits ("30000012" is "030000012"). */
export function idKey(id: string): string {
  const d = id.replace(/[^\dA-Za-z]/g, '').toUpperCase()
  return /^\d{8}$/.test(d) ? `0${d}` : d
}

/** The best template for a document, or null. */
export function matchSupplierTemplate(
  result: ExtractionResult,
  templates: readonly SupplierTemplate[],
): { template: SupplierTemplate; matchedBy: 'tax_id' | 'name' } | null {
  const numbers = new Set([...printedNumbers(result.document)].map(idKey))
  for (const t of templates) if (t.match.taxIds.some((id) => idKey(id).length >= 5 && numbers.has(idKey(id)))) return { template: t, matchedBy: 'tax_id' }
  const text = foldForMatch(result.document.lines.map((l) => l.text).join('\n'))
  for (const t of templates)
    if (t.match.names.some((n) => foldForMatch(n).trim().length >= 3 && text.includes(foldForMatch(n).trim()))) return { template: t, matchedBy: 'name' }
  return null
}

interface RuleValue {
  field: CanonicalField
  rule: TemplateNote['rule']
  raw: string
  normalized: NormalizedValue
  evidence: Evidence[]
  label: Evidence | null
  originalLabel: string | null
}

function evidenceOf(words: ReadonlyMap<string, Word>, wordIds: readonly string[]): Evidence[] {
  const byLine = new Map<string, string[]>()
  for (const id of wordIds) {
    const w = words.get(id)
    if (w) byLine.set(w.lineId, [...(byLine.get(w.lineId) ?? []), id])
  }
  return [...byLine.values()].map((ids) => {
    const ws = ids.map((id) => words.get(id)!)
    return {
      page: ws[0]!.page,
      wordIds: ids,
      text: ws.map((w) => w.text).join(' '),
      bbox: { x0: Math.min(...ws.map((w) => w.bbox.x0)), y0: Math.min(...ws.map((w) => w.bbox.y0)), x1: Math.max(...ws.map((w) => w.bbox.x1)), y1: Math.max(...ws.map((w) => w.bbox.y1)) },
    }
  })
}

/** The words whose centre lies inside a box (fractions of the page), in reading order. */
export function wordsInBox(doc: DocumentModel, page: number, box: BBox): string[] {
  const p = doc.pages.find((x) => x.number === page)
  if (!p) return []
  const inside = new Set(
    doc.words
      .filter((w) => w.page === page)
      .filter((w) => {
        const cx = (w.bbox.x0 + w.bbox.x1) / 2 / p.width
        const cy = (w.bbox.y0 + w.bbox.y1) / 2 / p.height
        return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1
      })
      .map((w) => w.id),
  )
  return doc.lines.filter((l) => l.page === page).flatMap((l) => l.wordIds.filter((id) => inside.has(id)))
}

/** The box around some words, as fractions of their page, with a margin of half a line. */
export function boxAround(doc: DocumentModel, wordIds: readonly string[]): { page: number; box: BBox } | null {
  const ws = doc.words.filter((w) => wordIds.includes(w.id))
  const page = doc.pages.find((p) => p.number === ws[0]?.page)
  if (!ws.length || !page) return null
  const h = Math.max(...ws.map((w) => w.bbox.y1 - w.bbox.y0)) * 0.5
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  return {
    page: page.number,
    box: {
      x0: clamp((Math.min(...ws.map((w) => w.bbox.x0)) - h) / page.width),
      y0: clamp((Math.min(...ws.map((w) => w.bbox.y0)) - h) / page.height),
      x1: clamp((Math.max(...ws.map((w) => w.bbox.x1)) + h) / page.width),
      y1: clamp((Math.max(...ws.map((w) => w.bbox.y1)) + h) / page.height),
    },
  }
}

/** A word that is only punctuation after a label (":", "-"). */
const PUNCT_ONLY = /^[\s:：\-–—.]+$/

function ruleValues(result: ExtractionResult, t: SupplierTemplate): RuleValue[] {
  const doc = result.document
  const ctx = buildContext(doc)
  const words = new Map(doc.words.map((w) => [w.id, w]))
  const currency = result.fields.currency?.normalized?.kind === 'currency' ? result.fields.currency.normalized.code : ctx.currency
  const opts = { currency, monthFirst: ctx.dateOrder === 'MDY' }
  const out: RuleValue[] = []
  for (const r of t.regions) {
    const ids = wordsInBox(doc, r.page, r.box)
    if (!ids.length) continue
    const ev = evidenceOf(words, ids)
    const raw = ev.map((e) => e.text).join(' ')
    const n = normalizeFor(r.field, raw, opts)
    if (n) out.push({ field: r.field, rule: 'region', raw, normalized: n, evidence: ev, label: null, originalLabel: null })
  }
  for (const { label, field } of t.labels) {
    const want = foldForMatch(label).trim()
    if (!want) continue
    // A labelled value the pipeline already found ("Other fields"), else the rest of the line.
    const d = result.discovered.find((x) => x.originalLabel && foldForMatch(x.originalLabel).trim() === want)
    const dn = d && normalizeFor(field, d.rawValue, opts)
    if (d && dn) {
      out.push({ field, rule: 'label', raw: d.rawValue, normalized: dn, evidence: d.evidence, label: d.labelEvidence, originalLabel: d.originalLabel })
      continue
    }
    for (const line of doc.lines) {
      if (!foldForMatch(line.text).includes(want)) continue
      // The label ends at the first word that completes it; the value is the words after it.
      const ids = line.wordIds
      let end = -1
      let acc = ''
      for (let i = 0; i < ids.length && end < 0; i++) {
        acc += ` ${words.get(ids[i]!)?.text ?? ''}`
        if (foldForMatch(acc).includes(want)) end = i
      }
      const rest = ids.slice(end + 1).filter((id) => !PUNCT_ONLY.test(words.get(id)?.text ?? ':'))
      if (end < 0 || !rest.length) continue
      const raw = rest.map((id) => words.get(id)!.text).join(' ')
      const n = normalizeFor(field, raw, opts)
      if (!n) continue
      out.push({ field, rule: 'label', raw, normalized: n, evidence: evidenceOf(words, rest), label: evidenceOf(words, ids.slice(0, end + 1))[0] ?? null, originalLabel: label })
      break
    }
  }
  for (const [field, value] of Object.entries(t.fixed) as [CanonicalField, string][]) {
    if (!value?.trim()) continue
    const n = normalizeFor(field, value, opts)
    if (n) out.push({ field, rule: 'fixed', raw: value.trim(), normalized: n, evidence: [], label: null, originalLabel: null })
  }
  return out
}

/** Applies a supplier template to a result; the result itself is left unchanged. */
export function applySupplierTemplate(result: ExtractionResult, template: SupplierTemplate, matchedBy: AppliedTemplate['matchedBy']): AppliedTemplate {
  const fields: Partial<Record<CanonicalField, ExtractedField>> = { ...result.fields }
  const notes: TemplateNote[] = []
  const done = new Set<CanonicalField>()
  // Rules come in order of precedence: a taught box, then a label, then a fixed fact.
  for (const v of ruleValues(result, template)) {
    if (done.has(v.field)) continue
    done.add(v.field)
    const have = result.fields[v.field]
    const source = `Template "${template.name}"`
    if (have && sameValue(have.normalized, v.normalized)) {
      // Agreeing with the supplier's known layout settles a doubt, but is no independent check.
      if (have.status === 'needs_review') fields[v.field] = { ...have, status: 'proposed' }
      notes.push({ field: v.field, rule: v.rule, outcome: 'same', message: `${source} reads the same value${have.status === 'needs_review' ? ', so it is proposed instead of needing review' : ''}.` })
      continue
    }
    fields[v.field] = {
      field: v.field,
      originalLabel: v.originalLabel,
      labelEvidence: v.label,
      rawValue: v.raw,
      normalized: v.normalized,
      evidence: v.evidence,
      confidence: v.rule === 'fixed' ? 0.6 : 0.7,
      status: have?.status === 'verified' ? 'needs_review' : 'proposed',
      method: `template:${v.rule}`,
      checks: [],
      alternatives: have ? [{ rawValue: have.rawValue, normalized: have.normalized, evidence: have.evidence, confidence: have.confidence }, ...have.alternatives] : [],
    }
    notes.push({
      field: v.field,
      rule: v.rule,
      outcome: have ? 'replaced' : 'filled',
      message: have
        ? `${source} reads "${v.raw}" where the extractor read "${have.rawValue}"${have.status === 'verified' ? ' and verified it: check which is right' : ''}.`
        : `${source} supplied "${v.raw}".`,
    })
  }
  return { template, matchedBy, fields, notes }
}
