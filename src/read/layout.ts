/**
 * One page's units → the public Page/Word/Line/Block records with ids in reading order.
 *
 * The same code serves the text layer and OCR, so both produce the same kind of lines.
 */
import type { Block, Direction, Line, Page, Word } from '../model/types'
import { union } from '../lib/geometry'
import { cleanText } from '../lib/text'
import type { PageInput, RawLine, Unit } from './model'
import { groupLines, type LineOptions } from './lines'
import { segmentBlocks } from './blocks'
import { directionCue, lineBaseDirection, orderLine, reportedDirection } from './order'
import { repairDateOrder } from './grammar'

export interface PageLayout {
  page: Page
  words: Word[]
  lines: Line[]
  blocks: Block[]
  /** Paragraph direction of the page (see paragraphDirection). */
  dir: Direction
}

/** Majority direction of the letters in some units, or null when there are none. */
export function letterDirection(units: readonly Unit[], decisive = 0.5): Direction | null {
  let r = 0
  let l = 0
  for (const u of units) {
    const n = [...u.text].filter((ch) => /\p{L}/u.test(ch)).length
    if (u.cls === 'R') r += n
    else if (u.cls === 'L') l += n
  }
  if (!r && !l) return null
  if (r >= l && r / (r + l) >= decisive) return 'rtl'
  if (l > r && l / (r + l) >= decisive) return 'ltr'
  return null
}

/**
 * The direction the page's paragraphs were set in. Letter counts alone mislead on bilingual
 * Israeli invoices: they often carry more English than Hebrew yet are laid out right to left.
 * So: no Hebrew → LTR; mostly Hebrew → RTL; otherwise an English line drawn with its trailing
 * punctuation moved to the left (directionCue 'rtl') proves an RTL paragraph, and without such
 * a cue a quarter of Hebrew letters is enough for RTL (Hebrew-first layout is the norm for
 * Israeli documents; an English invoice with a Hebrew name stays far below that). The opposite
 * cue (a Hebrew cell set LTR) says something about that cell only, not about the page.
 */
export function paragraphDirection(lines: readonly RawLine[]): Direction | null {
  const units = lines.flatMap((l) => l.units)
  let r = 0
  let l = 0
  for (const u of units) {
    const n = [...u.text].filter((ch) => /\p{L}/u.test(ch)).length
    if (u.cls === 'R') r += n
    else if (u.cls === 'L') l += n
  }
  if (!r && !l) return null
  if (!r) return 'ltr'
  const share = r / (r + l)
  if (share >= 0.6) return 'rtl'
  if (lines.some((line) => !line.fixedOrder && directionCue(line.units) === 'rtl')) return 'rtl'
  return share >= 0.25 ? 'rtl' : 'ltr'
}

const round = (x: number): number => Math.round(x * 100) / 100

export interface LayoutOptions extends LineOptions {
  /** Direction for a page without letters (the document's). */
  fallbackDir?: Direction
  /** Blocks of lines already grouped and ordered (plain text input); `input.units` is then ignored. */
  blocks?: RawLine[][]
}

export function layoutPage(input: PageInput, opts: LayoutOptions = {}): PageLayout {
  const p = input.number
  const raw = opts.blocks?.flat() ?? groupLines(input.units, input.rules, opts)
  const dir = paragraphDirection(raw) ?? opts.fallbackDir ?? 'ltr'
  const blocks = opts.blocks ?? segmentBlocks(raw, dir, input.rules)

  const words: Word[] = []
  const lines: Line[] = []
  const outBlocks: Block[] = []
  for (const blockLines of blocks) {
    const blockId = `p${p}b${outBlocks.length + 1}`
    // Lines take the page's paragraph direction as context, except a clearly Hebrew block on a
    // left-to-right page (a Hebrew address on an English invoice is usually set RTL). A mixed
    // line never decides its own context: "דוד fine office" is Latin-heavy but set RTL.
    const pure = blockLines.filter((l) => !(l.units.some((u) => u.cls === 'R') && l.units.some((u) => u.cls === 'L')))
    const context = dir === 'ltr' && letterDirection(pure.flatMap((l) => l.units), 0.7) === 'rtl' ? 'rtl' : dir
    const lineIds: string[] = []
    for (const rl of blockLines) {
      const line = buildLine(rl, p, lines.length + 1, blockId, context, words, input.source)
      if (!line) continue
      lines.push(line)
      lineIds.push(line.id)
    }
    if (!lineIds.length) continue
    outBlocks.push({ id: blockId, page: p, lineIds, bbox: roundBox(union(blockLines.map((l) => l.bbox))) })
  }

  const page: Page = {
    number: p,
    width: round(input.width),
    height: round(input.height),
    source: input.source,
    lineIds: lines.map((l) => l.id),
    blockIds: outBlocks.map((b) => b.id),
  }
  return { page, words, lines, blocks: outBlocks, dir }
}

function buildLine(rl: RawLine, p: number, n: number, blockId: string, context: Direction, words: Word[], source: Page['source']): Line | null {
  const base = rl.fixedOrder ? (letterDirection(rl.units) ?? context) : lineBaseDirection(rl.units, context)
  // A right-to-left reading of an LTR cell reverses dates; their grammar tells (grammar.ts).
  const bidiOrder = orderLine(rl.units, base, rl.fixedOrder)
  const ordered = base === 'rtl' && !rl.fixedOrder ? repairDateOrder(bidiOrder) : bidiOrder
  const id = `p${p}l${n}`
  const wordIds: string[] = []
  const texts: string[] = []
  for (const w of ordered) {
    const text = cleanText(w.text)
    if (!text) continue
    const wid = `p${p}w${words.length + 1}`
    const sizes = w.units.map((u) => u.fontSize)
    const boldChars = w.units.reduce((s, u) => s + (u.bold ? u.text.length : 0), 0)
    const allChars = w.units.reduce((s, u) => s + u.text.length, 0)
    words.push({
      id: wid,
      page: p,
      text,
      bbox: roundBox(w.bbox),
      dir: w.dir,
      source,
      confidence: Math.min(...w.units.map((u) => u.confidence)),
      fontSize: round(source === 'ocr' ? rl.fontSize : Math.max(...sizes)),
      bold: boldChars * 2 > allChars,
      lineId: id,
    })
    wordIds.push(wid)
    texts.push(text)
  }
  if (!wordIds.length) return null
  return { id, page: p, wordIds, text: texts.join(' '), bbox: roundBox(rl.bbox), dir: reportedDirection(rl.units, base), blockId }
}

function roundBox(b: { x0: number; y0: number; x1: number; y1: number }) {
  return { x0: round(b.x0), y0: round(b.y0), x1: round(b.x1), y1: round(b.y1) }
}
