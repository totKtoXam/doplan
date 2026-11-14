import { useMemo } from 'react'
import { create } from 'zustand'
import type { Asset, Catalog, Doc, Hdri, Id, Material } from '@core/types'
import { builtinCatalog, mergeCatalog } from '@core'
import { docStore, useDoc } from '@/store/document'
import { t } from '@/i18n'
import { uiStore, useUi } from '@/store/ui'

// ───────────────────────────── transactions ─────────────────────────────

/** the single entry point for document edits from the panels */
export function tx(label: string, fn: (draft: Doc) => void, merge?: string): void {
  docStore.getState().transact(label, fn, merge ? { merge } : undefined)
}

// ───────────────────────────── catalog lookups ─────────────────────────────

let builtinCache: Catalog | null = null
export function builtins(): Catalog {
  if (!builtinCache) builtinCache = builtinCatalog()
  return builtinCache
}

function dedupe<T extends { id: Id }>(...lists: T[][]): T[] {
  const seen = new Set<Id>()
  const out: T[] = []
  for (const list of lists)
    for (const e of list) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      out.push(e)
    }
  return out
}

/** project-local materials first, then the loaded catalog, then builtins */
export function useAllMaterials(): Material[] {
  const docMats = useDoc((s) => s.doc.materials)
  const catMats = useUi((s) => s.catalog.materials)
  return useMemo(() => dedupe(Object.values(docMats ?? {}), catMats ?? [], builtins().materials), [docMats, catMats])
}

export function useAllAssets(): Asset[] {
  const docAssets = useDoc((s) => s.doc.assets)
  const catAssets = useUi((s) => s.catalog.assets)
  return useMemo(() => dedupe(Object.values(docAssets ?? {}), catAssets ?? [], builtins().assets), [docAssets, catAssets])
}

export function useAllHdris(): Hdri[] {
  const h = useUi((s) => s.catalog.hdris)
  return useMemo(() => dedupe(h ?? [], builtins().hdris ?? []), [h])
}

export function useMaterialMap(): Map<Id, Material> {
  const all = useAllMaterials()
  return useMemo(() => new Map(all.map((m) => [m.id, m])), [all])
}

export function useAssetMap(): Map<Id, Asset> {
  const all = useAllAssets()
  return useMemo(() => new Map(all.map((m) => [m.id, m])), [all])
}

/** non-reactive lookups (event handlers) */
export function lookupMaterial(id: Id | undefined): Material | undefined {
  if (!id) return undefined
  return (
    docStore.getState().doc.materials?.[id] ??
    uiStore.getState().getMaterial(id) ??
    builtins().materials.find((m) => m.id === id)
  )
}

export function lookupAsset(id: Id | undefined): Asset | undefined {
  if (!id) return undefined
  return docStore.getState().doc.assets?.[id] ?? uiStore.getState().getAsset(id) ?? builtins().assets.find((a) => a.id === id)
}

export function displayName(e: { name: string; nameRu?: string } | undefined, lang: 'ru' | 'en'): string {
  if (!e) return '—'
  return lang === 'ru' ? (e.nameRu ?? e.name) : e.name
}

export function useLang(): 'ru' | 'en' {
  return useUi((s) => s.lang)
}

export async function refreshCatalog(): Promise<void> {
  const loaded = await window.doplan.catalog.load()
  uiStore.getState().setCatalog(mergeCatalog(builtins(), loaded))
}

// ───────────────────────────── favourites & recents (per user, localStorage) ─────────────────────────────

type PrefKind = 'asset' | 'material'
interface PrefsState {
  favorites: Record<PrefKind, Id[]>
  recents: Record<PrefKind, Id[]>
  toggleFavorite(kind: PrefKind, id: Id): void
  pushRecent(kind: PrefKind, id: Id): void
}

const PREFS_KEY = 'doplan.panels.prefs.v1'

function loadPrefs(): Pick<PrefsState, 'favorites' | 'recents'> {
  const empty = { favorites: { asset: [], material: [] }, recents: { asset: [], material: [] } }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return empty
    const p = JSON.parse(raw) as Partial<Pick<PrefsState, 'favorites' | 'recents'>>
    return {
      favorites: { asset: p.favorites?.asset ?? [], material: p.favorites?.material ?? [] },
      recents: { asset: p.recents?.asset ?? [], material: p.recents?.material ?? [] },
    }
  } catch {
    return empty
  }
}

function savePrefs(s: Pick<PrefsState, 'favorites' | 'recents'>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ favorites: s.favorites, recents: s.recents }))
  } catch {
    /* storage unavailable: preferences stay in memory */
  }
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...loadPrefs(),
  toggleFavorite(kind, id) {
    const cur = get().favorites[kind]
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur]
    set({ favorites: { ...get().favorites, [kind]: next } })
    savePrefs(get())
  },
  pushRecent(kind, id) {
    const cur = get().recents[kind].filter((x) => x !== id)
    set({ recents: { ...get().recents, [kind]: [id, ...cur].slice(0, 24) } })
    savePrefs(get())
  },
}))

// ───────────────────────────── on-demand downloads ─────────────────────────────

interface DownloadState {
  progress: Record<Id, { done: number; total: number }>
  errors: Record<Id, string>
}

export const useDownloads = create<DownloadState>(() => ({ progress: {}, errors: {} }))

let progressUnsub: (() => void) | null = null
function ensureProgressListener() {
  if (progressUnsub) return
  progressUnsub = window.doplan.catalog.onProgress((p) => {
    const st = useDownloads.getState()
    if (!(p.id in st.progress)) return
    useDownloads.setState({ progress: { ...st.progress, [p.id]: { done: p.done, total: p.total } } })
  })
}

/** downloads a remote catalog entry into the user library and refreshes the catalog */
export async function downloadEntry(kind: 'asset' | 'material' | 'hdri', id: Id): Promise<Asset | Material | Hdri | null> {
  ensureProgressListener()
  const st = useDownloads.getState()
  if (id in st.progress) return null
  const errors = { ...st.errors }
  delete errors[id]
  useDownloads.setState({ progress: { ...st.progress, [id]: { done: 0, total: 0 } }, errors })
  try {
    const entry = await window.doplan.catalog.download(kind, id)
    await refreshCatalog()
    return entry
  } catch (e) {
    useDownloads.setState({ errors: { ...useDownloads.getState().errors, [id]: e instanceof Error ? e.message : String(e) } })
    return null
  } finally {
    const p = { ...useDownloads.getState().progress }
    delete p[id]
    useDownloads.setState({ progress: p })
  }
}

export function progressFraction(p: { done: number; total: number } | undefined): number | null {
  if (!p) return null
  return p.total > 0 ? Math.min(1, p.done / p.total) : 0
}

// ───────────────────────────── misc helpers ─────────────────────────────

/** message of an error; known Russian texts (e.g. the web-build fallbacks in store/api) are translated */
export function errorText(e: unknown): string {
  return t(e instanceof Error ? e.message : String(e))
}

export async function blobToArrayBuffer(b: Blob): Promise<ArrayBuffer> {
  return b.arrayBuffer()
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function mimeOf(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'gif':
      return 'image/gif'
    default:
      return 'application/octet-stream'
  }
}

/** downloads text through a save dialog */
export async function saveText(name: string, ext: string, label: string, content: string) {
  return window.doplan.files.saveText(name, [{ name: label, extensions: [ext] }], content)
}
