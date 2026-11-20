/**
 * Document store: the undoable project document + derived geometry per level.
 * Every change goes through `transact()` (Immer `produceWithPatches`), which synchronously runs
 * core `normalize` + `syncRooms` (when the change could break the plan invariants: `touchesPlan`)
 * and recomputes `derivePlan` for the levels the patches touched.
 * Untouched levels keep their previous `DerivedPlan` object (structural sharing → cheap 3D/2D diffing).
 */
import { applyPatches, enablePatches, type Patch, produce, produceWithPatches } from 'immer'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { createEmptyDoc, derivePlan, docFormatVersion, normalize, syncFormatVersion, syncRooms } from '@core'
import type { DerivedPlan, Doc, EntityRef, Id } from '@core/types'
import type { DocState } from '@/contracts'

enablePatches()

export const HISTORY_LIMIT = 200
/** coalescing window for `opts.merge`, ms since the previous merged change */
const MERGE_WINDOW_MS = 1500

interface HistoryEntry {
  /** unique, monotonically increasing; identifies the document state right after this entry */
  id: number
  label: string
  patches: Patch[]
  inverse: Patch[]
  mergeKey?: string
  time: number
  selBefore: EntityRef[]
  selAfter: EntityRef[]
}

/** Extra (non-contract) fields exposed by this store. */
export interface DocStoreState extends DocState {
  undoLabel: string | null
  redoLabel: string | null
  /** true while transient (preview) changes are pending */
  transientActive: boolean
  /** set dirty without a document change (e.g. after restoring a recovery snapshot) */
  setDirty(dirty: boolean): void
}

// ───────────── selection bridge (configured by store/ui.ts, avoids an import cycle) ─────────────

let getSelection: () => EntityRef[] = () => []
let setSelection: (refs: EntityRef[]) => void = () => {}

export function bindSelection(get: () => EntityRef[], set: (refs: EntityRef[]) => void): void {
  getSelection = get
  setSelection = set
}

// ───────────── derived geometry ─────────────

/** Collections whose changes alter the derived plan of the level they belong to. */
const GEOMETRY_COLLECTIONS = new Set(['nodes', 'walls', 'openings', 'rooms', 'levels'])

function levelOfEntity(doc: Doc, coll: string, id: string): Id | null {
  switch (coll) {
    case 'nodes':
      return doc.nodes[id]?.levelId ?? null
    case 'walls':
      return doc.walls[id]?.levelId ?? null
    case 'rooms':
      return doc.rooms[id]?.levelId ?? null
    case 'levels':
      return doc.levels[id] ? id : null
    case 'openings': {
      const o = doc.openings[id]
      return o ? (doc.walls[o.wallId]?.levelId ?? null) : null
    }
    default:
      return null
  }
}

/** Levels whose derived plan must be recomputed; `null` means "all levels". */
function touchedLevels(prev: Doc, next: Doc, patches: Patch[]): Set<Id> | null {
  const out = new Set<Id>()
  for (const p of patches) {
    const coll = p.path[0]
    if (coll === undefined) return null // whole document replaced
    if (typeof coll !== 'string') continue
    if (coll === 'levelOrder') {
      for (const id of next.levelOrder) if (!prev.levels[id]) out.add(id)
      continue
    }
    if (!GEOMETRY_COLLECTIONS.has(coll)) continue
    const id = p.path[1]
    if (id === undefined) return null // whole collection replaced
    const sid = String(id)
    const a = levelOfEntity(prev, coll, sid)
    const b = levelOfEntity(next, coll, sid)
    if (a) out.add(a)
    if (b) out.add(b)
    // an opening moved to another wall: the patch path may be ['openings', id, 'wallId']
  }
  return out
}

function safeDerive(doc: Doc, levelId: Id): DerivedPlan {
  try {
    return derivePlan(doc, levelId)
  } catch (err) {
    console.error('[doplan] derivePlan failed for level', levelId, err)
    return { wallGeoms: {}, rooms: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }
  }
}

function deriveAll(doc: Doc): Record<Id, DerivedPlan> {
  const out: Record<Id, DerivedPlan> = {}
  for (const id of doc.levelOrder) out[id] = safeDerive(doc, id)
  return out
}

function deriveIncremental(prevDoc: Doc, nextDoc: Doc, prevDerived: Record<Id, DerivedPlan>, patches: Patch[]): Record<Id, DerivedPlan> {
  const touched = touchedLevels(prevDoc, nextDoc, patches)
  if (touched === null) return deriveAll(nextDoc)
  let changed = false
  const out: Record<Id, DerivedPlan> = {}
  for (const id of nextDoc.levelOrder) {
    if (touched.has(id) || !prevDerived[id]) {
      out[id] = safeDerive(nextDoc, id)
      changed = true
    } else {
      out[id] = prevDerived[id]
    }
  }
  if (!changed && Object.keys(prevDerived).length === nextDoc.levelOrder.length) return prevDerived
  return out
}

/** normalize + syncRooms; failures are logged but never block an edit */
function normalizeDraft(d: Doc): void {
  try {
    normalize(d)
  } catch (err) {
    console.error('[doplan] normalize failed', err)
  }
  try {
    syncRooms(d)
  } catch (err) {
    console.error('[doplan] syncRooms failed', err)
  }
  // layers / variants raise the file format (older apps must refuse the file, not drop data)
  try {
    syncFormatVersion(d)
  } catch (err) {
    console.error('[doplan] syncFormatVersion failed', err)
  }
}

/** collections that normalize and syncRooms neither read nor change */
const INERT_ROOTS = new Set(['meta', 'render', 'items', 'lights', 'dimensions', 'labels', 'annotations', 'underlays', 'cameras', 'materials', 'assets', 'source', 'design'])
/** room fields the room detection and the record sync do not read: the finishes and the description */
const INERT_ROOM_FIELDS = new Set(['name', 'type', 'floor', 'skirting', 'skirtingMaterialId', 'labelledArea', 'design', 'styleId', 'accentFace'])

/**
 * Whether a change can break the plan invariants (a wall, a node, a room's place, an electric point,
 * a layer…). The document in the store is always normalised, so a change that touches none of that
 * (a room renamed letter by letter, furniture moved, a finish picked) leaves it normalised, and the
 * normalisation, which detects the rooms of every level again, is skipped.
 */
export function touchesPlan(patches: readonly Patch[]): boolean {
  return patches.some((p) => {
    const [root, id, field] = p.path
    if (INERT_ROOTS.has(root as string)) return false
    return !(root === 'rooms' && id !== undefined && field !== undefined && INERT_ROOM_FIELDS.has(field as string))
  })
}

function touchModified(d: Doc): void {
  d.meta.modifiedAt = new Date().toISOString()
}

/** Prepare a freshly loaded document (normalised, frozen by Immer). */
function prepareLoaded(doc: Doc): Doc {
  return produce(doc, (d) => {
    normalizeDraft(d)
  })
}

// ───────────── store ─────────────

let undoStack: HistoryEntry[] = []
let redoStack: HistoryEntry[] = []
/** transient session: base document and accumulated forward patches */
let transientBase: Doc | null = null
let transientPatches: Patch[] = []
let transientSel: EntityRef[] = []

// ── saved-state tracking: the document is clean iff the history position equals the saved one ──
let nextEntryId = 1
/** id of the state with an empty undo stack (0 after load; the last trimmed entry after HISTORY_LIMIT trimming) */
let baseId = 0
/** history position of the last saved/loaded state; -1 = not reachable through undo/redo */
let savedId = 0
/** positions a save in flight was taken at (id → number of saves): no later edit merges into them */
const savePins = new Map<number, number>()

/** id of the current history position */
function currentId(): number {
  return undoStack.length ? undoStack[undoStack.length - 1].id : baseId
}

/** dirty unless the history is exactly at the saved position (pending transient previews count as changes) */
function computeDirty(): boolean {
  return transientBase !== null || currentId() !== savedId
}

function historyFlags() {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : null,
    redoLabel: redoStack.length ? redoStack[redoStack.length - 1].label : null,
  }
}

const initialDoc = prepareLoaded(createEmptyDoc())

export const docStore = createStore<DocStoreState>()((set, get) => {
  /** applies `next` (already normalised) after a change described by `patches` */
  function applyNext(next: Doc, patches: Patch[], extra?: Partial<DocStoreState>): void {
    const s = get()
    const derived = deriveIncremental(s.doc, next, s.derived, patches)
    set({
      doc: next,
      derived,
      revision: s.revision + 1,
      dirty: computeDirty(),
      ...historyFlags(),
      ...extra,
    })
  }

  function pushHistory(data: Omit<HistoryEntry, 'id'>, mergeKey?: string): void {
    const entry: HistoryEntry = { ...data, id: nextEntryId++ }
    const top = undoStack[undoStack.length - 1]
    // never merge into the saved entry: undo must be able to return to the saved state
    // nor into one a save in flight was taken at: that entry must keep describing the written file
    if (mergeKey && top && top.id !== savedId && !savePins.has(top.id) && top.mergeKey === mergeKey && entry.time - top.time < MERGE_WINDOW_MS) {
      top.patches = [...top.patches, ...entry.patches]
      top.inverse = [...entry.inverse, ...top.inverse]
      top.time = entry.time
      top.selAfter = entry.selAfter
      top.label = entry.label
    } else {
      undoStack.push(entry)
      if (undoStack.length > HISTORY_LIMIT) {
        const trimmed = undoStack.splice(0, undoStack.length - HISTORY_LIMIT)
        baseId = trimmed[trimmed.length - 1].id
      }
    }
    redoStack = []
  }

  return {
    doc: initialDoc,
    derived: deriveAll(initialDoc),
    revision: 0,
    loadId: 0,
    reload: null,
    filePath: null,
    dirty: false,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    transientActive: false,

    transact(label, fn, opts) {
      const s = get()
      if (opts?.transient) {
        if (!transientBase) {
          transientBase = s.doc
          transientPatches = []
          transientSel = getSelection()
        }
        // live preview: no normalisation (it could merge nodes the drag is still moving)
        let next: Doc
        let patches: Patch[]
        try {
          ;[next, patches] = produceWithPatches(s.doc, (d: Doc) => {
            fn(d)
          })
        } catch (err) {
          console.error(`[doplan] transient "${label}" failed`, err)
          return
        }
        if (!patches.length) return
        transientPatches.push(...patches)
        applyNext(next, patches, { transientActive: true })
        return
      }

      // a regular transaction while a transient session is open: fold the session in first
      if (transientBase) get().commitTransient(label)

      const before = get().doc
      const selBefore = getSelection()
      let next: Doc
      let patches: Patch[]
      let inverse: Patch[]
      try {
        ;[next, patches, inverse] = produceWithPatches(before, (d: Doc) => {
          fn(d)
          touchModified(d)
        })
        // then the invariants, when the change could break them (applied after it: one history entry)
        const plan = touchesPlan(patches)
        if (plan || docFormatVersion(next) !== next.version) {
          const [n2, p2, i2] = produceWithPatches(next, (d: Doc) => {
            if (plan) normalizeDraft(d)
            else syncFormatVersion(d)
          })
          next = n2
          patches = [...patches, ...p2]
          inverse = [...i2, ...inverse]
        }
      } catch (err) {
        console.error(`[doplan] transaction "${label}" failed`, err)
        throw err
      }
      // only the modifiedAt stamp changed → nothing really happened
      if (!patches.some((p) => !(p.path[0] === 'meta' && p.path[1] === 'modifiedAt'))) return
      pushHistory(
        { label, patches, inverse, mergeKey: opts?.merge, time: Date.now(), selBefore, selAfter: getSelection() },
        opts?.merge,
      )
      applyNext(next, patches)
    },

    commitTransient(label) {
      if (!transientBase) return
      const base = transientBase
      const forward = transientPatches
      const selBefore = transientSel
      transientBase = null
      transientPatches = []
      transientSel = []
      if (!forward.length) {
        set({ transientActive: false })
        return
      }
      let next: Doc
      let patches: Patch[]
      let inverse: Patch[]
      try {
        // furniture dragged: nothing the normalisation looks at moved (see touchesPlan)
        const plan = touchesPlan(forward)
        ;[next, patches, inverse] = produceWithPatches(base, (d: Doc) => {
          applyPatches(d, forward)
          if (plan) normalizeDraft(d)
          touchModified(d)
        })
        if (!plan && docFormatVersion(next) !== next.version) {
          const [n2, p2, i2] = produceWithPatches(next, (d: Doc) => syncFormatVersion(d))
          next = n2
          patches = [...patches, ...p2]
          inverse = [...i2, ...inverse]
        }
      } catch (err) {
        console.error(`[doplan] commitTransient "${label}" failed`, err)
        // fall back to the base document
        const cur = get().doc
        set({
          doc: base,
          derived: deriveIncremental(cur, base, get().derived, forward),
          revision: get().revision + 1,
          dirty: computeDirty(),
          transientActive: false,
        })
        return
      }
      pushHistory({ label, patches, inverse, time: Date.now(), selBefore, selAfter: getSelection() })
      // derived must be computed relative to the currently displayed (preview) doc
      const cur = get().doc
      set({
        doc: next,
        derived: deriveIncremental(cur, next, get().derived, [...forward, ...patches]),
        revision: get().revision + 1,
        dirty: computeDirty(),
        transientActive: false,
        ...historyFlags(),
      })
    },

    cancelTransient() {
      if (!transientBase) return
      const base = transientBase
      const forward = transientPatches
      transientBase = null
      transientPatches = []
      transientSel = []
      const cur = get().doc
      set({
        doc: base,
        derived: deriveIncremental(cur, base, get().derived, forward),
        revision: get().revision + 1,
        dirty: computeDirty(),
        transientActive: false,
      })
    },

    undo() {
      if (transientBase) get().cancelTransient()
      const e = undoStack.pop()
      if (!e) return
      const cur = get().doc
      const next = applyPatches(cur, e.inverse)
      redoStack.push(e)
      applyNext(next, e.inverse)
      setSelection(e.selBefore)
    },

    redo() {
      if (transientBase) get().cancelTransient()
      const e = redoStack.pop()
      if (!e) return
      const cur = get().doc
      const next = applyPatches(cur, e.patches)
      undoStack.push(e)
      applyNext(next, e.patches)
      setSelection(e.selAfter)
    },

    load(doc, filePath, reload = null) {
      transientBase = null
      transientPatches = []
      transientSel = []
      undoStack = []
      redoStack = []
      baseId = 0
      savedId = 0
      const prepared = prepareLoaded(doc)
      set({
        doc: prepared,
        derived: deriveAll(prepared),
        revision: get().revision + 1,
        loadId: get().loadId + 1,
        reload,
        filePath,
        dirty: false,
        transientActive: false,
        ...historyFlags(),
      })
    },

    newDoc(name) {
      get().load(createEmptyDoc(name), null)
    },

    markSaved(filePath, id, written) {
      // `written`: the snapshot that went to disk. Saved is what is on screen only if it is that very
      // snapshot; edited since, the snapshot's own history position (pinned, so nothing merged into
      // it); taken during a live preview, no position holds it
      savedId = !written ? currentId() : !written.exact ? -1 : written.doc === get().doc ? currentId() : written.at
      // the id the file was written with (Save As / the first save of an older file give a new one); not an edit
      const doc = id && id !== get().doc.meta.id ? { ...get().doc, meta: { ...get().doc.meta, id } } : get().doc
      set({ doc, filePath, dirty: computeDirty() })
    },

    setDocId(id) {
      const doc = get().doc
      if (doc.meta.id === id) return
      // the file still carries the old id: changed until saved, so the next save (or the close prompt) writes it
      savedId = -1
      set({ doc: { ...doc, meta: { ...doc.meta, id } }, dirty: computeDirty() })
    },

    setDirty(dirty) {
      // dirty=true (e.g. a restored recovery snapshot): no history position matches the file on disk
      savedId = dirty ? -1 : currentId()
      set({ dirty: computeDirty() })
    },
  }
})

/** React selector hook over `docStore`. */
export function useDoc<T>(selector: (s: DocStoreState) => T): T {
  return useStore(docStore, selector)
}

// ───────────── project versions: undo labels since the last commit ─────────────

/** id of the current history position (pass it back to `undoLabelsSince` later) */
export function historyPosition(): number {
  return currentId()
}

/** what a save writes: the document as it is now, where it sits in the history, and which load it belongs to */
export interface SaveSnapshot {
  doc: Doc
  /** history position the document was taken at */
  at: number
  /** false during a live preview: no history position holds this document */
  exact: boolean
  /** DocState.loadId when taken: another open, reload or version view makes the snapshot stale */
  loadId: number
}

/** takes the document for a save and pins its history position until `endSave` */
export function beginSave(): SaveSnapshot {
  const s = docStore.getState()
  const at = currentId()
  savePins.set(at, (savePins.get(at) ?? 0) + 1)
  return { doc: s.doc, at, exact: !s.transientActive, loadId: s.loadId }
}

export function endSave(snap: SaveSnapshot): void {
  const n = (savePins.get(snap.at) ?? 1) - 1
  if (n > 0) savePins.set(snap.at, n)
  else savePins.delete(snap.at)
}

/** labels of the history entries made after position `since`, oldest first (undone entries excluded) */
export function undoLabelsSince(since: number): string[] {
  return undoStack.filter((e) => e.id > since).map((e) => e.label)
}
