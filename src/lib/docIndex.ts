import type { Block, DocumentModel, Evidence, Line, TextRef, Word } from '../model/types'
import { union } from './geometry'

/** Lookups every layer after the reader needs. Build once per document. */
export interface DocIndex {
  doc: DocumentModel
  word: Map<string, Word>
  line: Map<string, Line>
  block: Map<string, Block>
  /** Lines of each page in reading order. */
  pageLines: Map<number, Line[]>
}

export function indexDocument(doc: DocumentModel): DocIndex {
  const pageLines = new Map<number, Line[]>()
  for (const page of doc.pages) pageLines.set(page.number, [])
  for (const line of doc.lines) pageLines.get(line.page)?.push(line)
  return {
    doc,
    word: new Map(doc.words.map((w) => [w.id, w])),
    line: new Map(doc.lines.map((l) => [l.id, l])),
    block: new Map(doc.blocks.map((b) => [b.id, b])),
    pageLines,
  }
}

/**
 * Evidence for some words, in the order given (callers pass logical order). The text is the words
 * joined by single spaces, so it reads like the line it came from.
 */
export function evidenceOf(index: DocIndex, wordIds: readonly string[]): Evidence {
  const words = wordIds.map((id) => {
    const w = index.word.get(id)
    if (!w) throw new Error(`Unknown word id ${id}`)
    return w
  })
  if (!words.length) throw new Error('Evidence needs at least one word')
  return { page: words[0].page, wordIds: words.map((w) => w.id), text: words.map((w) => w.text).join(' '), bbox: union(words.map((w) => w.bbox)) }
}

/** A TextRef has the same shape as Evidence. */
export const textRefOf: (index: DocIndex, wordIds: readonly string[]) => TextRef = evidenceOf

export function lineRef(index: DocIndex, line: Line): TextRef {
  return evidenceOf(index, line.wordIds)
}

/** Words of a line whose text, joined in order, covers [start, end) of `line.text`. */
export function wordsInSpan(index: DocIndex, line: Line, start: number, end: number): string[] {
  const out: string[] = []
  let pos = 0
  for (const id of line.wordIds) {
    const w = index.word.get(id)!
    const s = pos
    const e = pos + w.text.length
    if (e > start && s < end) out.push(id)
    pos = e + 1
  }
  return out
}
