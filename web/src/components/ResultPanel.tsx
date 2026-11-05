import { useState, type ReactNode } from 'react'
import type { ExtractedField, ExtractionResult, FieldStatus } from '../../../src/model/types'
import { fieldFocus, itemFocus, lineFocus, type Focus } from '../focus'
import { FIELD_GROUPS, FIELD_LABEL, STATUS, counts, formatMs, showValue, valueNotes } from '../format'
import { download, resultJson, type Job } from '../jobs'

export type Tab = 'fields' | 'items' | 'other' | 'checks' | 'text' | 'json'

interface Props {
  job: Job
  tab: Tab
  onTab: (t: Tab) => void
  active: Focus | null
  pinned: string | null
  onHover: (f: Focus | null) => void
  onPin: (f: Focus) => void
}

export function ResultPanel({ job, tab, onTab, active, pinned, onHover, onPin }: Props) {
  const r = job.result!
  const c = counts(r)
  const problems = r.issues.filter((i) => i.severity !== 'info')
  const others = r.discovered.length
  const failed = r.checks.filter((x) => x.status === 'fail').length
  const row = (f: Focus) => ({
    id: `row-${f.key}`,
    className: `${active?.key === f.key ? 'is-active' : ''} ${pinned === f.key ? 'is-pinned' : ''}`,
    onMouseEnter: () => onHover(f),
    onMouseLeave: () => onHover(null),
    onClick: () => onPin(f),
  })

  return (
    <section className="panel">
      <header className="summary">
        <div className="summary-top">
          <StatusPill status={r.summary.status} big />
          <span className="summary-conf" title="Overall confidence">
            {Math.round(r.summary.confidence * 100)}%
          </span>
          <span className="summary-meta">
            {r.document.meta.pageCount} page{r.document.meta.pageCount === 1 ? '' : 's'} · {textLayerLabel(r.document.meta.textLayer)} · {r.document.meta.scripts.join(' + ') || 'no text'} · {formatMs(job.ms ?? 0)}
          </span>
        </div>
        <div className="summary-counts">
          {(Object.keys(STATUS) as FieldStatus[]).map((s) => (
            <span key={s} className={`count count-${s}`} title={STATUS[s].hint}>
              <b>{c[s]}</b> {STATUS[s].label.toLowerCase()}
            </span>
          ))}
          {r.summary.missing.length > 0 && (
            <span className="count count-missing" title={r.summary.missing.map((m) => FIELD_LABEL[m] ?? m).join(', ')}>
              <b>{r.summary.missing.length}</b> key field{r.summary.missing.length === 1 ? '' : 's'} missing
            </span>
          )}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <TabButton id="fields" tab={tab} onTab={onTab}>
          Fields
        </TabButton>
        <TabButton id="items" tab={tab} onTab={onTab} badge={r.lineItems.length}>
          Line items
        </TabButton>
        <TabButton id="other" tab={tab} onTab={onTab} badge={others}>
          Other fields
        </TabButton>
        <TabButton id="checks" tab={tab} onTab={onTab} badge={failed || undefined} alert={failed > 0}>
          Checks
        </TabButton>
        <TabButton id="text" tab={tab} onTab={onTab}>
          Text
        </TabButton>
        <TabButton id="json" tab={tab} onTab={onTab}>
          JSON
        </TabButton>
      </nav>

      <div className="tab-body">
        {tab === 'fields' && (
          <>
            {problems.length > 0 && (
              <ul className="issues">
                {problems.map((i, k) => (
                  <li key={k} className={`issue issue-${i.severity}`}>
                    <span className="issue-mark">{i.severity === 'error' ? '✕' : '⚠'}</span>
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
            {FIELD_GROUPS.map((g) => (
              <table key={g.title} className="fields">
                <caption>{g.title}</caption>
                <tbody>
                  {g.fields.map(({ key, en, he }) => {
                    const f = r.fields[key]
                    if (!f)
                      return (
                        <tr key={key} className="missing">
                          <th>
                            {en} <span className="he">{he}</span>
                          </th>
                          <td colSpan={2}>—</td>
                        </tr>
                      )
                    const focus = fieldFocus(key, f)
                    return (
                      <FieldRow key={key} rowProps={row(focus)} expanded={pinned === key} f={f}>
                        {en} <span className="he">{he}</span>
                      </FieldRow>
                    )
                  })}
                </tbody>
              </table>
            ))}
            {r.derived.length > 0 && (
              <table className="fields derived">
                <caption>Computed (not printed on the document)</caption>
                <tbody>
                  {r.derived.map((d, k) => (
                    <tr key={k}>
                      <th>{FIELD_LABEL[d.field] ?? d.field}</th>
                      <td className="value">{showValue(d.normalized, '')}</td>
                      <td className="muted small">= {d.formula}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === 'items' &&
          (r.lineItems.length ? (
            <table className="items">
              <thead>
                <tr>
                  <th />
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {r.lineItems.map((li) => (
                  <tr key={li.index} {...row(itemFocus(li))}>
                    <td>
                      <StatusMark status={li.status} />
                    </td>
                    <td dir="auto" className="desc">
                      {cell(li.description)}
                      {li.sku && <span className="muted small"> · {cell(li.sku)}</span>}
                    </td>
                    <td className="num">{cell(li.quantity)}</td>
                    <td className="num">{cell(li.unitPrice)}</td>
                    <td className="num">{cell(li.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No line items were found.</p>
          ))}

        {tab === 'other' &&
          (r.discovered.length ? (
            <table className="fields">
              <caption>Other labelled values on the document</caption>
              <tbody>
                {r.discovered.map((d, k) => {
                  const focus = fieldFocus(`other:${k}`, d)
                  return (
                    <tr key={k} {...row(focus)}>
                      <th dir="auto">
                        {d.originalLabel ?? '(no label)'}
                        {d.field && <span className="muted small"> · {FIELD_LABEL[d.field] ?? d.field}</span>}
                      </th>
                      <td className="value" dir="auto" colSpan={2}>
                        {showValue(d.normalized, d.rawValue)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p className="empty">No other labelled values.</p>
          ))}

        {tab === 'checks' && (
          <>
            <table className="checks">
              <caption>Validation checks</caption>
              <tbody>
                {r.checks.length === 0 && (
                  <tr>
                    <td className="muted">No checks could be run.</td>
                  </tr>
                )}
                {r.checks.map((x) => (
                  <tr key={x.id} className={`check-${x.status}`}>
                    <td className="check-mark">{x.status === 'pass' ? '✔' : x.status === 'fail' ? '✕' : '–'}</td>
                    <td>
                      <div>{x.message}</div>
                      {x.status === 'fail' && (x.expected || x.actual) && (
                        <div className="muted small">
                          expected {x.expected ?? '—'}, found {x.actual ?? '—'}
                        </div>
                      )}
                      <code className="muted small">{x.id}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="checks">
              <caption>Notes</caption>
              <tbody>
                {r.issues.length === 0 && (
                  <tr>
                    <td className="muted">No notes.</td>
                  </tr>
                )}
                {r.issues.map((i, k) => (
                  <tr key={k} className={`issue-${i.severity}`}>
                    <td className="check-mark">{i.severity === 'error' ? '✕' : i.severity === 'warning' ? '⚠' : 'i'}</td>
                    <td>
                      <div>{i.message}</div>
                      <code className="muted small">{i.code}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.document.meta.warnings.length > 0 && (
              <p className="muted small">Reader notes: {r.document.meta.warnings.join(', ')}</p>
            )}
          </>
        )}

        {tab === 'text' && <TextTab r={r} row={row} />}

        {tab === 'json' && <JsonTab job={job} />}
      </div>
    </section>
  )
}

function FieldRow({ f, rowProps, expanded, children }: { f: ExtractedField; rowProps: object; expanded: boolean; children: ReactNode }) {
  const shown = showValue(f.normalized, f.rawValue)
  const notes = valueNotes(f.normalized)
  return (
    <>
      <tr {...rowProps}>
        <th>{children}</th>
        <td className="value">
          <span dir="auto">{shown}</span>
          {notes.map((n) => (
            <span key={n} className="note">
              {n}
            </span>
          ))}
          {shown.replace(/[\s,]/g, '').toLowerCase() !== f.rawValue.replace(/[\s,]/g, '').toLowerCase() && (
            <div className="raw" dir="auto" title="As printed">
              {f.rawValue}
            </div>
          )}
        </td>
        <td className="status-cell">
          <StatusMark status={f.status} />
        </td>
      </tr>
      {expanded && (
        <tr className="details">
          <td colSpan={3}>
            <dl>
              <dt>Status</dt>
              <dd>
                {STATUS[f.status].label} — {STATUS[f.status].hint}
              </dd>
              <dt>Confidence</dt>
              <dd>{Math.round(f.confidence * 100)}%</dd>
              {f.originalLabel && (
                <>
                  <dt>Printed label</dt>
                  <dd dir="auto">{f.originalLabel}</dd>
                </>
              )}
              <dt>Found by</dt>
              <dd>
                <code>{f.method}</code>
              </dd>
              {f.checks.length > 0 && (
                <>
                  <dt>Confirmed by</dt>
                  <dd>
                    {f.checks.map((c) => (
                      <code key={c}>{c}</code>
                    ))}
                  </dd>
                </>
              )}
              {f.alternatives.length > 0 && (
                <>
                  <dt>Other readings</dt>
                  <dd>
                    {f.alternatives.slice(0, 4).map((a, k) => (
                      <div key={k} dir="auto">
                        {showValue(a.normalized, a.rawValue)} <span className="muted small">({Math.round(a.confidence * 100)}%)</span>
                      </div>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

function TextTab({ r, row }: { r: ExtractionResult; row: (f: Focus) => object }) {
  const [onlyUnused, setOnlyUnused] = useState(false)
  const unused = new Set(r.unclassifiedLineIds)
  const byId = new Map(r.document.lines.map((l) => [l.id, l]))
  return (
    <>
      <label className="check-toggle">
        <input type="checkbox" checked={onlyUnused} onChange={(e) => setOnlyUnused(e.target.checked)} /> Only lines no field used ({unused.size})
      </label>
      {r.document.pages.map((p) => (
        <div key={p.number} className="text-page">
          {r.document.pages.length > 1 && <h4>Page {p.number}</h4>}
          <ol className="lines">
            {p.lineIds
              .map((id) => byId.get(id)!)
              .filter((l) => l && (!onlyUnused || unused.has(l.id)))
              .map((l) => (
                <li key={l.id} dir={l.dir} {...row(lineFocus(r, l.id))} data-unused={unused.has(l.id) ? '1' : undefined}>
                  {l.text}
                </li>
              ))}
          </ol>
        </div>
      ))}
    </>
  )
}

function JsonTab({ job }: { job: Job }) {
  const json = resultJson(job.result!)
  const base = job.name.replace(/\.[^.]+$/, '')
  return (
    <>
      <div className="json-actions">
        <button onClick={() => download(`${base}.extraction.json`, json, 'application/json')}>Download JSON</button>
        <button onClick={() => navigator.clipboard?.writeText(json)}>Copy</button>
        <span className="muted small">{(json.length / 1024).toFixed(0)} KB · includes every word with its position</span>
      </div>
      <pre className="json">{json.length > 400_000 ? `${json.slice(0, 400_000)}\n…` : json}</pre>
    </>
  )
}

function TabButton({ id, tab, onTab, badge, alert, children }: { id: Tab; tab: Tab; onTab: (t: Tab) => void; badge?: number; alert?: boolean; children: ReactNode }) {
  return (
    <button role="tab" aria-selected={tab === id} className={tab === id ? 'tab is-on' : 'tab'} onClick={() => onTab(id)}>
      {children}
      {badge !== undefined && badge > 0 && <span className={alert ? 'badge badge-alert' : 'badge'}>{badge}</span>}
    </button>
  )
}

export function StatusMark({ status }: { status: FieldStatus }) {
  return (
    <span className={`mark mark-${status}`} title={`${STATUS[status].label}: ${STATUS[status].hint}`}>
      {STATUS[status].mark}
    </span>
  )
}

export function StatusPill({ status, big }: { status: FieldStatus; big?: boolean }) {
  return (
    <span className={`pill pill-${status}${big ? ' pill-big' : ''}`} title={STATUS[status].hint}>
      {STATUS[status].mark} {STATUS[status].label}
    </span>
  )
}

const cell = (f: ExtractedField | null) => (f ? showValue(f.normalized, f.rawValue) : '')

function textLayerLabel(t: ExtractionResult['document']['meta']['textLayer']): string {
  return t === 'embedded' ? 'digital text' : t === 'ocr' ? 'OCR' : 'digital text + OCR'
}
