// Copies the files the app loads at run time into web/public/vendor, so the browser gets them
// from the app itself and never from a CDN: the pdf.js fonts and character maps, the tesseract
// worker and WebAssembly core, and the Hebrew and English OCR language data. Also copies the demo
// invoices (web/samples, made-up data) into web/public/samples. Runs before `web:dev` and `web:build`.
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(web, '..')
const vendor = join(web, 'public', 'vendor')
const pkg = (name) => dirname(require.resolve(`${name}/package.json`, { paths: [repo] }))

/** [source, destination under public/] */
const copies = [
  [join(pkg('pdfjs-dist'), 'standard_fonts'), 'vendor/pdfjs/standard_fonts'],
  [join(pkg('pdfjs-dist'), 'cmaps'), 'vendor/pdfjs/cmaps'],
  [join(pkg('pdfjs-dist'), 'wasm'), 'vendor/pdfjs/wasm'],
  [join(pkg('pdfjs-dist'), 'iccs'), 'vendor/pdfjs/iccs'],
  [join(pkg('tesseract.js'), 'dist', 'worker.min.js'), 'vendor/tesseract/worker.min.js'],
  // The reader runs tesseract's LSTM engine only, so only the LSTM builds of the core are needed
  // (tesseract.js picks relaxed-SIMD, SIMD or plain by what the browser supports).
  ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].map((v) => [join(pkg('tesseract.js-core'), `tesseract-core-${v}.wasm.js`), `vendor/tesseract/core/tesseract-core-${v}.wasm.js`]),
  ...['heb', 'eng'].map((lang) => [join(pkg(`@tesseract.js-data/${lang}`), '4.0.0_best_int', `${lang}.traineddata.gz`), `vendor/tessdata/${lang}.traineddata.gz`]),
  ...['hebrew-tax-invoice.pdf', 'hebrew-scan.png', 'english-invoice.pdf'].map((f) => [join(web, 'samples', f), `samples/${f}`]),
]

rmSync(vendor, { recursive: true, force: true })
let bytes = 0
for (const [src, rel] of copies) {
  if (!existsSync(src)) {
    throw new Error(`Missing ${src}. Run \`npm install\` in the repository root first.`)
  }
  const dst = join(web, 'public', rel)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  bytes += size(dst)
}
console.log(`copy-vendor: ${copies.length} entries, ${(bytes / 1048576).toFixed(1)} MB → web/public`)

function size(path) {
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  return 0 // directories: not worth walking for a log line
}
