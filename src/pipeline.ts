import type { ExtractionResult } from './model/types'
import { interpret } from './interpret'
import { readDocument, type ReadOptions } from './read'
import { analyzeStructure } from './structure'
import { resolve } from './validate'

export type ExtractOptions = ReadOptions

/** Runs the four layers: read → structure → interpret → validate. */
export async function extract(bytes: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractionResult> {
  const document = await readDocument(bytes, opts)
  const structure = analyzeStructure(document)
  const meaning = interpret(document, structure)
  const resolved = resolve({ document, candidates: meaning.candidates, lineItems: meaning.lineItems })
  const used = new Set(meaning.usedLineIds)
  return {
    schemaVersion: 1,
    document,
    structure,
    fields: resolved.fields,
    lineItems: resolved.lineItems,
    discovered: meaning.discovered,
    unclassifiedLineIds: document.lines.filter((l) => !used.has(l.id)).map((l) => l.id),
    derived: resolved.derived,
    checks: resolved.checks,
    issues: resolved.issues,
    summary: resolved.summary,
  }
}
