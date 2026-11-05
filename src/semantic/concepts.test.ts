import { describe, expect, it } from 'vitest'
import { CANONICAL_FIELDS, DOCUMENT_TYPES } from '../model/types'
import { CONCEPTS, conceptForDocType, conceptsForField, getConcept, phraseEntries } from './concepts'
import { compilePhrase, matchLabels } from './match'

describe('lexicon coverage', () => {
  it('has a concept for every canonical field (document_type through the title concepts)', () => {
    for (const field of CANONICAL_FIELDS) {
      expect(conceptsForField(field).length, field).toBeGreaterThan(0)
    }
  })

  it('has a title concept for every document type', () => {
    for (const type of DOCUMENT_TYPES) expect(conceptForDocType(type), type).toBeDefined()
  })

  it('uses unique concept ids, and Hebrew phrases for every field concept', () => {
    expect(new Set(CONCEPTS.map((c) => c.id)).size).toBe(CONCEPTS.length)
    for (const c of CONCEPTS.filter((c) => c.kind === 'field')) {
      expect(c.phrases.he?.length ?? 0, c.id).toBeGreaterThan(0)
    }
  })

  it('compiles every phrase', () => {
    for (const p of phraseEntries()) expect(compilePhrase(p.phrase), `${p.concept.id}: ${p.phrase}`).not.toBeNull()
  })

  it('matches every phrase against its own text as an exact label', () => {
    const failures: string[] = []
    for (const p of phraseEntries()) {
      // A '*' word stands for any word: try it with a sample word of the phrase's script.
      const text = p.phrase.replace('*', /[א-ת]/.test(p.phrase) ? 'דוגמה' : 'sample')
      const m = matchLabels(text, { concepts: [p.concept.id] })
      if (!m.length || !m[0].exact || m[0].start !== 0 || m[0].end !== text.length) failures.push(`${p.concept.id}: ${p.phrase}`)
    }
    expect(failures).toEqual([])
  })

  it('lists no phrase twice within one concept', () => {
    const seen = new Set<string>()
    const dup: string[] = []
    for (const p of phraseEntries()) {
      const key = `${p.concept.id}|${p.language}|${p.phrase}`
      if (seen.has(key)) dup.push(key)
      seen.add(key)
    }
    expect(dup).toEqual([])
  })

  it('marks fax as a trap and lists the main phone separately', () => {
    expect(getConcept('trap.fax')?.kind).toBe('trap')
    expect(getConcept('party.phone')?.fields).toEqual(['supplier.phone'])
  })
})
