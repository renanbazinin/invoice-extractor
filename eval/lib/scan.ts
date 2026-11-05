/**
 * Turns a clean screenshot into something that looks scanned: slight skew, blur, sensor noise,
 * uneven contrast, dust specks and JPEG artefacts, in grayscale like most office scanners. The
 * result is written as a PNG (with the JPEG artefacts baked in) and as an image-only PDF that
 * embeds the JPEG, so the reader's OCR path is exercised on both inputs.
 */
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { deflateSync, crc32 } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import type { Rng } from './rng'

export interface ScanParams {
  /** Skew in degrees (signed). */
  angle: number
  /** Gaussian blur radius in px. */
  blur: number
  /** Noise standard deviation in gray levels. */
  noise: number
  /** Contrast multiplier around mid-gray. */
  contrast: number
  /** Brightness offset in gray levels. */
  brightness: number
  /** Paper tone (gray level of the background). */
  paper: number
  jpegQuality: number
  specks: number
}

export function randomScanParams(rng: Rng, scale: number): ScanParams {
  const sign = rng.chance(0.5) ? -1 : 1
  return {
    angle: sign * (0.3 + rng.next() * 0.9),
    blur: (0.3 + rng.next() * 0.5) * (scale / 2),
    noise: 3 + rng.next() * 7,
    contrast: 0.85 + rng.next() * 0.3,
    brightness: -6 + rng.next() * 12,
    paper: 238 + rng.int(0, 14),
    jpegQuality: rng.int(55, 82),
    specks: rng.int(20, 160),
  }
}

/** Index of the last row (from the top) that has any non-white pixel, for trimming receipts. */
function lastInkRow(data: Uint8ClampedArray, width: number, height: number): number {
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = row + x * 4
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return y
    }
  }
  return height - 1
}

/** Minimal PNG encoder for 8-bit grayscale (a third of RGBA's size, and plenty for OCR). */
export function encodeGrayPng(gray: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

export interface ScanResult {
  png: Buffer
  jpeg: Buffer
  width: number
  height: number
}

export async function degrade(input: Buffer, rng: Rng, p: ScanParams, opts: { trim?: boolean } = {}): Promise<ScanResult> {
  let img: Image = await loadImage(input)
  let width = img.width
  let height = img.height
  if (opts.trim) {
    const probe = createCanvas(width, height)
    const pctx = probe.getContext('2d')
    pctx.drawImage(img, 0, 0)
    const last = lastInkRow(pctx.getImageData(0, 0, width, height).data, width, height)
    height = Math.min(height, last + Math.round(width * 0.08))
  }

  // 1. skew + blur onto paper.
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = `rgb(255,255,255)`
  ctx.fillRect(0, 0, width, height)
  ctx.translate(width / 2, height / 2)
  ctx.rotate((p.angle * Math.PI) / 180)
  ctx.translate(-width / 2, -height / 2)
  ctx.filter = `blur(${p.blur.toFixed(2)}px)`
  ctx.drawImage(img, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.filter = 'none'

  // 2. grayscale, paper tone, contrast, noise, specks.
  const data = ctx.getImageData(0, 0, width, height)
  const px = data.data
  const n = width * height
  const gray = new Uint8Array(n)
  const paperScale = p.paper / 255
  // The paper's grey level after the contrast/brightness change (what blank paper scans as).
  const bg = Math.max(0, Math.min(255, (p.paper - 128) * p.contrast + 128 + p.brightness))
  for (let i = 0; i < n; i++) {
    const o = i * 4
    let g = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]
    g = g * paperScale
    g = (g - 128) * p.contrast + 128 + p.brightness
    g += rng.normal() * p.noise
    // Scanner background clean-up: near-paper pixels flatten to the paper tone, so the noise sits
    // on the ink and the grey areas (where it hurts OCR) and the PNG stays a sensible size.
    if (g > bg - 14) g = bg
    gray[i] = g < 0 ? 0 : g > 255 ? 255 : g
  }
  for (let s = 0; s < p.specks; s++) {
    const cx = rng.int(0, width - 1)
    const cy = rng.int(0, height - 1)
    const r = rng.int(0, 2)
    const v = rng.int(40, 140)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && y >= 0 && x < width && y < height) gray[y * width + x] = Math.min(gray[y * width + x], v)
      }
  }
  for (let i = 0; i < n; i++) {
    const o = i * 4
    px[o] = px[o + 1] = px[o + 2] = gray[i]
    px[o + 3] = 255
  }
  ctx.putImageData(data, 0, 0)

  // 3. JPEG round trip, so the PNG carries the same compression artefacts as the PDF.
  const jpeg = Buffer.from(await canvas.encode('jpeg', p.jpegQuality))
  img = await loadImage(jpeg)
  const back = createCanvas(width, height)
  const bctx = back.getContext('2d')
  bctx.drawImage(img, 0, 0)
  const bd = bctx.getImageData(0, 0, width, height).data
  for (let i = 0; i < n; i++) gray[i] = bd[i * 4]
  return { png: encodeGrayPng(gray, width, height), jpeg, width, height }
}

/** An image-only PDF: one page, the JPEG stretched over it (no text layer at all). */
export async function imagePdf(jpeg: Buffer, pageWidthPt: number, pixelWidth: number, pixelHeight: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setProducer('formExtractor corpus scanner')
  pdf.setCreator('formExtractor corpus scanner')
  const img = await pdf.embedJpg(jpeg)
  const h = (pageWidthPt * pixelHeight) / pixelWidth
  const pg = pdf.addPage([pageWidthPt, h])
  pg.drawImage(img, { x: 0, y: 0, width: pageWidthPt, height: h })
  return pdf.save()
}
