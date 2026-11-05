/**
 * pdf.js text items → units with page coordinates.
 *
 * What pdf.js gives us (measured on Chrome-made and generated PDFs): one item per drawn run; a
 * run with Hebrew letters comes out reordered into pdf.js's guess of logical order (which we
 * undo, see drawingOrder), other runs (Latin, numbers, signs, brackets) are in drawing order; `transform` is the baseline origin of the run's left end in PDF user space, `width` its
 * advance in user space. Per-glyph positions are not available, so word extents inside a run are
 * estimated from typical glyph advances scaled to the run width.
 */
import type { Direction } from '../model/types'
import type { Unit } from './model'
import { advanceEm, charClass, mirrorChar, normalizeChar, visualOrder } from './chars'
import { splitToken, type PosChar } from './units'

export interface TextItemLike {
  str: string
  dir: string
  transform: number[]
  width: number
  height: number
  fontName: string
}

export interface FontLike {
  /** Ascent and descent in em (descent negative). */
  ascent: number
  descent: number
  bold: boolean
  /** A fixed-pitch font (pdf.js reads the font flags): its word space is 0.6 em. */
  mono?: boolean
}

export interface ItemContext {
  /** Affine user space → page points (top-left origin, y down), as pdf.js viewports give it. */
  viewport: readonly number[]
  /** Index of this item on the page; units of one item share it. */
  run: number
  font: FontLike
  /** Running creation counter shared by the page. */
  nextSeq: () => number
  /** The item's drawn characters with the spaces of letter-spaced text rebuilt, or null (spacing.ts). */
  respace?: (drawn: readonly string[]) => string[] | null
}

export type Affine = readonly number[]

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** m1 applied after m2 (PDF "cm" concatenation: m2 is the new local matrix, m1 the CTM). */
export function multiplyAffine(m1: Affine, m2: Affine): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

/** Angle (degrees, 0..360, y down) at which an item's baseline runs on the page. */
export function itemAngle(transform: readonly number[], viewport: Affine): number {
  const [a, b] = transform
  const dx = viewport[0] * a + viewport[2] * b
  const dy = viewport[1] * a + viewport[3] * b
  return snapAngle((Math.atan2(dy, dx) * 180) / Math.PI)
}

/** Angles within 2° of a right angle count as that angle (scanner/PDF rounding noise). */
export function snapAngle(deg: number): number {
  const d = ((deg % 360) + 360) % 360
  for (const q of [0, 90, 180, 270, 360]) if (Math.abs(d - q) <= 2) return q % 360
  return Math.round(d)
}

/**
 * Hebrew written with a legacy 8-bit encoding (ISO-8859-8 / Windows-1255) in a font without a
 * Unicode map comes out of pdf.js as Latin-1 letters "àáâ…ú", in drawing order. When most letters
 * of a run are in that range it cannot be French or Spanish text, so the letters are mapped back
 * to Hebrew (still in drawing order). Null when the run is not like that.
 */
export function remapLegacyHebrew(str: string): string | null {
  let legacy = 0
  let letters = 0
  for (const ch of str) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    const cp = ch.codePointAt(0)!
    if (cp >= 0xe0 && cp <= 0xfa) legacy++
  }
  if (legacy < 2 || legacy / letters < 0.6) return null
  return [...str]
    .map((ch) => {
      const cp = ch.codePointAt(0)!
      return cp >= 0xe0 && cp <= 0xfa ? String.fromCodePoint(0x05d0 + cp - 0xe0) : ch
    })
    .join('')
}

/**
 * The code points of a pdf.js run in drawing (left-to-right) order. pdf.js reorders a run that
 * contains RTL letters into what it guesses is logical order, deciding the run's direction by a
 * rule of thumb (RTL when ≥30% of its characters are RTL letters) that misfires on runs like
 * "חתימה: ____". The bidi reordering of one line is its own inverse, so reordering again with
 * the direction pdf.js used gives back the drawing order; the line-level bidi then decides with
 * the page's context.
 */
export function drawingOrder(str: string, dir: Direction): string[] {
  const cps = [...str]
  if (!cps.some((ch) => charClass(ch) === 'R')) return cps
  const pos = new Array<number>(str.length)
  visualOrder(str, dir).forEach((logical, visual) => (pos[logical] = visual))
  const starts: { ch: string; rank: number }[] = []
  let u = 0
  for (const ch of cps) {
    starts.push({ ch, rank: pos[u] })
    u += ch.length
  }
  return starts.sort((p, q) => p.rank - q.rank).map((x) => x.ch)
}

/** Splits one pdf.js item into units with page-space boxes. */
export function itemToUnits(item: TextItemLike, ctx: ItemContext, warn?: (code: string) => void): Unit[] {
  const str = item.str
  if (!str || !/\S/u.test(str)) return []
  const legacy = item.dir === 'rtl' ? null : remapLegacyHebrew(str)
  if (legacy !== null) warn?.('legacy-hebrew-encoding')
  const ordered = legacy !== null ? [...legacy] : drawingOrder(str, item.dir === 'rtl' ? 'rtl' : 'ltr')
  const respaced = legacy === null ? (ctx.respace?.(ordered) ?? null) : null
  const drawn = respaced ?? ordered

  // Cumulative estimated advances in drawing order, scaled to the run's real width.
  const adv = drawn.map(advanceEm)
  const totalEm = adv.reduce((sum, x) => sum + x, 0)
  const [a, b, c, d, e, f] = item.transform
  const hScale = Math.hypot(a, b) || 1
  const size = Math.hypot(c, d) || hScale
  const runWidth = item.width > 0 ? item.width : totalEm * hScale
  const k = totalEm > 0 ? runWidth / totalEm : 0

  // Whitespace-separated tokens, left to right. Each character is normalized on its own and
  // kept as one cluster ("שׁ" from a presentation form stays base + mark when reversed).
  const tokens: PosChar[][] = []
  let cur: PosChar[] = []
  let x = 0
  drawn.forEach((ch, i) => {
    const s = x
    x += adv[i] * k
    if (/\s/u.test(ch)) {
      if (cur.length) tokens.push(cur)
      cur = []
      return
    }
    const norm = normalizeChar(ch)
    if (norm) cur.push({ ch: norm, s, t: x })
  })
  if (cur.length) tokens.push(cur)

  const ux = a / hScale
  const uy = b / hScale
  const vx = c / size
  const vy = d / size
  const vpScale = Math.hypot(ctx.viewport[0], ctx.viewport[1]) || 1
  const orient = itemAngle(item.transform, ctx.viewport)
  const asc = ctx.font.ascent * size
  const desc = ctx.font.descent * size
  const box = (s: number, t: number) => {
    const pts = [
      [s, desc],
      [s, asc],
      [t, desc],
      [t, asc],
    ].map(([along, up]) => applyAffine(ctx.viewport, e + ux * along + vx * up, f + uy * along + vy * up))
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  }

  const out: Unit[] = []
  tokens.forEach((tok, ti) => {
    const wordKey = `${ctx.run}:${ti}`
    for (const p of splitToken(tok, false)) {
      const baseline = applyAffine(ctx.viewport, e + ux * p.s, f + uy * p.s)[1]
      out.push({
        // Hebrew runs are drawn right to left: their reading order is the reverse, with mirrored
        // brackets. Everything else stays as drawn and is resolved with the whole line.
        text: p.cls === 'R' ? [...p.clusters].reverse().map((cl) => [...cl].map(mirrorChar).join('')).join('') : p.text,
        bbox: box(p.s, p.t),
        baseline: orient === 0 ? baseline : null,
        fontSize: size * vpScale,
        bold: ctx.font.bold,
        cls: p.cls,
        source: 'pdf',
        confidence: 1,
        wordKey,
        run: ctx.run,
        visual: p.cls !== 'R',
        orient,
        seq: ctx.nextSeq(),
        ...(respaced ? { tracked: true } : {}),
        ...(ctx.font.mono ? { mono: true } : {}),
      })
    }
  })
  return out
}
