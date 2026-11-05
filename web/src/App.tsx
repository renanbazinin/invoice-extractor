import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import type { Word } from '../../src/model/types'
import { DocumentViewer } from './components/DocumentViewer'
import { ResultPanel, StatusPill, type Tab } from './components/ResultPanel'
import { whereUsed, type Focus } from './focus'
import { formatBytes, formatMs } from './format'
import { download, jobFromFile, runJob, toCsv, type Job, type OcrMode } from './jobs'

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp,.txt,application/pdf,image/*,text/plain'
const SAMPLES = [
  { file: 'hebrew-tax-invoice.pdf', label: 'Hebrew tax invoice (PDF)' },
  { file: 'hebrew-scan.png', label: 'Hebrew scan (OCR)' },
  { file: 'english-invoice.pdf', label: 'English invoice (PDF)' },
]

export function App() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [ocr, setOcr] = useState<OcrMode>('auto')
  const [tab, setTab] = useState<Tab>('fields')
  const [hover, setHover] = useState<Focus | null>(null)
  const [pinned, setPinned] = useState<Focus | null>(null)
  const [showWords, setShowWords] = useState(false)
  const [dragging, setDragging] = useState(false)
  const busy = useRef(false)
  const input = useRef<HTMLInputElement>(null)

  const patch = useCallback((id: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j))), [])

  // One document at a time, in the order added.
  useEffect(() => {
    if (busy.current) return
    const next = jobs.find((j) => j.state === 'queued')
    if (!next) return
    busy.current = true
    patch(next.id, { state: 'running' })
    // Let the browser paint the "reading" state before the pipeline takes the main thread.
    setTimeout(async () => {
      const outcome = await runJob(next)
      busy.current = false
      patch(next.id, outcome)
    }, 50)
  }, [jobs, patch])

  const addFiles = useCallback(
    // Callers pass a copy: a FileList empties when its input is reset or its drop event ends.
    async (files: readonly File[]) => {
      const added: Job[] = []
      for (const f of files) added.push(await jobFromFile(f, ocr))
      if (!added.length) return
      setJobs((js) => [...js, ...added])
      setSelected((s) => s ?? added[0].id)
    },
    [ocr],
  )

  const addSample = async (file: string) => {
    const res = await fetch(`samples/${file}`)
    if (!res.ok) return
    await addFiles([new File([await res.blob()], file)])
  }

  const job = jobs.find((j) => j.id === selected) ?? null
  const done = jobs.filter((j) => j.result)

  const select = (id: string) => {
    setSelected(id)
    setPinned(null)
    setHover(null)
  }

  const remove = (id: string) => {
    setJobs((js) => js.filter((j) => j.id !== id || j.state === 'running'))
    if (selected === id) setSelected(jobs.find((j) => j.id !== id)?.id ?? null)
  }

  const pin = (f: Focus) => {
    setPinned((p) => (p?.key === f.key ? null : f))
    // Bring the highlighted value into view on the page.
    requestAnimationFrame(() => document.querySelector('.pages [data-focus="1"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }

  const onWordClick = (w: Word) => {
    if (!job?.result) return
    const used = whereUsed(job.result, w.id)
    setTab(used.tab)
    setPinned(used.focus)
    requestAnimationFrame(() => document.getElementById(`row-${used.focus.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void addFiles([...e.dataTransfer.files])
  }

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22">
              <rect x="6" y="3" width="20" height="26" rx="3" fill="currentColor" />
              <path d="M11 11h10M11 16h10M11 21h6" stroke="var(--bg)" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          Invoice Extractor
          <span className="local" title="Files are read in this browser tab. Nothing is uploaded.">
            runs locally
          </span>
        </div>
        <div className="toolbar">
          <label className="select" title="When to run OCR. Auto: only for pages without a usable text layer (scans, photos).">
            OCR
            <select value={ocr} onChange={(e) => setOcr(e.target.value as OcrMode)}>
              <option value="auto">Auto</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
          </label>
          <label className="check-toggle" title="Outline every word the reader found">
            <input type="checkbox" checked={showWords} onChange={(e) => setShowWords(e.target.checked)} /> Show words
          </label>
          <button disabled={!done.length} onClick={() => download('invoices.csv', toCsv(done), 'text/csv;charset=utf-8')} title="One row per document, every standard field with its status">
            Export CSV
          </button>
          <button className="primary" onClick={() => input.current?.click()}>
            Add files
          </button>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles([...e.target.files])
              e.target.value = ''
            }}
          />
        </div>
      </header>

      {jobs.length === 0 ? (
        <main className="welcome">
          <div className={`dropzone${dragging ? ' is-over' : ''}`} onClick={() => input.current?.click()} role="button" tabIndex={0}>
            <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden>
              <path d="M24 31V9m0 0-8 8m8-8 8 8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 29v8a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <strong>Drop invoices here, or click to choose files</strong>
            <span>PDF, PNG, JPEG, TIFF, WebP or text. Several at once is fine.</span>
          </div>
          <p className="privacy">
            Everything runs in this browser tab: the files are never uploaded, and OCR runs on this computer. No templates, no AI model.
          </p>
          <div className="samples">
            <span>Or try a sample:</span>
            {SAMPLES.map((s) => (
              <button key={s.file} onClick={() => void addSample(s.file)}>
                {s.label}
              </button>
            ))}
          </div>
        </main>
      ) : (
        <main className="workspace">
          <aside className="sidebar">
            <ul className="joblist">
              {jobs.map((j) => (
                <li key={j.id} className={j.id === selected ? 'is-selected' : ''} onClick={() => select(j.id)}>
                  <div className="job-name" title={j.name}>
                    {j.name}
                  </div>
                  <div className="job-sub">
                    {j.state === 'queued' && <span className="muted">Waiting…</span>}
                    {j.state === 'running' && (
                      <span className="running">
                        <span className="spinner" /> Reading…
                      </span>
                    )}
                    {j.state === 'error' && <span className="err">Failed</span>}
                    {j.state === 'password' && <span className="warn">Password needed</span>}
                    {j.result && <StatusPill status={j.result.summary.status} />}
                    <span className="muted small">{j.ms !== undefined ? formatMs(j.ms) : formatBytes(j.size)}</span>
                  </div>
                  {j.state !== 'running' && (
                    <button
                      className="job-remove"
                      title="Remove"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(j.id)
                      }}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button className="sidebar-add" onClick={() => input.current?.click()}>
              + Add files
            </button>
          </aside>

          {job?.result ? (
            <>
              <section className="viewer" onMouseLeave={() => setHover(null)}>
                <DocumentViewer job={job} focus={hover ?? pinned} showWords={showWords} onWordClick={onWordClick} />
              </section>
              <ResultPanel job={job} tab={tab} onTab={setTab} active={hover ?? pinned} pinned={pinned?.key ?? null} onHover={setHover} onPin={pin} />
            </>
          ) : (
            <section className="viewer viewer-empty">
              {job && <JobState job={job} onPassword={(pw) => patch(job.id, { password: pw, state: 'queued', error: undefined })} onRetry={(mode) => patch(job.id, { ocr: mode, state: 'queued', error: undefined })} />}
            </section>
          )}
        </main>
      )}

      {dragging && jobs.length > 0 && <div className="drop-overlay">Drop to add</div>}
    </div>
  )
}

function JobState({ job, onPassword, onRetry }: { job: Job; onPassword: (pw: string) => void; onRetry: (mode: OcrMode) => void }) {
  const [pw, setPw] = useState('')
  if (job.state === 'queued' || job.state === 'running')
    return (
      <div className="state">
        <span className="spinner big" />
        <p>{job.state === 'queued' ? 'Waiting for the documents before it…' : `Reading ${job.name}…`}</p>
        {job.state === 'running' && job.mimeType !== 'application/pdf' && job.mimeType !== 'text/plain' && (
          <p className="muted small">Images are read with OCR, which takes a few seconds per page. The first OCR run also loads the Hebrew and English language data.</p>
        )}
      </div>
    )
  if (job.state === 'password')
    return (
      <form
        className="state"
        onSubmit={(e) => {
          e.preventDefault()
          if (pw) onPassword(pw)
        }}
      >
        <p>
          <strong>{job.name}</strong> is password-protected.
        </p>
        {job.error && <p className="err">{job.error}</p>}
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="PDF password" aria-label="PDF password" />
        <button className="primary" type="submit">
          Open
        </button>
      </form>
    )
  return (
    <div className="state">
      <p className="err">Could not read {job.name}</p>
      <p className="muted">{job.error}</p>
      {job.mimeType === 'application/pdf' && <button onClick={() => onRetry('always')}>Retry with OCR</button>}
    </div>
  )
}
