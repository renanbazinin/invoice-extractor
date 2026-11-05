import type { Block, DocumentModel, Evidence, Line, Word } from '../model/types'
import { foldForMatch } from '../lib/text'

/** All word ids an evidence list points at. */
export function wordIdsOf(evidence: readonly Evidence[]): string[] {
  return evidence.flatMap((e) => e.wordIds)
}

/** True when the two sets share a word: the same printed text read twice. */
export function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size > b.size) return overlaps(b, a)
  for (const id of a) if (b.has(id)) return true
  return false
}

/**
 * Read-only lookups into the DocumentModel that validation needs: word confidence (an OCR word at
 * 0.5 cannot verify anything on its own), blocks (a supplier name next to a checksum-valid tax id),
 * line coverage (a name that is only part of its line may be truncated) and the page text (dates
 * and cash cues outside any candidate).
 */
export interface DocIndex {
  /**
   * Lowest text confidence among the words. A word id the document does not know counts as 0:
   * text nobody can point at is not trusted (label-only and coarse verification then fail safe).
   */
  minConfidence(wordIds: Iterable<string>): number
  /** Block ids of the words (via their lines). */
  blocksOf(wordIds: Iterable<string>): Set<string>
  /**
   * True when every word of every line the value touches is either the value or its label, i.e.
   * the value is not a fragment of a longer printed text. null when the words are unknown.
   */
  coversLines(valueWordIds: readonly string[], labelWordIds: readonly string[]): boolean | null
  /** Line texts folded for matching. */
  foldedLines: readonly string[]
  /** Raw line texts, in reading order. */
  lineTexts: readonly string[]
  /** Whether any line contains one of the (already folded) cues. */
  mentions(cues: readonly string[]): boolean
  /** Whether the document text has Hebrew letters. */
  hebrew: boolean
  /** Every line, in reading order (role markers, printed adjustments and ids are read from them). */
  lines: readonly Line[]
  word(id: string): Word | undefined
  /** The line a word is on, or undefined for an unknown word. */
  lineOfWord(wordId: string): Line | undefined
  /** The lines of a block, in reading order. */
  linesOfBlock(blockId: string): Line[]
  block(blockId: string): Block | undefined
  /** Lines of a page, in reading order. */
  pageLines(page: number): readonly Line[]
}

export function indexDocument(doc: DocumentModel): DocIndex {
  const words = new Map<string, Word>()
  for (const w of doc.words) words.set(w.id, w)
  const lineBlock = new Map<string, string>()
  const lineWords = new Map<string, string[]>()
  for (const l of doc.lines) {
    lineBlock.set(l.id, l.blockId)
    lineWords.set(l.id, l.wordIds)
  }
  const lineTexts = doc.lines.map((l) => l.text)
  const foldedLines = lineTexts.map(foldForMatch)
  const hebrew = doc.meta.scripts.includes('hebrew') || lineTexts.some((t) => /[א-ת]/.test(t))
  const lineById = new Map(doc.lines.map((l) => [l.id, l]))
  const blockById = new Map(doc.blocks.map((b) => [b.id, b]))
  const byPage = new Map<number, Line[]>()
  for (const l of doc.lines) {
    const list = byPage.get(l.page)
    if (list) list.push(l)
    else byPage.set(l.page, [l])
  }

  return {
    lines: doc.lines,
    word(id) {
      return words.get(id)
    },
    lineOfWord(id) {
      const w = words.get(id)
      return w ? lineById.get(w.lineId) : undefined
    },
    linesOfBlock(id) {
      const b = blockById.get(id)
      return b ? b.lineIds.map((l) => lineById.get(l)).filter((l): l is Line => !!l) : []
    },
    block(id) {
      return blockById.get(id)
    },
    pageLines(page) {
      return byPage.get(page) ?? []
    },
    minConfidence(ids) {
      let min = 1
      for (const id of ids) {
        const w = words.get(id)
        if (!w) return 0
        if (w.confidence < min) min = w.confidence
      }
      return min
    },
    blocksOf(ids) {
      const out = new Set<string>()
      for (const id of ids) {
        const w = words.get(id)
        const block = w ? lineBlock.get(w.lineId) : undefined
        if (block) out.add(block)
      }
      return out
    },
    coversLines(valueIds, labelIds) {
      if (!valueIds.length) return null
      const inValue = new Set([...valueIds, ...labelIds])
      const touched = new Set<string>()
      for (const id of valueIds) {
        const w = words.get(id)
        if (!w) return null
        touched.add(w.lineId)
      }
      for (const lineId of touched) {
        const ids = lineWords.get(lineId)
        if (!ids) return null
        if (ids.some((id) => !inValue.has(id))) return false
      }
      return true
    },
    foldedLines,
    lineTexts,
    mentions(cues) {
      return foldedLines.some((t) => cues.some((c) => t.includes(c)))
    },
    hebrew,
  }
}

/** Folded cue list, so callers can compare against `foldForMatch` output. */
export function foldCues(cues: readonly string[]): string[] {
  return cues.map(foldForMatch)
}

const HEBREW_PREFIX = 'והשכלבמ'

/**
 * Whether some line contains one of the (already folded) cues as a word: the cue may follow a
 * non-letter, or a Hebrew one-letter prefix (ו/ה/ש/כ/ל/ב/מ) that itself starts a word. Unlike a
 * substring test, "ישולם" (will be paid) does not contain "שולם" (paid).
 */
export function mentionsWord(lines: readonly string[], cues: readonly string[]): boolean {
  return lines.some((t) => cues.some((c) => cueAsWord(t, c)))
}

function cueAsWord(t: string, c: string): boolean {
  const hebrew = /[א-ת]/.test(c)
  for (let i = t.indexOf(c); i >= 0; i = t.indexOf(c, i + 1)) {
    // A Latin cue ends at a word boundary ("paid", not "paidup"); Hebrew words take suffixes
    // (שולמה, שולמו), so only the start of a Hebrew word is checked.
    if (!hebrew && /\p{L}/u.test(t[i + c.length] ?? '')) continue
    const prev = t[i - 1] ?? ''
    if (!/\p{L}/u.test(prev)) return true
    // One Hebrew prefix letter at the start of the word: "ששולם", "והמקדמה".
    if (hebrew && HEBREW_PREFIX.includes(prev) && !/\p{L}/u.test(t[i - 2] ?? '')) return true
  }
  return false
}

/** Whether `text` (any case/script) contains one of the cues, compared folded. */
export function hasCue(text: string | null | undefined, cues: readonly string[]): boolean {
  if (!text) return false
  const t = foldForMatch(text)
  return cues.some((c) => t.includes(foldForMatch(c)))
}
