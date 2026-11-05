import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GroundTruth } from '../src/model/types'
import { findTruthFiles, formatReport, jsonReport, parseArgs, runAll } from './run'
import { aggregate, scoreDocument } from './score'

const dir = mkdtempSync(join(tmpdir(), 'fx-eval-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const truth = (id: string): GroundTruth => ({ id, file: `${id}.pdf`, languages: ['he'], notes: '', fields: { total: '1180.00', document_type: 'tax_invoice' }, absent: ['due_date'], lineItems: [{ description: 'x', amount: '1000.00' }], extra: [{ label: 'סניף', value: '12' }] })

describe('run', () => {
  it('parses arguments', () => {
    expect(parseArgs(['eval/corpus', '--filter', 'he-', '--json', 'o.json', '--verbose', '--concurrency', '3', '--timeout', '5000'])).toEqual({ dir: 'eval/corpus', filter: 'he-', json: 'o.json', verbose: true, concurrency: 3, timeoutMs: 5000 })
    expect(() => parseArgs([])).toThrow(/usage/)
    expect(() => parseArgs(['x', '--nope'])).toThrow(/unknown option/)
  })

  it('finds truth files recursively and survives documents that cannot be extracted', async () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'one.truth.json'), JSON.stringify(truth('one')))
    writeFileSync(join(dir, 'a', 'b', 'two.truth.json'), JSON.stringify(truth('two')))
    // one.pdf is missing on purpose; two.pdf is not a PDF at all.
    writeFileSync(join(dir, 'a', 'b', 'two.pdf'), 'not a pdf')
    expect(findTruthFiles(dir)).toHaveLength(2)
    const runs = await runAll({ dir, filter: null, json: null, verbose: false, concurrency: 2, timeoutMs: 20_000 })
    expect(runs).toHaveLength(2)
    const one = runs.find((r) => r.score.id === 'one')!
    expect(one.score.error).toMatch(/ENOENT|no such file/i)
    expect(one.score.counts).toMatchObject({ truth: 2, missed: 2, hallucinated: 0 })
    const filtered = await runAll({ dir, filter: 'b/two', json: null, verbose: false, concurrency: 1, timeoutMs: 20_000 })
    expect(filtered.map((r) => r.score.id)).toEqual(['two'])
  })

  it('formats a readable report and a JSON report', () => {
    const runs = [{ score: scoreDocument(null, truth('one'), new Error('boom')), path: 'a/one.pdf', ms: 5 }]
    const agg = aggregate(runs.map((r) => r.score))
    const text = formatReport(agg, runs)
    expect(text).toMatch(/total\s+1\s+0/)
    expect(text).toMatch(/1 × boom/)
    expect(text).toMatch(/worst documents/)
    const json = jsonReport({ dir, filter: null, json: null, verbose: false, concurrency: 1, timeoutMs: 1 }, agg, runs) as { documents: { fields: { field: string; outcome: string }[]; extras: { missing: unknown[] } }[] }
    expect(json.documents[0].fields.map((f) => f.outcome)).toEqual(['missed', 'missed'])
    expect(json.documents[0].extras.missing).toHaveLength(1)
  })
})
