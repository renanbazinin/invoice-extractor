/**
 * The reader's platform in the browser (see src/read/env.ts). Vite puts this module in place of
 * src/read/nodeEnv.ts. Every file it points to is served by the app itself (copied into
 * public/vendor by scripts/copy-vendor.mjs), so documents and OCR never touch the network.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { ReaderEnv, RgbaImage } from '../../src/read/env'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** Absolute URL of a vendored file (tesseract's worker resolves paths against a blob: URL). */
export const vendorUrl = (path: string): string => new URL(`vendor/${path}`, new URL(import.meta.env.BASE_URL, location.href)).href

export function whiteCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('This browser cannot create a 2D canvas.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  return { canvas, ctx }
}

/**
 * Decodes with EXIF orientation ignored, like the Node reader: page sizes come from the image
 * header, and OCR boxes must be in the same pixel grid.
 */
export async function decodeBitmap(bytes: Uint8Array): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), { imageOrientation: 'none' })
  } catch {
    return null
  }
}

export const env: ReaderEnv = {
  pdfOptions: () => ({
    standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
    cMapUrl: vendorUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    wasmUrl: vendorUrl('pdfjs/wasm/'),
    iccUrl: vendorUrl('pdfjs/iccs/'),
  }),

  createCanvas: (width, height) => whiteCanvas(width, height),

  async decodeImage(bytes) {
    const bmp = await decodeBitmap(bytes)
    if (!bmp) return null
    try {
      const { ctx } = whiteCanvas(bmp.width, bmp.height)
      ctx.drawImage(bmp, 0, 0)
      return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data }
    } finally {
      bmp.close()
    }
  },

  async encodePng(image: RgbaImage) {
    const { canvas, ctx } = whiteCanvas(image.width, image.height)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Cannot encode the image as PNG.')
    return new Uint8Array(await blob.arrayBuffer())
  },

  async ocrOptions() {
    return {
      workerPath: vendorUrl('tesseract/worker.min.js'),
      corePath: vendorUrl('tesseract/core/'),
      langPath: vendorUrl('tessdata'),
      gzip: true,
      // Language data is cached in IndexedDB after the first OCR run.
      cacheMethod: 'write',
    }
  },
}
