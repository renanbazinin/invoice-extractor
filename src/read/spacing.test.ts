import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { glyphStream, looksLetterSpaced, respaceItem, streamCursor } from './spacing'
import { readDocument } from './index'

/** showText arguments as pdf.js gives them: one array of glyphs (or TJ numbers) per operation. */
const show = (...ops: (string | number)[][]): unknown[][] =>
  ops.map((glyphs) => [glyphs.map((g) => (typeof g === 'number' ? g : { unicode: g, isSpace: g === ' ' }))])
const chars = (s: string) => [...s]

describe('respaceItem (letter-spaced text)', () => {
  it('keeps only the spaces the content stream writes as space glyphs', () => {
    // Chrome draws letter-spaced text one glyph per operation, word spaces as space glyphs.
    const stream = glyphStream(show(['B'], ['I'], ['L'], ['L'], [' '], ['T'], ['O']))
    expect(respaceItem(chars('B I L L TO'), streamCursor(stream))?.join('')).toBe('BILL TO')
  })

  it('joins a short letter-spaced word drawn glyph by glyph', () => {
    const stream = glyphStream(show(['A', 'm', 'o', 'u', 'n', 't', ' ', 'd', 'u', 'e'], [' '], ['T'], ['O'], ['T'], ['A'], ['L']))
    expect(respaceItem(chars('TOTA L'), streamCursor(stream))?.join('')).toBe('TOTAL')
  })

  it('leaves two runs drawn apart without a space glyph alone unless they look letter-spaced', () => {
    // "Total" and "Due" in two spans with a margin: separately shown runs of several glyphs.
    const stream = glyphStream(show(['T', 'o', 't', 'a', 'l'], ['D', 'u', 'e'], [' '], ['x']))
    expect(respaceItem(chars('Total Due'), streamCursor(stream))).toBeNull()
  })

  it('treats a wide TJ adjustment as a word gap', () => {
    const stream = glyphStream(show(['I', 'N', 'V', -600, 'N', 'O'], [' ']))
    expect(respaceItem(chars('I N V N O'), streamCursor(stream))?.join('')).toBe('INV NO')
  })

  it('does nothing on pages that never write space glyphs', () => {
    const stream = glyphStream(show(['I'], ['N'], ['V']))
    expect(stream.hasSpaces).toBe(false)
    expect(respaceItem(chars('I N V'), streamCursor(stream))).toBeNull()
  })

  it('finds successive items in content order', () => {
    const stream = glyphStream(show(['A'], ['B'], [' '], ['C'], ['A'], ['B'], ['C']))
    const cursor = streamCursor(stream)
    expect(respaceItem(chars('A B C'), cursor)?.join('')).toBe('AB C')
    expect(respaceItem(chars('A B C'), cursor)?.join('')).toBe('ABC')
  })

  it('recognizes letter-spaced looking items', () => {
    expect(looksLetterSpaced(chars('I N V O I C E'))).toBe(true)
    expect(looksLetterSpaced(chars('Invoice No 5'))).toBe(false)
  })
})

describe('letter-spaced titles in a Chrome PDF', () => {
  it('reads "INVOICE" and "BILL TO" as words', async () => {
    const doc = await readDocument(new Uint8Array(readFileSync(new URL('./__fixtures__/letter-spaced.pdf', import.meta.url))))
    const texts = doc.lines.map((l) => l.text)
    expect(texts).toContain('TAX INVOICE')
    expect(texts).toContain('BILL TO')
    expect(texts).toContain('חשבונית זיכוי')
    expect(texts.some((t) => t.includes('Total due'))).toBe(true)
    // Two letter-spaced runs one word space apart (pdf.js splits them) stay one line.
    expect(texts).toContain('TOTAL DUE')
  })
})
