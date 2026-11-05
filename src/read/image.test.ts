import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { imageInfo, splitTiff, tiffIfds } from './image'
import { sniffMimeType } from './sniff'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))

describe('sniffMimeType', () => {
  it('recognizes the supported formats by magic number', () => {
    expect(sniffMimeType(fixture('he-invoice.pdf'))).toBe('application/pdf')
    expect(sniffMimeType(fixture('ocr-sample.png'))).toBe('image/png')
    expect(sniffMimeType(fixture('ocr-two-page.tif'))).toBe('image/tiff')
    const canvas = createCanvas(20, 10)
    expect(sniffMimeType(new Uint8Array(canvas.toBuffer('image/jpeg')))).toBe('image/jpeg')
    expect(sniffMimeType(new Uint8Array(canvas.toBuffer('image/webp')))).toBe('image/webp')
    expect(sniffMimeType(new TextEncoder().encode('חשבונית מס 12\nTotal 5'))).toBe('text/plain')
    expect(sniffMimeType(new Uint8Array([0, 1, 2, 3, 0xff, 0xfe]))).toBeNull()
  })
})

describe('imageInfo', () => {
  it('reads dimensions (and resolution when stated) from headers', () => {
    expect(imageInfo(fixture('ocr-sample.png'), 'image/png')).toEqual({ width: 2040, height: 900, dpi: null })
    const canvas = createCanvas(321, 123)
    expect(imageInfo(new Uint8Array(canvas.toBuffer('image/jpeg')), 'image/jpeg')).toMatchObject({ width: 321, height: 123 })
    expect(imageInfo(new Uint8Array(canvas.toBuffer('image/webp')), 'image/webp')).toMatchObject({ width: 321, height: 123 })
  })

  it('reads a PNG pHYs resolution', () => {
    const png = fixture('ocr-sample.png')
    // Insert a pHYs chunk (11811 px/m = 300 dpi) after IHDR; the CRC is not checked here.
    const phys = new Uint8Array(21)
    const dv = new DataView(phys.buffer)
    dv.setUint32(0, 9)
    phys.set([0x70, 0x48, 0x59, 0x73], 4)
    dv.setUint32(8, 11811)
    dv.setUint32(12, 11811)
    phys[16] = 1
    const withPhys = new Uint8Array([...png.subarray(0, 33), ...phys, ...png.subarray(33)])
    expect(imageInfo(withPhys, 'image/png')?.dpi).toBeCloseTo(300, 0)
  })

  it('splits a multi-page TIFF into single-page TIFFs with their resolution', () => {
    const tif = fixture('ocr-two-page.tif')
    const pages = splitTiff(tif)
    expect(pages).toHaveLength(2)
    expect(pages[0].info).toEqual({ width: 2040, height: 900, dpi: 288 })
    expect(pages[1].info).toMatchObject({ width: 2040, height: 600 })
    for (const p of pages) expect(tiffIfds(new DataView(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength))).toHaveLength(1)
  })
})
