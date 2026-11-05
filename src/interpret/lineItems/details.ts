import { matchLabels } from '../../semantic'

/**
 * Lines printed under an item that are not more of its description. A description that wraps
 * goes on in the same voice; these say something else about the item:
 * - a translation: a bilingual table (its description title in both scripts, "תיאור Description")
 *   prints each name twice, once per script ("Deluxe Double Room" under "לינה – חדר דלוקס זוגי").
 *   It does so for (nearly) every line; a note in the other script under one or two lines ("לפי
 *   הצעת מחיר 2291" under an English name) is part of that description;
 * - a labelled attribute: "Packing: 200 per ctn", or a code after a code word ("SKU OCP-BP-R02").
 * They are kept as the item's extra values (the code as its SKU), so the description is the name
 * as printed once.
 */

const HEBREW = /[\u0590-\u05FF]/gu
const LATIN = /[A-Za-z\u00C0-\u024F]/gu

export type Script = 'hebrew' | 'latin'

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length

/** The script of (seven tenths of) a text's letters, or null when mixed or too short to tell. */
export function scriptOf(text: string): Script | null {
  const he = count(text, HEBREW)
  const la = count(text, LATIN)
  if (he + la < 3) return null
  if (he >= 0.7 * (he + la)) return 'hebrew'
  if (la >= 0.7 * (he + la)) return 'latin'
  return null
}

/** "Packing:" — a short label (at most three words, no digits) and a colon opening the line. */
const COLON_LABEL = /^\s*([^\d:：]{1,30}?)\s*[:：]\s*(?=\S)/u

export interface Detail {
  /** The key the value is kept under in `extra`; 'sku' for a code after a code word. */
  key: string
  /** The label as printed ('' for a translation). */
  label: string
  /** Where the value starts in the line's text. */
  start: number
}

/**
 * What a text line attached to an item is, when it is not more of the item's description (see the
 * file comment). `ownScript` is the script of the item's own description; `descHeader` the title
 * of the description column as printed; `translated`: the table prints its names in both scripts
 * (see isTranslation).
 */
export function detailOf(text: string, ownScript: Script | null, descHeader: string | null, translated: boolean): Detail | null {
  const label = COLON_LABEL.exec(text)
  if (label && /\p{L}/u.test(label[1]) && label[1].trim().split(/\s+/).length <= 3) {
    return { key: label[1].trim(), label: label[1].trim(), start: label[0].length }
  }
  const first = text.search(/\S/)
  const lead = matchLabels(text).find((m) => m.start === first && m.kind === 'column' && m.concept === 'col.sku')
  if (lead && /\d/.test(text.slice(lead.end))) {
    return { key: 'sku', label: text.slice(lead.start, lead.end), start: lead.end + text.slice(lead.end).search(/\S/) }
  }
  return translated ? translation(text, ownScript, descHeader) : null
}

/**
 * A line that can be the translation of an item's name: entirely in the other script, under a
 * description title printed in both. Whether the table translates its names is decided over all
 * its lines (most of them must have one).
 */
export function isTranslation(text: string, ownScript: Script | null, descHeader: string | null): boolean {
  return translation(text, ownScript, descHeader) !== null
}

function translation(text: string, ownScript: Script | null, descHeader: string | null): Detail | null {
  const script = scriptOf(text)
  if (!ownScript || !script || script === ownScript || !descHeader) return null
  const other = script === 'hebrew' ? HEBREW : LATIN
  const mine = ownScript === 'hebrew' ? HEBREW : LATIN
  if (count(text, mine) > 0) return null
  if (count(descHeader, other) < 2 || count(descHeader, mine) < 2) return null
  // Kept under the title's words in the translation's script ("Description").
  const key = descHeader
    .split(/\s+/)
    .filter((w) => count(w, other) > 0)
    .join(' ')
  return { key: key || 'translation', label: '', start: text.search(/\S/) }
}
