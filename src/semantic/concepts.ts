import type { CanonicalField, DocumentType } from '../model/types'
import { COLUMN_CONCEPTS } from './lexicon/columns'
import { DOCTYPE_CONCEPTS } from './lexicon/doctypes'
import { FIELD_CONCEPTS } from './lexicon/fields'
import { PARTY_CONCEPTS } from './lexicon/parties'
import { TRAP_CONCEPTS } from './lexicon/traps'
import type { ConceptKind, ConceptSpec, Lang, Strength } from './types'

/**
 * The whole lexicon, in priority order: when two concepts list the very same phrase, the earlier
 * one is reported as the match's `concept` and the others in `also`.
 */
export const CONCEPTS: readonly ConceptSpec[] = [
  ...DOCTYPE_CONCEPTS,
  ...FIELD_CONCEPTS,
  ...PARTY_CONCEPTS,
  ...COLUMN_CONCEPTS,
  ...TRAP_CONCEPTS,
]

const BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]))

export function getConcept(id: string): ConceptSpec | undefined {
  return BY_ID.get(id)
}

/** Concepts that can name a canonical field (party attributes included). */
export function conceptsForField(field: CanonicalField): ConceptSpec[] {
  return CONCEPTS.filter((c) => c.fields.includes(field))
}

export function conceptsOfKind(kind: ConceptKind): ConceptSpec[] {
  return CONCEPTS.filter((c) => c.kind === kind)
}

/** The concept of a document type. */
export function conceptForDocType(type: DocumentType): ConceptSpec | undefined {
  return CONCEPTS.find((c) => c.docType === type)
}

export interface PhraseEntry {
  concept: ConceptSpec
  /** Position of the concept in CONCEPTS (lower wins ties). */
  order: number
  phrase: string
  strength: Strength
  language: Lang
  /** '=' in the lexicon: the first word takes no Hebrew one-letter prefix ("אתר" is a website,
   *  "באתר" is on site). */
  anchored: boolean
}

/** Every phrase of the lexicon, flattened; '~' is turned into strength 'weak', '=' into `anchored`. */
export function phraseEntries(): PhraseEntry[] {
  const out: PhraseEntry[] = []
  CONCEPTS.forEach((concept, order) => {
    for (const [language, list] of Object.entries(concept.phrases) as [Lang, readonly string[]][]) {
      for (const raw of list) {
        const weak = raw.startsWith('~')
        const body = weak ? raw.slice(1) : raw
        const anchored = body.startsWith('=')
        out.push({ concept, order, phrase: anchored ? body.slice(1) : body, strength: weak ? 'weak' : 'strong', language, anchored })
      }
    }
  })
  return out
}
