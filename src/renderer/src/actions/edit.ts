import { detachElectric, duplicateEntities, layerIndex, nearestWallFace, newId, pickableRefs, placeElectricOnWall, remapAccentFace, removeEntities, unlockedRefs } from '@core'
import type { Doc, EntityRef, Id, Vec2 } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { handles } from '@/store/handles'
import { toast } from '@/store/notify'
import { uiStore } from '@/store/ui'
import { activeLevel, currentDoc } from './util'

function selection(): EntityRef[] {
  return uiStore.getState().selection
}

export function undo(): void {
  docStore.getState().undo()
}

export function redo(): void {
  docStore.getState().redo()
}

export function deleteSelection(): void {
  const refs = selection()
  if (!refs.length) return
  const doc = currentDoc()
  // locked objects (own lock, their kind's or their layer's) are never deleted
  const deletable = unlockedRefs(doc, refs)
  if (!deletable.length) {
    toast(t('Выбранные объекты заблокированы'), 'warning')
    return
  }
  docStore.getState().transact(t('Удалить'), (d) => removeEntities(d, deletable))
  uiStore.getState().clearSelection()
}

export function duplicateSelection(): void {
  const refs = selection()
  if (!refs.length) return
  let created: EntityRef[] = []
  docStore.getState().transact(t('Дублировать'), (d) => {
    created = duplicateEntities(d, refs, 500, 500)
  })
  if (created.length) uiStore.getState().select(created)
}

export function selectAll(): void {
  const doc = currentDoc()
  const lv = activeLevel()
  const refs: EntityRef[] = []
  for (const w of Object.values(doc.walls)) if (w.levelId === lv) refs.push({ kind: 'wall', id: w.id })
  for (const i of Object.values(doc.items)) if (i.levelId === lv && !i.locked && !i.hidden) refs.push({ kind: 'item', id: i.id })
  for (const l of Object.values(doc.lights)) if (l.levelId === lv) refs.push({ kind: 'light', id: l.id })
  for (const e of Object.values(doc.electrical ?? {})) if (e.levelId === lv) refs.push({ kind: 'electric', id: e.id })
  for (const l of Object.values(doc.labels)) if (l.levelId === lv) refs.push({ kind: 'label', id: l.id })
  for (const dm of Object.values(doc.dimensions)) if (dm.levelId === lv) refs.push({ kind: 'dimension', id: dm.id })
  // what cannot be clicked on the plan (hidden / locked in the layers panel) is not selected either
  uiStore.getState().select(pickableRefs(doc, refs))
}

export function zoomFit(): void {
  handles.editor2d?.zoomToFit()
  if (uiStore.getState().mode !== '2d') handles.engine3d?.resetCamera()
}

// ───────────── rotate ─────────────

function rot(p: Vec2, c: Vec2, cos: number, sin: number): Vec2 {
  const dx = p.x - c.x
  const dy = p.y - c.y
  // clockwise on screen (y down)
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/** the kinds groupRotate turns; openings and rooms follow their walls, underlays stay put */
export const ROTATABLE_KINDS: ReadonlySet<EntityRef['kind']> = new Set(['wall', 'node', 'item', 'light', 'electric', 'dimension', 'label'])

/** Rotates the selection by `deg` (clockwise on the plan) around its common centre. */
export function groupRotate(deg: number): void {
  const doc = currentDoc()
  const refs = unlockedRefs(doc, selection())
  if (!refs.length) return
  const vis = layerIndex(doc)
  const nodeIds = new Set<Id>()
  const pts: Vec2[] = []
  for (const r of refs) {
    switch (r.kind) {
      case 'wall': {
        const w = doc.walls[r.id]
        if (w) {
          // a node shared with a locked wall stays put
          if (!vis.locked('node', w.a)) nodeIds.add(w.a)
          if (!vis.locked('node', w.b)) nodeIds.add(w.b)
        }
        break
      }
      case 'node':
        if (doc.nodes[r.id]) nodeIds.add(r.id)
        break
      case 'item': {
        const it = doc.items[r.id]
        if (it && !it.locked) pts.push({ x: it.x, y: it.y })
        break
      }
      case 'light': {
        const l = doc.lights[r.id]
        if (l) pts.push({ x: l.x, y: l.y })
        break
      }
      case 'electric': {
        const e = doc.electrical?.[r.id]
        if (e) pts.push({ x: e.x, y: e.y })
        break
      }
      case 'label': {
        const l = doc.labels[r.id]
        if (l) pts.push({ x: l.x, y: l.y })
        break
      }
      case 'dimension': {
        const dm = doc.dimensions[r.id]
        if (dm) pts.push(dm.a, dm.b)
        break
      }
      default:
        break
    }
  }
  for (const id of nodeIds) pts.push(doc.nodes[id])
  if (!pts.length) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const norm = (v: number) => ((v % 360) + 360) % 360
  docStore.getState().transact(t('Повернуть'), (d) => {
    for (const id of nodeIds) {
      const n = d.nodes[id]
      const p = rot(n, c, cos, sin)
      n.x = p.x
      n.y = p.y
    }
    for (const r of refs) {
      if (r.kind === 'item') {
        const it = d.items[r.id]
        if (!it || it.locked) continue
        const p = rot(it, c, cos, sin)
        it.x = p.x
        it.y = p.y
        it.rotation = norm(it.rotation + deg)
      } else if (r.kind === 'light') {
        const l = d.lights[r.id]
        if (!l) continue
        const p = rot(l, c, cos, sin)
        l.x = p.x
        l.y = p.y
        if (l.rotation !== undefined) l.rotation = norm(l.rotation + deg)
      } else if (r.kind === 'electric') {
        // wall points are put back on their faces by normalize (the facing follows the wall)
        const e = d.electrical?.[r.id]
        if (!e) continue
        const p = rot(e, c, cos, sin)
        e.x = p.x
        e.y = p.y
        e.rotation = norm(e.rotation + deg)
      } else if (r.kind === 'label') {
        const l = d.labels[r.id]
        if (!l) continue
        const p = rot(l, c, cos, sin)
        l.x = p.x
        l.y = p.y
      } else if (r.kind === 'dimension') {
        const dm = d.dimensions[r.id]
        if (!dm) continue
        dm.a = rot(dm.a, c, cos, sin)
        dm.b = rot(dm.b, c, cos, sin)
      }
    }
  })
}

// ───────────── clipboard (in-app, works across levels and projects in one session) ─────────────

interface Clip {
  doc: Doc
  refs: EntityRef[]
  levelId: Id
  pastes: number
}

let clip: Clip | null = null

export function hasClipboard(): boolean {
  return !!clip
}

export function copySelection(): void {
  const refs = selection()
  if (!refs.length) return
  clip = { doc: currentDoc(), refs: [...refs], levelId: activeLevel(), pastes: 0 }
  toast(t('Скопировано объектов: {n}', { n: refs.length }), 'info', 1800)
}

export function cutSelection(): void {
  copySelection()
  deleteSelection()
}

/** Copies the clipped entities from `src` into `d` on `level`, returns refs of the new entities. */
function pasteInto(src: Doc, refs: EntityRef[], srcLevel: Id, d: Doc, level: Id, dx: number, dy: number): EntityRef[] {
  const out: EntityRef[] = []
  const wallIds = new Set<Id>()
  const roomIds = new Set<Id>()
  for (const r of refs) {
    if (r.kind === 'wall' && src.walls[r.id]) wallIds.add(r.id)
    if (r.kind === 'room' && src.rooms[r.id]) roomIds.add(r.id)
  }
  // a selected room brings its boundary walls along (derived from the source document)
  if (roomIds.size) {
    const derived = docStore.getState().doc === src ? docStore.getState().derived[srcLevel] : undefined
    for (const dr of derived?.rooms ?? []) if (roomIds.has(dr.roomId)) for (const e of dr.edges) wallIds.add(e.wallId)
  }
  const nodeMap = new Map<Id, Id>()
  const mapNode = (id: Id): Id => {
    const existing = nodeMap.get(id)
    if (existing) return existing
    const n = src.nodes[id]
    const nid: Id = newId('n')
    nodeMap.set(id, nid)
    d.nodes[nid] = { id: nid, levelId: level, x: n.x + dx, y: n.y + dy }
    return nid
  }
  const wallMap = new Map<Id, Id>()
  for (const wid of wallIds) {
    const w = src.walls[wid]
    if (!w || !src.nodes[w.a] || !src.nodes[w.b]) continue
    const id = newId('w')
    wallMap.set(wid, id)
    d.walls[id] = structuredClone({ ...w, id, levelId: level, a: mapNode(w.a), b: mapNode(w.b) })
    out.push({ kind: 'wall', id })
    for (const o of Object.values(src.openings)) {
      if (o.wallId !== wid) continue
      const oid = newId('o')
      d.openings[oid] = structuredClone({ ...o, id: oid, wallId: id })
    }
  }
  for (const rid of roomIds) {
    const r = src.rooms[rid]
    const id = newId('r')
    d.rooms[id] = structuredClone({ ...r, id, levelId: level, anchor: { x: r.anchor.x + dx, y: r.anchor.y + dy } })
    remapAccentFace(d.rooms[id], wallMap)
  }
  for (const r of refs) {
    switch (r.kind) {
      case 'item': {
        const it = src.items[r.id]
        if (!it) break
        const id = newId('i')
        d.items[id] = structuredClone({ ...it, id, levelId: level, x: it.x + dx, y: it.y + dy, locked: false })
        if (!d.assets[it.assetId] && src.assets[it.assetId]) d.assets[it.assetId] = structuredClone(src.assets[it.assetId])
        for (const mid of Object.values(it.overrides ?? {})) if (!d.materials[mid] && src.materials[mid]) d.materials[mid] = structuredClone(src.materials[mid])
        out.push({ kind: 'item', id })
        break
      }
      case 'light': {
        const l = src.lights[r.id]
        if (!l) break
        const id = newId('l')
        d.lights[id] = structuredClone({ ...l, id, levelId: level, x: l.x + dx, y: l.y + dy })
        out.push({ kind: 'light', id })
        break
      }
      case 'electric': {
        const e = src.electrical?.[r.id]
        if (!e) break
        const id = newId('e')
        const wallId = e.wallId ? wallMap.get(e.wallId) : undefined
        const copy = { ...e, id, levelId: level, x: e.x + dx, y: e.y + dy }
        ;(d.electrical ??= {})[id] = copy
        if (wallId) copy.wallId = wallId
        else if (copy.mount === 'wall') {
          // pasted without its wall: sits on the wall face found at the new place, if any
          detachElectric(copy)
          const hit = nearestWallFace(d, level, copy, 60, { skipHidden: true })
          if (hit) placeElectricOnWall(d, id, hit.wallId, hit.side, hit.t)
        }
        out.push({ kind: 'electric', id })
        break
      }
      case 'label': {
        const l = src.labels[r.id]
        if (!l) break
        const id = newId('t')
        d.labels[id] = { ...l, id, levelId: level, x: l.x + dx, y: l.y + dy }
        out.push({ kind: 'label', id })
        break
      }
      case 'dimension': {
        const dm = src.dimensions[r.id]
        if (!dm) break
        const id = newId('d')
        d.dimensions[id] = { ...dm, id, levelId: level, a: { x: dm.a.x + dx, y: dm.a.y + dy }, b: { x: dm.b.x + dx, y: dm.b.y + dy } }
        out.push({ kind: 'dimension', id })
        break
      }
      case 'underlay': {
        const u = src.underlays[r.id]
        if (!u) break
        const id = newId('u')
        d.underlays[id] = { ...u, id, levelId: level, x: u.x + dx, y: u.y + dy }
        out.push({ kind: 'underlay', id })
        break
      }
      default:
        break
    }
  }
  return out
}

export function paste(): void {
  if (!clip) return
  const c = clip
  const level = activeLevel()
  const sameLevel = level === c.levelId && currentDoc().levels[level] === c.doc.levels[c.levelId]
  c.pastes++
  const off = sameLevel || level === c.levelId ? 500 * c.pastes : 0
  let created: EntityRef[] = []
  docStore.getState().transact(t('Вставить'), (d) => {
    created = pasteInto(c.doc, c.refs, c.levelId, d, level, off, off)
  })
  // ids of walls may change during normalisation: keep only refs that survived
  const doc = currentDoc()
  const alive = created.filter((r) => {
    const coll = { wall: doc.walls, item: doc.items, light: doc.lights, electric: doc.electrical, label: doc.labels, dimension: doc.dimensions, underlay: doc.underlays }[
      r.kind as 'wall' | 'item' | 'light' | 'electric' | 'label' | 'dimension' | 'underlay'
    ]
    return !!coll?.[r.id]
  })
  if (alive.length) uiStore.getState().select(alive)
}
