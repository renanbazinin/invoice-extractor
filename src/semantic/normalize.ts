/**
 * Text preparation for the semantic layer. Matching needs a canonical form (lower case, Hebrew
 * geresh/gershayim and typographic quotes unified, niqqud and Latin accents dropped), but every
 * match must still point at the characters as printed, so the prepared text keeps a map back to
 * the original string. `foldForMatch` in src/lib/text.ts has no such map, which is why this exists.
 */

/** A prepared string plus, for each of its UTF-16 units, the span of the original that produced it. */
export interface MappedText {
  text: string
  /** start[i]: offset in the original string of the character that produced text[i]. */
  start: number[]
  /** end[i]: offset just past that original character. */
  end: number[]
  /** The original string. */
  source: string
}

export interface FoldOptions {
  /** Lower-case letters (labels: yes; currency codes and VAT prefixes: no). */
  lower: boolean
  /** Collapse whitespace runs to one space and trim (default true). */
  collapse?: boolean
}

/** Invisible controls a PDF or OCR engine leaves inside words. */
const INVISIBLE = /[؜​-‏‪-‮⁠⁦-⁩﻿­]/
/** Every space-like character, including NBSP and the thin spaces used as thousands separators. */
const SPACE = /[\s      　]/
/** Single-quote look-alikes: Hebrew geresh, typographic apostrophes, prime, backtick, acute. */
const GERESH = /['׳‘’‚‛`´′]/
/** Double-quote look-alikes: Hebrew gershayim, typographic double quotes, double prime. */
const GERSHAYIM = /["״“”„‟″]/
/** Hyphens, dashes, minus signs and the Hebrew maqaf. */
const DASH = /[‐-―−־﹣－]/
const MARKS = /\p{M}/gu

/**
 * Folds `input` for matching and keeps the offset map. Two adjacent geresh-like characters become
 * one '"', because typists and OCR write gershayim as two apostrophes (מע''מ).
 */
export function foldMapped(input: string, opts: FoldOptions): MappedText {
  const collapse = opts.collapse ?? true
  const chars: { ch: string; at: number }[] = []
  let offset = 0
  for (const ch of input) {
    chars.push({ ch, at: offset })
    offset += ch.length
  }
  let text = ''
  const start: number[] = []
  const end: number[] = []
  const push = (s: string, from: number, to: number): void => {
    for (let k = 0; k < s.length; k++) {
      text += s[k]
      start.push(from)
      end.push(to)
    }
  }
  for (let i = 0; i < chars.length; i++) {
    const { ch, at } = chars[i]
    const to = at + ch.length
    if (INVISIBLE.test(ch)) continue
    if (SPACE.test(ch)) {
      if (!collapse) push(' ', at, to)
      else if (text.length && text[text.length - 1] !== ' ') push(' ', at, to)
      continue
    }
    if (GERESH.test(ch)) {
      const next = chars[i + 1]
      if (next && GERESH.test(next.ch)) {
        push('"', at, next.at + next.ch.length)
        i++
      } else push("'", at, to)
      continue
    }
    if (GERSHAYIM.test(ch)) {
      push('"', at, to)
      continue
    }
    if (DASH.test(ch)) {
      push('-', at, to)
      continue
    }
    let s = ch.normalize('NFKD').replace(MARKS, '')
    if (opts.lower) s = s.toLowerCase()
    push(s, at, to)
  }
  if (collapse && text.endsWith(' ')) {
    text = text.slice(0, -1)
    start.pop()
    end.pop()
  }
  return { text, start, end, source: input }
}

/** Folding used for labels: lower case, everything unified. */
export function foldLabel(input: string): MappedText {
  return foldMapped(input, { lower: true })
}

/** Folding used for values: case kept (currency codes, VAT prefixes), spacing kept as single spaces. */
export function foldValue(input: string): MappedText {
  return foldMapped(input, { lower: false })
}

/** Maps a [from, to) span of the prepared text back to a span of the original string. */
export function originalSpan(m: MappedText, from: number, to: number): { start: number; end: number } {
  if (to <= from) {
    const at = from < m.start.length ? m.start[from] : m.source.length
    return { start: at, end: at }
  }
  return { start: m.start[from], end: m.end[to - 1] }
}

/** A span of the prepared text as it was printed in the original. */
export function originalText(m: MappedText, from: number, to: number): string {
  const { start, end } = originalSpan(m, from, to)
  return m.source.slice(start, end)
}

export const HEBREW_LETTER = /[א-ת]/
export const HEBREW_LETTERS = /[א-ת]/g

/** True when the text has at least one Hebrew letter. */
export function hasHebrew(text: string): boolean {
  return HEBREW_LETTER.test(text)
}

/** Escapes a string for use in a RegExp source outside a character class ('u' flag safe, so no
 *  escaping of '-', which unicode mode rejects there). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
