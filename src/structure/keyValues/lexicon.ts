import { classifyDocumentType, getConcept, matchLabels, type DocumentTypeMatch, type LabelMatch } from '../../semantic'

/**
 * Lexicon matching for the key/value and field layers, tolerant of two things printed invoices
 * do that the plain matcher (src/semantic) does not see:
 *
 *  - Letter-spaced headings. CSS letter spacing ("I N V O I C E", "C U S TO M E R", "ח ש ב ו נ י ת
 *    ז י כ ו י", a kerning split "FAC TUURNUMMER") makes the reader split words into letters, and
 *    the letters no longer spell a label. Runs of one- to three-letter tokens are joined again,
 *    keeping the word breaks that make a lexicon phrase ("D E L I V E R TO" → "DELIVER TO"), and the
 *    matches are mapped back to the printed characters. A join is used only when it lets the lexicon
 *    read more of the run than the text as printed, so ordinary short words stay as they are.
 *  - Abbreviations the lexicon does not list ("לכב'" for "לכבוד").
 *
 * Every match keeps offsets into the text as given, so callers map it to words as before.
 */

interface Run {
  /** Offsets of the run's tokens in the text. */
  tokens: { start: number; end: number }[]
}

/**
 * A token that may be a piece of a letter-spaced word: one or two letters, or an upper-case run
 * of a kerned heading ("FAC" + "TUURNUMMER", "TOTA" + "L").
 */
function isPiece(tok: string): boolean {
  return /^\p{L}{1,2}$/u.test(tok) || /^\p{Lu}{1,16}$/u.test(tok)
}

/** Runs of letter pieces separated by single spaces, with at least one single letter. */
function pieceRuns(text: string): Run[] {
  const toks = [...text.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }))
  const out: Run[] = []
  let cur: typeof toks = []
  const flush = () => {
    const singles = cur.filter((t) => t.text.length === 1).length
    const short = cur.filter((t) => t.text.length <= 3).length
    // Spaced letters, or a short upper-case heading with a kerning split in it.
    if (cur.length >= 2 && (singles >= 1 || (cur.length <= 4 && short >= 1))) out.push({ tokens: cur.map((t) => ({ start: t.start, end: t.end })) })
    cur = []
  }
  for (const t of toks) {
    const prev = cur[cur.length - 1]
    const adjacent = prev && t.start === prev.end + 1
    if (isPiece(t.text) && (!prev || adjacent)) {
      cur.push(t)
      continue
    }
    flush()
    if (isPiece(t.text)) cur.push(t)
  }
  flush()
  return out
}

/** Letters of a text the lexicon reads (inside a match). */
function coveredLetters(text: string, matches: readonly LabelMatch[]): number {
  let n = 0
  for (const m of matches) n += (text.slice(m.start, m.end).match(/\p{L}/gu) ?? []).length
  return n
}

/** Space positions (offsets into the text) of a run, between its tokens. */
function spacesOf(run: Run): number[] {
  return run.tokens.slice(1).map((t) => t.start - 1)
}

/**
 * The best spacing of one run: which of its spaces to keep (none, one or two), by how many of its
 * letters the lexicon then reads. Returns the spaces to remove, or null to keep the run as printed.
 */
function bestSpacing(text: string, run: Run): number[] | null {
  const spaces = spacesOf(run)
  const from = run.tokens[0]!.start
  const to = run.tokens[run.tokens.length - 1]!.end
  const piece = text.slice(from, to)
  const letters = (piece.match(/\p{L}/gu) ?? []).length
  if (letters < 3) return null
  const score = (keep: ReadonlySet<number>) => {
    let s = ''
    for (let i = from; i < to; i++) if (text[i] !== ' ' || keep.has(i)) s += text[i]
    const ms = matchLabels(s)
    return { covered: coveredLetters(s, ms), exact: ms.some((m) => m.exact) }
  }
  const asPrinted = coveredLetters(piece, matchLabels(piece))
  if (asPrinted === letters) return null
  const options: Set<number>[] = [new Set()]
  for (const a of spaces) options.push(new Set([a]))
  if (spaces.length <= 16) for (let i = 0; i < spaces.length; i++) for (let j = i + 1; j < spaces.length; j++) options.push(new Set([spaces[i]!, spaces[j]!]))
  let best: { keep: Set<number>; covered: number; exact: boolean } | null = null
  for (const keep of options) {
    const r = score(keep)
    if (!best || r.covered > best.covered || (r.covered === best.covered && r.exact && !best.exact)) best = { keep, ...r }
  }
  // Joined letters must spell (nearly) the whole run, and more of it than the printed tokens did.
  if (!best || best.covered <= asPrinted || best.covered < 0.8 * letters) return null
  return spaces.filter((s) => !best!.keep.has(s))
}

export interface Despaced {
  text: string
  /** Original offset of each character of `text`, plus the text length at the end. */
  offsets: number[]
}

const despacedCache = new Map<string, Despaced | null>()

/** The text with its letter-spaced runs joined, or null when nothing is letter-spaced. */
export function despace(text: string): Despaced | null {
  const cached = despacedCache.get(text)
  if (cached !== undefined) return cached
  let result: Despaced | null = null
  const runs = pieceRuns(text)
  const drop = new Set<number>()
  for (const r of runs) for (const s of bestSpacing(text, r) ?? []) drop.add(s)
  if (drop.size) {
    let out = ''
    const offsets: number[] = []
    for (let i = 0; i < text.length; i++) {
      if (drop.has(i)) continue
      out += text[i]
      offsets.push(i)
    }
    offsets.push(text.length)
    result = { text: out, offsets }
  }
  if (despacedCache.size > 5000) despacedCache.clear()
  despacedCache.set(text, result)
  return result
}

/** A [start, end) span of the despaced text, in the original text's offsets. */
export function originalRange(d: Despaced, start: number, end: number): { start: number; end: number } {
  return { start: d.offsets[start]!, end: end > start ? d.offsets[end - 1]! + 1 : d.offsets[start]! }
}

/**
 * Party phrases missing from the lexicon (to be moved there; see the fields team's report): the
 * concept they name and the lexicon phrase they stand for. Longer than any lexicon match they
 * overlap, they replace it ("מזמין העבודה" is the customer marker, not "מזמין" plus a name).
 */
const LOCAL_PHRASES: { re: RegExp; concept: string; phrase: string }[] = [
  // "לכב'" / "לכב׳": לכבוד (to, the addressee).
  { re: /(?<![\p{L}])ו?לכב['׳](?![\p{L}])/gu, concept: 'role.customer', phrase: 'לכבוד' },
  // The one who ordered the work / service, the holder of a (municipal) property account.
  { re: /(?<![\p{L}])(?:פרטי\s+)?(?:ה?מזמין|מזמינ[הת])\s+(?:ה?עבודה|ה?שירות)(?![\p{L}])/gu, concept: 'role.customer', phrase: 'מזמין' },
  { re: /(?<![\p{L}])(?:פרטי\s+)?(?:ה?מחזיק|מחזיק\s+ה?נכס)(?:\s+ב?נכס)?(?![\p{L}])/gu, concept: 'role.customer', phrase: 'לכבוד' },
  // "חשבון עבור": billed to (not a bank account).
  { re: /(?<![\p{L}])חשבון\s+עבור(?![\p{L}])/gu, concept: 'role.customer', phrase: 'עבור' },
  // העוסק: the dealer, i.e. the issuer ("פרטי העוסק", "שם העוסק").
  { re: /(?<![\p{L}])פרטי\s+ה?עוסק(?![\p{L}])/gu, concept: 'role.supplier', phrase: 'ספק' },
  { re: /(?<![\p{L}])שם\s+ה?עוסק(?![\p{L}])/gu, concept: 'supplier.name', phrase: 'שם הספק' },
]

/** Matches of the local phrases; a lexicon match they cover (or that covers less) gives way. */
function localMatches(text: string): LabelMatch[] {
  const out: LabelMatch[] = []
  for (const a of LOCAL_PHRASES) {
    const spec = getConcept(a.concept)
    if (!spec) continue
    a.re.lastIndex = 0
    for (const m of text.matchAll(a.re)) {
      const start = m.index
      const end = start + m[0].length
      const rest = text.slice(0, start) + text.slice(end)
      out.push({
        concept: spec.id,
        kind: spec.kind,
        fields: spec.fields,
        phrase: a.phrase,
        text: m[0],
        start,
        end,
        prefix: m[0].startsWith('ו') ? 'ו' : '',
        strength: 'strong',
        language: 'he',
        exact: !/[\p{L}\p{N}]/u.test(rest),
        also: [],
      })
    }
  }
  return out
}

const matchCache = new Map<string, LabelMatch[]>()

/**
 * Lexicon matches of a text (offsets into the text as given), best first, reading letter-spaced
 * headings and the local phrases above too.
 */
export function matchLabelsPlus(text: string): LabelMatch[] {
  const cached = matchCache.get(text)
  if (cached) return cached
  let matches: LabelMatch[]
  const d = despace(text)
  if (d) {
    matches = matchLabels(d.text).map((m) => {
      const r = originalRange(d, m.start, m.end)
      return { ...m, start: r.start, end: r.end, text: text.slice(r.start, r.end) }
    })
  } else matches = matchLabels(text)
  for (const x of localMatches(text)) {
    const overlap = matches.filter((m) => m.start < x.end && x.start < m.end)
    if (overlap.some((m) => m.end - m.start > x.end - x.start)) continue
    matches = matches.filter((m) => !overlap.includes(m))
    // Kept in the matcher's best-first (longest first) order.
    const i = matches.findIndex((m) => m.end - m.start < x.end - x.start)
    matches = i < 0 ? [...matches, x] : [...matches.slice(0, i), x, ...matches.slice(i)]
  }
  if (matchCache.size > 20000) matchCache.clear()
  matchCache.set(text, matches)
  return matches
}

/** The document type a text names (see classifyDocumentType), letter-spaced titles included. */
export function classifyDocumentTypePlus(text: string): DocumentTypeMatch | null {
  const d = despace(text)
  if (!d) return classifyDocumentType(text)
  const m = classifyDocumentType(d.text)
  if (!m) return classifyDocumentType(text)
  const r = originalRange(d, m.start, m.end)
  return { ...m, start: r.start, end: r.end, text: text.slice(r.start, r.end) }
}
