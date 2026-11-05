import { describe, expect, it } from 'vitest'
import { downscale, encodePgm, estimateSkew, invertDarkRegions, otsu, scale, squeezeGaps, toGray, type Gray } from './preprocess'

const DEG = Math.PI / 180

/** A white page with rows of dark "words" (dashes) whose baselines slope by `angle`. */
function textPage(width: number, height: number, angle: number): Gray {
  const data = new Uint8Array(width * height).fill(245)
  const tan = Math.tan(angle)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = y - x * tan
      // 12 px tall text rows every 30 px, words of 40 px with 15 px gaps.
      const inRow = v > 40 && v < height - 60 && ((v - 40) % 30) < 12
      const inWord = x > 30 && x < width - 30 && (x % 55) < 40
      if (inRow && inWord && (x + y) % 3 !== 0) data[y * width + x] = 20
    }
  return { width, height, data }
}

const at = (g: Gray, x: number, y: number): number => g.data[y * g.width + x]

describe('otsu', () => {
  it('splits a bimodal histogram between its modes', () => {
    const h = new Array(256).fill(0)
    h[30] = 100
    h[220] = 900
    const t = otsu(h)
    expect(t).toBeGreaterThanOrEqual(30)
    expect(t).toBeLessThan(220)
  })
})

describe('estimateSkew', () => {
  it('measures the slope of text rows', () => {
    for (const deg of [0, 0.7, -1.1, 2.5]) {
      const est = estimateSkew(textPage(900, 700, deg * DEG)) / DEG
      expect(Math.abs(est - deg)).toBeLessThan(0.08)
    }
  })

  it('returns 0 for a blank page', () => {
    expect(estimateSkew({ width: 300, height: 200, data: new Uint8Array(300 * 200).fill(255) })).toBe(0)
  })
})

describe('invertDarkRegions', () => {
  /** A page with a dark band holding light "letters", plus ordinary dark text below it. */
  function bandPage(): Gray {
    const width = 1200
    const height = 400
    const data = new Uint8Array(width * height).fill(240)
    for (let y = 100; y < 150; y++)
      for (let x = 100; x < 1100; x++) {
        const letter = y > 112 && y < 138 && x > 150 && x < 1000 && x % 30 < 6
        data[y * width + x] = letter ? 235 : 50
      }
    // Bold black text under the band: thick strokes, but mostly paper around them.
    for (let y = 250; y < 280; y++) for (let x = 100; x < 600; x++) if (x % 24 < 10) data[y * width + x] = 15
    return { width, height, data }
  }

  it('turns white-on-dark text into dark-on-white, edges included', () => {
    const { image, regions } = invertDarkRegions(bandPage())
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ x0: 100, y0: 100, x1: 1100, y1: 150 })
    expect(at(image, 500, 105)).toBeGreaterThan(200) // band background → paper
    expect(at(image, 106, 102)).toBeGreaterThan(200) // its edge too: no dark frame left
    expect(at(image, 152, 125)).toBeLessThan(60) // a light letter → ink
  })

  it('leaves ordinary text and the paper alone', () => {
    const page = bandPage()
    const { image } = invertDarkRegions(page)
    expect(at(image, 102, 260)).toBe(15)
    expect(at(image, 50, 50)).toBe(240)
  })

  it('keeps dark areas that touch the border (a scanner bed) and small cores (bold glyphs)', () => {
    const width = 600
    const height = 300
    const data = new Uint8Array(width * height).fill(240)
    for (let y = 0; y < height; y++) for (let x = 0; x < 40; x++) data[y * width + x] = 60
    for (let y = 100; y < 130; y++) for (let x = 300; x < 340; x++) data[y * width + x] = 10
    const { regions, inverted } = invertDarkRegions({ width, height, data })
    expect(regions).toHaveLength(0)
    expect(inverted).toBe(0)
  })
})

describe('squeezeGaps', () => {
  it('closes up letter-spaced glyphs and maps columns back', () => {
    // Three 4 px glyphs 12 px apart in a 40 px wide, 10 px tall crop.
    const width = 40
    const height = 10
    const data = new Uint8Array(width * height).fill(250)
    for (const x0 of [2, 18, 34]) for (let y = 2; y < 8; y++) for (let x = x0; x < x0 + 4; x++) data[y * width + x] = 20
    const { image, columns } = squeezeGaps({ width, height, data }, 3)
    expect(image.width).toBeLessThan(width)
    expect(image.width).toBe(columns.length)
    // Glyph columns are all kept, blank runs cut to 3.
    expect(columns).toContain(18)
    expect(columns).toContain(37)
    expect(columns.filter((x) => x > 5 && x < 18)).toHaveLength(3)
  })
})

describe('pixel helpers', () => {
  it('converts RGBA to luminance with transparency as paper', () => {
    const g = toGray(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]), 3, 1)
    expect([...g.data]).toEqual([0, 255, 255])
  })

  it('encodes PGM with a P5 header', () => {
    const pgm = encodePgm({ width: 2, height: 1, data: new Uint8Array([7, 9]) })
    expect(new TextDecoder().decode(pgm.subarray(0, 11))).toBe('P5\n2 1\n255\n')
    expect([...pgm.subarray(11)]).toEqual([7, 9])
  })

  it('scales and downscales', () => {
    const g = { width: 4, height: 2, data: new Uint8Array(8).fill(100) }
    expect(scale(g, 1.5)).toMatchObject({ width: 6, height: 3 })
    expect(downscale(g, 2)).toMatchObject({ width: 2, height: 1 })
    expect(scale(g, 1)).toBe(g)
  })
})
