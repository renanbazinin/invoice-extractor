import { useMemo, useState } from 'react'
import type { CanonicalField, Word } from '../../../src/model/types'
import { applySupplierTemplate, boxAround, wordsInBox, type ExportTemplate, type SupplierTemplate } from '../../../src/templates'
import { DocumentViewer } from '../components/DocumentViewer'
import type { Box, Focus } from '../focus'
import { FIELD_GROUPS, FIELD_LABEL, showValue } from '../format'
import type { Job } from '../jobs'

interface Props {
  draft: SupplierTemplate
  onChange: (t: SupplierTemplate) => void
  jobs: Job[]
  previewId: string | null
  onPreview: (id: string) => void
  exportTemplates: ExportTemplate[]
}

/** Facts copied by "Fill from this invoice": the supplier's details that hold on every invoice. */
const FIXED_FROM_DOC: CanonicalField[] = ['supplier.name', 'supplier.address', 'supplier.phone', 'supplier.email', 'supplier.bank_account', 'currency', 'payment_terms']

const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)

export function SupplierEditor({ draft, onChange, jobs, previewId, onPreview, exportTemplates }: Props) {
  const set = (p: Partial<SupplierTemplate>) => onChange({ ...draft, ...p })
  const job = jobs.find((j) => j.id === previewId && j.result) ?? jobs.find((j) => j.result) ?? null
  const doc = job?.result?.document ?? null
  const [teachField, setTeachField] = useState<CanonicalField | ''>('')
  const [picked, setPicked] = useState<string[]>([])
  const [showWords, setShowWords] = useState(false)

  const applied = useMemo(() => (job?.result ? applySupplierTemplate(job.result, draft, 'manual') : null), [job, draft])

  const pageSize = (n: number) => doc?.pages.find((p) => p.number === n)
  const focus: Focus | null = useMemo(() => {
    if (!doc) return null
    const boxes: Box[] = []
    for (const r of draft.regions) {
      const p = pageSize(r.page)
      if (p) boxes.push({ page: r.page, kind: 'row', bbox: { x0: r.box.x0 * p.width, y0: r.box.y0 * p.height, x1: r.box.x1 * p.width, y1: r.box.y1 * p.height } })
    }
    for (const id of picked) {
      const w = doc.words.find((x) => x.id === id)
      if (w) boxes.push({ page: w.page, kind: 'value', bbox: w.bbox })
    }
    return { key: 'teach', boxes }
  }, [doc, draft.regions, picked])

  const onWord = (w: Word) => {
    if (!teachField) return
    setPicked((p) => (p.includes(w.id) ? p.filter((x) => x !== w.id) : [...p, w.id]))
  }
  const onBox = (page: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
    if (!teachField || !doc) return
    const inside = doc.words
      .filter((w) => w.page === page && (w.bbox.x0 + w.bbox.x1) / 2 >= b.x0 && (w.bbox.x0 + w.bbox.x1) / 2 <= b.x1 && (w.bbox.y0 + w.bbox.y1) / 2 >= b.y0 && (w.bbox.y0 + w.bbox.y1) / 2 <= b.y1)
      .map((w) => w.id)
    setPicked((p) => [...p, ...inside.filter((id) => !p.includes(id))])
  }
  const saveBox = () => {
    if (!doc || !teachField || !picked.length) return
    const b = boxAround(doc, picked)
    if (!b) return
    set({ regions: [...draft.regions.filter((r) => r.field !== teachField), { field: teachField, ...b }] })
    setPicked([])
    setTeachField('')
  }

  const fillFromDoc = () => {
    if (!job?.result) return
    const f = job.result.fields
    const fixed = { ...draft.fixed }
    for (const k of FIXED_FROM_DOC) if (f[k] && !fixed[k]) fixed[k] = f[k]!.rawValue
    const taxId = f['supplier.tax_id']?.normalized
    const name = f['supplier.name']?.rawValue
    set({
      fixed,
      match: {
        taxIds: taxId?.kind === 'id' && !draft.match.taxIds.includes(taxId.value) ? [...draft.match.taxIds, taxId.value] : draft.match.taxIds,
        names: name && !draft.match.names.includes(name) ? [...draft.match.names, name] : draft.match.names,
      },
      name: draft.name === 'My supplier' && name ? name : draft.name,
    })
  }

  const labelsOnDoc = (job?.result?.discovered ?? []).map((d) => d.originalLabel).filter((l): l is string => !!l && !draft.labels.some((x) => x.label === l))

  return (
    <div className="editor editor-split">
      <div className="editor-form">
        <div className="form-grid">
          <label>
            Name
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} dir="auto" />
          </label>
          <label className="wide">
            Description
            <input value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="What this template knows about the supplier" dir="auto" />
          </label>
          <label className="wide">
            Supplier tax IDs (ח.פ / ע.מ), comma-separated
            <input value={draft.match.taxIds.join(', ')} onChange={(e) => set({ match: { ...draft.match, taxIds: list(e.target.value) } })} placeholder="515555555" />
          </label>
          <label className="wide">
            Or supplier names, comma-separated
            <input value={draft.match.names.join(', ')} onChange={(e) => set({ match: { ...draft.match, names: list(e.target.value) } })} placeholder='סטודיו הדמו בע"מ' dir="auto" />
          </label>
          <label className="wide">
            Export this supplier&apos;s invoices with
            <select value={draft.exportTemplateId ?? ''} onChange={(e) => set({ exportTemplateId: e.target.value || null })}>
              <option value="">The default export template</option>
              {exportTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">The template applies to every invoice that prints one of these tax IDs (or, failing that, one of the names).</p>

        <h3 className="editor-h">Fixed facts</h3>
        <p className="muted small">Values that hold on every invoice of this supplier, such as its legal name or bank account.</p>
        <RuleRows
          rows={Object.entries(draft.fixed).map(([field, value]) => ({ field: field as CanonicalField, text: value ?? '' }))}
          placeholder="Value"
          onChange={(rows) => set({ fixed: Object.fromEntries(rows.map((r) => [r.field, r.text])) })}
        />
        {job && (
          <button className="link" onClick={fillFromDoc}>
            Fill the supplier&apos;s details from {job.name}
          </button>
        )}

        <h3 className="editor-h">Labels this supplier prints</h3>
        <p className="muted small">When the supplier labels a field in its own way (for example &quot;אסמכתא&quot; for the invoice number), map the label to the field.</p>
        <RuleRows
          rows={draft.labels.map((l) => ({ field: l.field, text: l.label }))}
          placeholder="Label as printed"
          textFirst
          onChange={(rows) => set({ labels: rows.map((r) => ({ label: r.text, field: r.field })) })}
        />
        {labelsOnDoc.length > 0 && (
          <div className="add-cols">
            <span className="muted small">Labels on {job!.name}:</span>
            {labelsOnDoc.slice(0, 14).map((l) => (
              <button key={l} className="chip" dir="auto" onClick={() => set({ labels: [...draft.labels, { label: l, field: 'invoice_number' }] })}>
                + {l}
              </button>
            ))}
          </div>
        )}

        <h3 className="editor-h">Boxes on the page</h3>
        <p className="muted small">For a value with no label, show where it is printed: choose the field, drag a box around the value on the invoice (or click its words), then save the box.</p>
        {draft.regions.length > 0 && (
          <ul className="regions">
            {draft.regions.map((r, i) => {
              const words = doc && r.page <= doc.pages.length ? wordsInBox(doc, r.page, r.box).map((id) => doc.words.find((w) => w.id === id)!.text) : []
              return (
                <li key={i}>
                  <b>{FIELD_LABEL[r.field]}</b> <span className="muted small">page {r.page}</span>
                  <span dir="auto" className="region-words">
                    {words.length ? words.join(' ') : '(nothing in this box on this invoice)'}
                  </span>
                  <button title="Remove" onClick={() => set({ regions: draft.regions.filter((_, k) => k !== i) })}>
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {doc ? (
          <div className="teach">
            <select value={teachField} onChange={(e) => (setTeachField(e.target.value as CanonicalField | ''), setPicked([]))}>
              <option value="">Teach a box for…</option>
              <FieldOptions />
            </select>
            {teachField && (
              <>
                <span className="muted small">{picked.length ? `${picked.length} word${picked.length === 1 ? '' : 's'} picked` : 'Drag a box around the value'}</span>
                <button className="primary" disabled={!picked.length} onClick={saveBox}>
                  Save box
                </button>
                <button onClick={() => (setTeachField(''), setPicked([]))}>Cancel</button>
              </>
            )}
          </div>
        ) : (
          <p className="muted small">Add an invoice from this supplier on the Documents page to teach boxes.</p>
        )}

        {applied && (
          <>
            <h3 className="editor-h">What it does to {job!.name}</h3>
            {applied.notes.length === 0 ? (
              <p className="muted small">Nothing yet: add facts, labels or boxes.</p>
            ) : (
              <table className="checks">
                <tbody>
                  {applied.notes.map((n, i) => {
                    const f = applied.fields[n.field]
                    return (
                      <tr key={i} className={n.outcome === 'replaced' ? 'issue-warning' : undefined}>
                        <td className="check-mark">{n.outcome === 'same' ? '=' : n.outcome === 'filled' ? '+' : '≠'}</td>
                        <td>
                          <b>{FIELD_LABEL[n.field]}</b>: <span dir="auto">{f ? showValue(f.normalized, f.rawValue) : ''}</span>
                          <div className="muted small">{n.message}</div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="editor-page">
        {jobs.some((j) => j.result) ? (
          <>
            <div className="editor-page-bar">
              <select value={job?.id ?? ''} onChange={(e) => (onPreview(e.target.value), setPicked([]))} aria-label="Invoice to try the template on">
                {jobs
                  .filter((j) => j.result)
                  .map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
              </select>
              <label className="check-toggle">
                <input type="checkbox" checked={showWords || !!teachField} onChange={(e) => setShowWords(e.target.checked)} /> Show words
              </label>
            </div>
            <div className={`viewer editor-viewer${teachField ? ' is-teaching' : ''}`}>{job && <DocumentViewer job={job} focus={focus} showWords={showWords || !!teachField} onWordClick={onWord} onSelectBox={teachField ? onBox : undefined} />}</div>
          </>
        ) : (
          <div className="viewer viewer-empty">
            <p className="muted">Add an invoice from this supplier on the Documents page to see the template work on it.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function FieldOptions() {
  return (
    <>
      {FIELD_GROUPS.map((g) => (
        <optgroup key={g.title} label={g.title}>
          {g.fields.map((f) => (
            <option key={f.key} value={f.key}>
              {FIELD_LABEL[f.key]}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
}

interface Row {
  field: CanonicalField
  text: string
}

function RuleRows({ rows, onChange, placeholder, textFirst }: { rows: Row[]; onChange: (rows: Row[]) => void; placeholder: string; textFirst?: boolean }) {
  const setRow = (i: number, r: Row) => onChange(rows.map((x, k) => (k === i ? r : x)))
  const free = FIELD_GROUPS.flatMap((g) => g.fields).find((f) => !rows.some((r) => r.field === f.key))?.key ?? 'invoice_number'
  return (
    <div className="rules">
      {rows.map((r, i) => {
        const field = (
          <select value={r.field} onChange={(e) => setRow(i, { ...r, field: e.target.value as CanonicalField })} aria-label="Field">
            <FieldOptions />
          </select>
        )
        const text = <input value={r.text} onChange={(e) => setRow(i, { ...r, text: e.target.value })} placeholder={placeholder} dir="auto" />
        return (
          <div key={i} className="rule-row">
            {textFirst ? text : field}
            <span className="muted">{textFirst ? '→' : '='}</span>
            {textFirst ? field : text}
            <button title="Remove" onClick={() => onChange(rows.filter((_, k) => k !== i))}>
              ×
            </button>
          </div>
        )
      })}
      <button className="link" onClick={() => onChange([...rows, { field: free, text: '' }])}>
        + Add
      </button>
    </div>
  )
}
