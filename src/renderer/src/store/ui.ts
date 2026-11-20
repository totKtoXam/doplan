/**
 * UI store: view mode, tool, selection, tool options, catalog, language/theme (persisted via
 * window.doplan.settings) and live status values. Not undoable.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { builtinCatalog } from '@core'
import type { Asset, Catalog, EntityRef, Hdri, Id, Material, QualityPreset } from '@core/types'
import type { AppSettings } from '@shared/ipc'
import type { UiState } from '@/contracts'
import { api } from './api'
import { bindSelection, docStore } from './document'

/** Extra (non-contract) fields exposed by this store. */
export interface UiStoreState extends UiState {
  /** renderer backend actually in use by the 3D engine ('webgpu' | 'webgl2'), set by Viewport3D */
  backend: string | null
  /** preferred 3D backend (persisted): engines should read this when creating the renderer */
  backendPref: 'webgpu' | 'webgl'
  leftPanelOpen: boolean
  rightPanelOpen: boolean
  /** share of the width taken by the 2D pane in split mode (0..1) */
  splitRatio: number
  /** app settings as last loaded/saved from main */
  appSettings: AppSettings | null
  /** true once boot (settings + catalog + document) has finished */
  booted: boolean
  setLang(lang: 'ru' | 'en'): void
  setTheme(theme: 'dark' | 'light'): void
  setBackendPref(b: 'webgpu' | 'webgl'): void
  setQuality(q: QualityPreset): void
}

interface CatalogIndex {
  materials: Map<Id, Material>
  assets: Map<Id, Asset>
  hdris: Map<Id, Hdri>
}

const indexCache = new WeakMap<Catalog, CatalogIndex>()

function indexOf(c: Catalog): CatalogIndex {
  let idx = indexCache.get(c)
  if (!idx) {
    idx = {
      materials: new Map(c.materials.map((m) => [m.id, m])),
      assets: new Map(c.assets.map((a) => [a.id, a])),
      hdris: new Map(c.hdris.map((h) => [h.id, h])),
    }
    indexCache.set(c, idx)
  }
  return idx
}

function safeBuiltinCatalog(): Catalog {
  try {
    return builtinCatalog()
  } catch (err) {
    console.error('[doplan] builtinCatalog failed', err)
    return { version: 1, materials: [], assets: [], hdris: [] }
  }
}

const firstDoc = docStore.getState().doc

export const uiStore = createStore<UiStoreState>()((set, get) => ({
  mode: '2d',
  tool: 'select',
  activeLevelId: firstDoc.levelOrder[0] ?? '',
  selection: [],
  hover: null,
  wallKind: 'wall',
  wallThickness: firstDoc.settings.wallThickness,
  wallHeight: firstDoc.settings.wallHeight,
  openingKind: 'door',
  openingPreset: null,
  placingAssetId: null,
  paintFinish: null,
  catalog: safeBuiltinCatalog(),
  lang: 'ru',
  theme: 'dark',
  cursor: null,
  hint: '',
  cameraMode: 'orbit',

  backend: null,
  backendPref: 'webgpu',
  leftPanelOpen: true,
  rightPanelOpen: true,
  splitRatio: 0.5,
  appSettings: null,
  booted: false,

  setMode(m) {
    set({ mode: m })
  },
  setTool(t) {
    const patch: Partial<UiStoreState> = { tool: t }
    if (t !== 'item') patch.placingAssetId = null
    set(patch)
  },
  select(refs, additive) {
    if (!additive) {
      set({ selection: dedupe(refs) })
      return
    }
    const cur = get().selection
    const out = [...cur]
    for (const r of refs) {
      const i = out.findIndex((x) => x.kind === r.kind && x.id === r.id)
      if (i >= 0) out.splice(i, 1)
      else out.push(r)
    }
    set({ selection: out })
  },
  clearSelection() {
    if (get().selection.length) set({ selection: [] })
  },
  set(patch) {
    set(patch as Partial<UiStoreState>)
  },
  getMaterial(id) {
    const doc = docStore.getState().doc
    return doc.materials[id] ?? indexOf(get().catalog).materials.get(id)
  },
  getAsset(id) {
    const doc = docStore.getState().doc
    return doc.assets[id] ?? indexOf(get().catalog).assets.get(id)
  },
  getHdri(id) {
    return indexOf(get().catalog).hdris.get(id)
  },
  setCatalog(c) {
    set({ catalog: c })
  },

  setLang(lang) {
    set({ lang })
  },
  setTheme(theme) {
    set({ theme })
  },
  setBackendPref(b) {
    set({ backendPref: b })
    void api.settings
      .set({ backend: b })
      .then((s) => set({ appSettings: s }))
      .catch(() => {})
  },
  setQuality(q) {
    docStore.getState().transact('Качество рендера', (d) => {
      d.render.quality = q
    }, { merge: 'render.quality' })
  },
}))

function dedupe(refs: EntityRef[]): EntityRef[] {
  const seen = new Set<string>()
  const out: EntityRef[] = []
  for (const r of refs) {
    const k = `${r.kind}:${r.id}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push(r)
    }
  }
  return out
}

/** React selector hook over `uiStore`. */
export function useUi<T>(selector: (s: UiStoreState) => T): T {
  return useStore(uiStore, selector)
}

// selection is restored together with undo/redo entries
bindSelection(
  () => uiStore.getState().selection,
  (refs) => uiStore.setState({ selection: refs }),
)

// ───────────── keep UI consistent with the document ─────────────

function entityExists(doc: ReturnType<typeof docStore.getState>['doc'], r: EntityRef): boolean {
  switch (r.kind) {
    case 'node':
      return !!doc.nodes[r.id]
    case 'wall':
      return !!doc.walls[r.id]
    case 'opening':
      return !!doc.openings[r.id]
    case 'room':
      return !!doc.rooms[r.id]
    case 'item':
      return !!doc.items[r.id]
    case 'light':
      return !!doc.lights[r.id]
    case 'electric':
      return !!doc.electrical?.[r.id]
    case 'dimension':
      return !!doc.dimensions[r.id]
    case 'label':
      return !!doc.labels[r.id]
    case 'underlay':
      return !!doc.underlays[r.id]
    default:
      return false
  }
}

docStore.subscribe((s, prev) => {
  if (s.doc === prev.doc) return
  const ui = uiStore.getState()
  const patch: Partial<UiStoreState> = {}
  if (!s.doc.levels[ui.activeLevelId]) patch.activeLevelId = s.doc.levelOrder[0] ?? ''
  if (ui.selection.length) {
    const kept = ui.selection.filter((r) => entityExists(s.doc, r))
    if (kept.length !== ui.selection.length) patch.selection = kept
  }
  if (ui.hover && !entityExists(s.doc, ui.hover)) patch.hover = null
  if (Object.keys(patch).length) uiStore.setState(patch)
})

// ───────────── persistence + theme application ─────────────

function applyTheme(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

function applyLang(lang: 'ru' | 'en'): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang
}

applyTheme(uiStore.getState().theme)
applyLang(uiStore.getState().lang)

// a door preset from the Construction panel applies only while the door tool draws its kind:
// leaving the tool or switching the opening kind drops it
uiStore.subscribe((s) => {
  const p = s.openingPreset
  if (p && (s.tool !== 'door' || s.openingKind !== p.kind)) uiStore.setState({ openingPreset: null })
})

uiStore.subscribe((s, prev) => {
  if (s.theme !== prev.theme) applyTheme(s.theme)
  if (s.lang !== prev.lang) applyLang(s.lang)
  // persist only after boot, so loading settings does not echo them back
  if (!s.booted) return
  const patch: Partial<Pick<AppSettings, 'lang' | 'theme'>> = {}
  if (s.lang !== prev.lang) patch.lang = s.lang
  if (s.theme !== prev.theme) patch.theme = s.theme
  if (patch.lang || patch.theme) {
    void api.settings
      .set(patch)
      .then((saved) => uiStore.setState({ appSettings: saved }))
      .catch((err) => console.warn('[doplan] settings.set failed', err))
  }
})
