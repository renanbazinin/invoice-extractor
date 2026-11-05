/**
 * Image clean-up before OCR, on 8-bit grayscale pixels in plain arrays (pure functions, so they
 * are testable without a canvas).
 *
 * Tesseract binarizes the page with one global threshold and assumes dark text on a light
 * background with horizontal lines. Scans and photocopies break each assumption:
 *  - a skew of 0.5–1.5° moves the end of a table row by more than a line height, so the reader's
 *    line grouping splits a row and pairs cells of different rows (estimateSkew; the OCR pass
 *    straightens the word boxes);
 *  - white text on a dark header band or a dark totals bar disappears in the global threshold or is
 *    taken for a picture (invertDarkRegions);
 *  - small print at screen-capture resolution (~190 dpi) loses decimal points and thin digits;
 *    tesseract reads best with glyphs of 25–40 px, so crops read a second time are enlarged
 *    (scale), and letter-spaced figures are closed up (squeezeGaps).
 */

/** A rectangle in pixels, x1/y1 exclusive. */
export interface PixelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Gray {
  width: number
  height: number
  /** Row-major luminance, 0 black .. 255 white. */
  data: Uint8Array
}

/** RGBA (canvas ImageData) → luminance; transparent pixels count as white paper. */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const a = rgba[p + 3] / 255
    const y = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
    data[i] = Math.round(y * a + 255 * (1 - a))
  }
  return { width, height, data }
}

/** Binary PGM (P5): leptonica reads it natively, and it costs nothing to encode. */
export function encodePgm(g: Gray): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${g.width} ${g.height}\n255\n`)
  const out = new Uint8Array(header.length + g.data.length)
  out.set(header)
  out.set(g.data, header.length)
  return out
}

/** Otsu's threshold of a luminance histogram: the level that best separates ink from paper. */
export function otsu(hist: ArrayLike<number>): number {
  let total = 0
  let sum = 0
  for (let i = 0; i < 256; i++) {
    total += hist[i]
    sum += i * hist[i]
  }
  let wB = 0
  let sumB = 0
  let best = 0
  let bestVar = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) * (mB - mF)
    if (v > bestVar) {
      bestVar = v
      best = t
    }
  }
  return best
}

function histogram(g: Gray): Uint32Array {
  const h = new Uint32Array(256)
  for (let i = 0; i < g.data.length; i++) h[g.data[i]]++
  return h
}

/** Box-averaged downscale by an integer factor (fast, and averaging keeps thin strokes). */
export function downscale(g: Gray, k: number): Gray {
  if (k <= 1) return g
  const width = Math.floor(g.width / k)
  const height = Math.floor(g.height / k)
  const data = new Uint8Array(width * height)
  const n = k * k
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let dy = 0; dy < k; dy++) {
        const row = (y * k + dy) * g.width + x * k
        for (let dx = 0; dx < k; dx++) s += g.data[row + dx]
      }
      data[y * width + x] = Math.round(s / n)
    }
  return { width, height, data }
}

/**
 * Skew of the text lines in radians (positive: lines descend to the right in image coordinates,
 * y down), by the projection-profile method: shear the ink pixels by each candidate angle and keep
 * the angle whose row histogram is sharpest (text lines separate cleanly from the gaps between
 * them only when the angle is right). Coarse search over ±5°, then a fine one. Works on a
 * downscaled copy; 0 when the page has too little ink to tell.
 */
export function estimateSkew(g: Gray): number {
  const k = Math.max(1, Math.floor(g.width / 900))
  const s = downscale(g, k)
  const t = otsu(histogram(s))
  // Ink pixels; dark regions (bands, pictures) are left out: their edges are as sharp at a wrong
  // angle as at the right one only when they are themselves skewed, and a page has few of them.
  const xs: number[] = []
  const ys: number[] = []
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) if (s.data[y * s.width + x] <= t) {
      xs.push(x)
      ys.push(y)
    }
  if (xs.length < 200) return 0
  const score = (angle: number): number => {
    const tan = Math.tan(angle)
    const off = Math.ceil(Math.abs(tan) * s.width) + 1
    const h = new Float64Array(s.height + 2 * off + 2)
    for (let i = 0; i < xs.length; i++) h[Math.round(ys[i] - xs[i] * tan) + off]++
    let sq = 0
    for (let r = 1; r < h.length; r++) {
      const d = h[r] - h[r - 1]
      sq += d * d
    }
    return sq
  }
  const search = (from: number, to: number, step: number): number => {
    let best = 0
    let bestScore = -1
    for (let a = from; a <= to + 1e-12; a += step) {
      const sc = score(a)
      if (sc > bestScore) {
        bestScore = sc
        best = a
      }
    }
    return best
  }
  const deg = Math.PI / 180
  const coarse = search(-5 * deg, 5 * deg, 0.25 * deg)
  return search(coarse - 0.3 * deg, coarse + 0.3 * deg, 0.02 * deg)
}

/** Bilinear upscale by a real factor ≥ 1. */
export function scale(g: Gray, f: number): Gray {
  if (f <= 1) return g
  const width = Math.round(g.width * f)
  const height = Math.round(g.height * f)
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(g.height - 1.001, (y + 0.5) / f - 0.5)
    for (let x = 0; x < width; x++) {
      const sx = Math.min(g.width - 1.001, (x + 0.5) / f - 0.5)
      data[y * width + x] = sampleClamped(g, Math.max(0, sx), Math.max(0, sy))
    }
  }
  return { width, height, data }
}

function sampleClamped(g: Gray, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(g.width - 1, x0 + 1)
  const y1 = Math.min(g.height - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const d = g.data
  const top = d[y0 * g.width + x0] + (d[y0 * g.width + x1] - d[y0 * g.width + x0]) * fx
  const bot = d[y1 * g.width + x0] + (d[y1 * g.width + x1] - d[y1 * g.width + x0]) * fx
  return Math.round(top + (bot - top) * fy)
}

/** Share of dark pixels in a window above which the window is a dark region's background. */
const DARK_CORE = 0.6
/**
 * Dark pixels connected to a core belong to its region down to this dark share of their window
 * (the region's edges); text and rules touching the region from outside fall below it.
 */
const DARK_EDGE = 0.35

/**
 * Inverts regions whose background is dark (white text on a header band, a totals bar, a dark
 * table header), so the whole page is dark-on-light; tesseract loses such text or takes the band
 * for a picture.
 *
 * A pixel is in the core of such a region when most pixels of a window around it, about one text
 * line tall and three wide (body text is ~1/60 of the page width), are darker than the page
 * threshold: even bold black text covers less than half of its surroundings, white text on a band
 * leaves most of it dark. The window sees paper near the region's edges, so the core stops short
 * of them; the dark pixels connected to the core with a still high dark share are the rest of the
 * region (left as they are, they would make a black frame hugging the inverted text). Regions
 * touching the image border are the scanner bed or the edge of a photocopy, not bands, and are
 * kept, and so are regions too small to hold a line of text (the inside of a large bold glyph).
 * Returns the image, the share of pixels inverted, the regions' boxes, and per pixel the
 * 1-based index of its region (0: none).
 */
export function invertDarkRegions(g: Gray): { image: Gray; inverted: number; regions: PixelBox[]; labels: Int32Array } {
  const { width, height, data } = g
  const n = width * height
  const t = otsu(histogram(g))
  const W = width + 1
  const integral = new Uint32Array(W * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += data[y * width + x] <= t ? 1 : 0
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row
    }
  }
  const hh = Math.max(4, Math.round(width / 120))
  const hw = Math.max(8, Math.round(width / 40))
  // 2: core, 1: dark pixel with a high dark share (an edge candidate), 0: other.
  const cls = new Uint8Array(n)
  let cores = 0
  for (let y = 0; y < height; y++) {
    const ya = Math.max(0, y - hh)
    const yb = Math.min(height, y + hh + 1)
    for (let x = 0; x < width; x++) {
      const xa = Math.max(0, x - hw)
      const xb = Math.min(width, x + hw + 1)
      const dark = integral[yb * W + xb] - integral[ya * W + xb] - integral[yb * W + xa] + integral[ya * W + xa]
      const share = dark / ((yb - ya) * (xb - xa))
      const i = y * width + x
      if (share > DARK_CORE) {
        cls[i] = 2
        cores++
      } else if (share > DARK_EDGE && data[i] <= t) cls[i] = 1
    }
  }
  const out = new Uint8Array(data)
  const labels = new Int32Array(n)
  if (!cores) return { image: { width, height, data: out }, inverted: 0, regions: [], labels }

  // Regions: 4-connected components of core pixels, grown into connected edge candidates.
  const label = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  let inverted = 0
  const regions: PixelBox[] = []
  for (let s = 0; s < n; s++) {
    if (cls[s] !== 2 || label[s] >= 0) continue
    let top = 0
    stack[top++] = s
    label[s] = s
    const members: number[] = []
    let border = false
    let x0 = width
    let x1 = 0
    let y0 = height
    let y1 = 0
    while (top) {
      const i = stack[--top]
      members.push(i)
      const x = i % width
      const y = (i - x) / width
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const visit = (j: number): void => {
        if (label[j] >= 0 || !cls[j]) return
        // Edge candidates only extend a region, they never join two cores through paper.
        label[j] = s
        stack[top++] = j
      }
      if (x > 0) visit(i - 1)
      if (x < width - 1) visit(i + 1)
      if (y > 0) visit(i - width)
      if (y < height - 1) visit(i + width)
    }
    // A band is wider than a few words and at least a line tall; smaller cores are the insides
    // of large bold glyphs or a stamp.
    if (border || x1 - x0 < 4 * hw || y1 - y0 < hh) continue
    // Inverted, the band's background is a light grey with the scan's noise in it, which
    // tesseract's layout analysis takes for a picture: stretch it to paper white.
    const hist = new Uint32Array(256)
    for (const i of members) hist[255 - data[i]]++
    let bg = 0
    for (let acc = 0, half = members.length / 2; bg < 255 && (acc += hist[bg]) < half; bg++);
    const gain = 255 / Math.max(64, bg)
    for (const i of members) out[i] = Math.min(255, Math.round((255 - data[i]) * gain))
    inverted += members.length
    regions.push({ x0, y0, x1: x1 + 1, y1: y1 + 1 })
    for (const i of members) labels[i] = regions.length
  }
  return { image: { width, height, data: out }, inverted: inverted / n, regions, labels }
}

/**
 * Narrows the blank columns of a one-line crop: letter-spaced figures ("1 , 4 5 6 . 7 1" in a
 * monospace font with tracking) become ordinary figures, which the line recognizer reads far
 * better (it splits wide-tracked figures into pieces and drops digits). A blank run longer than
 * `maxGap` is cut to `maxGap`, except a word space (from `wordGap` up), which is cut to
 * `wordGap` so a date and its time stay two words. Returns the image and, per output column,
 * the input column it came from (to map boxes back).
 */
export function squeezeGaps(g: Gray, maxGap: number, wordGap = Infinity): { image: Gray; columns: number[] } {
  const { width, height, data } = g
  const t = otsu(histogram(g))
  const ink = new Array<boolean>(width).fill(false)
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++)
      if (data[y * width + x] <= t && data[y * width + x] < 200) {
        ink[x] = true
        break
      }
  const keep: number[] = []
  let x = 0
  while (x < width) {
    if (ink[x]) {
      keep.push(x++)
      continue
    }
    let e = x
    while (e < width && !ink[e]) e++
    const run = e - x
    const kept = run >= wordGap ? wordGap : Math.min(run, maxGap)
    for (let k = 0; k < kept; k++) keep.push(x + k)
    x = e
  }
  if (keep.length === width) return { image: g, columns: keep }
  const out = new Uint8Array(keep.length * height)
  for (let y = 0; y < height; y++) for (let k = 0; k < keep.length; k++) out[y * keep.length + k] = data[y * width + keep[k]]
  return { image: { width: keep.length, height, data: out }, columns: keep }
}
