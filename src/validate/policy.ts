import type { CanonicalField, FieldStatus } from '../model/types'

/**
 * Every number and rule that decides a status lives here, so the safety policy can be reviewed in
 * one place. The guiding rule (docs/ARCHITECTURE.md, "Never silently wrong"): 'verified' is a
 * promise that the value is on the page AND something independent of the candidate's own label
 * confirms it. When in doubt the answer is 'proposed' or 'needs_review'; a correct needs_review
 * costs a person a glance, a wrong verified costs money.
 */

export type FieldKind = 'money' | 'rate' | 'identifier' | 'date' | 'code' | 'name' | 'address' | 'contact' | 'terms'

export const FIELD_KIND: Record<CanonicalField, FieldKind> = {
  document_type: 'code',
  invoice_number: 'identifier',
  invoice_date: 'date',
  due_date: 'date',
  delivery_date: 'date',
  po_number: 'identifier',
  allocation_number: 'identifier',
  currency: 'code',
  subtotal: 'money',
  discount: 'money',
  tax_rate: 'rate',
  tax_amount: 'money',
  total: 'money',
  amount_paid: 'money',
  amount_due: 'money',
  rounding: 'money',
  payment_terms: 'terms',
  'supplier.name': 'name',
  'supplier.tax_id': 'identifier',
  'supplier.address': 'address',
  'supplier.phone': 'contact',
  'supplier.email': 'contact',
  'supplier.bank_account': 'identifier',
  'customer.name': 'name',
  'customer.tax_id': 'identifier',
  'customer.address': 'address',
}

/** Fields whose absence is reported as an issue and listed in `summary.missing`. */
export const CORE_FIELDS: readonly CanonicalField[] = ['invoice_number', 'invoice_date', 'total', 'supplier.name']

export interface KindPolicy {
  /** The best status this kind of field can ever get. */
  max: FieldStatus
  /** All of these must hold for 'verified'. */
  verified: string
  /** Any of these gives 'needs_review'. Everything else found is 'proposed'. */
  needsReview: string
}

/**
 * The status policy, per field kind. The code in this folder implements exactly these rules; the
 * strings are the specification and are kept next to the thresholds they use.
 */
export const STATUS_POLICY: Record<FieldKind, KindPolicy> = {
  money: {
    max: 'verified',
    verified:
      '(1) A passing arithmetic check confirms it. Precise: the check closes with no difference at all and a ' +
      'one-cent change of the field would break it. Coarse (role confirmed, last digit not): the check closes within ' +
      'one cent, or sees the field only through a tax rate; coarse counts only when the field and every other input ' +
      'of the check are embedded text (cannot be misread), the field is not a subtraction partner (subtotal - discount ' +
      'is pinned, not each), and no rounding is printed or mentioned (figures before/after rounding sit agorot apart). ' +
      '(2) Every other value in that check can vouch: not disputed by a competitor, not overruled, not rescued, not in ' +
      'a failing check, not a page total, not equal to another chosen field (permuted roles), not a zero or a few ' +
      'agorot, and not cancelling against another term (x - x adds nothing). ' +
      '(3) No failing strong check involves it. (4) No other value of the field is confirmed in a consistent ' +
      'combination that keeps the winner\'s strong figures or uses a strong figure the winner ignores. (5) The ' +
      'arithmetic did not overrule a reading at least overrideMargin stronger. (6) Not labelled as a page total. ' +
      '(7) Subtotal only: every discount printed outside the item lines is held by the chosen discount, unless the ' +
      'lines sum to the subtotal exactly; otherwise "base after discount + tax = total" closes just as well, and the ' +
      'figure may be that base. ' +
      'Amounts under MIN_VERIFIABLE_AMOUNT (and zeros) are verified only by an exact check that pins them plus a ' +
      'strong label naming the role (מע"מ, הנחה, מקדמה...). Paid and due additionally need their own label cue ' +
      '(the payment check also closes with swapped roles, with tax/subtotal, or with two half payments). Rounding ' +
      'needs a rounding label. amount_due may also be verified as the very same printed figure as a verified total ' +
      'when its label is payable, no payment candidate or other amount-due value exists and the page mentions no ' +
      'payment. Printed adjustments count as terms of an exact closure: total (− paid) + previous balance = due, ' +
      'total − retention/withholding = due (not when a payment equal to the adjustment cancels it). Σ lines = total ' +
      'confirms the total when the page prints no separate tax (embedded text only). With several VAT rates printed, ' +
      'tax_rate is left out and the tax is checked per rate against the lines. amount_paid candidates on a quote or ' +
      'proforma, or under a schedule label ("מקדמה (30%)", "בחתימה"), are not payments and are left out.',
    needsReview:
      'a failing strong check involves it; or it was left out by the arithmetic but its prior is strong (reported ' +
      'anyway); or a competing value also satisfies the checks; or the arithmetic overruled a much stronger reading; ' +
      'or, without any check, a competitor has a close, high prior; or the prior or the text is weak.',
  },
  rate: {
    max: 'verified',
    verified:
      'as money: an exact tax check (tax = rate × base, or tax = total × rate / (100 + rate)) whose tax and base ' +
      'can vouch, on a base of at least 2.00 (so a half-point change of the rate would show). A 0% rate is a zero: ' +
      'it needs that exact check plus a strong tax label (מע"מ 0%).',
    needsReview: 'as money.',
  },
  identifier: {
    max: 'verified',
    verified:
      'checksum passes (Israeli ID family, IBAN) with prior >= 0.5 and a label or role signal, and no other ' +
      'checksum-valid value competes; or, for identifiers without a checksum, a single strong-label, well-formed ' +
      'candidate (prior >= strongLabel or signal label:exact) with no competitor >= competitorMin, read from text with ' +
      'confidence >= ocr.labelOnly. Never when the same value is also a candidate for the other party. A party id read ' +
      'by OCR needs an explicit marker of its own party (OCR may have lost the marker or the rival id). Party tax ids ' +
      '(a checksum proves validity, not ownership; roles.ts): never when the label or region (nearest marker above in ' +
      'its block, the heading above the block, an addressee line, the role heading of its grid column or row) names ' +
      "the other party; when another party id printed on the page could be this party's (not explicitly the other " +
      "party's; a company register number does not compete with a tax number), only with an explicit marker of this " +
      'party and no other id under the same marker. Bank account: never a bank-branch-account reading when an IBAN ' +
      'is printed (the definition picks the IBAN); the same account printed both ways corroborates.',
    needsReview:
      'checksum fails; malformed; competing values; the same value claimed by two roles; printed under the other ' +
      "party's marker; two ids under the same party marker; a bank-branch-account reading with an IBAN printed.",
  },
  date: {
    max: 'verified',
    verified:
      'unambiguous, or disambiguated by the day/month order the rest of the document uses or by invoice <= due order; ' +
      'from a strong label; no competing date >= competitorMin; text confidence >= ocr.labelOnly; plausible year; the ' +
      'date-order check does not fail.',
    needsReview: 'competing dates; the order check fails; a weak reading.',
  },
  code: {
    max: 'verified',
    verified:
      'document_type: a single strong title candidate (prior >= strongLabel) with no competitor. currency: a single ' +
      'value that the chosen amounts confirm with their own printed currency, with no competitor; or a sign printed ' +
      'with the verified total itself when no amount on the page is in another currency. Never when every printing is ' +
      'a shared sign ($, kr, ¥, Fr) unless the page names the ISO code (and no other currency of that sign).',
    needsReview: 'competing values, printed amounts in another currency, or a shared sign while the page names another currency of it.',
  },
  name: {
    max: 'verified',
    verified:
      'the full chain of role evidence: one candidate (no competitor), prior >= 0.7, a party role marker (signal ' +
      'role:<party> or a party label), a legal-entity suffix (so it is the legal name the truth asks for), whole printed ' +
      'line(s) or a whole "·"/"|"-separated piece of one (not truncated), not read from a party noun printed flush ' +
      'against it in the same type ("לקוח הדמו בע"מ" may be one name: only a colon, a separator, another type or a ' +
      'salutation such as "לכבוד" sets a label apart), in the same block as that party\'s verified, ' +
      "checksum-valid tax id, different from the other party's name, not under the other party's marker, and no legal " +
      'name of the party printed in another script next to it (bilingual names: neither is verified over the other).',
    needsReview: 'competing names, weak reading.',
  },
  address: {
    max: 'proposed',
    verified: 'never: addresses are matched fuzzily and nothing can confirm one.',
    needsReview: 'competing addresses, weak reading.',
  },
  contact: {
    max: 'verified',
    verified:
      'well-formed, single strong-label candidate with no competitor, confidence >= ocr.labelOnly, and supplier role ' +
      'evidence (signal role:supplier, or in the same block as the verified supplier tax id), not in a block the page ' +
      'marks as the customer\'s. An e-mail needs no label (only an e-mail has an "@") when it is the only address ' +
      'printed on the page and sits in the block of the verified supplier tax id. A contact found only by its shape ' +
      'outside the seller card the page marks explicitly (marketplace, agent) is left out.',
    needsReview: 'competing values, malformed, weak reading.',
  },
  terms: {
    max: 'verified',
    verified:
      'single strong-label candidate whose WHOLE value is a payment-terms expression (שוטף + N, Net N, 14 dagen, a ' +
      'schedule "30% מקדמה, יתרה שוטף + 30"): no second sentence, no date or amount, every clause about paying (terms.ts).',
    needsReview: 'competing values, weak reading.',
  },
}

/** Thresholds on the interpreter's prior (`FieldCandidate.score`, 0..1). */
export const PRIOR = {
  /** An alternative weaker than this never blocks verification. */
  competitorMin: 0.25,
  /** Without any check, an alternative at least this strong and within `conflictMargin` of the chosen one is a conflict. */
  conflictMin: 0.5,
  conflictMargin: 0.15,
  /** A label alone (no checksum/arithmetic) can verify only from this prior up. */
  strongLabel: 0.75,
  /** A checksum-valid identifier still needs this much prior (so a random digit string is not promoted). */
  checksumMin: 0.5,
  /** Name verification requires this prior. */
  name: 0.7,
  /** Below this an unconfirmed value is needs_review, not proposed. */
  proposedMin: 0.35,
  /** A money candidate this strong that the joint selection left out is still reported, as needs_review. */
  rescueMin: 0.6,
  /**
   * When the arithmetic picks a value over an alternative this much stronger (and >= rescueMin),
   * it overruled the interpreter: either the interpreter is badly wrong or the closing figures are
   * a self-consistent decoy (page totals, a second currency). Either way a person decides.
   */
  overrideMargin: 0.2,
  /** Prior of "this money field is not on the document" in the joint selection. */
  absent: 0.15,
  /** Candidates below this (after adjustments) are ignored by the joint selection. */
  floor: 0.01,
} as const

/** Word-level text confidence (1 for embedded PDF text, the OCR score otherwise). */
export const OCR = {
  /** Label-only verification (ids without checksum, dates, codes, names) needs at least this. */
  labelOnly: 0.9,
  /** Below this, a reading is weak: never better than needs_review unless arithmetic confirms it. */
  weak: 0.6,
  /**
   * Text this certain is the printed characters themselves (an embedded text layer): it cannot be
   * misread, so a check that confirms only its role (not its last digit) may verify it.
   */
  digital: 0.99,
} as const

/** Money tolerances (decimal strings, used through src/lib/decimal). */
export const TOLERANCE = {
  /** One rounding step. A check within this (but not exact) is 'close': it confirms roles, not digits. */
  step: '0.01',
  /** Rounded cash totals (Israeli agorot rounding), only with a rounding line or a cash context. Never verifies. */
  cash: '0.05',
  /** A printed rounding adjustment is smaller than this. */
  maxRounding: '1.00',
} as const

/** Joint-selection score contributions (log-space; priors enter as ln(p)). */
export const WEIGHT = {
  strong: { exact: 2.5, close: 2, approx: 1, fail: -3 },
  /** The line-sum closure: line extraction misses rows more often than totals are wrong. */
  soft: { exact: 1.5, close: 1.2, approx: 0.5, fail: -0.75 },
  /** Equalities between two printings that do not prove the field's role (total = due without payments). */
  corroboration: { exact: 0.5, close: 0.4, approx: 0.25, fail: -2 },
  identity: { exact: 0, close: 0, approx: 0, fail: -3 },
  /** Range checks: no reward for being in range, a heavy cost for being out of it. */
  sanity: { exact: 0, close: 0, approx: 0, fail: -4 },
  /** Tax larger than the base, discount larger than the subtotal… */
  implausible: -1,
} as const

/** Multipliers applied to a candidate's prior before grouping, with the reason recorded. */
export const PRIOR_FACTOR = {
  /** An amount with an explicit currency other than the document's. */
  currencyMismatch: 0.25,
  /** A per-page or carried-forward figure ("סה"כ לעמוד"). */
  pageTotal: 0.3,
  /** An amount printed with the same digits/words as a phone, tax id or document number. */
  identifierCollision: 0.05,
  /** 7+ digits, no separators, no decimals: reads like an identifier, not an amount. */
  looksLikeIdentifier: 0.5,
  /** A "rounding" of 1.00 or more is not a rounding. */
  roundingTooLarge: 0.3,
  /** A tax rate that no known VAT system uses. */
  unknownRate: 0.7,
} as const

/** Joint search limits. */
export const SEARCH = {
  /** Value groups considered per money field (plus "absent"). */
  topK: 4,
  /** Upper bound on enumerated combinations; the weakest options are dropped first above it. */
  maxCombos: 20000,
} as const

/** Calibration (see confidence.ts): log-odds contributions and the band each status maps into. */
export const CALIBRATION = {
  exactCheck: 2.5,
  approxCheck: 0.7,
  failedCheck: -3,
  competitor: -1.5,
  ambiguous: -1,
  weakText: -1,
  band: {
    verified: [0.95, 0.999],
    proposed: [0.4, 0.9],
    needs_review: [0.05, 0.6],
  } satisfies Record<FieldStatus, [number, number]>,
} as const

/**
 * Signals (FieldCandidate.signals) this layer understands. Interpretation may emit them; the
 * lexicon fallbacks below cover candidates that don't.
 */
export const SIGNAL = {
  strongLabel: ['label:exact', 'label:strong'],
  cash: 'context:cash',
  taxInclusive: 'tax:inclusive',
  roleSupplier: 'role:supplier',
  roleCustomer: 'role:customer',
} as const

/**
 * Small cue lexicons, compared after `foldForMatch` (so ״ and " are the same). Hebrew first: the
 * cues are substrings, which also covers the prefixes ו/ה/ב/ל/מ/ש/כ.
 */
export const CUES = {
  /** amount_due labels: the figure is what remains to be paid. */
  payable: ['לתשלום', 'יתרה', 'יתרת', 'לפירעון', 'amount due', 'balance', 'due', 'payable', 'to pay', 'zu zahlen', 'à payer', 'a payer', 'a pagar', 'da pagare', 'te betalen'],
  /** tax printed as part of the total ("of which VAT"), i.e. tax-inclusive prices. */
  taxInclusive: ['מתוכו', 'מתוכם', 'מזה מע', 'כלול', 'included', 'includes', 'incl.', 'inkl', 'enthalten', 'dont tva', 'incluido', 'inclusa', 'inbegrepen'],
  /** Line rows that are discounts. */
  discountRow: ['הנחה', 'הנחת', 'discount', 'rabatt', 'nachlass', 'remise', 'descuento', 'sconto', 'korting'],
  /**
   * Figures that are not the document's: per-page sums and carried-forward balances. They often
   * close among themselves (a page's subtotal, VAT and total), so they never vouch for anything.
   */
  pageTotal: ['לעמוד', 'להעברה', 'מועבר', 'מהעמוד', 'מעמוד קודם', 'page total', 'carried forward', 'brought forward', 'c/f', 'b/f', 'übertrag', 'seitensumme', 'à reporter', 'report', 'suma y sigue', 'riporto', 'transport'],
  /** Tax labels. */
  tax: ['מע"מ', 'מעמ', 'מס ערך מוסף', 'vat', 'tax', 'mwst', 'ust', 'tva', 'iva', 'btw', 'gst'],
  /** A rounding adjustment is printed (עיגול אגורות). */
  rounding: ['עיגול', 'rounding', 'rundung', 'arrondi', 'redondeo', 'arrotondamento', 'afronding'],
  /** The base after a document discount, printed beside the subtotal (it is not the subtotal). */
  afterDiscount: ['חייב במע"מ', 'אחרי הנחה', 'לאחר הנחה', 'לאחר ההנחה', 'after discount', 'taxable', 'base ht', 'ht net', 'net ht', 'base imponible', 'imponibile', 'nach rabatt', 'bemessungsgrundlage', 'après remise', 'na korting'],
  /** A subtotal labelled as before the document discount. */
  beforeDiscount: ['לפני הנחה', 'לפני ההנחה', 'before discount', 'gross', 'brut', 'vor rabatt', 'brutto', 'avant remise', 'bruto', 'lordo', 'voor korting'],
  /** Line rows that are shipping/handling. */
  shippingRow: ['משלוח', 'הובלה', 'דמי משלוח', 'shipping', 'freight', 'delivery charge', 'versand', 'fracht', 'livraison', 'envío', 'envio', 'spedizione', 'verzending'],
  /** A payment, advance or credit is printed somewhere: total and amount due may differ. */
  payment: ['מקדמה', 'מקדמות', 'שולם', 'ששולם', 'ששולמו', 'תקבול', 'קיזוז', 'advance', 'deposit', 'paid', 'payment received', 'prepayment', 'anzahlung', 'bereits bezahlt', 'acompte', 'déjà payé', 'anticipo', 'aanbetaling'],
  /** Payment in cash: totals may be rounded to 10 agorot without a printed rounding line. */
  cash: ['מזומן', 'במזומן', 'cash', 'bar bezahlt', 'espèces', 'efectivo', 'contanti', 'contant'],
  /**
   * Bank details of the PAYER: money is taken from this account (a standing order or direct debit
   * on the customer's account, "paid from"). Read on the bank details' own line or label only:
   * "לתשלום בהעברה לחשבון" (to the account) is the payee's.
   */
  payerAccount: ['מחשבון', 'מחשבונך', 'מחשבונכם', 'חשבון הלקוח', 'חשבונך', 'חשבונכם', 'הוראת קבע', 'הוראת הקבע', 'יחויב', 'החיוב יבוצע', 'חיוב מחשבון', 'paid from', 'from account', 'from your account', 'debited from', 'debit from', 'direct debit', 'your account', "customer's account", 'customer account', 'payer', 'drawn on', 'standing order', 'lastschrift', 'abgebucht', 'ihrem konto', 'prélèvement', 'prelevement', 'votre compte', 'domiciliación', 'domiciliacion', 'su cuenta', 'addebito', 'incasso'],
  /**
   * Words that change what a title says the document is: another type's distinguishing word
   * (חשבונית חיוב is a debit note, not an invoice) or a state that voids it (טיוטה, מבוטל). Other
   * words in a title are descriptive ("חשבון חשמל תקופתי", "חשבונית מס מרכזת").
   */
  typeWords: [
    'חיוב', 'זיכוי', 'קבלה', 'עסקה', 'פרופורמה', 'פרופורמא', 'הצעה', 'הצעת', 'הזמנה', 'הזמנת', 'משלוח', 'טיוטה', 'טיוטא', 'מבוטל', 'מבוטלת', 'בוטל', 'בוטלה', 'ביטול', 'דוגמה', 'דוגמא', 'דרישת', 'תרומה', 'החזר', 'החזרה',
    'debit', 'credit', 'receipt', 'proforma', 'pro-forma', 'forma', 'quote', 'quotation', 'estimate', 'order', 'delivery', 'statement', 'draft', 'cancelled', 'canceled', 'void', 'sample', 'specimen', 'refund', 'memo',
    'gutschrift', 'lastschrift', 'quittung', 'angebot', 'auftrag', 'auftragsbestätigung', 'lieferschein', 'entwurf', 'storno', 'stornorechnung',
    'avoir', 'reçu', 'devis', 'commande', 'livraison', 'brouillon', 'annulée', 'annulee',
    'abono', 'rectificativa', 'recibo', 'presupuesto', 'pedido', 'albarán', 'albaran', 'borrador', 'anulada',
    'credito', 'ricevuta', 'preventivo', 'ordine', 'bolla', 'bozza', 'annullata',
    'creditnota', 'kwitantie', 'offerte', 'bestelling', 'pakbon', 'concept',
  ],
  /** Legal-entity suffixes: a name with one is the legal name. */
  legalSuffix: ['בע"מ', 'בעמ', 'בע"ם', '(ע"ר)', 'ע"ר', 'עמותה', 'שותפות', 'חל"צ', 'ltd', 'limited', 'inc', 'llc', 'plc', 'gmbh', 'ag', 'kg', 'sarl', 's.a.r.l', 's.a.', 'sa', 'sas', 'bv', 'b.v.', 'nv', 'n.v.', 'spa', 's.p.a.', 's.r.l.', 'srl', 'sl', 's.l.', 'corp', 'corporation', 'company', 'co.'],
  supplierLabel: ['ספק', 'מאת', 'עוסק מורשה', 'from', 'supplier', 'vendor', 'seller', 'issued by', 'lieferant', 'fournisseur', 'proveedor', 'fornitore', 'leverancier'],
  customerLabel: ['לכבוד', "לכב'", 'לקוח', 'למזמין', 'מזמין', 'bill to', 'billed to', 'customer', 'client', 'sold to', 'kunde', 'rechnungsempfänger', 'destinataire', 'cliente', 'klant'],
  /**
   * Party labels that never begin a name: salutations and prepositions ("לכבוד", "מאת", "Bill
   * to", "From"). A party noun ("לקוח", "ספק", "Customer", "Client") can be a name's first word
   * ("Client Focus Ltd."), so flush against a name it may be part of it. A label phrase ending in
   * to/from/by counts as one too ("Invoice to", "Received from", "Issued by").
   */
  salutation: ['לכבוד', "לכב'", "לכ'", 'חשבון לכבוד', 'חשבון עבור', 'עבור', 'אל', 'מאת', 'התקבל מאת', 'התקבלו מאת', 'קיבלנו מאת', 'למזמין', 'לידי', 'לידיעת', 'to', 'from', 'attn', 'attn.', 'attention', 'an', 'à', 'a', 'para', 'per', 'aan', 'für'],
  /**
   * Addressee abbreviations the shared lexicon does not list yet ("לכב'" for לכבוד). A line that
   * starts with one opens the customer's block.
   */
  customerMarkerExtra: ["לכב'", "לכ'"],
  /** "For the attention of" lines: printed only in the billed party's block. */
  addressee: ['לידי', 'לידיעת', 'attn', 'attn.', 'attention', 'to the attention of', 'z. hd.', 'z.hd.', 'zu händen', "à l'attention de", 't.a.v.', 'all\'attenzione di', 'a la atención de'],
  /**
   * Labels of company-register numbers (not tax numbers): HRB, KvK, RCS, SIREN/SIRET, Company No.
   * Outside Israel the tax_id is the VAT number, so a register number of the same company does not
   * compete with it (and a register number is not verified when a VAT number is printed).
   */
  registerIdLabel: [/\bhrb\b/, /handelsregister/, /amtsgericht/, /\bkvk\b/, /\brcs\b/, /\bsiren\b/, /\bsiret\b/, /company (reg(istration)? )?(no|number)/, /\breg(istration)? (no|number)\b/, /registered in/, /\bcrn\b/, /\bičo\b/, /\bico\b/, /מספר רישום/],
  /** Payment-terms shapes that can be confirmed by format. */
  terms: [/שוטף\s*\+?\s*\d+/, /שוטף/, /נטו\s*\+?\s*\d+/, /net\s*\d+/, /\d+\s*(days|ימים|tage|jours|días|dias|giorni|dagen)/, /due on receipt/, /מיידי|במזומן|מזומן|immediate|sofort|à réception/],
} as const

/** Israeli standard VAT by effective date (newest first). */
export const IL_VAT_HISTORY: readonly { from: string; rate: string }[] = [
  { from: '2025-01-01', rate: '18' },
  { from: '2015-10-01', rate: '17' },
  { from: '2013-06-02', rate: '18' },
  { from: '2012-09-01', rate: '17' },
  { from: '2010-01-01', rate: '16' },
  { from: '2009-07-01', rate: '16.5' },
  { from: '2008-07-01', rate: '15.5' },
]

/** VAT/sales-tax rates in use somewhere (Israel first). A rate outside this list is penalised, not rejected. */
export const KNOWN_TAX_RATES: readonly string[] = [
  '0', '18', '17', '16', '16.5', '15.5',
  '2.5', '3', '4', '5', '5.5', '6', '7', '7.7', '8', '8.1', '9', '9.5', '10', '12', '13', '14', '15', '19', '20', '21', '22', '23', '24', '25', '25.5', '27',
]

/**
 * Amounts below this (other than rounding and rates) are not verified by arithmetic alone: a few
 * agorot printed anywhere can close a rounding gap, and a zero closes any sum.
 */
export const MIN_VERIFIABLE_AMOUNT = '1.00'

/** Rates above this are not tax rates. */
export const MAX_TAX_RATE = '30'
