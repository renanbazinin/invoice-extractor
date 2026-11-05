# Invoice Extractor

**[עברית](README.he.md)**

Reads invoices it has never seen before, in Hebrew and in English, and returns their fields: number, dates, amounts, VAT, supplier, customer and line items. It works without templates per supplier and without an LLM or any other AI service. Everything runs locally, either in the browser or in Node.

Every value comes with the words on the page it was read from. Each field is marked:

| Status | Meaning |
| --- | --- |
| ✔ **verified** | Found and independently confirmed, by arithmetic, a check digit or an unambiguous label |
| ? **proposed** | Found and plausible, but nothing independent confirms it |
| ! **needs review** | Conflicting readings, a failed check or a weak reading |

The design goal is that a *verified* value is never wrong. When in doubt, the extractor flags the value for a person instead of guessing.

## How it works

The pipeline has four layers. Each is plain, deterministic TypeScript.

1. **Read:** words and lines with their positions, in logical reading order, including right-to-left and mixed Hebrew/English text. The text comes from pdf.js for digital PDFs, or from tesseract OCR for scans and photos.
2. **Structure:** label/value pairs and tables, found from the layout.
3. **Interpret:** candidate values for each standard field, from multilingual label lexicons and format parsers (dates, money, Israeli ח.פ/ע.מ/ת.ז, IBAN, phones).
4. **Validate:** picks the values that agree with each other (subtotal + VAT = total, line sums, check digits) and decides each field's status.

It returns three things:

- **The document as read:** every word with its position.
- **The standard fields:** with their line items.
- **Every other labelled value found:** fields outside the standard set.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Quick start

You need [Node.js](https://nodejs.org) 22.12 or newer.

```bash
npm install
```

### Web app

The web app runs entirely in the browser: files are never uploaded.

```bash
npm run web:dev
```

Then open http://localhost:5173. Drop in invoices, or try one of the demo samples. [INSTALL.md](INSTALL.md) covers building and deploying the app.

### Command line

```bash
npm run extract -- path/to/invoice.pdf
```

```bash
npm run extract -- path/to/scan.png --json
```

### As a library

```ts
import { readFileSync } from 'node:fs'
import { extract } from './src/pipeline'

const result = await extract(new Uint8Array(readFileSync('invoice.pdf')))
console.log(result.fields.total?.normalized, result.fields.total?.status)
```

## Supported input

| Input | How it is read |
| --- | --- |
| Digital PDFs | Embedded text layer |
| Scanned PDFs | OCR |
| Images: PNG, JPEG, TIFF (multi-page too), WebP | OCR |
| Plain text | Laid out as a page |

Hebrew and English are the main targets. Number and date formats of other Latin-script languages (de, fr, es, it, nl) are understood as well.

## Status

This is an early-stage project.

- **Measured results:** on the development test sets, no verified value is wrong. Overall accuracy is about 84% on hand-written invoices and 97% on generated ones.
- **Unfamiliar layouts score lower.** Line items, document numbers, names and poor scans are the weakest areas.

## Test data

The invoices used to develop and measure the extractor are **not published**. They look like real invoices, with names, ID numbers and bank details, and someone could mistake them for real people's data. The same goes for the generator that makes them.

The unit tests use short, made-up snippets. The evaluation tools (`eval/run.ts`, `eval/score.ts`) are included, so you can measure the extractor on your own invoices:

1. Next to each invoice, write a `*.truth.json` file with the expected values (see `GroundTruth` in `src/model/types.ts`).
2. Run:

```bash
npm run eval -- your-folder
```

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run web:typecheck
```

## License

[MIT](LICENSE)
