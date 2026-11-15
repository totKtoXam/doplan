/**
 * UI side of the object-kind registry (@core/layers): the icon of a kind and, for kinds that are not
 * selected through `uiStore.selection` (pencil marks), how the layers panel reads and changes their
 * selection. A module that registers its own kind with `registerEntityKind` may call
 * `registerKindIcon` / `registerKindSelection` from its renderer code; without them the panel uses
 * a generic icon and `uiStore.selection`.
 */
import {
  BrickWall,
  Box,
  DoorOpen,
  Image,
  Lightbulb,
  Pencil,
  Ruler,
  Sofa,
  SquareDashed,
  Type,
  type LucideIcon,
} from 'lucide-react'
import type { Id } from '@core/types'
import { marksStore } from '@/store/marks'

const ICONS = new Map<string, LucideIcon>([
  ['brick-wall', BrickWall],
  ['square-dashed', SquareDashed],
  ['door-open', DoorOpen],
  ['sofa', Sofa],
  ['lightbulb', Lightbulb],
  ['image', Image],
  ['pencil', Pencil],
  ['ruler', Ruler],
  ['type', Type],
])

/** an icon for the `icon` id of a kind definition (lucide kebab-case name) */
export function registerKindIcon(icon: string, component: LucideIcon): void {
  ICONS.set(icon, component)
}

export function kindIcon(icon: string): LucideIcon {
  return ICONS.get(icon) ?? Box
}

/** selection of a kind kept outside `uiStore.selection` */
export interface KindSelection {
  /** ids selected now */
  selected(): Id[]
  /** replace (additive = false) or toggle (additive = true) the selection of these ids */
  select(ids: Id[], additive: boolean): void
  /** notifies when the selection changes; returns unsubscribe */
  subscribe(cb: () => void): () => void
}

const SELECTIONS = new Map<string, KindSelection>()

export function registerKindSelection(kind: string, sel: KindSelection): void {
  SELECTIONS.set(kind, sel)
  if (listeners.size) unsubs.push(sel.subscribe(notify))
  notify()
}

function notify(): void {
  version++
  for (const l of listeners) l()
}

export function kindSelection(kind: string): KindSelection | undefined {
  return SELECTIONS.get(kind)
}

export function customSelections(): ReadonlyMap<string, KindSelection> {
  return SELECTIONS
}

let version = 0
const listeners = new Set<() => void>()
let unsubs: (() => void)[] = []

/** useSyncExternalStore pair over every custom selection */
export function subscribeCustomSelection(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    unsubs = [...SELECTIONS.values()].map((s) => s.subscribe(notify))
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      for (const u of unsubs) u()
      unsubs = []
    }
  }
}

export function customSelectionVersion(): number {
  return version
}

// pencil marks: one selected mark at a time (marksStore)
registerKindSelection('annotation', {
  selected: () => {
    const id = marksStore.getState().selected
    return id ? [id] : []
  },
  select: (ids, additive) => {
    const cur = marksStore.getState().selected
    if (additive) {
      if (cur && ids.includes(cur)) marksStore.getState().select(null)
      else if (ids.length) marksStore.getState().select(ids[ids.length - 1])
      return
    }
    marksStore.getState().select(ids.length ? ids[ids.length - 1] : null)
  },
  subscribe: (cb) => marksStore.subscribe((s, p) => s.selected !== p.selected && cb()),
})
