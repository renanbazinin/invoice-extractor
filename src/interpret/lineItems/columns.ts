import { abs, add, cmp, dec, div, eq, fromInt, isZero, mul, round, sub, type Dec } from '../../lib/decimal'
import type { Table, TextRef } from '../../model/types'
import { matchLabels, parseAmount, parsePercent, parseQuantity, type NumberFormat } from '../../semantic'
import { cellKind, looseAmount, type CellKind } from '../../structure/tables'

/**
 * Column roles of an item table. The header's lexicon concept is the first guess; the values
 * correct it: a "quantity" column holding words is the unit of measure, a "description" column
 * holding codes is the article number, a "VAT" column holding amounts is a per-line VAT amount
 * (not a rate). Then arithmetic settles the numbers: the three columns where quantity × unit
 * price = amount on most rows are those roles, whatever their titles say, or when there are none.
 */

export type ColumnRole = 'description' | 'quantity' | 'unit_price' | 'amount' | 'tax_rate' | 'discount' | 'sku' | 'unit' | 'line_number'

const FROM_CONCEPT: Record<string, ColumnRole> = {
  'col.description': 'description',
  'col.quantity': 'quantity',
  'col.unit_price': 'unit_price',
  'col.line_amount': 'amount',
  'col.tax_rate': 'tax_rate',
  'col.discount': 'discount',
  'col.sku': 'sku',
  'col.unit': 'unit',
  'col.line_number': 'line_number',
}

export interface ColumnStats {
  /** Non-empty cells in item rows. */
  n: number
  kinds: Partial<Record<CellKind, number>>
  /** Average letters per cell. */
  letters: number
  /** The numeric value of each item row's cell (null when empty or not a number). */
  values: (Dec | null)[]
  /** Percent values of each item row's cell (discount, VAT rate). */
  percents: (Dec | null)[]
  /** Values are 1, 2, 3, … in order. */
  sequential: boolean
}

export interface ColumnMap {
  /** Role of each column (null: kept as an extra cell). */
  roles: (ColumnRole | null)[]
  /** The roles of quantity, unit price and amount were confirmed by their product on most rows. */
  arithmetic: boolean
}

const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length

/**
 * The column concept a header names: the column reading of each lexicon match (a cell "סה"כ" is
 * a subtotal label in general but the line-amount column in a header), longest and strongest first.
 */
export function conceptOfHeader(header: TextRef | null): string | null {
  if (!header) return null
  const total = letters(header.text) || 1
  const scores = new Map<string, number>()
  for (const m of matchLabels(header.text)) {
    const len = letters(header.text.slice(m.start, m.end)) || 1
    if (m.kind === 'column') scores.set(m.concept, (scores.get(m.concept) ?? 0) + len * (m.strength === 'strong' ? 1 : 0.7))
    for (const a of m.also) if (a.startsWith('col.')) scores.set(a, (scores.get(a) ?? 0) + len * 0.6)
  }
  let best: string | null = null
  let bestScore = 0
  for (const [c, s] of scores) {
    if (s > bestScore) {
      best = c
      bestScore = s
    }
  }
  return best && bestScore / total >= 0.3 ? best : null
}

/** A number as printed in a quantity, price or amount cell. */
export function numberOf(text: string, fmt: NumberFormat): Dec | null {
  const a = parseAmount(text, fmt)
  if (a) return dec(a.amount)
  const q = parseQuantity(text, fmt)
  if (q) return dec(q.value)
  const loose = looseAmount(text, fmt)
  return loose ? dec(loose.amount) : null
}

export function columnStats(cells: readonly (TextRef | null)[], fmt: NumberFormat): ColumnStats {
  const kinds: Partial<Record<CellKind, number>> = {}
  let n = 0
  let chars = 0
  const percents: (Dec | null)[] = []
  const values = cells.map((c) => {
    if (!c) {
      percents.push(null)
      return null
    }
    n++
    const k = cellKind(c.text, fmt)
    kinds[k] = (kinds[k] ?? 0) + 1
    chars += letters(c.text)
    const pct = k === 'percent' ? parsePercent(c.text) : null
    percents.push(pct ? dec(pct.value) : null)
    return k === 'money' || k === 'number' ? numberOf(c.text, fmt) : null
  })
  const present = values.filter((v): v is Dec => v !== null)
  const sequential = present.length >= 2 && present.length === n && present.every((v, i) => eq(v, fromInt(i + 1)))
  return { n, kinds, letters: n ? chars / n : 0, values, percents, sequential }
}

const share = (s: ColumnStats, ...ks: CellKind[]): number => (s.n ? ks.reduce((t, k) => t + (s.kinds[k] ?? 0), 0) / s.n : 0)

/**
 * q × p = a, allowing for a unit price rounded to the cent (33.33 for 33.333…): within one cent
 * plus half a cent per unit. Stricter than the validation's row check on purpose: here it picks
 * columns, and a loose test lets any small numbers "multiply" (10 × 0 ≈ 1 within half a unit).
 */
export function multiplies(q: Dec, p: Dec, a: Dec): boolean {
  if (isZero(a) || isZero(p) || isZero(q)) return false
  const diff = abs(sub(round(mul(q, p), 2), a))
  return cmp(diff, add(mul(abs(q), dec('0.005')), dec('0.01'))) <= 0
}

const HUNDRED = fromInt(100)

/** Share of a column's numbers that are whole (2, 3.00). */
function wholeShare(s: ColumnStats): number {
  const vs = s.values.filter((v): v is Dec => v !== null)
  if (!vs.length) return 0
  return vs.filter((v) => eq(round(v, 0), v)).length / vs.length
}

/** The row's product after a line discount (percent or amount), when one is printed. */
function discounted(q: Dec, p: Dec, d: { pct: Dec | null; amount: Dec | null }): Dec | null {
  if (d.pct) return div(mul(mul(q, p), sub(HUNDRED, d.pct)), HUNDRED, 4)
  if (d.amount) return sub(mul(q, p), abs(d.amount))
  return null
}

/**
 * Assigns a role to every column of an item table, from headers and values (see the file comment).
 * `rtl`: on a right-to-left page the amount is the left-most numeric column.
 */
export function mapColumns(table: Table, itemRows: readonly number[], fmt: NumberFormat, rtl: boolean): ColumnMap {
  const concepts = table.columns.map((c) => conceptOfHeader(c.header))
  const stats = table.columns.map((_, j) => columnStats(itemRows.map((r) => table.rows[r].cells[j] ?? null), fmt))
  const roles: (ColumnRole | null)[] = concepts.map((c) => (c ? FROM_CONCEPT[c] ?? null : null))

  // Values correct the titles.
  roles.forEach((role, j) => {
    const s = stats[j]
    if (!s.n) return
    const numeric = share(s, 'money', 'number')
    if ((role === 'quantity' || role === 'unit_price' || role === 'amount') && numeric < 0.5 && share(s, 'qxp') < 0.5) {
      roles[j] = role === 'quantity' && share(s, 'text') >= 0.5 && s.letters <= 8 ? 'unit' : null
    }
    if (role === 'tax_rate' && share(s, 'percent') < 0.5) roles[j] = null
    if (role === 'discount' && share(s, 'percent', 'money', 'number') < 0.5) roles[j] = null
    if (role === 'description' && share(s, 'code') >= 0.6) roles[j] = 'sku'
    if (role === 'line_number' && !s.sequential && share(s, 'number') < 0.8) roles[j] = null
  })
  // Sequential integers on the outer edge with no title are line numbers.
  stats.forEach((s, j) => {
    if (roles[j] === null && s.sequential && (j === 0 || j === stats.length - 1)) roles[j] = 'line_number'
  })
  // Two description columns: the one with more words is the description, the other a code or extra.
  const descs = roles.map((r, j) => (r === 'description' ? j : -1)).filter((j) => j >= 0)
  if (descs.length > 1) {
    const keep = descs.reduce((a, b) => (stats[b].letters > stats[a].letters ? b : a))
    for (const j of descs) if (j !== keep) roles[j] = share(stats[j], 'code', 'number') >= 0.5 || stats[j].letters < 4 ? 'sku' : null
  }

  // Two columns with one title concept ("Net" and "Total", "סה"כ" twice): the line amount is the
  // one at the end of the reading direction; for other roles the first. The rest are extras.
  for (const role of ['amount', 'unit_price', 'quantity', 'tax_rate', 'discount', 'sku', 'unit'] as const) {
    const cols = roles.map((r, j) => (r === role ? j : -1)).filter((j) => j >= 0)
    if (cols.length < 2) continue
    const keep = role === 'amount' ? (rtl ? cols[0] : cols[cols.length - 1]) : cols[0]
    for (const j of cols) if (j !== keep) roles[j] = null
  }

  const arithmetic = settleByArithmetic(roles, stats, rtl)
  // One untitled number column between a titled quantity and amount is the unit price (and the
  // other way round), when the arithmetic could not tell (misread digits, empty cells).
  const untitled = (kinds: CellKind[]) => stats.map((s, j) => (roles[j] === null && share(s, ...kinds) >= 0.6 ? j : -1)).filter((j) => j >= 0)
  if (!arithmetic && roles.includes('amount')) {
    const money = untitled(['money', 'number'])
    if (roles.includes('quantity') && !roles.includes('unit_price') && money.length === 1) roles[money[0]] = 'unit_price'
    const counts = untitled(['number'])
    if (roles.includes('unit_price') && !roles.includes('quantity') && counts.length === 1) roles[counts[0]] = 'quantity'
  }
  // Without a title, the amount is the money column at the end of the reading direction.
  if (!roles.includes('amount')) {
    const money = stats.map((s, j) => (roles[j] === null && share(s, 'money') >= 0.6 ? j : -1)).filter((j) => j >= 0)
    if (money.length) roles[rtl ? money[0] : money[money.length - 1]] = 'amount'
  }
  if (!roles.includes('description')) {
    let best = -1
    stats.forEach((s, j) => {
      if (roles[j] === null && share(s, 'text', 'qxp') >= 0.5 && (best < 0 || s.letters > stats[best].letters)) best = j
    })
    if (best >= 0) roles[best] = 'description'
  }
  return { roles, arithmetic }
}

/**
 * Finds the (quantity, unit price, amount) columns among the numeric ones by checking
 * quantity × price (less a line discount) = amount row by row. Titles break ties (the product is
 * symmetric); a triple must hold on at least half of the rows that fill all three, and on two rows
 * when the table has two. Returns whether arithmetic decided.
 */
function settleByArithmetic(roles: (ColumnRole | null)[], stats: readonly ColumnStats[], rtl: boolean): boolean {
  const excluded = new Set<ColumnRole | null>(['line_number', 'sku', 'tax_rate', 'discount', 'description', 'unit'])
  const numeric = stats.map((s, j) => (share(s, 'money', 'number') >= 0.5 && !excluded.has(roles[j]) ? j : -1)).filter((j) => j >= 0)
  if (numeric.length < 3) return false
  const discCol = roles.indexOf('discount')
  const check = (q: number, p: number, a: number): { hits: number; filled: number } => {
    let hits = 0
    let filled = 0
    stats[a].values.forEach((av, r) => {
      const qv = stats[q].values[r]
      const pv = stats[p].values[r]
      if (!av || !qv || !pv) return
      filled++
      if (multiplies(qv, pv, av)) {
        hits++
        return
      }
      if (discCol >= 0) {
        const d = discounted(qv, pv, { pct: stats[discCol].percents[r], amount: stats[discCol].values[r] })
        if (d && cmp(abs(sub(round(d, 2), av)), dec('0.01')) <= 0) hits++
      }
    })
    return { hits, filled }
  }
  // Titles that the numbers confirm are kept; titles the numbers never confirm can be overruled,
  // but only by a clear majority (misread digits must not reshuffle a titled table).
  const tq = roles.indexOf('quantity')
  const tp = roles.indexOf('unit_price')
  const ta = roles.indexOf('amount')
  const titled = tq >= 0 && tp >= 0 && ta >= 0 ? check(tq, tp, ta) : null
  if (titled && titled.hits >= 1 && titled.hits * 2 >= titled.filled) return true
  let best: { q: number; p: number; a: number; score: number } | null = null
  for (const a of numeric)
    for (const q of numeric)
      for (const p of numeric) {
        if (a === q || a === p || q === p) continue
        const { hits, filled } = check(q, p, a)
        if (!filled || hits * 2 < filled || hits < Math.min(2, filled)) continue
        if (titled && (hits < 2 || hits * 5 < filled * 4)) continue
        let score = hits * 10
        if (roles[a] === 'amount') score += 3
        if (roles[q] === 'quantity') score += 2
        if (roles[p] === 'unit_price') score += 2
        if (roles[q] === 'unit_price' || roles[p] === 'quantity') score -= 2
        if (roles[a] === 'quantity' || roles[a] === 'unit_price') score -= 3
        // Amounts sit at the end of the reading direction; quantities are mostly whole numbers,
        // printed without cents where prices have them ("1" next to "180.00"); and the unit price
        // stands next to the amount, the quantity further from it.
        if ((rtl && a < Math.min(q, p)) || (!rtl && a > Math.max(q, p))) score += 1
        if (wholeShare(stats[q]) > wholeShare(stats[p])) score += 1
        else if (wholeShare(stats[q]) === wholeShare(stats[p]) && share(stats[q], 'number') > share(stats[p], 'number')) score += 1
        if (Math.abs(p - a) < Math.abs(q - a)) score += 0.5
        if (!best || score > best.score) best = { q, p, a, score }
      }
  if (!best) return false
  for (const [j, role] of [
    [best.q, 'quantity'],
    [best.p, 'unit_price'],
    [best.a, 'amount'],
  ] as const) {
    const other = roles.indexOf(role)
    if (other >= 0 && other !== j) roles[other] = null
    roles[j] = role
  }
  return true
}
