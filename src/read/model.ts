/**
 * Internal types of the reader. They never leave src/read: the public output is the
 * DocumentModel of src/model/types.ts.
 */
import type { BBox, TextSource } from '../model/types'

/** Bidi class of a unit at word granularity: strong RTL, strong LTR, number, other neutral. */
export type UnitClass = 'R' | 'L' | 'N' | 'O'

/**
 * The smallest piece of positioned text the layout logic works with: a whitespace-free run of
 * one bidi class (a Hebrew word, a Latin word, a number, a bracket or sign).
 *
 * Words are assembled from units only after the line's logical order is known, because a word
 * like "(100.00)" or "-300.00" in a right-to-left line is drawn as pieces whose visual order
 * differs from their reading order.
 */
export interface Unit {
  /** Characters in logical order inside the unit (for `visual` units: as drawn, left to right). */
  text: string
  bbox: BBox
  /** Baseline y in page points; null when unknown (OCR). */
  baseline: number | null
  fontSize: number
  bold: boolean
  cls: UnitClass
  source: TextSource
  /** 1 for embedded text, the OCR word confidence (0..1) otherwise. */
  confidence: number
  /** Units with the same key were written without whitespace between them (one source word). */
  wordKey: string
  /**
   * Source run (pdf.js text item) index. Two units of the same run with different word keys
   * were separated by whitespace in the run.
   */
  run: number
  /**
   * True when `text` is a neutral run in drawing order that has not been through any bidi
   * processing yet: if it resolves to a right-to-left level it must be reversed and mirrored.
   */
  visual: boolean
  /**
   * Text direction on the page in degrees, 0 for upright text. Units at other angles (side notes,
   * stamps, watermarks) are kept on lines of their own.
   */
  orient: number
  /** Creation order; within one run this is logical order. */
  seq: number
  /**
   * From a letter-spaced run (spacing.ts): its word spaces are wider by twice the tracking, so the
   * line grouping allows more between two such units.
   */
  tracked?: boolean
  /** Set in a fixed-pitch font, whose word space (0.6 em) is twice a proportional font's. */
  mono?: boolean
}

/** A ruling line drawn on the page (table borders, separators, box edges), in page points. */
export interface Rule {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 'h' horizontal or 'v' vertical. */
  axis: 'h' | 'v'
}

/** A line before ids and logical order exist: units in visual left-to-right order. */
export interface RawLine {
  units: Unit[]
  bbox: BBox
  fontSize: number
  /** True for rotated text: `units` are already in logical order and are not reordered. */
  fixedOrder: boolean
}

/** One page's raw material, whatever produced it (text layer or OCR). */
export interface PageInput {
  /** 1-based. */
  number: number
  width: number
  height: number
  source: TextSource
  units: Unit[]
  rules: Rule[]
}
