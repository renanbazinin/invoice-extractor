import type { Line, Word } from '../../model/types'
import type { DocumentTypeMatch } from '../../semantic'
import { classifyDocumentTypePlus as classifyDocumentType, matchLabelsPlus as matchLabels } from '../../structure/keyValues/lexicon'
import type { FieldsContext } from './context'
import type { Draft } from './draft'
import { wordsOfSpan } from './draft'
import { readIdentifier } from './values'

/**
 * The document title: the line that names the document type and stands out (larger or bold
 * type, near the top, little else on it). A type word inside a sentence ("חשבונית זו הופקה…"),
 * behind a prefix ("משמש גם כחשבונית מס") or after other words ("בגין חשבונית 5344") is not a
 * title. Copy marks (מקור/העתק/Original/Copy) are ignored, never a type.
 */

export interface TitleLine {
  line: Line
  match: DocumentTypeMatch
  /** How much the line looks like the title (0..1). */
  score: number
  /** End offset of the title phrase in the line text (a number may follow). */
  phraseEnd: number
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

const NUMBER_SIGN = /^(?:no\.?|nr\.?|n[°º]\.?|#|num\.?|number|מס['׳"]?|מספר)$/i
const TITLE_CONCEPTS = new Set(['trap.copy_mark', 'invoice_number'])

/** Letter-words of a title line that are not the type, a copy mark or a number sign. */
function extraWords(text: string, covered: { start: number; end: number }[]): { before: number; after: number } {
  let before = 0
  let after = 0
  const first = Math.min(...covered.map((c) => c.start))
  for (const m of text.matchAll(/\S+/g)) {
    const tok = m[0].replace(/[()[\],:/|·]/g, '')
    if (!/\p{L}/u.test(tok)) continue
    if (NUMBER_SIGN.test(tok)) continue
    const s = m.index
    const e = s + m[0].length
    if (covered.some((c) => c.start < e && s < c.end)) continue
    // An identifier with letters ("INV-2026-6431") is a number, not a word.
    if (/\d/.test(tok)) continue
    if (s < first) before++
    else after++
  }
  return { before, after }
}

export function titleLines(fc: FieldsContext): TitleLine[] {
  const { index } = fc
  const out: TitleLine[] = []
  const page = index.doc.pages[0]
  if (!page) return out
  const lines = index.pageLines.get(page.number) ?? []
  const words = lines.flatMap((l) => l.wordIds.map((id) => index.word.get(id)).filter((w): w is Word => !!w))
  const med = median(words.map((w) => w.fontSize)) || 1
  // A label with its value beside or under it is meta data ("חשבונית מס' | 2226"), not the title.
  const labels = new Set(fc.pairs.filter((p) => p.layout === 'grid' || p.layout === 'below').flatMap((p) => p.labelLineIds))
  for (const line of lines) {
    if (fc.itemLineIds.has(line.id) || labels.has(line.id)) continue
    const match = classifyDocumentType(line.text)
    if (!match) continue
    const all = matchLabels(line.text)
    const docMatches = all.filter((m) => m.kind === 'doctype')
    const head = docMatches.find((m) => m.start === match.start)
    // "כחשבונית", "בחשבונית": the type word is part of a sentence.
    if (head && head.prefix && head.prefix !== 'ה') continue
    const covered = all.filter((m) => m.kind === 'doctype' || TITLE_CONCEPTS.has(m.concept))
    const extra = extraWords(line.text, covered)
    if (extra.before + extra.after >= 3 || extra.before >= 2) continue
    const lw = line.wordIds.map((id) => index.word.get(id)).filter((w): w is Word => !!w)
    const size = Math.max(...lw.map((w) => w.fontSize))
    const bold = lw.every((w) => w.bold)
    const ratio = size / med
    let s = 0.3
    if (ratio > 1) s += Math.min(0.35, (ratio - 1) * 0.6)
    if (bold) s += 0.1
    if (line.bbox.y0 < 0.45 * page.height) s += 0.1
    s -= 0.2 * extra.before + 0.12 * extra.after
    if (ratio < 0.95) s -= 0.15
    const invoiceHead = all.find((m) => m.concept === 'invoice_number' && m.start <= match.start && m.end >= match.end)
    out.push({ line, match, score: Math.max(0, Math.min(1, s)), phraseEnd: invoiceHead ? invoiceHead.end : match.end })
  }
  return out.sort((a, b) => b.score - a.score || a.line.bbox.y0 - b.line.bbox.y0)
}

/** Prior of a document_type candidate from its title score. */
function titlePrior(score: number, strong: boolean): number {
  const base = score >= 0.7 ? 0.9 : score >= 0.5 ? 0.78 : score >= 0.35 ? 0.55 : 0.3
  return strong ? base : base - 0.15
}

export function documentTypeDrafts(fc: FieldsContext, titles: readonly TitleLine[]): Draft[] {
  const out: Draft[] = []
  const best = titles[0]
  if (!best) return out
  for (const t of titles.slice(0, 3)) {
    // Runner-up titles only when nearly as prominent; a weaker one would block a clean title.
    if (t !== best && (t.score < best.score - 0.12 || t.match.type === best.match.type)) continue
    const ids = wordsOfSpan(fc.index, t.line.wordIds, t.match.start, t.match.end)
    if (!ids.length) continue
    // An OCR'd bare "חשבונית" may be the rest of "חשבונית מס" / "חשבונית מס/קבלה" with a word
    // lost by the recogniser: the type it names is then only a reading, not a certainty.
    const truncated = ids.some((id) => fc.index.word.get(id)?.source === 'ocr') && /^חשבונית$/.test(t.match.text.trim())
    const strong = t.match.strength === 'strong' && !truncated
    out.push({
      field: 'document_type',
      rawValue: t.match.text,
      normalized: { kind: 'document_type', value: t.match.type },
      valueWordIds: ids,
      labelWordIds: null,
      originalLabel: null,
      score: Math.min(truncated ? 0.7 : 1, titlePrior(t.score, strong) * (t === best ? 1 : 0.8)),
      method: 'header:title',
      signals: ['title', strong ? 'title:strong' : 'title:weak'],
    })
  }
  return out
}

/**
 * "חשבונית מס 940976 (העתק)", "Invoice #2026-117", "Proforma-Rechnung Nr. 2026-3219": the number
 * printed in the title line right after the type is the document's own number.
 */
export function titleNumberDrafts(fc: FieldsContext, titles: readonly TitleLine[]): Draft[] {
  const best = titles[0]
  if (!best || best.score < 0.2) return []
  const own = best.score >= 0.45 ? ownNumber(fc, best) : null
  if (own) return [own]
  const near = nearNumber(fc, best)
  // A faint title (small print, "I N V O I C E" over a large "#2026-117") vouches for a number
  // only when a number sign is printed with it.
  return near && (best.score >= 0.3 || near.score >= 0.7) ? [near] : []
}

/** The number in the title line itself, after the type. */
function ownNumber(fc: FieldsContext, best: TitleLine): Draft | null {
  const rest = best.line.text.slice(best.phraseEnd)
  const id = readIdentifier(rest)
  if (!id) return null
  // Only words between the type and the number would make it something else ("Invoice for order 12").
  const between = rest.slice(0, id.start)
  if (/\p{L}{3,}/u.test(between.replace(/no|nr|num|number|nummer|מס['׳"]?|מספר/giu, ''))) return null
  const start = best.phraseEnd + id.start
  const ids = wordsOfSpan(fc.index, best.line.wordIds, start, start + id.raw.length)
  const labelIds = wordsOfSpan(fc.index, best.line.wordIds, best.match.start, best.phraseEnd)
  if (!ids.length) return null
  return {
    field: 'invoice_number',
    rawValue: id.value,
    normalized: { kind: 'id', value: id.value, scheme: null, checksum: null },
    valueWordIds: ids,
    labelWordIds: labelIds.filter((x) => !ids.includes(x)),
    originalLabel: best.line.text.slice(best.match.start, best.phraseEnd).trim(),
    score: best.score >= 0.6 ? 0.85 : 0.7,
    method: 'header:title-number',
    signals: best.score >= 0.6 ? ['label:strong', 'title'] : ['title'],
  }
}

const SIGN_TOKEN = /^(?:no\.?|nr\.?|n[°º]\.?|#|num\.?|number|nummer|מס['׳"]?|מספר)$/i
const PIECE_SEP = /\s[|·•]\s|\s[|·•]|[|·•]\s/

/**
 * The number printed next to the title on a line of its own: under it ("חשבונית מס / קבלה" over
 * "מס' 40187", "I N V O I C E" over "#2026-117") or beside it on its row, on the reading side
 * ("Tax Invoice (Original) … מס' No. 2026-1183"). The line (or its first piece, "מספר INV-2026-0318
 * · הופקה ב-31.10.2026") must be only a number sign and an identifier. With a number sign it reads
 * as "<title> No. <id>", as strong as the same text on one line; a bare identifier is a guess.
 */
function nearNumber(fc: FieldsContext, t: TitleLine): Draft | null {
  const page = fc.index.pageLines.get(t.line.page) ?? []
  const tb = t.line.bbox
  const h = Math.max(4, tb.y1 - tb.y0)
  const cy = (l: Line) => (l.bbox.y0 + l.bbox.y1) / 2
  const rtl = t.line.dir === 'rtl'
  const options: { line: Line; dist: number }[] = []
  for (const l of page) {
    if (l === t.line || fc.itemLineIds.has(l.id)) continue
    const lh = Math.max(4, l.bbox.y1 - l.bbox.y0)
    if (Math.abs(cy(l) - cy(t.line)) <= 0.5 * Math.max(h, lh)) {
      const gap = rtl ? tb.x0 - l.bbox.x1 : l.bbox.x0 - tb.x1
      if (gap < -2) continue
      // Nothing printed between the title and the number on the row, but the title's translation
      // ("חשבונית מס (מקור)" … "Tax Invoice (Original)" … "מס' No. 2026-1183").
      const between = page.some(
        (o) =>
          o !== l &&
          o !== t.line &&
          Math.abs(cy(o) - cy(t.line)) <= 0.5 * h &&
          (rtl ? o.bbox.x0 >= l.bbox.x1 - 2 && o.bbox.x1 <= tb.x0 + 2 : o.bbox.x0 >= tb.x1 - 2 && o.bbox.x1 <= l.bbox.x0 + 2) &&
          classifyDocumentType(o.text)?.type !== t.match.type,
      )
      if (!between) options.push({ line: l, dist: gap })
      continue
    }
    const below = l.bbox.y0 >= tb.y1 - 0.25 * h && l.bbox.y0 - tb.y1 <= 1.2 * h
    const overlap = Math.min(tb.x1, l.bbox.x1) - Math.max(tb.x0, l.bbox.x0)
    if (below && overlap > 0.5 * Math.min(l.bbox.x1 - l.bbox.x0, tb.x1 - tb.x0)) options.push({ line: l, dist: l.bbox.y0 - tb.y1 })
  }
  options.sort((a, b) => a.dist - b.dist)
  for (const { line } of options) {
    const text = line.text.split(PIECE_SEP)[0]!
    const id = readIdentifier(text)
    if (!id) continue
    const rest = (text.slice(0, id.start) + ' ' + text.slice(id.end)).replace(/\([^)]*\)/g, ' ')
    const tokens = rest.split(/\s+/).filter((w) => w && !/^[#:.\-–]+$/.test(w))
    if (tokens.some((w) => !SIGN_TOKEN.test(w))) continue
    const sign = tokens.length > 0 || /#\s*$/.test(text.slice(0, id.start)) || text.trim().startsWith('#')
    const ids = wordsOfSpan(fc.index, line.wordIds, id.start, id.end)
    if (!ids.length) continue
    const signIds = wordsOfSpan(fc.index, line.wordIds, 0, id.start).filter((x) => !ids.includes(x))
    const labelIds = [...wordsOfSpan(fc.index, t.line.wordIds, t.match.start, t.phraseEnd), ...signIds]
    const strong = sign && t.score >= 0.6
    return {
      field: 'invoice_number',
      rawValue: id.value,
      normalized: { kind: 'id', value: id.value, scheme: null, checksum: null },
      valueWordIds: ids,
      labelWordIds: labelIds,
      originalLabel: [t.line.text.slice(t.match.start, t.phraseEnd).trim(), ...signIds.map((x) => fc.index.word.get(x)?.text ?? '')].join(' ').trim(),
      score: strong ? 0.85 : sign ? 0.72 : 0.5,
      method: 'header:title-number',
      signals: strong ? ['label:strong', 'title'] : ['title'],
    }
  }
  return null
}
