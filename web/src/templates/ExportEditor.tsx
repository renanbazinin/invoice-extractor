import { useMemo } from 'react'
import { buildTable, type Column, type ColumnSource, type ExportDoc, type ExportTemplate, type FieldPart, type LineProp, type MetaProp } from '../../../src/templates'
import { FIELD_GROUPS, FIELD_LABEL } from '../format'

const LINE_PROPS: [LineProp, string][] = [
  ['index', 'Line number'],
  ['description', 'Description'],
  ['sku', 'SKU'],
  ['quantity', 'Quantity'],
  ['unitPrice', 'Unit price'],
  ['amount', 'Amount'],
  ['taxRate', 'Tax rate'],
  ['discount', 'Discount'],
]
const META_PROPS: [MetaProp, string][] = [
  ['fileName', 'File name'],
  ['status', 'Overall status'],
  ['confidence', 'Overall confidence'],
  ['pageCount', 'Pages'],
  ['lineCount', 'Number of line items'],
  ['textLayer', 'Text source (digital / OCR)'],
  ['supplierTemplate', 'Supplier template used'],
]
const PARTS: [FieldPart, string][] = [
  ['value', 'value'],
  ['raw', 'as printed'],
  ['status', 'status'],
  ['confidence', 'confidence'],
]

const sourceKey = (s: ColumnSource): string =>
  s.type === 'field' ? `field:${s.field}` : s.type === 'line' ? `line:${s.prop}` : s.type === 'meta' ? `meta:${s.prop}` : s.type

function sourceFromKey(key: string, prev: ColumnSource): ColumnSource {
  const [type, name] = key.split(':') as [ColumnSource['type'], string]
  if (type === 'field') return { type, field: name as never, part: prev.type === 'field' ? prev.part : undefined }
  if (type === 'line') return { type, prop: name as LineProp }
  if (type === 'meta') return { type, prop: name as MetaProp }
  if (type === 'constant') return { type, value: prev.type === 'constant' ? prev.value : '' }
  return { type: 'other', label: prev.type === 'other' ? prev.label : '' }
}

function defaultHeader(s: ColumnSource): string {
  if (s.type === 'field') return FIELD_LABEL[s.field] ?? s.field
  if (s.type === 'line') return LINE_PROPS.find(([p]) => p === s.prop)?.[1] ?? s.prop
  if (s.type === 'meta') return META_PROPS.find(([p]) => p === s.prop)?.[1] ?? s.prop
  return s.type === 'constant' ? 'Fixed' : s.label || 'Other'
}

interface Props {
  draft: ExportTemplate
  onChange: (t: ExportTemplate) => void
  docs: ExportDoc[]
}

export function ExportEditor({ draft, onChange, docs }: Props) {
  const set = (p: Partial<ExportTemplate>) => onChange({ ...draft, ...p })
  const setOpt = (p: Partial<ExportTemplate['options']>) => onChange({ ...draft, options: { ...draft.options, ...p } })
  const setCol = (i: number, c: Column) => set({ columns: draft.columns.map((x, k) => (k === i ? c : x)) })
  const move = (i: number, d: -1 | 1) => {
    const cols = [...draft.columns]
    const j = i + d
    if (j < 0 || j >= cols.length) return
    ;[cols[i], cols[j]] = [cols[j]!, cols[i]!]
    set({ columns: cols })
  }
  const used = new Set(draft.columns.map((c) => sourceKey(c.source)))
  const addField = (key: string) => {
    const source = sourceFromKey(key, { type: 'constant', value: '' })
    set({ columns: [...draft.columns, { header: defaultHeader(source), source }] })
  }
  const table = useMemo(() => (docs.length ? buildTable(draft, docs.slice(0, 25)) : null), [draft, docs])

  return (
    <div className="editor">
      <div className="form-grid">
        <label>
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="wide">
          Description
          <input value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="What this export is for" />
        </label>
        <label>
          File format
          <select value={draft.format} onChange={(e) => set({ format: e.target.value as ExportTemplate['format'] })}>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label>
          Rows
          <select value={draft.rows} onChange={(e) => set({ rows: e.target.value as ExportTemplate['rows'] })}>
            <option value="invoice">One row per invoice</option>
            <option value="line">One row per line item</option>
          </select>
        </label>
        <label>
          Dates
          <select value={draft.options.dateFormat} onChange={(e) => setOpt({ dateFormat: e.target.value as ExportTemplate['options']['dateFormat'] })}>
            <option value="dd/mm/yyyy">31/12/2026</option>
            <option value="mm/dd/yyyy">12/31/2026</option>
            <option value="iso">2026-12-31</option>
          </select>
        </label>
        {draft.format !== 'json' && (
          <label>
            Decimal separator
            <select value={draft.options.decimal} onChange={(e) => setOpt({ decimal: e.target.value as '.' | ',' })}>
              <option value=".">1234.50</option>
              <option value=",">1234,50</option>
            </select>
          </label>
        )}
        {draft.format === 'csv' && (
          <label>
            Column separator
            <select value={draft.options.delimiter} onChange={(e) => setOpt({ delimiter: e.target.value as ',' | ';' | '\t' })}>
              <option value=",">Comma ,</option>
              <option value=";">Semicolon ;</option>
              <option value={'\t'}>Tab</option>
            </select>
          </label>
        )}
        <label>
          Values not verified
          <select value={draft.options.unverified} onChange={(e) => setOpt({ unverified: e.target.value as 'keep' | 'blank' })}>
            <option value="keep">Export them</option>
            <option value="blank">Leave the cell empty</option>
          </select>
        </label>
        <label className="check-toggle">
          <input type="checkbox" checked={draft.options.statusColumns} onChange={(e) => setOpt({ statusColumns: e.target.checked })} /> Status column after each value
        </label>
        {draft.format === 'xlsx' && (
          <label className="check-toggle">
            <input type="checkbox" checked={draft.options.highlight} onChange={(e) => setOpt({ highlight: e.target.checked })} /> Colour cells that are not verified
          </label>
        )}
      </div>

      <h3 className="editor-h">Columns</h3>
      {draft.columns.length === 0 && <p className="muted small">No columns yet. Add fields below.</p>}
      <ol className="cols">
        {draft.columns.map((c, i) => (
          <li key={i} className="col-row">
            <span className="col-num">{i + 1}</span>
            <input className="col-header" value={c.header} onChange={(e) => setCol(i, { ...c, header: e.target.value })} aria-label="Column header" dir="auto" />
            <select value={sourceKey(c.source)} onChange={(e) => setCol(i, { ...c, source: sourceFromKey(e.target.value, c.source) })} aria-label="Column source">
              <SourceOptions />
            </select>
            {c.source.type === 'field' && (
              <select value={c.source.part ?? 'value'} onChange={(e) => setCol(i, { ...c, source: { ...(c.source as Extract<ColumnSource, { type: 'field' }>), part: e.target.value as FieldPart } })} aria-label="Column part">
                {PARTS.map(([p, l]) => (
                  <option key={p} value={p}>
                    {l}
                  </option>
                ))}
              </select>
            )}
            {c.source.type === 'constant' && <input value={c.source.value} onChange={(e) => setCol(i, { ...c, source: { type: 'constant', value: e.target.value } })} placeholder="Text for every row" dir="auto" />}
            {c.source.type === 'other' && <input value={c.source.label} onChange={(e) => setCol(i, { ...c, source: { type: 'other', label: e.target.value } })} placeholder="Label as printed" dir="auto" />}
            <span className="col-actions">
              <button title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button title="Move down" onClick={() => move(i, 1)} disabled={i === draft.columns.length - 1}>
                ↓
              </button>
              <button title="Remove" onClick={() => set({ columns: draft.columns.filter((_, k) => k !== i) })}>
                ×
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="add-cols">
        <span className="muted small">Add:</span>
        {FIELD_GROUPS.flatMap((g) => g.fields)
          .filter((f) => !used.has(`field:${f.key}`))
          .map((f) => (
            <button key={f.key} className="chip" onClick={() => addField(`field:${f.key}`)}>
              + {FIELD_LABEL[f.key]}
            </button>
          ))}
        {draft.rows === 'line' &&
          LINE_PROPS.filter(([p]) => !used.has(`line:${p}`)).map(([p, l]) => (
            <button key={p} className="chip chip-line" onClick={() => addField(`line:${p}`)}>
              + Line: {l}
            </button>
          ))}
        {META_PROPS.filter(([p]) => !used.has(`meta:${p}`)).map(([p, l]) => (
          <button key={p} className="chip chip-meta" onClick={() => addField(`meta:${p}`)}>
            + {l}
          </button>
        ))}
        <button className="chip chip-meta" onClick={() => addField('constant')}>
          + Fixed text
        </button>
        <button className="chip chip-meta" onClick={() => addField('other')}>
          + Other labelled value
        </button>
      </div>

      <h3 className="editor-h">Preview</h3>
      {!table ? (
        <p className="muted small">Add invoices on the Documents page to see a preview here.</p>
      ) : (
        <div className="preview-wrap">
          <table className="preview">
            <thead>
              <tr>
                {table.headers.map((h, i) => (
                  <th key={i} dir="auto">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 12).map((r, i) => (
                <tr key={i}>
                  {r.map((c, k) => (
                    <td key={k} dir="auto" className={c.status && c.status !== 'verified' ? `cell-${c.status}` : undefined}>
                      {c.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.rows.length > 12 && <p className="muted small">…and {table.rows.length - 12} more rows</p>}
        </div>
      )}
    </div>
  )
}

function SourceOptions() {
  return (
    <>
      {FIELD_GROUPS.map((g) => (
        <optgroup key={g.title} label={g.title}>
          {g.fields.map((f) => (
            <option key={f.key} value={`field:${f.key}`}>
              {FIELD_LABEL[f.key]}
            </option>
          ))}
        </optgroup>
      ))}
      <optgroup label="Line items">
        {LINE_PROPS.map(([p, l]) => (
          <option key={p} value={`line:${p}`}>
            Line: {l}
          </option>
        ))}
      </optgroup>
      <optgroup label="Document">
        {META_PROPS.map(([p, l]) => (
          <option key={p} value={`meta:${p}`}>
            {l}
          </option>
        ))}
      </optgroup>
      <optgroup label="Other">
        <option value="constant">Fixed text</option>
        <option value="other">Other labelled value</option>
      </optgroup>
    </>
  )
}
