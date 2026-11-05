import type { DocIndex } from '../../lib/docIndex'
import type { DocumentType, KeyValue, Line, Structure, TextRef } from '../../model/types'
import type { DocContext } from '../context'
import type { LineItemInterpretation } from '../lineItems'
import { senseOf, type LabelSense } from './sense'

/** A key/value with its meaning and the lines it occupies. */
export interface Pair {
  id: string
  label: TextRef
  value: TextRef
  layout: KeyValue['layout'] | 'table'
  score: number
  sense: LabelSense
  /** Page of the label. */
  page: number
  labelLineIds: string[]
  valueLineIds: string[]
}

/** Everything the field interpreters share for one document. */
export interface FieldsContext {
  ctx: DocContext
  index: DocIndex
  structure: Structure
  items: LineItemInterpretation
  pairs: Pair[]
  /** Lines of item-table bodies (not label/value text). */
  itemLineIds: Set<string>
  /** Lines of payment tables: the payer's bank details and cheque dates live there. */
  paymentLineIds: Set<string>
  /** The document type read from the title, once known (receipts change what a payment total is). */
  docType: DocumentType | null
  /** Day/month order for numeric dates (see dateOrderOf). */
  dateOrder: 'DMY' | 'MDY'
}

/** A US state and ZIP code ("Tampa, FL 33692", "Portland, OR 97229-1234"). */
const US_ADDRESS = /(?:^|[\s,])(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s\d{5}(?:-\d{4})?(?![\d])/

/**
 * Numeric dates follow the order the document's own dates prove (25/04 is day-first). With no
 * proof, an English-only document addressed with US state and ZIP codes is month-first, as US
 * invoices are; everything else is day-first.
 */
export function dateOrderOf(ctx: DocContext): 'DMY' | 'MDY' {
  if (ctx.dateOrderConfidence > 0 || ctx.hebrew) return ctx.dateOrder
  const us = ctx.index.doc.lines.filter((l) => US_ADDRESS.test(l.text)).length
  return us >= 1 ? 'MDY' : ctx.dateOrder
}

function linesOf(index: DocIndex, ref: TextRef): string[] {
  return [...new Set(ref.wordIds.map((id) => index.word.get(id)?.lineId).filter((x): x is string => !!x))]
}

export function pairOf(index: DocIndex, kv: { id: string; label: TextRef; value: TextRef; layout: Pair['layout']; score: number }): Pair {
  return {
    id: kv.id,
    label: kv.label,
    value: kv.value,
    layout: kv.layout,
    score: kv.score,
    sense: senseOf(kv.label.text),
    page: kv.label.page,
    labelLineIds: linesOf(index, kv.label),
    valueLineIds: linesOf(index, kv.value),
  }
}

/**
 * Key/values from tables that are not item tables, in case the tables layer claimed a meta strip
 * or a totals grid: a header cell and the cell under it, for one-row tables only (a payments or
 * tax table with several rows is a list, not a key/value).
 */
function tablePairs(index: DocIndex, structure: Structure): Pair[] {
  const out: Pair[] = []
  for (const t of structure.tables) {
    if (t.role === 'items' || t.role === 'payments') continue
    const body = t.rows.filter((r) => r.kind === 'item' || r.kind === 'summary')
    if (body.length !== 1) continue
    const row = body[0]!
    t.columns.forEach((col, i) => {
      const cell = row.cells[i]
      if (!col.header || !cell) return
      out.push(pairOf(index, { id: `${t.id}:c${i}`, label: col.header, value: cell, layout: 'table', score: 0.7 }))
    })
  }
  return out
}

export function buildFieldsContext(ctx: DocContext, structure: Structure, items: LineItemInterpretation): FieldsContext {
  const index = ctx.index
  const pairs = structure.keyValues.map((kv) => pairOf(index, kv))
  const known = new Set(pairs.flatMap((p) => [...p.labelLineIds, ...p.valueLineIds]))
  for (const p of tablePairs(index, structure)) {
    if (![...p.labelLineIds, ...p.valueLineIds].some((l) => known.has(l))) pairs.push(p)
  }
  const itemLineIds = new Set<string>()
  const paymentLineIds = new Set<string>()
  for (const t of structure.tables) {
    for (const r of t.rows) {
      // Body rows only: a header row may have absorbed the title above it, and summary rows are
      // totals (key/values).
      if (r.kind !== 'item' && r.kind !== 'continuation') continue
      for (const c of r.cells) {
        if (!c) continue
        for (const id of c.wordIds) {
          const lineId = index.word.get(id)?.lineId
          if (!lineId) continue
          if (t.role === 'items') itemLineIds.add(lineId)
          if (t.role === 'payments') paymentLineIds.add(lineId)
        }
      }
    }
  }
  return { ctx, index, structure, items, pairs, itemLineIds, paymentLineIds, docType: null, dateOrder: dateOrderOf(ctx) }
}

export function lineOf(fc: FieldsContext, id: string): Line | undefined {
  return fc.index.line.get(id)
}
