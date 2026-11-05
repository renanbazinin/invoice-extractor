import type { Block, Direction, DocumentModel, Line, Word } from '../../model/types'

/**
 * Test helper: a DocumentModel from a list of lines with positions, the way the reader would
 * hand them over (logical-order text, one line per cell of a wide gap, blocks as given). Words
 * get proportional boxes inside their line: enough geometry for pairing and party regions.
 */
export interface LineSpec {
  text: string
  /** Left and right edge of the line, in points. */
  x0: number
  x1: number
  /** Top of the line. */
  y: number
  /** Glyph height (default 9). */
  size?: number
  dir?: Direction
  bold?: boolean
  /** Lines with the same block key share a block (default: one block per line). */
  block?: string
  page?: number
  confidence?: number
}

export function buildDoc(specs: readonly LineSpec[], opts: { width?: number; height?: number } = {}): DocumentModel {
  const width = opts.width ?? 595
  const height = opts.height ?? 842
  const words: Word[] = []
  const lines: Line[] = []
  const blocks = new Map<string, Block>()
  const pages = new Map<number, { lineIds: string[]; blockIds: string[] }>()
  specs.forEach((s, i) => {
    const page = s.page ?? 1
    const size = s.size ?? 9
    const dir: Direction = s.dir ?? (/[א-ת]/.test(s.text) ? 'rtl' : 'ltr')
    const lineId = `p${page}l${i + 1}`
    const blockKey = s.block ?? `b${i + 1}`
    const blockId = `p${page}${blockKey.startsWith('b') ? '' : 'b'}${blockKey}`
    const toks = s.text.split(' ').filter(Boolean)
    const total = toks.reduce((n, t) => n + t.length, 0) + Math.max(0, toks.length - 1)
    const unit = (s.x1 - s.x0) / Math.max(1, total)
    // Logical order: an RTL line's first word is the right-most one.
    let cursor = 0
    const ids: string[] = []
    for (const t of toks) {
      const a = cursor * unit
      const b = (cursor + t.length) * unit
      const x0 = dir === 'rtl' ? s.x1 - b : s.x0 + a
      const x1 = dir === 'rtl' ? s.x1 - a : s.x0 + b
      const id = `p${page}w${words.length + 1}`
      words.push({
        id,
        page,
        text: t,
        bbox: { x0, y0: s.y, x1, y1: s.y + size },
        dir: /\p{L}/u.test(t) ? (/[א-ת]/.test(t) ? 'rtl' : 'ltr') : null,
        source: s.confidence !== undefined ? 'ocr' : 'pdf',
        confidence: s.confidence ?? 1,
        fontSize: size,
        bold: !!s.bold,
        lineId,
      })
      ids.push(id)
      cursor += t.length + 1
    }
    lines.push({ id: lineId, page, wordIds: ids, text: toks.join(' '), bbox: { x0: s.x0, y0: s.y, x1: s.x1, y1: s.y + size }, dir, blockId })
    const block = blocks.get(blockId)
    if (block) {
      block.lineIds.push(lineId)
      block.bbox = { x0: Math.min(block.bbox.x0, s.x0), y0: Math.min(block.bbox.y0, s.y), x1: Math.max(block.bbox.x1, s.x1), y1: Math.max(block.bbox.y1, s.y + size) }
    } else {
      blocks.set(blockId, { id: blockId, page, lineIds: [lineId], bbox: { x0: s.x0, y0: s.y, x1: s.x1, y1: s.y + size } })
    }
    const p = pages.get(page) ?? { lineIds: [], blockIds: [] }
    p.lineIds.push(lineId)
    if (!p.blockIds.includes(blockId)) p.blockIds.push(blockId)
    pages.set(page, p)
  })
  return {
    pages: [...pages].map(([number, p]) => ({ number, width, height, source: 'pdf', lineIds: p.lineIds, blockIds: p.blockIds })),
    words,
    lines,
    blocks: [...blocks.values()],
    meta: {
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
      pageCount: pages.size,
      textLayer: 'embedded',
      scripts: specs.some((s) => /[א-ת]/.test(s.text)) ? ['hebrew', 'latin'] : ['latin'],
      producer: null,
      warnings: [],
    },
  }
}
