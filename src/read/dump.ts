/**
 * Debug view of what the reader sees:
 *
 *   npx tsx src/read/dump.ts <file> [--words] [--json] [--ocr=auto|always|never] [--password=…] [--lang=heb+eng]
 *
 * Prints, per page, each block and its lines in reading order with their boxes (points,
 * top-left origin) and base direction; --words adds every word with its box, font size, bold
 * flag and OCR confidence; --json prints the whole DocumentModel.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BBox, DocumentModel } from '../model/types'
import { readDocument, type ReadOptions } from './index'

const box = (b: BBox): string => `[${[b.x0, b.y0, b.x1, b.y1].map((v) => v.toFixed(1).padStart(6)).join(' ')}]`

/** The dump as text, for the CLI and for tests that want to eyeball a page. */
export function formatDocument(doc: DocumentModel, opts: { words?: boolean } = {}): string {
  const out: string[] = []
  const m = doc.meta
  out.push(`${m.fileName ?? '(bytes)'}  ${m.mimeType}  pages=${m.pageCount}  textLayer=${m.textLayer}  scripts=${m.scripts.join(',') || '-'}  producer=${m.producer ?? '-'}`)
  if (m.warnings.length) out.push(`warnings: ${m.warnings.join(', ')}`)
  const lines = new Map(doc.lines.map((l) => [l.id, l]))
  const blocks = new Map(doc.blocks.map((b) => [b.id, b]))
  const wordsById = new Map(doc.words.map((w) => [w.id, w]))
  for (const page of doc.pages) {
    out.push('')
    out.push(`=== page ${page.number}  ${page.width.toFixed(1)} x ${page.height.toFixed(1)} pt  source=${page.source}  blocks=${page.blockIds.length}  lines=${page.lineIds.length}`)
    for (const bid of page.blockIds) {
      const b = blocks.get(bid)!
      out.push(`  ${b.id.padEnd(7)} ${box(b.bbox)}`)
      for (const lid of b.lineIds) {
        const l = lines.get(lid)!
        out.push(`    ${l.id.padEnd(7)} ${l.dir} ${box(l.bbox)}  ${l.text}`)
        if (!opts.words) continue
        for (const wid of l.wordIds) {
          const w = wordsById.get(wid)!
          const extra = [`${w.fontSize}pt`, w.bold ? 'bold' : '', w.dir ?? 'neutral', w.source === 'ocr' ? `conf=${w.confidence.toFixed(2)}` : ''].filter(Boolean)
          out.push(`        ${w.id.padEnd(8)} ${box(w.bbox)}  ${w.text}   (${extra.join(' ')})`)
        }
      }
    }
  }
  return out.join('\n')
}

async function main(argv: string[]): Promise<void> {
  const file = argv.find((a) => !a.startsWith('--'))
  if (!file) throw new Error('usage: npx tsx src/read/dump.ts <file> [--words] [--json] [--ocr=auto|always|never] [--password=…] [--lang=heb+eng]')
  const flag = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const opts: ReadOptions = { fileName: basename(file) }
  const ocr = flag('ocr')
  if (ocr === 'auto' || ocr === 'always' || ocr === 'never') opts.ocr = ocr
  const password = flag('password')
  if (password !== undefined) opts.password = password
  const lang = flag('lang')
  if (lang) opts.ocrLanguages = lang.split('+')
  const doc = await readDocument(new Uint8Array(readFileSync(file)), opts)
  if (argv.includes('--json')) console.log(JSON.stringify(doc, null, 2))
  else console.log(formatDocument(doc, { words: argv.includes('--words') }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
