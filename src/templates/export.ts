/**
 * Export templates: documents → a table (one row per document or per line item) → CSV, JSON or
 * Excel. The table keeps each value's status, so unverified values can be left empty, given a
 * status column, or coloured in Excel.
 */
import type { CanonicalField, ExtractedField, ExtractionResult, FieldStatus, LineItem } from '../model/types'
import { foldForMatch } from '../lib/text'
import type { AppliedTemplate } from './supplier'
import type { Column, ColumnSource, ExportOptions, ExportTemplate, LineProp } from './types'
import { plainValue } from './values'
import { buildXlsx, type SheetCell } from './xlsx'

export interface ExportDoc {
  name: string
  result: ExtractionResult
  /** The supplier template applied to it, whose values replace the extractor's. */
  applied?: AppliedTemplate | null
}

export interface Cell {
  text: string
  number?: number
  /** ISO date, for spreadsheets. */
  date?: string
  status?: FieldStatus
}

export interface Table {
  headers: string[]
  rows: Cell[][]
}

const EMPTY: Cell = { text: '' }

function fieldCell(f: ExtractedField | null | undefined, part: NonNullable<Extract<ColumnSource, { type: 'field' }>['part']>, o: ExportOptions): Cell {
  if (!f) return EMPTY
  if (part === 'status') return { text: f.status }
  if (part === 'confidence') return { text: f.confidence.toFixed(2), number: Math.round(f.confidence * 100) / 100 }
  if (o.unverified === 'blank' && f.status !== 'verified') return { text: '', status: f.status }
  if (part === 'raw') return { text: f.rawValue, status: f.status }
  const v = f.normalized
  const text = plainValue(v, f.rawValue, o)
  if (v?.kind === 'money') return { text, number: Number(v.amount), status: f.status }
  if (v?.kind === 'percent' || v?.kind === 'decimal') return { text, number: Number(v.value), status: f.status }
  if (v?.kind === 'date') return { text, date: v.iso, status: f.status }
  return { text, status: f.status }
}

const LINE_FIELD: Record<Exclude<LineProp, 'index'>, keyof LineItem> = {
  description: 'description',
  quantity: 'quantity',
  unitPrice: 'unitPrice',
  amount: 'amount',
  taxRate: 'taxRate',
  discount: 'discount',
  sku: 'sku',
}

function lineCell(li: LineItem, prop: LineProp, o: ExportOptions): Cell {
  if (prop === 'index') return { text: String(li.index + 1), number: li.index + 1 }
  const c = fieldCell(li[LINE_FIELD[prop]] as ExtractedField | null, 'value', o)
  return c.status ? c : { ...c, status: li.status }
}

function cellOf(src: ColumnSource, doc: ExportDoc, li: LineItem | null, o: ExportOptions): Cell {
  const r = doc.result
  const fields = doc.applied?.fields ?? r.fields
  switch (src.type) {
    case 'field':
      return fieldCell(fields[src.field], src.part ?? 'value', o)
    case 'line': {
      if (li) return lineCell(li, src.prop, o)
      // A line column in a per-document export: every line's value, joined.
      const parts = r.lineItems.map((x) => lineCell(x, src.prop, o).text).filter(Boolean)
      return { text: parts.join('; ') }
    }
    case 'meta':
      switch (src.prop) {
        case 'fileName':
          return { text: doc.name }
        case 'pageCount':
          return { text: String(r.document.meta.pageCount), number: r.document.meta.pageCount }
        case 'status':
          return { text: r.summary.status }
        case 'confidence':
          return { text: r.summary.confidence.toFixed(2), number: Math.round(r.summary.confidence * 100) / 100 }
        case 'textLayer':
          return { text: r.document.meta.textLayer }
        case 'supplierTemplate':
          return { text: doc.applied?.template.name ?? '' }
        case 'lineCount':
          return { text: String(r.lineItems.length), number: r.lineItems.length }
      }
      return EMPTY
    case 'constant':
      return { text: src.value }
    case 'other': {
      const want = foldForMatch(src.label).trim()
      const d = r.discovered.find((x) => x.originalLabel && foldForMatch(x.originalLabel).trim() === want)
      return d ? { text: d.rawValue, status: d.status } : EMPTY
    }
  }
}

/** The template's columns, with a status column after each value column when asked. */
export function expandColumns(t: ExportTemplate): Column[] {
  if (!t.options.statusColumns) return t.columns
  return t.columns.flatMap((c) => {
    const s = c.source
    const valued = (s.type === 'field' && (s.part ?? 'value') !== 'status' && s.part !== 'confidence') || (s.type === 'line' && s.prop !== 'index')
    if (!valued) return [c]
    const status: ColumnSource = s.type === 'field' ? { type: 'field', field: s.field, part: 'status' } : { type: 'meta', prop: 'status' }
    return [c, { header: `${c.header} (status)`, source: status }]
  })
}

export function buildTable(t: ExportTemplate, docs: readonly ExportDoc[]): Table {
  const cols = expandColumns(t)
  const rows: Cell[][] = []
  for (const doc of docs) {
    const lines = t.rows === 'line' && doc.result.lineItems.length ? doc.result.lineItems : [null]
    for (const li of lines) rows.push(cols.map((c) => cellOf(c.source, doc, t.rows === 'line' ? li : null, t.options)))
  }
  return { headers: cols.map((c) => c.header), rows }
}

export function toCsv(table: Table, o: ExportOptions): string {
  const q = (s: string) => (s.includes(o.delimiter) || /["\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s)
  return '﻿' + [table.headers, ...table.rows.map((r) => r.map((c) => c.text))].map((r) => r.map(q).join(o.delimiter)).join('\r\n') + '\r\n'
}

export function toJson(table: Table): string {
  const keys: string[] = []
  for (const h of table.headers) {
    let k = h || 'column'
    for (let n = 2; keys.includes(k); n++) k = `${h} ${n}`
    keys.push(k)
  }
  const data = table.rows.map((r) => Object.fromEntries(r.map((c, i) => [keys[i], c.number ?? (c.text === '' ? null : c.text)])))
  return JSON.stringify(data, null, 2)
}

const XLSX_DATE: Record<ExportOptions['dateFormat'], string> = { iso: 'yyyy-mm-dd', 'dd/mm/yyyy': 'dd/mm/yyyy', 'mm/dd/yyyy': 'mm/dd/yyyy' }

export function toXlsx(table: Table, t: ExportTemplate): Uint8Array {
  const mark = (s: FieldStatus | undefined): SheetCell['mark'] => (!t.options.highlight || !s || s === 'verified' ? 0 : s === 'proposed' ? 1 : 2)
  return buildXlsx({
    name: t.name,
    headers: table.headers,
    rows: table.rows.map((r) => r.map((c) => ({ text: c.text, number: c.text === '' ? undefined : c.number, date: c.text === '' ? undefined : c.date, mark: mark(c.status) }))),
    dateFormat: XLSX_DATE[t.options.dateFormat],
    rightToLeft: table.headers.some((h) => /[א-ת]/.test(h)),
  })
}

export interface ExportFile {
  name: string
  mime: string
  data: string | Uint8Array
}

/** Renders documents through an export template into a file. */
export function exportFile(t: ExportTemplate, docs: readonly ExportDoc[], baseName = 'invoices'): ExportFile {
  const table = buildTable(t, docs)
  const slug = t.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'export'
  if (t.format === 'xlsx') return { name: `${baseName}-${slug}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: toXlsx(table, t) }
  if (t.format === 'json') return { name: `${baseName}-${slug}.json`, mime: 'application/json', data: toJson(table) }
  return { name: `${baseName}-${slug}.csv`, mime: 'text/csv;charset=utf-8', data: toCsv(table, t.options) }
}

/** The fields a column list reads, for the editor's "used" markers. */
export function fieldsUsed(t: ExportTemplate): Set<CanonicalField> {
  return new Set(t.columns.flatMap((c) => (c.source.type === 'field' ? [c.source.field] : [])))
}
