/**
 * «Карандаш» (pencil marks): the drawing mode and the selected mark. The marks themselves live in
 * the document (doc.annotations, undoable); this store is view state only.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { isHidden, isLocked, markBadge, newId, nextMarkNumber } from '@core'
import type { Annotation, Id, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from './document'
import { toast } from './notify'

export type PencilShape = 'free' | 'lasso' | 'rect'

export interface MarksState {
  shape: PencilShape
  selected: Id | null
  /** the mini «what to do here?» field next to a mark just drawn (client px) */
  prompt: { id: Id; x: number; y: number } | null
  setShape(s: PencilShape): void
  select(id: Id | null): void
  setPrompt(p: { id: Id; x: number; y: number } | null): void
}

export const marksStore = createStore<MarksState>()((set) => ({
  shape: 'free',
  selected: null,
  prompt: null,
  setShape: (shape) => set({ shape }),
  select: (selected) => set({ selected }),
  setPrompt: (prompt) => set({ prompt }),
}))

/** numbers already taken outside the document (marks drawn on chat images), so ①② never repeat */
let takenElsewhere: () => number = () => 0
export function setMarkNumberFloor(fn: () => number): void {
  takenElsewhere = fn
}

export function useMarks<T>(selector: (s: MarksState) => T): T {
  return useStore(marksStore, selector)
}

export function getMark(id: Id | null | undefined): Annotation | undefined {
  return id ? docStore.getState().doc.annotations?.[id] : undefined
}

/** adds a mark (undoable) and selects it */
export function addMark(levelId: Id, shape: Annotation['shape'], points: Vec2[]): Id {
  const id = newId('pm')
  const n = Math.max(nextMarkNumber(docStore.getState().doc), takenElsewhere() + 1)
  docStore.getState().transact(t('Пометка {n}', { n: markBadge(n) }), (d) => {
    ;(d.annotations ??= {})[id] = { id, levelId, n, shape, points: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) }
  })
  marksStore.getState().select(id)
  return id
}

export function deleteMark(id: Id): void {
  const m = getMark(id)
  if (!m) return
  // locked in the layers panel: kept
  if (isLocked(docStore.getState().doc, { kind: 'annotation', id })) {
    toast(t('Пометка заблокирована'), 'warning')
    return
  }
  docStore.getState().transact(t('Удалить пометку {n}', { n: markBadge(m.n) }), (d) => {
    if (d.annotations) delete d.annotations[id]
    if (d.annotations && !Object.keys(d.annotations).length) delete d.annotations
  })
  if (marksStore.getState().selected === id) marksStore.getState().select(null)
}

/** «Очистить пометки» on a level: the visible, unlocked marks (layers panel) */
export function clearMarks(levelId: Id): void {
  const doc = docStore.getState().doc
  const all = doc.annotations
  const kept = (id: Id) => isLocked(doc, { kind: 'annotation', id }) || isHidden(doc, { kind: 'annotation', id })
  const ids = Object.values(all ?? {}).filter((m) => m.levelId === levelId && !kept(m.id)).map((m) => m.id)
  if (!ids.length) return
  docStore.getState().transact(t('Очистить пометки'), (d) => {
    for (const id of ids) if (d.annotations) delete d.annotations[id]
    if (d.annotations && !Object.keys(d.annotations).length) delete d.annotations
  })
  const sel = marksStore.getState().selected
  if (sel && ids.includes(sel)) marksStore.getState().select(null)
}

export function marksOnLevel(levelId: Id): Annotation[] {
  return Object.values(docStore.getState().doc.annotations ?? {})
    .filter((m) => m.levelId === levelId)
    .sort((a, b) => a.n - b.n)
}
