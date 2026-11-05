/**
 * Renders the demo invoices in web/samples/src (made-up data only) into the files the app offers
 * under "Try a sample": two PDFs, and a PNG made to look scanned so it exercises OCR. Needs an
 * installed Chrome or Edge. The outputs are committed, so this only runs when a sample changes:
 *
 *   npx tsx web/scripts/build-samples.ts
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPdf, renderPng } from '../../eval/render'
import { createRng } from '../../eval/lib/rng'
import { degrade } from '../../eval/lib/scan'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples')
const src = (name: string) => join(dir, 'src', `${name}.html`)

await renderPdf(src('hebrew-tax-invoice'), join(dir, 'hebrew-tax-invoice.pdf'))
await renderPdf(src('english-invoice'), join(dir, 'english-invoice.pdf'))

// A mild office-scanner look: a slight skew, blur, noise and a grey paper tone.
const clean = join(dir, 'hebrew-scan.clean.png')
await renderPng(src('hebrew-scan'), clean, { width: 794, height: 1000, scale: 2 })
const scan = await degrade(readFileSync(clean), createRng('demo-scan'), { angle: -0.4, blur: 0.35, noise: 4, contrast: 0.97, brightness: 0, paper: 245, jpegQuality: 80, specks: 25 }, { trim: true })
writeFileSync(join(dir, 'hebrew-scan.png'), scan.png)
rmSync(clean)
console.log('samples written to', dir)
