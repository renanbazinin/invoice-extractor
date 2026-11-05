import { useMemo, useRef, useState } from 'react'
import { isBuiltin, matchSupplierTemplate, type ExportDoc, type ExportTemplate, type SupplierTemplate, type Template } from '../../../src/templates'
import { download, type Job } from '../jobs'
import { ExportEditor } from './ExportEditor'
import { SupplierEditor } from './SupplierEditor'
import { blankExport, blankSupplier, forkOf, type TemplateStore } from './useTemplates'

interface Props {
  store: TemplateStore
  jobs: Job[]
  docs: ExportDoc[]
  editing: Template | null
  setEditing: (t: Template | null) => void
  previewId: string | null
  setPreviewId: (id: string) => void
}

export function TemplatesView({ store, jobs, docs, editing, setEditing, previewId, setPreviewId }: Props) {
  const [tab, setTab] = useState<'export' | 'supplier'>(editing?.kind ?? 'export')
  const [message, setMessage] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const saved = editing ? store.get(editing.id) : undefined
  const dirty = !!editing && JSON.stringify(saved) !== JSON.stringify(editing)
  const done = jobs.filter((j) => j.result)

  const matches = useMemo(() => {
    const m = new Map<string, number>()
    for (const j of done) {
      const hit = matchSupplierTemplate(j.result!, store.supplierTemplates)
      if (hit) m.set(hit.template.id, (m.get(hit.template.id) ?? 0) + 1)
    }
    return m
  }, [done, store.supplierTemplates])

  const open = (t: Template) => {
    setTab(t.kind)
    setEditing(structuredClone(t))
  }
  const close = () => {
    if (dirty && !confirm('Discard the changes to this template?')) return
    setEditing(null)
  }
  const exportTemplateFile = (t: Template) => download(`${t.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.template.json`, JSON.stringify(t, null, 2), 'application/json')

  if (editing) {
    const builtin = isBuiltin(editing)
    return (
      <main className="templates">
        <header className="tpl-head">
          <button onClick={close}>← All templates</button>
          <h2>
            {builtin ? 'Built-in template' : saved ? 'Edit template' : 'New template'} <span className="muted">· {editing.kind === 'export' ? 'export' : 'supplier'}</span>
          </h2>
          <span className="spacer" />
          {builtin ? (
            <button className="primary" onClick={() => setEditing(forkOf(editing))}>
              Fork to customize
            </button>
          ) : (
            <>
              {dirty && <span className="muted small">Unsaved changes</span>}
              <button
                className="primary"
                disabled={!dirty}
                onClick={() => {
                  setEditing(store.save(editing))
                  setMessage(`Saved "${editing.name}".`)
                }}
              >
                Save
              </button>
            </>
          )}
        </header>
        {builtin && <p className="tpl-note">Built-in templates can&apos;t be changed. Fork this one to make your own copy, then edit it.</p>}
        <fieldset className="tpl-body" disabled={builtin}>
          {editing.kind === 'export' ? (
            <ExportEditor draft={editing} onChange={setEditing} docs={docs} />
          ) : (
            <SupplierEditor draft={editing} onChange={setEditing} jobs={jobs} previewId={previewId} onPreview={setPreviewId} exportTemplates={store.exportTemplates} />
          )}
        </fieldset>
        {message && (
          <div className="toast" onAnimationEnd={() => setMessage(null)}>
            {message}
          </div>
        )}
      </main>
    )
  }

  const list: Template[] = tab === 'export' ? store.exportTemplates : store.supplierTemplates
  return (
    <main className="templates">
      <header className="tpl-head">
        <nav className="tabs tpl-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'export'} className={tab === 'export' ? 'tab is-on' : 'tab'} onClick={() => setTab('export')}>
            Export templates <span className="badge">{store.exportTemplates.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'supplier'} className={tab === 'supplier' ? 'tab is-on' : 'tab'} onClick={() => setTab('supplier')}>
            Supplier templates <span className="badge">{store.supplierTemplates.length}</span>
          </button>
        </nav>
        <span className="spacer" />
        <button onClick={() => file.current?.click()}>Import…</button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            const n = store.importJson(await f.text())
            setMessage(n ? `Imported ${n} template${n === 1 ? '' : 's'}.` : 'That file holds no template this app can read.')
          }}
        />
        <button className="primary" onClick={() => open(tab === 'export' ? blankExport() : blankSupplier())}>
          New {tab} template
        </button>
      </header>
      <p className="tpl-intro">
        {tab === 'export'
          ? 'An export template decides where the extracted data goes: which values, in which columns, as Excel, CSV or JSON. Use one as it is, or fork it and change it.'
          : 'A supplier template holds what one supplier’s invoices need: its own labels, boxes on its layout, fixed facts such as its legal name, and the export its invoices go to. It is applied automatically to that supplier’s invoices. Values it supplies are never marked verified.'}{' '}
        Your templates are saved in this browser.
      </p>
      <div className="cards">
        {list.map((t) => {
          const mine = !isBuiltin(t)
          const isDefault = t.kind === 'export' && store.defaultExport === t.id
          return (
            <article key={t.id} className={`card${isDefault ? ' is-default' : ''}`}>
              <div className="card-top">
                <h3 dir="auto">{t.name}</h3>
                <span className={mine ? 'tag tag-mine' : 'tag'}>{mine ? 'Mine' : 'Built-in'}</span>
              </div>
              <p className="card-desc" dir="auto">
                {t.description || <span className="muted">No description.</span>}
              </p>
              <div className="card-meta">
                {t.kind === 'export' ? (
                  <>
                    <span className="tag">{(t as ExportTemplate).format.toUpperCase()}</span>
                    <span className="tag">{(t as ExportTemplate).rows === 'line' ? 'per line item' : 'per invoice'}</span>
                    <span className="tag">{(t as ExportTemplate).columns.length} columns</span>
                    {isDefault && <span className="tag tag-default">Default</span>}
                  </>
                ) : (
                  <>
                    <span className="tag">{[...(t as SupplierTemplate).match.taxIds, ...(t as SupplierTemplate).match.names].slice(0, 2).join(' · ') || 'no match rule'}</span>
                    {matches.get(t.id) ? <span className="tag tag-default">applies to {matches.get(t.id)} of your invoices</span> : null}
                  </>
                )}
                {t.forkedFrom && <span className="tag">forked from {store.get(t.forkedFrom)?.name ?? 'a template'}</span>}
              </div>
              <div className="card-actions">
                {t.kind === 'export' && !isDefault && <button onClick={() => store.setDefaultExport(t.id)}>Make default</button>}
                <button onClick={() => open(mine ? t : forkOf(t))}>{mine ? 'Edit' : 'Fork'}</button>
                {!mine && <button onClick={() => open(t)}>View</button>}
                {mine && <button onClick={() => open(forkOf(t))}>Fork</button>}
                <button title="Download as a file you can share or import elsewhere" onClick={() => exportTemplateFile(t)}>
                  Download
                </button>
                {mine && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm(`Delete "${t.name}"?`)) store.remove(t.id)
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
      {message && (
        <div className="toast" onAnimationEnd={() => setMessage(null)}>
          {message}
        </div>
      )}
    </main>
  )
}
