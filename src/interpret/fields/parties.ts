import { wordsInSpan } from '../../lib/docIndex'
import { xOverlapRatio } from '../../lib/geometry'
import type { CanonicalField, Line, Word } from '../../model/types'
import { type TaxIdHint } from '../../semantic'
import { matchLabelsPlus as matchLabels } from '../../structure/keyValues/lexicon'
import type { FieldsContext, Pair } from './context'
import { wordsOfSpan, type Draft } from './draft'
import { addressScore, cityLike, hasLegalSuffix, legalOwner, looksLikeContact, nameScore, onlySuffix } from './partyText'
import { senseOf } from './sense'
import { readBankAccount, readEmail, readPhone, readTaxId, readText, type BankValue, type Found } from './values'

/**
 * Parties: who issued the document (supplier) and who is billed (customer).
 *
 *  1. Role markers (לכבוד / לקוח / Bill to / Cliente → customer; ספק / מאת / From / Proveedor →
 *     supplier; Ship to → a delivery address, never the customer's) open a region: the lines
 *     under the marker aligned with it, until the line pitch breaks, another marker or a table.
 *  2. Without a supplier marker, the issuer is the letterhead: the block near the top with the
 *     most identity evidence (tax id, phones, e-mail, address, a large name line).
 *  3. Attributes come from labelled values inside a region (ח.פ / טל' / דוא"ל / כתובת …) and from
 *     text shapes (address lines, the name line above them, e-mail patterns).
 *
 * Every candidate carries 'role:supplier'/'role:customer' only when a marker or the letterhead's
 * own identity evidence says whose it is.
 */

type Role = 'supplier' | 'customer' | 'ship_to'

interface Segment {
  line: Line
  wordIds: string[]
  text: string
}

export interface Region {
  role: Role
  kind: 'marker' | 'letterhead' | 'unmarked'
  marker: Line | null
  lineIds: Set<string>
  segments: Segment[]
  /** The region's role is backed by a marker or by identity evidence. */
  confirmed: boolean
  /**
   * A letterhead without a phone, e-mail or website may be the addressee's block (an address
   * window with the customer's tax id): its ids are not the issuer's by position alone.
   */
  uncertain?: boolean
  /** Lines of a contacts column the letterhead was joined with: phones and e-mails, never its name. */
  contactLines?: Set<string>
}

/** Concepts that open a party's block: role markers, and the party-name labels ("שם הלקוח"). */
const ROLE_OF: Record<string, Role> = {
  'role.customer': 'customer',
  'role.supplier': 'supplier',
  'role.ship_to': 'ship_to',
  'customer.name': 'customer',
  'supplier.name': 'supplier',
}
const SEP = /\s[|·•]\s|\s[|·•]|[|·•]\s/g

function wordsOf(fc: FieldsContext, line: Line): Word[] {
  return line.wordIds.map((id) => fc.index.word.get(id)).filter((w): w is Word => !!w)
}

function lineHeight(fc: FieldsContext, line: Line): number {
  return Math.max(4, ...wordsOf(fc, line).map((w) => w.bbox.y1 - w.bbox.y0))
}

function segmentsOfLine(fc: FieldsContext, line: Line, from = 0): Segment[] {
  const out: Segment[] = []
  const text = line.text
  let pos = from
  const push = (s: number, e: number) => {
    const t = text.slice(s, e).trim()
    if (!/[\p{L}\p{N}]/u.test(t)) return
    const ids = wordsInSpan(fc.index, line, s, e)
    if (ids.length) out.push({ line, wordIds: ids, text: ids.map((id) => fc.index.word.get(id)!.text).join(' ') })
  }
  for (const m of text.slice(from).matchAll(SEP)) {
    push(pos, from + m.index)
    pos = from + m.index + m[0].length
  }
  push(pos, text.length)
  return out
}

interface Marker {
  line: Line
  role: Role
  /** Offset in the line where the party text starts (after the marker), or null for a heading line. */
  contentFrom: number | null
  /** An inline marker printed flush against its text, with no colon ("לקוח הדמו בע"מ"). */
  glued?: boolean
}

/** A role marker at the start of a line: a heading ("לכבוד", "Bill To") or inline ("לכבוד: X"). */
export function markerOf(line: Line): Marker | null {
  const text = line.text
  const sense = senseOf(text)
  if (sense.exact && sense.primary && ROLE_OF[sense.primary.concept]) return { line, role: ROLE_OF[sense.primary.concept]!, contentFrom: null }
  // A billing-address heading alone on its line ("FACTUURADRES", "Rechnungsadresse") heads the
  // addressee's block, as "Bill to" does.
  if (sense.exact && sense.primary?.concept === 'customer.address' && !/[:：]/.test(text)) return { line, role: 'customer', contentFrom: null }
  const ms = matchLabels(text).filter((x) => ROLE_OF[x.concept])
  // The marker opens the line, possibly after a framing word ("פרטי לקוח:", "Customer details").
  const m = ms.find((x) => !/[\p{L}\p{N}]/u.test(text.slice(0, x.start).replace(/פרטי|פרטים|details/giu, '')))
  if (!m) return null
  const role = ROLE_OF[m.concept]
  if (!role) return null
  const rest = text.slice(m.end)
  const colon = /^\s*[:：]/.test(rest)
  if (colon) return { line, role, contentFrom: m.end + rest.indexOf(':') + 1 }
  if (m.strength === 'strong' && /\p{L}{2,}/u.test(rest) && role !== 'ship_to') return { line, role, contentFrom: m.end, glued: true }
  return null
}

function aligned(marker: Line, l: Line): boolean {
  if (xOverlapRatio(marker.bbox, l.bbox) >= 0.5) return true
  if (marker.dir === 'rtl') return Math.abs(l.bbox.x1 - marker.bbox.x1) <= 12
  return Math.abs(l.bbox.x0 - marker.bbox.x0) <= 12
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

function columnHeader(line: Line): boolean {
  const s = senseOf(line.text)
  const m = s.matches[0]
  return !!m && m.kind === 'column' && !s.primary && s.matches.every((x) => x.kind === 'column')
}

/**
 * The header row of an item table: two or more column headers side by side ("תיאור | כמות |
 * מחיר"). One column word alone ("שם", "Services") is a label or a name, not a table.
 */
function isItemHeader(fc: FieldsContext, line: Line): boolean {
  if (!columnHeader(line)) return false
  const h = lineHeight(fc, line)
  const row = (fc.index.pageLines.get(line.page) ?? []).filter((l) => l !== line && Math.abs((l.bbox.y0 + l.bbox.y1) / 2 - (line.bbox.y0 + line.bbox.y1) / 2) <= 0.6 * h)
  return row.filter(columnHeader).length >= 2
}

/** The lines under a marker that belong to its party. */
function regionLines(fc: FieldsContext, marker: Line, stops: Set<string>): Line[] {
  const ownMarker = markerOf(marker)
  const own = ownMarker?.role
  const lines = (fc.index.pageLines.get(marker.page) ?? []).filter((l) => l.bbox.y0 > marker.bbox.y0 + 0.5 * lineHeight(fc, marker)).sort((a, b) => a.bbox.y0 - b.bbox.y0)
  const out: Line[] = []
  const h = lineHeight(fc, marker)
  let prevY0 = marker.bbox.y0
  const pitches: number[] = []
  for (const l of lines) {
    if (!aligned(marker, l)) continue
    const pitch = l.bbox.y0 - prevY0
    const limit = pitches.length >= 2 ? 1.45 * median(pitches) + 1 : Math.max(3.2 * h, 26)
    if (pitch > limit) break
    if (stops.has(l.id) || fc.itemLineIds.has(l.id) || isItemHeader(fc, l)) break
    // Another party's marker ends the region; a name label of the same party ("פרטי הספק" over
    // "שם החברה") is one of its attributes. Under a heading ("לכבוד", "Bill to"), a line that
    // starts with this party's own noun flush against more words ("לקוח הדמו בע"מ") is the
    // party's text: the heading already marked the block, and the noun may begin the name.
    const next = markerOf(l)
    const heading = ownMarker?.contentFrom === null
    if (next && !(next.role === own && (!(senseOf(l.text).primary?.concept ?? '').startsWith('role.') || (heading && next.glued)))) break
    out.push(l)
    pitches.push(pitch)
    prevY0 = l.bbox.y0
    if (out.length >= 9) break
  }
  return out
}

function pairsIn(fc: FieldsContext, lineIds: Set<string>): Pair[] {
  return fc.pairs.filter((p) => p.labelLineIds.some((id) => lineIds.has(id)))
}

function markerRegions(fc: FieldsContext, stops: Set<string>): Region[] {
  const out: Region[] = []
  const page = fc.index.doc.pages[0]
  if (!page) return out
  const markers = (fc.index.pageLines.get(page.number) ?? []).filter((l) => !fc.itemLineIds.has(l.id) && !stops.has(l.id) && markerOf(l))
  for (const line of markers) {
    const mk = markerOf(line)!
    // A name label already inside the region of its party's marker is that region's.
    if (out.some((r) => r.role === mk.role && r.lineIds.has(line.id))) continue
    const lines = regionLines(fc, line, stops)
    const lineIds = new Set([line.id, ...lines.map((l) => l.id)])
    // Values paired with the region's labels (grid boxes put them in a second column).
    for (const p of pairsIn(fc, lineIds)) for (const id of p.valueLineIds) lineIds.add(id)
    if (!sharesRowWithMarker(fc, line)) for (const p of rowMatePairs(fc, line, [line, ...lines], markers)) for (const id of [...p.labelLineIds, ...p.valueLineIds]) lineIds.add(id)
    const segments: Segment[] = []
    if (mk.contentFrom !== null) segments.push(...segmentsOfLine(fc, line, mk.contentFrom))
    // Below the item table a supplier marker is a signature or a payee line ("הנפיק / Issued by:
    // Export Dept.", "Account name: …"): it names the supplier only with a legal name.
    if (mk.role === 'supplier' && belowItems(fc, line) && !segments.some((sg) => hasLegalSuffix(sg.text)) && !lines.length) continue
    const ordered = [...lineIds]
      .filter((id) => id !== line.id)
      .map((id) => fc.index.line.get(id)!)
      .sort((a, b) => a.bbox.y0 - b.bbox.y0 || (a.dir === 'rtl' ? b.bbox.x1 - a.bbox.x1 : a.bbox.x0 - b.bbox.x0))
    for (const l of ordered) segments.push(...segmentsOfLine(fc, l))
    out.push({ role: mk.role, kind: 'marker', marker: line, lineIds, segments, confirmed: true })
  }
  return out
}

/** The line is printed under the (first) item table of its page: the totals and footer area. */
function belowItems(fc: FieldsContext, line: Line): boolean {
  const items = fc.structure.tables.filter((t) => t.role === 'items' && t.pages[0] === line.page)
  return items.some((t) => line.bbox.y0 > t.bbox.y1)
}

const PARTY_ATTRS = new Set(['party.address', 'party.tax_id', 'party.phone', 'party.email', 'customer.tax_id', 'supplier.tax_id', 'customer.address', 'supplier.address'])

function centreY(l: Line): number {
  return (l.bbox.y0 + l.bbox.y1) / 2
}

/** Another role marker on the marker's own row: the page is split into side-by-side party boxes. */
function sharesRowWithMarker(fc: FieldsContext, marker: Line): boolean {
  const h = lineHeight(fc, marker)
  return (fc.index.pageLines.get(marker.page) ?? []).some((l) => l !== marker && Math.abs(centreY(l) - centreY(marker)) <= 0.6 * h && !!markerOf(l))
}

/**
 * A full-width party grid ("שם | רחל אברהם | כתובת | סוקולוב 17…"): party attributes printed on
 * the region's rows further along the reading direction belong to the same party.
 */
function rowMatePairs(fc: FieldsContext, marker: Line, lines: Line[], markers: readonly Line[]): Pair[] {
  const rtl = marker.dir === 'rtl'
  const out: Pair[] = []
  for (const p of fc.pairs) {
    if (!p.sense.concepts.some((c) => PARTY_ATTRS.has(c))) continue
    const label = fc.index.line.get(p.labelLineIds[0] ?? '')
    if (!label || label.page !== marker.page) continue
    // Under another marker's column it is that party's.
    if (markers.some((m) => m !== marker && m.bbox.y0 < label.bbox.y0 && aligned(m, label) && !aligned(marker, m))) continue
    const onSide = rtl ? label.bbox.x1 < marker.bbox.x1 - 12 : label.bbox.x0 > marker.bbox.x0 + 12
    if (!onSide) continue
    const h = lineHeight(fc, label)
    if (lines.some((l) => Math.abs(centreY(l) - centreY(label)) <= 0.6 * h)) out.push(p)
  }
  return out
}

const META_CONCEPTS = new Set(['invoice_number', 'invoice_date', 'due_date', 'delivery_date', 'po_number', 'allocation_number', 'payment_terms', 'total', 'total_due', 'subtotal', 'amount_due', 'tax', 'tax_amount'])

/** Countries whose tax-id formats the label's language implies ("NIF/CIF" → ES, "USt-ID" → DE). */
const COUNTRY_OF_LANG: Record<string, string> = { he: 'IL', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', pt: 'PT' }

/** How to read the id under a tax-id label: by the label's language (EIN means a US number). */
export function taxIdHint(p: Pair): TaxIdHint {
  const m = p.sense.matches.find((x) => x.concept === 'party.tax_id' || x.concept.endsWith('.tax_id'))
  if (!m) return /[א-ת]/.test(p.sense.text) ? { country: 'IL' } : {}
  if (/^f?ein$/i.test(m.phrase)) return { scheme: 'US_EIN' }
  const c = COUNTRY_OF_LANG[m.language]
  return c ? { country: c } : {}
}

function isVatNumber(text: string): boolean {
  const t = readTaxId(text)
  return !!t && (t.value.scheme === 'EU_VAT' || t.value.scheme === 'GB_VAT' || t.value.scheme === 'CH_UID') && t.value.checksum !== false
}

/** A prefixed EU/UK VAT number or a checksum-valid Israeli id. */
function isTaxIdShaped(text: string): boolean {
  const t = readTaxId(text)
  return !!t && (t.value.scheme === 'EU_VAT' || t.value.scheme === 'GB_VAT' || t.value.scheme === 'CH_UID' || (t.value.scheme === 'IL' && t.value.checksum === true))
}

interface BlockScore {
  blockId: string
  lines: Line[]
  score: number
  identity: boolean
  /** A phone, e-mail or website: an addressee block seldom carries them, an issuer always. */
  contact: boolean
}

/** Supplier identity evidence of a block (tax id, phone, e-mail, address, a big name line). */
function scoreBlock(fc: FieldsContext, lines: Line[], pageHeight: number, bigFont: number): BlockScore {
  const ids = new Set(lines.map((l) => l.id))
  const pairs = pairsIn(fc, ids)
  let score = 0
  let identity = false
  // A value shaped like a VAT/company id counts whatever its label ("TVA intracom.: FR57…").
  const idPairs = pairs.filter((p) => p.sense.concepts.includes('party.tax_id') || p.sense.concepts.includes('supplier.tax_id') || isTaxIdShaped(p.value.text))
  const concepts = new Set(pairs.filter((p) => !idPairs.includes(p)).flatMap((p) => p.sense.concepts))
  if (idPairs.length) {
    score += 2
    identity = true
  }
  const phone = concepts.has('party.phone') || lines.some((l) => looksLikeContact(l.text) && /\d{3}/.test(l.text))
  const email = concepts.has('party.email') || lines.some((l) => looksLikeContact(l.text) && !/\d{5}/.test(l.text))
  if (phone) score += 1
  if (email) score += 1
  if (lines.some((l) => segmentsOfLine(fc, l).some((s) => addressScore(s.text) >= 0.65))) score += 1
  if (lines.some((l) => hasLegalSuffix(l.text))) score += 1
  if (lines[0] && lines[0].bbox.y0 < 0.3 * pageHeight) score += 1
  // The issuer's header is at the top; the same details in a footer are a repetition.
  if (lines[0] && lines[0].bbox.y0 > 0.6 * pageHeight) score -= 2
  const size = Math.max(...lines.flatMap((l) => wordsOf(fc, l).map((w) => w.fontSize)))
  if (size >= bigFont * 0.95) score += 1
  // The largest type at the very top of the page, as a name, is the issuer's (a logo line); an
  // address window lower down with a name and an address is the addressee's.
  const named = lines.filter((l) => nameScore(l.text) > 0)
  const nameSize = Math.max(0, ...named.flatMap((l) => wordsOf(fc, l).map((w) => w.fontSize)))
  if (nameSize >= bigFont * 0.7 && named.some((l) => l.bbox.y0 < 0.15 * pageHeight)) score += 1
  if ([...concepts].some((c) => META_CONCEPTS.has(c))) score -= 3
  if (lines.some((l) => markerOf(l)?.role === 'customer')) score -= 3
  return { blockId: lines[0]?.blockId ?? '', lines, score, identity, contact: phone || email }
}

function letterhead(fc: FieldsContext, taken: Set<string>, title: Line | null): Region | null {
  const page = fc.index.doc.pages[0]
  if (!page) return null
  const pageLines = (fc.index.pageLines.get(page.number) ?? []).filter((l) => !taken.has(l.id) && !fc.itemLineIds.has(l.id) && l !== title)
  const byBlock = new Map<string, Line[]>()
  for (const l of pageLines) byBlock.set(l.blockId, [...(byBlock.get(l.blockId) ?? []), l])
  const top = pageLines.filter((l) => l.bbox.y0 < 0.35 * page.height)
  const bigFont = Math.max(0, ...top.flatMap((l) => wordsOf(fc, l).map((w) => w.fontSize)))
  // Score each block together with the blocks it grows into: the reader (or OCR) may have split
  // the letterhead, and a split letterhead must not lose to an addressee block.
  const blocks = [...byBlock.values()]
  const seen = new Set<string>()
  const scored: BlockScore[] = []
  const contacts = new Map<BlockScore, Set<string>>()
  for (const b of blocks) {
    const contactLines = new Set<string>()
    const grown = growLetterhead(fc, [...b], blocks, contactLines)
    const key = grown.map((l) => l.id).sort().join(',')
    if (seen.has(key)) continue
    seen.add(key)
    const sc = scoreBlock(fc, grown, page.height, bigFont)
    contacts.set(sc, contactLines)
    scored.push(sc)
  }
  scored.sort((a, b) => b.score - a.score)
  let best = scored[0]
  if (!best || best.score < 3) return null
  // A name and an address with no id and no contact is an address window when a larger name is
  // printed above it (the issuer's, whose details may sit in a footer).
  if (!best.identity && !best.contact) {
    const nameSize = (b: BlockScore) => Math.max(0, ...b.lines.filter((l) => nameScore(l.text) > 0).flatMap((l) => wordsOf(fc, l).map((w) => w.fontSize)))
    const top = (b: BlockScore) => Math.min(...b.lines.map((l) => l.bbox.y0))
    const above = scored.find((b) => b !== best && b.score >= 2 && top(b) < top(best!) && nameSize(b) > 1.3 * nameSize(best!))
    if (above) best = above
  }
  const lineIds = new Set(best.lines.map((l) => l.id))
  // Whose block it is is settled only by identity evidence the runner-up cannot match.
  const margin = best.score - (scored[1]?.score ?? 0)
  return {
    role: 'supplier',
    kind: 'letterhead',
    marker: null,
    lineIds,
    segments: best.lines.flatMap((l) => segmentsOfLine(fc, l)),
    confirmed: best.identity && best.contact && margin >= 2,
    uncertain: !best.contact,
    contactLines: contacts.get(best),
  }
}

/**
 * A letterhead the reader split into blocks (a logo-size name over the details, an OCR gap):
 * blocks right above or below it, aligned on the same reading-start edge and holding no meta
 * labels, belong to it.
 */
function growLetterhead(fc: FieldsContext, lines: Line[], blocks: Line[][], contactLines?: Set<string>): Line[] {
  const out = [...lines]
  const dir = lines[0]?.dir ?? 'rtl'
  const edge = (ls: Line[]) => (dir === 'rtl' ? Math.max(...ls.map((l) => l.bbox.x1)) : Math.min(...ls.map((l) => l.bbox.x0)))
  for (let round = 0; round < 3; round++) {
    let grew = false
    const top = Math.min(...out.map((l) => l.bbox.y0))
    const bottom = Math.max(...out.map((l) => l.bbox.y1))
    const h = Math.max(...out.map((l) => lineHeight(fc, l)))
    for (const b of blocks) {
      if (b.some((l) => out.includes(l))) continue
      if (othersBlock(fc, b)) continue
      const bTop = Math.min(...b.map((l) => l.bbox.y0))
      const bBottom = Math.max(...b.map((l) => l.bbox.y1))
      if (Math.abs(edge(b) - edge(out)) > 12) {
        // The name on one side of the header and the details on the other, in the same band.
        const side = sideName(fc, out, b, top, bottom)
        if (!side) continue
        if (side === 'contact') for (const l of b) contactLines?.add(l.id)
      } else {
        const gap = bTop >= bottom ? bTop - bottom : top - bBottom
        if (gap < 0 || gap > 2.2 * h) continue
      }
      const concepts = pairsIn(fc, new Set(b.map((l) => l.id))).flatMap((p) => p.sense.concepts)
      if (concepts.some((c) => META_CONCEPTS.has(c)) || b.some((l) => markerOf(l))) continue
      // A second tax id or a second legal name is a second party, not more of this letterhead.
      const taxIds = (ls: Line[]) => pairsIn(fc, new Set(ls.map((l) => l.id))).some((p) => p.sense.concepts.includes('party.tax_id'))
      if (taxIds(b) && taxIds(out)) continue
      if (b.some((l) => hasLegalSuffix(l.text)) && out.some((l) => hasLegalSuffix(l.text))) continue
      out.push(...b)
      grew = true
    }
    if (!grew) break
  }
  return out.sort((a, b) => a.bbox.y0 - b.bbox.y0)
}

/**
 * A block that belongs to something else: part of it was taken by another party's region (the
 * buyer's lines under "Buyer"), or it holds the values of labels printed outside it (the value
 * column of a meta grid: "PI No." … "HS-PI-260917").
 */
function othersBlock(fc: FieldsContext, b: Line[]): boolean {
  const ids = new Set(b.map((l) => l.id))
  const block = fc.index.block.get(b[0]?.blockId ?? '')
  if (block && block.lineIds.some((id) => !ids.has(id))) return true
  return fc.pairs.some((p) => p.valueLineIds.some((id) => ids.has(id)) && !p.labelLineIds.some((id) => ids.has(id)) && p.layout !== 'inline')
}

/**
 * A details block without a name line (tax id, address, phones) and, beside it in the same band of
 * the header, a block whose larger print is a name: one letterhead split in two columns.
 */
function sideName(fc: FieldsContext, details: Line[], b: Line[], top: number, bottom: number): 'name' | 'contact' | null {
  const bTop = Math.min(...b.map((l) => l.bbox.y0))
  const bBottom = Math.max(...b.map((l) => l.bbox.y1))
  const overlap = Math.min(bottom, bBottom) - Math.max(top, bTop)
  if (overlap < 0.5 * (bBottom - bTop)) return null
  const named = (ls: Line[]) => ls.some((l) => segmentsOfLine(fc, l).some((s) => nameScore(s.text) > 0 && (hasLegalSuffix(s.text) || !listPiece(fc, s))))
  const size = (ls: Line[]) => Math.max(0, ...ls.flatMap((l) => wordsOf(fc, l).map((w) => w.fontSize)))
  if (!named(details) && named(b) && size(b) >= 1.3 * size(details)) return 'name'
  // Or the contacts of a letterhead that prints none itself ("הזמנות: 04-…" / e-mail beside the
  // name and tax-id block), without another party's id or name.
  const contact = (ls: Line[]) => ls.some((l) => segmentsOfLine(fc, l).some((s) => looksLikeContact(s.text) || !!readPhone(s.text)))
  const ids = (ls: Line[]) => pairsIn(fc, new Set(ls.map((l) => l.id))).some((p) => p.sense.concepts.includes('party.tax_id'))
  return named(details) && !contact(details) && contact(b) && !ids(b) && !b.some((l) => hasLegalSuffix(l.text)) ? 'contact' : null
}

/** A name-and-address block nobody marked (window envelopes, utility bills): the addressee. */
function unmarkedCustomer(fc: FieldsContext, taken: Set<string>, title: Line | null): Region | null {
  const page = fc.index.doc.pages[0]
  if (!page) return null
  const byBlock = new Map<string, Line[]>()
  for (const l of fc.index.pageLines.get(page.number) ?? []) {
    if (taken.has(l.id) || fc.itemLineIds.has(l.id) || l === title || l.bbox.y0 > 0.5 * page.height) continue
    byBlock.set(l.blockId, [...(byBlock.get(l.blockId) ?? []), l])
  }
  for (const lines of byBlock.values()) {
    const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0)
    if (sorted.length < 2 || sorted.length > 6) continue
    const concepts = new Set(pairsIn(fc, new Set(sorted.map((l) => l.id))).flatMap((p) => p.sense.concepts))
    if ([...concepts].some((c) => META_CONCEPTS.has(c))) continue
    if (nameScore(sorted[0]!.text) < 0.7) continue
    if (!sorted.slice(1).some((l) => addressScore(l.text) >= 0.65)) continue
    return { role: 'customer', kind: 'unmarked', marker: null, lineIds: new Set(sorted.map((l) => l.id)), segments: sorted.flatMap((l) => segmentsOfLine(fc, l)), confirmed: false }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Attributes

function roleSignal(region: Region): string[] {
  if (!region.confirmed || region.role === 'ship_to') return []
  return [`role:${region.role}`]
}

function method(region: Region, how: string): string {
  return `party:${region.kind}:${how}`
}

/** A phone abbreviation opening a contact piece ("T", "P", "Ph.", "Tel.", "Tél.", "Fon"). */
const PHONE_MARK = /^(?:t|p|ph|tel|tél|fon|telefon|telephone|téléphone|teléfono)\.?:?\s+[+(\d]/i

/**
 * A phone number in national or international print the strict parser does not know ("0113 496
 * 0582", "04 72 00 01 08", "963 00 01 10", "(03) 5550 0182", "+86 574 0000 0112"): digit groups with
 * an optional country code and area code, 7 to 15 digits. Only read where a label or a phone mark
 * says the value is a phone.
 */
export function loosePhone(text: string): Found<string> | null {
  const m = /(?<![\d\p{L}])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,5}(?![\d\p{L}])/u.exec(text)
  if (!m) return null
  const digits = m[0].replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return { value: m[0].trim(), raw: m[0].trim(), start: m.index, end: m.index + m[0].trim().length }
}

const MAIN_PHONE = /^(?:טל|טלפון|tel|phone|telephone|telefon|téléphone|teléfono|telefono|telefoon|telefone|fon)/i
const MOBILE = /^(?:נייד|סלולר|פלאפון|mobile|mob|cell|handy|mobil|portable|móvil|celular|cellulare|mobiel|telem)/i

/**
 * Under a heading marker ("לכבוד", "Bill to"), a line that starts with the party's own noun flush
 * against more words ("לקוח הדמו בע"מ") is the party's text, not a second label: the heading
 * already marked the block, and the noun may be the name's first word (see regionLines).
 */
function headingAbsorbs(fc: FieldsContext, region: Region, p: Pair): boolean {
  if (region.kind !== 'marker' || !region.marker || markerOf(region.marker)?.contentFrom !== null) return false
  if (!(p.sense.primary?.concept ?? '').startsWith('role.')) return false
  const line = fc.index.line.get(p.labelLineIds[0] ?? '')
  if (!line || line.id === region.marker.id) return false
  const mk = markerOf(line)
  return !!mk?.glued && mk.role === region.role
}

function nameDrafts(fc: FieldsContext, region: Region, field: CanonicalField, allPairs: Pair[]): Draft[] {
  const out: Draft[] = []
  const signals = roleSignal(region)
  const pairs = allPairs.filter((p) => !headingAbsorbs(fc, region, p))
  // Labelled names: "שם העסק", "שם הלקוח", "שם", a role label with the name as its value.
  for (const p of pairs) {
    const c = p.sense.primary?.concept ?? ''
    // "שם", "שם החברה", "Company name": a name label inside the party's block names the party.
    const nameWord = NAME_LABEL.test(p.sense.text.trim()) && (!p.sense.primary || p.sense.primary.kind === 'column' || c.endsWith('.name'))
    const nameLabel = c === field || (field === 'customer.name' && c === 'role.customer') || (field === 'supplier.name' && c === 'role.supplier') || nameWord
    if (!nameLabel) continue
    const t = readText(p.value.text)
    if (!t || nameScore(t.value) === 0) continue
    out.push({
      field,
      rawValue: t.value,
      normalized: { kind: 'text', value: t.value },
      valueWordIds: wordsOfSpan(fc.index, p.value.wordIds, t.start, t.end),
      labelWordIds: p.label.wordIds,
      originalLabel: p.sense.text,
      score: (hasLegalSuffix(t.value) ? 0.88 : 0.8) * (region.confirmed ? 1 : 0.6),
      method: method(region, 'label'),
      signals,
    })
  }
  if (out.length) return out
  const segs = region.segments.filter((s) => !pairOwns(pairs, s))
  if (region.kind === 'letterhead') return letterheadNames(fc, region, field, segs)
  const first = segs.find((s) => nameScore(s.text) > 0)
  if (!first) return out
  const t = readText(first.text)!
  const legal = hasLegalSuffix(t.value)
  out.push({
    field,
    rawValue: t.value,
    normalized: { kind: 'text', value: t.value },
    valueWordIds: first.wordIds,
    labelWordIds: region.marker ? region.marker.wordIds : null,
    originalLabel: region.marker ? region.marker.text : null,
    score: region.kind === 'unmarked' ? 0.45 : legal ? 0.84 : 0.76,
    method: method(region, 'first-line'),
    signals,
  })
  return out
}

/** The segment is the label of a pair (a "טל': …" or "שם החברה" segment is not a name or address). */
function pairOwns(pairs: Pair[], s: Segment): boolean {
  const ids = new Set(s.wordIds)
  return pairs.some((p) => p.label.wordIds.some((id) => ids.has(id)) && !['role.customer', 'role.supplier'].includes(p.sense.primary?.concept ?? ''))
}

/** "From" words: the issuer on an invoice, the payer on a receipt. */
const FROM = /^(?:מאת|from|von|de|da|van)(?![\p{L}])/iu

/** Labels that open with the word "name" in the languages of the lexicon. */
const NAME_LABEL = /^(?:שם|name|company name|business name|nombre|nom|naam|nome|firmenname|razón social|raison sociale|ragione sociale)(?:\s|$)/i

/**
 * Letterhead names: the name line right above the address/contact lines is the legal name when a
 * trading name (often a large logo-like line) is printed above it; a legal suffix confirms it.
 * Among several legal names (a Hebrew and an English one) the more prominent, larger print wins.
 * Taglines are not names: a line split by separators into a list ("צילום · וידאו · תוכן
 * לעסקים", "Managed IT · Cloud · Dev") lists services, unless the piece carries a legal suffix.
 */
function letterheadNames(fc: FieldsContext, region: Region, field: CanonicalField, segs: Segment[]): Draft[] {
  const out: Draft[] = []
  const signals = roleSignal(region)
  const isDetail = (s: Segment) => addressScore(s.text) >= 0.65 || looksLikeContact(s.text)
  const details = segs.filter(isDetail)
  const firstDetail = segs.findIndex(isDetail)
  // A name is printed above the details of its own column: a letterhead split in two columns
  // (the name on one side, address and phones on the other) keeps the name side's lines.
  const aboveDetails = (s: Segment) =>
    !details.some((d) => d.line.bbox.y0 < s.line.bbox.y0 - 0.3 * lineHeight(fc, s.line) && Math.min(d.line.bbox.x1, s.line.bbox.x1) > Math.max(d.line.bbox.x0, s.line.bbox.x0))
  const candidates = firstDetail >= 0 ? segs.filter((s) => !isDetail(s) && aboveDetails(s)) : segs.slice(0, 2)
  const pool = joinRowSplits(fc, candidates)
  // Captions of a contacts column beside the letterhead ("הזמנות ושירות" over the order line) are not names.
  const head = pool.filter((s) => nameScore(s.text) > 0 && (hasLegalSuffix(s.text) || !listPiece(fc, s)) && !region.contactLines?.has(s.line.id))
  if (!head.length) return out
  // The name line closest above the details of its own column; in a side-by-side letterhead
  // (details in another column) the most prominent name line.
  const overDetails = head.filter((h) => details.some((d) => d.line.bbox.y0 > h.line.bbox.y0 && Math.min(d.line.bbox.x1, h.line.bbox.x1) > Math.max(d.line.bbox.x0, h.line.bbox.x0)))
  let closest = overDetails.length || !details.length ? (overDetails[overDetails.length - 1] ?? head[head.length - 1]!) : [...head].sort((a, b) => segmentSize(fc, b) - segmentSize(fc, a))[0]!
  // A legal name wrapped over two lines ("Vogel Partners GmbH & Co." / "KG").
  const prev = head[head.length - 2]
  if (prev && prev.line !== closest.line && (onlySuffix(closest.text) || /[&,\-–]$|\bund$|\band$/i.test(prev.text.trim()))) {
    closest = { line: prev.line, wordIds: [...prev.wordIds, ...closest.wordIds], text: `${prev.text} ${closest.text}` }
    head.splice(head.length - 2, 2, closest)
  }
  const legalOnes = head.filter((s) => hasLegalSuffix(s.text))
  // The most prominent legal name; ties go to the one closest to the details. Without a legal
  // name, the line closest to the details.
  const chosen = legalOnes.length ? [...legalOnes].sort((a, b) => segmentSize(fc, b) - segmentSize(fc, a) || head.indexOf(b) - head.indexOf(a))[0]! : closest
  const add = (s: Segment, score: number, how: string) => {
    const t = readText(s.text)!
    out.push({ field, rawValue: t.value, normalized: { kind: 'text', value: t.value }, valueWordIds: s.wordIds, labelWordIds: null, originalLabel: null, score, method: method(region, how), signals })
  }
  const legalChosen = hasLegalSuffix(chosen.text)
  add(chosen, firstDetail >= 0 ? (legalChosen ? 0.84 : 0.72) : 0.6, 'name-line')
  for (const s of head) {
    if (s === chosen) continue
    if (hasLegalSuffix(s.text)) add(s, legalChosen ? 0.3 : 0.55, 'legal-name')
    else if (s === head[0]) add(s, legalOnes.length ? 0.2 : 0.3, 'trading-name')
  }
  return out
}

/** Largest glyph size of a segment's words. */
function segmentSize(fc: FieldsContext, s: Segment): number {
  return Math.max(0, ...s.wordIds.map((id) => fc.index.word.get(id)?.fontSize ?? 0))
}

/**
 * One piece of a tagline: a line that separators split into several pieces of plain words ("יוגה ·
 * פילאטיס · מדיטציה"). A piece beside an id or a contact ("שירה אלמוג · עוסק פטור 310000013") is
 * an identity line, and its name is the issuer's.
 */
function listPiece(fc: FieldsContext, s: Segment): boolean {
  const pieces = segmentsOfLine(fc, s.line)
  if (pieces.length >= 2 && pieces.every((p) => nameScore(p.text) > 0)) return true
  // The reader may print each piece as a line of its own, with the separator a line between them:
  // the chain of lines along the row (same size, word-sized gaps) holds a separator.
  const h = lineHeight(fc, s.line)
  const size = segmentSize(fc, s)
  const row = (fc.index.pageLines.get(s.line.page) ?? [])
    .filter((l) => Math.abs(centreY(l) - centreY(s.line)) <= 0.4 * h)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0)
  const i = row.indexOf(s.line)
  if (i < 0) return false
  let lo = i
  let hi = i
  while (lo > 0 && row[lo]!.bbox.x0 - row[lo - 1]!.bbox.x1 <= 5 * size) lo--
  while (hi < row.length - 1 && row[hi + 1]!.bbox.x0 - row[hi]!.bbox.x1 <= 5 * size) hi++
  return row.slice(lo, hi + 1).some((l) => /^[\s|·•]+$/.test(l.text))
}

/**
 * A name the reader split at wide gaps into several lines of one row ("נמלית" "שילוח" "ולוגיסטיקה"
 * "בע"מ" in spaced-out display type): whole-line segments of the same size, side by side on one
 * row with word-sized gaps, are read as one segment again (in reading order).
 */
function joinRowSplits(fc: FieldsContext, segs: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.line !== s.line && sameRowWords(fc, last, s)) {
      out[out.length - 1] = { line: last.line, wordIds: [...last.wordIds, ...s.wordIds], text: `${last.text} ${s.text}` }
      continue
    }
    out.push(s)
  }
  return out
}

function sameRowWords(fc: FieldsContext, a: Segment, b: Segment): boolean {
  if (a.line.page !== b.line.page || segmentsOfLine(fc, a.line).length > 1 || segmentsOfLine(fc, b.line).length > 1) return false
  const size = segmentSize(fc, a)
  if (!size || Math.abs(size - segmentSize(fc, b)) > 0.5) return false
  const h = lineHeight(fc, a.line)
  if (Math.abs(centreY(a.line) - centreY(b.line)) > 0.3 * h) return false
  const boxes = (s: Segment) => s.wordIds.map((id) => fc.index.word.get(id)!.bbox)
  const ax0 = Math.min(...boxes(a).map((x) => x.x0))
  const ax1 = Math.max(...boxes(a).map((x) => x.x1))
  const bx0 = Math.min(...boxes(b).map((x) => x.x0))
  const bx1 = Math.max(...boxes(b).map((x) => x.x1))
  const gap = Math.max(bx0 - ax1, ax0 - bx1)
  return gap >= 0 && gap <= 1.5 * size
}

function addressDrafts(fc: FieldsContext, region: Region, field: CanonicalField, pairs: Pair[]): Draft[] {
  const out: Draft[] = []
  const signals = roleSignal(region)
  for (const p of pairs) {
    if (!p.sense.concepts.some((c) => c === 'party.address' || c === field) || p.sense.concepts.includes('role.ship_to')) continue
    const t = readText(p.value.text)
    if (!t || looksLikeContact(t.value)) continue
    // A billing-address heading over its block pairs with the block's first line, the name.
    if (addressScore(t.value) < 0.65 && hasLegalSuffix(t.value)) continue
    out.push({
      field,
      rawValue: t.value,
      normalized: { kind: 'text', value: t.value },
      valueWordIds: wordsOfSpan(fc.index, p.value.wordIds, t.start, t.end),
      labelWordIds: p.label.wordIds,
      originalLabel: p.sense.text,
      score: region.kind === 'unmarked' ? 0.45 : 0.78,
      method: method(region, 'label'),
      signals,
    })
  }
  if (out.length) return out
  const segs = region.segments.filter((s) => !pairOwns(pairs, s))
  const i = segs.findIndex((s) => addressScore(s.text) >= 0.65)
  if (i < 0) return out
  const parts = [segs[i]!]
  // One more line: a second address line or the city under the street.
  const next = segs[i + 1]
  if (next && next.line !== segs[i]!.line && (addressScore(next.text) >= 0.65 || cityLike(next.text)) && !hasLegalSuffix(next.text)) parts.push(next)
  else if (next && next.line === segs[i]!.line && (addressScore(next.text) >= 0.65 || cityLike(next.text))) parts.push(next)
  const text = parts.map((p) => readText(p.text)!.value).join(', ')
  out.push({
    field,
    rawValue: text,
    normalized: { kind: 'text', value: text },
    valueWordIds: parts.flatMap((p) => p.wordIds),
    labelWordIds: null,
    originalLabel: null,
    score: region.kind === 'unmarked' ? 0.4 : 0.66,
    method: method(region, 'address-lines'),
    signals,
  })
  return out
}

function taxIdDrafts(fc: FieldsContext, region: Region, field: CanonicalField, pairs: Pair[]): Draft[] {
  const out: Draft[] = []
  const signals = roleSignal(region)
  for (const p of pairs) {
    const own = p.sense.concepts.includes(field)
    // "TVA intracom.: FR57…", "VAT: GB…": a tax label in front of a prefixed VAT number.
    const vatShaped = (p.sense.concepts.includes('tax') || p.sense.concepts.includes('tax_amount')) && isVatNumber(p.value.text)
    if (!own && !p.sense.concepts.includes('party.tax_id') && !vatShaped) continue
    const other: CanonicalField = field === 'supplier.tax_id' ? 'customer.tax_id' : 'supplier.tax_id'
    if (p.sense.concepts.includes(other) && !p.sense.concepts.includes('party.tax_id')) continue
    const t = readTaxId(p.value.text, taxIdHint(p))
    if (!t) continue
    const ids = wordsOfSpan(fc.index, p.value.wordIds, t.start, t.end)
    if (!ids.length) continue
    let score = region.kind === 'unmarked' ? 0.5 : p.sense.exact ? 0.86 : 0.7
    if (t.value.checksum === false) score -= 0.2
    // A checksum proves the number is an id, not whose: below the checksum threshold.
    if (region.uncertain) score = Math.min(score, 0.45)
    out.push({
      field,
      rawValue: t.raw,
      normalized: { kind: 'id', value: t.value.value, scheme: t.value.scheme, checksum: t.value.checksum },
      valueWordIds: ids,
      labelWordIds: p.label.wordIds,
      originalLabel: p.sense.text,
      score,
      method: method(region, 'label'),
      signals,
    })
  }
  return out
}

function contactDrafts(fc: FieldsContext, region: Region, pairs: Pair[]): Draft[] {
  const out: Draft[] = []
  const signals = roleSignal(region)
  let phoneLabelled = false
  for (const p of pairs) {
    // "טל' סניף" (branch phone) is a phone label whatever else it names.
    const phoneLabel = p.sense.concepts.includes('party.phone') || p.sense.matches.some((m) => m.concept === 'party.phone' && !/[\p{L}\p{N}]/u.test(p.sense.text.slice(0, m.start)))
    if (phoneLabel && !p.sense.concepts.includes('trap.fax')) {
      const ph = readPhone(p.value.text) ?? loosePhone(p.value.text)
      if (!ph) continue
      const label = p.sense.text.replace(/^[^\p{L}]+/u, '')
      const score = MAIN_PHONE.test(label) ? 0.82 : MOBILE.test(label) ? 0.45 : 0.5
      phoneLabelled = true
      out.push({
        field: 'supplier.phone',
        rawValue: ph.raw,
        normalized: { kind: 'text', value: ph.value },
        valueWordIds: wordsOfSpan(fc.index, p.value.wordIds, ph.start, ph.end),
        labelWordIds: p.label.wordIds,
        originalLabel: p.sense.text,
        score: score * (region.confirmed ? 1 : 0.8),
        method: method(region, 'label'),
        signals: score >= 0.8 ? signals : [],
      })
    }
    if (p.sense.concepts.includes('party.email')) {
      const e = readEmail(p.value.text)
      if (!e) continue
      out.push({
        field: 'supplier.email',
        rawValue: e.raw,
        normalized: { kind: 'text', value: e.value },
        valueWordIds: wordsOfSpan(fc.index, p.value.wordIds, e.start, e.end),
        labelWordIds: p.label.wordIds,
        originalLabel: p.sense.text,
        score: 0.85 * (region.confirmed ? 1 : 0.8),
        method: method(region, 'label'),
        signals,
      })
    }
  }
  // Pairs with a known label were read above; an unknown label ("T:", "פל':") leaves its value
  // to the patterns.
  const pairedIds = new Set(pairs.filter((p) => p.sense.primary).flatMap((p) => [...p.label.wordIds, ...p.value.wordIds]))
  for (const s of region.segments) {
    if (s.wordIds.some((id) => pairedIds.has(id))) continue
    const e = readEmail(s.text)
    if (e && !out.some((d) => d.field === 'supplier.email')) {
      out.push({
        field: 'supplier.email',
        rawValue: e.raw,
        normalized: { kind: 'text', value: e.value },
        valueWordIds: wordsOfSpan(fc.index, s.wordIds, e.start, e.end),
        labelWordIds: null,
        originalLabel: null,
        score: 0.72,
        method: method(region, 'pattern'),
        signals: [],
      })
    }
    if (!phoneLabelled && !/פקס|fax/i.test(s.text)) {
      // "T 030 000 0109", "P (03) 5550 0182": a one-letter phone mark in front of the number.
      const ph = readPhone(s.text) ?? (PHONE_MARK.test(s.text) ? loosePhone(s.text) : null)
      if (ph && !out.some((d) => d.field === 'supplier.phone')) {
        out.push({
          field: 'supplier.phone',
          rawValue: ph.raw,
          normalized: { kind: 'text', value: ph.value },
          valueWordIds: wordsOfSpan(fc.index, s.wordIds, ph.start, ph.end),
          labelWordIds: null,
          originalLabel: null,
          score: 0.4,
          method: method(region, 'pattern'),
          signals: [],
        })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Bank accounts (anywhere but the customer's block and payment tables)

const BANK_WORDS = /בנק|סניף|חשבון|ח-ן|ח"ן|iban|bank|account|a\/c|bsb|sort code|routing|konto|compte|cuenta|conto|rekening/i
const PAYMENT_ROW = /צ['׳]ק|המחאה|cheque|check no|שובר/i
/** Words of a bank-payment context: a bare "Account: 4800000113" is the payee's account only there. */
const BANK_CONTEXT = /bank|swift|bic|iban|sort code|bsb|routing|aba|beneficiary|wire|transfer|ach|eft|bankverbindung|virement|transferencia/i

/**
 * An IBAN or account number printed in spaced digit groups that the reader split into lines of
 * one row ("A/C No.: 3901" "0012" "0920" "0018" "776"): the groups to the right of the line, in
 * the order printed (left to right, as numbers read), up to the first gap wider than a word space.
 */
function withRowGroups(fc: FieldsContext, line: Line): { text: string; wordIds: string[] } {
  const last = line.text.trim().split(/\s+/).pop() ?? ''
  if (!/^[A-Z0-9]{1,6}$/.test(last) || !/\d/.test(last)) return { text: line.text, wordIds: [...line.wordIds] }
  const h = lineHeight(fc, line)
  const row = (fc.index.pageLines.get(line.page) ?? [])
    .filter((l) => l !== line && Math.abs(centreY(l) - centreY(line)) <= 0.4 * h && l.bbox.x0 >= line.bbox.x1 - 1)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0)
  const parts = [line]
  for (const l of row) {
    const prev = parts[parts.length - 1]!
    if (l.bbox.x0 - prev.bbox.x1 > 1.5 * h) break
    if (!l.text.trim().split(/\s+/).every((t) => /^[A-Z0-9]{1,6}$/.test(t))) break
    parts.push(l)
  }
  return { text: parts.map((l) => l.text).join(' '), wordIds: parts.flatMap((l) => l.wordIds) }
}

/**
 * Bank accounts outside the IBAN and Israeli formats, written the way the field wants them
 * (bank-branch-account digits): a UK sort code with its account ("20-45-77-00000125"), an
 * Australian BSB with its account ("083-417-000000126"), or a plain account number under an
 * account label in a bank-payment context (a US routing number is not part of it).
 */
export function foreignAccount(text: string, bankContext: boolean): Found<BankValue> | null {
  const acct = /(?<![\p{L}])(?:account(?:\s*(?:no\.?|number|#))?|acct\.?(?:\s*no\.?)?|a\/c(?:\s*no\.?)?)\s*[:#]?\s*(\d[\d\s-]{4,30}\d)(?!\d)/iu.exec(text)
  if (!acct) return null
  const account = acct[1]!.replace(/\D/g, '')
  if (account.length < 6 || account.length > 20) return null
  const accStart = acct.index
  const accEnd = acct.index + acct[0].length
  const branch =
    /(?<![\p{L}])sort\s*code\s*[:#]?\s*(\d{2})[-\s]?(\d{2})[-\s]?(\d{2})(?!\d)/iu.exec(text) ?? /(?<![\p{L}])BSB\s*[:#]?\s*(\d{3})[-\s]?(\d{3})(?!\d)/u.exec(text)
  if (branch) {
    const parts = branch.slice(1).filter(Boolean)
    const start = Math.min(branch.index, accStart)
    const end = Math.max(branch.index + branch[0].length, accEnd)
    return { value: { value: [...parts, account].join('-'), scheme: 'bank-branch-account', checksum: null }, raw: text.slice(start, end), start, end }
  }
  if (!bankContext) return null
  const start = accStart + acct[0].indexOf(acct[1]!)
  return { value: { value: account, scheme: 'bank-branch-account', checksum: null }, raw: acct[1]!, start, end: start + acct[1]!.length }
}

function bankDrafts(fc: FieldsContext, customerLines: Set<string>, supplierLines: Set<string>): Draft[] {
  const out: Draft[] = []
  const seen = new Set<string>()
  for (const line of fc.index.doc.lines) {
    if (customerLines.has(line.id) || fc.paymentLineIds.has(line.id) || fc.itemLineIds.has(line.id)) continue
    if (PAYMENT_ROW.test(line.text)) continue
    const own = withRowGroups(fc, line)
    let text = own.text
    let wordIds = own.wordIds
    const block = fc.index.block.get(line.blockId)
    const context = block ? block.lineIds.map((id) => fc.index.line.get(id)?.text ?? '').join(' ') : text
    const read = (t: string) => readBankAccount(t) ?? foreignAccount(t, BANK_CONTEXT.test(context))
    let b = read(text)
    if (!b && BANK_WORDS.test(text)) {
      // Bank, branch and account on consecutive lines of one block (or side by side on its row).
      const idx = block ? block.lineIds.indexOf(line.id) : -1
      if (block && idx >= 0) {
        const next = block.lineIds.slice(idx + 1, idx + 3).map((id) => fc.index.line.get(id)!).filter(Boolean).map((l) => withRowGroups(fc, l))
        text = [own.text, ...next.map((l) => l.text)].join(' ')
        wordIds = [...own.wordIds, ...next.flatMap((l) => l.wordIds)]
        b = read(text)
      }
    }
    if (!b) continue
    const ids = wordsOfSpan(fc.index, wordIds, b.start, b.end)
    const key = b.value.value
    // The account alone after its sort code / BSB / bank and branch were read with it.
    if (!ids.length || seen.has(key) || [...seen].some((k) => k.endsWith(`-${key}`))) continue
    seen.add(key)
    const labelled = BANK_WORDS.test(text)
    const inSupplier = supplierLines.has(line.id)
    const iban = b.value.scheme === 'iban'
    // The bank words printed around the number are its label ("IBAN:", "בנק … סניף … חשבון").
    const labelIds = wordIds.filter((id) => {
      const t = fc.index.word.get(id)?.text ?? ''
      return BANK_WORDS.test(t) && !/\d/.test(t)
    })
    // Bank, branch and account each named: the format itself says what the number is.
    const spelled = !iban && /בנק|bank/i.test(b.raw) && /סניף|סנ['׳]|branch/i.test(b.raw) && /חשבון|ח-ן|ח"ן|account|acct/i.test(b.raw)
    // "פרטי חשבון: בנק מרכנתיל 17-969-000117": a bank-details label in front of the number.
    const headed = !iban && senseOf(text).matches.some((m) => m.concept === 'party.bank_account' && m.strength === 'strong')
    out.push({
      field: 'supplier.bank_account',
      rawValue: b.raw,
      normalized: { kind: 'id', value: b.value.value, scheme: b.value.scheme, checksum: b.value.checksum },
      valueWordIds: ids,
      labelWordIds: labelIds.length ? labelIds : null,
      originalLabel: labelIds.length ? labelIds.map((id) => fc.index.word.get(id)!.text).join(' ') : null,
      score: iban ? (b.value.checksum ? 0.82 : 0.5) : spelled || headed ? 0.78 : labelled ? 0.7 : 0.45,
      // Printed bank words ("IBAN:", "בנק … סניף … חשבון") are a label, not a guess by pattern.
      method: labelIds.length ? (iban ? 'party:iban' : 'party:bank-details') : iban ? 'pattern:iban' : 'pattern:bank-account',
      signals: inSupplier ? ['role:supplier'] : [],
    })
  }
  // An IBAN is what the field wants when both forms of one account are printed.
  if (out.some((d) => d.normalized.kind === 'id' && d.normalized.scheme === 'iban' && d.score >= 0.8)) {
    for (const d of out) if (d.normalized.kind === 'id' && d.normalized.scheme !== 'iban') d.score = Math.min(d.score, 0.2)
  }
  return out
}

// ---------------------------------------------------------------------------------------------

export interface PartyResult {
  drafts: Draft[]
  usedLineIds: string[]
}

export function partyDrafts(fc: FieldsContext, title: Line | null): PartyResult {
  const regions = partyRegions(fc, title)
  const drafts: Draft[] = []
  const used = new Set<string>()
  for (const r of regions) {
    if (r.role === 'ship_to') continue
    const pairs = pairsIn(fc, r.lineIds)
    const field = (f: string) => `${r.role}.${f}` as CanonicalField
    drafts.push(...nameDrafts(fc, r, field('name'), pairs))
    drafts.push(...addressDrafts(fc, r, field('address'), pairs))
    drafts.push(...taxIdDrafts(fc, r, field('tax_id'), pairs))
    if (r.role === 'supplier') drafts.push(...contactDrafts(fc, r, pairs))
    for (const id of r.lineIds) used.add(id)
  }
  const customerLines = new Set(regions.filter((r) => r.role !== 'supplier').flatMap((r) => [...r.lineIds]))
  // Only a confirmed supplier region lends its role to the bank details printed in it.
  const supplierLines = new Set(regions.filter((r) => r.role === 'supplier' && r.confirmed).flatMap((r) => [...r.lineIds]))
  drafts.push(...ownerDrafts(fc, drafts, customerLines))
  drafts.push(...bankDrafts(fc, customerLines, supplierLines))
  // The seller named under a supplier marker ("Sold by", "ספק"): contacts elsewhere on the page may
  // be a platform's or a printer's, so an orphan e-mail must be the seller's own domain.
  const marked = regions.some((r) => r.role === 'supplier' && r.kind === 'marker' && r.confirmed)
  // Only a Latin-script name can be compared with an e-mail domain.
  const seller = marked ? drafts.find((d) => d.field === 'supplier.name' && d.method.startsWith('party:marker') && hasLegalSuffix(d.rawValue) && /[a-z]{3}/i.test(d.rawValue)) : undefined
  const names = seller ? drafts.filter((d) => d.field === 'supplier.name').map((d) => d.rawValue) : null
  drafts.push(...orphanDrafts(fc, drafts, customerLines, names))
  return { drafts, usedLineIds: [...used] }
}

/**
 * The legal name behind a trading name: when the issuer's best name has no legal suffix, a line
 * that mentions that name together with a legal entity ("השם המסחרי "קפה שחור-לבן" הוא בבעלות
 * נ.ע. משקאות ושיווק (2019) בע"מ", "… is a trading name of … Pty Ltd") names the legal one, which
 * the field wants.
 */
function ownerDrafts(fc: FieldsContext, drafts: readonly Draft[], customerLines: Set<string>): Draft[] {
  const names = drafts.filter((d) => d.field === 'supplier.name').sort((a, b) => b.score - a.score)
  const best = names[0]
  if (!best || hasLegalSuffix(best.rawValue)) return []
  for (const line of fc.index.pageLines.get(fc.index.doc.pages[0]?.number ?? 1) ?? []) {
    if (customerLines.has(line.id) || names.some((n) => n.valueWordIds.some((id) => line.wordIds.includes(id)))) continue
    // The sentence names one of the issuer's printed names (the trading name, the logo line).
    const span = names.map((n) => legalOwner(line.text, n.rawValue)).find((x) => x)
    if (!span) continue
    const ids = wordsInSpan(fc.index, line, span.start, span.end)
    if (!ids.length) continue
    const t = readText(ids.map((id) => fc.index.word.get(id)!.text).join(' '))!
    const out: Draft[] = [{ field: 'supplier.name', rawValue: t.value, normalized: { kind: 'text', value: t.value }, valueWordIds: ids, labelWordIds: null, originalLabel: null, score: Math.min(0.85, best.score + 0.06), method: 'party:legal-owner', signals: [] }]
    // The entity's address printed with it ("…בע"מ, ח.פ. …, רח' הקלייה 4, לוד 7124004",
    // "Hollerbach Bürotechnik GmbH · Friedrichstraße 112 · 10117 Berlin").
    const addr = addressAfter(line.text, span.end)
    if (addr && !drafts.some((d) => d.field === 'supplier.address' && d.score >= 0.6)) {
      const aIds = wordsInSpan(fc.index, line, addr.start, addr.end)
      if (aIds.length) out.push({ field: 'supplier.address', rawValue: addr.text, normalized: { kind: 'text', value: addr.text }, valueWordIds: aIds, labelWordIds: null, originalLabel: null, score: 0.6, method: 'party:legal-owner', signals: [] })
    }
    return out
  }
  return []
}

/** The address pieces that follow a name on its line (separated by · | , ;), joined with ", ". */
function addressAfter(text: string, from: number): { text: string; start: number; end: number } | null {
  const pieces = [...text.slice(from).matchAll(/[^·|,;]+/g)]
    .map((m) => ({ raw: m[0], start: from + m.index + (m[0].length - m[0].trimStart().length), text: m[0].trim().replace(/[.\s]+$/, '') }))
    .filter((p) => p.text)
  const parts: typeof pieces = []
  for (const p of pieces) {
    const ok = addressScore(p.text) >= 0.65 || (parts.length > 0 && cityLike(p.text))
    if (ok) parts.push(p)
    else if (parts.length) break
  }
  if (!parts.length) return null
  const last = parts[parts.length - 1]!
  return { text: parts.map((p) => p.text).join(', '), start: parts[0]!.start, end: last.start + last.text.length }
}

/** The e-mail's domain spells a word of the name ("billing@lumenspire.example" for "Lumenspire Analytics"). */
export function domainOf(email: string, name: string): boolean {
  const host = (email.split('@')[1] ?? '').toLowerCase().split('.')[0]!.replace(/[^a-z0-9]/g, '')
  if (host.length < 3) return false
  const words = name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
  return words.some((w) => host.includes(w) || (host.length >= 4 && w.includes(host)))
}

/** The party regions of a document (exported for debugging and tests). */
export function partyRegions(fc: FieldsContext, title: Line | null): Region[] {
  const stops = new Set<string>(title ? [title.id] : [])
  const regions = markerRegions(fc, stops)
  const taken = new Set(regions.flatMap((r) => [...r.lineIds]))
  let head = letterhead(fc, new Set(regions.filter((r) => r.role !== 'supplier').flatMap((r) => [...r.lineIds])), title)
  // On a receipt, "מאת: X" / "From: X" under the issuer's letterhead says whom the money came from.
  const receipt = fc.docType === 'receipt' || fc.docType === 'tax_invoice_receipt'
  if (receipt && head?.confirmed) {
    for (const r of regions) {
      if (r.role === 'supplier' && r.marker && FROM.test(r.marker.text.trim()) && ![...head.lineIds].some((id) => r.lineIds.has(id))) r.role = 'customer'
    }
    head = letterhead(fc, new Set(regions.filter((r) => r.role !== 'supplier').flatMap((r) => [...r.lineIds])), title)
  }
  const supplierMarked = regions.some((r) => r.role === 'supplier' && r.segments.length)
  if (head && (!supplierMarked || ![...head.lineIds].some((id) => taken.has(id)))) {
    if (supplierMarked) head.confirmed = false
    regions.push(head)
    for (const id of head.lineIds) taken.add(id)
  }
  if (!regions.some((r) => r.role === 'customer')) {
    const unmarked = unmarkedCustomer(fc, taken, title)
    if (unmarked) regions.push(unmarked)
  }
  return regions
}

/**
 * Supplier contacts and ids printed outside any party region (footers, a contact strip): weak
 * candidates, only when the regions gave none.
 */
function orphanDrafts(fc: FieldsContext, have: readonly Draft[], customerLines: Set<string>, sellerNames: readonly string[] | null): Draft[] {
  const out: Draft[] = []
  const missing = (f: CanonicalField) => !have.some((d) => d.field === f)
  const sellers = (email: string) => sellerNames === null || sellerNames.some((n) => domainOf(email, n))
  const free = fc.pairs.filter((p) => !p.labelLineIds.some((id) => customerLines.has(id)) && !fc.paymentLineIds.has(p.labelLineIds[0] ?? ''))
  for (const p of free) {
    const c = p.sense.concepts
    if (missing('supplier.email') && c.includes('party.email')) {
      const e = readEmail(p.value.text)
      if (e && sellers(e.value)) out.push({ field: 'supplier.email', rawValue: e.raw, normalized: { kind: 'text', value: e.value }, valueWordIds: wordsOfSpan(fc.index, p.value.wordIds, e.start, e.end), labelWordIds: p.label.wordIds, originalLabel: p.sense.text, score: 0.5, method: 'party:orphan:label', signals: [] })
    }
    if (missing('supplier.phone') && c.includes('party.phone') && !c.includes('trap.fax')) {
      const ph = readPhone(p.value.text)
      if (ph) out.push({ field: 'supplier.phone', rawValue: ph.raw, normalized: { kind: 'text', value: ph.value }, valueWordIds: wordsOfSpan(fc.index, p.value.wordIds, ph.start, ph.end), labelWordIds: p.label.wordIds, originalLabel: p.sense.text, score: 0.4, method: 'party:orphan:label', signals: [] })
    }
    if (missing('supplier.tax_id') && (c.includes('party.tax_id') || c.includes('supplier.tax_id'))) {
      const t = readTaxId(p.value.text, taxIdHint(p))
      if (t && (t.value.scheme || taxIdHint(p).country)) {
        out.push({ field: 'supplier.tax_id', rawValue: t.raw, normalized: { kind: 'id', value: t.value.value, scheme: t.value.scheme, checksum: t.value.checksum }, valueWordIds: wordsOfSpan(fc.index, p.value.wordIds, t.start, t.end), labelWordIds: p.label.wordIds, originalLabel: p.sense.text, score: 0.4, method: 'party:orphan:label', signals: [] })
      }
    }
  }
  if (missing('supplier.email')) {
    for (const line of fc.index.doc.lines) {
      if (customerLines.has(line.id)) continue
      const e = readEmail(line.text)
      if (!e || !sellers(e.value)) continue
      out.push({ field: 'supplier.email', rawValue: e.raw, normalized: { kind: 'text', value: e.value }, valueWordIds: wordsInSpan(fc.index, line, e.start, e.end), labelWordIds: null, originalLabel: null, score: 0.4, method: 'pattern:email', signals: [] })
      break
    }
  }
  return out
}
