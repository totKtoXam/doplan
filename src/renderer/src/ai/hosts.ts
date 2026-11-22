/**
 * ToolHosts: the live document (every change = one undoable docStore transaction, visible at once)
 * and the plan-mode draft (changes collected as Immer patches, applied by the user in one step).
 */
import { applyPatches, type Patch, produceWithPatches } from 'immer'
import { buildDisplayList, derivePlan, drawToCanvas, normalize, syncRooms } from '@core'
import type { DerivedPlan, Doc, Id } from '@core/types'
import { docStore } from '@/store/document'
import { handles, waitForEngine3D } from '@/store/handles'
import { uiStore } from '@/store/ui'
import type { Snapshot, ToolHost } from './tools'

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function plan2d(doc: Doc, plan: DerivedPlan, levelId: Id, width: number): Promise<Snapshot> {
  const dl = buildDisplayList(doc, levelId, { theme: 'light', derived: plan, catalog: uiStore.getState().catalog })
  const bw = Math.max(1, dl.bounds.maxX - dl.bounds.minX)
  const bh = Math.max(1, dl.bounds.maxY - dl.bounds.minY)
  let pxPerMm = width / bw
  if (bh * pxPerMm > 1600) pxPerMm = 1600 / bh
  const w = Math.max(1, Math.ceil(bw * pxPerMm))
  const h = Math.max(1, Math.ceil(bh * pxPerMm))
  const canvas = new OffscreenCanvas(w, h)
  const c2d = canvas.getContext('2d')
  if (!c2d) throw new Error('2D-контекст недоступен')
  drawToCanvas(c2d, dl, { pxPerMm, width: w, height: h, background: dl.background || '#ffffff' })
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { mime: 'image/png', data: await blobToBase64(blob), note: `${w}×${h} px, 1 px = ${Math.round((1 / pxPerMm) * 10) / 10} мм, левый верхний угол = (${Math.round(dl.bounds.minX)}, ${Math.round(dl.bounds.minY)})` }
}

async function view3d(width: number): Promise<Snapshot> {
  let engine = handles.engine3d
  const ui = uiStore.getState()
  const prevMode = ui.mode
  if (!engine) {
    ui.setMode('split')
    engine = await waitForEngine3D(20000)
  }
  try {
    if (!engine) throw new Error('3D-вид недоступен')
    const height = Math.round(width * 0.625)
    const blob = await engine.renderStill({ width, height, mode: 'realtime', format: 'jpeg' })
    return { mime: 'image/jpeg', data: await blobToBase64(blob), note: `${width}×${height} px, текущая камера 3D` }
  } finally {
    if (prevMode !== uiStore.getState().mode && prevMode === '2d') uiStore.getState().setMode(prevMode)
  }
}

export function liveHost(): ToolHost {
  return {
    doc: () => docStore.getState().doc,
    derived: (lv) => docStore.getState().derived[lv] ?? derivePlan(docStore.getState().doc, lv),
    activeLevelId: () => uiStore.getState().activeLevelId,
    selection: () => uiStore.getState().selection,
    catalog: () => uiStore.getState().catalog,
    mutate: (label, fn) => docStore.getState().transact(label, fn),
    snapshot: (view, width, lv) => {
      if (view === '3d') return view3d(width)
      const s = docStore.getState()
      return plan2d(s.doc, s.derived[lv] ?? derivePlan(s.doc, lv), lv, width)
    },
  }
}

export interface DraftMark {
  readonly cur: Doc
  readonly patches: number
  readonly count: number
}

/** Plan mode: changes go to a private copy; `apply()` replays them on the live document. */
export class DraftHost implements ToolHost {
  /** the live revision the draft was taken from; moved on by changes that cannot clash with it (sent marks let go) */
  baseRevision: number
  private cur: Doc
  private patches: Patch[] = []
  private cache = new Map<Id, DerivedPlan>()
  /** number of applied mutations */
  count = 0

  constructor() {
    const s = docStore.getState()
    this.cur = s.doc
    this.baseRevision = s.revision
  }

  doc(): Doc {
    return this.cur
  }

  derived(lv: Id): DerivedPlan {
    let p = this.cache.get(lv)
    if (!p) {
      p = this.patches.length ? derivePlan(this.cur, lv) : (docStore.getState().derived[lv] ?? derivePlan(this.cur, lv))
      this.cache.set(lv, p)
    }
    return p
  }

  activeLevelId(): Id {
    return uiStore.getState().activeLevelId
  }

  selection() {
    return uiStore.getState().selection
  }

  catalog() {
    return uiStore.getState().catalog
  }

  mutate(_label: string, fn: (d: Doc) => void): void {
    const [next, patches] = produceWithPatches(this.cur, (d: Doc) => {
      fn(d)
      normalize(d)
      syncRooms(d)
    })
    this.cur = next
    this.patches.push(...patches)
    this.cache.clear()
    this.count++
  }

  async snapshot(view: '2d' | '3d', width: number, lv: Id): Promise<Snapshot> {
    if (view === '2d') return plan2d(this.cur, this.derived(lv), lv, width)
    const s = await view3d(width)
    return { ...s, note: `${s.note}. Внимание: 3D показывает документ без черновика режима плана` }
  }

  get empty(): boolean {
    return this.patches.length === 0
  }

  /** where the draft is now, to go back to with `rollback` */
  mark(): DraftMark {
    return { cur: this.cur, patches: this.patches.length, count: this.count }
  }

  /** forgets the changes made after `m` */
  rollback(m: DraftMark): void {
    this.cur = m.cur
    this.patches.length = m.patches
    this.count = m.count
    this.cache.clear()
  }

  /** Applies the draft as one undoable step. Returns false if the document changed meanwhile and patching failed. */
  apply(label = 'ИИ: применить план'): { ok: boolean; stale: boolean } {
    const stale = docStore.getState().revision !== this.baseRevision
    // a mark the draft touched («внесено») may be gone from the plan by now (sent marks are let go when
    // the turn ends, or the user deleted it): that part has nothing to land on and is skipped
    const live = docStore.getState().doc.annotations
    const patches = this.patches.filter((p) => !(p.path[0] === 'annotations' && p.path.length > 2 && !live?.[String(p.path[1])]))
    try {
      docStore.getState().transact(label, (d) => {
        applyPatches(d, patches)
      })
      return { ok: true, stale }
    } catch (e) {
      console.error('[doplan] plan apply failed', e)
      return { ok: false, stale }
    }
  }
}
