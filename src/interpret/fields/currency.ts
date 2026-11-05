import { wordsInSpan } from '../../lib/docIndex'
import { currencyAmbiguity, currencyFromLocaleCues, findCurrencies, parseCurrency } from '../../semantic'
import type { FieldsContext } from './context'
import type { Draft } from './draft'
import { wordsOfSpan } from './draft'

/**
 * The invoice currency: an explicit currency label ("מטבע: USD") or the marks printed on the
 * amounts (₪, ש"ח, NIS, $, €, …). Marks on the totals count most, so a converted total in a
 * second currency ("Total in ILS") does not outvote the invoice's own.
 *
 * A bare "$" is shared by many currencies (USD, AUD, CAD, NZD, SGD, HKD, MXN; "¥", "kr", "Fr."
 * likewise): the parser reads it as one default, which is wrong on an Australian invoice. What
 * the document itself says decides first (one of the candidates printed as a code, "AMOUNT
 * (AUD)", "A$"), then locale cues (ABN, Pty Ltd, GST/HST, a country name); see dollarCode.
 */
export function currencyDrafts(fc: FieldsContext, money: readonly Draft[]): Draft[] {
  const out: Draft[] = []
  const dollar = dollarCode(fc)
  for (const pair of fc.pairs) {
    if (!pair.sense.concepts.includes('currency') || !pair.sense.exact) continue
    const mention = findCurrencies(pair.value.text)[0]
    let code = mention?.code ?? parseCurrency(pair.value.text)
    if (!code) continue
    if (mention && dollar && bareDollar(mention.raw)) code = dollar.code
    const ids = mention ? wordsOfSpan(fc.index, pair.value.wordIds, mention.start, mention.end) : pair.value.wordIds
    out.push({
      field: 'currency',
      rawValue: mention?.raw ?? pair.value.text,
      normalized: { kind: 'currency', code },
      valueWordIds: ids,
      labelWordIds: pair.label.wordIds,
      originalLabel: pair.sense.text,
      score: 0.85,
      method: `kv:${pair.layout}`,
      signals: ['label:exact'],
    })
  }

  const mainLines = new Map<string, number>()
  for (const d of money) {
    if (d.normalized.kind !== 'money' || !d.normalized.currency) continue
    const w = d.field === 'total' || d.field === 'amount_due' || d.field === 'subtotal' ? 3 : 2
    for (const id of d.valueWordIds) {
      const lineId = fc.index.word.get(id)?.lineId
      if (lineId) mainLines.set(lineId, Math.max(mainLines.get(lineId) ?? 0, w * d.score))
    }
  }
  const weight = new Map<string, number>()
  const best = new Map<string, { ids: string[]; w: number; raw: string }>()
  for (const line of fc.index.doc.lines) {
    for (const c of findCurrencies(line.text)) {
      const ids = wordsInSpan(fc.index, line, c.start, c.end)
      if (!ids.length) continue
      const code = dollar && bareDollar(c.raw) ? dollar.code : c.code
      const w = mainLines.get(line.id) ?? (fc.itemLineIds.has(line.id) ? 0.5 : 0.3)
      weight.set(code, (weight.get(code) ?? 0) + w)
      const b = best.get(code)
      if (!b || w > b.w) best.set(code, { ids, w, raw: c.raw })
    }
  }
  const ranked = [...weight].sort((a, b) => b[1] - a[1])
  const top = ranked[0]
  if (!top) {
    const locale = out.length ? null : localeCurrencyDraft(fc)
    return locale ? [locale] : out
  }
  const [code, w] = top
  const second = ranked[1]
  const b = best.get(code)!
  const contested = !!second && second[1] >= 0.5 * w
  // A "$" read by locale cues alone is a guess at the currency, however often it is printed.
  const guessed = !!dollar && !dollar.printed && code === dollar.code
  out.push({
    field: 'currency',
    rawValue: b.raw,
    normalized: { kind: 'currency', code },
    valueWordIds: b.ids,
    labelWordIds: null,
    originalLabel: null,
    score: contested ? 0.55 : guessed ? 0.6 : ranked.length > 1 ? 0.72 : 0.8,
    method: 'pattern:currency-mark',
    signals: [],
  })
  if (contested) {
    const s = best.get(second[0])!
    out.push({
      field: 'currency',
      rawValue: s.raw,
      normalized: { kind: 'currency', code: second[0] },
      valueWordIds: s.ids,
      labelWordIds: null,
      originalLabel: null,
      score: 0.3,
      method: 'pattern:currency-mark',
      signals: [],
    })
  }
  return out
}

/** A shared currency sign ("$", "¥", "kr", "Fr."), which the parser reads as one default currency. */
export function bareDollar(raw: string): boolean {
  return currencyAmbiguity(raw) !== null
}

/**
 * What the shared currency sign printed on this document means: the one candidate currency also
 * printed unambiguously (an ISO code or a prefixed sign: "AMOUNT (AUD)", "A$", "US$"), else the
 * one the locale cues decide (ABN, Pty Ltd, GST/HST, a state and postcode, a country name), else
 * null (the parser's default stands). `printed` says the code itself is on the page.
 */
export function dollarCode(fc: FieldsContext): { code: string; printed: boolean } | null {
  const texts = fc.index.doc.lines.map((l) => l.text)
  let candidates: readonly string[] | null = null
  const printed = new Set<string>()
  for (const t of texts) {
    for (const c of findCurrencies(t)) {
      const amb = currencyAmbiguity(c.raw)
      if (amb) candidates ??= amb
      else printed.add(c.code)
    }
  }
  if (!candidates) return null
  const named = [...printed].filter((c) => candidates!.includes(c))
  if (named.length === 1) return { code: named[0]!, printed: true }
  if (named.length > 1) return null
  const locale = currencyFromLocaleCues(texts, candidates)
  return locale?.decisive ? { code: locale.code, printed: false } : null
}

/**
 * No currency printed at all (a till slip or a receipt with bare amounts): the currency of the
 * document's locale, when its cues decide it (ח.פ / עוסק מורשה / מע"מ / +972 → ILS). The evidence is
 * the cue as printed; the reading stays a weak proposal.
 */
export function localeCurrencyDraft(fc: FieldsContext): Draft | null {
  const lines = fc.index.doc.lines
  if (lines.some((l) => findCurrencies(l.text).length)) return null
  const locale = currencyFromLocaleCues(lines.map((l) => l.text))
  if (!locale?.decisive) return null
  for (const cue of locale.cues) {
    const line = lines.find((l) => l.text.includes(cue))
    if (!line) continue
    const start = line.text.indexOf(cue)
    const ids = wordsInSpan(fc.index, line, start, start + cue.length)
    if (!ids.length) continue
    return {
      field: 'currency',
      rawValue: cue,
      normalized: { kind: 'currency', code: locale.code },
      valueWordIds: ids,
      labelWordIds: null,
      originalLabel: null,
      score: 0.45,
      method: 'context:locale',
      signals: [],
    }
  }
  return null
}

/**
 * Money drafts whose amount carries a shared sign ("$") take the code it stands for on this
 * document (the parser's USD default would make every amount disagree with an AUD invoice).
 */
export function resolveDollars(fc: FieldsContext, money: Draft[]): Draft[] {
  const dollar = dollarCode(fc)
  if (!dollar) return money
  return money.map((d) => {
    if (d.normalized.kind !== 'money' || !d.normalized.currency || !bareDollar(markOf(d.rawValue))) return d
    return { ...d, normalized: { ...d.normalized, currency: dollar.code } }
  })
}

/** The currency mark printed in an amount's text ("$27,494.00" → "$"). */
function markOf(raw: string): string {
  return findCurrencies(raw)[0]?.raw ?? ''
}
