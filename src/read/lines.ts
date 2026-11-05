/**
 * Units → lines: pieces of text on one baseline with no wide gap between them.
 *
 * Lines are the connected components of a "next word on the same line" graph: each unit is linked
 * to its nearest neighbour on the right when that neighbour sits on the same baseline, the two
 * pick each other (mutual nearest neighbours), the gap is not wide and no ruling line separates
 * them. Working locally instead of clustering whole-page rows keeps two columns with slightly
 * different baselines apart and follows skewed OCR lines.
 */
import type { BBox } from '../model/types'
import { union } from '../lib/geometry'
import type { RawLine, Rule, Unit } from './model'

/**
 * Gap thresholds (em of the larger font). Measured on the 250-PDF corpus and the fixtures:
 *  - inside one pdf.js run, words are separated by space characters and gaps never exceed
 *    0.4 em (pdf.js folds jumps up to 0.6 em into a space); a run is only split by a wider,
 *    deliberate gap (several spaces or a tab used for alignment): WIDE_GAP_EM;
 *  - between runs, word spacing is 0.2–0.4 em, nothing falls in 0.4–0.5 em, and from 0.6 em up
 *    the gaps are cell boundaries of tight tables ("509204007 | Allocation", "notebook | 4"):
 *    split at 1.6× the page's word spacing (estimated from its own inter-run gaps; 0.28 em in
 *    Arial), at least INTER_RUN_GAP_EM, so a monospace page (0.6 em spaces) is not cut word by
 *    word. (pdf.js whitespace items are no measure: it also emits them for positional jumps);
 *  - OCR boxes are ink boxes with an estimated em, and word gaps reach 0.8 em: OCR_GAP_EM, or
 *    2.2× the page's word spacing when that is wider (letter-spaced print).
 */
export const WIDE_GAP_EM = 1.0
export const INTER_RUN_GAP_EM = 0.45
export const OCR_GAP_EM = 1.0
/**
 * Extra gap (em) allowed between two runs of letter-spaced text ("TOTAL DUE" with 2 px tracking
 * has 0.6 em word spaces): pdf.js cuts such text into a run per word, and tracking of up to
 * ~0.15 em widens each word space by twice that.
 */
export const TRACKED_EXTRA_EM = 0.35
/**
 * Gap (em) that ends a line between two runs of a fixed-pitch font: one space is 0.6 em, so a
 * receipt printed in Courier with each word a run of its own stays one line; two spaces (a
 * column) still split it.
 */
export const MONO_GAP_EM = 0.85

export interface LineOptions {
  /** One gap threshold (em) for every pair, overriding the defaults (experiments, tests). */
  wideGapEm?: number
  /** Word spacing on this page (em); estimated from the page's gaps when absent. */
  spaceEm?: number | null
}

/** The gap (em) between separate runs that ends a line, from the page's space width. */
export function interRunGapEm(spaceEm: number | null | undefined): number {
  if (!spaceEm || !Number.isFinite(spaceEm)) return INTER_RUN_GAP_EM
  return Math.min(WIDE_GAP_EM, Math.max(INTER_RUN_GAP_EM, 1.6 * spaceEm))
}

/** Vertical extent used for row tests. */
const yMid = (b: BBox): number => (b.y0 + b.y1) / 2

/**
 * Whether two units sit on the same text line. Same-size text must share the baseline (small
 * jitter allowed); a smaller unit (superscript, subscript, footnote mark) only has to overlap.
 */
export function sameRow(a: Unit, b: Unit): boolean {
  const ha = a.bbox.y1 - a.bbox.y0
  const hb = b.bbox.y1 - b.bbox.y0
  const ov = Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0)
  const h = Math.min(ha, hb)
  if (h <= 0 || ov / h < 0.5) return false
  const big = Math.max(a.fontSize, b.fontSize)
  const small = Math.min(a.fontSize, b.fontSize)
  if (a.baseline !== null && b.baseline !== null) {
    if (small / big >= 0.9) return Math.abs(a.baseline - b.baseline) <= 0.3 * big
    // A smaller script must be pulled toward the bigger text's line, not sit between two lines.
    return Math.abs(a.baseline - b.baseline) <= 0.5 * big
  }
  // OCR boxes are ink boxes: descenders move the bottom, so compare centres.
  return Math.abs(yMid(a.bbox) - yMid(b.bbox)) <= 0.45 * Math.max(ha, hb)
}

/** A vertical ruling line between two horizontally adjacent units on their row. */
export function ruleBetween(a: BBox, b: BBox, rules: readonly Rule[]): boolean {
  const left = a.x1 <= b.x1 ? a : b
  const right = left === a ? b : a
  const cy = (yMid(a) + yMid(b)) / 2
  for (const r of rules) {
    if (r.axis !== 'v') continue
    const x = (r.x0 + r.x1) / 2
    if (x >= left.x1 - 1 && x <= right.x0 + 1 && r.y0 <= cy && r.y1 >= cy) return true
  }
  return false
}

const cx = (u: Unit): number => (u.bbox.x0 + u.bbox.x1) / 2

/** Groups upright units into lines (visual order) and keeps rotated runs as lines of their own. */
export function groupLines(units: readonly Unit[], rules: readonly Rule[] = [], opts: LineOptions = {}): RawLine[] {
  const upright = units.filter((u) => u.orient === 0)
  const lines: RawLine[] = []

  const n = upright.length
  const order = upright.map((_, i) => i).sort((p, q) => upright[p].bbox.y0 - upright[q].bbox.y0)
  const right = new Array<number>(n).fill(-1)
  const rightGap = new Array<number>(n).fill(Infinity)
  const left = new Array<number>(n).fill(-1)
  const leftGap = new Array<number>(n).fill(Infinity)

  // Candidate pairs: only units whose vertical extents are close (sorted sweep on y0).
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi]
    const a = upright[i]
    const reach = a.bbox.y1 + Math.max(a.bbox.y1 - a.bbox.y0, a.fontSize)
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj]
      const b = upright[j]
      if (b.bbox.y0 > reach) break
      if (!sameRow(a, b)) continue
      consider(i, j)
      consider(j, i)
    }
  }

  function consider(i: number, j: number): void {
    // Is j to the right of i? Allow overlap from estimated positions, but not containment.
    const a = upright[i]
    const b = upright[j]
    if (cx(b) <= cx(a) || b.bbox.x0 < a.bbox.x0 - 0.01) return
    const gap = b.bbox.x0 - a.bbox.x1
    if (gap < rightGap[i]) {
      rightGap[i] = gap
      right[i] = j
    }
    if (gap < leftGap[j]) {
      leftGap[j] = gap
      left[j] = i
    }
  }

  const interRun = interRunGapEm(opts.spaceEm ?? estimateSpaceEm(upright, right, rightGap, 'pdf'))
  const ocrGap = ocrGapEm(estimateSpaceEm(upright, right, rightGap, 'ocr'))
  const limitEm = (a: Unit, b: Unit): number =>
    opts.wideGapEm ??
    (a.source === 'ocr' || b.source === 'ocr'
      ? ocrGap
      : a.run === b.run
        ? WIDE_GAP_EM
        : Math.max(a.mono && b.mono ? MONO_GAP_EM : 0, interRun + (a.tracked && b.tracked ? TRACKED_EXTRA_EM : 0)))

  const parent = upright.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (let i = 0; i < n; i++) {
    const j = right[i]
    if (j < 0) continue
    const a = upright[i]
    const b = upright[j]
    const em = Math.max(a.fontSize, b.fontSize)
    // Text of very different sizes on one baseline (a 20 pt amount beside a 10 pt label) is
    // different elements: measure the gap against the smaller text. Not for OCR, whose sizes
    // come from ink boxes (a dash is 2 pt tall).
    const pdf = a.source === 'pdf' && b.source === 'pdf'
    const gapEm = pdf && Math.min(a.fontSize, b.fontSize) / em < 0.6 ? Math.min(a.fontSize, b.fontSize) : em
    if (rightGap[i] > limitEm(a, b) * gapEm) continue
    // Mutual nearest neighbours, or plain word spacing between same-size text: OCR boxes can
    // overlap their neighbours, which steals the "nearest left" of the next word.
    const similar = Math.min(a.fontSize, b.fontSize) / em >= 0.7
    if (left[j] !== i && !(similar && rightGap[i] <= 0.5 * em)) continue
    if (ruleBetween(a.bbox, b.bbox, rules)) continue
    parent[find(i)] = find(j)
  }

  const groups = new Map<number, Unit[]>()
  upright.forEach((u, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(u)
    else groups.set(r, [u])
  })
  for (const g of groups.values()) {
    g.sort((p, q) => cx(p) - cx(q))
    lines.push(rawLine(g, false))
  }

  // Rotated text: one line per source run, in its own (logical) order.
  const byRun = new Map<string, Unit[]>()
  for (const u of units) {
    if (u.orient === 0) continue
    const key = `${u.run}:${u.orient}`
    const g = byRun.get(key)
    if (g) g.push(u)
    else byRun.set(key, [u])
  }
  for (const g of byRun.values()) lines.push(rawLine(g.sort((p, q) => p.seq - q.seq), true))
  return lines
}

/**
 * The gap (em) that ends an OCR line: OCR_GAP_EM, or more on a page whose word spacing is wide
 * (letter-spaced or monospace print, where tesseract's word gaps reach 1–1.5 em).
 */
export function ocrGapEm(spaceEm: number | null): number {
  return spaceEm ? Math.max(OCR_GAP_EM, 2.2 * spaceEm) : OCR_GAP_EM
}

/**
 * Word spacing (em) of a page: the lower quartile of the gaps between neighbouring pieces (runs
 * of a PDF, words of OCR); most of them are word spaces, cell gaps are fewer and wider. Null
 * with too few samples.
 */
function estimateSpaceEm(units: readonly Unit[], right: readonly number[], rightGap: readonly number[], source: Unit['source']): number | null {
  const ems: number[] = []
  const cap = source === 'ocr' ? 2.5 : 1.2
  units.forEach((a, i) => {
    const j = right[i]
    if (j < 0 || a.source !== source || units[j].source !== source || (source === 'pdf' && units[j].run === a.run)) return
    const em = rightGap[i] / Math.max(a.fontSize, units[j].fontSize)
    if (em > 0.05 && em < cap) ems.push(em)
  })
  if (ems.length < 10) return null
  ems.sort((a, b) => a - b)
  return ems[Math.floor(ems.length / 4)]
}

function rawLine(units: Unit[], fixedOrder: boolean): RawLine {
  const sizes = units.map((u) => u.fontSize).sort((p, q) => p - q)
  return { units, bbox: union(units.map((u) => u.bbox)), fontSize: sizes[Math.floor(sizes.length / 2)], fixedOrder }
}
