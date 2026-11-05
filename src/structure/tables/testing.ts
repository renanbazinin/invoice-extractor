import type { Block, DocumentModel, Line, Page, Word } from '../../model/types'

/**
 * Test helper: hand-placed lines of text on pages, enough for the table code (words with boxes,
 * lines in logical order, one block per line). A Hebrew line is right-to-left: its first word is
 * the right-most one, as the reader would give it.
 */

export interface LineOpts {
  page?: number
  /** Text height (default 10). */
  h?: number
  /** Width of one character (default 5). */
  cw?: number
  /** Place the line so that it ends at x (right-aligned) instead of starting at x. */
  right?: boolean
  /** OCR confidence (default: embedded text). */
  conf?: number
  /** Width of the space between words (default: one character). */
  gap?: number
  /** Bold words. */
  bold?: boolean
}

const HEBREW = /[֐-׿]/

export class PageBuilder {
  private words: Word[] = []
  private lines: Line[] = []
  private blocks: Block[] = []
  private pages = new Map<number, Page>()
  private readonly width: number
  private readonly height: number

  constructor(width = 595, height = 842) {
    this.width = width
    this.height = height
  }

  private pageOf(n: number): Page {
    let p = this.pages.get(n)
    if (!p) {
      p = { number: n, width: this.width, height: this.height, source: 'pdf', lineIds: [], blockIds: [] }
      this.pages.set(n, p)
    }
    return p
  }

  /** Adds a line at (x, y): its left edge (or right edge with `right`) and top. Returns its id. */
  line(text: string, x: number, y: number, opts: LineOpts = {}): string {
    const page = this.pageOf(opts.page ?? 1)
    const h = opts.h ?? 10
    const cw = opts.cw ?? 5
    const sp = opts.gap ?? cw
    const tokens = text.split(' ').filter(Boolean)
    const total = tokens.reduce((n, t) => n + t.length * cw, 0) + (tokens.length - 1) * sp
    const x0 = opts.right ? x - total : x
    const rtl = HEBREW.test(text)
    const lineId = `p${page.number}l${page.lineIds.length + 1}`
    const blockId = `p${page.number}b${page.blockIds.length + 1}`
    const ids: string[] = []
    let cursor = rtl ? x0 + total : x0
    for (const t of tokens) {
      const w = t.length * cw
      const bx0 = rtl ? cursor - w : cursor
      const id = `p${page.number}w${this.words.filter((x) => x.page === page.number).length + 1}`
      this.words.push({
        id,
        page: page.number,
        text: t,
        bbox: { x0: bx0, y0: y, x1: bx0 + w, y1: y + h },
        dir: HEBREW.test(t) ? 'rtl' : /\p{L}/u.test(t) ? 'ltr' : null,
        source: opts.conf === undefined ? 'pdf' : 'ocr',
        confidence: opts.conf ?? 1,
        fontSize: h,
        bold: opts.bold ?? false,
        lineId,
      })
      ids.push(id)
      cursor = rtl ? bx0 - sp : bx0 + w + sp
    }
    const bbox = { x0, y0: y, x1: x0 + total, y1: y + h }
    this.lines.push({ id: lineId, page: page.number, wordIds: ids, text: tokens.join(' '), bbox, dir: rtl ? 'rtl' : 'ltr', blockId })
    this.blocks.push({ id: blockId, page: page.number, lineIds: [lineId], bbox })
    page.lineIds.push(lineId)
    page.blockIds.push(blockId)
    return lineId
  }

  /** Several cells on one row: [text, x, right?] triples (x is the right edge when right is true). */
  row(y: number, cells: [string, number, boolean?][], opts: LineOpts = {}): string[] {
    return cells.map(([t, x, right]) => this.line(t, x, y, { ...opts, right: right ?? opts.right }))
  }

  build(): DocumentModel {
    const pages = [...this.pages.values()].sort((a, b) => a.number - b.number)
    return {
      pages,
      words: this.words,
      lines: this.lines,
      blocks: this.blocks,
      meta: {
        fileName: null,
        mimeType: 'application/pdf',
        pageCount: pages.length,
        textLayer: 'embedded',
        scripts: ['hebrew', 'latin'],
        producer: null,
        warnings: [],
      },
    }
  }
}
