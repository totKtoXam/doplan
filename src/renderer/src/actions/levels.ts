import { copyLevelInVariants, newId, remapAccentFace, type LevelCopyMaps } from '@core'
import type { Doc, Id, Level } from '@core/types'
import { t } from '@/i18n'
import { docStore } from '@/store/document'
import { confirmDialog, promptDialog, toast } from '@/store/notify'
import { uiStore } from '@/store/ui'
import { currentDoc } from './util'

/**
 * Copies every plan entity of `srcLevel` in `src` into `draft` on level `dstLevel`, with fresh ids,
 * shifted by (dx, dy). Project-local materials and assets referenced are copied too (same ids).
 * Returns old → new ids of the walls, rooms and openings (the finishes of other furnishing variants follow them).
 */
export function copyLevelInto(src: Doc, srcLevel: Id, draft: Doc, dstLevel: Id, dx = 0, dy = 0): LevelCopyMaps {
  const nodeMap = new Map<Id, Id>()
  const wallMap = new Map<Id, Id>()
  const roomMap = new Map<Id, Id>()
  const openingMap = new Map<Id, Id>()
  for (const n of Object.values(src.nodes)) {
    if (n.levelId !== srcLevel) continue
    const id = newId('n')
    nodeMap.set(n.id, id)
    draft.nodes[id] = { ...n, id, levelId: dstLevel, x: n.x + dx, y: n.y + dy }
  }
  for (const w of Object.values(src.walls)) {
    if (w.levelId !== srcLevel) continue
    const a = nodeMap.get(w.a)
    const b = nodeMap.get(w.b)
    if (!a || !b) continue
    const id = newId('w')
    wallMap.set(w.id, id)
    draft.walls[id] = structuredClone({ ...w, id, levelId: dstLevel, a, b })
  }
  for (const o of Object.values(src.openings)) {
    const wallId = wallMap.get(o.wallId)
    if (!wallId) continue
    const id = newId('o')
    openingMap.set(o.id, id)
    draft.openings[id] = structuredClone({ ...o, id, wallId })
  }
  for (const r of Object.values(src.rooms)) {
    if (r.levelId !== srcLevel) continue
    const id = newId('r')
    roomMap.set(r.id, id)
    draft.rooms[id] = structuredClone({ ...r, id, levelId: dstLevel, anchor: { x: r.anchor.x + dx, y: r.anchor.y + dy } })
    remapAccentFace(draft.rooms[id], wallMap)
  }
  const itemMap = new Map<Id, Id>()
  const lightMap = new Map<Id, Id>()
  for (const it of Object.values(src.items)) {
    if (it.levelId !== srcLevel) continue
    const id = newId('i')
    itemMap.set(it.id, id)
    draft.items[id] = structuredClone({ ...it, id, levelId: dstLevel, x: it.x + dx, y: it.y + dy, groupId: undefined })
  }
  for (const l of Object.values(src.lights)) {
    if (l.levelId !== srcLevel) continue
    const id = newId('l')
    lightMap.set(l.id, id)
    draft.lights[id] = structuredClone({ ...l, id, levelId: dstLevel, x: l.x + dx, y: l.y + dy })
  }
  for (const e of Object.values(src.electrical ?? {})) {
    if (e.levelId !== srcLevel) continue
    const id = newId('e')
    const wallId = e.wallId ? wallMap.get(e.wallId) : undefined
    const copy = { ...e, id, levelId: dstLevel, x: e.x + dx, y: e.y + dy, wallId }
    if (!wallId) {
      delete copy.wallId
      delete copy.side
    }
    ;(draft.electrical ??= {})[id] = copy
  }
  for (const dm of Object.values(src.dimensions)) {
    if (dm.levelId !== srcLevel) continue
    const id = newId('d')
    draft.dimensions[id] = { ...dm, id, levelId: dstLevel, a: { x: dm.a.x + dx, y: dm.a.y + dy }, b: { x: dm.b.x + dx, y: dm.b.y + dy } }
  }
  for (const lb of Object.values(src.labels)) {
    if (lb.levelId !== srcLevel) continue
    const id = newId('t')
    draft.labels[id] = { ...lb, id, levelId: dstLevel, x: lb.x + dx, y: lb.y + dy }
  }
  for (const u of Object.values(src.underlays)) {
    if (u.levelId !== srcLevel) continue
    const id = newId('u')
    draft.underlays[id] = { ...u, id, levelId: dstLevel, x: u.x + dx, y: u.y + dy }
  }
  if (src !== draft) {
    for (const m of Object.values(src.materials)) if (!draft.materials[m.id]) draft.materials[m.id] = structuredClone(m)
    for (const a of Object.values(src.assets)) if (!draft.assets[a.id]) draft.assets[a.id] = structuredClone(a)
  }
  return { walls: wallMap, rooms: roomMap, openings: openingMap, items: itemMap, lights: lightMap }
}

/** Removes a level and everything on it (draft mutation). */
/** pencil marks of a deleted level go too (they would keep pushing up the mark numbers) */
export function removeLevelMarks(d: Doc, levelId: Id): void {
  if (d.annotations) for (const [id, m] of Object.entries(d.annotations)) if (m.levelId === levelId) delete d.annotations[id]
}

export function removeLevelFromDraft(d: Doc, levelId: Id): void {
  const walls = new Set(Object.values(d.walls).filter((w) => w.levelId === levelId).map((w) => w.id))
  for (const o of Object.values(d.openings)) if (walls.has(o.wallId)) delete d.openings[o.id]
  for (const id of walls) delete d.walls[id]
  const colls = ['nodes', 'rooms', 'items', 'lights', 'dimensions', 'labels', 'underlays'] as const
  for (const c of colls) {
    const rec = d[c] as Record<Id, { levelId: Id }>
    for (const [id, e] of Object.entries(rec)) if (e.levelId === levelId) delete rec[id]
  }
  if (d.electrical) {
    for (const [id, e] of Object.entries(d.electrical)) if (e.levelId === levelId) delete d.electrical[id]
  }
  removeLevelMarks(d, levelId)
  delete d.levels[levelId]
  d.levelOrder = d.levelOrder.filter((id) => id !== levelId)
}

function nextLevelGeometry(doc: Doc): Pick<Level, 'elevation' | 'height'> {
  const last = doc.levels[doc.levelOrder[doc.levelOrder.length - 1]]
  const height = last?.height ?? doc.settings.wallHeight
  // 200 mm slab between storeys
  return { elevation: last ? last.elevation + last.height + 200 : 0, height }
}

export function addLevel(copyFrom?: Id): Id {
  const doc = currentDoc()
  const id = newId('lv')
  const n = doc.levelOrder.length + 1
  const geom = nextLevelGeometry(doc)
  docStore.getState().transact(copyFrom ? t('Копировать этаж') : t('Добавить этаж'), (d) => {
    d.levels[id] = { id, name: t('Этаж {n}', { n }), elevation: geom.elevation, height: geom.height, visible: true }
    d.levelOrder.push(id)
    if (copyFrom && doc.levels[copyFrom]) {
      const maps = copyLevelInto(doc, copyFrom, d, id)
      // the other furnishing variants get their furniture and finishes on the copy too
      copyLevelInVariants(d, copyFrom, id, maps)
    }
  })
  uiStore.getState().set({ activeLevelId: id, selection: [] })
  return id
}

export async function renameLevel(levelId: Id): Promise<void> {
  const level = currentDoc().levels[levelId]
  if (!level) return
  const name = await promptDialog(t('Название этажа'), level.name)
  if (name === null || !name.trim() || name.trim() === level.name) return
  docStore.getState().transact(t('Переименовать этаж'), (d) => {
    if (d.levels[levelId]) d.levels[levelId].name = name.trim()
  })
}

export async function deleteLevel(levelId: Id): Promise<void> {
  const doc = currentDoc()
  const level = doc.levels[levelId]
  if (!level) return
  if (doc.levelOrder.length <= 1) {
    toast(t('Нельзя удалить единственный этаж'), 'warning')
    return
  }
  const hasContent = Object.values(doc.walls).some((w) => w.levelId === levelId) || Object.values(doc.items).some((i) => i.levelId === levelId)
  if (hasContent) {
    const ok = await confirmDialog(t('Удалить этаж?'), t('Этаж «{name}» и всё, что на нём, будут удалены.', { name: level.name }), {
      ok: t('Удалить'),
      danger: true,
    })
    if (!ok) return
  }
  const idx = doc.levelOrder.indexOf(levelId)
  docStore.getState().transact(t('Удалить этаж'), (d) => removeLevelFromDraft(d, levelId))
  const order = currentDoc().levelOrder
  uiStore.getState().set({ activeLevelId: order[Math.max(0, idx - 1)] ?? order[0] ?? '', selection: [] })
}

export function toggleLevelVisible(levelId: Id): void {
  docStore.getState().transact(t('Видимость этажа'), (d) => {
    if (d.levels[levelId]) d.levels[levelId].visible = !d.levels[levelId].visible
  })
}

export function moveLevel(levelId: Id, dir: -1 | 1): void {
  const order = currentDoc().levelOrder
  const i = order.indexOf(levelId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return
  docStore.getState().transact(t('Порядок этажей'), (d) => {
    const o = [...d.levelOrder]
    ;[o[i], o[j]] = [o[j], o[i]]
    d.levelOrder = o
  })
}
