/**
 * Just enough of the image formats to size an OCR page: pixel dimensions and resolution from the
 * headers (PNG pHYs, JPEG JFIF/EXIF, TIFF tags), and splitting multi-page TIFFs, which tesseract
 * reads one page of. No pixel decoding happens here.
 */
import type { MimeType } from './sniff'

export interface ImageInfo {
  width: number
  height: number
  /** Dots per inch from the file, or null when it does not say (or says something absurd). */
  dpi: number | null
}

/** Resolution assumed when the file does not state one (typical scan). */
export const DEFAULT_DPI = 300

const sane = (dpi: number): number | null => (Number.isFinite(dpi) && dpi >= 50 && dpi <= 2400 ? dpi : null)

export function imageInfo(bytes: Uint8Array, mime: MimeType): ImageInfo | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (mime === 'image/png') return pngInfo(bytes, dv)
    if (mime === 'image/jpeg') return jpegInfo(bytes, dv)
    if (mime === 'image/webp') return webpInfo(bytes, dv)
    if (mime === 'image/tiff') {
      const ifds = tiffIfds(dv)
      return ifds.length ? tiffIfdInfo(dv, ifds[0]) : null
    }
  } catch {
    return null
  }
  return null
}

const ascii = (bytes: Uint8Array, at: number, n: number): string => String.fromCharCode(...bytes.subarray(at, at + n))

function pngInfo(bytes: Uint8Array, dv: DataView): ImageInfo {
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  let dpi: number | null = null
  let p = 8
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p)
    const type = ascii(bytes, p + 4, 4)
    if (type === 'pHYs' && len >= 9 && bytes[p + 16] === 1) dpi = sane(dv.getUint32(p + 8) * 0.0254)
    if (type === 'IDAT' || type === 'IEND') break
    p += 12 + len
  }
  return { width, height, dpi }
}

function jpegInfo(bytes: Uint8Array, dv: DataView): ImageInfo | null {
  let p = 2
  let dpi: number | null = null
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) {
      p++
      continue
    }
    const marker = bytes[p + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      p += marker === 0xff ? 1 : 2
      continue
    }
    const len = dv.getUint16(p + 2)
    const seg = p + 4
    if (marker === 0xe0 && ascii(bytes, seg, 5) === 'JFIF\0' && dpi === null) {
      const units = bytes[seg + 7]
      const xd = dv.getUint16(seg + 8)
      if (units === 1) dpi = sane(xd)
      else if (units === 2) dpi = sane(xd * 2.54)
    } else if (marker === 0xe1 && ascii(bytes, seg, 6) === 'Exif\0\0' && dpi === null) {
      const tiff = new DataView(bytes.buffer, bytes.byteOffset + seg + 6, len - 8)
      const ifds = tiffIfds(tiff)
      if (ifds.length) dpi = tiffIfdInfo(tiff, ifds[0]).dpi
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(seg + 1), width: dv.getUint16(seg + 3), dpi }
    }
    p = seg + len - 2
  }
  return null
}

function webpInfo(bytes: Uint8Array, dv: DataView): ImageInfo | null {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff, dpi: null }
  if (chunk === 'VP8L') {
    const b = dv.getUint32(21, true)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, dpi: null }
  }
  if (chunk === 'VP8X') {
    const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    return { width: w, height: h, dpi: null }
  }
  return null
}

/** Offsets of every IFD (page) of a TIFF. */
export function tiffIfds(dv: DataView): number[] {
  const le = dv.getUint16(0) === 0x4949
  const out: number[] = []
  let off = dv.getUint32(4, le)
  while (off > 0 && off + 2 <= dv.byteLength && out.length < 1000 && !out.includes(off)) {
    out.push(off)
    const n = dv.getUint16(off, le)
    const next = off + 2 + n * 12
    if (next + 4 > dv.byteLength) break
    off = dv.getUint32(next, le)
  }
  return out
}

function tiffIfdInfo(dv: DataView, ifd: number): ImageInfo {
  const le = dv.getUint16(0) === 0x4949
  const n = dv.getUint16(ifd, le)
  let width = 0
  let height = 0
  let xres: number | null = null
  let unit = 2
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12
    const tag = dv.getUint16(e, le)
    const type = dv.getUint16(e + 2, le)
    const value = (): number => (type === 3 ? dv.getUint16(e + 8, le) : dv.getUint32(e + 8, le))
    if (tag === 256) width = value()
    else if (tag === 257) height = value()
    else if (tag === 296) unit = value()
    else if (tag === 282 && type === 5) {
      const at = dv.getUint32(e + 8, le)
      const den = dv.getUint32(at + 4, le)
      xres = den ? dv.getUint32(at, le) / den : null
    }
  }
  const dpi = xres === null || unit === 1 ? null : sane(unit === 3 ? xres * 2.54 : xres)
  return { width, height, dpi }
}

/**
 * One single-page TIFF per page of a multi-page TIFF. Offsets inside a TIFF are absolute, so a
 * page is the same bytes with the header pointing at its IFD and that IFD's "next" link cut.
 */
export function splitTiff(bytes: Uint8Array): { bytes: Uint8Array; info: ImageInfo }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = dv.getUint16(0) === 0x4949
  const ifds = tiffIfds(dv)
  return ifds.map((ifd) => {
    const info = tiffIfdInfo(dv, ifd)
    if (ifds.length === 1) return { bytes, info }
    const copy = bytes.slice()
    const cdv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
    cdv.setUint32(4, ifd, le)
    const n = cdv.getUint16(ifd, le)
    cdv.setUint32(ifd + 2 + n * 12, 0, le)
    return { bytes: copy, info }
  })
}
