import type { CanonicalField, FieldStatus, Issue, NormalizedValue, ValidationCheck } from '../model/types'
import { foldForMatch } from '../lib/text'
import { findPhones } from '../semantic'
import { CUES, OCR, PRIOR, SIGNAL } from './policy'
import { hasCue, overlaps, type DocIndex } from './evidence'
import type { ValueGroup } from './groups'
import { plausibleYear, type DateReading, conventionCheck, normalizedDate } from './dates'
import { idClassOf, idRole, partyIdsOnPage, partyOfField, otherParty, printParty, regionParty, type IdRole, type PartyIdPrint, type RoleContext } from './roles'
import { ibanPrinted, sameAccount, isIban } from './bank'
import { ambiguousCurrencyOnly, resolveSign } from './currency'
import { wholeTerms } from './terms'
import { titleProblem } from './title'
import { continuationBelow } from './extent'
import {
  CHECKSUM_FIELDS,
  checksumOf,
  competitorsOf,
  conflictsWith,
  labelled,
  okText,
  strongLabel,
  textConfidence,
  textOf,
  wellFormed,
  type Choice,
  type Decision,
} from './single'

/**
 * STATUS_POLICY applied to the single-value kinds (identifier, contact, code, terms, address,
 * date). Each function returns a Decision; nothing here looks at money.
 */

export interface DecideContext {
  doc: DocIndex
  /** Hebrew document or ILS: a bare 9-digit tax id is an Israeli ID-family number. */
  israeli: boolean
  /** Every group of every field, including the ones not chosen (role checks need them). */
  groups: Map<CanonicalField, ValueGroup[]>
  /** Decisions made so far (names need the tax id's). */
  decided: Map<CanonicalField, Decision>
  /** Party identifiers printed on the page (see roles.ts); computed on first use. */
  partyIds?: PartyIdPrint[]
  /** Set once the document type is known (a receipt reads "מאת" as the payer). */
  receipt?: boolean
}

export function rolesOf(ctx: DecideContext): RoleContext {
  return { doc: ctx.doc, receipt: !!ctx.receipt }
}

function partyIds(ctx: DecideContext): PartyIdPrint[] {
  if (!ctx.partyIds) ctx.partyIds = partyIdsOnPage(rolesOf(ctx), ctx.groups, ctx.israeli)
  return ctx.partyIds
}

function base(choice: Choice, ctx: DecideContext): { g: ValueGroup; alts: ValueGroup[]; weak: boolean } {
  const g = choice.ranked[choice.index]!
  const alts = choice.ranked.filter((x) => x !== g)
  return { g, alts, weak: textConfidence(g, ctx.doc) < OCR.weak }
}

function make(
  field: CanonicalField,
  g: ValueGroup,
  alts: ValueGroup[],
  status: FieldStatus,
  extra: Partial<Omit<Decision, 'field' | 'group' | 'alternatives' | 'status'>> = {},
): Decision {
  return {
    field,
    group: g,
    alternatives: alts,
    normalized: extra.normalized ?? g.rep.normalized,
    status,
    passed: extra.passed ?? [],
    report: extra.report ?? extra.passed ?? [],
    issues: extra.issues ?? [],
    exact: extra.exact ?? (extra.passed?.length ?? 0),
    failed: extra.failed ?? 0,
    competitor: extra.competitor ?? false,
    ambiguous: extra.ambiguous ?? false,
    weakText: extra.weakText ?? false,
  }
}

function conflictIssue(field: CanonicalField, g: ValueGroup, alts: readonly ValueGroup[]): Issue {
  const others = alts.filter((a) => a.prior >= PRIOR.competitorMin).map((a) => `"${a.rep.rawValue}"`)
  return {
    severity: 'warning',
    code: 'conflict.candidates',
    message: `${field}: "${g.rep.rawValue}" competes with ${others.join(', ')}.`,
    fields: [field],
  }
}

function pass(id: string, field: CanonicalField, expected: string | null, actual: string | null, message: string): ValidationCheck {
  return { id, status: 'pass', fields: [field], expected, actual, message }
}

function prior(g: ValueGroup): string {
  return g.prior.toFixed(2)
}

/** Fallback for anything unconfirmed: conflict → needs_review; weak → needs_review; else proposed. */
function unconfirmed(field: CanonicalField, g: ValueGroup, alts: ValueGroup[], weak: boolean, ok = true): Decision {
  if (conflictsWith(g, alts)) return make(field, g, alts, 'needs_review', { competitor: true, issues: [conflictIssue(field, g, alts)], weakText: weak })
  if (!ok || g.prior < PRIOR.proposedMin || weak) return make(field, g, alts, 'needs_review', { weakText: weak })
  return make(field, g, alts, 'proposed', { competitor: competitorsOf(g, alts).length > 0, weakText: weak })
}

// ---------------------------------------------------------------------------------------------

const PARTY_IDS = new Set<CanonicalField>(['supplier.tax_id', 'customer.tax_id'])

export function decideIdentifier(choice: Choice, ctx: DecideContext): Decision {
  const { field } = choice
  const { g, alts, weak } = base(choice, ctx)
  const cs = CHECKSUM_FIELDS.has(field) ? checksumOf(g, ctx.israeli) : null
  const formed = wellFormed(field, g, cs)
  const value = textOf(g.rep.normalized, g.rep.rawValue)
  const bank = field === 'supplier.bank_account'
  // A checksum-valid value only competes with other checksum-valid (or unchecked) values. The
  // same bank account printed as IBAN and as bank-branch-account corroborates, it does not compete.
  // A company register number (HRB, KvK, Company No.) is not the tax id when a tax number is
  // printed, so it does not compete with one either.
  const taxNumber = PARTY_IDS.has(field) && g.candidates.some((c) => idClassOf(c.originalLabel) === 'tax')
  const competing = competitorsOf(g, alts).filter(
    (a) =>
      (cs?.valid !== true || checksumOf(a, ctx.israeli).valid !== false) &&
      !(bank && sameAccount(g, a)) &&
      !(taxNumber && a.candidates.every((c) => idClassOf(c.originalLabel) === 'register')),
  )
  const roleConflict = choice.roleConflict ?? otherPartyClaims(field, g, ctx)
  const role = PARTY_IDS.has(field) ? idRole(field, g, rolesOf(ctx), partyIds(ctx)) : null
  const roleProblem = role ? partyIdProblem(field, value, role) ?? ocrRoleProblem(field, value, role, g, ctx.doc) : null
  // The definition picks the IBAN whenever one is printed: a bank-branch-account reading is then
  // the wrong printing, even of the right account.
  const ibanProblem: RoleProblem | null =
    bank && !isIban(g) && ibanPrinted(ctx.doc, ctx.groups)
      ? { review: true, issue: { severity: 'warning', code: 'bank.iban_printed', message: `supplier.bank_account "${value}" is a bank-branch-account number, but an IBAN is printed: the field is the IBAN.`, fields: [field] } }
      : null

  // The payer's account (a standing order debiting "חשבון הלקוח") is not the supplier's at all:
  // set those readings aside and decide among the rest (the supplier's own account, if printed).
  if (bank && choice.ranked.some((x) => payerAccount(x, ctx.doc))) {
    const payers = choice.ranked.filter((x) => payerAccount(x, ctx.doc))
    const note: Issue = {
      severity: 'info',
      code: 'bank.payer_account',
      message: `${payers.map((x) => `"${textOf(x.rep.normalized, x.rep.rawValue)}"`).join(', ')} is the account the payment is taken from (the payer's), not the supplier's bank account.`,
      fields: [field],
    }
    const rest = choice.ranked.filter((x) => !payers.includes(x))
    if (!rest.length) {
      const d = make(field, g, alts, 'needs_review')
      d.drop = note
      return d
    }
    const d = decideIdentifier({ ...choice, ranked: rest, index: 0 }, ctx)
    d.issues.push(note)
    return d
  }
  if (cs && cs.valid === false) {
    const check: ValidationCheck = {
      id: `checksum:${field}`,
      status: 'fail',
      fields: [field],
      expected: `valid ${cs.scheme} check digit`,
      actual: value,
      message: `${field} "${value}" fails the ${cs.scheme} checksum: misread or not an id.`,
    }
    const issue: Issue = { severity: 'warning', code: 'id.checksum_failed', message: check.message, fields: [field] }
    return make(field, g, alts, 'needs_review', { report: [check], issues: [issue], failed: 1, weakText: weak })
  }
  const checksumPass =
    cs && cs.valid === true
      ? pass(`checksum:${field}`, field, `valid ${cs.scheme} check digit`, value, `${field} "${value}" passes the ${cs.scheme} checksum.`)
      : null
  if (roleConflict) {
    const issue: Issue = {
      severity: 'warning',
      code: 'role.conflict',
      message: `${field} "${value}" is also a candidate for ${roleConflict}: whose number it is is unclear.`,
      fields: [field, roleConflict],
    }
    return make(field, g, alts, 'needs_review', { passed: checksumPass ? [checksumPass] : [], issues: [issue], competitor: true, weakText: weak })
  }
  const blocked = roleProblem !== null || ibanProblem !== null
  if (!blocked && checksumPass && g.prior >= PRIOR.checksumMin && (labelled(g) || hasRoleSignal(g)) && !competing.length) {
    return make(field, g, alts, 'verified', { passed: [checksumPass, ...roleChecks(field, value, role)] })
  }
  if (!blocked && (!cs || cs.valid === null) && formed && strongLabel(g) && !competing.length && okText(g, ctx.doc)) {
    const check = pass(
      `unique-label:${field}`,
      field,
      null,
      value,
      `single well-formed reading under a strong label ("${g.rep.originalLabel ?? ''}", prior ${prior(g)}) with no competing value`,
    )
    return make(field, g, alts, 'verified', { passed: [check, ...roleChecks(field, value, role)] })
  }
  const d = unconfirmed(field, g, alts, weak, formed)
  if (checksumPass) {
    d.passed = [checksumPass]
    d.report = [checksumPass]
  }
  for (const p of [roleProblem, ibanProblem]) {
    if (!p) continue
    d.issues.push(p.issue)
    // Evidence that it is the other party's, or the wrong printing: worse than unconfirmed.
    if (p.review) d.status = 'needs_review'
  }
  return d
}

/** The bank details' own lines or labels say the money is taken from this account (CUES.payerAccount). */
function payerAccount(g: ValueGroup, doc: DocIndex): boolean {
  const lineTexts = new Set<string>()
  for (const id of g.wordIds) {
    const line = doc.lineOfWord(id)
    if (line) lineTexts.add(line.text)
  }
  return [...lineTexts, ...g.candidates.map((c) => c.originalLabel)].some((t) => hasCue(t, CUES.payerAccount))
}

interface RoleProblem {
  issue: Issue
  /** The page says it is the other party's (or the wrong printing): needs_review, not proposed. */
  review: boolean
}

/**
 * STATUS_POLICY.identifier, party ids: a checksum proves validity, not ownership. The value's
 * role needs the page's backing: never under the other party's marker; and when another party id
 * printed on the page could be this party's, only an explicit marker (in the label or heading the
 * region) of this party, with no other id under the same marker, settles it.
 */
function partyIdProblem(field: CanonicalField, value: string, role: IdRole): RoleProblem | null {
  const party = partyOfField(field)!
  const list = (xs: readonly PartyIdPrint[]) => xs.map((x) => `"${x.value}"`).join(', ')
  if (role.opposite) {
    return { review: true, issue: { severity: 'warning', code: 'role.other_party_marker', message: `${field} "${value}" is printed under the ${otherParty(party)}'s marker.`, fields: [field] } }
  }
  if (role.competing.length) {
    return { review: true, issue: { severity: 'warning', code: 'role.competing_id', message: `${field}: "${value}" and ${list(role.competing)} are both printed as the ${party}'s.`, fields: [field] } }
  }
  if (role.rivals.length && !role.explicit) {
    return {
      review: false,
      issue: { severity: 'info', code: 'role.unmarked_id', message: `${field} "${value}": other party ids are printed (${list(role.rivals)}) and no ${party} marker says which one is the ${party}'s.`, fields: [field] },
    }
  }
  return null
}

/**
 * On OCR text the absence of evidence proves nothing: a lost "לכבוד" makes the customer's ח.פ look
 * like the letterhead's, and a garbled rival id never shows up as a rival. So a party id read by
 * OCR is verified only under an explicit marker of its own party that survived OCR.
 */
function ocrRoleProblem(field: CanonicalField, value: string, role: IdRole, g: ValueGroup, doc: DocIndex): RoleProblem | null {
  if (role.explicit || doc.minConfidence(g.wordIds) >= OCR.digital) return null
  const party = partyOfField(field)!
  return {
    review: false,
    issue: { severity: 'info', code: 'role.ocr_unmarked_id', message: `${field} "${value}" was read by OCR and no ${party} marker sits with it: OCR may have lost the marker that says whose number it is.`, fields: [field] },
  }
}

function roleChecks(field: CanonicalField, value: string, role: IdRole | null): ValidationCheck[] {
  if (!role || !role.explicit) return []
  return [pass(`role:${field}`, field, null, value, `"${value}" is printed under a ${partyOfField(field)} marker`)]
}

/** The same tax id is also read as the other party's: the checksum cannot tell whose it is. */
function otherPartyClaims(field: CanonicalField, g: ValueGroup, ctx: DecideContext): CanonicalField | null {
  const other: CanonicalField | null = field === 'supplier.tax_id' ? 'customer.tax_id' : field === 'customer.tax_id' ? 'supplier.tax_id' : null
  if (!other) return null
  const rival = (ctx.groups.get(other) ?? []).find((x) => x.key === g.key && x.prior >= PRIOR.competitorMin)
  return rival ? other : null
}

function hasRoleSignal(g: ValueGroup): boolean {
  return g.candidates.some((c) => c.signals.includes(SIGNAL.roleSupplier) || c.signals.includes(SIGNAL.roleCustomer))
}

// ---------------------------------------------------------------------------------------------

export function decideContact(choice: Choice, ctx: DecideContext): Decision {
  const { field } = choice
  const { g, alts, weak } = base(choice, ctx)
  const formed = wellFormed(field, g, null)
  if (choice.roleConflict) return make(field, g, alts, 'needs_review', { competitor: true, weakText: weak })
  const outside = outsideSupplierCard(g, ctx)
  if (outside) {
    const d = make(field, g, alts, 'needs_review', { weakText: weak })
    d.drop = { severity: 'info', code: 'contact.not_supplier', message: `${field} "${g.rep.rawValue}" is printed outside the card the page marks as the supplier's (${outside}); it is someone else's contact (a platform, an agent).`, fields: [field] }
    return d
  }
  const taxId = ctx.decided.get('supplier.tax_id')
  const inTaxIdBlock = taxId?.status === 'verified' && overlapsSets(ctx.doc.blocksOf(g.wordIds), ctx.doc.blocksOf(taxId.group.wordIds))
  // The page's own markers must not put it in the customer's block.
  const customers = g.candidates.some((c) => printParty(rolesOf(ctx), c.evidence.flatMap((e) => e.wordIds), c.originalLabel) === 'customer')
  const role = !customers && (g.candidates.some((c) => c.signals.includes(SIGNAL.roleSupplier)) || inTaxIdBlock)
  const value = textOf(g.rep.normalized, g.rep.rawValue)
  const unique = !competitorsOf(g, alts).length && okText(g, ctx.doc)
  if (formed && strongLabel(g) && unique && role) {
    return make(field, g, alts, 'verified', {
      passed: [pass(`unique-label:${field}`, field, null, value, `single well-formed ${field} under "${g.rep.originalLabel ?? ''}" with supplier role evidence`)],
    })
  }
  // An e-mail address needs no label to say what it is (only an e-mail has an "@"); what needs
  // confirming is whose it is and which one: the only address printed on the page, in the block
  // of the supplier's verified tax id.
  if (field === 'supplier.email' && formed && unique && !customers && inTaxIdBlock && onlyEmailOnPage(ctx, value)) {
    return make(field, g, alts, 'verified', {
      passed: [pass(`role:${field}`, field, null, value, `"${value}" is the only e-mail address on the page, printed in the block of the verified supplier tax id`)],
    })
  }
  // A phone under a phone label in the verified supplier block, when it is the only phone the page
  // labels (faxes and the customer's numbers aside): no doubt which one is "the main phone".
  if (field === 'supplier.phone' && formed && unique && !customers && inTaxIdBlock && phoneLabelled(g) && onlyPhoneOnPage(ctx, value)) {
    return make(field, g, alts, 'verified', {
      passed: [pass(`role:${field}`, field, null, value, `"${value}" is the only labelled phone on the page (faxes aside), printed in the block of the verified supplier tax id`)],
    })
  }
  return unconfirmed(field, g, alts, weak, formed)
}

const PHONE_LABEL = /טל|טלפון|נייד|מוקד|phone|tel|mobile|cell|telefon|téléphone|tél|teléfono|telefono/i
const FAX_LABEL = /פקס|fax|télécopie/i

function phoneLabelled(g: ValueGroup): boolean {
  return g.candidates.some((c) => !!c.originalLabel && PHONE_LABEL.test(c.originalLabel) && !FAX_LABEL.test(c.originalLabel))
}

function phoneDigits(v: string): string {
  let d = v.replace(/\D/g, '')
  if (d.startsWith('00972')) d = `0${d.slice(5)}`
  else if (d.startsWith('972')) d = `0${d.slice(3)}`
  return d
}

/**
 * The page labels exactly one phone number as a phone (the text before it in its piece of the
 * line names a phone, not a fax), apart from numbers in blocks the page marks as the customer's,
 * and it is this one.
 */
function onlyPhoneOnPage(ctx: DecideContext, value: string): boolean {
  const own = phoneDigits(value)
  const rc = rolesOf(ctx)
  let seen = false
  for (const line of ctx.doc.lines) {
    for (const p of findPhones(line.text)) {
      const piece = line.text.slice(0, p.start).split(/[|·•]/).pop() ?? ''
      if (FAX_LABEL.test(piece) || !PHONE_LABEL.test(piece)) continue
      if (phoneDigits(p.value) === own) seen = true
      else if (regionParty(rc, line.wordIds) !== 'customer') return false
    }
  }
  return seen
}

/**
 * A contact found only by its shape (an e-mail or phone pattern, no label, no role) on a page that
 * marks the supplier's card explicitly ("Sold by", "ספק:") but prints the contact elsewhere: on a
 * marketplace or agent invoice the letterhead and footer belong to the platform. Returns the
 * supplier card's marker evidence, or null when the contact may be the supplier's. A contact whose
 * domain names the supplier is kept.
 */
function outsideSupplierCard(g: ValueGroup, ctx: DecideContext): string | null {
  const patternOnly = g.candidates.every((c) => c.method.startsWith('pattern:') && !c.originalLabel && !c.signals.includes(SIGNAL.roleSupplier))
  if (!patternOnly) return null
  const rc = rolesOf(ctx)
  const card = new Set<string>()
  let names: string[] = []
  for (const f of ['supplier.name', 'supplier.tax_id', 'supplier.address'] as const) {
    for (const s of ctx.groups.get(f) ?? []) {
      if (s.prior < PRIOR.competitorMin) continue
      const explicit = s.candidates.some((c) => printParty(rc, c.evidence.flatMap((e) => e.wordIds), c.originalLabel) === 'supplier')
      if (!explicit) continue
      for (const b of ctx.doc.blocksOf(s.wordIds)) card.add(b)
      if (f === 'supplier.name') names = [...names, foldForMatch(s.rep.rawValue).replace(/[^\p{L}\p{N}]/gu, '')]
    }
  }
  if (!card.size) return null
  if (overlapsSets(ctx.doc.blocksOf(g.wordIds), card) || regionParty(rc, g.wordIds) === 'supplier') return null
  const domain = /@([^.@\s]+)\./.exec(g.rep.rawValue)?.[1]?.toLowerCase()
  if (domain && domain.length >= 4 && names.some((n) => n.includes(domain))) return null
  return 'a marked supplier block'
}

const EMAIL = /[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}/gi

/**
 * This is the only e-mail address the page prints, apart from addresses in blocks the page marks
 * as the customer's (the customer's own contact is no rival for the supplier's).
 */
function onlyEmailOnPage(ctx: DecideContext, value: string): boolean {
  const own = value.toLowerCase()
  const rc = rolesOf(ctx)
  let seen = false
  for (const line of ctx.doc.lines) {
    for (const m of line.text.matchAll(EMAIL)) {
      const e = m[0].toLowerCase().replace(/[.]+$/, '')
      if (e === own) seen = true
      else if (regionParty(rc, line.wordIds) !== 'customer') return false
    }
  }
  return seen
}

function overlapsSets(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && b.size > 0 && overlaps(a, b)
}

// ---------------------------------------------------------------------------------------------

/**
 * STATUS_POLICY.code, document_type: a single strong title, fully explained by its type (see
 * title.ts: a title split into pieces or followed by another type's name is not), read from
 * embedded text. OCR can drop a whole word of a title ("חשבונית מס/קבלה" read as "חשבונית מס")
 * without leaving a trace, so an OCR'd title is at most proposed.
 */
export function decideDocumentType(choice: Choice, ctx: DecideContext): Decision {
  const { field } = choice
  const { g, alts, weak } = base(choice, ctx)
  const chosen = g.rep.normalized.kind === 'document_type' ? g.rep.normalized.value : null
  const problem = chosen ? titleProblem(ctx.doc, chosen, g.wordIds) : null
  const ocr = ctx.doc.minConfidence(g.wordIds) < OCR.digital
  if (!problem && !ocr && g.prior >= PRIOR.strongLabel && !competitorsOf(g, alts).length && okText(g, ctx.doc) && !choice.roleConflict) {
    const value = textOf(g.rep.normalized, g.rep.rawValue)
    return make(field, g, alts, 'verified', {
      passed: [pass('unique-label:document_type', field, null, value, `single document title "${g.rep.rawValue}" (prior ${prior(g)}) with no competing type`)],
    })
  }
  const d = unconfirmed(field, g, alts, weak)
  if (problem) {
    if (problem.conflict) d.status = 'needs_review'
    d.issues.push({
      severity: 'warning',
      code: problem.conflict ? 'title.conflicting_type' : 'title.unexplained',
      message: problem.conflict
        ? `The title is read as ${chosen}, but "${problem.conflict}" is also printed in it.`
        : `The title is read as ${chosen}, but it also says "${problem.unexplained}", which may change the type.`,
      fields: [field],
    })
  }
  return d
}

/**
 * Currency: the chosen amounts' own printed currency must agree. A "מטבע: ILS" label confirmed by
 * "1,180.00 ₪" on the total is two independent printings.
 */
export function decideCurrency(
  choice: Choice,
  ctx: DecideContext,
  amounts: readonly CurrencyPrint[],
  otherCurrencies: readonly string[] = [],
): Decision {
  const { field } = choice
  const { g, alts, weak } = base(choice, ctx)
  const code = g.rep.normalized.kind === 'currency' ? g.rep.normalized.code.toUpperCase() : g.rep.rawValue
  const explicit = amounts.filter((a) => a.currency)
  const agree = explicit.filter((a) => a.currency!.toUpperCase() === code && !overlaps(a.wordIds, g.wordIds))
  const disagree = explicit.filter((a) => a.currency!.toUpperCase() !== code)
  // "$" on the label and "$" on the total agree, but both are the parser's default for a sign
  // that AUD, CAD, SGD … share: at least one printing must name the currency unambiguously.
  // The rest of the page may settle the sign: "All amounts in USD" confirms "$" as USD, an "AUD"
  // printed anywhere says it is not.
  const signOnly = ambiguousCurrencyOnly([...g.candidates.map((c) => c.rawValue), ...agree.map((a) => a.raw ?? '')])
  const sign = signOnly ? resolveSign(code, ctx.doc.lineTexts) : null
  const ambiguous = !!sign && !sign.confirmed
  if (sign?.rivals.length) {
    const d = unconfirmed(field, g, alts, weak)
    d.status = 'needs_review'
    d.issues.push({ severity: 'warning', code: 'currency.sign_conflict', message: `The currency ${code} is read from a shared sign, but the page names ${sign.rivals.join(', ')}.`, fields: ['currency'] })
    return d
  }
  if (disagree.length) {
    const check: ValidationCheck = {
      id: 'currency:amounts',
      status: 'fail',
      fields: ['currency', ...disagree.map((a) => a.field)],
      expected: code,
      actual: disagree.map((a) => `${a.field}=${a.currency}`).join(', '),
      message: `The document currency ${code} disagrees with the currency printed on ${disagree.map((a) => a.field).join(', ')}.`,
    }
    return make(field, g, alts, 'needs_review', {
      report: [check],
      failed: 1,
      issues: [{ severity: 'warning', code: 'currency.mismatch', message: check.message, fields: check.fields }],
      weakText: weak,
    })
  }
  if (agree.length) {
    const check = pass('currency:amounts', field, code, agree.map((a) => `${a.field}=${a.currency}`).join(', '), `${code} is also printed on ${agree.map((a) => a.field).join(', ')}.`)
    if (!competitorsOf(g, alts).length && !choice.roleConflict && !ambiguous) return make(field, g, alts, 'verified', { passed: [check] })
    const d = unconfirmed(field, g, alts, weak)
    d.passed = [check]
    d.report = [check]
    if (ambiguous) d.issues.push(ambiguousIssue(code))
    return d
  }
  // The only printing of the sign is on the total itself ("69,336.80 ₪", "סה"כ לתשלום ש"ח"): the
  // currency of the document is the currency of its total, and the arithmetic has confirmed that
  // this figure is the total. It holds only when the sign belongs to one currency and no amount on
  // the page is printed in another (a conversion box would make "the total" ambiguous).
  const own = amounts.filter(
    (a) => a.verified && TOTAL_FIGURES.has(a.field) && (a.currency === null || a.currency.toUpperCase() === code) && (overlaps(a.wordIds, g.wordIds) || overlaps(a.labelWordIds ?? new Set(), g.wordIds)),
  )
  if (own.length && !ambiguous && !otherCurrencies.length && !competitorsOf(g, alts).length && !choice.roleConflict && okText(g, ctx.doc)) {
    const check = pass('currency:verified-total', field, code, own.map((a) => a.field).join(', '), `${code} is printed with the verified ${own.map((a) => a.field).join(', ')} and no amount on the page is in another currency.`)
    return make(field, g, alts, 'verified', { passed: [check] })
  }
  const d = unconfirmed(field, g, alts, weak)
  if (ambiguous) d.issues.push(ambiguousIssue(code))
  return d
}

/** A chosen money field's printed currency, as decideCurrency sees it. */
export interface CurrencyPrint {
  field: CanonicalField
  currency: string | null
  wordIds: ReadonlySet<string>
  labelWordIds?: ReadonlySet<string>
  raw?: string
  verified?: boolean
}

const TOTAL_FIGURES = new Set<CanonicalField>(['total', 'amount_due'])

function ambiguousIssue(code: string): Issue {
  return { severity: 'info', code: 'currency.ambiguous_sign', message: `The currency ${code} is read from a sign several currencies share ("$", "kr", "¥", "Fr"); no ISO code confirms it.`, fields: ['currency'] }
}

export function decideTerms(choice: Choice, ctx: DecideContext): Decision {
  const { field } = choice
  const { g, alts, weak } = base(choice, ctx)
  const value = textOf(g.rep.normalized, g.rep.rawValue)
  // The whole value must be a terms expression; containing one is not enough (terms.ts). And it
  // must be the whole printed value: a clause wrapped onto the next line would be cut off (extent.ts).
  const known = wholeTerms(value)
  const more = continuationBelow(ctx.doc, g.wordIds, g.candidates.flatMap((c) => c.label?.wordIds ?? []))
  if (known && !more && strongLabel(g) && !competitorsOf(g, alts).length && okText(g, ctx.doc) && !choice.roleConflict) {
    return make(field, g, alts, 'verified', {
      passed: [pass('format:payment_terms', field, null, value, `"${value}" is a payment-terms expression as a whole, under "${g.rep.originalLabel ?? ''}"`)],
    })
  }
  const d = unconfirmed(field, g, alts, weak)
  if (!known && CUES.terms.some((re) => re.test(foldForMatch(value)))) {
    d.issues.push({ severity: 'info', code: 'terms.extra_text', message: `payment_terms "${value}" contains a terms pattern but also other text.`, fields: [field] })
  }
  if (more) {
    d.issues.push({ severity: 'info', code: 'value.may_continue', message: `payment_terms "${value}" may go on in the next line ("${more.text}").`, fields: [field] })
  }
  return d
}

/** Addresses are never verified (STATUS_POLICY.address). */
export function decideAddress(choice: Choice, ctx: DecideContext): Decision {
  const { g, alts, weak } = base(choice, ctx)
  return unconfirmed(choice.field, g, alts, weak || !!choice.roleConflict)
}

// ---------------------------------------------------------------------------------------------

export interface DateDecisionInput {
  reading: DateReading
  /** Resolved ISO of each alternative group (for "same date printed differently"). */
  isoOf: (g: ValueGroup) => string | null
  orderFailed: ValidationCheck | null
}

export function decideDate(choice: Choice, ctx: DecideContext, input: DateDecisionInput): Decision {
  const { field } = choice
  const { g, alts: allAlts, weak } = base(choice, ctx)
  const { reading } = input
  // Another printing of the same day is corroboration, not competition.
  const alts = allAlts.filter((a) => input.isoOf(a) !== reading.iso)
  const normalized: NormalizedValue = normalizedDate(reading)
  const conv = conventionCheck(field, g.rep.rawValue, reading)
  const passedBase = conv ? [conv] : []
  const issues: Issue[] = []
  if (reading.ambiguous) {
    issues.push({
      severity: 'warning',
      code: 'date.ambiguous',
      message: `${field} "${g.rep.rawValue}" can be read as ${reading.readings.join(' or ')}; nothing on the document settles the day/month order.`,
      fields: [field],
    })
  }
  if (input.orderFailed) {
    return make(field, g, allAlts, 'needs_review', { normalized, passed: passedBase, issues, failed: 1, ambiguous: reading.ambiguous, weakText: weak })
  }
  if (choice.roleConflict) return make(field, g, allAlts, 'needs_review', { normalized, passed: passedBase, issues, competitor: true, weakText: weak })
  if (conflictsWith(g, alts)) {
    return make(field, g, allAlts, 'needs_review', {
      normalized,
      passed: passedBase,
      issues: [...issues, conflictIssue(field, g, alts)],
      competitor: true,
      ambiguous: reading.ambiguous,
      weakText: weak,
    })
  }
  const competing = competitorsOf(g, alts).length > 0
  if (!reading.ambiguous && strongLabel(g) && !competing && okText(g, ctx.doc) && plausibleYear(reading.iso)) {
    const check = pass(
      `unique-label:${field}`,
      field,
      reading.iso,
      g.rep.rawValue,
      `unambiguous date under a strong label ("${g.rep.originalLabel ?? ''}", prior ${prior(g)}) with no competing date`,
    )
    return make(field, g, allAlts, 'verified', { normalized, passed: [...passedBase, check] })
  }
  const weakish = g.prior < PRIOR.proposedMin || weak || !plausibleYear(reading.iso)
  return make(field, g, allAlts, weakish ? 'needs_review' : 'proposed', {
    normalized,
    passed: passedBase,
    issues,
    competitor: competing,
    ambiguous: reading.ambiguous,
    weakText: weak,
  })
}

/** Party label cues by party. */
export function partyCue(party: 'supplier' | 'customer', label: string | null): boolean {
  return hasCue(label, party === 'supplier' ? CUES.supplierLabel : CUES.customerLabel)
}
