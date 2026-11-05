/**
 * The reader's platform in Node (see env.ts): pdf.js resources read from node_modules,
 * @napi-rs/canvas for pixels, and tesseract's language data from the local
 * @tesseract.js-data/<lang> packages (never the network).
 */
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import type { ReaderEnv, RgbaImage } from './env'
import { ReadError } from './errors'

const require = createRequire(import.meta.url)
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'))
// pdf.js in Node reads these with fs; it wants directory paths ending with '/' (also on Windows).
const pdfDir = (name: string) => join(PDFJS_DIR, name).replaceAll(sep, '/') + '/'

/**
 * tesseract.js reads `<langPath>/<lang>.traineddata.gz` and the languages live in separate
 * packages, so the files are copied once into one directory under the OS temp dir.
 */
export function tessdataDir(langs: readonly string[]): string {
  const dir = join(tmpdir(), 'formextractor-tessdata-4.0.0_best_int')
  mkdirSync(dir, { recursive: true })
  for (const lang of langs) {
    let src: string
    try {
      src = join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int', `${lang}.traineddata.gz`)
    } catch {
      throw new ReadError('unsupported', `No local OCR data for language '${lang}' (install @tesseract.js-data/${lang}).`)
    }
    if (!existsSync(src)) throw new ReadError('unsupported', `Missing OCR data file ${src}`)
    const dst = join(dir, `${lang}.traineddata.gz`)
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst)
  }
  return dir
}

function whiteCanvas(width: number, height: number) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  return { canvas, ctx }
}

export const env: ReaderEnv = {
  pdfOptions: () => ({ standardFontDataUrl: pdfDir('standard_fonts'), cMapUrl: pdfDir('cmaps'), cMapPacked: true }),

  createCanvas(width, height) {
    const { canvas, ctx } = whiteCanvas(width, height)
    return { canvas, ctx: ctx as unknown as CanvasRenderingContext2D }
  },

  async decodeImage(bytes) {
    let img
    try {
      img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    } catch {
      return null
    }
    const { ctx } = whiteCanvas(img.width, img.height)
    ctx.drawImage(img, 0, 0)
    return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data }
  },

  async encodePng(image: RgbaImage) {
    const { canvas, ctx } = whiteCanvas(image.width, image.height)
    const data = (ctx as SKRSContext2D).createImageData(image.width, image.height)
    data.data.set(image.data)
    ctx.putImageData(data, 0, 0)
    return new Uint8Array(canvas.toBuffer('image/png'))
  },

  async ocrOptions(langs) {
    return { langPath: tessdataDir(langs), gzip: true, cacheMethod: 'none' }
  },
}
