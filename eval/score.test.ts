import { describe, expect, it } from 'vitest'
import type { CanonicalField, DocumentModel, ExtractedField, ExtractionResult, FieldStatus, GroundTruth, LineItem, NormalizedValue } from '../src/model/types'
import { aggregate, badness, looseNumber, normalizeId, normalizePhone, normalizeText, scoreDocument, scoreLineItems, tokenSimilarity, valueMatches } from './score'

// ---------------------------------------------------------------------------------------------
// Builders for hand-made results

const BOX = { x0: 0, y0: 0, x1: 10, y1: 10 }

function ef(rawValue: string, normalized: NormalizedValue | null, status: FieldStatus = 'proposed', extra: Partial<ExtractedField> = {}): ExtractedField {
  return {
    field: null,
    originalLabel: null,
    labelEvidence: null,
    rawValue,
    normalized,
    evidence: [{ page: 1, wordIds: ['p1w1'], text: rawValue, bbox: BOX }],
    confidence: 0.9,
    status,
    method: 'test',
    checks: [],
    alternatives: [],
    ...extra,
  }
}

const money = (amount: string): NormalizedValue => ({ kind: 'money', amount, currency: 'ILS' })
const text = (value: string): NormalizedValue => ({ kind: 'text', value })
const id = (value: string): NormalizedValue => ({ kind: 'id', value, scheme: null, checksum: null })
const date = (iso: string): NormalizedValue => ({ kind: 'date', iso, alternatives: [] })

function line(description: string, amount: string, quantity?: string, unitPrice?: string): LineItem {
  return {
    index: 0,
    row: { page: 1, wordIds: [], text: description, bbox: BOX },
    description: ef(description, text(description)),
    quantity: quantity ? ef(quantity, { kind: 'decimal', value: quantity }) : null,
    unitPrice: unitPrice ? ef(unitPrice, money(unitPrice)) : null,
    amount: ef(amount, money(amount)),
    taxRate: null,
    discount: null,
    sku: null,
    extra: {},
    status: 'proposed',
  }
}

const EMPTY_DOC: DocumentModel = {
  pages: [],
  words: [],
  lines: [],
  blocks: [],
  meta: { fileName: null, mimeType: 'application/pdf', pageCount: 1, textLayer: 'embedded', scripts: ['hebrew'], producer: null, warnings: [] },
}

function result(fields: Partial<Record<CanonicalField, ExtractedField>>, more: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    schemaVersion: 1,
    document: EMPTY_DOC,
    structure: { keyValues: [], tables: [] },
    fields,
    lineItems: [],
    discovered: [],
    unclassifiedLineIds: [],
    derived: [],
    checks: [],
    issues: [],
    summary: { status: 'proposed', confidence: 0.5, missing: [] },
    ...more,
  }
}

function truth(fields: Partial<Record<CanonicalField, string>>, more: Partial<GroundTruth> = {}): GroundTruth {
  return { id: 't1', file: 't1.pdf', languages: ['he'], notes: '', fields, absent: [], lineItems: [], extra: [], ...more }
}

const outcome = (s: ReturnType<typeof scoreDocument>, f: CanonicalField): string => s.fields.find((x) => x.field === f)!.outcome

// ---------------------------------------------------------------------------------------------

describe('normalisation helpers', () => {
  it('folds ids, text and phones as the architecture rules say', () => {
    expect(normalizeId('51-234567-8')).toBe('512345678')
    expect(normalizeId('IL62 0108 0000 0009 9999 999')).toBe('il620108000000099999999')
    expect(normalizeId('2026/0412')).toBe(normalizeId('2026-0412'))
    expect(normalizeText('גלבוע מערכות בע״מ')).toBe(normalizeText('גלבוע  מערכות בע"מ'))
    expect(normalizePhone('+972-3-5123456')).toBe('035123456')
    expect(normalizePhone('972 54 123 4567')).toBe('0541234567')
    expect(normalizePhone('(03) 512-3456')).toBe('035123456')
  })

  it('measures token-set similarity (Dice) after folding', () => {
    expect(tokenSimilarity("רח' הברזל 32, תל אביב 6971044", 'הברזל 32 תל אביב 6971044')).toBeCloseTo(10 / 11)
    expect(tokenSimilarity('a b c', 'x y z')).toBe(0)
  })

  it('parses printed numbers loosely for extras', () => {
    expect(looseNumber('1,234.50')).toBe('1234.50')
    expect(looseNumber('1.234,50 €')).toBe('1234.50')
    expect(looseNumber('₪ 245.30')).toBe('245.30')
    expect(looseNumber('1,234')).toBe('1234')
    expect(looseNumber('12-345-67')).toBeNull()
    expect(looseNumber('abc')).toBeNull()
  })
})

describe('field matching', () => {
  it('compares money and percents numerically on the normalized value', () => {
    expect(valueMatches('total', '1180.00', ef('1,180.00 ₪', money('1180')))).toBe(true)
    expect(valueMatches('tax_rate', '18', ef('18%', { kind: 'percent', value: '18.00' }))).toBe(true)
    // A raw value alone is not enough for money: normalizing is the extractor's job.
    expect(valueMatches('total', '1180.00', ef('1180.00', null))).toBe(false)
    expect(valueMatches('total', '1180.00', ef('1,180.01', money('1180.01')))).toBe(false)
  })

  it('compares dates by ISO and currencies by code', () => {
    expect(valueMatches('invoice_date', '2026-10-31', ef('31/10/26', date('2026-10-31')))).toBe(true)
    expect(valueMatches('invoice_date', '2026-10-31', ef('31/10/26', date('2026-31-10')))).toBe(false)
    expect(valueMatches('currency', 'ILS', ef('₪', { kind: 'currency', code: 'ILS' }))).toBe(true)
  })

  it('compares ids without separators and names after folding', () => {
    expect(valueMatches('supplier.tax_id', '512345678', ef('51-234567-8', id('51-234567-8')))).toBe(true)
    expect(valueMatches('invoice_number', 'INV-2026-0042', ef('inv 2026/0042', id('inv 2026/0042')))).toBe(true)
    expect(valueMatches('supplier.name', 'גלבוע מערכות מידע בע"מ', ef('גלבוע מערכות מידע בע״מ', text('גלבוע מערכות מידע בע״מ')))).toBe(true)
    expect(valueMatches('supplier.name', 'גלבוע מערכות מידע בע"מ', ef('גלבוע מערכות', text('גלבוע מערכות')))).toBe(false)
    expect(valueMatches('payment_terms', 'שוטף + 30', ef('שוטף+30', text('שוטף+30')))).toBe(true)
  })

  it('accepts addresses at token similarity >= 0.8 only', () => {
    const want = "רח' הברזל 32, תל אביב 6971044"
    expect(valueMatches('supplier.address', want, ef('הברזל 32 תל אביב', text('הברזל 32 תל אביב')))).toBe(true) // 8/10
    expect(valueMatches('supplier.address', want, ef('הברזל 32', text('הברזל 32')))).toBe(false) // 4/8
    expect(valueMatches('supplier.address', want, ef('רח\' העמל 32, תל אביב 6971044', text('רח\' העמל 32, תל אביב 6971044')))).toBe(true) // 10/12 ≈ 0.83
    expect(valueMatches('supplier.address', want, ef('רח\' העמל 7, חיפה 3100000', text('רח\' העמל 7, חיפה 3100000')))).toBe(false)
  })

  it('normalises phones: 972 equals a leading 0, punctuation is ignored', () => {
    expect(valueMatches('supplier.phone', '03-5123456', ef('+972-3-512-3456', text('+972-3-512-3456')))).toBe(true)
    expect(valueMatches('supplier.phone', '054-1234567', ef('0541234567', text('0541234567')))).toBe(true)
    expect(valueMatches('supplier.phone', '03-5123456', ef('03-5123457', text('03-5123457')))).toBe(false)
  })
})

describe('scoreDocument', () => {
  const t = truth(
    { document_type: 'tax_invoice', invoice_number: '12345', total: '1180.00', tax_amount: '180.00', 'supplier.phone': '03-5123456' },
    { absent: ['due_date', 'amount_paid', 'po_number'] },
  )

  it('classifies correct, wrong, missed, hallucinated and unscored fields', () => {
    const r = result({
      document_type: ef('חשבונית מס', { kind: 'document_type', value: 'tax_invoice' }, 'verified'),
      invoice_number: ef('12345', id('12345'), 'verified'),
      total: ef('1,108.00', money('1108.00'), 'proposed'),
      due_date: ef('30/11/2026', date('2026-11-30'), 'needs_review'),
      delivery_date: ef('01/10/2026', date('2026-10-01')),
    })
    const s = scoreDocument(r, t)
    expect(outcome(s, 'document_type')).toBe('correct')
    expect(outcome(s, 'invoice_number')).toBe('correct')
    expect(outcome(s, 'total')).toBe('wrong')
    expect(outcome(s, 'tax_amount')).toBe('missed')
    expect(outcome(s, 'supplier.phone')).toBe('missed')
    expect(outcome(s, 'due_date')).toBe('hallucinated')
    expect(outcome(s, 'amount_paid')).toBe('absent_ok')
    expect(outcome(s, 'delivery_date')).toBe('unscored')
    expect(s.counts).toMatchObject({ truth: 5, found: 3, correct: 2, wrong: 1, missed: 2, verified: 2, verifiedCorrect: 2, verifiedWrong: 0, absent: 3, hallucinated: 1, hallucinatedVerified: 0 })
    expect(s.error).toBeNull()
  })

  it('counts verified-but-wrong values and verified hallucinations', () => {
    const r = result({
      total: ef('1,108.00', money('1108.00'), 'verified'),
      po_number: ef('4500123456', id('4500123456'), 'verified'),
    })
    const s = scoreDocument(r, t)
    expect(s.counts.verifiedWrong).toBe(1)
    expect(s.counts.hallucinatedVerified).toBe(1)
    const agg = aggregate([s])
    expect(agg.total.verifiedPrecision).toBe(0)
    expect(agg.fields.find((f) => f.field === 'total')!.verifiedWrong).toBe(1)
    expect(badness(s)).toBeGreaterThan(40)
  })

  it('notices when the right value was only an alternative', () => {
    const wrong = ef('1,108.00', money('1108.00'), 'needs_review', { alternatives: [{ rawValue: '1,180.00', normalized: money('1180.00'), evidence: [], confidence: 0.4 }] })
    const s = scoreDocument(result({ total: wrong }), t)
    expect(s.fields.find((f) => f.field === 'total')!.inAlternatives).toBe(true)
  })

  it('scores a crash as every truth field missed and no hallucination', () => {
    const s = scoreDocument(null, t, new Error('readDocument: not implemented yet'))
    expect(s.error).toBe('readDocument: not implemented yet')
    expect(s.counts).toMatchObject({ truth: 5, found: 0, missed: 5, hallucinated: 0 })
    expect(s.lineItems.matched).toBe(0)
  })
})

describe('line items', () => {
  const lines: GroundTruth['lineItems'] = [
    { description: 'טונר HP 85A שחור', quantity: '2', unitPrice: '250.00', amount: '500.00' },
    { description: 'נייר צילום A4 80 גרם (500 דף)', quantity: '10', unitPrice: '22.90', amount: '229.00' },
    { description: 'שעות ייעוץ טכני', amount: '1200.00' },
  ]

  it('matches by order and content, tolerating a missing row', () => {
    const got = [line('טונר HP 85A שחור', '500', '2', '250'), line('שעות ייעוץ טכני', '1200.00')]
    const s = scoreLineItems(lines, got)
    expect(s.matched).toBe(2)
    expect(s.matches.map((m) => m.got)).toEqual([0, null, 1])
  })

  it('accepts descriptions by token similarity and checks qty/unit price when the truth has them', () => {
    const got = [
      line('טונר HP 85A שחור מקורי', '500.00', '2', '250.00'), // 5 of 6 tokens shared: 2*5/(5+6)=0.91
      line('נייר צילום A4 80 גרם (500 דף)', '229.00', '1', '229.00'), // wrong qty
      line('שעות ייעוץ', '1200.00', '1', '1200.00'), // 2*2/(3+2)=0.8, no qty in truth
    ]
    const s = scoreLineItems(lines, got)
    expect(s.matches.map((m) => m.full)).toEqual([true, false, true])
    expect(s.matches[1]).toMatchObject({ got: 1, description: true, amount: true, quantity: false, unitPrice: false })
    expect(s.matched).toBe(2)
  })

  it('does not credit an extra row and keeps alignment after it', () => {
    const got = [line('דמי משלוח', '30.00'), line('טונר HP 85A שחור', '500', '2', '250'), line('נייר צילום A4 80 גרם (500 דף)', '229', '10', '22.90'), line('שעות ייעוץ טכני', '1200')]
    const s = scoreLineItems(lines, got)
    expect(s.matched).toBe(3)
    expect(s.matches.map((m) => m.got)).toEqual([1, 2, 3])
  })
})

describe('extras', () => {
  const t = truth({}, { extra: [{ label: "מס' לקוח", value: '10234' }, { label: 'יתרה קודמת', value: '1,234.50 ₪' }, { label: 'מספר רכב', value: '12-345-67' }, { label: 'Project code', value: 'PRJ-1234' }] })

  it('finds discovered values by label (equal or containing) and value (raw or normalized)', () => {
    const r = result(
      {},
      {
        discovered: [
          ef('10234', id('10234'), 'proposed', { originalLabel: "מס' לקוח:" }),
          ef('₪1,234.50', money('1234.5'), 'proposed', { originalLabel: 'יתרה קודמת לתשלום' }),
          ef('1234567', text('1234567'), 'proposed', { originalLabel: 'מספר רכב' }),
          ef('1234', id('1234'), 'proposed', { originalLabel: 'Project code' }),
        ],
      },
    )
    const s = scoreDocument(r, t)
    expect(s.extras.details.map((d) => d.found)).toEqual([true, true, true, false])
    expect(s.extras.details[3].labelOnly).toBe(true)
    expect(s.extras.found).toBe(3)
  })

  it('does not match a label that is only part of the truth label', () => {
    const r = result({}, { discovered: [ef('10234', id('10234'), 'proposed', { originalLabel: 'לקוח' })] })
    expect(scoreDocument(r, t).extras.details[0].found).toBe(false)
  })
})

describe('aggregate', () => {
  it('computes accuracy, verified precision and auto rate per field and in total', () => {
    const t = truth({ total: '100.00', invoice_number: 'A1' }, { absent: ['discount'] })
    const good = scoreDocument(result({ total: ef('100', money('100'), 'verified'), invoice_number: ef('A1', id('A1'), 'proposed') }), t)
    const bad = scoreDocument(result({ total: ef('90', money('90'), 'verified'), discount: ef('10', money('10'), 'proposed') }), t)
    const crash = scoreDocument(null, t, 'boom')
    const agg = aggregate([good, bad, crash])
    const total = agg.fields.find((f) => f.field === 'total')!
    expect(total).toMatchObject({ n: 3, found: 2, correct: 1, wrong: 1, missed: 1, verified: 2, verifiedCorrect: 1, verifiedWrong: 1 })
    expect(total.accuracy).toBeCloseTo(1 / 3)
    expect(total.verifiedPrecision).toBe(0.5)
    expect(total.autoRate).toBeCloseTo(1 / 3)
    expect(agg.fields.find((f) => f.field === 'discount')).toMatchObject({ absentN: 3, hallucinated: 1 })
    expect(agg.errors).toBe(1)
    expect(agg.perfectDocuments).toBe(1)
    expect(agg.total.n).toBe(6)
  })
})
