/**
 * Accuracy UI state: provenance legend, the «Обмер» checklist panel and the dimension the «Обмер»
 * tool is working on. View-only (not undoable, not in the document); the two toggles persist in
 * localStorage.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { RunEnd } from '@core'

export interface SurveyTarget {
  /** run key `wallId:side` (see core/provenance) */
  key: string
  /** room the run belongs to */
  roomId: string
}

export interface AccuracyState {
  /** provenance legend on the plan */
  legend: boolean
  /** checklist of unmeasured dimensions */
  checklist: boolean
  /** dimension under the pointer in «Обмер» */
  hoverKey: string | null
  /** dimension being measured (input panel open) */
  target: SurveyTarget | null
  /** which end of the target moves */
  moveEnd: RunEnd
  setLegend(v: boolean): void
  setChecklist(v: boolean): void
  setHover(key: string | null): void
  setTarget(t: SurveyTarget | null): void
  setMoveEnd(e: RunEnd): void
}

const KEY = 'doplan.accuracy'

function load(): { legend: boolean; checklist: boolean } {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as { legend?: unknown; checklist?: unknown }
      return { legend: v.legend === true, checklist: v.checklist === true }
    }
  } catch {
    /* storage unavailable */
  }
  return { legend: false, checklist: false }
}

function save(s: { legend: boolean; checklist: boolean }): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ legend: s.legend, checklist: s.checklist }))
  } catch {
    /* storage unavailable */
  }
}

const initial = load()

export const accuracyStore = createStore<AccuracyState>()((set, get) => ({
  legend: initial.legend,
  checklist: initial.checklist,
  hoverKey: null,
  target: null,
  moveEnd: 'b',
  setLegend(v) {
    set({ legend: v })
    save(get())
  },
  setChecklist(v) {
    set({ checklist: v })
    save(get())
  },
  setHover(key) {
    if (get().hoverKey !== key) set({ hoverKey: key })
  },
  setTarget(t) {
    const cur = get().target
    if (cur?.key === t?.key && cur?.roomId === t?.roomId) return
    set({ target: t, moveEnd: 'b' })
  },
  setMoveEnd(e) {
    set({ moveEnd: e })
  },
}))

export function useAccuracy<T>(sel: (s: AccuracyState) => T): T {
  return useStore(accuracyStore, sel)
}
