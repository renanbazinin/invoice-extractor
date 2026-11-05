/**
 * Evaluation runner (`npm run eval -- <dir>`): runs src/pipeline.ts extract() on every document
 * that has a *.truth.json under <dir>, scores it with eval/score.ts and prints the per-field table,
 * totals, hallucinations, line-item and extra recall and the worst documents. A detailed JSON
 * report (expected vs got per field, with status/method/confidence/evidence) is written to
 * eval/out/<dirname>-report.json for failure analysis.
 *
 *   npm run eval -- eval/corpus
 *   npm run eval -- eval/corpus --filter he-utility --verbose
 *   npm run eval -- eval/corpus --json tmp/report.json --concurrency 2 --timeout 180000
 *
 * A document that throws (or times out) scores as "everything missed"; the run never stops on it.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ExtractionResult, GroundTruth } from '../src/model/types'
import { pool } from './render'
import { aggregate, badness, scoreDocument, type Aggregate, type DocScore, type FieldStats } from './score'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface RunOptions {
  dir: string
  filter: string | null
  json: string | null
  verbose: boolean
  concurrency: number
  timeoutMs: number
}

type Extract = (bytes: Uint8Array, opts: { fileName?: string }) => Promise<ExtractionResult>

export function parseArgs(argv: string[]): RunOptions {
  const o: RunOptions = { dir: '', filter: null, json: null, verbose: false, concurrency: 4, timeoutMs: 120_000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--filter') o.filter = argv[++i] ?? null
    else if (a === '--json') o.json = argv[++i] ?? null
    else if (a === '--verbose' || a === '-v') o.verbose = true
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(argv[++i]) || 1)
    else if (a === '--timeout') o.timeoutMs = Math.max(1000, Number(argv[++i]) || 120_000)
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (!o.dir) o.dir = a
    else throw new Error(`unexpected argument ${a}`)
  }
  if (!o.dir) throw new Error('usage: npm run eval -- <dir> [--filter text] [--json out.json] [--verbose] [--concurrency n] [--timeout ms]')
  return o
}

/** Every *.truth.json under `dir`, sorted, as absolute paths. */
export function findTruthFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.truth.json'))
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

/**
 * Loads the pipeline lazily, so an import-time failure in a layer under construction is reported
 * per document instead of killing the runner.
 */
async function loadExtract(): Promise<{ extract: Extract | null; error: unknown }> {
  try {
    const mod = (await import('../src/pipeline')) as { extract: Extract }
    return { extract: mod.extract, error: undefined }
  } catch (error) {
    return { extract: null, error }
  }
}

export interface DocRun {
  score: DocScore
  path: string
  ms: number
}

export async function runAll(o: RunOptions, log: (s: string) => void = () => {}): Promise<DocRun[]> {
  const root = resolve(o.dir)
  let files = findTruthFiles(root)
  if (o.filter) files = files.filter((f) => relative(root, f).replace(/\\/g, '/').includes(o.filter!))
  const { extract, error: importError } = await loadExtract()
  if (importError) log(`! pipeline failed to load: ${(importError as Error).message ?? importError}`)
  const runs: DocRun[] = new Array(files.length)
  let done = 0
  await pool(
    files.map((f, i) => ({ f, i })),
    o.concurrency,
    async ({ f, i }) => {
      const truth = JSON.parse(readFileSync(f, 'utf8')) as GroundTruth
      const docPath = resolve(dirname(f), truth.file)
      const t0 = Date.now()
      let score: DocScore
      try {
        if (!extract) throw importError
        const bytes = new Uint8Array(readFileSync(docPath))
        const result = await withTimeout(extract(bytes, { fileName: basename(docPath) }), o.timeoutMs)
        score = scoreDocument(result, truth)
      } catch (err) {
        score = scoreDocument(null, truth, err ?? new Error('unknown error'))
      }
      runs[i] = { score, path: relative(root, docPath).replace(/\\/g, '/'), ms: Date.now() - t0 }
      done++
      if (o.verbose) log(verboseLine(runs[i]))
      else if (done % 25 === 0) log(`  ${done}/${files.length}`)
    },
  )
  return runs
}

// ---------------------------------------------------------------------------------------------
// Printing

const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(1)}%`)

function pad(s: string | number, w: number, left = false): string {
  const t = String(s)
  return left ? t.padEnd(w) : t.padStart(w)
}

function fieldRow(name: string, s: Omit<FieldStats, 'field'>): string {
  return [
    pad(name, 22, true),
    pad(s.n, 5),
    pad(s.found, 6),
    pad(s.correct, 8),
    pad(pct(s.accuracy), 8),
    pad(s.verified, 6),
    pad(s.verifiedWrong, 7),
    pad(pct(s.verifiedPrecision), 8),
    pad(pct(s.autoRate), 7),
    pad(s.absentN, 7),
    pad(s.hallucinated, 7),
  ].join(' ')
}

function docSummary(d: DocScore): string {
  if (d.error && d.counts.found === 0) return `ERROR ${d.error.split('\n')[0].slice(0, 100)}`
  const list = (outcome: string, verified?: boolean): string[] => d.fields.filter((f) => f.outcome === outcome && (verified === undefined || f.verified === verified)).map((f) => f.field)
  const show = (fields: string[]): string => (fields.length > 6 ? `${fields.length} (${fields.slice(0, 5).join(', ')}, …)` : fields.join(', '))
  const parts: string[] = []
  const vw = [...list('wrong', true), ...list('hallucinated', true)]
  if (vw.length) parts.push(`VERIFIED-WRONG ${vw.join(', ')}`)
  const wrong = list('wrong', false)
  if (wrong.length) parts.push(`wrong ${show(wrong)}`)
  const halluc = list('hallucinated', false)
  if (halluc.length) parts.push(`halluc ${show(halluc)}`)
  const missed = list('missed')
  if (missed.length) parts.push(`missed ${show(missed)}`)
  if (d.lineItems.expected) parts.push(`lines ${d.lineItems.matched}/${d.lineItems.expected}`)
  return parts.join('; ') || 'ok'
}

function verboseLine(r: DocRun): string {
  const c = r.score.counts
  return `  ${pad(r.score.id, 30, true)} ${pad(`${c.correct}/${c.truth}`, 6)} ${pad(`${r.ms}ms`, 8)}  ${docSummary(r.score)}`
}

export function formatReport(agg: Aggregate, runs: DocRun[], worst = 15): string {
  const out: string[] = []
  const header = [pad('field', 22, true), pad('n', 5), pad('found', 6), pad('correct', 8), pad('acc', 8), pad('verif', 6), pad('v-wrong', 7), pad('v-prec', 8), pad('auto', 7), pad('absent', 7), pad('halluc', 7)].join(' ')
  out.push(header, '-'.repeat(header.length))
  for (const f of agg.fields) if (f.n || f.absentN) out.push(fieldRow(f.field, f))
  out.push('-'.repeat(header.length), fieldRow('TOTAL', agg.total), '')
  const t = agg.total
  out.push(`documents        ${agg.documents} (${agg.errors} failed to extract, ${agg.perfectDocuments} perfect)`)
  out.push(`accuracy         ${pct(t.accuracy)}  (${t.correct}/${t.n} truth fields correct)`)
  out.push(`verified prec.   ${pct(t.verifiedPrecision)}  (${t.verifiedCorrect} correct of ${t.verified + t.hallucinatedVerified} verified; ${t.verifiedWrong} verified-wrong, ${t.hallucinatedVerified} verified hallucinations)`)
  out.push(`auto rate        ${pct(t.autoRate)}  (correct and verified / truth fields)`)
  out.push(`hallucinations   ${t.hallucinated} of ${t.absentN} absent fields`)
  out.push(`line items       recall ${pct(agg.lineItems.recall)} (${agg.lineItems.matched}/${agg.lineItems.expected}), precision ${pct(agg.lineItems.precision)} (${agg.lineItems.extracted} extracted)`)
  out.push(`extras           recall ${pct(agg.extras.recall)} (${agg.extras.found}/${agg.extras.expected})`)

  const errors = new Map<string, number>()
  for (const r of runs) if (r.score.error) errors.set(r.score.error.split('\n')[0], (errors.get(r.score.error.split('\n')[0]) ?? 0) + 1)
  if (errors.size) {
    out.push('', 'errors:')
    for (const [msg, n] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 8)) out.push(`  ${pad(n, 4)} × ${msg.slice(0, 140)}`)
  }
  const ranked = [...runs].sort((a, b) => badness(b.score) - badness(a.score)).filter((r) => badness(r.score) > 0)
  if (ranked.length) {
    out.push('', `worst documents (${Math.min(worst, ranked.length)} of ${ranked.length} with problems):`)
    for (const r of ranked.slice(0, worst)) out.push(`  ${pad(r.path, 48, true)} ${docSummary(r.score)}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// JSON report

export function jsonReport(o: RunOptions, agg: Aggregate, runs: DocRun[]): unknown {
  return {
    dir: o.dir,
    filter: o.filter,
    aggregate: agg,
    documents: runs.map(({ score: d, path, ms }) => ({
      id: d.id,
      path,
      ms,
      error: d.error,
      summaryStatus: d.summaryStatus,
      counts: d.counts,
      fields: d.fields
        .filter((f) => f.outcome !== 'unscored' || f.got !== null)
        .filter((f) => f.outcome !== 'absent_ok')
        .map((f) => ({ field: f.field, outcome: f.outcome, expected: f.expected, got: f.got, gotRaw: f.gotRaw, status: f.status, method: f.method, confidence: f.confidence, label: f.label, evidence: f.evidence, checks: f.checks, inAlternatives: f.inAlternatives })),
      lineItems: {
        expected: d.lineItems.expected,
        extracted: d.lineItems.extracted,
        matched: d.lineItems.matched,
        misses: d.lineItems.matches.filter((m) => !m.full),
      },
      extras: { expected: d.extras.expected, found: d.extras.found, missing: d.extras.details.filter((x) => !x.found) },
    })),
  }
}

export function defaultReportPath(dir: string): string {
  const name = basename(resolve(dir)) || 'eval'
  return join(HERE, 'out', `${name}-report.json`)
}

async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv)
  const t0 = Date.now()
  const runs = await runAll(o, (s) => console.log(s))
  if (!runs.length) {
    console.log(`no *.truth.json under ${o.dir}${o.filter ? ` matching "${o.filter}"` : ''}`)
    return
  }
  const agg = aggregate(runs.map((r) => r.score))
  console.log('')
  console.log(formatReport(agg, runs))
  const out = o.json ?? defaultReportPath(o.dir)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(jsonReport(o, agg, runs), null, 2)}\n`)
  console.log(`\nreport: ${relative(process.cwd(), out)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
