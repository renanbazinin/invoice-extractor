/**
 * OCR with tesseract.js and local traineddata (never the network; the platform says where the
 * files are, see env.ts). One worker is created lazily per document and reused for all its pages.
 */
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import type { BBox } from '../model/types'
import { cleanText } from '../lib/text'
import type { Unit } from './model'
import { wordClass } from './units'
import { mirrorChar } from './chars'
import { env } from './nodeEnv'

export interface OcrWord {
  text: string
  /** Pixels of the recognized image. */
  bbox: BBox
  /** 0..1. */
  confidence: number
  /** Index of tesseract's text line the word was read in (words of a line are in its reading order). */
  line?: number
}

/**
 * Page segmentation mode 4 ("single column of variable sizes"). Measured on the Hebrew/English
 * fixtures rendered at 2× and 3×: 97.3–97.7% word accuracy and 98.4% on numbers, against
 * 94.5–95.4% for modes 3, 11 and 12, which drop isolated single digits in table cells (a
 * quantity column). The reader regroups words into lines itself, so tesseract's own line
 * structure (wrong for multi-column pages in this mode) does not matter.
 */
const PAGE_SEG_MODE = PSM.SINGLE_COLUMN

export class OcrEngine {
  private worker: Promise<Worker> | null = null
  readonly langs: readonly string[]
  constructor(langs: readonly string[] = ['heb', 'eng']) {
    this.langs = langs
  }

  private get(): Promise<Worker> {
    this.worker ??= (async () => {
      const options = await env.ocrOptions(this.langs)
      const w = await createWorker([...this.langs], OEM.LSTM_ONLY, options)
      // Tesseract's own debug prints ("Detected 28 diacritics") go to stdout otherwise.
      await w.setParameters({ tessedit_pageseg_mode: PAGE_SEG_MODE, debug_file: '/dev/null' })
      return w
    })()
    return this.worker
  }

  /**
   * Words of an encoded image (PNG/JPEG/TIFF/WebP/PGM), boxes in the image's pixels. `params`
   * are tesseract variables for this call only (a page segmentation mode, a character whitelist).
   */
  async recognize(image: Uint8Array, dpi: number, params: Record<string, string> = {}): Promise<OcrWord[]> {
    const w = await this.get()
    await w.setParameters({ user_defined_dpi: String(Math.round(dpi)) })
    // tesseract.js applies variables passed with the call and restores them afterwards. Its types
    // say Buffer, but both its Node and browser loaders take any Uint8Array.
    const input = image as unknown as Parameters<Worker['recognize']>[0]
    const { data } = await w.recognize(input, params as Parameters<Worker['recognize']>[1], { blocks: true, text: false })
    const out: OcrWord[] = []
    let line = 0
    for (const b of data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines) {
          for (const word of l.words) {
            const text = cleanText(word.text.normalize('NFKC'))
            if (!text) continue
            const [x0, x1] = symbolExtent(word.symbols?.map((s) => s.bbox) ?? []) ?? [word.bbox.x0, word.bbox.x1]
            out.push({ text, bbox: { x0, y0: word.bbox.y0, x1, y1: word.bbox.y1 }, confidence: Math.max(0, Math.min(1, word.confidence / 100)), line })
          }
          line++
        }
    return out
  }

  async terminate(): Promise<void> {
    if (!this.worker) return
    const w = await this.worker.catch(() => null)
    this.worker = null
    await w?.terminate()
  }
}

/**
 * Horizontal extent of a word from its symbol boxes. Tesseract's LSTM engine sometimes gives
 * one symbol (often the first letter of a Hebrew word) a box stretching across the previous
 * word, and the word box inherits it, which breaks reading order. A symbol more than 2.5× the
 * median width is cut to the median width on the side of its nearest normal neighbour.
 */
export function symbolExtent(boxes: readonly BBox[]): [number, number] | null {
  if (!boxes.length) return null
  const widths = boxes.map((b) => b.x1 - b.x0).sort((a, b) => a - b)
  const m = widths[Math.floor(widths.length / 2)]
  const fixed = boxes.map((b, i) => {
    if (boxes.length < 3 || b.x1 - b.x0 <= 2.5 * m) return b
    let k = -1
    for (let d = 1; d < boxes.length && k < 0; d++)
      for (const j of [i - d, i + d]) if (j >= 0 && j < boxes.length && boxes[j].x1 - boxes[j].x0 <= 2.5 * m) k = j
    if (k < 0) return b
    const nb = boxes[k]
    if (nb.x1 <= b.x0 + m) return { ...b, x1: b.x0 + m }
    if (nb.x0 >= b.x1 - m) return { ...b, x0: b.x1 - m }
    return b
  })
  return [Math.min(...fixed.map((b) => b.x0)), Math.max(...fixed.map((b) => b.x1))]
}

const BRACKET = /[()[\]{}]/u

/** Whether every bracket of `text` closes one opened before it. */
function balanced(text: string): boolean {
  const stack: string[] = []
  for (const ch of text) {
    if ('([{'.includes(ch)) stack.push(ch)
    else if (')]}'.includes(ch) && stack.pop() !== '([{'[')]}'.indexOf(ch)]) return false
  }
  return stack.length === 0
}

/**
 * Tesseract writes right-to-left lines in logical order but keeps bracket glyphs as seen, so
 * "(077)" in a Hebrew line comes out ")077(". When mirroring the brackets is the only way to
 * balance them, mirror them. A word with one bracket on the wrong side of its text ("12(" of
 * "(מארז 12)", ")500" of "(500 גיליונות)") gets it mirrored too: a word never ends with an
 * opening bracket or starts with a closing one.
 */
export function fixOcrBrackets(text: string): string {
  if (!BRACKET.test(text) || balanced(text)) return text
  const mirrored = [...text].map(mirrorChar).join('')
  if (balanced(mirrored)) return mirrored
  if ((text.match(/[()[\]{}]/gu) ?? []).length !== 1) return text
  if (/^[)\]}][\p{L}\p{N}]/u.test(text) || /[\p{L}\p{N}][([{]$/u.test(text)) return mirrored
  return text
}

/**
 * Specks read as punctuation (":", "==", "'"): words without a letter or digit that are far
 * smaller than the page's text.
 */
function isSpeck(w: OcrWord, medianHeight: number): boolean {
  return !/[\p{L}\p{N}]/u.test(w.text) && w.bbox.y1 - w.bbox.y0 < 0.35 * medianHeight
}

/**
 * OCR words → units in page points (`scale` = pixels per point). Each OCR word is one unit and
 * never glued to its neighbours: tesseract already decided where the spaces are.
 */
export function ocrUnits(words: readonly OcrWord[], scale: number): Unit[] {
  const heights = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 0
  return words.flatMap((w, i) => {
    if (isSpeck(w, medianHeight)) return []
    const bbox = { x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale }
    const text = fixOcrBrackets(w.text)
    const unit: Unit = {
      text,
      bbox,
      baseline: null,
      // Ink height of a word is ~0.7 em (cap/ascender height); the line takes the median later.
      fontSize: (bbox.y1 - bbox.y0) / 0.72,
      bold: false,
      cls: wordClass(text),
      source: 'ocr',
      confidence: w.confidence,
      wordKey: `ocr${i}`,
      run: -1 - i,
      visual: false,
      orient: 0,
      seq: i,
    }
    return [unit]
  })
}
