/**
 * Theme store: the active colour theme, the preferred dark and light themes (the sun/moon toggle
 * switches between them) and the themes the user installed. Kept in localStorage so the colours
 * are right before the first paint; uiStore.theme follows the kind (dark/light) of the theme.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { setActivePalette } from '@/editor2d/theme'
import { uiStore } from '@/store/ui'
import { BUILTIN_THEMES, DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from './builtin'
import { resolveTheme, themeKind, UI_TOKENS, type ResolvedTheme, type ThemeKind, type ThemeSource } from './themes'

const KEY = 'doplan.themes'

interface Saved {
  activeId: string
  preferred: Record<ThemeKind, string>
  custom: ThemeSource[]
}

export interface ThemeState extends Saved {
  resolved: ResolvedTheme
  all(): ThemeSource[]
  select(id: string): void
  /** adds or replaces (same id) installed themes */
  install(themes: ThemeSource[]): void
  remove(id: string): void
}

function load(): Saved {
  const def: Saved = { activeId: DEFAULT_DARK_ID, preferred: { dark: DEFAULT_DARK_ID, light: DEFAULT_LIGHT_ID }, custom: [] }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return def
    const s = JSON.parse(raw) as Partial<Saved>
    return {
      activeId: typeof s.activeId === 'string' ? s.activeId : def.activeId,
      preferred: { ...def.preferred, ...(s.preferred ?? {}) },
      custom: Array.isArray(s.custom) ? s.custom.filter((t) => t && typeof t.id === 'string' && t.colors) : [],
    }
  } catch {
    return def
  }
}

const allOf = (custom: ThemeSource[]) => [...BUILTIN_THEMES, ...custom]
const find = (id: string, custom: ThemeSource[]) => allOf(custom).find((t) => t.id === id)

function resolve(id: string, custom: ThemeSource[]): ResolvedTheme {
  const all = allOf(custom)
  const t = find(id, custom) ?? all[0]
  return resolveTheme(t, all)
}

const DEFAULT_OF: Record<ThemeKind, string> = { dark: DEFAULT_DARK_ID, light: DEFAULT_LIGHT_ID }

/** the kind of a theme among these installed ones (an overlay's kind follows its parent) */
function kindIn(id: string, custom: ThemeSource[]): ThemeKind | undefined {
  const t = find(id, custom)
  return t ? themeKind(t, allOf(custom)) : undefined
}

/**
 * The preferred dark and light themes after the installed themes changed: one that is gone or now of
 * the other kind (reinstalled with another "type", or an overlay whose parent changed) gives way to
 * the default; the theme in use is the preferred one of its kind.
 */
function settle(p: Record<ThemeKind, string>, custom: ThemeSource[], resolved: ResolvedTheme): Record<ThemeKind, string> {
  const keep = (kind: ThemeKind) => (kindIn(p[kind], custom) === kind ? p[kind] : DEFAULT_OF[kind])
  return { dark: keep('dark'), light: keep('light'), [resolved.kind]: resolved.id }
}

const saved = load()

export const themeStore = createStore<ThemeState>()((set, get) => ({
  ...saved,
  resolved: resolve(saved.activeId, saved.custom),
  all: () => allOf(get().custom),
  select(id) {
    const t = find(id, get().custom)
    if (!t) return
    const resolved = resolve(id, get().custom)
    set({ activeId: id, preferred: { ...get().preferred, [resolved.kind]: id }, resolved })
  },
  install(themes) {
    const ids = new Set(themes.map((t) => t.id))
    const custom = [...get().custom.filter((t) => !ids.has(t.id)), ...themes]
    const resolved = resolve(get().activeId, custom)
    set({ custom, preferred: settle(get().preferred, custom, resolved), resolved })
  },
  remove(id) {
    const s = get()
    const custom = s.custom.filter((t) => t.id !== id)
    // removing the theme in use falls back to the default of its kind
    const activeId = s.activeId === id || !find(s.activeId, custom) ? DEFAULT_OF[s.resolved.kind] : s.activeId
    const resolved = resolve(activeId, custom)
    set({ custom, activeId, preferred: settle(s.preferred, custom, resolved), resolved })
  },
}))

export const useTheme = <T>(sel: (s: ThemeState) => T): T => useStore(themeStore, sel)

function apply(r: ResolvedTheme): void {
  setActivePalette(r.kind, r.plan)
  if (typeof document === 'undefined') return
  const el = document.documentElement
  for (const k of UI_TOKENS) el.style.setProperty(`--${k}`, r.ui[k])
  el.dataset.theme = r.kind
  el.style.colorScheme = r.kind
  if (uiStore.getState().theme !== r.kind) uiStore.getState().setTheme(r.kind)
}

apply(themeStore.getState().resolved)

themeStore.subscribe((s, prev) => {
  if (s.resolved !== prev.resolved) apply(s.resolved)
  if (s.activeId !== prev.activeId || s.custom !== prev.custom || s.preferred !== prev.preferred) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ activeId: s.activeId, preferred: s.preferred, custom: s.custom }))
    } catch {
      // storage full or blocked: the theme still applies for this session
    }
  }
})

// the dark/light toggle and the setting from main pick the preferred theme of that kind
uiStore.subscribe((s, prev) => {
  if (s.theme === prev.theme) return
  const t = themeStore.getState()
  if (t.resolved.kind === s.theme) return
  const id = t.preferred[s.theme]
  t.select(kindIn(id, t.custom) === s.theme ? id : DEFAULT_OF[s.theme])
})
