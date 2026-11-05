import type { CanonicalField } from '../model/types'
import { foldForMatch } from '../lib/text'
import { parseIban } from '../semantic'
import { ibanChecksum } from './checksum'
import type { DocIndex } from './evidence'
import type { ValueGroup } from './groups'
import { PRIOR } from './policy'

/**
 * Bank accounts. The field definition picks the IBAN when one is printed, else the
 * bank-branch-account digits. Israeli invoices often print both for the same account, so a
 * bank-branch-account reading is the wrong printing as soon as an IBAN is on the page, and the
 * two printings of one account corroborate each other instead of competing.
 */

function compact(g: ValueGroup): string {
  const n = g.rep.normalized
  const v = n.kind === 'id' || n.kind === 'text' ? n.value : g.rep.rawValue
  return v.replace(/[\s\-./]/g, '').toUpperCase()
}

/** The group reads an IBAN (shape and scheme; the checksum is judged elsewhere). */
export function isIban(g: ValueGroup): boolean {
  const n = g.rep.normalized
  return (n.kind === 'id' && !!n.scheme && /iban/i.test(n.scheme)) || ibanChecksum(compact(g)) !== null
}

/**
 * An IBAN is printed on the page: a valid IBAN candidate, a valid IBAN in any line, or an "IBAN"
 * label (the reader often splits the digit groups of an IBAN over several lines, so the label is
 * the robust witness).
 */
export function ibanPrinted(doc: DocIndex, groups: Map<CanonicalField, ValueGroup[]>): boolean {
  if ((groups.get('supplier.bank_account') ?? []).some((g) => g.prior >= PRIOR.competitorMin && isIban(g) && ibanChecksum(compact(g)) === true)) return true
  return doc.lines.some((l) => /(?<![\p{L}])iban(?![\p{L}])/u.test(foldForMatch(l.text)) || parseIban(l.text)?.checksum === true)
}

/** bank, branch and account of an Israeli IBAN (IL kk BBB SSS AAAAAAAAAAAAA) or a b-b-a reading. */
function accountParts(g: ValueGroup): [number, number, string] | null {
  const v = compact(g)
  const il = /^IL\d{2}(\d{3})(\d{3})(\d{13})$/.exec(v)
  if (il) return [Number(il[1]), Number(il[2]), il[3]!.replace(/^0+/, '')]
  const n = g.rep.normalized
  for (const raw of [n.kind === 'id' || n.kind === 'text' ? n.value : '', g.rep.rawValue]) {
    const bba = /^(\d{1,3})[-\s/.](\d{1,4})[-\s/.](\d{3,13})$/.exec(raw.trim())
    if (bba) return [Number(bba[1]), Number(bba[2]), bba[3]!.replace(/^0+/, '')]
  }
  return null
}

/** Two readings of one Israeli account: an IBAN and the bank-branch-account digits it encodes. */
export function sameAccount(a: ValueGroup, b: ValueGroup): boolean {
  if (isIban(a) === isIban(b)) return false
  const pa = accountParts(a)
  const pb = accountParts(b)
  return !!pa && !!pb && pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2]
}
