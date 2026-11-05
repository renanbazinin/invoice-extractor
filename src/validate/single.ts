import type { CanonicalField, FieldStatus, Issue, NormalizedValue, ValidationCheck } from '../model/types'
import { FIELD_KIND, OCR, PRIOR, SIGNAL, type FieldKind } from './policy'
import { checkIdentifier, type ChecksumResult } from './checksum'
import { overlaps, type DocIndex } from './evidence'
import type { ValueGroup } from './groups'

/**
 * Fields that take one printed value without arithmetic: identifiers, codes, contacts, terms,
 * names, addresses and dates. Choosing is ranking by prior (identifiers: a failing checksum costs
 * most of it), then making sure two fields do not claim the same printed words.
 */

export interface Choice {
  field: CanonicalField
  /** Best first. */
  ranked: ValueGroup[]
  /** Index of the chosen group in `ranked`, -1 when the field ends up absent. */
  index: number
  /** Set when another field claims the same words with a similar prior. */
  roleConflict: CanonicalField | null
}

/** The outcome for one field, before it becomes an ExtractedField. */
export interface Decision {
  field: CanonicalField
  group: ValueGroup
  alternatives: ValueGroup[]
  normalized: NormalizedValue
  status: FieldStatus
  /** Passing checks that involve the field (ids go to ExtractedField.checks). */
  passed: ValidationCheck[]
  /** Checks to report (passing or failing). */
  report: ValidationCheck[]
  issues: Issue[]
  /** For calibration. */
  exact: number
  failed: number
  competitor: boolean
  ambiguous: boolean
  weakText: boolean
  /** Leave the field out: the candidate is not this field's at all (with the reason). */
  drop?: Issue
}

const CHECKSUM_PENALTY = 0.3

/** Identifier fields that carry a checksum scheme we can recompute. */
export const CHECKSUM_FIELDS = new Set<CanonicalField>(['supplier.tax_id', 'customer.tax_id', 'supplier.bank_account'])

export function checksumOf(group: ValueGroup, israeli: boolean): ChecksumResult {
  const n = group.rep.normalized
  const value = n.kind === 'id' || n.kind === 'text' ? n.value : group.rep.rawValue
  const given = n.kind === 'id' ? { scheme: n.scheme, checksum: n.checksum } : { scheme: null, checksum: null }
  return checkIdentifier(value, given, israeli || hasIsraeliIdLabel(group))
}

/** ח.פ / ע.מ / ת.ז / עוסק labels make a bare number an Israeli id even on an English page. */
function hasIsraeliIdLabel(group: ValueGroup): boolean {
  return group.candidates.some((c) => !!c.originalLabel && /ח[."״']?\s?פ|ע[."״']?\s?מ|ת[."״']?\s?ז|עוסק|ח"פ|ע"מ/.test(c.originalLabel))
}

/**
 * Orders a field's groups: prior, with a failing checksum costing 70% of it. For the bank account
 * a valid IBAN comes first whatever its prior: the field definition prefers it over the
 * bank-branch-account printing.
 */
export function rankGroups(field: CanonicalField, groups: readonly ValueGroup[], israeli: boolean): ValueGroup[] {
  if (!CHECKSUM_FIELDS.has(field)) return [...groups]
  const score = (g: ValueGroup) => g.prior * (checksumOf(g, israeli).valid === false ? CHECKSUM_PENALTY : 1)
  const iban = (g: ValueGroup) => field === 'supplier.bank_account' && g.prior >= PRIOR.competitorMin && checksumOf(g, israeli).scheme === 'iban' && checksumOf(g, israeli).valid === true ? 1 : 0
  return [...groups].sort((a, b) => iban(b) - iban(a) || score(b) - score(a))
}

/** Prior gap above which the weaker of two fields claiming the same words simply yields. */
const CLAIM_GAP = 0.2

/**
 * Fields that read the same kind of value and therefore compete for the same printed words. A
 * document title ("חשבונית מס 2026/0457") or payment terms ("שוטף + 30, עד 25/05/2026") may
 * legitimately contain another field's words, so codes and terms are not part of any family.
 */
const CLAIM_FAMILY: Partial<Record<FieldKind, string>> = {
  date: 'date',
  identifier: 'id',
  contact: 'id',
  name: 'party',
  address: 'party',
}

/**
 * Two fields of one family may not be read from the same words (an invoice date is not also the
 * delivery date unless printed twice). The weaker claim moves to its next reading or becomes
 * absent; claims of similar strength are both kept and flagged as a role conflict.
 */
export function resolveClaims(choices: Choice[]): Issue[] {
  const issues: Issue[] = []
  const chosen = (c: Choice) => (c.index >= 0 ? c.ranked[c.index]! : null)
  for (let round = 0; round < 20; round++) {
    let changed = false
    for (let i = 0; i < choices.length && !changed; i++) {
      for (let j = i + 1; j < choices.length && !changed; j++) {
        const a = choices[i]!
        const b = choices[j]!
        const family = CLAIM_FAMILY[FIELD_KIND[a.field]]
        if (!family || family !== CLAIM_FAMILY[FIELD_KIND[b.field]]) continue
        const ga = chosen(a)
        const gb = chosen(b)
        if (!ga || !gb || !overlaps(ga.wordIds, gb.wordIds)) continue
        if (Math.abs(ga.prior - gb.prior) < CLAIM_GAP) {
          if (a.roleConflict !== b.field || b.roleConflict !== a.field) {
            a.roleConflict = b.field
            b.roleConflict = a.field
            issues.push({
              severity: 'warning',
              code: 'role.conflict',
              message: `"${ga.rep.rawValue}" is read as both ${a.field} and ${b.field} with similar confidence.`,
              fields: [a.field, b.field],
            })
          }
          continue
        }
        const loser = ga.prior < gb.prior ? a : b
        const winner = loser === a ? b : a
        const taken = chosen(winner)!
        let next = loser.index + 1
        while (next < loser.ranked.length && overlaps(loser.ranked[next]!.wordIds, taken.wordIds)) next++
        loser.index = next < loser.ranked.length ? next : -1
        issues.push({
          severity: 'info',
          code: 'role.yielded',
          message: `"${taken.rep.rawValue}" is the ${winner.field}; it is not also used as ${loser.field}.`,
          fields: [loser.field],
        })
        changed = true
      }
    }
    if (!changed) break
  }
  return issues
}

// ---------------------------------------------------------------------------------------------
// Shared predicates

export function strongLabel(g: ValueGroup): boolean {
  return g.candidates.some(
    (c) =>
      c.label !== null &&
      !c.method.startsWith('pattern:') &&
      (c.signals.some((s) => (SIGNAL.strongLabel as readonly string[]).includes(s)) || c.score >= PRIOR.strongLabel),
  )
}

export function labelled(g: ValueGroup): boolean {
  return g.candidates.some((c) => c.label !== null || c.originalLabel !== null)
}

/** Alternatives strong enough to block verification. */
export function competitorsOf(chosen: ValueGroup, alternatives: readonly ValueGroup[]): ValueGroup[] {
  return alternatives.filter((a) => a !== chosen && a.prior >= PRIOR.competitorMin)
}

/** A strong alternative close to the chosen one: needs a person. */
export function conflictsWith(chosen: ValueGroup, alternatives: readonly ValueGroup[]): boolean {
  return alternatives.some((a) => a !== chosen && a.prior >= Math.max(PRIOR.conflictMin, chosen.prior - PRIOR.conflictMargin))
}

export function textOf(n: NormalizedValue, raw: string): string {
  switch (n.kind) {
    case 'id':
    case 'text':
      return n.value
    case 'currency':
      return n.code
    case 'document_type':
      return n.value
    default:
      return raw
  }
}

const DATE_SHAPE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/

/** Well-formedness by field; malformed values are never verified. */
export function wellFormed(field: CanonicalField, g: ValueGroup, cs: ChecksumResult | null): boolean {
  const value = textOf(g.rep.normalized, g.rep.rawValue).trim()
  const compact = value.replace(/[\s\-./]/g, '')
  switch (field) {
    case 'invoice_number':
      return compact.length >= 1 && compact.length <= 30 && /\d/.test(compact) && !/^0+$/.test(compact) && !DATE_SHAPE.test(g.rep.rawValue.trim())
    case 'po_number':
      return compact.length >= 1 && compact.length <= 30 && /[\p{L}\d]/u.test(compact)
    case 'allocation_number':
      return /^\d{6,12}$/.test(compact)
    case 'supplier.tax_id':
    case 'customer.tax_id':
      if (cs?.scheme === 'il-id') return /^\d{7,9}$/.test(compact)
      return /^[A-Z0-9]{5,20}$/i.test(compact)
    case 'supplier.bank_account':
      if (cs?.scheme === 'iban') return cs.valid !== false
      return /^\d[\d\-\s/]{4,}\d$/.test(value) && compact.replace(/\D/g, '').length >= 6 && compact.replace(/\D/g, '').length <= 22
    case 'supplier.phone': {
      const digits = value.replace(/^\+972/, '0').replace(/\D/g, '')
      return digits.length >= 7 && digits.length <= 15
    }
    case 'supplier.email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
    default:
      return value.length > 0
  }
}

export function isIdentifierKind(field: CanonicalField): boolean {
  return FIELD_KIND[field] === 'identifier'
}

/** Text confidence of a group (lowest word), and whether it is too weak for label-only verification. */
export function textConfidence(g: ValueGroup, doc: DocIndex): number {
  return doc.minConfidence(g.wordIds)
}

export function okText(g: ValueGroup, doc: DocIndex): boolean {
  return textConfidence(g, doc) >= OCR.labelOnly
}
