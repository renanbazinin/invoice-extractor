import type { LabelMatch } from '../../semantic'
import { analyzeLabel, isPairingMatch } from './labels'
import { looksLikeTerms } from './terms'

/**
 * Inline pairs: "label value" in reading order inside one line, several per line when the line
 * is a run of segments ("טל': 08-0000104 | דוא"ל: a@b.co.il", "ח.פ / ע.מ 510000060 · טל' 03-…").
 * Works on the logical-order text only; the caller maps the character spans back to words.
 */

export interface Span {
  start: number
  end: number
}

export interface InlinePair {
  label: Span
  value: Span
  /** The label ends with a colon (the strongest inline cue). */
  colon: boolean
  /** The lexicon match that heads the label, if any. */
  head: LabelMatch | null
}

/** Heads that take a plain-text value without a colon ("לכבוד חברה בע"מ", "תנאי תשלום שוטף"). */
const TEXT_HEADS = (m: LabelMatch): boolean =>
  m.kind === 'role' || ['payment_terms', 'party.contact', 'other.period', 'customer.name', 'supplier.name', 'other.payment_method'].includes(m.concept)

/**
 * "ת.ד. 5834, חולון", "רחוב אחד העם 134": address words without a colon are part of the address,
 * not a label in front of it.
 */
function addressMarker(text: string, m: LabelMatch): boolean {
  if (m.concept !== 'party.address') return false
  const n = nextNonSpace(text, m.end, text.length)
  return text[n] !== ':' && text[n] !== '：'
}

const VALUE_WORDS = new Set(['payment_terms', 'other.payment_method'])
const TERMS_LABELS = new Set(['payment_terms', 'due_date', 'other.payment_method'])

/**
 * A payment-method phrase that names a means of payment ("מזומן", "bank transfer",
 * "Transferencia") rather than labelling one ("אמצעי תשלום", "Payment method", "Forma de pago").
 */
export function methodValue(m: LabelMatch): boolean {
  if (m.concept !== 'other.payment_method') return false
  return !/אמצעי|אופן|דרך|סוג|method|type|mode|paid by|forma|método|medio|metodo|mezzo|moyen|meio|zahlungs|betaal/i.test(m.text)
}

/** Hard separators between independent segments of a line. */
const SEGMENT_SEP = /\s[|·•]\s|\s[|·•]|[|·•]\s|\s;\s|\t/g

/** Segments of a line, as spans of the text. */
export function segmentsOf(text: string): Span[] {
  const out: Span[] = []
  let pos = 0
  for (const m of text.matchAll(SEGMENT_SEP)) {
    if (m.index > pos) out.push({ start: pos, end: m.index })
    pos = m.index + m[0].length
  }
  if (pos < text.length) out.push({ start: pos, end: text.length })
  return out.filter((s) => /[\p{L}\p{N}]/u.test(text.slice(s.start, s.end)))
}

/** Colons that end a label: not inside a time or a ratio ("18:23", "1:2"). */
export function labelColons(text: string, from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i < to; i++) {
    const ch = text[i]
    if (ch !== ':' && ch !== '：') continue
    const prev = text.slice(from, i).trimEnd().slice(-1)
    const next = text.slice(i + 1, to).trimStart().slice(0, 1)
    if (/\d/.test(prev) && /\d/.test(next)) continue
    if (!prev) continue
    out.push(i)
  }
  return out
}

/** Text with digits outside percentages/parentheses: values, not label words. */
function hasValueDigits(s: string): boolean {
  const stripped = s.replace(/\(?\s*[-+]?\d+(?:[.,]\d+)?\s*%\s*\)?/g, ' ').replace(/%\s*\d+(?:[.,]\d+)?/g, ' ')
  return /\d/.test(stripped)
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length
}

const SKIP = /[\s:：\-–—,.;|·•*]/

function skipFiller(text: string, pos: number, end: number): number {
  while (pos < end && SKIP.test(text[pos]!)) pos++
  return pos
}

/** Next non-space character index after `pos`. */
function nextNonSpace(text: string, pos: number, end: number): number {
  while (pos < end && /\s/.test(text[pos]!)) pos++
  return pos
}

/** Previous non-space character before `pos`, or ''. */
function prevChar(text: string, pos: number, from: number): string {
  let i = pos - 1
  while (i >= from && /\s/.test(text[i]!)) i--
  return i >= from ? text[i]! : ''
}

function trimSpan(text: string, s: Span): Span {
  let { start, end } = s
  while (start < end && /[\s:：\-–—,;|·•]/.test(text[start]!)) start++
  while (end > start && /[\s:：\-–—,;|·•]/.test(text[end - 1]!)) end--
  return { start, end }
}

/**
 * Where a label of this segment can start after `after`: a lexicon match followed by a colon,
 * or a strong match right after a comma ("בנק יהב, סניף 318, ח-ן 3732297"), or the run of words
 * just before a label colon.
 */
function nextLabelStart(text: string, heads: LabelMatch[], colons: number[], after: number, end: number): number | null {
  let best: number | null = null
  for (const m of heads) {
    if (m.start <= after || m.start >= end) continue
    const n = nextNonSpace(text, m.end, end)
    const colon = text[n] === ':' || text[n] === '：'
    const comma = prevChar(text, m.start, after) === ','
    if (colon || (comma && m.strength === 'strong')) {
      best = best === null ? m.start : Math.min(best, m.start)
      break
    }
  }
  for (const c of colons) {
    if (c <= after) continue
    // The label is the run of letter words right before the colon (at most three).
    const before = text.slice(after, c)
    const m = /((?:[^\s\d]+\s+){0,2}[^\s\d]+)\s*$/u.exec(before)
    if (!m || !/\p{L}/u.test(m[1]!)) continue
    const start = after + m.index
    if (start <= after) continue
    // Something must be left for the previous value.
    if (!/[\p{L}\p{N}]/u.test(text.slice(after, start))) continue
    if (best === null || start < best) best = start
    break
  }
  return best
}

/** Currency marks and codes, the only words a "words then number" value may hold. */
const CURRENCY_WORD = /^(?:[₪$€£¥]|ש"ח|ש״ח|nis|ils|usd|eur|gbp|chf|=)$/i

/**
 * A colon-less segment of label words followed by one number-like value: "בגין חשבונית 5344",
 * "כרטיס לקוח 10295", "Total in ILS 18,586.15 ILS", "USD rate 1 USD = 3.7150 ILS". The whole run
 * of words is the label (the lexicon word inside it says it is one), so a reference like "עבור
 * חשבונית 77879" keeps its full label instead of "עבור" with "חשבונית 77879" as the value.
 */
export function wordsThenValue(text: string, seg: Span, matches: readonly LabelMatch[]): InlinePair | null {
  const toks = [...text.slice(seg.start, seg.end).matchAll(/\S+/g)].map((m) => ({ t: m[0], start: seg.start + m.index, end: seg.start + m.index + m[0].length }))
  const first = toks.findIndex((x) => /\d/.test(x.t))
  if (first < 1 || first > 5) return null
  const label = toks.slice(0, first)
  const value = toks.slice(first)
  const lead = label.filter((x) => !CURRENCY_WORD.test(x.t))
  if (!lead.length || !lead.every((x) => /^[\p{L}"'׳״./()-]+$/u.test(x.t) && /\p{L}/u.test(x.t))) return null
  // Currency marks before the number belong to the value ("סך של ₪ 20,839.86").
  const valueStart = label.slice(lead.length).length ? label[lead.length]!.start : value[0]!.start
  if (value.length > 6 || value.some((x) => /\p{L}{2,}/u.test(x.t) && !/\d/.test(x.t) && !CURRENCY_WORD.test(x.t))) return null
  const labelSpan = { start: lead[0]!.start, end: lead[lead.length - 1]!.end }
  const head = matches.find((m) => m.start >= labelSpan.start && m.end <= labelSpan.end && isPairingMatch(m)) ?? null
  // A phrase found behind a one-letter prefix in a short word ("שמונה" read as ש+"מונה") is too
  // weak to make a line a label on its own.
  const inLabel = matches.filter((m) => m.start >= labelSpan.start && m.end <= labelSpan.end && (m.prefix === '' || m.prefix === 'ו' || m.prefix === 'ה'))
  // "רחוב האלה 90": street words and a house number are an address, not a label and a value.
  if (!inLabel.length || inLabel.some((m) => m.concept === 'party.address')) return null
  return { label: labelSpan, value: { start: valueStart, end: toks[toks.length - 1]!.end }, colon: false, head }
}

/**
 * Finds the inline pairs of one line. `matches` are the lexicon matches over the whole text.
 */
export function inlinePairs(text: string, matches: readonly LabelMatch[]): InlinePair[] {
  const out: InlinePair[] = []
  const heads = matches.filter((m) => isPairingMatch(m) && !addressMarker(text, m)).sort((a, b) => a.start - b.start)
  for (const seg of segmentsOf(text)) {
    const segHeads = heads.filter((m) => m.start >= seg.start && m.end <= seg.end)
    const colons = labelColons(text, seg.start, seg.end)
    // "שוטף + 30", "Net 60": a terms value whose first word is also a weak terms label. A means of
    // payment opening it ("Transferencia bancaria a 30 días") is part of the value, not its label.
    const termsHead = segHeads.some((m) => m.strength === 'strong' && TERMS_LABELS.has(m.concept) && !methodValue(m))
    if (!colons.length && looksLikeTerms(text.slice(seg.start, seg.end)) && !termsHead) continue
    const words = !colons.length ? wordsThenValue(text, seg, matches) : null
    if (words) {
      out.push(words)
      continue
    }
    let pos = skipFiller(text, seg.start, seg.end)
    let guard = 0
    while (pos < seg.end && guard++ < 20) {
      let labelEnd: number | null = null
      let valueStart = pos
      let colon = false
      let head: LabelMatch | null = segHeads.find((m) => m.start >= pos && skipFiller(text, pos, m.start) === m.start) ?? null
      const c = colons.find((x) => x > pos)
      if (c !== undefined) {
        const labelText = text.slice(pos, c)
        if (/\p{L}/u.test(labelText) && !hasValueDigits(labelText) && wordCount(labelText) <= 8 && (!head || head.start < c)) {
          labelEnd = c
          valueStart = c + 1
          colon = true
          if (head && head.end > c) head = null
        }
      }
      if (labelEnd === null && head) {
        labelEnd = head.end
        const n = nextNonSpace(text, head.end, seg.end)
        if (text[n] === ':' || text[n] === '：') {
          colon = true
          valueStart = n + 1
        } else valueStart = head.end
      }
      if (labelEnd === null) {
        const next = nextLabelStart(text, segHeads, colons, pos, seg.end)
        if (next === null || next <= pos) break
        pos = next
        continue
      }
      const vEnd = nextLabelStart(text, segHeads, colons, valueStart, seg.end) ?? seg.end
      const value = trimSpan(text, { start: valueStart, end: vEnd })
      const valueText = text.slice(value.start, value.end)
      // A lexicon word opening a sentence is not a label: prose values are long and digit-free.
      const prose = !colon && wordCount(valueText) > 6 && !/\d/.test(valueText)
      // "מס' צ'ק / אסמכתא": two labels side by side, not a label and its value.
      const labelOnly = !colon && !/\d/.test(valueText) && (() => {
        const v = analyzeLabel(valueText)
        // "תנאי תשלום שוטף": a terms word after a terms label is the value.
        const termsValue =
          !!head && TERMS_LABELS.has(head.concept) && (looksLikeTerms(valueText) || (!!v.primary && VALUE_WORDS.has(v.primary.concept) && v.primary.strength === 'weak') || v.primary?.concept === 'other.payment_method')
        return (v.exact || v.columnOnly) && !termsValue
      })()
      // Without a colon, a lexicon word followed by words only is prose ("סה"כ אחרי", "חשבונית זו
      // הופקה…"); only party markers and terms take a text value that way ("לכבוד חברה בע"מ").
      const textOk = colon || /[\d@]/.test(valueText) || (!!head && TEXT_HEADS(head))
      if (value.end > value.start && /[\p{L}\p{N}@]/u.test(valueText) && !prose && !labelOnly && textOk) {
        out.push({ label: trimSpan(text, { start: pos, end: labelEnd }), value, colon, head })
      }
      pos = skipFiller(text, Math.max(vEnd, labelEnd + 1), seg.end)
    }
  }
  return out
}
