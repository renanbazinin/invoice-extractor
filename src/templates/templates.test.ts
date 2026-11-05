import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ExtractionResult } from '../model/types'
import { extract } from '../pipeline'
import {
  BUILTIN_EXPORT,
  BUILTIN_SUPPLIER,
  applySupplierTemplate,
  boxAround,
  buildTable,
  crc32,
  exportFile,
  formatDate,
  matchSupplierTemplate,
  normalizeFor,
  sameValue,
  toCsv,
  toJson,
  wordsInBox,
  type ExportTemplate,
  type SupplierTemplate,
} from './index'

const sample = (name: string) => new Uint8Array(readFileSync(new URL(`../../web/samples/${name}`, import.meta.url)))
const byId = <T extends { id: string }>(list: T[], id: string) => list.find((t) => t.id === id)!

describe('template values', () => {
  it('reads text as the value of a field', () => {
    expect(normalizeFor('total', '₪1,392.40')).toEqual({ kind: 'money', amount: '1392.40', currency: 'ILS' })
    expect(normalizeFor('total', '1,392.40', { currency: 'ILS' })).toMatchObject({ amount: '1392.40', currency: 'ILS' })
    expect(normalizeFor('invoice_date', '05/11/2026')).toMatchObject({ iso: '2026-11-05' })
    expect(normalizeFor('invoice_date', '05/11/2026', { monthFirst: true })).toMatchObject({ iso: '2026-05-11' })
    expect(normalizeFor('supplier.tax_id', 'ח.פ. 51-555555-5')).toMatchObject({ kind: 'id', value: '515555555', checksum: true })
    expect(normalizeFor('tax_rate', '18%')).toEqual({ kind: 'percent', value: '18' })
    expect(normalizeFor('currency', 'ILS')).toEqual({ kind: 'currency', code: 'ILS' })
    expect(normalizeFor('total', 'abc')).toBeNull()
    expect(normalizeFor('supplier.name', '  מוסך   הדמו ')).toEqual({ kind: 'text', value: 'מוסך הדמו' })
  })

  it('compares and formats values', () => {
    expect(sameValue({ kind: 'money', amount: '10.0', currency: null }, { kind: 'money', amount: '10.00', currency: 'ILS' })).toBe(true)
    expect(sameValue({ kind: 'id', value: '12-345-6', scheme: null, checksum: null }, { kind: 'id', value: '123456', scheme: null, checksum: null })).toBe(true)
    expect(sameValue({ kind: 'text', value: 'סטודיו הדמו בע"מ' }, { kind: 'text', value: 'סטודיו הדמו' })).toBe(false)
    expect(formatDate('2026-11-05', 'dd/mm/yyyy')).toBe('05/11/2026')
    expect(formatDate('2026-11-05', 'mm/dd/yyyy')).toBe('11/05/2026')
  })
})

describe('supplier templates', () => {
  let studio: ExtractionResult
  let garage: ExtractionResult
  beforeAll(async () => {
    studio = await extract(sample('hebrew-tax-invoice.pdf'), { fileName: 'hebrew-tax-invoice.pdf' })
    garage = await extract(sample('hebrew-scan.png'), { fileName: 'hebrew-scan.png' })
  })

  it('matches a template by a tax id printed anywhere, before a name', () => {
    expect(matchSupplierTemplate(studio, BUILTIN_SUPPLIER)?.template.id).toBe('builtin:demo-studio')
    expect(matchSupplierTemplate(studio, BUILTIN_SUPPLIER)?.matchedBy).toBe('tax_id')
    expect(matchSupplierTemplate(garage, BUILTIN_SUPPLIER)?.template.id).toBe('builtin:demo-garage')
    const byName: SupplierTemplate = { ...byId(BUILTIN_SUPPLIER, 'builtin:demo-studio'), id: 'x', match: { taxIds: ['999999998'], names: ['סטודיו הדמו'] } }
    expect(matchSupplierTemplate(studio, [byName])?.matchedBy).toBe('name')
    expect(matchSupplierTemplate(studio, [{ ...byName, match: { taxIds: [], names: [] } }])).toBeNull()
  })

  it('fills a field from the supplier\'s own label, and never verifies it', () => {
    const t = byId(BUILTIN_SUPPLIER, 'builtin:demo-garage')
    const applied = applySupplierTemplate(garage, t, 'tax_id')
    expect(garage.fields.po_number).toBeUndefined()
    expect(applied.fields.po_number).toMatchObject({ rawValue: '12-345-67', status: 'proposed', method: 'template:label' })
    expect(applied.fields.po_number!.evidence[0]!.wordIds.length).toBeGreaterThan(0)
    expect(applied.notes.find((n) => n.field === 'po_number')?.outcome).toBe('filled')
    expect(Object.values(applied.fields).filter((f) => f!.method.startsWith('template:')).every((f) => f!.status !== 'verified')).toBe(true)
  })

  it('keeps the extractor\'s value when the template agrees, and flags a contradiction of a verified value', () => {
    const t = byId(BUILTIN_SUPPLIER, 'builtin:demo-studio')
    const same = applySupplierTemplate(studio, t, 'tax_id')
    expect(same.fields['supplier.bank_account']).toBe(studio.fields['supplier.bank_account'])
    expect(same.notes.every((n) => n.outcome === 'same')).toBe(true)
    const other = applySupplierTemplate(studio, { ...t, fixed: { 'supplier.bank_account': '12-345-999999' } }, 'manual')
    expect(studio.fields['supplier.bank_account']?.status).toBe('verified')
    expect(other.fields['supplier.bank_account']).toMatchObject({ rawValue: '12-345-999999', status: 'needs_review' })
    expect(other.fields['supplier.bank_account']!.alternatives[0]!.rawValue).toBe(studio.fields['supplier.bank_account']!.rawValue)
  })

  it('reads a field from a box taught on the page', () => {
    const num = studio.fields.invoice_number!
    const taught = boxAround(studio.document, num.evidence.flatMap((e) => e.wordIds))!
    expect(wordsInBox(studio.document, taught.page, taught.box)).toEqual(num.evidence.flatMap((e) => e.wordIds))
    const t: SupplierTemplate = { ...byId(BUILTIN_SUPPLIER, 'builtin:demo-studio'), fixed: {}, regions: [{ field: 'po_number', ...taught }] }
    const applied = applySupplierTemplate(studio, t, 'manual')
    expect(applied.fields.po_number).toMatchObject({ rawValue: '1001', status: 'needs_review', method: 'template:region' })
  })
})

describe('export templates', () => {
  let docs: { name: string; result: ExtractionResult }[]
  beforeAll(async () => {
    docs = [
      { name: 'studio.pdf', result: await extract(sample('hebrew-tax-invoice.pdf')) },
      { name: 'english.pdf', result: await extract(sample('english-invoice.pdf')) },
    ]
  })

  it('makes one row per invoice or one per line item', () => {
    const summary = byId(BUILTIN_EXPORT, 'builtin:summary-csv')
    const t = buildTable(summary, docs)
    expect(t.headers[0]).toBe('File')
    expect(t.rows).toHaveLength(2)
    const col = (h: string) => t.headers.indexOf(h)
    expect(t.rows[0]![col('Number')]!.text).toBe('1001')
    expect(t.rows[0]![col('Date')]!.text).toBe('18/11/2026')
    expect(t.rows[0]![col('Total')]).toMatchObject({ text: '6985.60', number: 6985.6, status: 'verified' })
    const lines = buildTable(byId(BUILTIN_EXPORT, 'builtin:lines-xlsx'), docs)
    expect(lines.rows).toHaveLength(docs.reduce((s, d) => s + d.result.lineItems.length, 0))
    expect(lines.rows[0]![lines.headers.indexOf('Invoice number')]!.text).toBe('1001')
  })

  it('leaves unverified values empty or adds status columns when asked', () => {
    const base = byId(BUILTIN_EXPORT, 'builtin:summary-csv')
    const blank: ExportTemplate = { ...base, options: { ...base.options, unverified: 'blank', statusColumns: true } }
    const t = buildTable(blank, docs)
    const i = t.headers.indexOf('Supplier')
    expect(t.headers[i + 1]).toBe('Supplier (status)')
    for (const row of t.rows) if (row[i + 1]!.text !== 'verified') expect(row[i]!.text).toBe('')
  })

  it('writes CSV with a BOM, the chosen delimiter and decimal comma', () => {
    const base = byId(BUILTIN_EXPORT, 'builtin:summary-csv')
    const t: ExportTemplate = { ...base, options: { ...base.options, delimiter: ';', decimal: ',' } }
    const csv = toCsv(buildTable(t, docs), t.options)
    expect(csv.startsWith('﻿File;Document type;')).toBe(true)
    expect(csv).toContain(';6985,60;')
    const json = JSON.parse(toJson(buildTable(byId(BUILTIN_EXPORT, 'builtin:fields-json'), docs)))
    expect(json[0]).toMatchObject({ file: 'studio.pdf', invoice_number: '1001', total: 6985.6, invoice_date: '2026-11-18' })
  })

  it('writes a valid .xlsx (a zip whose entries check out)', () => {
    const file = exportFile(byId(BUILTIN_EXPORT, 'builtin:summary-he-xlsx'), docs)
    expect(file.name).toMatch(/\.xlsx$/)
    const entries = unzip(file.data as Uint8Array)
    expect(Object.keys(entries)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'])
    const sheet = entries['xl/worksheets/sheet1.xml']!
    expect(sheet).toContain('rightToLeft="1"')
    expect(sheet).toContain('<t xml:space="preserve">סטודיו הדמו בע&quot;מ</t>')
    expect(sheet).toContain('<v>6985.6</v>')
  })
})

/** Reads a stored (uncompressed) zip and checks every entry's CRC. */
function unzip(data: Uint8Array): Record<string, string> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: Record<string, string> = {}
  let at = 0
  while (dv.getUint32(at, true) === 0x04034b50) {
    const crc = dv.getUint32(at + 14, true)
    const size = dv.getUint32(at + 18, true)
    const nameLen = dv.getUint16(at + 26, true)
    const name = new TextDecoder().decode(data.subarray(at + 30, at + 30 + nameLen))
    const body = data.subarray(at + 30 + nameLen, at + 30 + nameLen + size)
    expect(crc32(body), name).toBe(crc)
    out[name] = new TextDecoder().decode(body)
    at += 30 + nameLen + size
  }
  expect(dv.getUint32(at, true)).toBe(0x02014b50)
  return out
}
