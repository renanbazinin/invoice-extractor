/**
 * Turns positioned characters into units: whitespace-free runs of one bidi class.
 *
 * A source word like "(100.00)" or "ABC-12" becomes several units ("(", "100.00", ")"), so the
 * line's bidi pass can move a bracket or a sign that was drawn on the other side of a number in
 * right-to-left text. Units of one source word are glued back into a single Word later.
 */
import type { UnitClass } from './model'
import { charClass, type CharClass } from './chars'

/** One output character with its extent along the run (distance from the run origin). */
export interface PosChar {
  ch: string
  s: number
  t: number
}

export interface UnitPiece {
  text: string
  /** The characters (normalization clusters) of the piece, in input order. */
  clusters: string[]
  cls: UnitClass
  /** Extent along the run. */
  s: number
  t: number
}

interface ClassedChar extends PosChar {
  c: CharClass
}

const isNeutral = (c: CharClass): boolean => c === 'O' || c === 'SEP' || c === 'ET'

/**
 * Splits a whitespace-free token into class runs.
 *
 * `logicalRtl` is set for tokens that pdf.js already reordered from a right-to-left run: a token
 * with any RTL letter is then kept whole (it is in reading order and its neutrals were resolved
 * with it), and only neutral/number/Latin tokens are split.
 */
export function splitToken(chars: readonly PosChar[], logicalRtl: boolean): UnitPiece[] {
  const cs: ClassedChar[] = []
  for (const p of chars) {
    const c = charClass(p.ch)
    if (c === 'X' || c === 'WS') continue
    cs.push({ ...p, c })
  }
  if (!cs.length) return []
  if (logicalRtl && cs.some((x) => x.c === 'R')) return [piece(cs, 'R')]

  const out: UnitPiece[] = []
  let i = 0
  while (i < cs.length) {
    const start = i
    const c = cs[i].c
    if (c === 'R' || c === 'L') {
      i = strongRunEnd(cs, i, c)
      out.push(piece(cs.slice(start, i), c))
      continue
    }
    const numEnd = numberEnd(cs, i)
    if (numEnd > i) {
      i = numEnd
      out.push(piece(cs.slice(start, i), 'N'))
      continue
    }
    // A neutral run (or a stray combining mark): up to the next strong letter or number.
    i++
    while (i < cs.length && (isNeutral(cs[i].c) || cs[i].c === 'NSM') && numberEnd(cs, i) === i) i++
    out.push(piece(cs.slice(start, i), 'O'))
  }
  return out
}

/**
 * End of a strong run starting at `i`: letters of class `c` and their combining marks, plus
 * neutrals that sit between two letters of the same class ("e.g", 'סה"כ', "O'Brien").
 */
function strongRunEnd(cs: readonly ClassedChar[], i: number, c: CharClass): number {
  let j = i + 1
  for (;;) {
    while (j < cs.length && (cs[j].c === c || cs[j].c === 'NSM')) j++
    let k = j
    while (k < cs.length && isNeutral(cs[k].c)) k++
    if (k > j && k < cs.length && cs[k].c === c) j = k
    else return j
  }
}

/**
 * End of a number starting at `i`, or `i` when none starts there. Follows the bidi rules W4/W5:
 * digits, single separators between digits ("1,180.00", "31/10/2026", "03-1234567") and
 * terminators touching digits ("18%", "₪1,180.00").
 */
export function numberEnd(cs: readonly { c: CharClass }[], i: number): number {
  let j = i
  while (j < cs.length && cs[j].c === 'ET') j++
  if (j >= cs.length || cs[j].c !== 'D') return i
  for (;;) {
    while (j < cs.length && (cs[j].c === 'D' || cs[j].c === 'NSM')) j++
    if (j + 1 < cs.length && cs[j].c === 'SEP' && cs[j + 1].c === 'D') {
      j++
      continue
    }
    break
  }
  while (j < cs.length && cs[j].c === 'ET') j++
  return j
}

function piece(cs: readonly ClassedChar[], cls: UnitClass): UnitPiece {
  let s = Infinity
  let t = -Infinity
  for (const x of cs) {
    s = Math.min(s, x.s)
    t = Math.max(t, x.t)
  }
  return { text: cs.map((x) => x.ch).join(''), clusters: cs.map((x) => x.ch), cls, s, t }
}

/** Class of a whole word whose text is already logical (OCR words, rotated runs). */
export function wordClass(text: string): UnitClass {
  let hasL = false
  let hasD = false
  for (const ch of text) {
    const c = charClass(ch)
    if (c === 'R') return 'R'
    if (c === 'L') hasL = true
    if (c === 'D') hasD = true
  }
  return hasL ? 'L' : hasD ? 'N' : 'O'
}
