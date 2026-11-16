/**
 * Window layout remembered between launches (per user, not in the document): the widths of the
 * resizable panels, whether the side panels are open and the 2D|3D split. Kept in localStorage.
 *
 * Every resizable panel registers its limits in PANELS; a new panel only needs an entry there.
 */
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { sanitizeSize } from '@/ui/kit/sashMath'
import { uiStore } from './ui'

export interface PanelSpec {
  defaultSize: number
  minSize: number
  maxSize: number
}

export const PANELS = {
  /** left dock: catalogue (construction, furniture, materials, styles, lights) */
  left: { defaultSize: 300, minSize: 220, maxSize: 640 },
  /** right dock: «Свойства | ИИ» */
  right: { defaultSize: 320, minSize: 260, maxSize: 900 },
  /** «Рендер и освещение» drawer */
  render: { defaultSize: 384, minSize: 320, maxSize: 760 },
} as const satisfies Record<string, PanelSpec>

export type PanelId = keyof typeof PANELS

/** the 2D|3D split: share of the 2D view, and the least width each view keeps */
export const SPLIT = { defaultRatio: 0.5, minPx: 200 } as const

/**
 * A floating panel or dialog the user resized: only the axes they dragged are kept, the other
 * one stays automatic. Keyed by a stable name given by the caller (`float.*`, `dialog.*`).
 */
export interface BoxSize {
  w?: number
  h?: number
}

/** stored box sizes are checked against these bounds when read back */
const BOX_BOUNDS = { min: 80, max: 6000 }

interface LayoutState {
  sizes: Record<PanelId, number>
  setSize(id: PanelId, size: number): void
  boxes: Record<string, BoxSize>
  /** null forgets the size (double click on a frame edge) */
  setBox(key: string, size: BoxSize | null): void
}

const KEY = 'doplan.layout'

interface Saved {
  sizes?: Partial<Record<PanelId, unknown>>
  leftOpen?: unknown
  rightOpen?: unknown
  split?: unknown
  boxes?: unknown
}

function read(): Saved {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const v: unknown = raw ? JSON.parse(raw) : null
    return v && typeof v === 'object' ? (v as Saved) : {}
  } catch {
    return {}
  }
}

const saved = read()

function initialSizes(): Record<PanelId, number> {
  const out = {} as Record<PanelId, number>
  for (const id of Object.keys(PANELS) as PanelId[]) {
    const p = PANELS[id]
    out[id] = sanitizeSize(saved.sizes?.[id], p.defaultSize, { min: p.minSize, max: p.maxSize })
  }
  return out
}

function cleanBox(v: unknown): BoxSize | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const out: BoxSize = {}
  for (const k of ['w', 'h'] as const) {
    const n = o[k]
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = Math.round(Math.min(BOX_BOUNDS.max, Math.max(BOX_BOUNDS.min, n)))
  }
  return out.w === undefined && out.h === undefined ? null : out
}

function initialBoxes(): Record<string, BoxSize> {
  const out: Record<string, BoxSize> = {}
  if (saved.boxes && typeof saved.boxes === 'object') {
    for (const [k, v] of Object.entries(saved.boxes as Record<string, unknown>)) {
      const b = cleanBox(v)
      if (b) out[k] = b
    }
  }
  return out
}

export const layoutStore = createStore<LayoutState>()((set) => ({
  sizes: initialSizes(),
  setSize: (id, size) => {
    const p = PANELS[id]
    set((s) => ({ sizes: { ...s.sizes, [id]: sanitizeSize(size, p.defaultSize, { min: p.minSize, max: p.maxSize }) } }))
  },
  boxes: initialBoxes(),
  setBox: (key, size) =>
    set((s) => {
      const boxes = { ...s.boxes }
      const b = size && cleanBox({ ...s.boxes[key], ...size })
      if (b) boxes[key] = b
      else delete boxes[key]
      return { boxes }
    }),
}))

export const useLayout = <T>(sel: (s: LayoutState) => T): T => useStore(layoutStore, sel)

/** the props a ResizablePanel needs for a registered panel's size */
export function usePanelSize(id: PanelId) {
  const size = useLayout((s) => s.sizes[id])
  return { ...PANELS[id], size, onSizeChange: (v: number) => layoutStore.getState().setSize(id, v) }
}

/** the remembered size of a resizable box and its setter (no key: not resizable, nothing kept) */
export function useBoxSize(key: string | undefined): { size: BoxSize | undefined; set(size: BoxSize | null): void } {
  const size = useLayout((s) => (key ? s.boxes[key] : undefined))
  return {
    size,
    set: (v) => {
      if (key) layoutStore.getState().setBox(key, v)
    },
  }
}

export function clampRatio(r: unknown): number {
  return typeof r === 'number' && Number.isFinite(r) ? Math.min(0.9, Math.max(0.1, r)) : SPLIT.defaultRatio
}

// open flags and the split live in the UI store (other modules open the right panel); restore them
// once and remember changes
{
  const patch: Partial<{ leftPanelOpen: boolean; rightPanelOpen: boolean; splitRatio: number }> = {}
  if (typeof saved.leftOpen === 'boolean') patch.leftPanelOpen = saved.leftOpen
  if (typeof saved.rightOpen === 'boolean') patch.rightPanelOpen = saved.rightOpen
  if (saved.split !== undefined) patch.splitRatio = clampRatio(saved.split)
  if (Object.keys(patch).length) uiStore.setState(patch)
}

let timer: ReturnType<typeof setTimeout> | null = null
function save(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const ui = uiStore.getState()
    try {
      globalThis.localStorage?.setItem(
        KEY,
        JSON.stringify({ sizes: layoutStore.getState().sizes, boxes: layoutStore.getState().boxes, leftOpen: ui.leftPanelOpen, rightOpen: ui.rightPanelOpen, split: ui.splitRatio }),
      )
    } catch {
      /* private mode / quota: keep in memory */
    }
  }, 200)
}

layoutStore.subscribe(save)
uiStore.subscribe((s, p) => {
  if (s.leftPanelOpen !== p.leftPanelOpen || s.rightPanelOpen !== p.rightPanelOpen || s.splitRatio !== p.splitRatio) save()
})
