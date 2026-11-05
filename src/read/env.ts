/**
 * What the reader needs from the platform it runs on: pdf.js resources, a canvas to render PDF
 * pages into, image decoding, and the files of the OCR worker. Everything else in the pipeline
 * is plain TypeScript.
 *
 * Node provides it in nodeEnv.ts (the CLI, tests and eval). The browser app provides
 * web/src/env.browser.ts, which its Vite config puts in place of nodeEnv.ts.
 */

/** Decoded pixels, RGBA, with transparency already flattened onto white paper. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface ReaderEnv {
  /** Extra pdf.js getDocument options: where its standard fonts, cmaps and decoders live. */
  pdfOptions(): Record<string, unknown>
  /** A canvas filled white, for rendering a PDF page. */
  createCanvas(width: number, height: number): { canvas: unknown; ctx: CanvasRenderingContext2D }
  /** Pixels of an image the platform can decode (PNG, JPEG, WebP), or null when it cannot. */
  decodeImage(bytes: Uint8Array): Promise<RgbaImage | null>
  /** Decoded pixels encoded as PNG. */
  encodePng(image: RgbaImage): Promise<Uint8Array>
  /** tesseract.js createWorker options: where the language data (and the worker scripts) live. */
  ocrOptions(langs: readonly string[]): Promise<Record<string, unknown>>
}
