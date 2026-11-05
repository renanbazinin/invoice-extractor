import type { CanonicalField, Line } from '../model/types'
import { foldForMatch } from '../lib/text'
import { matchLabels, parseTaxId, type LabelMatch } from '../semantic'
import { CUES, PRIOR } from './policy'
import type { DocIndex } from './evidence'
import type { ValueGroup } from './groups'
import { checksumOf } from './single'

/**
 * Whose is it? A checksum proves that an identifier was read correctly, never whose it is: the
 * customer's ח.פ under "לכב'" passes the very same check digit as the supplier's. Party roles are
 * the interpreter's most error-prone guess, so validation re-reads the role evidence itself, from
 * the page:
 *
 *  - a role marker heading the value's region: the nearest marker line at or above the value in
 *    its own block, the heading line directly above that block, or the role heading of the grid
 *    column the value is printed in ("לכבוד", "לכב'", "Bill to", "ספק", "Sold by" …);
 *  - an addressee line inside the block ("לידי:", "Attn:") marks the customer's block;
 *  - a label that names the party ("ח.פ. לקוח", "Customer VAT no.");
 *  - every other party identifier printed on the page (a labelled ח.פ / VAT no. / ABN …): when one
 *    of them could be this party's, a value without an explicit marker is only a guess.
 *
 * On a receipt, "מאת" / "From" names the payer (the customer), not the issuer.
 *
 * Markers come from the shared lexicon (role.* and party-specific field concepts), plus a few
 * abbreviations it does not list yet (CUES.customerMarkerExtra, CUES.addressee).
 */

export type Party = 'supplier' | 'customer'

export interface RoleContext {
  doc: DocIndex
  /** Receipt-type document: "מאת" / "From" is the payer. */
  receipt: boolean
}

export function otherParty(p: Party): Party {
  return p === 'supplier' ? 'customer' : 'supplier'
}

export function partyOfField(field: CanonicalField): Party | null {
  return field.startsWith('supplier.') ? 'supplier' : field.startsWith('customer.') ? 'customer' : null
}

/** The party a lexicon match names on its own: role markers and single-party field labels. */
function conceptParty(m: LabelMatch): Party | null {
  if (m.concept === 'role.supplier') return 'supplier'
  if (m.concept === 'role.customer') return 'customer'
  if (m.kind !== 'field' || !m.fields.length) return null
  const parties = new Set(m.fields.map(partyOfField))
  return parties.size === 1 ? [...parties][0]! : null
}

/** Words that may stand before a marker without making it a sentence ("פרטי לקוח", "Customer details"). */
const FRAMING = /^(?:\s|פרטי|פרטים|שם|details|name|[:\-–|·•*])+/iu

/** "From" words: the issuer on an invoice, the payer on a receipt. */
const FROM = /^(?:מאת|from|von|de|da|van)$/iu

/**
 * Letter-spaced headings ("B I L L TO", "C U S TO M E R") are printed for looks; reading them
 * needs the letters joined, either run by run or all together.
 */
function variants(text: string): string[] {
  const tokens = text.trim().split(/\s+/)
  const single = (t: string) => [...t].length === 1 && /\p{L}/u.test(t)
  if (tokens.filter(single).length < 3) return [text]
  const runs: string[] = []
  let run = ''
  for (const t of tokens) {
    if (single(t)) run += t
    else {
      if (run) runs.push(run)
      run = ''
      runs.push(t)
    }
  }
  if (run) runs.push(run)
  return [text, runs.join(' '), tokens.join('')]
}

interface MarkerInfo {
  party: Party
  /**
   * A role heading (לכבוד / ספק / Bill to / Sold by) opens a region below it; a party-specific
   * field label ("שם העסק", "כתובת הלקוח") only marks its own line and block.
   */
  heading: boolean
  /** The marker is a bare "from" word ("מאת", "From"): the payer on a receipt. */
  from: boolean
}

function markerOf(text: string): MarkerInfo | null {
  const folded = foldForMatch(text).trim()
  for (const cue of CUES.customerMarkerExtra) {
    const c = foldForMatch(cue)
    if (folded.startsWith(c) && !/^\p{L}/u.test(folded.slice(c.length))) return { party: 'customer', heading: true, from: false }
  }
  const ms = matchLabels(text).sort((a, b) => a.start - b.start)
  const m = ms.find((x) => !text.slice(0, x.start).replace(FRAMING, '').trim())
  if (!m) return null
  const party = conceptParty(m)
  if (!party) return null
  const info: MarkerInfo = { party, heading: m.kind === 'role', from: party === 'supplier' && FROM.test(foldForMatch(m.phrase).trim()) }
  const rest = text.slice(m.end)
  const alone = !/[\p{L}\p{N}]/u.test(rest)
  const colon = /^\s*[:：\-–]/.test(rest)
  if (alone || colon) return info
  // A bilingual heading repeats the marker: "פרטי לקוח / Bill To".
  const sep = /^\s*[/|]\s*/.exec(rest)
  if (sep && markerOf(rest.slice(sep[0].length))?.party === party) return info
  // Inline content without a colon: only the unmistakable addressee forms ("לכבוד X", "מאת X")
  // and multi-word markers, followed by a name (not a date or a number: "From 01/08 to 30/09").
  if (m.strength === 'weak' || !/^\s*\p{L}/u.test(rest)) return null
  const phrase = foldForMatch(m.phrase)
  if (phrase === 'לכבוד' || phrase === 'מאת' || /\s/.test(phrase)) {
    // "Customer service", "Supplier code" … are not markers even when the lexicon has the phrase.
    if (/^\s*(service|care|support|code|number|no\b|id\b|portal|account)/i.test(rest)) return null
    return info
  }
  return null
}

function markerInfo(text: string): MarkerInfo | null {
  for (const t of variants(text)) {
    const p = markerOf(t)
    if (p) return p
  }
  return null
}

const lineMarkers = new WeakMap<Line, MarkerInfo | null>()

/** markerInfo of a document line, memoized (region searches ask about the same lines often). */
function infoOfLine(l: Line): MarkerInfo | null {
  let p = lineMarkers.get(l)
  if (p === undefined) lineMarkers.set(l, (p = markerInfo(l.text)))
  return p
}

function partyOfInfo(info: MarkerInfo | null, receipt: boolean): Party | null {
  if (!info) return null
  return receipt && info.from ? 'customer' : info.party
}

/**
 * The party a line opens, when it starts with a role marker: a heading ("לכבוד", "Bill To:"), or
 * an inline marker followed by a colon ("לקוח: …") — "לכבוד X" also without one. A single-word
 * marker inside running text ("Customer service: …", "לקוחות יקרים") is not a heading.
 */
export function lineMarker(text: string, receipt = false): Party | null {
  return partyOfInfo(markerInfo(text), receipt)
}

/** The party a candidate's own label names ("ח.פ. לקוח" → customer), or null. */
export function labelParty(label: string | null | undefined, receipt = false): Party | null {
  if (!label) return null
  const parties = new Set<Party>()
  for (const v of variants(label)) {
    for (const m of matchLabels(v)) {
      const p = conceptParty(m)
      if (!p) continue
      // On a receipt "מאת X" names the payer.
      parties.add(receipt && p === 'supplier' && FROM.test(foldForMatch(m.phrase).trim()) ? 'customer' : p)
    }
  }
  return parties.size === 1 ? [...parties][0]! : null
}

/** An addressee line ("לידי: …", "Attn: …"): only the billed party's block prints one. */
function addresseeLine(text: string): boolean {
  const t = foldForMatch(text).trim()
  return CUES.addressee.some((c) => {
    const cue = foldForMatch(c)
    return t.startsWith(cue) && !/^\p{L}/u.test(t.slice(cue.length))
  })
}

/** A heading sits at most this many of its own line heights above the block it heads. */
const HEADER_GAP_LINES = 1.8
const HEADER_GAP_MIN = 6

function height(l: Line): number {
  return Math.max(4, l.bbox.y1 - l.bbox.y0)
}

function xOverlap(a: Line['bbox'], b: Line['bbox']): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0
}

/**
 * The party of the region a value is printed in: the nearest marker line at or above the value
 * within its block, else the heading line just above the block (same column, a line pitch away),
 * else an addressee line anywhere in the block, else the role heading of the value's grid column.
 * Markers below the value open another party's region and say nothing about this one. null when
 * nothing marks the region.
 */
export function regionParty(rc: RoleContext, wordIds: Iterable<string>): Party | null {
  const { doc } = rc
  const first = [...wordIds].map((id) => doc.lineOfWord(id)).find((l): l is Line => !!l)
  if (!first) return null
  const blockLines = doc.linesOfBlock(first.blockId)
  const at = blockLines.findIndex((l) => l.id === first.id)
  for (let i = at; i >= 0; i--) {
    const p = partyOfInfo(infoOfLine(blockLines[i]!), rc.receipt)
    if (p) return p
  }
  const block = doc.block(first.blockId)
  if (!block) return null
  const top = block.bbox.y0
  const gapMax = Math.max(HEADER_GAP_MIN, HEADER_GAP_LINES * Math.max(...blockLines.map(height), 4))
  const above = doc
    .pageLines(block.page)
    .filter((l) => l.blockId !== block.id && l.bbox.y1 <= top + 1 && top - l.bbox.y1 <= gapMax && xOverlap(l.bbox, block.bbox))
  if (above.length) {
    const nearest = Math.max(...above.map((l) => l.bbox.y1))
    for (const l of above.filter((x) => nearest - x.bbox.y1 <= 2)) {
      const p = partyOfInfo(infoOfLine(l), rc.receipt)
      if (p) return p
    }
  }
  if (blockLines.some((l) => addresseeLine(l.text))) return 'customer'
  return columnParty(rc, first) ?? rowParty(rc, first)
}

/**
 * One-row party strips: "לכבוד: X   ח.פ.: Y   לידי: Z" prints the marker, the name, the id and the
 * contact as separate lines on one baseline. The value belongs to the nearest marker before it on
 * its row in reading order (to its right on an RTL line, to its left on an LTR one).
 */
function rowParty(rc: RoleContext, value: Line): Party | null {
  const h = height(value)
  const mid = (value.bbox.y0 + value.bbox.y1) / 2
  const rtl = value.dir === 'rtl'
  const before = rc.doc
    .pageLines(value.page)
    .filter((l) => l !== value && Math.abs((l.bbox.y0 + l.bbox.y1) / 2 - mid) <= 0.6 * Math.max(h, height(l)))
    .filter((l) => (rtl ? l.bbox.x0 >= value.bbox.x1 - 1 : l.bbox.x1 <= value.bbox.x0 + 1))
    .sort((a, b) => (rtl ? a.bbox.x0 - b.bbox.x0 : b.bbox.x1 - a.bbox.x1))
  for (const l of before) {
    const info = infoOfLine(l)
    // Only a role heading opens a strip; "שם העסק" on the same baseline labels the other card.
    if (info?.heading) return partyOfInfo(info, rc.receipt)
  }
  return null
}

/** A marker heads at most this many line heights of its column (a party card, not a page half). */
const COLUMN_MAX_LINES = 14
/** A gap of this many line heights inside the column ends the marker's region. */
const COLUMN_GAP_LINES = 3

/**
 * Grid layouts print a party card as separate label and value blocks under one heading ("ספק" over
 * "שם העסק | X / ח.פ. | Y", and "לכבוד" over the same grid one column to the left). The value
 * belongs to the nearest role heading above it whose column holds it: headings on one row split
 * the page width between them (an RTL heading's column runs leftwards from its right edge to the
 * next heading, an LTR one rightwards), and the column's lines from the heading down to the value
 * must follow each other without a wide gap.
 */
function columnParty(rc: RoleContext, value: Line): Party | null {
  const lines = rc.doc.pageLines(value.page)
  const h = height(value)
  const cx = (value.bbox.x0 + value.bbox.x1) / 2
  const markers = lines
    .map((l) => ({ l, info: infoOfLine(l) }))
    .filter((m) => m.info?.heading)
    .map((m) => ({ l: m.l, p: partyOfInfo(m.info, rc.receipt)! }))
  let best: { l: Line; p: Party; lo: number; hi: number } | null = null
  for (const m of markers) {
    const M = m.l
    if (M.bbox.y1 > value.bbox.y0 + 1 || value.bbox.y0 - M.bbox.y1 > COLUMN_MAX_LINES * h) continue
    const mid = (M.bbox.y0 + M.bbox.y1) / 2
    const row = markers.filter((x) => x.l !== M && Math.abs((x.l.bbox.y0 + x.l.bbox.y1) / 2 - mid) <= 1.5 * Math.max(height(M), height(x.l)))
    let lo: number
    let hi: number
    if (M.dir === 'rtl') {
      hi = M.bbox.x1 + 12
      lo = Math.max(0, ...row.filter((x) => x.l.bbox.x1 < M.bbox.x0).map((x) => x.l.bbox.x1))
    } else {
      lo = M.bbox.x0 - 12
      hi = Math.min(Number.MAX_VALUE, ...row.filter((x) => x.l.bbox.x0 > M.bbox.x1).map((x) => x.l.bbox.x0))
    }
    if (cx < lo || cx > hi) continue
    if (!best || M.bbox.y1 > best.l.bbox.y1) best = { ...m, lo, hi }
  }
  if (!best) return null
  const b = best
  // The column between the heading and the value must be one region: no wide vertical gap.
  const ys = lines
    .filter((l) => l.bbox.y0 >= b.l.bbox.y1 - 1 && l.bbox.y1 <= value.bbox.y1 + 1)
    .filter((l) => {
      const c = (l.bbox.x0 + l.bbox.x1) / 2
      return c >= b.lo && c <= b.hi
    })
    .map((l) => l.bbox.y0)
    .sort((x, y) => x - y)
  let prev = b.l.bbox.y0
  for (const y of [...ys, value.bbox.y0]) {
    if (y - prev > COLUMN_GAP_LINES * h) return null
    prev = Math.max(prev, y)
  }
  return b.p
}

// ---------------------------------------------------------------------------------------------
// Party identifiers on the page

/**
 * What kind of number a party-id label names. A VAT number and a company register number of the
 * same company are different facts, and only the first is a tax_id outside Israel.
 */
export type IdClass = 'tax' | 'register'

export function idClassOf(label: string | null | undefined): IdClass {
  return label && CUES.registerIdLabel.some((re) => re.test(foldForMatch(label))) ? 'register' : 'tax'
}

export interface PartyIdPrint {
  /** Comparison key, as ValueGroup.key ('i:' + value without separators, upper case). */
  key: string
  value: string
  wordIds: string[]
  label: string | null
  /** The party its label or region names explicitly, or null. */
  party: Party | null
  cls: IdClass
}

const ID_CONCEPTS = new Set(['party.tax_id', 'supplier.tax_id', 'customer.tax_id'])

function keyOf(value: string): string {
  return `i:${value.replace(/[\s\-./]/g, '').toUpperCase()}`
}

/** The party of one printing: its label first, else its region. */
export function printParty(rc: RoleContext, wordIds: readonly string[], label: string | null): Party | null {
  return labelParty(label, rc.receipt) ?? regionParty(rc, wordIds)
}

/**
 * Every party identifier printed on the page: the interpreter's tax-id candidates, and every value
 * that follows a tax-id label in a line of text (the fine print "…בע"מ, ח.פ. 510000052" that no
 * candidate holds). Israeli-shaped values count only with a valid check digit.
 */
export function partyIdsOnPage(rc: RoleContext, groups: Map<CanonicalField, ValueGroup[]>, israeli: boolean): PartyIdPrint[] {
  const out: PartyIdPrint[] = []
  for (const f of ['supplier.tax_id', 'customer.tax_id'] as const) {
    for (const g of groups.get(f) ?? []) {
      if (g.prior < PRIOR.competitorMin || checksumOf(g, israeli).valid === false) continue
      const n = g.rep.normalized
      const value = n.kind === 'id' || n.kind === 'text' ? n.value : g.rep.rawValue
      for (const c of g.candidates) {
        const ids = c.evidence.flatMap((e) => e.wordIds)
        out.push({ key: g.key, value, wordIds: ids, label: c.originalLabel, party: printParty(rc, ids, c.originalLabel), cls: idClassOf(c.originalLabel) })
      }
    }
  }
  for (const line of rc.doc.lines) {
    const ms = matchLabels(line.text).filter((m) => ID_CONCEPTS.has(m.concept) && m.strength !== 'weak' && !m.prefix)
    for (const m of ms) {
      const next = ms.filter((x) => x.start >= m.end).map((x) => x.start)
      const stop = Math.min(line.text.length, m.end + 40, ...next)
      let rest = line.text.slice(m.end, stop)
      const cut = rest.search(/[|·•,;]|\s{3,}/)
      if (cut > 0 && /\d/.test(rest.slice(0, cut))) rest = rest.slice(0, cut)
      const p = parseTaxId(rest, /[א-ת]/.test(m.text) ? { country: 'IL' } : {})
      if (!p) continue
      if (p.scheme === 'IL' && p.checksum !== true) continue
      if (!p.scheme && p.value.replace(/\D/g, '').length < 6) continue
      out.push({ key: keyOf(p.value), value: p.value, wordIds: line.wordIds, label: m.text, party: printParty(rc, line.wordIds, m.text), cls: idClassOf(m.text) })
    }
  }
  return out
}

/** How well the page backs a party identifier's role (STATUS_POLICY.identifier, party ids). */
export interface IdRole {
  /** Its label or region names the other party: it is (probably) not this party's. */
  opposite: boolean
  /** Its label or region names this party. */
  explicit: boolean
  /** Other identifiers on the page that could be this party's (not explicitly the other party's). */
  rivals: PartyIdPrint[]
  /** Rivals that are explicitly this party's too: two candidates with equally good evidence. */
  competing: PartyIdPrint[]
}

export function idRole(field: CanonicalField, g: ValueGroup, rc: RoleContext, prints: readonly PartyIdPrint[]): IdRole {
  const party = partyOfField(field)!
  const other = otherParty(party)
  const own = g.candidates.map((c) => printParty(rc, c.evidence.flatMap((e) => e.wordIds), c.originalLabel))
  const explicit = own.includes(party) && !own.includes(other)
  const opposite = own.includes(other) && !own.includes(party)
  const ownCls = g.candidates.some((c) => idClassOf(c.originalLabel) === 'tax') ? 'tax' : 'register'
  const byKey = new Map<string, PartyIdPrint[]>()
  for (const p of prints) {
    if (p.key === g.key) continue
    // A company register number does not compete with a VAT number: the field is the tax number.
    if (ownCls === 'tax' && p.cls === 'register') continue
    const list = byKey.get(p.key)
    if (list) list.push(p)
    else byKey.set(p.key, [p])
  }
  const rivals: PartyIdPrint[] = []
  const competing: PartyIdPrint[] = []
  for (const list of byKey.values()) {
    const parties = new Set(list.map((p) => p.party))
    if (parties.has(other) && !parties.has(party)) continue
    rivals.push(list[0]!)
    if (parties.has(party)) competing.push(list.find((p) => p.party === party)!)
  }
  return { opposite, explicit, rivals, competing }
}
