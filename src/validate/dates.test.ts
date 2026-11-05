import { describe, expect, it } from 'vitest'
import { resolve } from './index'
import { conventionOf, isoOf, numericDate } from './dates'
import { check, invoice, issueCodes, wrongVerified } from './testing'

describe('date parsing helpers', () => {
  it('reads day/month numbers and the convention they prove', () => {
    expect(numericDate('25/04/2026')).toEqual({ a: 25, b: 4, year: 2026 })
    expect(numericDate('3.4.26')).toEqual({ a: 3, b: 4, year: 2026 })
    expect(numericDate('2026-04-03')).toBeNull()
    expect(conventionOf(numericDate('25/04/2026')!)).toBe('dmy')
    expect(conventionOf(numericDate('04/25/2026')!)).toBe('mdy')
    expect(conventionOf(numericDate('03/04/2026')!)).toBe('ambiguous')
    expect(conventionOf(numericDate('04/04/2026')!)).toBe('same')
    expect(isoOf(numericDate('31/02/2026')!, 'dmy')).toBeNull()
  })
})

describe('dates', () => {
  it('verifies an unambiguous date under a strong label', () => {
    const out = resolve(invoice().date('invoice_date', '25/04/2026', { label: 'תאריך הפקה:', score: 0.85 }).build())
    expect(out.fields.invoice_date).toMatchObject({ status: 'verified', normalized: { kind: 'date', iso: '2026-04-25', alternatives: [] } })
    expect(out.fields.invoice_date!.checks).toEqual(['unique-label:invoice_date'])
  })

  it('never verifies an ambiguous 03/04/2026 when nothing settles it', () => {
    const out = resolve(invoice().date('invoice_date', '03/04/2026', { label: 'תאריך:', score: 0.9 }).build())
    const f = out.fields.invoice_date!
    expect(f.status).toBe('proposed')
    expect(f.normalized).toEqual({ kind: 'date', iso: '2026-04-03', alternatives: ['2026-03-04'] })
    expect(issueCodes(out)).toContain('date.ambiguous')
    expect(wrongVerified(out, { invoice_date: '2026-04-03' })).toEqual([])
  })

  it('treats 03/04/2026 as ambiguous even when the parser dropped the alternative', () => {
    const out = resolve(invoice().date('invoice_date', '03/04/2026', { alternatives: [], score: 0.9 }).build())
    expect(out.fields.invoice_date!.status).toBe('proposed')
  })

  it('settles 03/04/2026 as 3 April when a due date 25/04/2026 shows the day-first order', () => {
    const b = invoice().date('invoice_date', '03/04/2026', { label: 'תאריך:', score: 0.9 }).date('due_date', '25/04/2026', { label: 'לתשלום עד:', score: 0.85 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date).toMatchObject({ status: 'verified', normalized: { iso: '2026-04-03', alternatives: [] } })
    expect(check(out, 'date:day-month-order:invoice_date')).toMatchObject({ status: 'pass', expected: '2026-04-03', actual: '03/04/2026' })
    expect(check(out, 'date:invoice_date<=due_date')?.status).toBe('pass')
    expect(issueCodes(out)).not.toContain('date.ambiguous')
  })

  it('settles it from a date printed elsewhere on the page (not a candidate)', () => {
    const b = invoice().textLine('הודפס בתאריך 25/04/2026 10:31').date('invoice_date', '03/04/2026', { score: 0.9 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date).toMatchObject({ status: 'verified', normalized: { iso: '2026-04-03' } })
  })

  it('settles it month-first when the document prints US dates (04/25/2026)', () => {
    const b = invoice().date('invoice_date', '03/04/2026', { label: 'Date:', score: 0.9 }).date('due_date', '04/25/2026', { label: 'Due date:', iso: '2026-04-25', score: 0.85 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date).toMatchObject({ status: 'verified', normalized: { iso: '2026-03-04' } })
  })

  it('does not settle anything when the page mixes day-first and month-first dates', () => {
    const b = invoice().textLine('25/04/2026').textLine('04/26/2026').date('invoice_date', '03/04/2026', { score: 0.9 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date!.status).toBe('proposed')
    expect(issueCodes(out)).toEqual(expect.arrayContaining(['date.ambiguous', 'date.conflicting_conventions']))
  })

  it('settles by order when the only other date is written with a month name', () => {
    // Due "20 March 2026": only 4 March keeps invoice ≤ due.
    const b = invoice().date('invoice_date', '03/04/2026', { score: 0.9 }).date('due_date', '20 March 2026', { iso: '2026-03-20', alternatives: [], score: 0.85 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date).toMatchObject({ status: 'verified', normalized: { iso: '2026-03-04' } })
    expect(check(out, 'date:order-disambiguation:invoice_date')?.status).toBe('pass')
  })

  it('marks an invoice date after the due date for review', () => {
    const b = invoice().date('invoice_date', '25/05/2026', { score: 0.9 }).date('due_date', '15/04/2026', { score: 0.85 })
    const out = resolve(b.build())
    expect(check(out, 'date:invoice_date<=due_date')?.status).toBe('fail')
    expect(out.fields.invoice_date!.status).toBe('needs_review')
    expect(out.fields.due_date!.status).toBe('needs_review')
    expect(issueCodes(out)).toContain('date.order')
  })

  it('marks two different strong invoice dates as needs_review', () => {
    const b = invoice().date('invoice_date', '25/04/2026', { label: 'תאריך:', score: 0.8 }).date('invoice_date', '26/04/2026', { label: 'תאריך הדפסה:', score: 0.75 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date!.status).toBe('needs_review')
    expect(out.fields.invoice_date!.alternatives[0]!.rawValue).toBe('26/04/2026')
  })

  it('treats the same date printed twice as corroboration', () => {
    const b = invoice().date('invoice_date', '25/04/2026', { score: 0.85 }).date('invoice_date', '2026-04-25', { label: 'Date:', score: 0.6 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date!.status).toBe('verified')
  })

  it('does not reuse the invoice date as the delivery date', () => {
    const b = invoice().date('invoice_date', '25/04/2026', { id: 'inv', score: 0.85 }).date('delivery_date', '25/04/2026', { shareWith: 'inv', score: 0.4 })
    const out = resolve(b.build())
    expect(out.fields.invoice_date!.status).toBe('verified')
    expect(out.fields.delivery_date).toBeUndefined()
    expect(issueCodes(out)).toContain('role.yielded')
  })

  it('does not verify an OCR-read date with low confidence', () => {
    const out = resolve(invoice().date('invoice_date', '25/04/2026', { conf: 0.7, score: 0.85 }).build())
    expect(out.fields.invoice_date!.status).toBe('proposed')
  })

  it('does not verify a date found without a label', () => {
    const out = resolve(invoice().date('invoice_date', '25/04/2026', { label: null, method: 'pattern:free-text', score: 0.6 }).build())
    expect(out.fields.invoice_date!.status).toBe('proposed')
  })
})
