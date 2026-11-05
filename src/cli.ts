/**
 * Command line: extract one or more invoices.
 *
 *   npx tsx src/cli.ts <file...> [--json] [--full] [--out <file|dir>] [--ocr=auto|always|never] [--password=…] [--lang=heb+eng]
 *
 * Without --json it prints a readable summary: every standard field with its status, confidence
 * and the text it was read from, the line items, discovered fields, derived values and issues.
 * --json prints the ExtractionResult (without the bulky document model unless --full).
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CANONICAL_FIELDS, type ExtractedField, type ExtractionResult, type NormalizedValue } from './model/types'
import { extract, type ExtractOptions } from './pipeline'

interface CliOptions {
  files: string[]
  json: boolean
  full: boolean
  out: string | null
  extract: ExtractOptions
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = { files: [], json: false, full: false, out: null, extract: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--full') o.full = true
    else if (a === '--out') o.out = argv[++i] ?? null
    else if (a.startsWith('--ocr=')) o.extract.ocr = a.slice(6) as ExtractOptions['ocr']
    else if (a.startsWith('--password=')) o.extract.password = a.slice(11)
    else if (a.startsWith('--lang=')) o.extract.ocrLanguages = a.slice(7).split('+')
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`)
    else o.files.push(a)
  }
  if (!o.files.length) throw new Error('usage: cli.ts <file...> [--json] [--full] [--out <file|dir>] [--ocr=auto|always|never] [--password=…] [--lang=heb+eng]')
  return o
}

/** The result without the document model (words/lines/blocks), which dwarfs everything else. */
export function compact(result: ExtractionResult): Omit<ExtractionResult, 'document' | 'structure'> & { document: { meta: ExtractionResult['document']['meta'] } } {
  const { document, structure: _structure, ...rest } = result
  return { ...rest, document: { meta: document.meta } }
}

export function showValue(v: NormalizedValue | null, raw: string): string {
  if (!v) return raw
  switch (v.kind) {
    case 'money':
      return `${v.amount}${v.currency ? ` ${v.currency}` : ''}`
    case 'percent':
      return `${v.value}%`
    case 'decimal':
      return v.value
    case 'date':
      return v.alternatives.length ? `${v.iso} (or ${v.alternatives.join(', ')})` : v.iso
    case 'currency':
      return v.code
    case 'document_type':
      return v.value
    case 'id':
      return `${v.value}${v.checksum === true ? ' ✓' : v.checksum === false ? ' ✗checksum' : ''}`
    case 'text':
      return v.value
  }
}

const MARK = { verified: '✔', proposed: '?', needs_review: '!' } as const

function fieldLine(name: string, f: ExtractedField): string {
  const label = f.originalLabel ? `  ⟵ "${f.originalLabel}"` : ''
  return `  ${MARK[f.status]} ${name.padEnd(22)} ${showValue(f.normalized, f.rawValue).padEnd(34)} ${f.status.padEnd(12)} ${f.confidence.toFixed(2)}${label}`
}

export function formatResult(file: string, r: ExtractionResult): string {
  const out: string[] = []
  const m = r.document.meta
  out.push(`${basename(file)}  — ${m.pageCount} page(s), text: ${m.textLayer}, scripts: ${m.scripts.join('+') || '-'}`)
  out.push(`summary: ${r.summary.status} (confidence ${r.summary.confidence.toFixed(2)})${r.summary.missing.length ? `, missing: ${r.summary.missing.join(', ')}` : ''}`)
  out.push('', 'fields  (✔ verified · ? proposed · ! needs review)')
  for (const name of CANONICAL_FIELDS) {
    const f = r.fields[name]
    if (f) out.push(fieldLine(name, f))
  }
  if (r.lineItems.length) {
    out.push('', `line items (${r.lineItems.length})`)
    for (const li of r.lineItems) {
      const cell = (f: ExtractedField | null) => (f ? showValue(f.normalized, f.rawValue) : '-')
      out.push(`  ${MARK[li.status]} ${String(li.index + 1).padStart(3)}. ${cell(li.description).slice(0, 48).padEnd(48)} qty ${cell(li.quantity).padEnd(8)} × ${cell(li.unitPrice).padEnd(14)} = ${cell(li.amount)}`)
    }
  }
  const discovered = r.discovered.filter((d) => !d.field)
  if (discovered.length) {
    out.push('', `discovered (${discovered.length})`)
    for (const d of discovered) out.push(`    ${(d.originalLabel ?? '').slice(0, 40).padEnd(40)} ${showValue(d.normalized, d.rawValue)}`)
  }
  if (r.derived.length) {
    out.push('', 'derived (computed, not printed)')
    for (const d of r.derived) out.push(`    ${d.field.padEnd(22)} ${showValue(d.normalized, '')}  = ${d.formula}`)
  }
  const issues = r.issues.filter((i) => i.severity !== 'info')
  if (issues.length) {
    out.push('', 'issues')
    for (const i of issues) out.push(`  ${i.severity === 'error' ? '✗' : '⚠'} ${i.code}: ${i.message}`)
  }
  return out.join('\n')
}

async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv)
  const outIsDir = !!o.out && o.files.length > 1
  for (const file of o.files) {
    const result = await extract(new Uint8Array(readFileSync(file)), { ...o.extract, fileName: basename(file) })
    const text = o.json ? JSON.stringify(o.full ? result : compact(result), null, 2) : formatResult(file, result)
    if (o.out) {
      const target = outIsDir || (o.out && isDir(o.out)) ? join(o.out, `${basename(file)}.${o.json ? 'json' : 'txt'}`) : o.out
      writeFileSync(target, text)
      console.error(`wrote ${target}`)
    } else {
      console.log(text)
      if (o.files.length > 1) console.log('')
    }
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
