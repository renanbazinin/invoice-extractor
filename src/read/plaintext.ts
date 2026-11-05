/**
 * Plain text input (the contract allows `text/plain`): the text is already logical, so lines are
 * built in that order and only given synthetic monospace positions. Runs of two or more spaces
 * or a tab end a line, like a wide gap on a page; a blank line ends a block; a form feed starts
 * a new page. Blocks and lines keep the order of the text (no layout analysis is needed).
 */
import type { Direction } from '../model/types'
import { firstStrongDirection } from '../lib/text'
import type { RawLine, Unit } from './model'
import { visualOrder } from './chars'
import { splitToken } from './units'

/** Synthetic metrics: 10 pt monospace, 6 pt advance, 14 pt line pitch, 36 pt margins. */
const FONT = 10
const ADVANCE = 6
const PITCH = 14
const MARGIN = 36

export interface TextPage {
  width: number
  height: number
  /** Paragraphs in text order, lines in text order. */
  blocks: RawLine[][]
}

export function plainTextPages(text: string): TextPage[] {
  return text
    .replace(/^﻿/u, '')
    .split('\f')
    .map((pageText) => {
      const rows = pageText.split(/\r?\n/u).map((r) => r.replace(/\t/gu, '    '))
      const cols = Math.max(80, ...rows.map((r) => [...r].length))
      const width = 2 * MARGIN + cols * ADVANCE
      const height = Math.max(842, 2 * MARGIN + rows.length * PITCH)
      const blocks: RawLine[][] = [[]]
      let seq = 0
      rows.forEach((row, r) => {
        if (!row.trim()) {
          if (blocks[blocks.length - 1].length) blocks.push([])
          return
        }
        const dir: Direction = firstStrongDirection(row) ?? 'ltr'
        // Astral characters would break the UTF-16 visual order: lay those rows out unreordered.
        const order = [...row].length === row.length ? visualOrder(row, dir) : null
        blocks[blocks.length - 1].push(...rowLines(row, r, dir, width, () => seq++, order))
      })
      return { width, height, blocks: blocks.filter((b) => b.length) }
    })
}

/** One text row → lines (split at wide gaps), units in logical order with visual-column boxes. */
function rowLines(row: string, r: number, dir: Direction, width: number, nextSeq: () => number, order: number[] | null): RawLine[] {
  const col = new Array<number>(row.length)
  if (order) order.forEach((logical, visual) => (col[logical] = visual))
  else for (let i = 0; i < row.length; i++) col[i] = i
  const n = row.length
  // Right-to-left rows are right-aligned, as an editor would show them.
  const x = (c: number): number => (dir === 'rtl' ? width - MARGIN - (n - c) * ADVANCE : MARGIN + c * ADVANCE)
  const y0 = MARGIN + r * PITCH
  const out: RawLine[] = []
  for (const seg of row.matchAll(/\S+(?: \S+)*/gu)) {
    const units: Unit[] = []
    for (const tok of seg[0].matchAll(/\S+/gu)) {
      const start = seg.index + tok.index
      const chars = [...tok[0]].map((ch, i) => ({ ch, s: x(col[start + i]), t: x(col[start + i]) + ADVANCE }))
      for (const p of splitToken(chars, true)) {
        units.push({
          text: p.text,
          bbox: { x0: p.s, y0, x1: p.t, y1: y0 + FONT * 1.1 },
          baseline: y0 + FONT * 0.9,
          fontSize: FONT,
          bold: false,
          cls: p.cls,
          source: 'pdf',
          confidence: 1,
          wordKey: `t${r}:${start}`,
          run: r,
          visual: false,
          orient: 0,
          seq: nextSeq(),
        })
      }
    }
    if (!units.length) continue
    const xs = units.flatMap((u) => [u.bbox.x0, u.bbox.x1])
    out.push({ units, bbox: { x0: Math.min(...xs), y0, x1: Math.max(...xs), y1: y0 + FONT * 1.1 }, fontSize: FONT, fixedOrder: true })
  }
  return out
}
