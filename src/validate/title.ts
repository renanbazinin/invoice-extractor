import type { DocumentType, Line } from '../model/types'
import { classifyDocumentType, matchLabels } from '../semantic'
import { foldForMatch } from '../lib/text'
import { CUES } from './policy'
import type { DocIndex } from './evidence'

/**
 * Whether a document title is fully explained by the type it was read as. A title is often drawn
 * as several pieces on one row (letter-spaced words, a "/" lost by OCR): "חשבונית" | "חיוב" read as
 * two lines makes the first piece look like a plain invoice, and "חשבונית מס" | "קבלה" like a tax
 * invoice. So the title's row, and the large print around it, must name no incompatible type and
 * hold no word that changes the type (CUES.typeWords: חיוב, זיכוי, טיוטה, draft…). Descriptive
 * words ("חשבון חשמל תקופתי", "חשבונית מס מרכזת"), copy marks, number signs and document numbers
 * ("INV-26-0412") are fine.
 */

/** A generic title printed beside a more specific one refines nothing away. */
const REFINES_INVOICE: ReadonlySet<DocumentType> = new Set(['tax_invoice', 'tax_invoice_receipt', 'credit_note', 'debit_note', 'proforma', 'transaction_account'])

export function compatibleTypes(chosen: DocumentType, other: DocumentType): boolean {
  if (chosen === other) return true
  if (other === 'invoice') return REFINES_INVOICE.has(chosen)
  // "חשבונית מס / קבלה" is both a tax invoice and a receipt.
  if (chosen === 'tax_invoice_receipt') return other === 'tax_invoice' || other === 'receipt'
  return false
}

const NUMBER_SIGN = /(?:מס['׳"]?|מספר|no\.?|nr\.?|n[°º]|num(?:ber)?\.?|#)(?![\p{L}])/giu

/** The letters of a line that no type phrase, copy mark or number sign accounts for, and the types it names. */
export function titleRemainder(text: string): { rest: string; types: DocumentType[] } {
  const chars = [...text]
  const blank = new Array<boolean>(text.length).fill(false)
  const types = new Set<DocumentType>()
  for (const m of matchLabels(text)) {
    const typePhrase = m.kind === 'doctype'
    // "חשבונית מס / קבלה מס'" reads as an invoice-number label that holds the type.
    const numbered = m.concept === 'invoice_number' && classifyDocumentType(m.text) !== null
    if (!typePhrase && !numbered && m.concept !== 'trap.copy_mark') continue
    for (let i = m.start; i < m.end; i++) blank[i] = true
    if (typePhrase) types.add(m.concept.slice('doc.'.length) as DocumentType)
    if (numbered) types.add(classifyDocumentType(m.text)!.type)
  }
  let rest = ''
  let pos = 0
  for (const ch of chars) {
    rest += blank[pos] ? ' ' : ch
    pos += ch.length
  }
  // Document numbers are codes, whatever letters they hold ("INV-26-0412", "RE-2026-17").
  rest = rest
    .split(/\s+/)
    .filter((t) => !/\d/.test(t))
    .join(' ')
    .replace(NUMBER_SIGN, ' ')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
  return { rest, types: [...types] }
}

const TYPE_WORDS = new Set(CUES.typeWords.map(foldForMatch))
const HEBREW_PREFIX = /^[והבלמשכ]{1,2}/

/** The words of a title remainder that change what the title says the document is. */
export function typeChangingWords(rest: string): string[] {
  return foldForMatch(rest)
    .split(/[^\p{L}-]+/u)
    .filter((w) => w && (TYPE_WORDS.has(w) || (/[א-ת]/.test(w) && TYPE_WORDS.has(w.replace(HEBREW_PREFIX, '')))))
}

function fontSize(doc: DocIndex, line: Line): number {
  const sizes = line.wordIds.map((id) => doc.word(id)?.fontSize ?? 0).filter((s) => s > 0).sort((a, b) => a - b)
  return sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0
}

function sameRow(a: Line, b: Line): boolean {
  const overlap = Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0)
  const h = Math.min(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0)
  return h > 0 && overlap / h >= 0.5
}

/**
 * The lines a title is made of: the lines holding its words, the pieces beside it on its row
 * (within 2.5 em: OCR can leave a wide hole where a "/" was), and the large print of its block
 * just above or below it (a title over two lines; on a receipt the title is no larger than the
 * body, so only its neighbourhood counts).
 */
export function titleLines(doc: DocIndex, wordIds: Iterable<string>): { title: Line[]; context: Line[] } {
  const title: Line[] = []
  for (const id of wordIds) {
    const line = doc.lineOfWord(id)
    if (line && !title.includes(line)) title.push(line)
  }
  const context: Line[] = []
  for (const t of title) {
    const em = Math.max(fontSize(doc, t), t.bbox.y1 - t.bbox.y0, 1)
    const beside = doc
      .pageLines(t.page)
      .filter((l) => !title.includes(l) && sameRow(l, t))
      .filter((l) => Math.max(l.bbox.x0 - t.bbox.x1, t.bbox.x0 - l.bbox.x1) <= 2.5 * em)
    const large = doc
      .linesOfBlock(t.blockId)
      .filter((l) => !title.includes(l) && fontSize(doc, l) >= 0.75 * fontSize(doc, t))
      .filter((l) => Math.max(l.bbox.y0 - t.bbox.y1, t.bbox.y0 - l.bbox.y1) <= 1.5 * em)
    for (const l of [...beside, ...large]) if (!context.includes(l)) context.push(l)
  }
  return { title, context }
}

export interface TitleProblem {
  /** Another, incompatible document type is printed in the title. */
  conflict: DocumentType | null
  /** Words of the title that change the type ("חיוב", "טיוטה"). */
  unexplained: string
}

/** Null when the title is explained by `chosen`; otherwise the words that contradict or change it. */
export function titleProblem(doc: DocIndex, chosen: DocumentType, wordIds: Iterable<string>): TitleProblem | null {
  const { title, context } = titleLines(doc, wordIds)
  // The lexicon scan is the costly part: read each line once.
  const seen = new Map<string, ReturnType<typeof titleRemainder>>()
  const remainder = (text: string) => seen.get(text) ?? seen.set(text, titleRemainder(text)).get(text)!
  const rests: string[] = []
  let conflict: DocumentType | null = null
  for (const line of [...title, ...context]) {
    const { rest, types } = remainder(line.text)
    rests.push(...typeChangingWords(rest))
    conflict ??= types.find((t) => !compatibleTypes(chosen, t)) ?? null
  }
  // A short line of the title's block naming another type ("DEBIT NOTE · מקור" under "חשבונית").
  for (const line of title.flatMap((t) => doc.linesOfBlock(t.blockId))) {
    if (conflict || line.wordIds.length > 6) continue
    conflict = remainder(line.text).types.find((t) => !compatibleTypes(chosen, t)) ?? null
  }
  return conflict || rests.length ? { conflict, unexplained: rests.join(' ') } : null
}
