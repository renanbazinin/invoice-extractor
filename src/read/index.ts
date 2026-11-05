/**
 * Layer 1: bytes → DocumentModel (words, lines, blocks, pages) in logical reading order.
 *
 *   PDF   text layer via pdf.js; pages without a usable one are rasterized and OCR'd
 *   image OCR (PNG, JPEG, TIFF incl. multi-page, WebP)
 *   text  plain UTF-8 text, laid out on a synthetic monospace page
 *
 * Text layer and OCR end in the same layout code (lines.ts → blocks.ts → order.ts), so both
 * produce the same kind of lines.
 */
import type { Direction, DocumentModel, TextSource, Word } from '../model/types'
import type { PageInput, RawLine } from './model'
import { sniffMimeType } from './sniff'
import { ReadError } from './errors'
import { openPdf, pdfInfo, rasterizePage, readPdfPage } from './pdf'
import { OcrEngine, ocrUnits } from './ocr'
import { ocrPage } from './ocrpage'
import { toGray, type Gray } from './preprocess'
import { DEFAULT_DPI, imageInfo, splitTiff, type ImageInfo } from './image'
import { layoutPage, letterDirection, type PageLayout } from './layout'
import { plainTextPages } from './plaintext'
import { scriptOf } from './chars'
import { env } from './nodeEnv'

export { ReadError } from './errors'
export { sniffMimeType } from './sniff'

export interface ReadOptions {
  fileName?: string
  /** Sniffed from the bytes when omitted. */
  mimeType?: DocumentModel['meta']['mimeType']
  /** 'auto' (default): OCR only pages without a usable text layer. */
  ocr?: 'auto' | 'always' | 'never'
  /** Tesseract language codes, default ['heb', 'eng']. */
  ocrLanguages?: string[]
  password?: string
}

interface Collected {
  input: PageInput
  /** Pre-grouped blocks (plain text). */
  blocks?: RawLine[][]
}

/** Layer 1: bytes → words, lines and blocks with positions, in logical reading order. */
export async function readDocument(bytes: Uint8Array, opts: ReadOptions = {}): Promise<DocumentModel> {
  const mimeType = opts.mimeType ?? sniffMimeType(bytes)
  if (!mimeType) throw new ReadError('unsupported', 'Unrecognized input: expected a PDF, PNG, JPEG, TIFF or WebP file, or UTF-8 text.')
  const mode = opts.ocr ?? 'auto'
  const ocr = new OcrEngine(opts.ocrLanguages ?? ['heb', 'eng'])
  const warnings: string[] = []
  let producer: string | null = null
  let collected: Collected[]
  try {
    if (mimeType === 'application/pdf') {
      const r = await collectPdf(bytes, opts.password, mode, ocr, warnings)
      collected = r.pages
      producer = r.producer
    } else if (mimeType === 'text/plain') {
      collected = plainTextPages(new TextDecoder('utf-8').decode(bytes)).map((p, i) => ({
        input: { number: i + 1, width: p.width, height: p.height, source: 'pdf' as TextSource, units: [], rules: [] },
        blocks: p.blocks,
      }))
    } else {
      collected = await collectImage(bytes, mimeType, mode, ocr, warnings)
    }
  } finally {
    await ocr.terminate()
  }

  // Pages without letters (a page of numbers) take the document's direction.
  const allUnits = collected.flatMap((c) => c.blocks?.flat().flatMap((l) => l.units) ?? c.input.units)
  const docDir: Direction = letterDirection(allUnits) ?? 'ltr'
  const layouts: PageLayout[] = collected.map((c) => layoutPage(c.input, { fallbackDir: docDir, blocks: c.blocks }))

  const words = layouts.flatMap((l) => l.words)
  if (!words.length) warnings.push('no-text')
  const sources = new Set(layouts.map((l) => l.page.source))
  return {
    pages: layouts.map((l) => l.page),
    words,
    lines: layouts.flatMap((l) => l.lines),
    blocks: layouts.flatMap((l) => l.blocks),
    meta: {
      fileName: opts.fileName ?? null,
      mimeType,
      pageCount: layouts.length,
      textLayer: sources.size === 2 ? 'mixed' : sources.has('ocr') ? 'ocr' : 'embedded',
      scripts: scripts(words),
      producer,
      warnings,
    },
  }
}

async function collectPdf(
  bytes: Uint8Array,
  password: string | undefined,
  mode: NonNullable<ReadOptions['ocr']>,
  ocr: OcrEngine,
  warnings: string[],
): Promise<{ pages: Collected[]; producer: string | null }> {
  const pdf = await openPdf(bytes, password)
  try {
    const { producer } = await pdfInfo(pdf)
    const pages: Collected[] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const pt = await readPdfPage(pdf, n)
      warnings.push(...pt.warnings)
      let input = pt.input
      if (mode === 'always' || (mode === 'auto' && pt.unusable)) {
        const r = await rasterizePage(pt.page, pt.rotation)
        const { words } = await ocrPage(ocr, { gray: r.gray, bytes: null, dpi: r.scale * 72 })
        input = { number: n, width: r.width, height: r.height, source: 'ocr', units: ocrUnits(words, r.scale), rules: pt.input.rules }
        warnings.push(`ocr-page-${n}`)
        if (pt.unusable) warnings.push(`${pt.unusable}-page-${n}`)
        if (!words.length) warnings.push(`no-text-page-${n}`)
      } else if (pt.unusable) {
        warnings.push(`${pt.unusable}-page-${n}`)
        input = { ...input, units: [] }
      }
      pages.push({ input })
      pt.page.cleanup()
    }
    return { pages, producer }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

async function collectImage(
  bytes: Uint8Array,
  mime: DocumentModel['meta']['mimeType'],
  mode: NonNullable<ReadOptions['ocr']>,
  ocr: OcrEngine,
  warnings: string[],
): Promise<Collected[]> {
  const frames = mime === 'image/tiff' ? splitTiff(bytes) : [{ bytes, info: imageInfo(bytes, mime) }]
  const pages: Collected[] = []
  for (const [i, frame] of frames.entries()) {
    const n = i + 1
    let image = frame.bytes
    let info: ImageInfo | null = frame.info
    if (!info || !info.width || !info.height) {
      const decoded = await decodeToPng(image)
      image = decoded.png
      info = { width: decoded.width, height: decoded.height, dpi: info?.dpi ?? null }
    }
    const dpi = info.dpi ?? DEFAULT_DPI
    const scale = dpi / 72
    const input: PageInput = { number: n, width: info.width / scale, height: info.height / scale, source: 'ocr', units: [], rules: [] }
    if (mode === 'never') {
      warnings.push(`no-text-page-${n}`)
      pages.push({ input })
      continue
    }
    // Decoded pixels allow the clean-up passes (ocrpage.ts); formats the canvas cannot decode
    // (TIFF) go to tesseract as they are.
    const gray = await decodeToGray(image)
    let words
    try {
      words = (await ocrPage(ocr, { gray, bytes: gray ? null : image, dpi })).words
    } catch (err) {
      if (gray) throw err
      // A format variant tesseract cannot read (e.g. some TIFF compressions): decode, retry as PNG.
      words = (await ocrPage(ocr, { gray: null, bytes: (await decodeToPng(image)).png, dpi })).words
    }
    warnings.push(`ocr-page-${n}`)
    if (!words.length) warnings.push(`no-text-page-${n}`)
    pages.push({ input: { ...input, units: ocrUnits(words, scale) } })
  }
  return pages
}

/** Grayscale pixels of an image the platform can decode (PNG, JPEG, WebP), else null. */
async function decodeToGray(image: Uint8Array): Promise<Gray | null> {
  const img = await env.decodeImage(image)
  return img && toGray(img.data, img.width, img.height)
}

/** Decodes an image and re-encodes it as PNG (dimension fallback, odd formats). */
async function decodeToPng(image: Uint8Array): Promise<{ png: Uint8Array; width: number; height: number }> {
  const img = await env.decodeImage(image)
  if (!img) throw new ReadError('invalid-input', 'Cannot decode the image.')
  return { png: await env.encodePng(img), width: img.width, height: img.height }
}

/** Scripts by share of letters, most frequent first; scripts under 1% of the letters are noise. */
export function scripts(words: readonly Pick<Word, 'text'>[]): string[] {
  const counts = new Map<string, number>()
  let total = 0
  for (const w of words)
    for (const ch of w.text) {
      const s = scriptOf(ch)
      if (!s) continue
      counts.set(s, (counts.get(s) ?? 0) + 1)
      total++
    }
  return [...counts.entries()]
    .filter(([, c]) => c / total >= 0.01)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s)
}

