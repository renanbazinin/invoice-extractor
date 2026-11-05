import type { DocumentModel, ExtractedField, FieldCandidate, LineItemCandidate, Structure } from '../model/types'
import { buildContext } from './context'
import { interpretFields } from './fields'
import { interpretLineItems } from './lineItems'

export interface Interpretation {
  candidates: FieldCandidate[]
  /** Rows of the main line-item table, in document order. */
  lineItems: LineItemCandidate[]
  /** Labelled values outside the standard fields (status 'proposed', `field` null or canonical). */
  discovered: ExtractedField[]
  /** Line ids consumed by a candidate, line item or discovered value. */
  usedLineIds: string[]
}

/** Layer 3: what the text means. Proposes; validation decides. */
export function interpret(doc: DocumentModel, structure: Structure): Interpretation {
  const ctx = buildContext(doc)
  const items = interpretLineItems(ctx, structure)
  const fields = interpretFields(ctx, structure, items)
  return {
    candidates: [...items.candidates, ...fields.candidates],
    lineItems: items.lineItems,
    discovered: fields.discovered,
    usedLineIds: [...new Set([...items.usedLineIds, ...fields.usedLineIds])],
  }
}
