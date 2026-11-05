import { describe, expect, it } from 'vitest'
import type { Rule } from './model'
import { orderInBlock, segmentBlocks, type LineBox } from './blocks'

interface L extends LineBox {
  name: string
}
const line = (name: string, x0: number, y0: number, x1: number, size = 10): L => ({ name, bbox: { x0, y0, x1, y1: y0 + size * 1.1 }, fontSize: size })
const names = (blocks: L[][]) => blocks.map((b) => b.map((l) => l.name))

describe('segmentBlocks', () => {
  const right = [line('r1', 350, 50, 540), line('r2', 380, 62, 540), line('r3', 360, 74, 540)]
  const left = [line('l1', 50, 50, 220), line('l2', 50, 62, 200), line('l3', 50, 74, 210)]

  it('splits side-by-side columns and reads the right one first on an RTL page', () => {
    expect(names(segmentBlocks([...left, ...right], 'rtl'))).toEqual([
      ['r1', 'r2', 'r3'],
      ['l1', 'l2', 'l3'],
    ])
    expect(names(segmentBlocks([...left, ...right], 'ltr'))).toEqual([
      ['l1', 'l2', 'l3'],
      ['r1', 'r2', 'r3'],
    ])
  })

  it('separates stacked regions at a vertical whitespace gap and keeps paragraphs whole', () => {
    const para = [line('p1', 50, 200, 540), line('p2', 50, 212, 540), line('p3', 50, 224, 400)]
    expect(names(segmentBlocks([...right, ...left, ...para], 'rtl'))).toEqual([
      ['r1', 'r2', 'r3'],
      ['l1', 'l2', 'l3'],
      ['p1', 'p2', 'p3'],
    ])
  })

  it('reads the columns of an English region left to right on a Hebrew page', () => {
    expect(names(segmentBlocks([...left, ...right], 'rtl', [], () => 'ltr'))[0]).toEqual(['l1', 'l2', 'l3'])
  })

  it('cuts off a title touching the columns below it', () => {
    const title = line('title', 50, 36, 540)
    expect(names(segmentBlocks([title, ...left, ...right], 'rtl'))).toEqual([['title'], ['r1', 'r2', 'r3'], ['l1', 'l2', 'l3']])
  })

  it('reads stacked boxes top to bottom even when they sit on different sides', () => {
    const totals = [line('t1', 50, 300, 250), line('t2', 50, 312, 250)]
    const notes = [line('n1', 350, 330, 540), line('n2', 350, 342, 540)]
    expect(names(segmentBlocks([...notes, ...totals], 'rtl'))).toEqual([
      ['t1', 't2'],
      ['n1', 'n2'],
    ])
  })

  it('treats a ruling line across the region as a cut', () => {
    const rows = [line('a', 50, 100, 300), line('b', 50, 112, 300)]
    const rule: Rule = { x0: 40, x1: 310, y0: 111, y1: 111.5, axis: 'h' }
    expect(names(segmentBlocks(rows, 'ltr'))).toEqual([['a', 'b']])
    expect(names(segmentBlocks(rows, 'ltr', [rule]))).toEqual([['a'], ['b']])
  })
})

describe('orderInBlock', () => {
  it('orders top-down, and same-row lines by page direction', () => {
    const ls = [line('left', 50, 100, 100), line('right', 200, 100, 300), line('below', 50, 114, 300)]
    expect(orderInBlock(ls, 'rtl').map((l) => l.name)).toEqual(['right', 'left', 'below'])
    expect(orderInBlock(ls, 'ltr').map((l) => l.name)).toEqual(['left', 'right', 'below'])
    // An English row on a Hebrew page reads left to right.
    expect(orderInBlock(ls, 'rtl', () => 'ltr').map((l) => l.name)).toEqual(['left', 'right', 'below'])
  })
})
