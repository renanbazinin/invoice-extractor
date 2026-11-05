import { describe, expect, it } from 'vitest'
import type { Table, TableRow, TextRef } from '../../model/types'
import type { NumberFormat } from '../../semantic'
import { mapColumns } from './columns'
import { detailOf, scriptOf } from './details'

const FMT: NumberFormat = { decimal: '.', group: ',', confidence: 1 }
const ref = (text: string, x0: number): TextRef => ({ page: 1, wordIds: [], text, bbox: { x0, y0: 0, x1: x0 + 30, y1: 10 } })

/** An untitled table: rows of cells at the given x positions. */
function table(xs: number[], rows: string[][]): Table {
  const body: TableRow[] = rows.map((cells, i) => ({
    index: i,
    page: 1,
    kind: 'item',
    cells: cells.map((t, j) => (t ? ref(t, xs[j]) : null)),
    bbox: { x0: 0, y0: i * 12, x1: 600, y1: i * 12 + 10 },
  }))
  return { id: 't1', role: 'items', pages: [1], columns: xs.map((x, j) => ({ index: j, x0: x, x1: x + 30, header: null })), rows: body, bbox: { x0: 0, y0: 0, x1: 600, y1: 100 }, score: 0.6 }
}

describe('mapColumns', () => {
  it('tells quantity from unit price when every line multiplies either way (1 × 180.00)', () => {
    // RTL: amount | price | quantity | description, all lines with quantity 1 but one.
    const t = table(
      [40, 100, 144, 229],
      [
        ['180.00', '180.00', '1', 'בדיקה'],
        ['220.00', '220.00', '1', 'צילום'],
        ['960.00', '480.00', '2', 'סתימה'],
      ],
    )
    const { roles } = mapColumns(t, [0, 1, 2], FMT, true)
    expect(roles).toEqual(['amount', 'unit_price', 'quantity', 'description'])
  })
})

describe('detailOf', () => {
  it('reads labelled lines and code lines under an item', () => {
    expect(detailOf('Packing: 200 per ctn', 'latin', 'Description', false)).toEqual({ key: 'Packing', label: 'Packing', start: 9 })
    expect(detailOf('SKU OCP-BP-R02', 'latin', 'Item', false)?.key).toBe('sku')
    // A wrapped description is neither.
    expect(detailOf('80 cm', 'latin', 'Bezeichnung', false)).toBeNull()
    expect(detailOf('Synchronmechanik', 'latin', 'Bezeichnung', true)).toBeNull()
  })

  it('reads a translation only in a table that translates its names, keyed by the title in its script', () => {
    expect(detailOf('Deluxe Double Room', 'hebrew', 'תיאור DESCRIPTION', true)).toEqual({ key: 'DESCRIPTION', label: '', start: 0 })
    expect(detailOf('Deluxe Double Room', 'hebrew', 'תיאור DESCRIPTION', false)).toBeNull()
    // A title in one script only: no translation.
    expect(detailOf('Deluxe Double Room', 'hebrew', 'תיאור', true)).toBeNull()
    expect(scriptOf('לינה – חדר זוגי')).toBe('hebrew')
    expect(scriptOf('הובלה ימית FCL 40HC נינגבו')).toBe('hebrew')
  })
})
