import type { CanonicalField, ValidationCheck } from '../model/types'
import { foldForMatch } from '../lib/text'
import { CUES, OCR, PRIOR, SIGNAL } from './policy'
import { overlaps, wordIdsOf } from './evidence'
import { partyCue, rolesOf, type DecideContext } from './decide'
import type { ValueGroup } from './groups'
import { otherParty, printParty } from './roles'
import { competitorsOf, conflictsWith, textConfidence, textOf, type Choice, type Decision } from './single'

/**
 * Party names. A name has no checksum and no arithmetic, and the interpreter's role assignment
 * (supplier vs customer vs bank vs delivery address) is the error-prone part. A name is verified
 * only through a chain of independent role evidence (STATUS_POLICY.name):
 *
 *   - a single candidate with a strong prior and a party marker (role signal or ספק/לכבוד label),
 *   - a legal-entity suffix (בע"מ, Ltd, GmbH…): the ground truth wants the legal name, and a
 *     suffix shows we are not holding the trading name,
 *   - the whole printed line(s), so it is not a fragment of a wrapped name,
 *   - in the same block as that party's verified, checksum-valid tax id,
 *   - different from the other party's name.
 *
 * Everything else is at most 'proposed'.
 */

export type Party = 'supplier' | 'customer'

export function partyOf(field: CanonicalField): Party | null {
  return field.startsWith('supplier.') ? 'supplier' : field.startsWith('customer.') ? 'customer' : null
}

/** Whether the name carries a legal-entity suffix (whole-token match for the short Latin ones). */
export function hasLegalSuffix(name: string): boolean {
  const folded = foldForMatch(name)
  const tokens = new Set(folded.split(/[\s,()]+/).map((t) => t.replace(/\.+$/, '')).filter(Boolean))
  return CUES.legalSuffix.some((cue) => {
    const c = foldForMatch(cue)
    if (/[\s"'()]/.test(c) || /[א-ת]/.test(c)) return folded.includes(c)
    return tokens.has(c.replace(/\.+$/, ''))
  })
}

export function decideName(choice: Choice, ctx: DecideContext): Decision {
  const field = choice.field
  const party = partyOf(field)!
  const g = choice.ranked[choice.index]!
  const alts = choice.ranked.filter((x) => x !== g)
  const conf = textConfidence(g, ctx.doc)
  const weak = conf < OCR.weak
  const value = textOf(g.rep.normalized, g.rep.rawValue)
  const failed: string[] = []

  if (choice.roleConflict) failed.push(`also read as ${choice.roleConflict}`)
  if (competitorsOf(g, alts).length) failed.push('competing names')
  if (g.prior < PRIOR.name) failed.push(`prior ${g.prior.toFixed(2)} < ${PRIOR.name}`)
  const marker = g.candidates.some((c) => c.signals.includes(party === 'supplier' ? SIGNAL.roleSupplier : SIGNAL.roleCustomer) || partyCue(party, c.originalLabel))
  if (!marker) failed.push(`no ${party} marker`)
  if (!hasLegalSuffix(value)) failed.push('no legal-entity suffix')
  const labelWords = g.rep.label ? g.rep.label.wordIds : []
  const covers = ctx.doc.coversLines(wordIdsOf(g.rep.evidence), labelWords)
  if (covers === null) failed.push('words unknown')
  else if (!covers && !wholeSegment(wordIdsOf(g.rep.evidence), labelWords, ctx)) failed.push('part of a longer line')
  const glued = gluedLabel(g, ctx)
  if (glued) failed.push(`"${glued}" is printed flush against the name and may be part of it`)
  const noun = leadingPartyNoun(value)
  if (noun) failed.push(`starts with the party word "${noun}", which may be a label`)
  if (conf < OCR.labelOnly) failed.push('low text confidence')
  const taxId = ctx.decided.get(party === 'supplier' ? 'supplier.tax_id' : 'customer.tax_id')
  const taxIdChecked = taxId?.status === 'verified' && taxId.passed.some((c) => c.id.startsWith('checksum:'))
  if (!taxIdChecked) failed.push(`${party} tax id not checksum-verified`)
  else {
    const a = ctx.doc.blocksOf(g.wordIds)
    const b = ctx.doc.blocksOf(taxId.group.wordIds)
    if (!a.size || !b.size || !overlaps(a, b)) failed.push('not in the tax id block')
  }
  const otherField: CanonicalField = party === 'supplier' ? 'customer.name' : 'supplier.name'
  const other = ctx.decided.get(otherField)
  if (other && other.group.key === g.key) failed.push(`same as ${otherField}`)
  // The page's own markers must not say it is the other party's (the interpreter's letterhead
  // guess can be an addressee block under an abbreviation it does not know).
  const own = g.candidates.map((c) => printParty(rolesOf(ctx), wordIdsOf(c.evidence), c.originalLabel))
  if (own.includes(otherParty(party)) && !own.includes(party)) failed.push(`printed under the ${otherParty(party)} marker`)
  // Two legal names of one party in two scripts: both are right, so neither is verified over the other.
  const twin = bilingualTwin(g, taxId?.group ?? null, alts, ctx)
  if (twin) failed.push(`also printed as "${twin}"`)

  const base = (status: Decision['status'], extra: Partial<Decision> = {}): Decision => ({
    field,
    group: g,
    alternatives: alts,
    normalized: g.rep.normalized,
    status,
    passed: [],
    report: [],
    issues: [],
    exact: 0,
    failed: 0,
    competitor: false,
    ambiguous: false,
    weakText: weak,
    ...extra,
  })

  if (!failed.length) {
    const check: ValidationCheck = {
      id: `role:${field}`,
      status: 'pass',
      fields: [field, party === 'supplier' ? 'supplier.tax_id' : 'customer.tax_id'],
      expected: null,
      actual: value,
      message: `"${value}" is the full ${party} line under a ${party} marker, has a legal-entity suffix and sits in the same block as the checksum-valid tax id ${textOf(taxId!.group.rep.normalized, taxId!.group.rep.rawValue)}.`,
    }
    return base('verified', { passed: [check], report: [check], exact: 1 })
  }
  if (choice.roleConflict || conflictsWith(g, alts)) {
    return base('needs_review', {
      competitor: true,
      issues: [{ severity: 'warning', code: 'conflict.candidates', message: `${field}: "${value}" competes with ${alts.map((a) => `"${a.rep.rawValue}"`).join(', ') || choice.roleConflict}.`, fields: [field] }],
    })
  }
  if (g.prior < PRIOR.proposedMin || weak) return base('needs_review')
  const issues: Decision['issues'] = twin
    ? [{ severity: 'info', code: 'name.bilingual', message: `${field}: "${value}" and "${twin}" are the same party's legal name in two scripts; neither is verified over the other.`, fields: [field] }]
    : []
  return base('proposed', { competitor: competitorsOf(g, alts).length > 0, issues })
}

/**
 * The label of a name read from its own line, printed flush against the name: the next word in
 * reading order, with no colon, dash or separator between them and in the same type. "לקוח הדמו
 * בע"מ" then reads as label + name or as one name ("Client Focus Ltd." starts with a label word
 * too), and nothing on the page tells which. A salutation never begins a name ("לכבוד", "Bill
 * to"), and a label set in another type (a regular "Customer" before a bold name) is a label.
 * Returns the label's text when it is ambiguous, else null.
 */
export function gluedLabel(g: ValueGroup, ctx: DecideContext): string | null {
  const label = g.rep.label
  if (!label?.wordIds.length) return null
  const lastLabel = label.wordIds[label.wordIds.length - 1]!
  const line = ctx.doc.lineOfWord(lastLabel)
  if (!line) return null
  const valueIds = new Set(wordIdsOf(g.rep.evidence))
  const at = line.wordIds.indexOf(lastLabel)
  const next = line.wordIds[at + 1]
  if (next === undefined || !valueIds.has(next)) return null
  const labelWords = label.wordIds.map((id) => ctx.doc.word(id))
  const valueWords = line.wordIds.filter((id) => valueIds.has(id)).map((id) => ctx.doc.word(id))
  if (labelWords.some((w) => !w) || valueWords.some((w) => !w) || !valueWords.length) return null
  if (/[:：\-–—]$/.test(labelWords[labelWords.length - 1]!.text) || /^[:：\-–—]/.test(valueWords[0]!.text)) return null
  if (isSalutation(label.text)) return null
  const bold = (ws: typeof labelWords) => ws.every((w) => w!.bold)
  const size = (ws: typeof labelWords) => ws.reduce((s, w) => s + w!.fontSize, 0) / ws.length
  const ratio = size(labelWords) / size(valueWords)
  const sameType = bold(labelWords) === bold(valueWords) && ratio > 1 / 1.15 && ratio < 1.15
  return sameType ? label.text : null
}

/**
 * The party noun a name starts with ("לקוח הדמו בע"מ", "Client Focus Ltd."), or null. Whether the
 * noun is a label printed flush against the name or the name's first word, the page cannot tell.
 */
export function leadingPartyNoun(name: string): string | null {
  const folded = foldForMatch(name)
  for (const cue of [...CUES.customerLabel, ...CUES.supplierLabel]) {
    if (isSalutation(cue)) continue
    const c = foldForMatch(cue)
    if (folded.startsWith(c + ' ') && /[\p{L}\p{N}]/u.test(folded.slice(c.length))) return cue
  }
  return null
}

function isSalutation(text: string): boolean {
  const t = foldForMatch(text).replace(/[\s:：.,\-–—]+$/u, '').trim()
  if (CUES.salutation.some((s) => foldForMatch(s) === t)) return true
  return /(^|\s)(to|from|by)$/.test(t)
}

/** Separator tokens that split a printed line into independent pieces ("X בע"מ · ח.פ. 123 · רח' …"). */
const SEPARATOR = /^[·|•]+$/

/**
 * The value is a whole piece of its line(s): every word next to it is a separator (·, |, •) or the
 * line's edge, so a line like "קווים-נט תקשורת בע"מ · ח.פ. 51-544720-9" holds the whole name.
 */
function wholeSegment(valueIds: readonly string[], labelIds: readonly string[], ctx: DecideContext): boolean {
  const inValue = new Set([...valueIds, ...labelIds])
  const lines = new Set(valueIds.map((id) => ctx.doc.lineOfWord(id)).filter((l) => !!l))
  if (!lines.size) return false
  for (const line of lines) {
    const ids = line!.wordIds
    for (let i = 0; i < ids.length; i++) {
      if (!inValue.has(ids[i]!)) continue
      const before = ids[i - 1]
      const after = ids[i + 1]
      for (const n of [before, after]) {
        if (n === undefined || inValue.has(n)) continue
        if (!SEPARATOR.test((ctx.doc.word(n)?.text ?? '').trim())) return false
      }
    }
  }
  return true
}

function scriptOf(s: string): 'hebrew' | 'latin' | null {
  const he = (s.match(/[א-ת]/g) ?? []).length
  const la = (s.match(/[A-Za-zÀ-ž]/g) ?? []).length
  if (he >= 3 && he >= la) return 'hebrew'
  if (la >= 3) return 'latin'
  return null
}

/**
 * A legal name in the other script printed next to this one (same line or same block as the name
 * or its tax id, or another candidate of the field): "Lumenspire Analytics Ltd. (לומנספייר
 * אנליטיקס בע"מ)". Returns the twin's text, or null.
 */
export function bilingualTwin(g: ValueGroup, taxId: ValueGroup | null, alts: readonly ValueGroup[], ctx: DecideContext): string | null {
  const value = textOf(g.rep.normalized, g.rep.rawValue)
  const script = scriptOf(value)
  if (!script) return null
  const isTwin = (s: string) => {
    const t = s.trim()
    return scriptOf(t) !== null && scriptOf(t) !== script && hasLegalSuffix(t)
  }
  for (const a of alts) {
    const t = textOf(a.rep.normalized, a.rep.rawValue)
    if (a.prior >= PRIOR.competitorMin && isTwin(t)) return t
  }
  const blocks = new Set([...ctx.doc.blocksOf(g.wordIds), ...(taxId ? ctx.doc.blocksOf(taxId.wordIds) : [])])
  const lines = new Set([...blocks].flatMap((b) => ctx.doc.linesOfBlock(b)))
  // A mirrored bilingual letterhead prints the other name in the other column, level with this one.
  for (const id of g.wordIds) {
    const own = ctx.doc.lineOfWord(id)
    if (!own) continue
    for (const l of ctx.doc.pageLines(own.page)) {
      if (Math.min(l.bbox.y1, own.bbox.y1) - Math.max(l.bbox.y0, own.bbox.y0) > 0.5 * Math.min(l.bbox.y1 - l.bbox.y0, own.bbox.y1 - own.bbox.y0)) lines.add(l)
    }
  }
  for (const line of lines) {
    const rest = line.wordIds.filter((id) => !g.wordIds.has(id)).map((id) => ctx.doc.word(id)?.text ?? '').join(' ')
    for (const seg of rest.split(/[()|·•,/]/)) if (isTwin(seg)) return seg.trim()
  }
  return null
}
