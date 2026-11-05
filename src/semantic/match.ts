import type { DocumentType } from '../model/types'
import { cleanText } from '../lib/text'
import { getConcept, phraseEntries, type PhraseEntry } from './concepts'
import { escapeRegExp, foldLabel, HEBREW_LETTER, originalSpan, type MappedText } from './normalize'
import type { ConceptKind, ConceptSpec, Lang, LabelMatch, Strength } from './types'

/**
 * Lexicon matching. Each lexicon phrase is compiled once into a regular expression over folded text
 * (see normalize.ts) that accepts the spelling variants printed invoices use:
 * - "No." / "No" / "Nr." / "N°" / "Nº" / "#" / "Number" are one token, and so are "מס'" / "מס׳" /
 *   "מספר" (but a bare "מס" is tax, so the last word of a phrase needs the geresh).
 * - Hebrew abbreviation marks are optional in words of 3+ letters (מע"מ = מע״מ = מעמ) and required
 *   in 2-letter ones (ח.פ = ח"פ, but "עמ'" is a page, not ע.מ); trailing marks are optional.
 * - Hebrew one-letter prefixes (ו ה ב ל מ ש כ, and combinations like וב, שה, וכש) in front of the
 *   first word, and the article ה in front of later words (תאריך החשבונית).
 * - Latin: case, accents, optional abbreviation dots, '-' or space inside compounds, a plural 's'.
 * - Between words: spaces, '/', '-', '|', ',', '&', '+' or parentheses ("חשבונית מס/קבלה").
 * A phrase written in UPPER CASE in the lexicon (EIN, CIF, CAP) only matches upper-case text,
 * because those acronyms are ordinary words in some language ("ein", "cap").
 *
 * Hebrew morphology the data does not have to spell out:
 * - The article on a later word is optional both ways: "פרטי הלקוח" = "פרטי לקוח", "תאריך
 *   חשבונית" = "תאריך החשבונית". A later word whose first ה is part of the stem (the verbal nouns
 *   הנחה, הזמנה, הקצאה, העברה, …: ה + 2-3 letters + ה/ת) keeps it.
 * - "ת." / "ת'" abbreviates תאריך before another word ("ת. אספקה" = "תאריך אספקה").
 * - '*' in a phrase is any one word: "הנחת *" is a discount whatever it is a discount of (the
 *   construct state names the head noun's kind: הנחת מסמך, הנחת מועדון, הנחת קבוצה).
 * Guards against false readings:
 * - A one-letter prefix is not stripped from an ordinary word that merely starts with a prefix
 *   letter (UNSPLIT: "שמונה" is eight, not ש + מונה; "מספק" supplies, it is not מ + ספק).
 * - A column phrase that is only a column (no field reading) is not a column title inside a
 *   longer text: "Services" in "Acme Services Ltd." or "שירות" in "בית קלייה · שירות למשרדים".
 * - A bare advance noun ("מקדמה", "Deposit", "Anzahlung") next to a percentage is a payment
 *   schedule ("מקדמה (30%)" is what must be paid up front), not an amount already paid.
 */

const LATIN_NO_WORDS = new Set(['no', 'no.', 'nr', 'nr.', 'n°', 'n°.', 'nro', 'nro.', '#', 'num', 'num.', 'n.', 'n.o', 'n.o.'])
const LATIN_NO = '(?:no\\.?|n\\.o\\.?|nr\\.?|nro\\.?|n ?°\\.?|num(?:ber|ero|\\.)?|nummer|n\\.|#)'
const HEB_NO_WORDS = new Set(["מס'", 'מספר', 'מס"'])
/** "מס'" or "מספר"; as the last word the geresh is required, else "מס" (tax) would match. */
const HEB_NO_LAST = `(?:מס['".]|מספר)`
const HEB_NO_INNER = `(?:מס['".]?|מספר)`
const HEB_PREFIX = '(ו?(?:כש|ש)?[בלמכ]?ה?)'
const SEP = '[\\s/|,&+()\\[\\]\\-]+'
const START = '(?<![\\p{L}\\p{N}])'
const END = '(?![\\p{L}\\p{N}])'
const HEB = /[א-ת]/

interface CompiledPhrase {
  source: string
  /** Longest literal run every match contains; a cheap pre-filter before running the regex. */
  key: string
  /** Matches must be upper case in the original text. */
  upper: boolean
}

interface Token {
  kind: 'latin_no' | 'heb_no' | 'symbol' | 'heb' | 'latin' | 'any'
  text: string
}

/**
 * '*' in a phrase: one word of letters (abbreviation marks inside allowed), but not a tax word or
 * a function word, which would change what the phrase names ("סה"כ מע"מ לתשלום" is VAT payable,
 * not a total payable; "הנחה על" is the start of a longer phrase).
 */
const ANY_WORD =
  `(?!(?:ה?מע"?מ|מס|על|של|לפני|אחרי|לאחר|כולל|ללא|עד|vat|tax|gst|of|on|before|after|incl|excl|including|excluding|mwst|tva|iva|btw)(?![\\p{L}'"]))\\p{L}[\\p{L}'"]*`

/**
 * Ordinary Hebrew words that begin with a prefix letter followed by a lexicon word. Matching them
 * as prefix + word turns a city name or a verb into a label ("קריית שמונה" → meter, "מספק" →
 * supplier, "למען" → address). Folded, without abbreviation marks; a leading ו or ה is ignored.
 */
const UNSPLIT: ReadonlySet<string> = new Set([
  'שמונה', 'שמונת', 'שמונים', 'ממונה', 'ממונים', 'ממונת', 'מספק', 'מספקת', 'מספקים', 'מספקות', 'למען',
  'מעיר', 'מעירים', 'שספק', 'כמונה', 'שמוכר', 'במוכר', 'ממוכר', 'כספק',
])

/** Verbal nouns whose first ה is part of the stem, not the article (הנחה, הזמנה, הקצאה, העברה). */
const STEM_HE = /^ה[א-ת]{2,3}[הת]$/

/** Bare advance nouns: next to a percentage they name a required advance, not a paid one. */
const ADVANCE_NOUNS: ReadonlySet<string> = new Set([
  'מקדמה', 'deposit', 'advance payment', 'prepayment', 'anzahlung', 'acompte', 'anticipo', 'acconto', 'aanbetaling',
  'adiantamento', 'sinal',
])
/** Plural payment words that, next to a small whole number, count card instalments. */
const INSTALMENT_WORDS: ReadonlySet<string> = new Set(['תשלומים', 'payments'])
const PERCENT_AFTER = /^\s*[(:]?\s*[-+]?\d+(?:[.,]\d+)?\s?%/
const PERCENT_BEFORE = /\d+(?:[.,]\d+)?\s?%\s*[)]?\s*$|%\s?\d+(?:[.,]\d+)?\s*[)]?\s*$/

/** Legal-entity suffixes: a text that carries one is a name, never a column title. */
const LEGAL_NAME =
  /(?:בע["'״]?מ|\(ע["״]ר\))|(?<![\p{L}])(?:ltd|limited|inc|llc|plc|gmbh|ag|kg|sarl|sas|bv|b\.v|nv|n\.v|spa|s\.p\.a|srl|s\.r\.l|s\.l|s\.a|s\.r\.o|pty|corp|co\.)(?![\p{L}])/iu

function tokenize(folded: string): Token[] {
  const words: string[] = []
  for (const w of folded.split(' ')) {
    if (!w) continue
    // Split "ח.פ./ע.מ." and "product/service", keep "a/c", "u/m", "c/f" whole.
    if (w.includes('/') && !/^[a-z]\/[a-z]\.?$/.test(w)) {
      w.split('/').forEach((part) => part && words.push(part))
    } else words.push(w)
  }
  return words.map((text) => {
    if (text === '*') return { kind: 'any', text }
    if (LATIN_NO_WORDS.has(text)) return { kind: 'latin_no', text }
    if (HEB_NO_WORDS.has(text)) return { kind: 'heb_no', text }
    if (!/[\p{L}\p{N}]/u.test(text)) return { kind: 'symbol', text }
    return { kind: HEB.test(text) ? 'heb' : 'latin', text }
  })
}

function hebrewWord(word: string, first: boolean, last: boolean): { source: string; runs: string[] } {
  const bare = word.replace(/[^א-ת]/g, '')
  const letters = bare.length
  // "ת. אספקה", "ת' ערך": the date word abbreviated before another word.
  if (word === 'תאריך' && !last) return { source: `(?:תאריך|ת['".]{1,2} ?)`, runs: [] }
  const runs: string[] = []
  let source = ''
  let run = ''
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (HEB.test(ch) || /\p{N}/u.test(ch)) {
      source += ch
      run += ch
      continue
    }
    if (run) runs.push(run)
    run = ''
    let j = i
    while (j < word.length && !HEB.test(word[j]) && !/\p{N}/u.test(word[j])) j++
    const marks = word.slice(i, j)
    if (/^['".\-]+$/.test(marks)) {
      if (j === word.length) source += `['".]?`
      else source += letters < 3 ? `['".\\-]{1,2} ?` : `['".\\-]{0,2} ?`
    } else source += escapeRegExp(marks)
    i = j - 1
  }
  if (run) runs.push(run)
  if (!first && letters >= 3 && !word.startsWith('ה')) source = `ה?${source}`
  // "פרטי הלקוח" also covers "פרטי לקוח": the article of a later word is optional.
  else if (!first && word.startsWith('ה') && letters >= 4 && !STEM_HE.test(bare)) {
    source = `ה?${source.slice(1)}`
    runs[0] = runs[0].slice(1)
  }
  return { source, runs }
}

function latinWord(word: string): { source: string; runs: string[] } {
  const runs: string[] = []
  let source = ''
  let run = ''
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (/[\p{L}\p{N}]/u.test(ch)) {
      source += escapeRegExp(ch)
      run += ch
      continue
    }
    if (run) runs.push(run)
    run = ''
    const last = i === word.length - 1
    if (ch === '.') source += last ? '\\.?' : '\\.? ?'
    else if (ch === '-') source += '[- ]?'
    else if (ch === "'") source += "'? ?"
    else if (ch === '/') source += ' ?/ ?'
    else source += escapeRegExp(ch)
  }
  if (run) runs.push(run)
  const letters = word.replace(/[^\p{L}]/gu, '')
  if (/\p{L}$/u.test(word) && letters.length >= 4 && !word.endsWith('s')) source += 's?'
  return { source, runs }
}

/**
 * Compiles one lexicon phrase. Exported for tests and for callers building ad-hoc matchers.
 * `anchored`: the first word takes no Hebrew one-letter prefix.
 */
export function compilePhrase(phrase: string, anchored = false): CompiledPhrase | null {
  const folded = foldLabel(phrase).text
  const tokens = tokenize(folded)
  if (!tokens.length) return null
  const upper = /\p{Lu}/u.test(phrase) && phrase === phrase.toUpperCase() && /[A-Z]/.test(phrase)
  const runs: string[] = []
  const parts: string[] = []
  tokens.forEach((t, i) => {
    const last = i === tokens.length - 1
    let source: string
    if (t.kind === 'latin_no') source = LATIN_NO
    else if (t.kind === 'heb_no') source = last ? HEB_NO_LAST : HEB_NO_INNER
    else if (t.kind === 'symbol') source = escapeRegExp(t.text)
    else if (t.kind === 'any') source = ANY_WORD
    else {
      const w = t.kind === 'heb' ? hebrewWord(t.text, i === 0, last) : latinWord(t.text)
      source = w.source
      runs.push(...w.runs)
    }
    if (i > 0) {
      const prev = tokens[i - 1]
      // The abbreviated date word carries its own optional space ("ת.אספקה", "ת. אספקה").
      const abbrevDate = prev.kind === 'heb' && prev.text === 'תאריך'
      const tight = t.kind === 'symbol' || prev.kind === 'symbol' || t.kind === 'latin_no' || abbrevDate
      // "Inv. No", "Art. Nr.": a Latin word may carry an abbreviation dot before the next word.
      const dot = prev.kind === 'latin' ? '\\.?' : ''
      parts.push(`${dot}${tight ? SEP.replace(/\+$/, '*') : SEP}`)
    }
    parts.push(source)
  })
  const first = tokens[0]
  const firstLetters = first.text.replace(/[^א-ת]/g, '').length
  const prefix = !anchored && ((first.kind === 'heb' && firstLetters >= 3) || first.kind === 'heb_no') ? HEB_PREFIX : '()'
  const lastTok = tokens[tokens.length - 1]
  // A Hebrew phrase that ends in a letter must not be followed by a geresh: "מס" is not "מס'".
  const tail = HEBREW_LETTER.test(lastTok.text) && /[א-ת]$/.test(lastTok.text) ? `(?!['"])` : ''
  // A Hebrew word joined to another by a hyphen or maqaf is part of a compound ("דור-אל", "אל-פסק").
  const hyphenBefore = HEB.test(first.text) ? '(?<![א-ת]-)' : ''
  const hyphenAfter = HEB.test(lastTok.text) ? '(?!-[א-ת])' : ''
  const source = `${START}${hyphenBefore}${prefix}(?:${parts.join('')})${END}${tail}${hyphenAfter}`
  const key = runs.reduce((best, r) => (r.length > best.length ? r : best), '')
  return { source, key: key.length >= 2 ? key : '', upper }
}

interface CompiledEntry {
  re: RegExp
  key: string
  upper: boolean
  owners: PhraseEntry[]
}

let compiled: CompiledEntry[] | null = null

function compiledLexicon(): CompiledEntry[] {
  if (compiled) return compiled
  const bySource = new Map<string, CompiledEntry>()
  for (const entry of phraseEntries()) {
    const c = compilePhrase(entry.phrase, entry.anchored)
    if (!c) continue
    const id = `${c.upper ? 'U' : 'i'}:${c.source}`
    let e = bySource.get(id)
    if (!e) {
      e = { re: new RegExp(c.source, 'gu'), key: c.key, upper: c.upper, owners: [] }
      bySource.set(id, e)
    }
    // One owner per concept: the first (strongest-listed) spelling wins.
    const same = e.owners.find((o) => o.concept.id === entry.concept.id)
    if (!same) e.owners.push(entry)
    else if (same.strength === 'weak' && entry.strength === 'strong') e.owners[e.owners.indexOf(same)] = entry
  }
  compiled = [...bySource.values()]
  return compiled
}

export interface MatchOptions {
  /** Only concepts of these kinds. */
  kinds?: readonly ConceptKind[]
  /** Only these concept ids. */
  concepts?: readonly string[]
}

interface RawMatch {
  from: number
  to: number
  prefix: string
  entry: PhraseEntry
}

const strengthRank = (s: Strength): number => (s === 'strong' ? 0 : 1)

function compareRaw(a: RawMatch, b: RawMatch): number {
  const coreA = a.to - a.from - a.prefix.length
  const coreB = b.to - b.from - b.prefix.length
  return (
    coreB - coreA ||
    strengthRank(a.entry.strength) - strengthRank(b.entry.strength) ||
    a.prefix.length - b.prefix.length ||
    a.entry.order - b.entry.order ||
    a.from - b.from
  )
}

function findRaw(folded: MappedText, opts: MatchOptions): RawMatch[] {
  const out: RawMatch[] = []
  const kinds = opts.kinds ? new Set(opts.kinds) : null
  const ids = opts.concepts ? new Set(opts.concepts) : null
  for (const e of compiledLexicon()) {
    if (e.key && !folded.text.includes(e.key)) continue
    const owners = e.owners.filter((o) => (!kinds || kinds.has(o.concept.kind)) && (!ids || ids.has(o.concept.id)))
    if (!owners.length) continue
    e.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = e.re.exec(folded.text))) {
      const from = m.index
      const to = from + m[0].length
      e.re.lastIndex = from + 1
      if (e.upper) {
        const printed = folded.source.slice(folded.start[from], folded.end[to - 1])
        if (printed !== printed.toUpperCase()) continue
      }
      if (unsplit(folded.text, from, m[1] ?? '')) continue
      for (const entry of owners) out.push({ from, to, prefix: m[1] ?? '', entry })
    }
  }
  return out
}

/**
 * Spans of e-mail addresses, URLs and domain names: a label inside them is not a label
 * ("billing@supplier.co.il" holds "supplier", "www.invoice-online.com" holds "invoice").
 */
function protectedSpans(folded: string): [number, number][] {
  const out: [number, number][] = []
  for (const m of folded.matchAll(/\S+/g)) {
    const tok = m[0]
    if (tok.includes('@') || /^(?:https?:\/\/|www\.)/.test(tok) || /[a-z0-9-]\.(?:com|net|org|co|il|io|de|fr|uk|info|biz|gov|edu|eu|nl|it|es)(?![a-z])/.test(tok)) {
      out.push([m.index, m.index + tok.length])
    }
  }
  return out
}

function isExact(folded: string, from: number, to: number): boolean {
  const rest = folded.slice(0, from) + folded.slice(to)
  return !/[\p{L}\p{N}]/u.test(rest)
}

/** The prefixed word is an ordinary word of its own (UNSPLIT), not prefix + lexicon word. */
function unsplit(folded: string, from: number, prefix: string): boolean {
  if (!prefix) return false
  const tok = (/^[^\s/|,&+()[\]-]+/.exec(folded.slice(from))?.[0] ?? '').replace(/['"]/g, '')
  return UNSPLIT.has(tok) || UNSPLIT.has(tok.replace(/^ו?ה?/, ''))
}

/** Words of a text that count for its length: no parenthesised asides, codes or symbols. */
function contentWords(text: string): number {
  const t = text.replace(/\([^)]*\)/g, ' ').replace(/(?<![\p{L}])[A-Z]{3}(?![\p{L}])/gu, ' ')
  return t.split(/[\s/|,·•–-]+/).filter((w) => /\p{L}/u.test(w)).length
}

/**
 * Column phrases that are only columns, inside a text that is not a column title: a name with a
 * legal suffix ("Acme Services Ltd."), or a longer text where the phrase has words on both sides
 * and is the only column word ("Calibration service on site"). A header row printed as one line
 * ("פריט כמות מחיר סכום") names several columns and keeps them all.
 */
function strayColumns(raw: RawMatch[], folded: string, source: string): Set<RawMatch> {
  const out = new Set<RawMatch>()
  const columnOnly = raw.filter(
    (r) => r.entry.concept.kind === 'column' && !raw.some((o) => o.from === r.from && o.to === r.to && o.entry.concept.kind !== 'column'),
  )
  if (!columnOnly.length) return out
  if (LEGAL_NAME.test(source)) {
    for (const r of columnOnly) out.add(r)
    return out
  }
  const spans = new Set(raw.filter((r) => r.entry.concept.kind === 'column').map((r) => `${r.from}:${r.to}`))
  const disjoint = [...spans].map((s) => s.split(':').map(Number)).filter(([a, b], i, all) => !all.some(([c, d], j) => j !== i && c <= a && d >= b && d - c > b - a))
  if (disjoint.length > 1 || contentWords(source) <= 3) return out
  for (const r of columnOnly) {
    if (/\p{L}/u.test(folded.slice(0, r.from)) && /\p{L}/u.test(folded.slice(r.to))) out.add(r)
    // "Unit 3B, Hartwell Business Park": a column word numbered like a part of an address.
    else if (/^ ?\d/.test(folded.slice(r.to))) out.add(r)
  }
  return out
}

/** "מקדמה (30%)", "Deposit 30 %": the advance still to be paid under a payment schedule. */
function isScheduledAdvance(r: RawMatch, text: string, start: number, end: number): boolean {
  if (r.entry.concept.id !== 'amount_paid' || !ADVANCE_NOUNS.has(foldLabel(r.entry.phrase).text)) return false
  return PERCENT_AFTER.test(text.slice(end)) || PERCENT_BEFORE.test(text.slice(0, start))
}

/**
 * "3 תשלומים", "תשלומים: 1": the number of card instalments, not payments received. The plural
 * "payments" word counts instalments when a small whole number stands right before or after it.
 */
function isInstalmentCount(r: RawMatch, text: string, start: number, end: number): boolean {
  if (r.entry.concept.id !== 'amount_paid' || !INSTALMENT_WORDS.has(foldLabel(r.entry.phrase).text)) return false
  return /(?<![\d.,])\d{1,2}\s*$/.test(text.slice(0, start)) || /^\s*[:-]?\s*\d{1,2}(?![\d]|[.,]\d)/.test(text.slice(end))
}

/** The concept a match names in its context (see isScheduledAdvance, isInstalmentCount). */
function contextualConcept(r: RawMatch, text: string, start: number, end: number): ConceptSpec {
  if (isScheduledAdvance(r, text, start, end)) return getConcept('other.payment_schedule') ?? r.entry.concept
  if (isInstalmentCount(r, text, start, end)) return getConcept('other.installments') ?? r.entry.concept
  return r.entry.concept
}

/**
 * Finds lexicon phrases in a line of text. Returns non-overlapping matches, best first: the
 * longest phrase wins (so "סה"כ לעמוד" beats "סה"כ" and "מספר לקוח" beats "מספר"), then strong over
 * weak, then a match without a Hebrew prefix, then lexicon order. When several concepts list the
 * same phrase the first is `concept` and the rest are in `also`.
 */
export function matchLabels(text: string, opts: MatchOptions = {}): LabelMatch[] {
  if (!text) return []
  const folded = foldLabel(text)
  if (!folded.text) return []
  const shielded = protectedSpans(folded.text)
  const found = findRaw(folded, opts).filter((r) => !shielded.some(([a, b]) => r.from < b && a < r.to))
  const stray = strayColumns(found, folded.text, text)
  const raw = found.filter((r) => !stray.has(r)).sort(compareRaw)
  const chosen: RawMatch[] = []
  const out: LabelMatch[] = []
  for (const r of raw) {
    if (chosen.some((c) => r.from < c.to && c.from < r.to)) continue
    chosen.push(r)
    const also = [
      ...new Set(
        raw
          .filter((o) => o !== r && o.from === r.from && o.to === r.to && o.entry.concept.id !== r.entry.concept.id)
          .map((o) => o.entry.concept.id),
      ),
    ]
    const { start, end } = originalSpan(folded, r.from, r.to)
    const concept = contextualConcept(r, text, start, end)
    out.push({
      concept: concept.id,
      kind: concept.kind,
      fields: concept.fields,
      phrase: r.entry.phrase,
      text: text.slice(start, end),
      start,
      end,
      prefix: r.prefix,
      strength: r.entry.strength,
      language: r.entry.language,
      exact: isExact(folded.text, r.from, r.to),
      also,
    })
  }
  return out
}

/** The best label match of a text, or null. */
export function bestLabel(text: string, opts: MatchOptions = {}): LabelMatch | null {
  return matchLabels(text, opts)[0] ?? null
}

export interface DocumentTypeMatch {
  type: DocumentType
  concept: string
  phrase: string
  text: string
  start: number
  end: number
  strength: Strength
  language: Lang
}

/**
 * The document type named in a text (a title line, or a whole page's text: the longest title
 * phrase wins). A title word inside a longer label that starts earlier ("מספר חשבונית", "תאריך
 * חשבונית") or that is a date label ("Invoice date") is not a title. "חשבונית מס' 123" is read as
 * a weak tax invoice: the geresh makes "מס'" the number sign, but Israeli invoices are tax invoices.
 */
export function classifyDocumentType(text: string): DocumentTypeMatch | null {
  const all = matchLabels(text)
  const docs = matchLabels(text, { kinds: ['doctype'] }).filter((d) => {
    const container = all.find((m) => m.kind !== 'doctype' && m.start <= d.start && m.end >= d.end && m.end - m.start > d.end - d.start)
    if (!container) return true
    const isDate = container.fields.some((f) => f.endsWith('_date'))
    return container.start === d.start && !isDate
  })
  if (!docs.length) return null
  const best = [...docs].sort(
    (a, b) => b.end - b.start - b.prefix.length - (a.end - a.start - a.prefix.length) || strengthRank(a.strength) - strengthRank(b.strength) || a.start - b.start,
  )[0]
  const concept = getConcept(best.concept)
  if (!concept?.docType) return null
  let type: DocumentType = concept.docType
  let strength = best.strength
  if (type === 'invoice' && best.language === 'he') {
    const after = foldLabel(text.slice(best.end)).text
    if (/^מס['"]/.test(after)) {
      type = 'tax_invoice'
      strength = 'weak'
    }
  }
  return { type, concept: best.concept, phrase: best.phrase, text: best.text, start: best.start, end: best.end, strength, language: best.language }
}

/**
 * How much a text looks like a label at all (0..1), lexicon or not, so the structure layer can
 * pair unknown labels in any language: a trailing (or, in RTL logical order, leading) colon, few
 * words, letters and no digits, no e-mail/URL; a lexicon match adds to it.
 */
export function labelScore(text: string): number {
  const t = cleanText(text)
  if (!t) return 0
  const letters = (t.match(/\p{L}/gu) ?? []).length
  const digits = (t.match(/\p{N}/gu) ?? []).length
  if (!letters) return 0
  let s = 0.3
  if (/[:：]\s*$/.test(t) || /^\s*[:：]/.test(t)) s += 0.3
  const words = t.split(' ').length
  if (words <= 3) s += 0.15
  else if (words <= 6) s += 0.05
  else s -= 0.2
  if (!digits) s += 0.15
  else s -= (digits / (letters + digits)) * 0.6 + 0.05
  if (t.length > 40) s -= 0.2
  if (/@|https?:|www\./i.test(t)) s -= 0.4
  const best = bestLabel(t)
  if (best) {
    s += best.strength === 'strong' ? 0.2 : 0.08
    if (best.exact) s += 0.15
  }
  return Math.max(0, Math.min(1, Math.round(s * 100) / 100))
}
