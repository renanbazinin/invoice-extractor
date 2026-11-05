/**
 * Builds the reader's binary fixtures from the HTML sources next to this file:
 *
 *   npx tsx src/read/__fixtures__/build.ts [--force]
 *
 *   *.html                    → *.pdf (headless Chrome via eval/render.ts)
 *   he-invoice.pdf            → he-invoice-rot90.pdf    (/Rotate 90, content counter-rotated: displays upright)
 *                             → he-invoice-sideways.pdf (/Rotate 90 only: displays sideways)
 *                             → he-invoice-offset.pdf   (MediaBox/CropBox not at the origin)
 *   he-invoice.html           → he-invoice.png (full-page screenshot at 2×, OCR accuracy fixture)
 *   ocr-sample.html           → ocr-sample.png (scan-like screenshot), scanned.pdf (image-only PDF)
 *   ocr-sample{,-2}.html      → ocr-two-page.tif (8-bit grey, PackBits, two pages)
 *   ocr-scan.html             → ocr-scan.png (photocopy-like: 0.9° skew, blur, noise, JPEG; a dark
 *                               table header and totals bar, letter-spaced monospace amounts)
 *   (generated)               → encrypted.pdf (RC4-40, user password "secret")
 *
 * pdf-lib cannot shape Hebrew (it reverses RTL runs), so every page with text comes from Chrome;
 * pdf-lib only rewraps existing pages.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { concatTransformationMatrix, degrees, PDFDocument, popGraphicsState, pushGraphicsState } from 'pdf-lib'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderPdf, renderPng } from '../../../eval/render'
import { degrade } from '../../../eval/lib/scan'
import { createRng } from '../../../eval/lib/rng'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const DIR = dirname(fileURLToPath(import.meta.url))
const at = (name: string): string => join(DIR, name)
const force = process.argv.includes('--force')
const stale = (out: string, ...inputs: string[]): boolean =>
  force || !existsSync(out) || inputs.some((i) => statSync(i).mtimeMs > statSync(out).mtimeMs)

async function main(): Promise<void> {
  for (const html of readdirSync(DIR).filter((f) => f.endsWith('.html') && !f.startsWith('ocr-'))) {
    const pdf = at(html.replace(/\.html$/, '.pdf'))
    if (stale(pdf, at(html))) await renderPdf(at(html), pdf)
  }
  const he = at('he-invoice.pdf')
  if (stale(at('he-invoice-rot90.pdf'), he)) writeFileSync(at('he-invoice-rot90.pdf'), await rotateUpright(readFileSync(he)))
  if (stale(at('he-invoice-sideways.pdf'), he)) writeFileSync(at('he-invoice-sideways.pdf'), await rotateOnly(readFileSync(he)))
  if (stale(at('he-invoice-offset.pdf'), he)) writeFileSync(at('he-invoice-offset.pdf'), await offsetBoxes(readFileSync(he), 50, 60))

  const png = at('ocr-sample.png')
  if (stale(png, at('ocr-sample.html'))) await renderPng(at('ocr-sample.html'), png, { width: 680, height: 300, scale: 3 })
  if (stale(at('scanned.pdf'), png)) writeFileSync(at('scanned.pdf'), await imagePdf(readFileSync(png), 3 * 96))
  // Full-page Hebrew invoice screenshot at 2× (192 dpi): the OCR word-accuracy fixture.
  if (stale(at('he-invoice.png'), at('he-invoice.html'))) await renderPng(at('he-invoice.html'), at('he-invoice.png'), { scale: 2 })
  const png2 = at('ocr-sample-2.png')
  if (stale(png2, at('ocr-sample-2.html'))) await renderPng(at('ocr-sample-2.html'), png2, { width: 680, height: 200, scale: 3 })
  if (stale(at('ocr-two-page.tif'), png, png2)) writeFileSync(at('ocr-two-page.tif'), await greyTiff([png, png2], 3 * 96))

  if (stale(at('ocr-scan.png'), at('ocr-scan.html'))) writeFileSync(at('ocr-scan.png'), await scanLike(at('ocr-scan.html')))

  if (force || !existsSync(at('encrypted.pdf'))) writeFileSync(at('encrypted.pdf'), encryptedPdf('secret', 'owner-secret'))
  console.log('fixtures up to date')
}

/** A screenshot of `html` at 2× degraded like an office photocopy, with fixed parameters. */
async function scanLike(html: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'fx-scan-'))
  try {
    const clean = join(dir, 'clean.png')
    await renderPng(html, clean, { width: 740, height: 400, scale: 2 })
    const p = { angle: 0.9, blur: 0.5, noise: 5, contrast: 1, brightness: 0, paper: 240, jpegQuality: 70, specks: 40 }
    return (await degrade(readFileSync(clean), createRng('ocr-scan'), p)).png
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Rewraps every page's content with a matrix (pdf-lib has no public "transform content"). */
function wrapContent(doc: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number], m: [number, number, number, number, number, number]): void {
  const p = page as unknown as { node: { normalize(): void; wrapContentStreams(a: unknown, b: unknown): void }; getContentStream(): unknown; createContentStream(...ops: unknown[]): unknown }
  p.node.normalize()
  p.getContentStream()
  const start = doc.context.register(p.createContentStream(pushGraphicsState(), concatTransformationMatrix(...m)) as never)
  const end = doc.context.register(p.createContentStream(popGraphicsState()) as never)
  p.node.wrapContentStreams(start, end)
}

/** Landscape MediaBox + /Rotate 90 + content rotated the other way: shows exactly like the original. */
async function rotateUpright(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  for (const page of doc.getPages()) {
    const { width: w, height: h } = page.getMediaBox()
    // Display of /Rotate 90 is (X, Y) = (y, x) in user space; the original point (u, v) must
    // show at (u, h - v), so user (x, y) = (h - v, u).
    wrapContent(doc, page, [0, 1, -1, 0, h, 0])
    page.setMediaBox(0, 0, h, w)
    page.setCropBox(0, 0, h, w)
    page.setRotation(degrees(90))
  }
  return doc.save()
}

/** /Rotate 90 on upright content: a viewer shows the text running downwards. */
async function rotateOnly(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  for (const page of doc.getPages()) page.setRotation(degrees(90))
  return doc.save()
}

/** Same appearance, but MediaBox and CropBox start at (dx, dy) instead of the origin. */
async function offsetBoxes(bytes: Uint8Array, dx: number, dy: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  for (const page of doc.getPages()) {
    const { width: w, height: h } = page.getMediaBox()
    wrapContent(doc, page, [1, 0, 0, 1, dx, dy])
    page.setMediaBox(dx, dy, w, h)
    page.setCropBox(dx, dy, w, h)
  }
  return doc.save()
}

/** A PDF whose only page is a picture: no text layer at all, like a scanner's output. */
async function imagePdf(png: Uint8Array, dpi: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const img = await doc.embedPng(png)
  const w = (img.width / dpi) * 72
  const h = (img.height / dpi) * 72
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h })
  return doc.save()
}

/** Multi-page 8-bit grey TIFF, PackBits rows, with the resolution tags set. */
async function greyTiff(pngs: string[], dpi: number): Promise<Uint8Array> {
  const pages: { w: number; h: number; data: Buffer }[] = []
  for (const file of pngs) {
    const img = await loadImage(readFileSync(file))
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const rgba = ctx.getImageData(0, 0, img.width, img.height).data
    const rows: Buffer[] = []
    for (let y = 0; y < img.height; y++) {
      const row = Buffer.alloc(img.width)
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4
        row[x] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2])
      }
      rows.push(packBits(row))
    }
    pages.push({ w: img.width, h: img.height, data: Buffer.concat(rows) })
  }
  const parts: Buffer[] = []
  let offset = 8
  const header = Buffer.alloc(8)
  header.write('II', 0)
  header.writeUInt16LE(42, 2)
  parts.push(header)
  const ifdLinks: number[] = []
  for (const p of pages) {
    const dataOff = offset
    parts.push(p.data)
    offset += p.data.length
    if (offset % 2) {
      parts.push(Buffer.alloc(1))
      offset++
    }
    const resOff = offset
    const res = Buffer.alloc(8)
    res.writeUInt32LE(dpi, 0)
    res.writeUInt32LE(1, 4)
    parts.push(res)
    offset += 8
    const tags: [number, number, number][] = [
      [256, 4, p.w],
      [257, 4, p.h],
      [258, 3, 8],
      [259, 3, 32773],
      [262, 3, 1],
      [273, 4, dataOff],
      [277, 3, 1],
      [278, 4, p.h],
      [279, 4, p.data.length],
      [282, 5, resOff],
      [283, 5, resOff],
      [296, 3, 2],
    ]
    const ifd = Buffer.alloc(2 + tags.length * 12 + 4)
    ifd.writeUInt16LE(tags.length, 0)
    tags.forEach(([tag, type, value], k) => {
      const e = 2 + k * 12
      ifd.writeUInt16LE(tag, e)
      ifd.writeUInt16LE(type, e + 2)
      ifd.writeUInt32LE(1, e + 4)
      if (type === 3) ifd.writeUInt16LE(value, e + 8)
      else ifd.writeUInt32LE(value, e + 8)
    })
    ifdLinks.push(offset)
    parts.push(ifd)
    offset += ifd.length
  }
  const out = Buffer.concat(parts)
  out.writeUInt32LE(ifdLinks[0], 4)
  ifdLinks.forEach((ifd, k) => {
    const n = out.readUInt16LE(ifd)
    out.writeUInt32LE(ifdLinks[k + 1] ?? 0, ifd + 2 + n * 12)
  })
  return out
}

function packBits(row: Buffer): Buffer {
  const out: number[] = []
  let i = 0
  while (i < row.length) {
    let run = 1
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++
    if (run > 1) {
      out.push(257 - run, row[i])
      i += run
      continue
    }
    let j = i
    while (j < row.length && j - i < 128 && !(j + 1 < row.length && row[j] === row[j + 1])) j++
    out.push(j - i - 1, ...row.subarray(i, j))
    i = j
  }
  return Buffer.from(out)
}

// --- A minimal RC4-40 (Standard security handler, R2) encrypted PDF -----------------------------

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex')
const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest()
const padded = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32)

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = Buffer.alloc(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

function encryptedPdf(user: string, owner: string): Buffer {
  const id = md5(Buffer.from('formextractor-reader-fixture'))
  const P = -44 // print + copy allowed, nothing else; any value works for the test
  const O = rc4(md5(padded(owner)).subarray(0, 5), padded(user))
  const pBytes = Buffer.alloc(4)
  pBytes.writeInt32LE(P)
  const key = md5(padded(user), O, pBytes, id).subarray(0, 5)
  const U = rc4(key, PAD)
  const objKey = (num: number): Buffer => md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10)

  const content = Buffer.from('BT /F1 14 Tf 72 760 Td (Invoice INV-1 Total 118.00) Tj ET\n', 'latin1')
  const stream = rc4(objKey(5), content)
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`),
  ]
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let pos = parts[0].length
  objects.forEach((body, i) => {
    offsets.push(pos)
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')])
    parts.push(obj)
    pos += obj.length
  })
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n')
  const trailer = `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${pos}\n%%EOF\n`
  parts.push(Buffer.from(xref + trailer, 'latin1'))
  return Buffer.concat(parts)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
