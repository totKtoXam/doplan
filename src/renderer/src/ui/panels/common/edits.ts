import type { Doc, EntityRef, Id, MaterialCategory, Vec2 } from '@core/types'
import { docStore } from '@/store/document'
import { FLOOR_CATEGORIES } from './labels'
import { lookupAsset, lookupMaterial, tx } from './catalog'

/** wall faces (wall id + side) that bound a derived room */
export function roomWallSides(levelId: Id, roomId: Id): { wallId: Id; side: 'left' | 'right' }[] {
  const plan = docStore.getState().derived[levelId]
  const room = plan?.rooms.find((r) => r.roomId === roomId)
  if (!room) return []
  const seen = new Set<string>()
  const out: { wallId: Id; side: 'left' | 'right' }[] = []
  for (const e of room.edges) {
    const k = `${e.wallId}:${e.side}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ wallId: e.wallId, side: e.side })
  }
  return out
}

/** where a material category naturally goes when applied to a whole room */
export function roomTargetFor(cat: MaterialCategory): 'floor' | 'ceiling' | 'walls' {
  if (FLOOR_CATEGORIES.includes(cat)) return 'floor'
  if (cat === 'ceiling') return 'ceiling'
  return 'walls'
}

/**
 * "Apply to selected": walls get both faces, rooms get floor / ceiling / all wall faces depending on the
 * material category, openings get the leaf (or curtain fabric), items get every material slot.
 */
export function applyMaterialToRefs(materialId: Id, refs: EntityRef[]): number {
  const mat = lookupMaterial(materialId)
  if (!mat || refs.length === 0) return 0
  const state = docStore.getState()
  // resolve room faces outside the draft (derived data is read-only)
  const roomFaces = new Map<Id, { wallId: Id; side: 'left' | 'right' }[]>()
  for (const r of refs) {
    if (r.kind !== 'room') continue
    const room = state.doc.rooms[r.id]
    if (room) roomFaces.set(r.id, roomWallSides(room.levelId, r.id))
  }
  let count = 0
  tx('Применить материал', (d: Doc) => {
    for (const r of refs) {
      if (r.kind === 'wall') {
        const w = d.walls[r.id]
        if (!w) continue
        w.left.materialId = materialId
        w.right.materialId = materialId
        count++
      } else if (r.kind === 'room') {
        const room = d.rooms[r.id]
        if (!room) continue
        const target = roomTargetFor(mat.category)
        if (target === 'floor') {
          room.floor.materialId = materialId
          if (mat.pattern) room.floor.pattern = { ...mat.pattern }
        } else if (target === 'ceiling') {
          room.ceiling.materialId = materialId
        } else {
          for (const f of roomFaces.get(r.id) ?? []) {
            const w = d.walls[f.wallId]
            if (w) w[f.side].materialId = materialId
          }
        }
        count++
      } else if (r.kind === 'opening') {
        const o = d.openings[r.id]
        if (!o) continue
        if ((mat.category === 'fabric' || mat.category === 'leather') && o.curtain && o.curtain.kind !== 'none') o.curtain.materialId = materialId
        else o.leafMaterialId = materialId
        count++
      } else if (r.kind === 'item') {
        const it = d.items[r.id]
        if (!it) continue
        const asset = lookupAsset(it.assetId)
        const slots = Object.keys(asset?.slots ?? {})
        if (slots.length === 0) continue
        it.overrides = { ...(it.overrides ?? {}) }
        for (const s of slots) it.overrides[s] = materialId
        count++
      }
    }
  })
  return count
}

/**
 * Offsets an orthogonal-ish simple polygon outward by `d` (mitre join): used to turn clear (inner)
 * room dimensions into wall centre lines.
 */
export function offsetPolygon(pts: Vec2[], d: number): Vec2[] {
  const n = pts.length
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  // y-down screen coords: area > 0 means clockwise on screen; outward normal of edge (dx,dy) is (dy,-dx) for that case
  const sign = area > 0 ? 1 : -1
  const normal = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    return { x: (sign * dy) / l, y: (-sign * dx) / l }
  }
  return pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n]
    const next = pts[(i + 1) % n]
    const n1 = normal(prev, p)
    const n2 = normal(p, next)
    const dot = n1.x * n2.x + n1.y * n2.y
    const k = d / (1 + dot || 1)
    return { x: p.x + (n1.x + n2.x) * k, y: p.y + (n1.y + n2.y) * k }
  })
}

/** free spot to the right of the existing plan on a level (mm), for wizard-created rooms */
export function freeOrigin(levelId: Id): Vec2 {
  const st = docStore.getState()
  const plan = st.derived[levelId]
  const hasWalls = Object.values(st.doc.walls).some((w) => w.levelId === levelId)
  if (!plan || !hasWalls) return { x: 0, y: 0 }
  const b = plan.bounds
  if (!Number.isFinite(b.maxX)) return { x: 0, y: 0 }
  return { x: Math.round((b.maxX + 1500) / 100) * 100, y: Math.round(b.minY / 100) * 100 }
}

/** all entity refs living on a level (used when deleting a level) */
export function refsOnLevel(doc: Doc, levelId: Id): EntityRef[] {
  const out: EntityRef[] = []
  const add = (kind: EntityRef['kind'], rec: Record<Id, { levelId: Id }>) => {
    for (const [id, e] of Object.entries(rec)) if (e.levelId === levelId) out.push({ kind, id })
  }
  add('wall', doc.walls)
  add('node', doc.nodes)
  add('room', doc.rooms)
  add('item', doc.items)
  add('light', doc.lights)
  add('electric', doc.electrical ?? {})
  add('dimension', doc.dimensions)
  add('label', doc.labels)
  add('underlay', doc.underlays)
  return out
}
