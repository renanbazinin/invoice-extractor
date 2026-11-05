import { evidenceOf } from '../../lib/docIndex'
import type { Evidence, FieldCandidate, FieldCandidateLite, LineItemCandidate, Structure, Table, TextRef } from '../../model/types'
import { dec, eq, mul, round, type Dec } from '../../lib/decimal'
import { attachContinuations, cellKind, embeddedQxP, looseAmount, parseQxP, type QxPParse } from '../../structure/tables'
import { findCurrencies, parseAmount, parsePercent, parseQuantity } from '../../semantic'
import type { DocContext } from '../context'
import { mapColumns, type ColumnRole } from './columns'
import { detailOf, isTranslation, scriptOf } from './details'

export interface LineItemInterpretation {
  /** Rows of the main item table, in document order. */
  lineItems: LineItemCandidate[]
  /** The table the items came from, or null. */
  mainTableId: string | null
  /** Standard-field candidates the tables provide (e.g. a currency or tax-rate column). */
  candidates: FieldCandidate[]
  usedLineIds: string[]
}

/**
 * Line items (layer 3) from the item tables of the structure. Every table whose role is 'items'
 * contributes its item rows in document order (an invoice may print parts and labour as two
 * tables); summary rows, page totals and carried-forward rows never become items. Column roles
 * come from the titles and the values (columns.ts); a description gathers the text rows that
 * belong to its item (continuation lines, or a name printed above "2 x 9.90"), except lines that
 * say something else about it (details.ts): a translation in a bilingual table, "Packing: …",
 * "SKU …", and a till receipt's "q × p + barcode" line, whose numbers become the quantity, unit
 * price and SKU.
 */
export function interpretLineItems(ctx: DocContext, structure: Structure): LineItemInterpretation {
  const tables = structure.tables.filter((t) => t.role === 'items')
  const lineItems: LineItemCandidate[] = []
  const used = new Set<string>()
  for (const table of tables) {
    for (const item of tableItems(ctx, table, used)) lineItems.push({ ...item, index: lineItems.length })
  }
  return { lineItems, mainTableId: tables[0]?.id ?? null, candidates: [], usedLineIds: [...used] }
}

function hasOwnDescription(ctx: DocContext, table: Table, row: number, descCol: number): boolean {
  const cells = descCol >= 0 ? [table.rows[row].cells[descCol]] : table.rows[row].cells
  return cells.some((c) => !!c && cellKind(c.text, ctx.numberFormat) === 'text')
}

function tableItems(ctx: DocContext, table: Table, used: Set<string>): LineItemCandidate[] {
  const itemRows = table.rows.map((r, i) => (r.kind === 'item' ? i : -1)).filter((i) => i >= 0)
  if (!itemRows.length) return []
  const rtl = table.rows.some((r) => r.cells.some((c) => c && ctx.index.line.get(ctx.index.word.get(c.wordIds[0])!.lineId)?.dir === 'rtl'))
  const { roles } = mapColumns(table, itemRows, ctx.numberFormat, rtl)
  const col = (role: ColumnRole): number => roles.indexOf(role)
  const descCol = col('description')
  const groups = attachContinuations(
    table.rows.map((r, i) => ({ kind: r.kind, page: r.page, bbox: r.bbox, hasDescription: hasOwnDescription(ctx, table, i, descCol) })),
  )
  const extraLines = new Map<number, number[]>()
  for (const g of groups) if (g.item >= 0) extraLines.set(g.item, [...(extraLines.get(g.item) ?? []), g.row])
  const headerCurrency = table.columns.map((c) => (c.header ? currencyOfText(c.header.text) : null))
  const descHeader = descCol >= 0 ? (table.columns[descCol].header?.text ?? null) : null
  const textOf = (r: number): TextRef | null => (descCol >= 0 ? table.rows[r].cells[descCol] : table.rows[r].cells.find((c) => c && /\p{L}/u.test(c.text))) ?? null
  // A bilingual table prints a translation under (nearly) every name.
  const withTranslation = itemRows.filter((ri) => {
    const own = descCol >= 0 ? table.rows[ri].cells[descCol] : null
    const script = own ? scriptOf(own.text) : null
    return (extraLines.get(ri) ?? []).some((k) => {
      const t = textOf(k)
      return !!t && isTranslation(t.text, script, descHeader)
    })
  }).length
  const translated = withTranslation >= 2 && withTranslation >= 0.6 * itemRows.length

  const markUsed = (ref: TextRef | null): void => {
    for (const id of ref?.wordIds ?? []) used.add(ctx.index.word.get(id)!.lineId)
  }
  for (const r of table.rows) if (r.kind === 'header') r.cells.forEach(markUsed)
  for (const c of table.columns) markUsed(c.header)

  return itemRows.map((ri, n) => {
    const row = table.rows[ri]
    row.cells.forEach(markUsed)
    const cell = (role: ColumnRole): TextRef | null => {
      const j = col(role)
      return j >= 0 ? row.cells[j] ?? null : null
    }
    const money = (role: ColumnRole): FieldCandidateLite | null => {
      const c = cell(role)
      return c ? moneyLite(ctx, c, headerCurrency[col(role)]) : null
    }
    let quantity = cell('quantity') ? quantityLite(ctx, cell('quantity')!) : null
    let unitPrice = money('unit_price')
    let amount = money('amount')
    let sku = cell('sku') ? textLite(ctx, cell('sku')!) : null
    const extra: Record<string, FieldCandidateLite> = {}
    const putExtra = (key: string, value: FieldCandidateLite): void => {
      let k = key
      for (let i = 2; extra[k]; i++) k = `${key} (${i})`
      extra[k] = value
    }
    // "quantity × price" in the row's own description cell or on a detail line under it.
    let multiplied: Multiplied | null = null
    const takeQxP = (ref: TextRef, q: QxPParse): void => {
      const qty = numberLite(ctx, ref, q.qty.start, q.qty.end, 'decimal')
      const price = numberLite(ctx, ref, q.price.start, q.price.end, 'money')
      if (qty && price && !multiplied) multiplied = { qty, price }
    }
    // The description: its own cell plus the text rows attached to it, top to bottom.
    const pieces: TextRef[] = []
    const own = cell('description')
    const qxp = own ? parseQxP(own.text) : null
    const inName = own && !qxp && !quantity && !unitPrice ? embeddedQxP(own.text) : null
    if (own && qxp) {
      takeQxP(own, qxp)
    } else if (own && inName) {
      // "במבה 80 גרם 2 x 5.90": the name, then the quantity and price in the same cell.
      quantity = numberLite(ctx, own, inName.qty.start, inName.qty.end, 'decimal')
      unitPrice = numberLite(ctx, own, inName.price.start, inName.price.end, 'money')
      const nameWords = wordsOfSpan(ctx, own, inName.rest.start, inName.rest.end)
      pieces.push(nameWords.length ? evidenceOf(ctx.index, nameWords) : own)
    } else if (own) pieces.push(own)
    const ownScript = own && !qxp ? scriptOf(own.text) : null
    for (const k of extraLines.get(ri) ?? []) {
      const t = table.rows[k]
      t.cells.forEach(markUsed)
      // Figures and codes on a detail line: "2 × 6.62" and the barcode under a till receipt's line.
      const consumed = new Set<TextRef>()
      for (const c of t.cells) {
        const kind = c ? cellKind(c.text, ctx.numberFormat) : null
        const q = c && kind === 'qxp' ? parseQxP(c.text) : null
        if (q && !multiplied) {
          takeQxP(c!, q)
          consumed.add(c!)
        } else if (c && kind === 'code' && !sku) {
          sku = textLite(ctx, c)
          consumed.add(c)
        }
      }
      const text = textOf(k)
      if (!text || consumed.has(text)) continue
      const detail = detailOf(text.text, ownScript, descHeader, translated)
      if (!detail) {
        pieces.push(text)
        continue
      }
      const words = wordsOfSpan(ctx, text, detail.start, text.text.length)
      const value = textLite(ctx, words.length ? evidenceOf(ctx.index, words) : text)
      if (detail.key === 'sku' && !sku) sku = value
      else putExtra(detail.key === 'sku' ? detail.label : detail.key, value)
    }
    pieces.sort((a, b) => a.page - b.page || a.bbox.y0 - b.bbox.y0)
    const description: FieldCandidateLite | null = pieces.length
      ? { rawValue: pieces.map((p) => p.text).join(' '), normalized: { kind: 'text', value: pieces.map((p) => p.text).join(' ') }, evidence: pieces.map((p) => evidenceOf(ctx.index, p.wordIds)) }
      : null
    if (multiplied) {
      const m: Multiplied = multiplied
      // A figure that equals quantity × price is the line's amount, whatever its column's title
      // says ("כמות x מחיר = סה"כ" titles one column for all three).
      const product = productOf(m.qty, m.price)
      if (product && quantity && !sameNumber(quantity, valueOf(m.qty)) && sameNumber(quantity, product)) {
        amount ??= moneyLite(ctx, quantity.evidence[0], headerCurrency[col('quantity')])
        quantity = null
      }
      quantity ??= m.qty
      unitPrice ??= m.price
    }
    roles.forEach((role, j) => {
      const c = row.cells[j]
      if (!c || (role && role !== 'line_number' && role !== 'unit')) return
      const key = table.columns[j].header?.text ?? `col${j}`
      extra[extra[key] ? `${key} (${j})` : key] = textLite(ctx, c)
    })
    const taxCell = cell('tax_rate')
    const discCell = cell('discount')
    return {
      index: n,
      // The row's words in reading order (right to left on a Hebrew page).
      row: evidenceOf(ctx.index, (rtl ? [...row.cells].reverse() : row.cells).flatMap((c) => c?.wordIds ?? [])),
      description,
      quantity,
      unitPrice,
      amount,
      taxRate: taxCell ? percentLite(ctx, taxCell) : null,
      discount: discCell ? (percentLite(ctx, discCell) ?? moneyLite(ctx, discCell, headerCurrency[col('discount')])) : null,
      sku,
      extra,
    }
  })
}

interface Multiplied {
  qty: FieldCandidateLite
  price: FieldCandidateLite
}

function valueOf(f: FieldCandidateLite): Dec | null {
  const n = f.normalized
  if (n.kind === 'money') return dec(n.amount)
  if (n.kind === 'decimal') return dec(n.value)
  return null
}

const sameNumber = (f: FieldCandidateLite, v: Dec | null): boolean => {
  const a = valueOf(f)
  return !!a && !!v && eq(a, v)
}

function productOf(q: FieldCandidateLite, p: FieldCandidateLite): Dec | null {
  const a = valueOf(q)
  const b = valueOf(p)
  return a && b ? round(mul(a, b), 2) : null
}

function currencyOfText(text: string): string | null {
  const codes = [...new Set(findCurrencies(text).map((c) => c.code))]
  return codes.length === 1 ? codes[0] : null
}

function evidence(ctx: DocContext, ref: TextRef): Evidence[] {
  return [evidenceOf(ctx.index, ref.wordIds)]
}

function textLite(ctx: DocContext, ref: TextRef): FieldCandidateLite {
  return { rawValue: ref.text, normalized: { kind: 'text', value: ref.text }, evidence: evidence(ctx, ref) }
}

function moneyLite(ctx: DocContext, ref: TextRef, headerCurrency: string | null): FieldCandidateLite | null {
  const a = parseAmount(ref.text, ctx.numberFormat)
  if (a) return { rawValue: a.raw, normalized: { kind: 'money', amount: a.amount, currency: a.currency ?? headerCurrency }, evidence: evidence(ctx, ref) }
  // A scan's stray letters next to the amount: only the words of the amount are evidence.
  const loose = looseAmount(ref.text, ctx.numberFormat)
  const words = loose ? wordsOfSpan(ctx, ref, loose.start, loose.end) : []
  if (!loose || !words.length) return null
  return { rawValue: loose.raw, normalized: { kind: 'money', amount: loose.amount, currency: loose.currency ?? headerCurrency }, evidence: [evidenceOf(ctx.index, words)] }
}

function quantityLite(ctx: DocContext, ref: TextRef): FieldCandidateLite | null {
  const q = parseQuantity(ref.text, ctx.numberFormat)
  if (q) return { rawValue: q.raw, normalized: { kind: 'decimal', value: q.value }, evidence: evidence(ctx, ref) }
  const a = parseAmount(ref.text, ctx.numberFormat)
  return a && !a.currency ? { rawValue: a.raw, normalized: { kind: 'decimal', value: a.amount }, evidence: evidence(ctx, ref) } : null
}

function percentLite(ctx: DocContext, ref: TextRef): FieldCandidateLite | null {
  const p = parsePercent(ref.text)
  return p ? { rawValue: p.raw, normalized: { kind: 'percent', value: p.value }, evidence: evidence(ctx, ref) } : null
}

/** A number inside a cell ("2" of "2 x 9.90"), with only the words that print it as evidence. */
function numberLite(ctx: DocContext, ref: TextRef, start: number, end: number, kind: 'money' | 'decimal'): FieldCandidateLite | null {
  const raw = ref.text.slice(start, end)
  const words = wordsOfSpan(ctx, ref, start, end)
  if (!words.length) return null
  const ev = evidenceOf(ctx.index, words)
  if (kind === 'money') {
    const a = parseAmount(raw, ctx.numberFormat)
    return a ? { rawValue: a.raw, normalized: { kind: 'money', amount: a.amount, currency: a.currency }, evidence: [ev] } : null
  }
  const q = parseQuantity(raw, ctx.numberFormat)
  return q ? { rawValue: q.raw, normalized: { kind: 'decimal', value: q.value }, evidence: [ev] } : null
}

function wordsOfSpan(ctx: DocContext, ref: TextRef, start: number, end: number): string[] {
  let pos = 0
  const out: string[] = []
  for (const id of ref.wordIds) {
    const w = ctx.index.word.get(id)!
    const s = pos
    const e = pos + w.text.length
    if (e > start && s < end) out.push(id)
    pos = e + 1
  }
  return out
}
