/**
 * Semantics: the multilingual knowledge layer (Hebrew first, then English, then de/fr/es/it/nl/pt).
 * - Lexicon: concepts with phrases per language and strength (concepts.ts, lexicon/*).
 * - Matching: matchLabels / labelScore / classifyDocumentType (match.ts).
 * - Value parsers: amounts, number formats, percents, quantities (numbers.ts), dates (dates.ts),
 *   currencies (currency.ts), tax ids, IBAN, Israeli bank accounts, e-mail, phone, identifiers
 *   (ids.ts), and the ranked value classifier (classify.ts).
 * Every parser is pure and returns null or a parse with the span it read (`raw`, `start`, `end`).
 */
export type {
  AmountParse,
  ConceptKind,
  ConceptSpec,
  DateOrder,
  LabelMatch,
  Lang,
  NumberFormat,
  Span,
  Strength,
  ValueKind,
} from './types'
export { CONCEPTS, conceptForDocType, conceptsForField, conceptsOfKind, getConcept, phraseEntries, type PhraseEntry } from './concepts'
export { bestLabel, classifyDocumentType, compilePhrase, labelScore, matchLabels, type DocumentTypeMatch, type MatchOptions } from './match'
export {
  currencyAmbiguity,
  currencyFromLocaleCues,
  DOLLAR_CURRENCIES,
  findCurrencies,
  parseCurrency,
  type CurrencyMention,
  type LocaleCurrency,
} from './currency'
export {
  findAmounts,
  inferNumberFormat,
  parseAmount,
  parsePercent,
  parseQuantity,
  readNumber,
  type PercentParse,
  type QuantityParse,
} from './numbers'
export { findDates, inferDateOrder, parseDate, type DateHints, type DateOrderInference, type DateParse } from './dates'
export {
  findPhones,
  isValidIsraeliId,
  ISRAELI_BANKS,
  looksLikeIdentifier,
  parseEmail,
  parseIban,
  parseIsraeliBankAccount,
  parseBankAccount,
  parsePhone,
  parseTaxId,
  taxIdCountryOfLabel,
  type AnyBankAccountParse,
  type BankAccountScheme,
  type BankAccountParse,
  type EmailParse,
  type IbanParse,
  type PhoneKind,
  type PhoneParse,
  type TaxIdHint,
  type TaxIdParse,
  type TaxIdScheme,
} from './ids'
export { classifyValue, expectedKinds, type ValueContext, type ValueGuess } from './classify'
export { foldLabel, foldValue, originalSpan, type MappedText } from './normalize'
