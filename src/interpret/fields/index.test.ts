import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CanonicalField, DocumentModel, FieldCandidate } from '../../model/types'
import { readDocument } from '../../read'
import { analyzeStructure } from '../../structure'
import { buildDoc } from '../../structure/keyValues/testing'
import { buildContext } from '../context'
import { interpretLineItems } from '../lineItems'
import { interpretFields } from './index'

function run(doc: DocumentModel) {
  const structure = analyzeStructure(doc)
  const ctx = buildContext(doc)
  return interpretFields(ctx, structure, interpretLineItems(ctx, structure))
}

function values(cands: FieldCandidate[], field: CanonicalField): string[] {
  return cands
    .filter((c) => c.field === field)
    .sort((a, b) => b.score - a.score)
    .map((c) => {
      const n = c.normalized
      return n.kind === 'money' ? n.amount : n.kind === 'date' ? n.iso : n.kind === 'percent' ? n.value : n.kind === 'currency' ? n.code : n.kind === 'document_type' ? n.value : n.value
    })
}

/** A classic Israeli layout: letterhead right, meta left, title, לכבוד block, totals grid. */
const HEBREW = buildDoc([
  { text: 'דקל', x0: 532, x1: 559, y: 36, size: 21, bold: true, block: 'b1' },
  { text: 'חומרי בניין דקל בע"מ', x0: 480, x1: 559, y: 62, size: 11, block: 'b1' },
  { text: "רח' הברזל 6", x0: 520, x1: 559, y: 79, block: 'b1' },
  { text: 'ראשון לציון', x0: 522, x1: 559, y: 91, block: 'b1' },
  { text: "טל': 08-0000104 | דוא\"ל: sales@dekel-pro.example", x0: 313, x1: 559, y: 103, block: 'b1' },
  { text: "מס' חברה: 510000037", x0: 484, x1: 559, y: 115, block: 'b1' },
  { text: 'תאריך: 16/02/2025', x0: 143, x1: 214, y: 35, block: 'b2' },
  { text: 'תנאי תשלום: שוטף + 30', x0: 131, x1: 214, y: 48, block: 'b2' },
  { text: "חשבונית מס מס' 7683", x0: 203, x1: 392, y: 146, size: 17, bold: true },
  { text: 'לכבוד', x0: 539, x1: 559, y: 174, block: 'b4' },
  { text: 'א.ב. ייעוץ עסקי בע"מ', x0: 480, x1: 559, y: 187, block: 'b4' },
  { text: 'סה"כ לפני מע"מ:', x0: 173, x1: 229, y: 457, block: 'b5' },
  { text: 'מע"מ (18%):', x0: 181, x1: 229, y: 474, block: 'b5' },
  { text: 'סה"כ לתשלום:', x0: 182, x1: 229, y: 494, block: 'b5' },
  { text: '₪ 4,958.77', x0: 42, x1: 87, y: 457, block: 'b6' },
  { text: '₪ 892.58', x0: 42, x1: 79, y: 474, block: 'b6' },
  { text: '₪ 5,851.35', x0: 42, x1: 93, y: 494, block: 'b6' },
])

describe('interpretFields on a hand-built Hebrew invoice', () => {
  const out = run(HEBREW)
  const c = out.candidates

  it('reads the title, its number and the labelled meta data', () => {
    expect(values(c, 'document_type')[0]).toBe('tax_invoice')
    expect(values(c, 'invoice_number')[0]).toBe('7683')
    expect(values(c, 'invoice_date')[0]).toBe('2025-02-16')
    expect(values(c, 'payment_terms')[0]).toBe('שוטף + 30')
  })

  it('reads the totals with honest signals', () => {
    expect(values(c, 'subtotal')[0]).toBe('4958.77')
    expect(values(c, 'tax_amount')[0]).toBe('892.58')
    expect(values(c, 'tax_rate')[0]).toBe('18')
    expect(values(c, 'total')).toContain('5851.35')
    expect(values(c, 'amount_due')).toContain('5851.35')
    const total = c.find((x) => x.field === 'total')!
    expect(total.signals).toContain('label:exact')
    expect(values(c, 'currency')[0]).toBe('ILS')
  })

  it('assigns the letterhead to the supplier and the לכבוד block to the customer', () => {
    expect(values(c, 'supplier.name')[0]).toBe('חומרי בניין דקל בע"מ')
    expect(values(c, 'supplier.tax_id')[0]).toBe('510000037')
    expect(values(c, 'supplier.phone')[0]).toBe('080000104')
    expect(values(c, 'supplier.email')[0]).toBe('sales@dekel-pro.example')
    expect(values(c, 'supplier.address')[0]).toBe("רח' הברזל 6, ראשון לציון")
    expect(values(c, 'customer.name')[0]).toBe('א.ב. ייעוץ עסקי בע"מ')
    expect(c.find((x) => x.field === 'customer.name')!.signals).toContain('role:customer')
  })

  it('points every candidate at words of the document', () => {
    const ids = new Set(HEBREW.words.map((w) => w.id))
    for (const x of c) {
      expect(x.evidence.length).toBeGreaterThan(0)
      for (const e of x.evidence) for (const id of e.wordIds) expect(ids.has(id)).toBe(true)
    }
  })

  it('lists every labelled value in discovered', () => {
    expect(out.discovered.some((d) => d.originalLabel === 'תאריך' && d.field === 'invoice_date')).toBe(true)
    expect(out.discovered.every((d) => d.status === 'proposed')).toBe(true)
  })
})

describe('interpretFields: traps and roles', () => {
  it('does not read a customer number or a paid invoice reference as the invoice number', () => {
    const doc = buildDoc([
      { text: 'קבלה', x0: 277, x1: 318, y: 116, size: 17 },
      { text: "קבלה מס': 704696", x0: 50, x1: 158, y: 35, size: 11 },
      { text: 'מספר לקוח: 4051135', x0: 50, x1: 158, y: 50, size: 11 },
      { text: "תשלום עבור חשבונית מס': 16802", x0: 363, x1: 559, y: 196, size: 11 },
    ])
    expect(values(run(doc).candidates, 'invoice_number')).toEqual(['704696'])
  })

  it('reads "from" as the payer on a receipt under the issuer letterhead', () => {
    const doc = buildDoc([
      { text: 'טופז הפצת מזון בע"מ', x0: 470, x1: 559, y: 56, size: 10, block: 'h' },
      { text: 'ת.ד. 9871, יקנעם עילית', x0: 491, x1: 559, y: 70, block: 'h' },
      { text: 'טלפון: 073-0000105', x0: 400, x1: 559, y: 82, block: 'h' },
      { text: 'ח.פ.: 510000086', x0: 506, x1: 559, y: 94, block: 'h' },
      { text: 'קבלה', x0: 216, x1: 379, y: 120, size: 16 },
      { text: 'מאת: ברוש שילוח בינלאומי (2008) בע"מ', x0: 418, x1: 559, y: 150, size: 10 },
    ])
    const c = run(doc).candidates
    expect(values(c, 'supplier.name')[0]).toBe('טופז הפצת מזון בע"מ')
    expect(values(c, 'customer.name')[0]).toBe('ברוש שילוח בינלאומי (2008) בע"מ')
  })
})

describe('interpretFields: side-by-side party boxes', () => {
  it('keeps each tax id with the party whose column it is in', () => {
    const doc = buildDoc([
      { text: 'פרטי העסק', x0: 504, x1: 552, y: 69, size: 10, bold: true },
      { text: 'שם העסק', x0: 516, x1: 552, y: 89 },
      { text: 'רימון מוסך ושירותי רכב (1995) בע"מ', x0: 348, x1: 479, y: 89 },
      { text: "עוסק מורשה מס'", x0: 491, x1: 552, y: 108 },
      { text: '51000009-4', x0: 432, x1: 479, y: 108 },
      { text: 'לכבוד', x0: 260, x1: 286, y: 69, size: 10, bold: true },
      { text: 'שם', x0: 274, x1: 286, y: 89 },
      { text: 'מגן מוצרי נייר ומשרד בע"מ', x0: 117, x1: 213, y: 89 },
      { text: "עוסק מורשה מס'", x0: 225, x1: 286, y: 108 },
      { text: '51-000001-1', x0: 162, x1: 213, y: 108 },
    ])
    const c = run(doc).candidates
    expect(values(c, 'supplier.tax_id')).toEqual(['51000009-4'.replace(/-/g, '')])
    expect(values(c, 'customer.tax_id')).toEqual(['510000011'])
    expect(values(c, 'supplier.name')[0]).toBe('רימון מוסך ושירותי רכב (1995) בע"מ')
    expect(values(c, 'customer.name')[0]).toBe('מגן מוצרי נייר ומשרד בע"מ')
  })
})

describe('interpretFields: US documents', () => {
  it('reads numeric dates month-first when the addresses are American', () => {
    const doc = buildDoc([
      { text: 'Harbor Bakery LLC', x0: 44, x1: 180, y: 45, size: 15, bold: true, block: 'h' },
      { text: '9084 Market Street', x0: 44, x1: 120, y: 65, block: 'h' },
      { text: 'Portland, OR 97229', x0: 44, x1: 123, y: 77, block: 'h' },
      { text: 'Phone: 217-555-0111', x0: 44, x1: 131, y: 89, block: 'h' },
      { text: 'INVOICE', x0: 466, x1: 568, y: 46, size: 22, bold: true },
      { text: 'Invoice Date', x0: 449, x1: 509, y: 155 },
      { text: '03/10/2026', x0: 521, x1: 569, y: 155 },
    ])
    const d = run(doc).candidates.find((x) => x.field === 'invoice_date')!
    expect(d.normalized).toEqual({ kind: 'date', iso: '2026-03-10', alternatives: ['2026-10-03'] })
  })
})

// The generated corpus is private (its invoices look too real to publish), so this test runs only
// where eval/corpus exists, and takes its expectations from the document's truth file.
const CORPUS_PDF = new URL('../../../eval/corpus/he-classic/he-classic-001.pdf', import.meta.url)
const CORPUS_TRUTH = new URL('../../../eval/corpus/he-classic/he-classic-001.truth.json', import.meta.url)

describe.skipIf(!existsSync(CORPUS_PDF))('interpretFields on a corpus PDF', () => {
  it('reads he-classic-001 end to end', async () => {
    const truth = JSON.parse(readFileSync(CORPUS_TRUTH, 'utf8')) as { fields: Record<string, string> }
    const doc = await readDocument(new Uint8Array(readFileSync(CORPUS_PDF)), { fileName: 'he-classic-001.pdf' })
    const c = run(doc).candidates
    for (const f of ['document_type', 'invoice_number', 'po_number', 'supplier.tax_id', 'customer.name'] as const) expect(values(c, f)[0]).toBe(truth.fields[f])
    expect(values(c, 'total')).toContain(truth.fields.total)
  })
})
