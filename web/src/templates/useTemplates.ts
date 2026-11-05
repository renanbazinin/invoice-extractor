import { useCallback, useEffect, useMemo, useState } from 'react'
import { BUILTIN_TEMPLATES, DEFAULT_OPTIONS, isBuiltin } from '../../../src/templates'
import type { ExportTemplate, SupplierTemplate, Template } from '../../../src/templates'

/**
 * The template store: the built-in templates plus the user's own, kept in this browser's local
 * storage (nothing leaves the browser). A user template with the id of a built-in one never
 * exists: forking always makes a new id.
 */
const KEY = 'invoice-extractor.templates.v1'
const SETTINGS = 'invoice-extractor.settings.v1'

interface Settings {
  defaultExport: string
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked (private window): templates last for this visit only.
  }
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Checks a parsed object is a template this app can use, filling options added later. */
export function asTemplate(x: unknown): Template | null {
  const t = x as Partial<Template> | null
  if (!t || typeof t !== 'object' || typeof t.name !== 'string') return null
  if (t.kind === 'export') {
    const e = t as Partial<ExportTemplate>
    if (!Array.isArray(e.columns) || !['csv', 'xlsx', 'json'].includes(e.format ?? '') || !['invoice', 'line'].includes(e.rows ?? '')) return null
    return { ...(e as ExportTemplate), description: e.description ?? '', options: { ...DEFAULT_OPTIONS, ...e.options } }
  }
  if (t.kind === 'supplier') {
    const s = t as Partial<SupplierTemplate>
    return {
      ...(s as SupplierTemplate),
      description: s.description ?? '',
      match: { taxIds: s.match?.taxIds ?? [], names: s.match?.names ?? [] },
      fixed: s.fixed ?? {},
      labels: s.labels ?? [],
      regions: s.regions ?? [],
      exportTemplateId: s.exportTemplateId ?? null,
    }
  }
  return null
}

export function blankExport(): ExportTemplate {
  return { id: newId(), kind: 'export', name: 'My export', description: '', format: 'xlsx', rows: 'invoice', columns: [], options: { ...DEFAULT_OPTIONS } }
}

export function blankSupplier(): SupplierTemplate {
  return { id: newId(), kind: 'supplier', name: 'My supplier', description: '', match: { taxIds: [], names: [] }, fixed: {}, labels: [], regions: [], exportTemplateId: null }
}

export function forkOf<T extends Template>(t: T): T {
  return { ...structuredClone(t), id: newId(), name: `${t.name} (copy)`, forkedFrom: t.id, updated: new Date().toISOString() }
}

export interface TemplateStore {
  /** User templates first, then the built-in ones (a user template wins a supplier match). */
  all: Template[]
  exportTemplates: ExportTemplate[]
  supplierTemplates: SupplierTemplate[]
  get(id: string | null | undefined): Template | undefined
  /** Saves a user template and returns it as stored (with its save time). */
  save<T extends Template>(t: T): T
  remove(id: string): void
  /** Adds templates from a file's contents; returns how many were added. */
  importJson(text: string): number
  defaultExport: string
  setDefaultExport(id: string): void
}

export function useTemplates(): TemplateStore {
  const [mine, setMine] = useState<Template[]>(() => read<unknown[]>(KEY, []).map(asTemplate).filter((t): t is Template => !!t && !isBuiltin(t)))
  const [settings, setSettings] = useState<Settings>(() => read<Settings>(SETTINGS, { defaultExport: 'builtin:summary-xlsx' }))
  useEffect(() => write(KEY, mine), [mine])
  useEffect(() => write(SETTINGS, settings), [settings])

  const all = useMemo(() => [...mine, ...BUILTIN_TEMPLATES], [mine])
  const get = useCallback((id: string | null | undefined) => (id ? all.find((t) => t.id === id) : undefined), [all])
  const save = useCallback(<T extends Template>(t: T): T => {
    if (isBuiltin(t)) return t
    const stamped = { ...t, updated: new Date().toISOString() }
    setMine((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? stamped : x)) : [stamped, ...ts]))
    return stamped
  }, [])
  const remove = useCallback((id: string) => setMine((ts) => ts.filter((t) => t.id !== id)), [])
  const importJson = useCallback((text: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return 0
    }
    const list = (Array.isArray(parsed) ? parsed : [parsed]).map(asTemplate).filter((t): t is Template => !!t)
    // Imported templates are the user's own copies, with fresh ids.
    const added = list.map((t) => ({ ...t, id: newId(), forkedFrom: t.forkedFrom ?? (isBuiltin(t) ? t.id : undefined), updated: new Date().toISOString() }))
    setMine((ts) => [...added, ...ts])
    return added.length
  }, [])

  const defaultExport = get(settings.defaultExport)?.kind === 'export' ? settings.defaultExport : 'builtin:summary-xlsx'
  return {
    all,
    exportTemplates: all.filter((t): t is ExportTemplate => t.kind === 'export'),
    supplierTemplates: all.filter((t): t is SupplierTemplate => t.kind === 'supplier'),
    get,
    save,
    remove,
    importJson,
    defaultExport,
    setDefaultExport: (id) => setSettings((s) => ({ ...s, defaultExport: id })),
  }
}
