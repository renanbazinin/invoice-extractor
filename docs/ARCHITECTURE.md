# formExtractor — architecture and ground rules

A generic invoice extractor. It works without per-supplier templates and without any LLM or other
generative model. It relies on layout analysis, multilingual lexicons, format parsers, checksums and
arithmetic constraints. **Hebrew invoices are the primary target** (Israeli suppliers), followed by
English and mixed Hebrew/English documents. Other Latin-script languages (de/fr/es/it/nl…) and their
number formats are secondary.

## Ground rules (apply to every module)

1. **No LLM, no generative model, no network at run time.** Deterministic TypeScript, plus pdf.js and
   tesseract.js (OCR, local language data from `@tesseract.js-data/{heb,eng}`).
2. **Evidence or nothing.** Every extracted value points to the words it was read from
   (`Evidence.wordIds`). A value that is computed, not written, is a `DerivedValue`. It never
   appears in `fields`.
3. **Never silently wrong.** `status: 'verified'` is a promise: the value is on the page *and* an
   independent check confirms it (arithmetic closure, checksum, a single unambiguous strong label
   with a well-formed value and no competitor). If a check is missing or conflicting, use
   `proposed` or `needs_review`. A wrong `verified` is the worst possible bug; a correct
   `needs_review` is fine. The goal is 100% of fields correct, with 0 verified-but-wrong.
4. **Don't guess meaning.** If a labelled value can't be mapped to a standard field, keep it in
   `discovered` with `field: null` and the label/value as printed.
5. **Generic, not template.** No supplier names, no fixed coordinates, no page-specific rules.
   Knowledge lives in lexicons (label vocabularies), parsers (formats) and constraints (arithmetic).
   A layout heuristic must hold for unfamiliar layouts, not only the test ones.
6. **Exact money.** Amounts are `DecimalString`s and are computed with `src/lib/decimal.ts`
   (bigint-based). Never use JS floats for money.
7. Match the code style: TypeScript, ESM, no semicolons, single quotes, 2-space indent, JSDoc that
   explains *why*, small pure functions, `vitest` unit tests next to the code (`*.test.ts`).

## Layers and the contract

All shared types are in `src/model/types.ts`, which is the contract. Don't change it without a strong
reason, and if you do, say so in your report. Each layer owns one folder and exposes its API from
`index.ts`.

| Layer | Folder | API | Input → output |
| --- | --- | --- | --- |
| 1 Read | `src/read/` | `readDocument(bytes, opts)` | PDF/image bytes → `DocumentModel` (words, lines, blocks, pages) |
| 2 Structure | `src/structure/` | `analyzeStructure(doc)` | `DocumentModel` → `Structure` (key/values, tables) |
| 3 Interpret | `src/interpret/` | `interpret(doc, structure)` | → `FieldCandidate[]`, `LineItemCandidate[]`, discovered drafts |
| — Semantics | `src/semantic/` | lexicon + parsers | label vocabulary, money/date/id/currency parsers |
| 4 Validate | `src/validate/` | `resolve(input)` | candidates → chosen fields, statuses, checks, issues, derived |
| Pipeline | `src/pipeline.ts` | `extract(bytes, opts)` | bytes → `ExtractionResult` |

### 1. Read (`src/read/`)
- Digital PDFs: pdf.js (`pdfjs-dist/legacy/build/pdf.mjs`) `getTextContent()`. Items come out as
  runs. When the PDF stores glyphs in visual order (Chrome, Word and most invoicing software do),
  pdf.js has already turned each RTL run into logical order. Numbers inside Hebrew text are
  separate LTR runs. The reader splits runs into words, groups words into lines by baseline (a
  wide horizontal gap ends a line, so a table row or a two-column header is several lines at the
  same y), and puts each line into **logical order** (Unicode bidi over the runs: for an RTL line, the
  right-most run comes first, and LTR runs such as numbers keep their inner order).
- Scanned PDFs, or pages without a usable text layer: rasterize with pdf.js + `@napi-rs/canvas` and
  OCR with tesseract.js (`heb+eng`, local traineddata). OCR boxes are converted to points.
- Images (png/jpg/tiff/webp): OCR directly.
- Blocks: group lines into visually separated regions (whitespace gaps, alignment).
- Coordinates: points, top-left origin, y down.

### 2. Structure (`src/structure/`)
- Key/values: `inline` ("Label: value" / "label value" in reading order, Hebrew included),
  `below` (label above value), `grid` (label column + value column, possibly far apart, including RTL
  grids where the label is on the right).
- Tables: header detection (lexicon-assisted, but also by alignment for unknown headers), column
  extents, rows (multi-line descriptions become `continuation`), summary rows, and tables that
  continue onto the next page.

### 3. Interpret (`src/interpret/`)
- Maps key/values, table cells and free text to standard fields, using the lexicon (multilingual
  label concepts with Hebrew prefix handling: ו/ה/ב/ל/מ/ש/כ), value parsers and position/role cues.
  Several candidates per field are expected and wanted. Choosing between them is validation's job.
- Party roles: supplier vs customer vs others (bank, delivery address, payment processor) from
  labels (לכבוד/לקוח/Bill to → customer; ספק/From/Issued by → supplier), position (issuer header at
  top), and the issuer's tax id/bank details.
- Every other labelled value becomes a discovered field.

### 4. Validate (`src/validate/`)
- Arithmetic: Σ line amounts = subtotal (allowing for discounts/shipping lines/tax-inclusive
  pricing); subtotal − discount + tax (+ rounding) = total; total − paid = amount_due;
  tax ≈ rate × taxable base; qty × unit price = line amount.
- Checksums: Israeli company/VAT id (ח.פ / ע.מ / ת.ז, 9 digits, Luhn-like check digit), IBAN mod 97.
- Global choice: pick the combination of candidates that best satisfies the constraints and
  priors. The chosen fields get `verified`/`proposed`/`needs_review`, with `checks` listing what
  confirmed them, and losers become `alternatives`.
- Missing but computable values go to `derived`, not `fields`.

## Field definitions (shared by ground truth and extractor)

These meanings are strict. Test authors and the extractor follow the same rules.

| Field | Meaning |
| --- | --- |
| `document_type` | The title that classifies the document: חשבונית מס / Tax invoice / VAT invoice → `tax_invoice`; חשבונית מס/קבלה, חשבונית מס קבלה → `tax_invoice_receipt`; קבלה / Receipt → `receipt`; חשבונית זיכוי / Credit note → `credit_note`; Debit note → `debit_note`; חשבון עסקה → `transaction_account`; חשבונית פרופורמה / Proforma → `proforma`; הצעת מחיר / Quote → `quote`; plain "Invoice"/Rechnung/Facture/Factura → `invoice`; a utility/telecom/municipal bill (חשבון חשמל/מים/ארנונה, "Bill") → `utility_bill`. "מקור"/"העתק"/"Original"/"Copy" marks are not types. |
| `invoice_number` | The document's own number (מספר חשבונית / חשבונית מס מס' / Invoice No.). Not order, delivery-note, customer or allocation numbers. |
| `invoice_date` | Issue date (תאריך / תאריך הפקה / Invoice date / Date). Not supply/value/due dates. |
| `due_date` | Payment due date (לתשלום עד / תאריך פירעון / Due date). |
| `delivery_date` | Supply/delivery/service date when it is printed as a separate date. |
| `po_number` | Customer order / purchase-order number (מספר הזמנה / PO). |
| `allocation_number` | Israeli Tax Authority allocation number (מספר הקצאה / Allocation No.). |
| `currency` | ISO 4217 code of the invoice amounts (₪/ש"ח/NIS → ILS). |
| `subtotal` | The printed sum of the lines **before tax and before any document-level discount** (סה"כ / סה"כ לפני מע"מ / Subtotal / Net). Absent when not printed. |
| `discount` | Document-level discount amount as a positive number (הנחה / Discount). Line-level discounts are not this field. |
| `tax_rate` | The single VAT/sales-tax rate printed (e.g. 18). Absent when several rates apply. |
| `tax_amount` | Total tax (מע"מ / VAT / MwSt / TVA / IVA). Also when printed as "includes VAT" (כולל מע"מ ... מתוכו). |
| `total` | The full value of the document including tax, after discounts and rounding (סה"כ כולל מע"מ / Total / Grand total). |
| `amount_paid` | Payments, advances or credits already applied that are printed on the document (שולם / מקדמה / Paid / Less: deposit). |
| `amount_due` | What remains payable **when printed with a payable/due/balance label** (לתשלום / סה"כ לתשלום / יתרה לתשלום / Amount due / Balance due). One printed figure can be both `total` and `amount_due` (e.g. a single "סה"כ לתשלום" line on an invoice with no payments). |
| `rounding` | Printed rounding adjustment (עיגול / Rounding). |
| `payment_terms` | As printed (שוטף + 30 / Net 30 / Due on receipt). |
| `supplier.*` / `customer.*` | The issuer and the billed party. `name`: the name as printed. When a trading name and a legal name are both printed, the legal one (with בע"מ / Ltd / GmbH / Inc …). `tax_id`: ח.פ / ע.מ / ת.ז / VAT reg. no., as printed minus separators. `address`: street, city, zip as printed. `phone`: the main phone, not fax. `bank_account`: the IBAN when printed, else `bank-branch-account` digits (e.g. `12-345-123456`). |

## Ground truth and evaluation (`eval/`)

> The test documents are **not in the public repository**. They are realistic-looking invoices,
> with names, ID numbers and bank details that could be mistaken for real people's data. So are
> the generator (`eval/families`, most of `eval/lib`, `eval/generate.ts`) and its pools of names
> and addresses. The scorer and runner (`eval/run.ts`, `eval/score.ts`) are public: write your own
> `*.truth.json` files next to your own invoices and run `npm run eval -- <dir>`. Unit tests use
> short made-up snippets; the one test that reads a corpus PDF is skipped where the corpus is absent.

- `eval/corpus/<family>/<id>.{html,pdf,truth.json}`: generated development corpus (`npm run corpus`).
  Regular by construction, so it is easy to overfit: never judge progress on it alone.
- `eval/handmade/<author>/<id>.{html,pdf,truth.json}`: hand-written development invoices by independent
  authors (different styles, vocabulary and traps). Developers may study them. Fix the general cause
  of a failure, never the document.
- `eval/blind/<author>/...`: hand-written **blind test set**. Developers of the extractor never open
  these files or their reports. Only the lead runs it, to measure generalization to unfamiliar
  layouts and terminology.
- `eval/render.ts`: HTML → PDF (and PNG "scans") through headless Chrome.
- `GroundTruth` (in `src/model/types.ts`): normalized expected values plus `absent` fields (extracting
  them is a hallucination) and `extra` labelled values that must appear in `discovered`.
- `npm run eval -- <dir>` scores the pipeline against every `*.truth.json` under `<dir>` and prints:
  - **accuracy**: correct extracted fields / truth fields
  - **verified precision**: correct verified / all verified (must be 100%)
  - **auto rate**: correct *and* verified / truth fields (how much needs no human)
  - **hallucinations**: values extracted for `absent` fields
  - line-item and extra-field recall.

### Matching rules used by the scorer
- money, percent, decimal: numerically equal (`sameDecimal`).
- date: ISO equal. currency: ISO code equal. document_type: equal.
- ids (`*_tax_id`, `invoice_number`, `po_number`, `allocation_number`, `bank_account`): equal after
  removing spaces, dashes, dots and slashes, case-folded.
- names, payment_terms, email, phone: `foldForMatch` + punctuation/space removal, then equal (phone:
  digits only, a leading country code `972`/`+972` equals a leading `0`).
- address: token-set similarity ≥ 0.8 after `foldForMatch`.
