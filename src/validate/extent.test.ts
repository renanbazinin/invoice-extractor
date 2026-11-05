import { describe, expect, it } from 'vitest'
import type { BBox, DocumentModel, Line, Word } from '../model/types'
import { indexDocument } from './evidence'
import { continuationBelow } from './extent'

/** A page of single-word-run lines: [text, x0, y0, x1, y1, block]. */
function page(rows: [string, number, number, number, number, string][]): DocumentModel {
  const words: Word[] = []
  const lines: Line[] = []
  for (const [text, x0, y0, x1, y1, block] of rows) {
    const id = `p1l${lines.length + 1}`
    const bbox: BBox = { x0, y0, x1, y1 }
    const wid = `p1w${words.length + 1}`
    words.push({ id: wid, page: 1, text, bbox, dir: 'ltr', source: 'pdf', confidence: 1, fontSize: 9, bold: false, lineId: id })
    lines.push({ id, page: 1, wordIds: [wid], text, bbox, dir: 'ltr', blockId: block })
  }
  const blocks = [...new Set(lines.map((l) => l.blockId))].map((b) => {
    const ls = lines.filter((l) => l.blockId === b)
    return { id: b, page: 1, lineIds: ls.map((l) => l.id), bbox: { x0: Math.min(...ls.map((l) => l.bbox.x0)), y0: Math.min(...ls.map((l) => l.bbox.y0)), x1: Math.max(...ls.map((l) => l.bbox.x1)), y1: Math.max(...ls.map((l) => l.bbox.y1)) } }
  })
  return {
    pages: [{ number: 1, width: 595, height: 842, source: 'pdf', lineIds: lines.map((l) => l.id), blockIds: blocks.map((b) => b.id) }],
    words,
    lines,
    blocks,
    meta: { fileName: null, mimeType: 'application/pdf', pageCount: 1, textLayer: 'embedded', scripts: ['latin'], producer: null, warnings: [] },
  }
}

const word = (doc: DocumentModel, text: string) => doc.words.find((w) => w.text === text)!.id

describe('continuationBelow', () => {
  it('finds a value wrapped onto the next line of a grid value column', () => {
    const doc = page([
      ['Rimon, Adler & Co.', 22, 113, 125, 126, 'name'],
      ['Terms', 372, 108, 398, 118, 'labels'],
      ['Payment within 15 days', 457, 108, 552, 118, 'values'],
      ['of invoice date', 457, 119.6, 517, 129, 'values'],
    ])
    const more = continuationBelow(indexDocument(doc), [word(doc, 'Payment within 15 days')], [word(doc, 'Terms')])
    expect(more?.text).toBe('of invoice date')
  })

  it('does not take the next pair of a grid for a continuation', () => {
    const doc = page([
      ['Terms', 372, 108, 398, 118, 'labels'],
      ['PO', 372, 119.6, 390, 129, 'labels'],
      ['Net 30', 457, 108, 490, 118, 'values'],
      ['ACME-7781', 457, 119.6, 510, 129, 'values'],
    ])
    expect(continuationBelow(indexDocument(doc), [word(doc, 'Net 30')], [word(doc, 'Terms')])).toBeNull()
  })

  it('does not take a stacked value of its own (a date, an amount) for a continuation', () => {
    const doc = page([
      ['Net 30', 457, 108, 490, 118, 'values'],
      ['2026-08-04', 457, 119.6, 510, 129, 'values'],
    ])
    expect(continuationBelow(indexDocument(doc), [word(doc, 'Net 30')])).toBeNull()
  })

  it('ignores the line below a value that stopped short of its column edge (it had room to go on)', () => {
    const doc = page([
      ['Net 30', 457, 108, 490, 118, 'values'],
      ['Late payments bear interest of 1.5% per month', 457, 119.6, 640, 129, 'values'],
    ])
    expect(continuationBelow(indexDocument(doc), [word(doc, 'Net 30')])).toBeNull()
  })

  it('ignores a line after a paragraph gap or out of alignment', () => {
    const gap = page([
      ['Net 30', 457, 108, 490, 118, 'values'],
      ['Thank you', 457, 140, 500, 150, 'values'],
    ])
    expect(continuationBelow(indexDocument(gap), [word(gap, 'Net 30')])).toBeNull()
    const shifted = page([
      ['Net 30', 457, 108, 490, 118, 'values'],
      ['of invoice date', 470, 119.6, 520, 129, 'values'],
    ])
    expect(continuationBelow(indexDocument(shifted), [word(shifted, 'Net 30')])).toBeNull()
  })
})
