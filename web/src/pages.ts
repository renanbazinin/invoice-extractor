/**
 * Page pictures for the viewer, in the same geometry the reader used: PDF pages at the rotation
 * the reader chose (uprightRotation), images in their stored pixel grid (EXIF ignored). Word
 * boxes are in page points, so an overlay with viewBox = page size lines up at any zoom.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { DocumentModel } from '../../src/model/types'
import { uprightRotation } from '../../src/read/pdf'
import type { TextItemLike } from '../../src/read/items'
import { decodeBitmap, env, whiteCanvas } from './env.browser'

export type PagePicture = { kind: 'canvas'; canvas: HTMLCanvasElement } | { kind: 'none'; reason: string }

/** Pixel width pages are drawn at (sharp on high-density screens, cheap enough for a few pages). */
const TARGET_WIDTH = 1600
const MAX_PAGES = 30

export async function renderPages(
  bytes: Uint8Array,
  doc: DocumentModel,
  password: string | undefined,
  onPage: (index: number, picture: PagePicture) => void,
  cancelled: () => boolean,
): Promise<void> {
  const mime = doc.meta.mimeType
  if (mime === 'text/plain') {
    doc.pages.forEach((_, i) => onPage(i, { kind: 'none', reason: 'text' }))
    return
  }
  if (mime !== 'application/pdf') {
    const bmp = await decodeBitmap(bytes)
    if (!bmp) {
      doc.pages.forEach((_, i) => onPage(i, { kind: 'none', reason: 'This browser cannot display this image format; the words are drawn from the extracted text.' }))
      return
    }
    const scale = Math.min(1, TARGET_WIDTH / bmp.width)
    const { canvas, ctx } = whiteCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale))
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    onPage(0, { kind: 'canvas', canvas })
    for (let i = 1; i < doc.pages.length; i++) onPage(i, { kind: 'none', reason: 'Only the first frame of a multi-page image can be displayed.' })
    return
  }
  const task = pdfjs.getDocument({ data: bytes.slice(), password, verbosity: 0, fontExtraProperties: true, useSystemFonts: false, ...env.pdfOptions() })
  try {
    const pdf = await task.promise
    for (let i = 0; i < Math.min(doc.pages.length, MAX_PAGES); i++) {
      if (cancelled()) return
      const page = await pdf.getPage(doc.pages[i].number)
      const tc = await page.getTextContent()
      const items = tc.items.filter((it) => 'str' in it) as unknown as TextItemLike[]
      const rotation = uprightRotation(page, items)
      const base = page.getViewport({ scale: 1, rotation })
      const viewport = page.getViewport({ scale: TARGET_WIDTH / base.width, rotation })
      const { canvas, ctx } = whiteCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      page.cleanup()
      onPage(i, { kind: 'canvas', canvas })
    }
  } finally {
    await task.destroy()
  }
}
