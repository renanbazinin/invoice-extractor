/**
 * Word-order repairs for right-to-left lines whose bidi reading is ambiguous, by the grammar of
 * dates.
 *
 * A cell set left-to-right inside a Hebrew page (`direction: ltr`, an isolate, a table cell of
 * an invoicing program) is drawn exactly like a right-to-left paragraph draws the opposite word
 * order: the LTR cell "24 ביולי 2026" puts the Hebrew month and everything after it in one
 * right-to-left run, so it is drawn "24 2026 ביולי", which reads back right to left as
 * "ביולי 2026 24". Generally, LTR content `n1..nk H x1..xm` (numbers, then a Hebrew word and
 * whatever follows it) reads back right to left as `H x1..xm nk..n1`: the numbers before the
 * first Hebrew word move to the end, reversed. Likewise an LTR cell "30/12/2025 - 23/2/2026"
 * reads back as "23/2/2026 - 30/12/2025", and "31/10/2026 12:30" as "12:30 31/10/2026".
 *
 * Nothing on the page tells the two readings apart, so the grammar of dates decides:
 *  - a day number belongs before a Hebrew month name ("24 ביולי 2026"), never after its year;
 *  - the earlier date of a range comes first;
 *  - a time follows its date.
 * The rules only move words of a date expression and only when the reading as given is not
 * well-formed, so text that was read correctly is never touched.
 */

/** Hebrew month names, full and abbreviated (geresh as ' or ׳), with an optional ב/ל/מ/ו/ה prefix. */
const HEB_MONTH = /^[ובלמה]?(?:ינואר|פברואר|מר[ץס]|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר|(?:ינו|פבר|אפר|אוג|ספט|אוק|נוב|דצמ)['׳])[,.]?$/u
const YEAR = /^(?:19|20)\d\d[,.]?$/u
const DAY = /^(?:0?[1-9]|[12]\d|3[01])[,.]?$/u
const TIME = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u
const NUM_DATE = /^(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})$/u
const YMD_DATE = /^(\d{4})([./-])(\d{1,2})\2(\d{1,2})$/u
const RANGE_SEP = /^(?:-|–|—|עד)$/u
const GLUED_RANGE = /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})([–—-])(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})$/u

export const isHebrewMonth = (t: string): boolean => HEB_MONTH.test(t)

/** A numeric date as a sortable number (yyyymmdd), day first as written in Israel and Europe; null if none. */
export function numericDateKey(t: string): number | null {
  let m = NUM_DATE.exec(t)
  if (m) {
    const d = Number(m[1])
    const mo = Number(m[3])
    const y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4])
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null
    return y * 10000 + mo * 100 + d
  }
  m = YMD_DATE.exec(t)
  if (m) {
    const mo = Number(m[3])
    const d = Number(m[4])
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null
    return Number(m[1]) * 10000 + mo * 100 + d
  }
  return null
}

/**
 * End (exclusive) of a well-formed Hebrew month-name date starting at `i` ("24 ביולי 2026
 * 17:47": day, month, year, optional times), or -1.
 */
function wellFormedDateEnd(texts: readonly string[], i: number): number {
  if (!DAY.test(texts[i] ?? '') || !HEB_MONTH.test(texts[i + 1] ?? '') || !YEAR.test(texts[i + 2] ?? '')) return -1
  let j = i + 3
  while (j < texts.length && TIME.test(texts[j])) j++
  return j
}

/**
 * Repairs month-name dates read back from an LTR cell: "ביולי 2026 24" → "24 ביולי 2026",
 * "אוגוסט 2025 17:47 23" → "23 אוגוסט 2025 17:47", and the range "במאי 2026 - 19 ביולי 2026 27"
 * → "27 במאי 2026 - 19 ביולי 2026". Returns the new order as indices, or null when nothing
 * changes.
 */
function monthDateOrder(texts: readonly string[]): number[] | null {
  const n = texts.length
  for (let i = 0; i < n; i++) {
    if (!HEB_MONTH.test(texts[i]) || (i > 0 && DAY.test(texts[i - 1])) || !YEAR.test(texts[i + 1] ?? '')) continue
    // The date (and the rest of a range) as it stands after the month.
    let j = i + 2
    while (j < n && TIME.test(texts[j])) j++
    if (j + 1 < n && RANGE_SEP.test(texts[j])) {
      const end = wellFormedDateEnd(texts, j + 1)
      if (end > 0) j = end
      // The end date's year wrapped onto the next line of a narrow cell: "… - 13 יוני".
      else if (DAY.test(texts[j + 1]) && HEB_MONTH.test(texts[j + 2] ?? '')) j += 3
    }
    // The numbers that were drawn before the month: a day, possibly with a time before it.
    if (j >= n || !DAY.test(texts[j])) continue
    const k = TIME.test(texts[j + 1] ?? '') ? j + 2 : j + 1
    // A number right after them would make this a run of figures, not a date.
    if (k < n && /^\d/u.test(texts[k])) continue
    const idx = texts.map((_, x) => x)
    const moved = idx.slice(j, k).reverse()
    return [...idx.slice(0, i), ...moved, ...idx.slice(i, j), ...idx.slice(k)]
  }
  return null
}

/** "23/2/2026 - 30/12/2025" → "30/12/2025 - 23/2/2026"; "12:30 31/10/2026" → "31/10/2026 12:30". */
function numericDateOrder(texts: readonly string[]): number[] | null {
  const idx = texts.map((_, x) => x)
  let changed = false
  for (let i = 0; i + 2 < idx.length; i++) {
    const a = numericDateKey(texts[idx[i]])
    const b = numericDateKey(texts[idx[i + 2]])
    if (a === null || b === null || !RANGE_SEP.test(texts[idx[i + 1]]) || a <= b) continue
    ;[idx[i], idx[i + 2]] = [idx[i + 2], idx[i]]
    changed = true
  }
  for (let i = 0; i + 1 < idx.length; i++) {
    if (!TIME.test(texts[idx[i]]) || numericDateKey(texts[idx[i + 1]]) === null) continue
    // "10:00 31/10/2026 - 12:00 ..." is not a date followed by its time: leave ranges of times alone.
    if (i > 0 && (TIME.test(texts[idx[i - 1]]) || numericDateKey(texts[idx[i - 1]]) !== null)) continue
    ;[idx[i], idx[i + 1]] = [idx[i + 1], idx[i]]
    changed = true
  }
  return changed ? idx : null
}

/**
 * The words of a line read right to left, put in the order the grammar of dates requires (see
 * the module comment). Returns the same array when nothing changes.
 */
export function repairDateOrder<T extends { text: string }>(words: readonly T[]): readonly T[] {
  let out = words
  // A range written without spaces is one word: "30/09/2026–01/09/2026" → "01/09/2026–30/09/2026".
  if (words.some((w) => GLUED_RANGE.test(w.text))) {
    out = words.map((w) => {
      const m = GLUED_RANGE.exec(w.text)
      if (!m) return w
      const a = numericDateKey(m[1])
      const b = numericDateKey(m[3])
      return a !== null && b !== null && a > b ? { ...w, text: m[3] + m[2] + m[1] } : w
    })
    if (out.every((w, i) => w === words[i])) out = words
  }
  for (const rule of [monthDateOrder, numericDateOrder]) {
    // A line can hold more than one date; each pass fixes the first ill-formed one.
    for (let guard = 0; guard < 4; guard++) {
      const order = rule(out.map((w) => w.text))
      if (!order) break
      out = order.map((k) => out[k])
    }
  }
  return out
}
