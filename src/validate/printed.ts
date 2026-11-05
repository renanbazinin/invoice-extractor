import type { CanonicalField, DocumentType, FieldCandidate, Line, LineItemCandidate, NormalizedValue } from '../model/types'
import { abs, cmp, dec, isDecimalString, isZero, type Dec } from '../lib/decimal'
import { foldForMatch } from '../lib/text'
import { findAmounts, matchLabels } from '../semantic'
import { CUES, OCR, PRIOR } from './policy'
import { foldCues, hasCue, type DocIndex } from './evidence'
import type { ValueGroup } from './groups'

/**
 * Facts printed on the page that change what the money fields mean, read by validation itself
 * because no candidate holds them (or because the candidates would mislead):
 *
 *  - adjustments between the total and the amount due: a previous balance carried into a utility
 *    bill (due = total + previous debt), a retention or a tax withheld at source (due = total −
 *    retention);
 *  - several VAT rates on one invoice (lines at 0% and 18%): tax_rate is then not a single rate;
 *  - a payment schedule on a quote or proforma: "מקדמה (30%)" is an advance to be paid, not a
 *    payment;
 *  - a page that prints no separate tax at all (exempt dealer, prices including VAT): the lines
 *    then sum to the total itself.
 */

// ---------------------------------------------------------------------------------------------
// Adjustments between total and amount due

export interface Adjustment {
  /** 'add': carried in (previous balance); 'sub': held back (retention, withholding). */
  sign: 'add' | 'sub'
  kind: 'previous_balance' | 'retention' | 'withholding'
  value: Dec
  label: string
  wordIds: string[]
}

const RETENTION = /עיכבון|עכבון|דמי עיכבון|retention|retainage|einbehalt|sicherheitseinbehalt|retenue de garantie|ritenuta a garanzia|retención de garantía/

function adjustmentKind(text: string): Adjustment['kind'] | null {
  const ms = matchLabels(text)
  if (ms.some((m) => m.concept === 'trap.previous_balance')) return 'previous_balance'
  if (RETENTION.test(foldForMatch(text))) return 'retention'
  // "פטור מניכוי במקור" (an exemption certificate) withholds nothing.
  if (ms.some((m) => m.concept === 'trap.tax_withholding') && !/פטור|exempt|befreit/.test(foldForMatch(text))) return 'withholding'
  return null
}

/** A money-shaped amount (two decimals, not a percentage) in a piece of text. */
function moneyIn(text: string): { value: Dec; start: number } | null {
  for (const a of findAmounts(text)) {
    if (a.decimals !== 2 || !isDecimalString(a.amount)) continue
    if (/^\s*%/.test(text.slice(a.end))) continue
    const v = abs(dec(a.amount))
    if (isZero(v)) continue
    return { value: v, start: a.start }
  }
  return null
}

/**
 * The amount of a label line: after the label on the same line, or alone in another line on the
 * same row (a totals box prints the label column and the value column apart). Null unless the row
 * holds exactly one amount.
 */
function amountOfRow(doc: DocIndex, line: Line): { value: Dec; wordIds: string[] } | null {
  const own = moneyIn(line.text)
  if (own) return { value: own.value, wordIds: [...line.wordIds] }
  const h = Math.max(4, line.bbox.y1 - line.bbox.y0)
  const mid = (line.bbox.y0 + line.bbox.y1) / 2
  const row = doc
    .pageLines(line.page)
    .filter((l) => l !== line && Math.abs((l.bbox.y0 + l.bbox.y1) / 2 - mid) <= 0.5 * Math.max(h, l.bbox.y1 - l.bbox.y0))
    .filter((l) => !/\p{L}{2,}/u.test(l.text.replace(/ש"ח|ש״ח|NIS|ILS|USD|EUR/g, '')))
    .map((l) => ({ l, m: moneyIn(l.text) }))
    .filter((x) => x.m !== null)
  if (row.length !== 1) return null
  return { value: row[0]!.m!.value, wordIds: [...row[0]!.l.wordIds] }
}

/** Adjustment rows: a previous balance, retention or withholding label with its amount (amountOfRow). */
export function printedAdjustments(doc: DocIndex): Adjustment[] {
  const out: Adjustment[] = []
  for (const line of doc.lines) {
    const kind = adjustmentKind(line.text)
    if (!kind) continue
    const found = amountOfRow(doc, line)
    if (!found) continue
    out.push({ sign: kind === 'previous_balance' ? 'add' : 'sub', kind, value: found.value, label: line.text, wordIds: found.wordIds })
  }
  // One printed figure, one adjustment.
  return out.filter((a, i) => out.findIndex((b) => b.kind === a.kind && cmp(b.value, a.value) === 0) === i)
}

// ---------------------------------------------------------------------------------------------
// Document discounts

/**
 * Discounts printed outside the item lines: a label naming a discount ("הנחה מסוכמת", "Less:
 * courtesy discount", "Volume commitment discount 8%") with its amount on the same line or row.
 * Read here because interpretation can miss them, and a missed discount lets the base after it
 * pass for the subtotal: "base + tax = total" closes exactly. Totals around the discount ("סה"כ
 * אחרי הנחה", "Taxable amount", "סה"כ לפני הנחה") are not discount rows; neither are item rows
 * (`itemWordIds`), whose discounts are already in the lines' sum.
 */
export function printedDiscounts(doc: DocIndex, itemWordIds: ReadonlySet<string>): Dec[] {
  const out: Dec[] = []
  for (const line of doc.lines) {
    if (!hasCue(line.text, CUES.discountRow)) continue
    if (hasCue(line.text, CUES.afterDiscount) || hasCue(line.text, CUES.beforeDiscount)) continue
    if (line.wordIds.some((id) => itemWordIds.has(id))) continue
    const found = moneyIn(line.text)?.value ?? amountBeside(doc, line, itemWordIds)
    if (found && !out.some((d) => cmp(d, found) === 0)) out.push(found)
  }
  return out
}

/**
 * The nearest amount-only line on the label's reading side of the same row: right of an LTR
 * label, left of an RTL one. Totals boxes often sit beside the item table, so the row also holds
 * item cells (`itemWordIds`), which are skipped. Only for facts that block verification: a wrong
 * pick here makes the output more cautious, never more confident.
 */
function amountBeside(doc: DocIndex, line: Line, itemWordIds: ReadonlySet<string>): Dec | null {
  const h = Math.max(4, line.bbox.y1 - line.bbox.y0)
  const mid = (line.bbox.y0 + line.bbox.y1) / 2
  const slack = 2
  let best: { gap: number; value: Dec } | null = null
  for (const l of doc.pageLines(line.page)) {
    if (l === line || l.wordIds.some((id) => itemWordIds.has(id))) continue
    if (Math.abs((l.bbox.y0 + l.bbox.y1) / 2 - mid) > 0.5 * Math.max(h, l.bbox.y1 - l.bbox.y0)) continue
    if (/\p{L}{2,}/u.test(l.text.replace(/ש"ח|ש״ח|NIS|ILS|USD|EUR/g, ''))) continue
    const gap = line.dir === 'rtl' ? line.bbox.x0 - l.bbox.x1 : l.bbox.x0 - line.bbox.x1
    if (gap < -slack) continue
    const m = moneyIn(l.text)
    if (m && (!best || gap < best.gap)) best = { gap, value: m.value }
  }
  return best?.value ?? null
}

// ---------------------------------------------------------------------------------------------
// Several VAT rates

function rateOf(n: NormalizedValue | undefined): string | null {
  if (!n || (n.kind !== 'percent' && n.kind !== 'decimal') || !isDecimalString(n.value)) return null
  return String(Number(n.value))
}

/**
 * Distinct VAT rates printed on the invoice: the rates in the lines' tax column, plus a strong
 * document-level rate that differs from them ("0%" on the freight lines, "מע"מ 18%" in the
 * summary); or two VAT lines, each with its own rate and amount ("MwSt 7% … MwSt 19% …"). Two or
 * more rates mean tax_rate is not a single rate (field definition).
 */
export function printedRates(lines: readonly LineItemCandidate[], groups: Map<CanonicalField, ValueGroup[]>): string[] {
  const rates = new Set<string>()
  for (const l of lines) {
    const r = rateOf(l.taxRate?.normalized)
    if (r !== null) rates.add(r)
  }
  const strong = (groups.get('tax_rate') ?? []).filter((g) => g.prior >= PRIOR.conflictMin)
  if (rates.size) {
    for (const g of strong) {
      const r = rateOf(g.rep.normalized)
      if (r !== null) rates.add(r)
    }
    return [...rates]
  }
  // Two VAT lines: two strong rates, each printed in the label of its own tax amount.
  const labelRates = new Set(
    (groups.get('tax_amount') ?? [])
      .filter((g) => g.prior >= PRIOR.conflictMin)
      .flatMap((g) => [...(g.rep.originalLabel ?? '').matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) => String(Number(m[1]!.replace(',', '.'))))),
  )
  const labelled = new Set(strong.map((g) => rateOf(g.rep.normalized)).filter((r): r is string => r !== null && labelRates.has(r)))
  return labelled.size >= 2 ? [...labelled] : [...rates]
}

// ---------------------------------------------------------------------------------------------
// Payment schedules

const PAID_WORDS = /שולם|ששולם|ששולמה|ששולמו|התקבל|נתקבל|paid|received|bezahlt|erhalten|payé|reçu|pagado|recibido|pagato|ricevuto|betaald|ontvangen/
const SCHEDULE_WORDS = /בחתימה|עם החתימה|עם ההזמנה|לוח תשלומים|upon signing|on signing|on order|due on|payable on|schedule|installment|instalment|milestone|bei auftragserteilung|à la commande|a la firma|alla firma|bij ondertekening/

/**
 * An "advance" label that describes a share of the price to be paid ("סכום המקדמה (30%)", "Deposit
 * due on signing") rather than a payment received.
 */
export function scheduleLabel(label: string | null): boolean {
  if (!label) return false
  const t = foldForMatch(label)
  if (PAID_WORDS.test(t)) return false
  return SCHEDULE_WORDS.test(t) || (/\d+\s*%/.test(t) && hasCue(label, CUES.payment))
}

/** Documents that ask for money in the future: nothing on them has been paid. */
export function requestOnly(docType: DocumentType | null): boolean {
  return docType === 'quote' || docType === 'proforma'
}

/** Groups of amount_paid that are schedule items, not payments (see scheduleLabel / requestOnly). */
export function schedulePayments(groups: readonly ValueGroup[], docType: DocumentType | null): ValueGroup[] {
  if (requestOnly(docType)) return [...groups]
  return groups.filter((g) => g.candidates.every((c: FieldCandidate) => scheduleLabel(c.originalLabel)))
}

// ---------------------------------------------------------------------------------------------
// No separate tax

const EXEMPT_OR_INCLUDED = /פטור|אינו גובה|ללא מע|כולל|כוללים|exempt|zero.rated|reverse charge|not applicable|non applicable|incl|included|inkl|enthalten|inclus|incluid|inclus|esente|vrijgesteld|verlegd|steuerfrei/

/**
 * The page prints no tax figure separately: no tax amount or rate candidate other than zero, and
 * every line that mentions tax says it is exempt or included ("עוסק פטור - אינו גובה מע"מ",
 * "סה"כ כולל מע"מ"). Only for embedded text: a garbled OCR tax line could hide the cue.
 */
export function noSeparateTax(doc: DocIndex, groups: Map<CanonicalField, ValueGroup[]>): boolean {
  const nonZero = (f: CanonicalField) =>
    (groups.get(f) ?? []).some((g) => {
      const n = g.rep.normalized
      const v = n.kind === 'money' ? n.amount : n.kind === 'percent' || n.kind === 'decimal' ? n.value : null
      return g.prior >= PRIOR.competitorMin && v !== null && isDecimalString(v) && !isZero(dec(v))
    })
  if (nonZero('tax_amount') || nonZero('tax_rate')) return false
  if (doc.lines.some((l) => l.wordIds.length && doc.minConfidence(l.wordIds) < OCR.digital)) return false
  const cues = foldCues(CUES.tax)
  return doc.foldedLines.every((t) => !cues.some((c) => t.includes(c)) || EXEMPT_OR_INCLUDED.test(t))
}
