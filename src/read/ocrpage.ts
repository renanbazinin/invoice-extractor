/**
 * OCR of one page image: recognition, then repairs of what full-page OCR gets wrong on scans and
 * photocopies.
 *
 *   1. full-page recognition, binarized with a local threshold (PAGE_PARAMS);
 *   2. dark bands (white text on a header band or a totals bar) are read again from an inverted
 *      crop (rereadBands);
 *   3. figures that read short for their box ("0" over "10.00", "33" over "33,676.76") are read
 *      again from a crop of their row, as one line of figures (rereadNumbers);
 *   4. word confidence is lowered where a figure was visibly misread (calibrateConfidence);
 *   5. deskew: the skew is measured from the text (projection profile) and the word boxes are
 *      straightened, so the cells of one table row share a row (straighten);
 *   6. Hebrew abbreviation marks misread as yods are restored (abbrev.ts).
 *
 * The page image itself is left as it is: turning it, or inverting its bands in place, changes
 * tesseract's layout analysis of the whole page and lost more words than it gained in tests.
 */
import type { BBox } from '../model/types'
import { normalizeAbbreviations } from './abbrev'
import type { OcrEngine, OcrWord } from './ocr'
import { encodePgm, estimateSkew, invertDarkRegions, otsu, scale, squeezeGaps, type Gray } from './preprocess'

/** A page to OCR: decoded pixels when the format allows it, else the encoded file (TIFF). */
export interface PageImage {
  gray: Gray | null
  bytes: Uint8Array | null
  dpi: number
}

const DEG = Math.PI / 180
/** Below this the skew moves a row end by less than a third of a line: not worth correcting. */
const MIN_SKEW = 0.1 * DEG

/**
 * Full-page recognition binarizes with Sauvola's local threshold (tesseract's method 2) instead
 * of one global Otsu threshold: photocopies have a grey, uneven background and shaded rows, and
 * a global threshold thins or merges digits there (measured on the corpus and handmade scans:
 * digits read right 74.7% / 77.9% against 73.7% / 65.6% with Otsu).
 */
const PAGE_PARAMS = { thresholding_method: '2' }

export async function ocrPage(engine: OcrEngine, img: PageImage): Promise<{ words: OcrWord[]; skew: number }> {
  if (!img.gray) {
    const words = calibrateConfidence(await engine.recognize(img.bytes!, img.dpi, PAGE_PARAMS))
    const skew = skewFromWords(words)
    const { width, height } = extent(words)
    return { words: abbreviations(splitGlued(straighten(words, skew, width, height))), skew }
  }
  const g = img.gray
  const skew = estimateSkew(g)
  let words = await engine.recognize(encodePgm(g), img.dpi, PAGE_PARAMS)
  // Second readings crop the image the boxes were measured on, so they come before straightening.
  words = await rereadBands(engine, g, words, img.dpi)
  words = await rereadNumbers(engine, g, words, img.dpi)
  words = calibrateConfidence(words)
  return { words: abbreviations(splitGlued(straighten(words, skew, g.width, g.height))), skew }
}

function extent(words: readonly OcrWord[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const w of words) {
    width = Math.max(width, w.bbox.x1)
    height = Math.max(height, w.bbox.y1)
  }
  return { width, height }
}

/**
 * Word boxes moved to where they are on the straightened page: each box keeps its size and its
 * centre is turned by -skew about the page centre. Text lines that were slanted become level, so
 * the reader's same-row test pairs the cells of a row again.
 */
export function straighten(words: readonly OcrWord[], skew: number, width: number, height: number): OcrWord[] {
  if (Math.abs(skew) < MIN_SKEW) return [...words]
  const cx = width / 2
  const cy = height / 2
  const cos = Math.cos(-skew)
  const sin = Math.sin(-skew)
  return words.map((w) => {
    const mx = (w.bbox.x0 + w.bbox.x1) / 2
    const my = (w.bbox.y0 + w.bbox.y1) / 2
    const nx = cx + (mx - cx) * cos - (my - cy) * sin
    const ny = cy + (mx - cx) * sin + (my - cy) * cos
    return { ...w, bbox: { x0: w.bbox.x0 + nx - mx, x1: w.bbox.x1 + nx - mx, y0: w.bbox.y0 + ny - my, y1: w.bbox.y1 + ny - my } }
  })
}

/**
 * Skew from the words themselves when there are no pixels to measure (an encoded TIFF): the
 * median slope between consecutive words of one tesseract line that are far enough apart.
 */
export function skewFromWords(words: readonly OcrWord[]): number {
  const slopes: number[] = []
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1]
    const b = words[i]
    if (a.line === undefined || a.line !== b.line) continue
    const dx = (b.bbox.x0 + b.bbox.x1) / 2 - (a.bbox.x0 + a.bbox.x1) / 2
    const h = Math.max(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0)
    if (Math.abs(dx) < 3 * h) continue
    // Bottoms: descenders aside, words of a line sit on one baseline.
    slopes.push((b.bbox.y1 - a.bbox.y1) / dx)
  }
  if (slopes.length < 5) return 0
  slopes.sort((p, q) => p - q)
  return Math.atan(slopes[Math.floor(slopes.length / 2)])
}

function abbreviations(words: OcrWord[]): OcrWord[] {
  const out = words.map((w) => ({ ...w }))
  let i = 0
  while (i < out.length) {
    let j = i
    while (j + 1 < out.length && out[j + 1].line === out[i].line) j++
    const fixed = normalizeAbbreviations(out.slice(i, j + 1).map((w) => w.text))
    fixed.forEach((t, k) => (out[i + k].text = t))
    i = j + 1
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Second reading of numbers

const LETTER = /[\p{L}]/u
const DIGIT = /\d/u
const CURRENCY = /^[₪$€£]+$/u
/** What a figure on an invoice looks like: an amount, a quantity, a date, a time, a rate, a phone. */
const WELL_FORMED = [
  /^[-+−]?[₪$€£]?[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?[%₪$€£]?[-+−]?$/u,
  /^\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4})$/u,
  /^\d{4}-\d{1,2}-\d{1,2}$/u,
  /^\d{1,2}:\d{2}(?::\d{2})?$/u,
  /^\+?\(?\d+\)?(?:-\d+)+$/u,
  /^[₪$€£%]$/u,
]
export const wellFormedFigure = (t: string): boolean => WELL_FORMED.some((re) => re.test(t))

/** Width of a word's box per character, in units of its height: digits take about 0.5–1.1. */
const widthPerChar = (w: OcrWord): number => (w.bbox.x1 - w.bbox.x0) / (Math.max(1, w.bbox.y1 - w.bbox.y0) * [...w.text].length)
/** A box this much wider than its characters lost some of them (a letter-spaced figure reads ~1). */
const TOO_WIDE = 1.7
/** Wide enough to be worth a second reading (rereadNumbers keeps it only if it is better). */
const SUSPECT_WIDE = 1.4

/** A word with digits that read short for its box, or not as any well-formed figure. */
export function suspiciousFigure(w: OcrWord): boolean {
  if (!DIGIT.test(w.text)) return false
  if (LETTER.test(w.text)) return GLUED_LETTER.test(w.text)
  return widthPerChar(w) > SUSPECT_WIDE || (w.confidence < 0.6 && !wellFormedFigure(w.text))
}

/** Digits with one Hebrew letter glued to an end ("ה50"): in a figure, a misread digit or dash. */
const GLUED_LETTER = /^(?:[א-ת]\d[\d.,/-]*\d|\d[\d.,/-]*\d[א-ת])$/u

/**
 * A word that can be a piece of a figure: digits without letters, or a figure with a glued
 * letter. A lone currency sign or bar beside the figure is not taken in: read together with the
 * digits it turns into more digits ("₪" as "20").
 */
const figurePiece = (w: OcrWord): boolean => DIGIT.test(w.text) && (!LETTER.test(w.text) || GLUED_LETTER.test(w.text))

const midY = (b: BBox): number => (b.y0 + b.y1) / 2

function crop(g: Gray, b: BBox): { image: Gray; x0: number; y0: number } {
  const x0 = Math.max(0, Math.floor(b.x0))
  const y0 = Math.max(0, Math.floor(b.y0))
  const x1 = Math.min(g.width, Math.ceil(b.x1))
  const y1 = Math.min(g.height, Math.ceil(b.y1))
  const w = Math.max(1, x1 - x0)
  const data = new Uint8Array(w * Math.max(1, y1 - y0))
  for (let y = y0; y < y1; y++) data.set(g.data.subarray(y * g.width + x0, y * g.width + x0 + w), (y - y0) * w)
  return { image: { width: w, height: Math.max(1, y1 - y0), data }, x0, y0 }
}

const FIGURE_CHARS = '0123456789.,-/:%₪$€£()+'
/** How far (line heights) a figure crop may reach beyond the words to take in dropped pieces. */
const MAX_REACH = 8

/**
 * Horizontal extent of the ink connected to a box along its row: from the box outwards, columns
 * of the row band are taken while the blank gap stays under a line height (letter spacing is
 * less), without crossing the limits.
 */
function inkExtent(g: Gray, box: BBox, leftLimit: number, rightLimit: number, h: number): [number, number] {
  const y0 = Math.max(0, Math.round(box.y0))
  const y1 = Math.min(g.height, Math.round(box.y1))
  const lo = Math.max(0, Math.floor(leftLimit))
  const hi = Math.min(g.width - 1, Math.ceil(rightLimit))
  if (y1 <= y0 || hi <= lo) return [box.x0, box.x1]
  const hist = new Uint32Array(256)
  for (let y = y0; y < y1; y++) for (let x = lo; x <= hi; x++) hist[g.data[y * g.width + x]]++
  const t = Math.min(otsu(hist), 160)
  const inked = (x: number): boolean => {
    for (let y = y0; y < y1; y++) if (g.data[y * g.width + x] <= t) return true
    return false
  }
  const walk = (from: number, step: number, stop: number): number => {
    let last = from
    let blank = 0
    for (let x = from; step < 0 ? x >= stop : x <= stop; x += step) {
      if (inked(x)) {
        last = x
        blank = 0
      } else if (++blank > h) break
    }
    return last
  }
  return [Math.min(box.x0, walk(Math.floor(box.x0), -1, lo)), Math.max(box.x1, walk(Math.ceil(box.x1), 1, hi))]
}

/** Widest blank gap (line heights) left inside a figure crop; a word space in a figure is less. */
const MAX_GAP = 0.35
/** A blank run from this (line heights) up is a word space between two figures (a date and its time). */
const WORD_GAP = 0.9
/** Tesseract reads best with glyphs this tall (px). */
const TARGET_HEIGHT = 32
/** At most this many second readings per page (each costs a few tens of ms). */
const MAX_REREADS = 60

/**
 * Reads suspicious figures again (see suspiciousFigure). The figure is the ink along the seed's
 * row (inkExtent), so pieces the page pass dropped are read too; its crop stops short of any word
 * with letters, has its letter spacing closed up (squeezeGaps), is enlarged to a comfortable glyph
 * height and is read as one line of figure characters. The new words replace the old pieces when
 * every one of them is a well-formed figure of plausible width and they hold more digits (or the
 * old reading was not well-formed); see the acceptance rules in the code. Replacements never
 * keep more than REREAD_CONFIDENCE: they are reconstructions, so a value read from them needs an
 * independent check (arithmetic) to be verified.
 */
export async function rereadNumbers(engine: OcrEngine, g: Gray, words: readonly OcrWord[], dpi: number): Promise<OcrWord[]> {
  const out = [...words]
  const done = new Set<OcrWord>()
  let budget = MAX_REREADS
  for (let k = 0; k < out.length && budget > 0; k++) {
    const seed = out[k]
    if (done.has(seed) || !suspiciousFigure(seed)) continue
    const h = seed.bbox.y1 - seed.bbox.y0
    const onRow = (w: OcrWord): boolean => Math.abs(midY(w.bbox) - midY(seed.bbox)) <= 0.6 * h
    // The figure is the ink around the seed along its row (letter-spaced figures break into pieces
    // the page pass partly dropped, such as the "1,19" of "1,197.00"), up to a wide blank gap or a
    // word with letters, whichever comes first.
    let leftLimit = seed.bbox.x0 - MAX_REACH * h
    let rightLimit = seed.bbox.x1 + MAX_REACH * h
    for (const w of out) {
      if (w === seed || !onRow(w) || figurePiece(w) || !LEGIBLE.test(w.text)) continue
      if (w.bbox.x1 <= seed.bbox.x0) leftLimit = Math.max(leftLimit, w.bbox.x1 + 1)
      if (w.bbox.x0 >= seed.bbox.x1) rightLimit = Math.min(rightLimit, w.bbox.x0 - 1)
    }
    const [inkLeft, inkRight] = inkExtent(g, seed.bbox, leftLimit, rightLimit, h)
    // What the new reading replaces: the words without letters inside the figure.
    const within = (w: OcrWord): boolean => onRow(w) && (w.bbox.x0 + w.bbox.x1) / 2 >= inkLeft && (w.bbox.x0 + w.bbox.x1) / 2 <= inkRight
    const idx = out.map((_, i) => i).filter((i) => out[i] === seed || (within(out[i]) && (figurePiece(out[i]) || !LETTER.test(out[i].text))))
    const cluster = idx.map((i) => out[i])
    cluster.forEach((w) => done.add(w))
    const box: BBox = {
      x0: Math.min(inkLeft, ...cluster.map((w) => w.bbox.x0)),
      x1: Math.max(inkRight, ...cluster.map((w) => w.bbox.x1)),
      y0: Math.min(...cluster.map((w) => w.bbox.y0)),
      y1: Math.max(...cluster.map((w) => w.bbox.y1)),
    }
    const c = crop(g, { x0: Math.max(leftLimit, box.x0 - 0.6 * h), x1: Math.min(rightLimit, box.x1 + 0.6 * h), y0: box.y0 - 0.4 * h, y1: box.y1 + 0.4 * h })
    const f = Math.min(3, Math.max(1, TARGET_HEIGHT / Math.max(1, h)))
    budget--
    // Letter-spaced figures are closed up first (squeezeGaps); boxes map back column by column.
    const squeezed = squeezeGaps(c.image, Math.max(2, Math.round(MAX_GAP * h)), Math.max(4, Math.round(WORD_GAP * h)))
    const image = encodePgm(scale(squeezed.image, f))
    const colX = (x: number): number => c.x0 + (squeezed.columns[Math.max(0, Math.min(squeezed.columns.length - 1, Math.round(x / f)))] ?? 0)
    const place = (ws: OcrWord[]): OcrWord[] =>
      ws.map((w) => ({
        text: w.text,
        // A reconstruction, not a reading the page pass agreed with: never a label-only certainty.
        confidence: Math.min(REREAD_CONFIDENCE, w.confidence),
        line: seed.line,
        bbox: { x0: colX(w.bbox.x0), x1: colX(w.bbox.x1), y0: c.y0 + w.bbox.y0 / f, y1: c.y0 + w.bbox.y1 / f },
      }))
    let placed: OcrWord[] | null = null
    try {
      // Figures only first, accepted outright when tesseract is sure of them. Otherwise a free
      // reading of the same crop decides: it replaces the cluster when it is confident itself,
      // or vouches for the figures-only reading by giving the same digits (tesseract scores some
      // right whitelisted readings near 0, and some wrong ones at 0.6).
      const figures = await engine.recognize(image, dpi * f, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: FIGURE_CHARS })
      if (better(cluster, figures, SURE)) placed = place(figures)
      else if (better(cluster, figures, 0)) {
        budget--
        const free = await engine.recognize(image, dpi * f, { tessedit_pageseg_mode: '7' })
        if (better(cluster, free, 0.5)) placed = place(free)
        else if (digitString(free) === digitString(figures)) placed = place(weak(figures))
        // An amount as invoicing software prints it (grouped thousands, two decimals): garbage
        // seldom comes out that way; kept weak, so only arithmetic can confirm it.
        else if (figures.length === 1 && AMOUNT.test(figures[0].text)) placed = place(weak(figures))
      }
    } catch {
      continue
    }
    if (!placed) continue
    // Keep a currency sign the figure-only reading dropped.
    const keep = placed.some((w) => /[₪$€£]/u.test(w.text)) ? [] : cluster.filter((w) => CURRENCY.test(w.text))
    const replacement = [...placed, ...keep].sort((a, b) => b.bbox.x1 - a.bbox.x1)
    const first = Math.min(...idx)
    const rest = out.filter((_, i) => !idx.includes(i))
    rest.splice(first, 0, ...replacement)
    out.splice(0, out.length, ...rest)
    replacement.forEach((w) => done.add(w))
    k = first + replacement.length - 1
  }
  return out
}

const digits = (ws: readonly OcrWord[]): number => ws.reduce((s, w) => s + (w.text.match(/\d/gu)?.length ?? 0), 0)

/** Confidence at which a figures-only second reading needs no other reading to vouch for it. */
const SURE = 0.8
/** A money amount as invoicing software prints it: grouped thousands and two decimals. */
const AMOUNT = /^-?[₪$€£]?-?\d{1,3}(?:,\d{3})*\.\d{2}$/u
const weak = (ws: readonly OcrWord[]): OcrWord[] => ws.map((w) => ({ ...w, confidence: MISREAD_CONFIDENCE }))

const digitString = (ws: readonly OcrWord[]): string => ws.map((w) => w.text.replace(/\D/gu, '')).join('')

/** Confidence cap of a figure read again (see rereadNumbers). */
export const REREAD_CONFIDENCE = 0.85

/**
 * Whether a second reading replaces the page pass's: every word a well-formed figure of plausible
 * width with at least `minConfidence`, and more digits than before (or as many, when the old
 * reading was not well-formed).
 */
function better(old: readonly OcrWord[], fresh: readonly OcrWord[], minConfidence: number): boolean {
  if (!fresh.length || !fresh.every((w) => wellFormedFigure(w.text))) return false
  if (fresh.some((w) => DIGIT.test(w.text) && widthPerChar(w) > TOO_WIDE)) return false
  if (fresh.some((w) => w.confidence < minConfidence)) return false
  const oldWell = old.every((w) => wellFormedFigure(w.text) && widthPerChar(w) <= TOO_WIDE)
  return digits(fresh) > digits(old) || (!oldWell && digits(fresh) >= digits(old))
}

// ---------------------------------------------------------------------------------------------
// Dark bands

/** At most this many bands per page are read again. */
const MAX_BANDS = 12
/** Line indices of words read from a band crop start here (they are lines of their own). */
const BAND_LINES = 1_000_000

/** How much legible text some words carry: letters and digits weighted by confidence. */
const legibility = (ws: readonly OcrWord[]): number => ws.reduce((s, w) => s + w.confidence * (w.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0)

/**
 * Reads the dark regions of the page (white text on a band) again from an inverted crop, and
 * keeps that reading when it carries more legible text than the full-page pass found there.
 * Inverting the bands in the page image itself changes tesseract's layout analysis of the whole
 * page (whole columns went missing in tests), so the page pass keeps the original pixels and
 * each band is read on its own as a block of text.
 */
export async function rereadBands(engine: OcrEngine, g: Gray, words: readonly OcrWord[], dpi: number): Promise<OcrWord[]> {
  const { image, regions, labels } = invertDarkRegions(g)
  if (!regions.length) return [...words]
  const f = enlargement(words)
  let out = [...words]
  for (const [n, r] of regions.slice(0, MAX_BANDS).entries()) {
    const c = crop(image, { x0: r.x0 - 2, y0: r.y0 - 2, x1: r.x1 + 2, y1: r.y1 + 2 })
    // Only the band: whatever the crop catches around it (the border of the box below) is blanked.
    for (let y = 0; y < c.image.height; y++)
      for (let x = 0; x < c.image.width; x++) if (labels[(c.y0 + y) * g.width + c.x0 + x] !== n + 1) c.image.data[y * c.image.width + x] = 255
    let fresh: OcrWord[]
    try {
      fresh = await engine.recognize(encodePgm(scale(c.image, f)), dpi * f, { tessedit_pageseg_mode: '6' })
    } catch {
      continue
    }
    const placed = fresh
      .filter((w) => w.confidence >= MIN_BAND_CONFIDENCE && LEGIBLE.test(w.text))
      .map((w) => ({
        ...w,
        line: BAND_LINES + n * 1000 + (w.line ?? 0),
        bbox: { x0: c.x0 + w.bbox.x0 / f, x1: c.x0 + w.bbox.x1 / f, y0: c.y0 + w.bbox.y0 / f, y1: c.y0 + w.bbox.y1 / f },
      }))
    const inside = (w: OcrWord): boolean => {
      const x = (w.bbox.x0 + w.bbox.x1) / 2
      const y = midY(w.bbox)
      return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1
    }
    const old = out.filter(inside)
    if (legibility(placed) <= legibility(old)) continue
    out = [...out.filter((w) => !inside(w)), ...placed]
  }
  return out
}

const LEGIBLE = /[\p{L}\p{N}]/u
/** Words of a band below this confidence are mostly specks and band edges read as letters. */
const MIN_BAND_CONFIDENCE = 0.2

/** Scale factor that brings the page's typical word height to TARGET_HEIGHT (1..3). */
function enlargement(words: readonly OcrWord[]): number {
  const hs = words.filter((w) => LEGIBLE.test(w.text)).map((w) => w.bbox.y1 - w.bbox.y0).sort((p, q) => p - q)
  const h = hs[Math.floor(hs.length / 2)] ?? TARGET_HEIGHT
  return Math.min(3, Math.max(1, TARGET_HEIGHT / Math.max(1, h)))
}

// ---------------------------------------------------------------------------------------------
// Confidence

/** Confidence given to a figure that reads wrong for its shape (see misreadFigure). */
export const MISREAD_CONFIDENCE = 0.5
/** Confidence cap of the words beside a misread figure: they may be its pieces. */
export const NEIGHBOUR_CONFIDENCE = 0.7

/**
 * A word that cannot be a figure as printed: digits glued to a Hebrew letter ("ה50" for
 * "50-26795"), a figure that is not well-formed (".12.03", "5,"), or one whose box is far wider
 * than its characters (digits were dropped).
 */
export function misreadFigure(w: OcrWord): boolean {
  if (!DIGIT.test(w.text)) return false
  if (/[א-ת]\d|\d[א-ת]/u.test(w.text)) return true
  if (LETTER.test(w.text)) return false
  return !wellFormedFigure(w.text) || widthPerChar(w) > TOO_WIDE
}

/**
 * Tesseract's word confidence is a statement about each word's shapes, not about whether the
 * figure it belongs to was read whole: when "50-26795" comes out as "ה50 795", the "795" scores
 * 0.90. The reader reports how much a word can be trusted, so a misread figure gets
 * MISREAD_CONFIDENCE and the words near it on its row (closer than two line heights, the gap a
 * dropped piece leaves) at most NEIGHBOUR_CONFIDENCE; a value
 * read from them then needs an independent check rather than its label alone.
 */
export function calibrateConfidence(words: readonly OcrWord[]): OcrWord[] {
  const out = words.map((w) => ({ ...w }))
  const bad = out.filter(misreadFigure)
  for (const b of bad) {
    b.confidence = Math.min(b.confidence, MISREAD_CONFIDENCE)
    const h = b.bbox.y1 - b.bbox.y0
    for (const w of out) {
      if (w === b || Math.abs(midY(w.bbox) - midY(b.bbox)) > 0.5 * h) continue
      const gap = Math.max(w.bbox.x0, b.bbox.x0) - Math.min(w.bbox.x1, b.bbox.x1)
      if (gap < 2 * h) w.confidence = Math.min(w.confidence, NEIGHBOUR_CONFIDENCE)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Words glued to numbers

/**
 * A Hebrew word of two letters or more glued to a number ("יוני2023", "מסי3417"): tesseract lost
 * the space. Hebrew glues only a one-letter prefix to a number ("ב2026"), so longer words are
 * split; in tesseract's logical order the Hebrew comes first and is drawn on the right.
 */
const GLUED_WORD = /^([א-ת][א-ת"'׳״]+)(\d[\d.,/:-]*\d|\d)$/u

export function splitGlued(words: readonly OcrWord[]): OcrWord[] {
  return words.flatMap((w) => {
    const m = GLUED_WORD.exec(w.text)
    if (!m) return [w]
    const [, heb, num] = m
    const n = heb.length + num.length
    // Box shares by character count; the Hebrew part is the right one.
    const cut = w.bbox.x1 - ((w.bbox.x1 - w.bbox.x0) * heb.length) / n
    return [
      { ...w, text: heb, bbox: { ...w.bbox, x0: cut } },
      { ...w, text: num, bbox: { ...w.bbox, x1: cut } },
    ]
  })
}
