/**
 * OCR tests — SLOW (tesseract.js, heb+eng, local traineddata): each case takes 1–5 s. They run
 * with the rest of the suite; skip them with `npx vitest run src/read --exclude '**\/ocr.test.ts'`.
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DocumentModel } from '../model/types'
import { foldForMatch } from '../lib/text'
import { readDocument } from './index'
import { fixOcrBrackets, symbolExtent } from './ocr'

const SLOW = 120_000
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))
const texts = (doc: DocumentModel, page?: number) => doc.lines.filter((l) => page === undefined || l.page === page).map((l) => l.text)

/** Share of the expected words found by OCR (multiset match after foldForMatch). */
function wordAccuracy(expected: readonly string[], got: readonly string[]): number {
  const bag = new Map<string, number>()
  for (const w of got) bag.set(foldForMatch(w), (bag.get(foldForMatch(w)) ?? 0) + 1)
  let hit = 0
  for (const w of expected) {
    const k = foldForMatch(w)
    const n = bag.get(k) ?? 0
    if (n > 0) {
      hit++
      bag.set(k, n - 1)
    }
  }
  return hit / expected.length
}

describe('OCR (slow): Hebrew/English image input', () => {
  let doc: DocumentModel
  beforeAll(async () => {
    doc = await readDocument(fixture('ocr-sample.png'), { fileName: 'ocr-sample.png' })
  }, SLOW)

  it('reads lines in logical order with the same line logic as the text layer', () => {
    const t = texts(doc)
    for (const line of ['חשבונית מס 2026-0042', 'אבג מערכות מידע בע"מ ח.פ. 512345678', 'תאריך: 31/10/2026', 'Invoice No: INV-778', 'מע"מ 18%', 'סה"כ לתשלום', '1,180.00'])
      expect(t).toContain(line)
    // Label and far-away value: two lines on one row, the value on the left.
    const label = doc.lines.find((l) => l.text === 'סה"כ לתשלום')!
    const value = doc.lines.find((l) => l.text === '1,180.00')!
    expect(Math.abs((label.bbox.y0 + label.bbox.y1) / 2 - (value.bbox.y0 + value.bbox.y1) / 2)).toBeLessThan(3)
    expect(value.bbox.x1).toBeLessThan(label.bbox.x0)
  })

  it('converts pixels to points and keeps OCR confidences', () => {
    // 2040 × 900 px with no resolution in the file → 300 dpi assumed.
    expect(doc.pages[0]).toMatchObject({ source: 'ocr', width: 489.6, height: 216 })
    expect(doc.meta).toMatchObject({ mimeType: 'image/png', textLayer: 'ocr', pageCount: 1, warnings: ['ocr-page-1'], producer: null })
    expect(doc.meta.scripts).toEqual(['hebrew', 'latin'])
    for (const w of doc.words) {
      expect(w.source).toBe('ocr')
      expect(w.confidence).toBeGreaterThan(0)
      expect(w.confidence).toBeLessThanOrEqual(1)
      expect(w.bbox.x1).toBeLessThanOrEqual(489.6)
    }
    const date = doc.words.find((w) => w.text === '31/10/2026')!
    // 15 CSS px at 3× = 45 px glyph em; at 300 dpi that is ≈10.8 pt.
    expect(date.fontSize).toBeGreaterThan(8)
    expect(date.fontSize).toBeLessThan(14)
  })
})

describe('OCR (slow): full Hebrew invoice page', () => {
  it('reaches ≥ 90% word accuracy against the PDF text layer', async () => {
    const truth = await readDocument(fixture('he-invoice.pdf'))
    const doc = await readDocument(fixture('he-invoice.png'))
    const acc = wordAccuracy(
      truth.words.map((w) => w.text),
      doc.words.map((w) => w.text),
    )
    // Measured 94.9% (78 words; misses: טל' DSC-5 לפני ע"י).
    expect(acc).toBeGreaterThanOrEqual(0.9)
    expect(texts(doc)).toContain('סה"כ לתשלום: 1,180.00 ₪')
    expect(texts(doc)).toContain('מספר חשבונית Invoice No 12345 לפי הזמנה')
  }, SLOW)
})

describe('OCR (slow): photocopy-like scan (skew, dark bands, letter-spaced figures)', () => {
  let doc: DocumentModel
  beforeAll(async () => {
    doc = await readDocument(fixture('ocr-scan.png'))
  }, SLOW)

  it('reads white text on dark bands (table header, totals bar)', () => {
    const t = texts(doc)
    for (const header of ['פריט', 'כמות', 'מחיר', 'סה"כ', 'סה"כ לתשלום']) expect(t).toContain(header)
  })

  it('reads letter-spaced figures whole', () => {
    const words = doc.words.map((w) => w.text)
    for (const figure of ['12.50', '37.50', '1,197.00', '1,234.50', '222.21', '1,456.71']) expect(words).toContain(figure)
  })

  it('straightens a 0.9° skew so the cells of a table row share a row', () => {
    const mid = (text: string) => {
      const l = doc.lines.find((x) => x.text.includes(text))!
      return (l.bbox.y0 + l.bbox.y1) / 2
    }
    // The row spans ~300 pt: unstraightened, its ends would be ~5 pt apart.
    expect(Math.abs(mid('מחברות משרד') - mid('37.50'))).toBeLessThan(2)
  })
})

describe('OCR (slow): PDF pages without a text layer', () => {
  it('rasterizes an image-only PDF page and OCRs it', async () => {
    const doc = await readDocument(fixture('scanned.pdf'))
    expect(doc.meta.textLayer).toBe('ocr')
    expect(doc.meta.warnings).toEqual(['ocr-page-1', 'no-text-layer-page-1'])
    expect(doc.pages[0]).toMatchObject({ source: 'ocr', width: 510, height: 225 })
    expect(texts(doc)).toContain('תאריך: 31/10/2026')
    expect(texts(doc)).toContain('Invoice No: INV-778')
  }, SLOW)

  it("OCRs every page when ocr: 'always', even with a text layer", async () => {
    const doc = await readDocument(fixture('two-pages.pdf'), { ocr: 'always' })
    expect(doc.pages.map((p) => p.source)).toEqual(['ocr', 'ocr'])
    expect(doc.meta.textLayer).toBe('ocr')
    expect(doc.meta.warnings).toEqual(['ocr-page-1', 'ocr-page-2'])
    expect(texts(doc, 2)).toEqual(['עמוד 2 מתוך 2', 'סה"כ לתשלום: 2,360.00 ₪'])
  }, SLOW)
})

describe('OCR (slow): multi-page TIFF', () => {
  it('reads each TIFF page as a page, with the resolution from the file', async () => {
    const doc = await readDocument(fixture('ocr-two-page.tif'))
    expect(doc.meta).toMatchObject({ mimeType: 'image/tiff', pageCount: 2, textLayer: 'ocr' })
    // 2040 px at 288 dpi = 510 pt.
    expect(doc.pages.map((p) => [p.width, p.height])).toEqual([
      [510, 225],
      [510, 150],
    ])
    expect(texts(doc, 2)).toEqual(['עמוד 2 מתוך 2', 'תנאי תשלום: שוטף + 30', 'Total due: 1,180.00 ILS'])
    expect(doc.lines.filter((l) => l.page === 2).map((l) => l.id)).toEqual(['p2l1', 'p2l2', 'p2l3'])
  }, SLOW)
})

describe('symbolExtent', () => {
  it("cuts a symbol box that stretches over the previous word (tesseract's LSTM quirk)", () => {
    // "מתוך": מ is drawn at 1711–1745 but tesseract reports 1711–1952.
    const boxes = [
      { x0: 1711, y0: 0, x1: 1952, y1: 10 },
      { x0: 1681, y0: 0, x1: 1711, y1: 10 },
      { x0: 1651, y0: 0, x1: 1705, y1: 10 },
      { x0: 1614, y0: 0, x1: 1643, y1: 10 },
    ]
    const [x0, x1] = symbolExtent(boxes)!
    expect(x0).toBe(1614)
    // The next word ("2") starts at 1767.
    expect(x1).toBeLessThan(1767)
    expect(symbolExtent([])).toBeNull()
  })
})

describe('fixOcrBrackets', () => {
  it('mirrors brackets tesseract kept as seen in RTL lines, and only then', () => {
    expect(fixOcrBrackets(')077(')).toBe('(077)')
    expect(fixOcrBrackets('(077)')).toBe('(077)')
    expect(fixOcrBrackets(')שעות(')).toBe('(שעות)')
    expect(fixOcrBrackets('5)')).toBe('5)')
    // One bracket on the wrong side of its word.
    expect(fixOcrBrackets('12(')).toBe('12)')
    expect(fixOcrBrackets(')500')).toBe('(500')
    expect(fixOcrBrackets('(מארז')).toBe('(מארז')
    expect(fixOcrBrackets('(')).toBe('(')
  })
})
