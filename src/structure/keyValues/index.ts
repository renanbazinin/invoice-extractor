import { textRefOf, wordsInSpan, type DocIndex } from '../../lib/docIndex'
import type { Direction, KeyValue, KeyValueLayout } from '../../model/types'
import { inlinePairs } from './inline'
import { expectedKinds, findAmounts, type LabelMatch } from '../../semantic'
import { buildLineInfo, mergeBilingualLabels, mergeWrappedLabels, mergeWrappedValues, readingSide, sameRow, sideGap, type LineInfo } from './lineInfo'
import { belowPartner, canLabel, gridPartner, type LinePair } from './pairing'

export interface KeyValueOptions {
  /** Lines inside table bodies, which are not label/value pairs. */
  excludeLineIds: ReadonlySet<string>
}

interface Draft {
  layout: KeyValueLayout
  labelIds: string[]
  valueIds: string[]
  score: number
  lineId: string
  weak: boolean
}

/**
 * Label/value pairs of every layout, by geometry and label shape only (meaning is
 * interpretation's job):
 *
 *  - inline: "label value" segments inside one line, in reading order (Hebrew included), several
 *    per line ("טל': 08-… | דוא"ל: …"); unknown labels are recognised by their colon;
 *  - grid: a label-only line and the nearest value line on the same row, on the label's
 *    reading side (left of a Hebrew label, right of an English one);
 *  - below: a label-only line and the aligned value line right under it.
 *
 * Every value line serves one label; the best-scored pairing wins.
 */
export function findKeyValues(index: DocIndex, opts: KeyValueOptions): KeyValue[] {
  const drafts: Draft[] = []
  for (const page of index.doc.pages) {
    const lines = (index.pageLines.get(page.number) ?? []).filter((l) => !opts.excludeLineIds.has(l.id))
    const infos = lines.map((l) => buildLineInfo(index, l))
    const inlineLines = new Set<string>()
    const pageDrafts: Draft[] = []
    for (const info of infos) {
      for (const p of inlinePairs(info.line.text, info.matches)) {
        const labelIds = wordsInSpan(index, info.line, p.label.start, p.label.end)
        const taken = new Set(labelIds)
        const valueIds = wordsInSpan(index, info.line, p.value.start, p.value.end).filter((id) => !taken.has(id))
        if (!labelIds.length || !valueIds.length) continue
        // "מע"מ 18%", "מע"מ 17% / VAT 17%": a label carrying its rate; the amount may sit in the next cell.
        const rateOnly = rateOnlyValue(info.line.text, p.value, info.matches)
        // "מקדמה ששולמה (14/09/2026)", "Less: paid on account": an amount label whose inline value
        // is a date or words, with the figure in the next cell of its row.
        const figureElsewhere = amountLine(info) && !hasFigure(info.line.text.slice(p.value.start, p.value.end)) && figureOnRow(info, infos)
        const strong = !rateOnly && !figureElsewhere && (p.colon || (!!p.head && p.head.strength === 'strong'))
        pageDrafts.push({ layout: 'inline', labelIds, valueIds, score: p.colon ? 0.9 : strong ? 0.75 : 0.6, lineId: info.line.id, weak: !strong })
        // A weak inline reading ("Net 60", "מס' 123") leaves the line free for a grid or below pairing.
        if (strong) inlineLines.add(info.line.id)
      }
    }
    const free = mergeWrappedValues(index, mergeBilingualLabels(index, mergeWrappedLabels(index, infos.filter((i) => !inlineLines.has(i.line.id)))))
    const paired = linePairs(free, pageDirection(infos))
    const used = new Set(paired.flatMap((p) => [p.label.line.id, p.value.line.id]))
    // The weak inline reading of a line that is a whole value elsewhere was a misreading.
    drafts.push(...pageDrafts.filter((d) => !(d.weak && used.has(d.lineId))))
    for (const p of paired) {
      drafts.push({ layout: p.layout, labelIds: p.label.line.wordIds, valueIds: p.value.line.wordIds, score: p.score, lineId: p.label.line.id, weak: false })
    }
  }
  return drafts.map((d, i) => ({ id: `kv${i + 1}`, label: textRefOf(index, d.labelIds), value: textRefOf(index, d.valueIds), layout: d.layout, score: d.score }))
}

/** The line names an amount (a money phrase anywhere in it). */
function amountLine(info: LineInfo): boolean {
  return info.matches.some((m) => expectedKinds(m.concept)[0] === 'amount' || m.also.some((c) => expectedKinds(c)[0] === 'amount'))
}

/** A money figure: an amount with cents or a currency mark. */
function hasFigure(text: string): boolean {
  return findAmounts(text).some((a) => a.decimals === 2 || !!a.currency)
}

/** A line further along the row (on the reading side) that is a money figure. */
function figureOnRow(info: LineInfo, infos: readonly LineInfo[]): boolean {
  const side = readingSide(info.dir)
  return infos.some((o) => o !== info && sameRow(info, o) && sideGap(info.bbox, o.bbox, side) !== null && o.valueScore >= 0.5 && hasFigure(o.line.text))
}

/** The value is only rates and label words of the line's own lexicon matches. */
function rateOnlyValue(text: string, value: { start: number; end: number }, matches: readonly LabelMatch[]): boolean {
  let v = text.slice(value.start, value.end)
  if (!/%/.test(v)) return false
  for (const m of matches) {
    if (m.start >= value.start && m.end <= value.end) v = v.replace(text.slice(m.start, m.end), ' ')
  }
  v = v.replace(/\(?\s*[-+]?\d+(?:[.,]\d+)?\s*%\s*\)?|%\s*\d+(?:[.,]\d+)?/g, ' ')
  return !/[\p{L}\p{N}]/u.test(v)
}

function pageDirection(infos: readonly LineInfo[]): Direction {
  const rtl = infos.filter((i) => i.dir === 'rtl').length
  return rtl * 2 >= infos.length ? 'rtl' : 'ltr'
}

/**
 * Grid and below pairs among lines that hold no inline pair, resolved greedily by score: a
 * label takes one value and a value serves one label.
 */
export function linePairs(infos: readonly LineInfo[], dir: Direction): LinePair[] {
  const options: LinePair[] = []
  for (const a of infos) {
    if (!canLabel(a)) continue
    const g = gridPartner(a, infos) ?? (a.dir !== dir ? gridPartner(a, infos, true) : null)
    if (g) options.push(g)
    const b = belowPartner(a, infos)
    if (b) options.push(b)
  }
  options.sort((x, y) => y.score - x.score || x.label.bbox.y0 - y.label.bbox.y0)
  const usedLabel = new Set<string>()
  const usedValue = new Set<string>()
  const chosen: LinePair[] = []
  for (const p of options) {
    const l = p.label.line.id
    const v = p.value.line.id
    if (usedLabel.has(l) || usedValue.has(v) || usedValue.has(l) || usedLabel.has(v)) continue
    usedLabel.add(l)
    usedValue.add(v)
    chosen.push(p)
  }
  return chosen
}
