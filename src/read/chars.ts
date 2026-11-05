/**
 * Character-level helpers for the reader: bidi classes, mirroring, rough glyph advances and the
 * per-character normalization applied before text is stored.
 *
 * Everything here works on single code points so the callers can keep a position for every
 * character they emit.
 */
import bidiFactory from 'bidi-js'
import type { Direction } from '../model/types'

const bidi = bidiFactory()

/**
 * Coarse bidi class of one character, enough for word-level bidi:
 * R/L strong, D digit (EN/AN), ET terminator (%, ₪, $, °), SEP separator (CS/ES: , . / : + -),
 * NSM combining mark, WS whitespace, X invisible (format/bidi controls), O any other neutral.
 */
export type CharClass = 'R' | 'L' | 'D' | 'ET' | 'SEP' | 'NSM' | 'WS' | 'X' | 'O'

/** Zero-width and format characters that carry no text: removed before anything is stored. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁩﻿؜]/u

export function charClass(ch: string): CharClass {
  if (/\s/u.test(ch)) return 'WS'
  if (INVISIBLE.test(ch)) return 'X'
  switch (bidi.getBidiCharTypeName(ch)) {
    case 'R':
    case 'AL':
      return 'R'
    case 'L':
      // bidi-js reports unassigned and private-use code points as L; they are not letters.
      return /[\p{L}\p{Mc}]/u.test(ch) ? 'L' : 'O'
    case 'EN':
    case 'AN':
      return 'D'
    case 'ET':
      return 'ET'
    case 'CS':
    case 'ES':
      return 'SEP'
    case 'NSM':
      return 'NSM'
    case 'WS':
    case 'S':
    case 'B':
      return 'WS'
    case 'BN':
    case 'LRE':
    case 'RLE':
    case 'LRO':
    case 'RLO':
    case 'PDF':
    case 'LRI':
    case 'RLI':
    case 'FSI':
    case 'PDI':
      return 'X'
    default:
      return 'O'
  }
}

/** The mirrored glyph of a bracket-like character ("(" ↔ ")"), or the character itself. */
export function mirrorChar(ch: string): string {
  return bidi.getMirroredCharacter(ch) ?? ch
}

/** Reverses a neutral run drawn right-to-left and swaps its brackets: visual ")-(" → logical "(-)". */
export function mirrorRun(text: string): string {
  return [...text].reverse().map(mirrorChar).join('')
}

/**
 * Bidi embedding levels of a string laid out in a paragraph of direction `dir` (one level per
 * UTF-16 code unit, as bidi-js counts them).
 */
export function embeddingLevels(text: string, dir: Direction): Uint8Array {
  return bidi.getEmbeddingLevels(text, dir).levels
}

/**
 * Visual (left-to-right drawing) order of the UTF-16 indices of `text`, assuming it is logical
 * text in a paragraph of direction `dir`. pdf.js already turned visual glyph runs into this
 * logical form, and the bidi reordering of a single line is its own inverse, so this recovers
 * where each character was drawn.
 */
export function visualOrder(text: string, dir: Direction): number[] {
  const levels = bidi.getEmbeddingLevels(text, dir)
  return bidi.getReorderedIndices(text, levels)
}

/**
 * Approximate advance width of a character in em, modelled on Arial/Helvetica. Only ratios
 * matter: the reader scales these to the run width the PDF reports, to estimate where each word
 * of a multi-word run starts and ends.
 */
export function advanceEm(ch: string): number {
  if (/\s/u.test(ch)) return 0.278
  const cp = ch.codePointAt(0) ?? 0
  if (cp >= 0x0591 && cp <= 0x05c7 && !/[־׀׃׆]/u.test(ch)) return 0 // niqqud / cantillation
  if (cp >= 0x05d0 && cp <= 0x05ea) {
    if ('וין'.includes(ch)) return 0.25
    if ('זגנ'.includes(ch)) return 0.4
    return 0.57
  }
  if (ch === '״' || ch === '"') return 0.355
  if (ch === '׳' || ch === "'") return 0.191
  if (/[0-9]/.test(ch)) return 0.556
  if (/[ijl]/.test(ch)) return 0.222
  if (/[ftI.,:;!|]/.test(ch)) return 0.278
  if (/[r()[\]{}\-\/]/.test(ch)) return 0.333
  if (/[mM]/.test(ch)) return 0.833
  if (/[wW]/.test(ch)) return ch === 'w' ? 0.722 : 0.944
  if (/[a-z]/.test(ch)) return 0.53
  if (/[A-Z]/.test(ch)) return 0.68
  if (/[%@]/.test(ch)) return 0.95
  if (ch === '₪' || ch === '€') return 0.8
  if (/\p{M}/u.test(ch)) return 0
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) return 1
  return 0.556
}

/**
 * The per-character normalization applied to embedded text before it is stored: NFKC (ligatures
 * like "ﬁ", Hebrew presentation forms, full-width forms), invisible characters dropped. It works
 * per code point so the caller can keep each output character's position.
 */
export function normalizeChar(ch: string): string {
  if (INVISIBLE.test(ch)) return ''
  return ch.normalize('NFKC')
}

/** Letters of a text by script, for `meta.scripts`. */
export function scriptOf(ch: string): string | null {
  if (!/\p{L}/u.test(ch)) return null
  if (/\p{Script=Hebrew}/u.test(ch)) return 'hebrew'
  if (/\p{Script=Latin}/u.test(ch)) return 'latin'
  if (/\p{Script=Arabic}/u.test(ch)) return 'arabic'
  if (/\p{Script=Cyrillic}/u.test(ch)) return 'cyrillic'
  if (/\p{Script=Greek}/u.test(ch)) return 'greek'
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(ch)) return 'cjk'
  return 'other'
}

/**
 * Text that carries no information: replacement characters, private-use code points (glyphs
 * a PDF font never mapped to Unicode), control characters and unassigned code points.
 */
export function isGarbageChar(ch: string): boolean {
  return /[�\p{Co}\p{Cc}\p{Cn}]/u.test(ch)
}
