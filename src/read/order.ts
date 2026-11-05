/**
 * Logical order of a line: the Unicode bidi algorithm run backwards, at unit granularity.
 *
 * A PDF (or a scan) shows text in visual order: on a right-to-left line the first word read is
 * the right-most one, but numbers, Latin words and codes inside it still read left to right. The
 * bidi algorithm (UAX #9) decides, from character classes, which runs are drawn left to right;
 * we resolve the same levels on the visual sequence of units (rules W4–W7, N1–N2 at word level)
 * and undo the L2 reordering.
 *
 * Some visual lines have two logical readings, both valid bidi:
 *  - in an RTL line, "Invoice No 778 31/10/2026" is one LTR run or "31/10/2026" + "Invoice No
 *    778": the canonical reading keeps a run that contains a Latin word together (except a
 *    number set off by a free-standing delimiter, see numberTailDelimiter);
 *  - a cell set LTR (`direction: ltr` / an isolate) inside an RTL page draws "12:30 31/10/2026",
 *    "116.00 ₪" or "24 ביולי 2026" exactly like an RTL paragraph draws "31/10/2026 12:30",
 *    "₪ 116.00", "ביולי 2026 24". Without a layout cue the paragraph direction wins; the cues
 *    used are in directionCue.
 */
import type { BBox, Direction } from '../model/types'
import { union } from '../lib/geometry'
import { dominantDirection } from '../lib/text'
import type { Unit } from './model'
import { mirrorRun } from './chars'

/** Units closer than this (em) count as touching: no space between them in the text. */
export const TOUCH_EM = 0.12

/**
 * Whether two visually adjacent units were written without whitespace between them: pieces of
 * one source word always, pieces of different words of one PDF run never, separate runs (and
 * glyphs a PDF positions one by one) when they touch. Runs that overlap deeply, or sit on
 * different baselines at the same size, are different texts printed over each other (a stamp
 * "נאמן למקור" across a value), not one word.
 */
export function touching(a: Unit, b: Unit): boolean {
  if (a.wordKey === b.wordKey) return true
  if (a.source === 'ocr' || b.source === 'ocr') return false
  if (a.run === b.run) return false
  const em = Math.max(a.fontSize, b.fontSize)
  const gap = Math.max(a.bbox.x0, b.bbox.x0) - Math.min(a.bbox.x1, b.bbox.x1)
  if (gap >= TOUCH_EM * em || gap < -0.3 * em) return false
  const sameSize = Math.min(a.fontSize, b.fontSize) / em >= 0.9
  return !(sameSize && a.baseline !== null && b.baseline !== null && Math.abs(a.baseline - b.baseline) > 0.15 * em)
}

/** A sign glued to the left of a number, possibly with a currency symbol: "-", "-₪", "₪-". */
const SIGN_LEFT = /^(?:[-+−]+\p{Sc}?|\p{Sc}[-+−])$/u
/** The same set off by a space from its number: only with both a sign and a currency symbol. */
const SIGN_CURRENCY = /^(?:[-+−]\p{Sc}|\p{Sc}[-+−])$/u
const TRAILING_PUNCT = /^[.,:;!?]+$/u
const CLOSING_MARK = /^[.,:;!?'"׳״]+$/u
/** Neutrals that separate fields ("info@x.co.il | 03-1234567"). */
const FIELD_DELIMITER = /^(?:[|/·•,;]|[-–—]{1,2})$/u
/** Arithmetic operators between numbers ("2 × 6.62", "3 * 4", "1 @ 14.90"). */
const OPERATOR = /^[×*@=÷]$/u
/** Feet/inches, minutes/seconds after a number. */
const UNIT_MARK = /^['"׳״′″]$/u

/**
 * Layout evidence of the paragraph direction a line was set in, from neutrals that the bidi
 * algorithm moves to the "wrong" side:
 *  - 'rtl': a Latin-only line that starts with sentence punctuation (":Net Amount", ".Ltd ABC")
 *    is how "Net Amount:" is drawn in a right-to-left paragraph;
 *  - 'ltr': a line whose right-most Hebrew run has a separate closing mark glued on its right
 *    ("מחיר ליח'" with the apostrophe drawn right of the Hebrew run) was set left-to-right; in
 *    an RTL paragraph the mark would sit on the left, inside the Hebrew run.
 */
export function directionCue(units: readonly Unit[]): Direction | null {
  const hasR = units.some((u) => u.cls === 'R')
  const hasL = units.some((u) => u.cls === 'L')
  const n = units.length
  if (n < 2 || (!hasR && !hasL)) return null
  if (!hasR) {
    const first = units[0]
    return first.cls === 'O' && TRAILING_PUNCT.test(first.text) && touching(first, units[1]) ? 'rtl' : null
  }
  // The unit right after the right-most Hebrew run ("מס' / #" or "Rate / מחיר ליח'" set LTR:
  // the apostrophe sits right of the Hebrew run, possibly followed by more neutrals).
  let r = n - 1
  while (r >= 0 && units[r].cls !== 'R') r--
  const next = units[r + 1]
  return r >= 0 && next && next.cls === 'O' && CLOSING_MARK.test(next.text) && touching(units[r], next) ? 'ltr' : null
}

/**
 * Base direction used to put a line in logical order, given the paragraph direction of its
 * context. Mixed Hebrew/Latin lines and lines without letters follow the context (both
 * readings are drawn the same; the paragraph decides). Latin-only lines also follow it: in a
 * right-to-left paragraph only their edge neutrals move ("Invoice #" is drawn "# Invoice").
 * Hebrew-only lines are right-to-left. A line whose Hebrew shows the LTR cue of directionCue is
 * left-to-right (a cell set LTR inside an RTL page). A Latin-only line with a label colon in its
 * middle (labelColon: "IL22 0310 … :IBAN") is right-to-left even in an LTR block: no LTR text
 * starts a word with a colon after a space. (A colon at the line's start is left to the
 * paragraph: on an LTR page ":Invoice No" stays as drawn.)
 */
export function lineBaseDirection(units: readonly Unit[], context: Direction): Direction {
  const hasR = units.some((u) => u.cls === 'R')
  const hasL = units.some((u) => u.cls === 'L')
  if (hasR && directionCue(units) === 'ltr') return 'ltr'
  if (hasR && !hasL) return 'rtl'
  if (!hasR && hasL && hasLabelColon(units)) return 'rtl'
  return context
}

/**
 * A Latin-only line with a label colon inside (see labelColon: "IL22 0310 … :IBAN" as drawn)
 * was set right to left, whatever its block's direction.
 */
function hasLabelColon(units: readonly Unit[]): boolean {
  const glued = units.slice(0, -1).map((u, i) => touching(u, units[i + 1]))
  return labelColon(units, glued, 0, units.length - 1) >= 0
}

/**
 * The direction reported on a Line: the base direction, except that a Latin-only line reads
 * left to right whatever paragraph it sits in.
 */
export function reportedDirection(units: readonly Unit[], base: Direction): Direction {
  const hasR = units.some((u) => u.cls === 'R')
  const hasL = units.some((u) => u.cls === 'L')
  return hasL && !hasR ? 'ltr' : base
}

/** Resolved levels of a line's units and of the whitespace between them. */
export interface Levels {
  /** Level of each unit (visual order). */
  units: number[]
  /** Level of the whitespace between units k and k+1 (used only where they do not touch). */
  gaps: number[]
}

/**
 * Embedding levels of the units (visual order) of a line of base direction `base`;
 * `glued[k]` says whether units k and k+1 touch.
 */
export function resolveLevels(units: readonly Pick<Unit, 'cls' | 'text'>[], glued: readonly boolean[], base: Direction): Levels {
  return base === 'rtl' ? levelsInRtl(units, glued) : levelsInLtr(units)
}

function levelsInRtl(units: readonly Pick<Unit, 'cls' | 'text'>[], glued: readonly boolean[]): Levels {
  const n = units.length
  const lv = new Array<number>(n).fill(1)
  const latinRun = new Array<boolean>(n).fill(false)
  // joined[k]: unit k and k+1 form one LTR run even across whitespace (a kept "-₪" and its number).
  const joined = new Array<boolean>(n).fill(false)
  let i = 0
  while (i < n) {
    if (units[i].cls === 'R') {
      i++
      continue
    }
    let j = i
    while (j + 1 < n && units[j + 1].cls !== 'R') j++
    // Stretch i..j has no RTL letters. Neutrals at its edges take the paragraph level (N1/N2:
    // they sit between this run and RTL text or the line end), except:
    //  - a sign (or sign + currency) on the left of a number: "-300.00", "-₪ 6,562.67" written
    //    in an LTR cell read only one way;
    //  - closing punctuation glued to the right of a word or number ("Ltd.", "5.");
    //  - in a run with Latin words, a bracket whose partner is inside the stretch ("80gsm (500
    //    sheets)": N0 gives the pair the direction of the text it encloses; numbers alone count
    //    as R, so "(03)" stays right-to-left).
    const latin = units.slice(i, j + 1).some((u) => u.cls === 'L')
    let a = i
    let b = j
    const keepLeft = (k: number): boolean =>
      k < j && units[k + 1].cls === 'N' && (glued[k] ? SIGN_LEFT.test(units[k].text) : SIGN_CURRENCY.test(units[k].text))
    while (a <= b && units[a].cls === 'O' && !keepLeft(a) && !(latin && pairedInside(units, a, a, b))) a++
    // Closing punctuation glued to a word or number, or a unit mark glued to a number ("40'").
    const closes = (k: number): boolean =>
      k > a && glued[k - 1] && units[k - 1].cls !== 'O' && (TRAILING_PUNCT.test(units[k].text) || (units[k - 1].cls === 'N' && UNIT_MARK.test(units[k].text)))
    while (b >= a && units[b].cls === 'O' && !closes(b) && !(latin && pairedInside(units, b, a, b))) b--
    // Which edges were kept as a sign / closing punctuation (and not only as a bracket partner).
    const keepA = a <= b && units[a].cls === 'O' && keepLeft(a)
    const keepB = b > a && units[b].cls === 'O' && closes(b)
    // Numbers only: each number is its own LTR island; neutrals between numbers (brackets
    // included) are R, since numbers count as R for N0/N1; a kept sign/punctuation stays.
    const numbers = (from: number, to: number, keepFrom: boolean, keepTo: boolean): void => {
      for (let k = from; k <= to; k++) lv[k] = units[k].cls === 'N' || (k === from && keepFrom) || (k === to && keepTo) ? 2 : 1
      if (keepFrom) joined[from] = true
      // Numbers joined by an arithmetic operator are one expression, read as drawn: "2 × 6.62"
      // set in an LTR cell (the usual way to print it in a Hebrew document) is not "6.62 × 2".
      for (let k = from + 1; k < to; k++)
        if (units[k].cls === 'O' && OPERATOR.test(units[k].text) && units[k - 1].cls === 'N' && units[k + 1].cls === 'N') {
          lv[k] = 2
          joined[k - 1] = joined[k] = true
        }
    }
    // A stretch with a Latin word: numbers after it become L (W7), neutrals between are L (N1).
    // Both readings of "info@x.co.il | 03-1234567" are valid bidi; the canonical one keeps the
    // Latin run together, except where the drawing shows a field boundary (labelColon,
    // numberTailDelimiter, markedNumberTail): the part on the right is then read first.
    const segment = (from: number, to: number, keepTo: boolean): void => {
      if (from > to) return
      if (!units.slice(from, to + 1).some((u) => u.cls === 'L')) return numbers(from, to, false, keepTo)
      const c = labelColon(units, glued, from, to)
      if (c >= 0) {
        lv[c] = 1
        segment(from, c - 1, false)
        segment(c + 1, to, keepTo)
        return
      }
      const d = numberTailDelimiter(units, glued, from, to)
      const m = d < 0 ? markedNumberTail(units, glued, from, to) : -1
      const end = d >= 0 ? d - 1 : m >= 0 ? m - 1 : to
      for (let k = from; k <= end; k++) {
        lv[k] = 2
        latinRun[k] = true
      }
      if (d >= 0) numbers(d + 1, to, false, keepTo)
      else if (m >= 0) numbers(m, to, false, keepTo)
    }
    if (a <= b) {
      if (latin) segment(a, b, keepB)
      else numbers(a, b, keepA, keepB)
    }
    i = j + 1
  }
  // Whitespace inside a Latin run is L; anywhere else (between numbers too) it is R.
  const gaps = lv.slice(1).map((_, k) => ((latinRun[k] && latinRun[k + 1]) || joined[k] ? 2 : 1))
  return { units: lv, gaps }
}

const OPEN = '([{'
const CLOSE = ')]}'

/**
 * Whether unit k is a lone bracket whose partner lies inside a..b but not at the opposite edge
 * (a bracket pair that encloses the whole stretch is resolved like any edge neutral).
 */
function pairedInside(units: readonly Pick<Unit, 'text'>[], k: number, a: number, b: number): boolean {
  const t = units[k].text
  const open = OPEN.indexOf(t)
  const close = CLOSE.indexOf(t)
  if (t.length !== 1 || (open < 0 && close < 0)) return false
  const [mine, partner, step] = open >= 0 ? [t, CLOSE[open], 1] : [t, OPEN[close], -1]
  let depth = 0
  for (let m = k + step; m >= a && m <= b; m += step) {
    if (units[m].text === mine) depth++
    else if (units[m].text === partner) {
      if (depth === 0) return step > 0 ? m < b : m > a
      depth--
    }
  }
  return false
}

/**
 * In a Latin run a..b of an RTL line: the index of a label colon, sentence punctuation glued to
 * the left of a Latin word and set off by a space on its other side (":IBAN", ":Your PO"). In an
 * RTL paragraph that is how "IBAN: IL22 0310 …" is drawn when the value follows in a run of its
 * own: the colon closes the label on its right, and what is on its left is the next field. In
 * left-to-right text no word starts with a colon. -1 when there is none.
 */
function labelColon(units: readonly Pick<Unit, 'cls' | 'text'>[], glued: readonly boolean[], a: number, b: number): number {
  for (let k = b - 1; k > a; k--) if (units[k].cls === 'O' && TRAILING_PUNCT.test(units[k].text) && glued[k] && units[k + 1].cls === 'L' && !glued[k - 1]) return k
  return -1
}

/**
 * In a Latin run a..b of an RTL line: the index of a unit mark glued to the left of a number at
 * the run's right end and set off from the rest by a space ("HC '40" as drawn), or -1. The mark
 * follows its number (40' is forty feet, 15" fifteen inches): "40' HC" was written, the number
 * with its mark read first.
 */
function markedNumberTail(units: readonly Pick<Unit, 'cls' | 'text'>[], glued: readonly boolean[], a: number, b: number): number {
  const m = b - 1
  if (m - 1 < a || units[b].cls !== 'N' || units[m].cls !== 'O' || !UNIT_MARK.test(units[m].text)) return -1
  if (!glued[m] || glued[m - 1]) return -1
  return units.slice(a, m).some((u) => u.cls === 'L') ? m : -1
}

/**
 * In a Latin run a..b of an RTL line: the index of a free-standing field delimiter ("|", "-",
 * "/" with spaces around) whose right side holds only numbers and neutrals, or -1. An operator
 * ("USD 2,150.00 × 3.712") joins its operands instead: the expression reads as one LTR run.
 */
function numberTailDelimiter(units: readonly Pick<Unit, 'cls' | 'text'>[], glued: readonly boolean[], a: number, b: number): number {
  for (let k = b - 1; k > a; k--) {
    const u = units[k]
    if (u.cls === 'L') return -1
    if (u.cls !== 'O' || glued[k - 1] || glued[k] || !FIELD_DELIMITER.test(u.text)) continue
    const tail = units.slice(k + 1, b + 1)
    if (tail.some((t) => t.cls === 'N') && units.slice(a, k).some((t) => t.cls === 'L')) return k
  }
  return -1
}

function levelsInLtr(units: readonly Pick<Unit, 'cls' | 'text'>[]): Levels {
  const n = units.length
  const lv = new Array<number>(n).fill(0)
  let i = 0
  while (i < n) {
    if (units[i].cls === 'L') {
      i++
      continue
    }
    let j = i
    while (j + 1 < n && units[j + 1].cls !== 'L') j++
    let a = i
    let b = j
    while (a <= b && units[a].cls === 'O') a++
    while (b >= a && units[b].cls === 'O') b--
    if (a <= b && units.slice(a, b + 1).some((u) => u.cls === 'R')) {
      // An RTL run inside LTR text: letters and neutrals at level 1, numbers at 2 (W7 does not
      // apply: their preceding strong letter is R).
      for (let k = a; k <= b; k++) lv[k] = units[k].cls === 'N' ? 2 : 1
    }
    i = j + 1
  }
  // Whitespace inside an RTL run is R (also between two numbers there); elsewhere L.
  const gaps = lv.slice(1).map((_, k) => (lv[k] >= 1 && lv[k + 1] >= 1 ? 1 : 0))
  return { units: lv, gaps }
}

/**
 * Inverse of rule L2: visual indices in logical order. L2 reverses runs from the highest level
 * down to the lowest odd level; undoing it reverses from the lowest odd level up.
 */
export function visualToLogical(levels: readonly number[]): number[] {
  const n = levels.length
  const idx = levels.map((_, i) => i)
  const lv = [...levels]
  if (!n) return idx
  const max = Math.max(...lv)
  const minOdd = Math.min(...lv) | 1
  for (let level = minOdd; level <= max; level++) {
    let k = 0
    while (k < n) {
      if (lv[k] < level) {
        k++
        continue
      }
      let e = k
      while (e + 1 < n && lv[e + 1] >= level) e++
      reverseRange(idx, k, e)
      reverseRange(lv, k, e)
      k = e + 1
    }
  }
  return idx
}

function reverseRange<T>(arr: T[], from: number, to: number): void {
  for (let p = from, q = to; p < q; p++, q--) [arr[p], arr[q]] = [arr[q], arr[p]]
}

export interface OrderedWord {
  text: string
  units: Unit[]
  bbox: BBox
  dir: Direction | null
}

/**
 * Words of a line in logical order. `units` are in visual (left-to-right) order unless
 * `fixedOrder`, in which case they are already logical.
 */
export function orderLine(units: readonly Unit[], base: Direction, fixedOrder = false): OrderedWord[] {
  if (!units.length) return []
  if (fixedOrder) {
    const words: Unit[][] = []
    units.forEach((u, i) => {
      if (i > 0 && u.wordKey === units[i - 1].wordKey) words[words.length - 1].push(u)
      else words.push([u])
    })
    return words.map((us) => makeWord(us, us.map((u) => u.text)))
  }

  const glued = units.slice(0, -1).map((u, i) => touching(u, units[i + 1]))
  const levels = resolveLevels(units, glued, base)
  // Reorder units together with the whitespace between the ones that do not touch: in logical
  // order, two units with no whitespace between them belong to one word.
  const seq: { unit: number | null; level: number }[] = []
  units.forEach((_, k) => {
    if (k > 0 && !glued[k - 1]) seq.push({ unit: null, level: levels.gaps[k - 1] })
    seq.push({ unit: k, level: levels.units[k] })
  })
  const order = visualToLogical(seq.map((e) => e.level)).map((k) => seq[k])

  const words: OrderedWord[] = []
  let cur: Unit[] = []
  let texts: string[] = []
  const flush = (): void => {
    if (cur.length) words.push(makeWord(cur, texts))
    cur = []
    texts = []
  }
  for (const e of order) {
    if (e.unit === null) {
      flush()
      continue
    }
    const u = units[e.unit]
    cur.push(u)
    texts.push(u.visual && u.cls === 'O' && e.level % 2 === 1 ? mirrorRun(u.text) : u.text)
  }
  flush()
  return words
}

function makeWord(units: Unit[], texts: string[]): OrderedWord {
  const text = texts.join('')
  return { text, units, bbox: union(units.map((u) => u.bbox)), dir: dominantDirection(text) }
}
