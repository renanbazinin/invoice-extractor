import type { BBox, Evidence, ExtractedField, ExtractionResult, LineItem } from '../../src/model/types'

/** What is highlighted on the page: the printed value, its label, or a whole row. */
export interface Box {
  page: number
  bbox: BBox
  kind: 'value' | 'label' | 'row'
}

export interface Focus {
  key: string
  boxes: Box[]
}

const boxes = (ev: readonly Evidence[], kind: Box['kind']): Box[] => ev.map((e) => ({ page: e.page, bbox: e.bbox, kind }))

export function fieldFocus(key: string, f: ExtractedField): Focus {
  return { key, boxes: [...boxes(f.evidence, 'value'), ...(f.labelEvidence ? boxes([f.labelEvidence], 'label') : [])] }
}

export function itemFocus(li: LineItem): Focus {
  return { key: `item:${li.index}`, boxes: boxes([li.row], 'row') }
}

export function lineFocus(r: ExtractionResult, lineId: string): Focus {
  const line = r.document.lines.find((l) => l.id === lineId)
  return { key: `line:${lineId}`, boxes: line ? [{ page: line.page, bbox: line.bbox, kind: 'row' }] : [] }
}

/** Where a clicked word is used, by priority: a standard field, a line item, another field. */
export function whereUsed(r: ExtractionResult, wordId: string): { tab: 'fields' | 'items' | 'other' | 'text'; focus: Focus } {
  const has = (ev: readonly Evidence[] | null | undefined) => !!ev?.some((e) => e.wordIds.includes(wordId))
  for (const [key, f] of Object.entries(r.fields)) if (f && has(f.evidence)) return { tab: 'fields', focus: fieldFocus(key, f) }
  for (const [key, f] of Object.entries(r.fields)) if (f?.labelEvidence && has([f.labelEvidence])) return { tab: 'fields', focus: fieldFocus(key, f) }
  for (const li of r.lineItems) if (has([li.row])) return { tab: 'items', focus: itemFocus(li) }
  for (const [i, d] of r.discovered.entries())
    if (has(d.evidence) || (d.labelEvidence && has([d.labelEvidence]))) return { tab: 'other', focus: fieldFocus(`other:${i}`, d) }
  const word = r.document.words.find((w) => w.id === wordId)
  return { tab: 'text', focus: lineFocus(r, word?.lineId ?? '') }
}
