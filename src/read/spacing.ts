/**
 * Letter-spaced text (CSS `letter-spacing`, a spaced-out title "I N V O I C E") in the text layer.
 *
 * pdf.js inserts a space into a text item wherever the gap between two glyphs exceeds about a
 * tenth of an em, so a word drawn with letter spacing comes out as letters separated by spaces,
 * and a real word space in it is just one more space: "B I L L TO", "I N V O I C E D E TA I L S",
 * "TOTA L". The item string cannot tell the two apart, but the content stream can: a producer
 * that writes its word spaces as space glyphs (Chrome, Word and most invoicing software do) shows
 * which spaces are real. The glyphs of the page are taken in content order from the operator
 * list, a letter-spaced item is located in that stream by its letters, and its spaces are rebuilt
 * from the space glyphs between them.
 *
 * An item counts as letter-spaced when it looks it (mostly single letters) or when its glyphs
 * were each shown on their own, which is how Chrome draws letter-spaced text; separately shown
 * runs of several glyphs (two spans set apart by a margin) keep their space.
 */

/** The glyphs pdf.js shows, in content order. */
export interface GlyphStream {
  /** The non-space characters of the page in content order (UTF-16 code units). */
  text: string
  /** Per code unit of `text`: whether a word space (space glyph, wide adjustment) precedes it. */
  spaceBefore: boolean[]
  /** Per code unit of `text`: whether its glyph was the only one of its show operation. */
  solo: boolean[]
  /** Whether the page writes word spaces as space glyphs at all (else nothing can be told). */
  hasSpaces: boolean
}

interface GlyphLike {
  unicode?: string
  isSpace?: boolean
}

/** A TJ position adjustment beyond this (thousandths of an em) is a word gap without a glyph. */
const GAP_ADJUSTMENT = -250

/**
 * The glyph stream of a page from the arguments of its showText operators (pdf.js turns TJ into
 * showText with numbers for the position adjustments).
 */
export function glyphStream(showTextArgs: readonly unknown[][]): GlyphStream {
  let text = ''
  const spaceBefore: boolean[] = []
  const solo: boolean[] = []
  let pending = false
  let hasSpaces = false
  for (const args of showTextArgs) {
    const list = args?.[0]
    if (!Array.isArray(list)) continue
    const units: string[] = []
    const spaces: boolean[] = []
    for (const g of list as (GlyphLike | number | null)[]) {
      if (typeof g === 'number') {
        if (g < GAP_ADJUSTMENT) pending = true
        continue
      }
      const u = g?.unicode ?? ''
      if (g?.isSpace || /^\s+$/u.test(u)) {
        pending = true
        hasSpaces = true
        continue
      }
      for (const cu of u.normalize('NFKC')) {
        if (/\s/u.test(cu)) continue
        units.push(cu)
        spaces.push(pending)
        pending = false
      }
    }
    const alone = units.length === 1
    for (let k = 0; k < units.length; k++) {
      text += units[k]
      spaceBefore.push(spaces[k])
      solo.push(alone)
    }
  }
  return { text, spaceBefore, solo, hasSpaces }
}

/** Whether characters (drawing order) look letter-spaced: three tokens or more, mostly one letter. */
export function looksLetterSpaced(drawn: readonly string[]): boolean {
  const tokens = drawn.join('').split(/\s+/u).filter(Boolean)
  if (tokens.length < 3) return false
  const single = tokens.filter((t) => [...t].length === 1).length
  return single / tokens.length >= 0.6
}

/** A cursor over the stream, so successive items are looked up in content order. */
export interface StreamCursor {
  stream: GlyphStream
  next: number
}

export const streamCursor = (stream: GlyphStream): StreamCursor => ({ stream, next: 0 })

/** Glyphs shown one per operation, as letter spacing is drawn, from this share of the item up. */
const SOLO_SHARE = 0.8

/**
 * The drawn characters of a letter-spaced item with its spaces rebuilt from the content stream:
 * a space is kept only where the stream has a word space. Null when the item has no space, is
 * not letter-spaced, or cannot be found in the stream.
 */
export function respaceItem(drawn: readonly string[], cursor: StreamCursor): string[] | null {
  const { stream } = cursor
  if (!stream.hasSpaces || !drawn.some((ch) => /\s/u.test(ch))) return null
  const chars = drawn.filter((ch) => !/\s/u.test(ch))
  const want = chars.join('')
  if (want.length < 2) return null
  let start = stream.text.indexOf(want, cursor.next)
  if (start < 0) start = stream.text.indexOf(want)
  if (start < 0) return null
  cursor.next = start + want.length
  let solo = 0
  for (let k = 0; k < want.length; k++) if (stream.solo[start + k]) solo++
  if (!looksLetterSpaced(drawn) && solo < SOLO_SHARE * want.length) return null
  const out: string[] = []
  let at = start
  for (const ch of chars) {
    if (out.length && stream.spaceBefore[at]) out.push(' ')
    out.push(ch)
    at += ch.length
  }
  return out
}
