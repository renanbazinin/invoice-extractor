import type { Direction } from '../model/types'

/** Letters of the right-to-left scripts. */
const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u
/** Characters with a direction of their own: letters (and spacing marks). */
const STRONG = /[\p{L}\p{Mc}]/u
/** Invisible bidi controls (LRM, RLM, ALM, embeddings, overrides, isolates). */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g

/** Direction of the first strong character, or null when there is none ("12.50 ₪" is neutral). */
export function firstStrongDirection(text: string): Direction | null {
  for (const ch of text) {
    if (STRONG.test(ch)) return RTL_SCRIPT.test(ch) ? 'rtl' : 'ltr'
  }
  return null
}

/** Direction by majority of strong characters, or null when there is none. */
export function dominantDirection(text: string): Direction | null {
  let rtl = 0
  let ltr = 0
  for (const ch of text) {
    if (!STRONG.test(ch)) continue
    if (RTL_SCRIPT.test(ch)) rtl++
    else ltr++
  }
  if (!rtl && !ltr) return null
  return rtl >= ltr ? 'rtl' : 'ltr'
}

export function isRtlChar(ch: string): boolean {
  return RTL_SCRIPT.test(ch)
}

/**
 * The form every layer stores text in: NFC, bidi controls removed, Hebrew punctuation geresh
 * (׳) and gershayim (״) kept as written (matching code folds them, see foldForMatch), runs of
 * whitespace collapsed to one space, trimmed.
 */
export function cleanText(text: string): string {
  return text.normalize('NFC').replace(BIDI_CONTROLS, '').replace(/[\s   ]+/g, ' ').trim()
}

/**
 * For comparing text, never for storing it: NFKC, lower case, niqqud/cantillation removed,
 * Hebrew geresh/gershayim and typographic quotes folded to ASCII ' and ", dashes to '-'.
 */
export function foldForMatch(text: string): string {
  return cleanText(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[׳‘’‚‛`´]/g, "'")
    .replace(/[״“”„‟]/g, '"')
    .replace(/[‐-―−־]/g, '-')
}
