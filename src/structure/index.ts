import { indexDocument } from '../lib/docIndex'
import type { DocumentModel, Structure } from '../model/types'
import { findKeyValues } from './keyValues'
import { findTables, tableBodyLineIds } from './tables'

/** Layer 2: tables first, so key/value detection can leave table bodies alone. */
export function analyzeStructure(doc: DocumentModel): Structure {
  const index = indexDocument(doc)
  const tables = findTables(index)
  const keyValues = findKeyValues(index, { excludeLineIds: tableBodyLineIds(index, tables) })
  return { keyValues, tables }
}
