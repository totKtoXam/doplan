import { addItem, layoutKitchenPreset, newId, type KitchenPreset, type PresetFace } from '@core'
import type { EntityRef, Id, Vec2 } from '@core/types'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import { lookupAsset, tx } from './catalog'
import { freeOrigin } from './edits'

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
const len = (a: Vec2): number => Math.hypot(a.x, a.y)

/** face from a segment of an inner wall face and a point inside the room */
function faceOf(from: Vec2, to: Vec2, inside: Vec2): PresetFace | null {
  const d = sub(to, from)
  const L = len(d)
  if (L < 1) return null
  const u = { x: d.x / L, y: d.y / L }
  let n = { x: -u.y, y: u.x }
  if (dot(sub(inside, from), n) < 0) n = { x: -n.x, y: -n.y }
  // item local +x for an item whose front looks along n
  const x = { x: n.y, y: -n.x }
  const p0 = dot(from, x) <= dot(to, x) ? from : to
  return { p0, x, n, length: L }
}

/**
 * Where to put a preset: the longest room face of the selected wall (or of the selected room),
 * otherwise a free spot to the right of the plan with the fronts looking down the screen.
 */
export function presetFace(levelId: Id, selection: EntityRef[], preset: KitchenPreset): PresetFace {
  const plan = docStore.getState().derived[levelId]
  const wallIds = new Set(selection.filter((r) => r.kind === 'wall').map((r) => r.id))
  const roomIds = new Set(selection.filter((r) => r.kind === 'room').map((r) => r.id))
  let best: PresetFace | null = null
  for (const room of plan?.rooms ?? []) {
    for (const e of room.edges) {
      if (!wallIds.has(e.wallId) && !roomIds.has(room.roomId)) continue
      const f = faceOf(e.from, e.to, room.labelPoint)
      if (f && (!best || f.length > best.length)) best = f
    }
  }
  if (best) return best
  // a wall without a room: its left face, fronts away from the centreline
  for (const id of wallIds) {
    const g = plan?.wallGeoms[id]
    if (!g) continue
    const [a, b] = g.left
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const out = sub(mid, { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 })
    const f = faceOf(a, b, { x: mid.x + out.x * 10, y: mid.y + out.y * 10 })
    if (f) return f
  }
  const o = freeOrigin(levelId)
  return { p0: o, x: { x: 1, y: 0 }, n: { x: 0, y: 1 }, length: preset.length }
}

/** place a whole kitchen set as one undo step; the new items are grouped and selected */
export function placeKitchenPreset(preset: KitchenPreset): number {
  const ui = uiStore.getState()
  const levelId = ui.activeLevelId
  const face = presetFace(levelId, ui.selection, preset)
  const placements = layoutKitchenPreset(preset, face, lookupAsset)
  if (placements.length === 0) return 0
  const groupId = newId('i')
  const created: Id[] = []
  tx(`Кухня: ${preset.nameRu}`, (d) => {
    for (const p of placements) {
      const a = lookupAsset(p.assetId)
      if (!a) continue
      const patch: Parameters<typeof addItem>[5] = { rotation: p.rotation, groupId }
      if (p.size) patch.size = p.size
      if (p.params) patch.params = p.params
      created.push(addItem(d, levelId, a, p.x, p.y, patch))
    }
  })
  uiStore.getState().setTool('select')
  uiStore.getState().select(created.map((id) => ({ kind: 'item' as const, id })))
  return created.length
}
