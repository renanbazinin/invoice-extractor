import type {
  BBox,
  Block,
  CanonicalField,
  DocumentModel,
  DocumentType,
  Evidence,
  ExtractedField,
  FieldCandidate,
  FieldCandidateLite,
  Line,
  LineItemCandidate,
  NormalizedValue,
  Word,
} from '../model/types'
import { sameDecimal } from '../lib/decimal'
import { foldForMatch } from '../lib/text'
import type { ResolveInput, ResolveOutput } from './index'

/**
 * Test helpers: hand-made candidate sets with a consistent DocumentModel behind them, so tests
 * describe invoices the way the interpreter would hand them over ("סה"כ לתשלום 1,180.00 with
 * prior 0.8") without building PDFs. Every value gets its own words (unless `shareWith` reuses
 * another candidate's words, i.e. the same printed figure), on its own line and block (unless
 * `block` groups lines).
 */

export interface CandOpts {
  id?: string
  score?: number
  /** Printed label; creates label words on the same line. null = no label. */
  label?: string | null
  /** Printed value text (defaults to the value). */
  raw?: string
  method?: string
  signals?: string[]
  /** Money: explicit currency printed with the amount. */
  currency?: string | null
  /** Reuse another candidate's value (and label) words: one printed figure read as two fields. */
  shareWith?: string
  /** Put the line in this block (lines sharing a block are one visual region). */
  block?: string
  /** Word confidence; < 1 marks OCR text. */
  conf?: number
  /** Date overrides. */
  iso?: string
  alternatives?: string[]
  /** Id overrides. */
  scheme?: string | null
  checksum?: boolean | null
  /** Extra words printed on the value's line after it (makes the value a fragment of its line). */
  trailing?: string
}

export interface LineCells {
  description?: string
  quantity?: string
  unitPrice?: string
  amount?: string
  /** Line discount as a percent ("10") … */
  discountPercent?: string
  /** … or as an amount. */
  discountAmount?: string
  taxRate?: string
  sku?: string
  /** Reuse the unit price words for the amount (one printed figure in two columns). */
  amountSharesUnitPrice?: boolean
}

let seq = 0

export class InvoiceBuilder {
  private words: Word[] = []
  private lines: Line[] = []
  private blocks = new Map<string, Block>()
  private candidates: FieldCandidate[] = []
  private items: LineItemCandidate[] = []
  private y = 20
  private byId = new Map<string, FieldCandidate>()

  /** A money candidate. `amount` is the normalized decimal ("1180.00", "-100"). */
  money(field: CanonicalField, amount: string, o: CandOpts = {}): this {
    return this.add(field, o.raw ?? amount, { kind: 'money', amount, currency: o.currency ?? null }, o)
  }

  /** A tax-rate candidate (percent). */
  rate(value: string, o: CandOpts = {}): this {
    return this.add('tax_rate', o.raw ?? `${value}%`, { kind: 'percent', value }, o)
  }

  /**
   * A date candidate parsed the way an Israeli-first parser would: day-first, with the
   * month-first reading as an alternative when both numbers are ≤ 12.
   */
  date(field: CanonicalField, raw: string, o: CandOpts = {}): this {
    const parsed = parseDayFirst(raw)
    const iso = o.iso ?? parsed?.iso ?? raw
    const alternatives = o.alternatives ?? parsed?.alternatives ?? []
    return this.add(field, raw, { kind: 'date', iso, alternatives }, o)
  }

  id(field: CanonicalField, value: string, o: CandOpts = {}): this {
    const compact = value.replace(/[\s\-./]/g, '')
    return this.add(field, o.raw ?? value, { kind: 'id', value: compact, scheme: o.scheme ?? null, checksum: o.checksum ?? null }, o)
  }

  text(field: CanonicalField, value: string, o: CandOpts = {}): this {
    return this.add(field, o.raw ?? value, { kind: 'text', value }, o)
  }

  docType(value: DocumentType, o: CandOpts = {}): this {
    return this.add('document_type', o.raw ?? value, { kind: 'document_type', value }, { label: null, ...o })
  }

  currency(code: string, o: CandOpts = {}): this {
    return this.add('currency', o.raw ?? code, { kind: 'currency', code }, o)
  }

  /** A line of printed text that no candidate uses (e.g. another date elsewhere on the page). */
  textLine(text: string, o: { block?: string; conf?: number } = {}): this {
    this.makeLine(text.split(/\s+/), o.block, o.conf ?? 1)
    return this
  }

  /** A row of the main items table. */
  line(cells: LineCells, o: { conf?: number } = {}): this {
    const conf = o.conf ?? 1
    const lineWords: string[] = []
    const cell = (text: string | undefined, normalized: (t: string) => NormalizedValue): FieldCandidateLite | null => {
      if (text === undefined) return null
      const ws = text.split(/\s+/).map((t) => this.makeWord(t, conf))
      lineWords.push(...ws.map((w) => w.id))
      return { rawValue: text, normalized: normalized(text), evidence: [this.evidence(ws, text)] }
    }
    const money = (t: string): NormalizedValue => ({ kind: 'money', amount: t, currency: null })
    const decimal = (t: string): NormalizedValue => ({ kind: 'decimal', value: t })
    const text = (t: string): NormalizedValue => ({ kind: 'text', value: t })
    const description = cell(cells.description, text)
    const quantity = cell(cells.quantity, decimal)
    const unitPrice = cell(cells.unitPrice, money)
    const amount = cells.amountSharesUnitPrice && unitPrice ? { ...unitPrice } : cell(cells.amount, money)
    const discount =
      cells.discountPercent !== undefined
        ? cell(cells.discountPercent, (t) => ({ kind: 'percent', value: t }))
        : cell(cells.discountAmount, money)
    const taxRate = cell(cells.taxRate, (t) => ({ kind: 'percent', value: t }))
    const sku = cell(cells.sku, (t) => ({ kind: 'id', value: t, scheme: null, checksum: null }))
    const lineId = this.finishLine(lineWords, undefined)
    const ws = lineWords.map((id) => this.words.find((w) => w.id === id)!)
    const row = { page: 1, wordIds: lineWords, text: ws.map((w) => w.text).join(' '), bbox: this.lines.find((l) => l.id === lineId)!.bbox }
    this.items.push({ index: this.items.length, row, description, quantity, unitPrice, amount, taxRate, discount, sku, extra: {} })
    return this
  }

  /** The candidate with this id (to tweak it in a test). */
  candidate(id: string): FieldCandidate {
    return this.byId.get(id)!
  }

  build(): ResolveInput {
    const blocks = [...this.blocks.values()]
    const scripts = this.words.some((w) => /[א-ת]/.test(w.text)) ? ['hebrew', 'latin'] : ['latin']
    const document: DocumentModel = {
      pages: [{ number: 1, width: 595, height: 842, source: this.words.some((w) => w.source === 'ocr') ? 'ocr' : 'pdf', lineIds: this.lines.map((l) => l.id), blockIds: blocks.map((b) => b.id) }],
      words: [...this.words],
      lines: [...this.lines],
      blocks,
      meta: { fileName: null, mimeType: 'application/pdf', pageCount: 1, textLayer: 'embedded', scripts, producer: null, warnings: [] },
    }
    return { document, candidates: [...this.candidates], lineItems: [...this.items] }
  }

  // -------------------------------------------------------------------------------------------

  private add(field: CanonicalField, raw: string, normalized: NormalizedValue, o: CandOpts): this {
    const id = o.id ?? `c${++seq}`
    let evidence: Evidence[]
    let label: Evidence | null = null
    let originalLabel = o.label === undefined ? defaultLabel(field) : o.label
    const shared = o.shareWith ? this.byId.get(o.shareWith) : undefined
    if (o.shareWith && !shared) throw new Error(`shareWith: unknown candidate ${o.shareWith}`)
    if (shared) {
      evidence = shared.evidence
      label = o.label === undefined ? shared.label : null
      if (o.label === undefined) originalLabel = shared.originalLabel
    } else {
      const conf = o.conf ?? 1
      const labelWords = originalLabel ? originalLabel.split(/\s+/).map((t) => this.makeWord(t, 1)) : []
      const valueWords = raw.split(/\s+/).map((t) => this.makeWord(t, conf))
      const trailing = o.trailing ? o.trailing.split(/\s+/).map((t) => this.makeWord(t, conf)) : []
      this.finishLine([...labelWords, ...valueWords, ...trailing].map((w) => w.id), o.block)
      evidence = [this.evidence(valueWords, raw)]
      label = labelWords.length ? this.evidence(labelWords, originalLabel!) : null
    }
    const c: FieldCandidate = {
      id,
      field,
      rawValue: raw,
      normalized,
      evidence,
      label,
      originalLabel,
      score: o.score ?? 0.8,
      method: o.method ?? (originalLabel ? 'kv:inline' : 'header:top-block'),
      signals: o.signals ?? (originalLabel ? ['label:exact'] : []),
    }
    this.candidates.push(c)
    this.byId.set(id, c)
    return this
  }

  private makeWord(text: string, conf: number): Word {
    const n = this.words.length + 1
    const w: Word = {
      id: `p1w${n}`,
      page: 1,
      text,
      bbox: { x0: 20 + (n % 10) * 30, y0: this.y, x1: 48 + (n % 10) * 30, y1: this.y + 10 },
      dir: /[א-ת]/.test(text) ? 'rtl' : /[A-Za-z]/.test(text) ? 'ltr' : null,
      source: conf < 1 ? 'ocr' : 'pdf',
      confidence: conf,
      fontSize: 10,
      bold: false,
      lineId: '',
    }
    this.words.push(w)
    return w
  }

  private makeLine(tokens: string[], block: string | undefined, conf: number): string {
    const ws = tokens.map((t) => this.makeWord(t, conf))
    return this.finishLine(ws.map((w) => w.id), block)
  }

  private finishLine(wordIds: string[], blockKey: string | undefined): string {
    const id = `p1l${this.lines.length + 1}`
    const ws = wordIds.map((wid) => this.words.find((w) => w.id === wid)!)
    for (const w of ws) w.lineId = id
    const bbox: BBox = ws.length ? unionBox(ws.map((w) => w.bbox)) : { x0: 0, y0: this.y, x1: 0, y1: this.y }
    const blockId = blockKey ? `b-${blockKey}` : `b${this.lines.length + 1}`
    let block = this.blocks.get(blockId)
    if (!block) this.blocks.set(blockId, (block = { id: blockId, page: 1, lineIds: [], bbox }))
    block.lineIds.push(id)
    block.bbox = unionBox([block.bbox, bbox])
    const hebrew = ws.some((w) => w.dir === 'rtl')
    this.lines.push({ id, page: 1, wordIds, text: ws.map((w) => w.text).join(' '), bbox, dir: hebrew ? 'rtl' : 'ltr', blockId })
    this.y += 14
    return id
  }

  private evidence(ws: Word[], text: string): Evidence {
    return { page: 1, wordIds: ws.map((w) => w.id), text, bbox: unionBox(ws.map((w) => w.bbox)) }
  }
}

export function invoice(): InvoiceBuilder {
  return new InvoiceBuilder()
}

function unionBox(boxes: BBox[]): BBox {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  }
}

/** Hebrew labels an Israeli invoice prints, used when a test does not name one. */
function defaultLabel(field: CanonicalField): string | null {
  const labels: Partial<Record<CanonicalField, string>> = {
    invoice_number: 'חשבונית מס מס\'',
    invoice_date: 'תאריך:',
    due_date: 'לתשלום עד:',
    delivery_date: 'תאריך אספקה:',
    po_number: 'מספר הזמנה:',
    allocation_number: 'מספר הקצאה:',
    currency: 'מטבע:',
    subtotal: 'סה"כ לפני מע"מ',
    discount: 'הנחה',
    tax_rate: 'מע"מ',
    tax_amount: 'מע"מ',
    total: 'סה"כ כולל מע"מ',
    amount_paid: 'מקדמה',
    amount_due: 'יתרה לתשלום',
    rounding: 'עיגול אגורות',
    payment_terms: 'תנאי תשלום:',
    'supplier.tax_id': 'ח.פ.',
    'customer.tax_id': 'ח.פ. לקוח',
    'supplier.phone': 'טל\':',
    'supplier.email': 'דוא"ל:',
    'supplier.bank_account': 'חשבון בנק:',
    'supplier.address': 'כתובת:',
    'customer.address': 'כתובת:',
  }
  return labels[field] ?? null
}

/** "03/04/2026" → 2026-04-03 with the alternative 2026-03-04. ISO input passes through. */
export function parseDayFirst(raw: string): { iso: string; alternatives: string[] } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (iso) return { iso: raw, alternatives: [] }
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(raw)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  const fmt = (d: number, mo: number) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  if (a > 12) return { iso: fmt(a, b), alternatives: [] }
  if (b > 12) return { iso: fmt(b, a), alternatives: [] }
  return { iso: fmt(a, b), alternatives: a === b ? [] : [fmt(b, a)] }
}

// ---------------------------------------------------------------------------------------------
// Assertions

/** A field's value in comparable form. */
export function valueOf(f: ExtractedField | undefined): string | null {
  const n = f?.normalized
  if (!n) return null
  switch (n.kind) {
    case 'money':
      return n.amount
    case 'percent':
    case 'decimal':
      return n.value
    case 'date':
      return n.iso
    case 'currency':
      return n.code
    case 'document_type':
      return n.value
    case 'id':
      return n.value
    case 'text':
      return n.value
  }
}

function same(expected: string, actual: string): boolean {
  const num = /^-?\d+(\.\d+)?$/
  if (num.test(expected) && num.test(actual)) return sameDecimal(expected, actual)
  const fold = (s: string) => foldForMatch(s).replace(/[\s\-./]/g, '')
  return fold(expected) === fold(actual)
}

/**
 * Every verified field that is wrong: its value differs from the truth, or the truth says the
 * field is not on the document (`null`). Fields missing from `truth` are not judged.
 */
export function wrongVerified(out: ResolveOutput, truth: Partial<Record<CanonicalField, string | null>>): string[] {
  const bad: string[] = []
  for (const [field, f] of Object.entries(out.fields) as [CanonicalField, ExtractedField][]) {
    if (f.status !== 'verified' || !(field in truth)) continue
    const t = truth[field]
    const v = valueOf(f)
    if (t === null || t === undefined || v === null || !same(t, v)) bad.push(`${field}: verified ${v} but truth is ${t}`)
  }
  for (const item of out.lineItems) {
    for (const cell of [item.amount, item.quantity, item.unitPrice]) {
      if (cell?.status === 'verified' && cell.normalized === null) bad.push(`line ${item.index}: verified empty cell`)
    }
  }
  return bad
}

/** Status of each field, for compact assertions. */
export function statuses(out: ResolveOutput): Partial<Record<CanonicalField, string>> {
  const s: Partial<Record<CanonicalField, string>> = {}
  for (const [k, v] of Object.entries(out.fields)) s[k as CanonicalField] = v!.status
  return s
}

/** Values of each field, for compact assertions. */
export function values(out: ResolveOutput): Partial<Record<CanonicalField, string | null>> {
  const s: Partial<Record<CanonicalField, string | null>> = {}
  for (const [k, v] of Object.entries(out.fields)) s[k as CanonicalField] = valueOf(v)
  return s
}

export function issueCodes(out: ResolveOutput): string[] {
  return out.issues.map((i) => i.code)
}

export function check(out: ResolveOutput, id: string) {
  return out.checks.find((c) => c.id === id)
}
