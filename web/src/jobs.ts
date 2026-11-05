import type { ExtractionResult } from '../../src/model/types'
import { extract, type ExtractOptions } from '../../src/pipeline'
import { ReadError } from '../../src/read/errors'
import { sniffMimeType } from '../../src/read/sniff'

export type OcrMode = NonNullable<ExtractOptions['ocr']>

export interface Job {
  id: string
  name: string
  size: number
  bytes: Uint8Array
  mimeType: ReturnType<typeof sniffMimeType>
  state: 'queued' | 'running' | 'done' | 'error' | 'password'
  ocr: OcrMode
  password?: string
  result?: ExtractionResult
  error?: string
  ms?: number
  /** The supplier template chosen by hand, null for none; undefined: matched automatically. */
  supplierTemplate?: string | null
}

let seq = 0

export async function jobFromFile(file: File, ocr: OcrMode): Promise<Job> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { id: `job${++seq}`, name: file.name, size: file.size, bytes, mimeType: sniffMimeType(bytes), state: 'queued', ocr }
}

/** Runs the four layers on one file. Everything happens in this tab: no upload, no server. */
export async function runJob(job: Job): Promise<Partial<Job>> {
  if (!job.mimeType) return { state: 'error', error: 'Not a PDF, PNG, JPEG, TIFF, WebP or text file.' }
  const t0 = performance.now()
  try {
    const result = await extract(job.bytes, { fileName: job.name, mimeType: job.mimeType, ocr: job.ocr, password: job.password })
    return { state: 'done', result, ms: performance.now() - t0, error: undefined }
  } catch (err) {
    if (err instanceof ReadError && (err.code === 'password-required' || err.code === 'password-incorrect'))
      return { state: 'password', error: err.code === 'password-incorrect' ? 'That password is incorrect.' : undefined }
    console.error(err)
    return { state: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

export function download(name: string, data: string | Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The result without the layout internals (structure) that only the pipeline needs. */
export function resultJson(r: ExtractionResult): string {
  const { structure: _structure, ...rest } = r
  return JSON.stringify(rest, null, 2)
}
