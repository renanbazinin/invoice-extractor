# Invoice Extractor web app: installation

A React app that runs the invoice extractor entirely in the browser. There is no server and no upload: files are read inside the browser tab, and OCR runs on the user's computer. No LLM or AI service is involved.

The app runs the same four-layer pipeline as the CLI (`src/`): read → structure → interpret → validate.

## Requirements

| What | Version | Needed for |
| --- | --- | --- |
| Node.js | 22.12 or newer | Building the app (users don't need it) |
| npm | comes with Node.js | Installing dependencies |
| Browser | a current Chrome, Edge, Firefox or Safari | Using the app |

## 1. Install

Run this in the repository root (the folder that contains `package.json`):

```bash
npm install
```

This installs the extractor's dependencies plus React and Vite. React, Vite and the other web build tools are dev dependencies.

## 2. Run it locally (development)

```bash
npm run web:dev
```

Open http://localhost:5173. Changes to `web/src` or to the extractor in `src/` reload the page automatically.

Before it starts, `web:dev` runs `web:vendor` (`web/scripts/copy-vendor.mjs`). That script copies the files the browser loads at run time from `node_modules` into `web/public/vendor`:

- pdf.js fonts, character maps and decoders;
- the tesseract OCR worker and its WebAssembly engine;
- the Hebrew and English OCR language data.

It also copies the three demo invoices from `web/samples` into `web/public/samples`. Both folders are generated and git-ignored.

The demo invoices contain only made-up data. Their HTML sources are in `web/samples/src`. After changing one, re-render them with `npx tsx web/scripts/build-samples.ts`; this needs an installed Chrome or Edge.

## 3. Build for production

```bash
npm run web:build
```

The finished app goes to `web/dist`, about 23 MB in total; the OCR engine and language data are most of it. To check the build before deploying it:

```bash
npm run web:preview
```

Then open http://localhost:4173.

## 4. Deploy

`web/dist` is a static site. Copy the whole folder to any web server or static host, for example nginx, Apache, IIS, an S3 bucket, Netlify, GitHub Pages or an internal file server. No server-side code or database is needed.

**GitHub Pages:** this repository deploys itself. `.github/workflows/pages.yml` runs the tests on every push to `main`, then builds the app and publishes it to https://renanbazinin.github.io/invoice-extractor/. In a fork, turn it on under Settings → Pages → Source: **GitHub Actions**.

- **Any path works.** Asset paths are relative, so the app runs from the root (`https://host/`) or a sub-folder (`https://host/tools/invoices/`).
- **Serve it over http or https.** Opening `index.html` straight from disk (`file://`) shows a blank page, because browsers block workers and WebAssembly there. Any local server works, for example:

  ```bash
  python -m http.server 8080 -d web/dist
  ```

- **MIME types.** The server must send `.mjs` files as JavaScript and must serve `.gz` files at all. Most servers do both by default. IIS doesn't, and needs this `web.config` in the site folder:

  ```xml
  <configuration>
    <system.webServer>
      <staticContent>
        <remove fileExtension=".mjs" />
        <mimeMap fileExtension=".mjs" mimeType="text/javascript" />
        <remove fileExtension=".gz" />
        <mimeMap fileExtension=".gz" mimeType="application/gzip" />
      </staticContent>
    </system.webServer>
  </configuration>
  ```

## Using the app

1. Drop invoices on the page, or click **Add files**. You can add several at once. Supported formats: PDF, PNG, JPEG, TIFF, WebP and plain text.
2. Files are processed one at a time. Digital PDFs take under a second. Scans and photos go through OCR, which takes a few seconds per page. The first OCR run also loads the language data (about 3.5 MB), which the browser then keeps in its cache.
3. Each field shows one of three statuses:
   - **✔ Verified:** found and independently confirmed, by arithmetic, a check digit or an unambiguous label.
   - **? Proposed:** found and plausible, but nothing independent confirms it.
   - **! Needs review:** conflicting readings, a failed check or a weak reading.
4. **Hover over or click a field** to highlight where it is printed on the page (blue: the value, amber: its label). **Click any word on the page** to jump to the field or line item that uses it.
5. Tabs:

   | Tab | Shows |
   | --- | --- |
   | Fields | The standard fields |
   | Line items | The item rows |
   | Other fields | Every other labelled value found |
   | Checks | Arithmetic and other checks, plus notes |
   | Text | The document's lines in reading order |
   | JSON | The full result |

6. **Export** sends every processed invoice through an export template and downloads the file. Pick the default template in the menu next to the button. An invoice whose supplier template names its own export goes there instead, so one click can produce several files. **Download JSON** (in the JSON tab) saves the full result of one document.
7. The **OCR** menu sets when OCR runs:
   - **Auto** (the default): only pages without a usable text layer.
   - **Always:** every page, useful when a PDF's text layer is garbled.
   - **Never:** OCR is skipped.
8. Password-protected PDFs ask for the password. It is used only in the browser.

## Templates (optional)

The extractor needs no template. Templates are for two other jobs, on the **Templates** page:

- **Export templates** decide where the data goes.
  - They set which values go in which columns, Excel, CSV or JSON, and one row per invoice or per line item.
  - They set date and number formats, and what happens to values that aren't verified: exported, left empty, coloured in Excel, or given a status column.
  - Eight are built in. **Fork** any of them to get your own copy, then add, remove, rename and reorder columns, with a live preview on your invoices.
- **Supplier templates** teach the app one supplier's invoices. Each one is applied automatically to invoices that print the supplier's tax ID (or name), and it can hold:
  - **fixed facts**, such as the legal name or bank account (**Fill from this invoice** copies them);
  - the supplier's **own labels** (for example "אסמכתא" → invoice number);
  - **boxes on the page** for values with no label: pick the field, drag a box around the value on one of the supplier's invoices, and save;
  - the **export template** its invoices go to.

  To start one, open an invoice from that supplier and click **Create one for this supplier** in the results panel. A value a supplier template supplies is shown with a ⧉ badge and is never marked verified. If it contradicts a value the extractor verified, the field is marked "needs review".

Your own templates are saved in this browser's local storage. **Download** saves a template as a file, and **Import…** loads one, for example to move templates to another computer or share them with a colleague.

## Privacy

- Documents never leave the browser tab. The only requests the app makes are for its own files (the app, pdf.js, the OCR engine and the language data), all served from the same place as the app. Nothing is fetched from a CDN.
- No document is stored. Closing or reloading the tab discards the documents and results. The browser does keep your own templates (in local storage) and the OCR language data (in IndexedDB), but neither holds document content. A supplier template holds only what you put in it.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Missing …/node_modules/…` when running `web:dev` or `web:build` | Run `npm install` in the repository root first. |
| Blank page after opening `web/dist/index.html` directly | Serve the folder over http instead (see Deploy). |
| OCR fails with an error about `traineddata` | The server didn't serve `vendor/tessdata/*.traineddata.gz` (check for a 404). On IIS, add the `web.config` above. |
| The page freezes for a moment on large scans | Image clean-up before OCR runs on the page's main thread. It finishes; it just isn't instant. |
| A TIFF shows its words drawn as text instead of the image | Chrome and Firefox can't display TIFF. Extraction still works, because OCR reads the TIFF itself. |

## How the browser build works

All of `src/` is shared with the CLI. Only the reader touches the platform, and it goes through one small interface, `src/read/env.ts`, which covers:

- where pdf.js finds its fonts;
- how to make a canvas;
- how to decode an image;
- where the OCR files are.

There are two implementations:

- `src/read/nodeEnv.ts`, for Node: the CLI, the tests and the evaluation.
- `web/src/env.browser.ts`, for the browser. `web/vite.config.ts` swaps it in with an alias.

| Path | What it is |
| --- | --- |
| `web/index.html` | Entry page |
| `web/vite.config.ts` | Build config: the platform alias, relative paths |
| `web/scripts/copy-vendor.mjs` | Copies pdf.js, OCR engine and language files into `public/vendor` |
| `web/src/env.browser.ts` | The reader's browser platform |
| `web/src/App.tsx` | Layout, file queue, drag and drop, CSV export |
| `web/src/components/DocumentViewer.tsx` | Page rendering with the evidence overlay |
| `web/src/components/ResultPanel.tsx` | Summary and the result tabs |
| `web/src/pages.ts` | Draws pages in the same geometry the reader used |
| `web/src/templates/` | The Templates page: store, export and supplier template editors |
| `src/templates/` | The template engine (shared with Node): matching, applying, CSV/JSON/Excel output |

All npm scripts:

| Script | Does |
| --- | --- |
| `npm run web:dev` | Development server on port 5173 |
| `npm run web:build` | Production build into `web/dist` |
| `npm run web:preview` | Serves `web/dist` on port 4173 |
| `npm run web:typecheck` | Type-checks the web app |
| `npm run web:vendor` | Copies the run-time files only |
