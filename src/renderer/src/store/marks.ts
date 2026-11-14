/**
 * «Карандаш» (pencil marks): the drawing mode and the selected mark. The marks themselves live in
 * the document (doc.annotations, undoable); this store is view state only.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { markBadge, newId, nextMarkNumber } from '@core'
import type { Annotation, Id, Vec2 } from '@core/types'
import { docStore } from './document'

export type PencilShape = 'free' | 'lasso' | 'rect'

export interface MarksState {
  shape: PencilShape
  selected: Id | null
  setShape(s: PencilShape): void
  select(id: Id | null): void
}

export const marksStore = createStore<MarksState>()((set) => ({
  shape: 'free',
  selected: null,
  setShape: (shape) => set({ shape }),
  select: (selected) => set({ selected }),
}))

export function useMarks<T>(selector: (s: MarksState) => T): T {
  return useStore(marksStore, selector)
}

export function getMark(id: Id | null | undefined): Annotation | undefined {
  return id ? docStore.getState().doc.annotations?.[id] : undefined
}

/** adds a mark (undoable) and selects it */
export function addMark(levelId: Id, shape: Annotation['shape'], points: Vec2[]): Id {
  const id = newId('pm')
  const n = nextMarkNumber(docStore.getState().doc)
  docStore.getState().transact(`Пометка ${markBadge(n)}`, (d) => {
    ;(d.annotations ??= {})[id] = { id, levelId, n, shape, points: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) }
  })
  marksStore.getState().select(id)
  return id
}

export function deleteMark(id: Id): void {
  const m = getMark(id)
  if (!m) return
  docStore.getState().transact(`Удалить пометку ${markBadge(m.n)}`, (d) => {
    if (d.annotations) delete d.annotations[id]
    if (d.annotations && !Object.keys(d.annotations).length) delete d.annotations
  })
  if (marksStore.getState().selected === id) marksStore.getState().select(null)
}

/** «Очистить пометки» on a level */
export function clearMarks(levelId: Id): void {
  const all = docStore.getState().doc.annotations
  if (!all || !Object.values(all).some((m) => m.levelId === levelId)) return
  docStore.getState().transact('Очистить пометки', (d) => {
    for (const id in d.annotations ?? {}) if (d.annotations![id].levelId === levelId) delete d.annotations![id]
    if (d.annotations && !Object.keys(d.annotations).length) delete d.annotations
  })
  marksStore.getState().select(null)
}

export function marksOnLevel(levelId: Id): Annotation[] {
  return Object.values(docStore.getState().doc.annotations ?? {})
    .filter((m) => m.levelId === levelId)
    .sort((a, b) => a.n - b.n)
}
