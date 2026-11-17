/**
 * Room detection: faces of the planar wall graph (half-edge traversal).
 *
 * - every wall gives two half-edges; outgoing half-edges of a node are sorted by direction angle;
 * - `next(h)` turns to the neighbouring half-edge so that the face stays on the RIGHT of the travel
 *   direction (y-down plan) — bounded faces then come out clockwise on screen (positive shoelace area),
 *   the outer boundary of every connected component comes out counter-clockwise (negative area);
 * - dangling walls and bridges are simply walked out and back: they do not create faces, but their
 *   footprint is correctly notched out of the inner polygon of the room they stand in;
 * - the outer boundary of a component that lies inside a face of another component is an island → hole;
 * - the inner polygon is built from the mitred wall faces (WallGeom.left / .right), so the area is
 *   measured between finished wall faces; virtual walls contribute their axis.
 */
import { dist, pointInPolygon, polygonArea, polygonPerimeter, polylabel } from './geom'
import { hashString } from './ids'
import type { DerivedRoom, Doc, Id, Room, RoomBoundaryEdge, Vec2, Wall, WallGeom } from './types'

/** centreline cycles below this area (mm²) are not faces (tree components, slits) */
const AREA_EPS = 1e3
/** faces whose inner area is below this (mm²) are dropped: 0.01 m² */
const MIN_FACE_AREA = 1e4
/** faces smaller than this (m²) never get an automatic Room record (shafts, ducts) */
export const MIN_ROOM_AREA_M2 = 0.1
const PT_EPS = 0.01

interface HalfEdge {
  id: number
  from: Id
  to: Id
  wall: Wall
  /** true: travels a → b */
  ab: boolean
  twin: number
  ang: number
  pos: number
}

interface Cycle {
  hes: HalfEdge[]
  area: number
  comp: Id
}

function samePt(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) <= PT_EPS && Math.abs(a.y - b.y) <= PT_EPS
}

/**
 * Removes duplicate points, zero-width spikes (out-and-back along the same line) and
 * redundant collinear vertices from a closed ring.
 */
export function cleanRing(points: readonly Vec2[]): Vec2[] {
  let ring: Vec2[] = []
  for (const p of points) {
    const last = ring[ring.length - 1]
    if (last && samePt(last, p)) continue
    ring.push({ x: p.x, y: p.y })
  }
  while (ring.length > 1 && samePt(ring[0], ring[ring.length - 1])) ring.pop()
  let changed = true
  let guard = 0
  while (changed && ring.length >= 3 && guard++ < 10000) {
    changed = false
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const prev = ring[(i + n - 1) % n]
      const cur = ring[i]
      const next = ring[(i + 1) % n]
      const ux = cur.x - prev.x
      const uy = cur.y - prev.y
      const wx = next.x - cur.x
      const wy = next.y - cur.y
      const lu = Math.hypot(ux, uy)
      const lw = Math.hypot(wx, wy)
      let drop = false
      if (lu <= PT_EPS || lw <= PT_EPS) {
        drop = true
      } else {
        const cr = ux * wy - uy * wx
        const dt = ux * wx + uy * wy
        if (dt < 0) {
          // spike: the path turns back along the same line
          if (Math.abs(cr) / Math.max(lu, lw) <= PT_EPS) drop = true
        } else {
          const chord = Math.hypot(next.x - prev.x, next.y - prev.y)
          if (chord > PT_EPS && Math.abs(cr) / chord <= PT_EPS) drop = true
        }
      }
      if (drop) {
        ring.splice(i, 1)
        changed = true
        break
      }
    }
    if (changed) {
      // removing a vertex may leave two equal neighbours
      const out: Vec2[] = []
      for (const p of ring) {
        const last = out[out.length - 1]
        if (last && samePt(last, p)) continue
        out.push(p)
      }
      while (out.length > 1 && samePt(out[0], out[out.length - 1])) out.pop()
      ring = out
    }
  }
  return ring
}

/** Removes out-and-back spurs (dangling walls) from a closed sequence of node ids. */
function pruneSpurs(ids: Id[]): Id[] {
  const out = ids.slice()
  let changed = true
  while (changed && out.length >= 3) {
    changed = false
    const n = out.length
    for (let i = 0; i < n; i++) {
      if (out[(i + n - 1) % n] === out[(i + 1) % n]) {
        // remove the tip and one copy of the repeated node
        const j = (i + 1) % n
        if (j > i) {
          out.splice(j, 1)
          out.splice(i, 1)
        } else {
          out.splice(i, 1)
          out.splice(j, 1)
        }
        changed = true
        break
      }
    }
  }
  return out
}

function faceSegment(h: HalfEdge, g: WallGeom): { side: 'left' | 'right'; from: Vec2; to: Vec2 } {
  // the face lies on the right of the travel direction
  return h.ab ? { side: 'right', from: g.right[0], to: g.right[1] } : { side: 'left', from: g.left[1], to: g.left[0] }
}

function sideRing(cycle: HalfEdge[], geoms: Record<Id, WallGeom>, edges: RoomBoundaryEdge[] | null): Vec2[] {
  const pts: Vec2[] = []
  for (const h of cycle) {
    const g = geoms[h.wall.id]
    if (!g) continue
    const seg = faceSegment(h, g)
    pts.push(seg.from, seg.to)
    if (edges && h.wall.kind !== 'virtual' && dist(seg.from, seg.to) > PT_EPS) {
      edges.push({
        wallId: h.wall.id,
        side: seg.side,
        from: { x: seg.from.x, y: seg.from.y },
        to: { x: seg.to.x, y: seg.to.y },
      })
    }
  }
  return cleanRing(pts)
}

function findRoot(parent: Map<Id, Id>, x: Id): Id {
  let r = x
  for (;;) {
    const p = parent.get(r)
    if (p === undefined || p === r) break
    r = p
  }
  let c = x
  while (c !== r) {
    const p = parent.get(c) as Id
    parent.set(c, r)
    c = p
  }
  return r
}

interface Face {
  cycle: Cycle
  polygon: Vec2[]
  ringArea: number
  holes: Vec2[][]
  holeArea: number
  edges: RoomBoundaryEdge[]
  centerline: Vec2[]
  nodeKey: string
}

/**
 * Planar faces of one level, matched to Room records by anchor point.
 * A face without a record gets the deterministic id `auto_<hash of its node ids>`.
 */
export function detectRooms(doc: Doc, levelId: Id, wallGeoms: Record<Id, WallGeom>): DerivedRoom[] {
  // ── half-edges ──
  const hes: HalfEdge[] = []
  const out = new Map<Id, HalfEdge[]>()
  const parent = new Map<Id, Id>()
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.levelId !== levelId || w.a === w.b) continue
    const na = doc.nodes[w.a]
    const nb = doc.nodes[w.b]
    if (!na || !nb || !wallGeoms[w.id]) continue
    const dx = nb.x - na.x
    const dy = nb.y - na.y
    if (Math.hypot(dx, dy) < 1e-6) continue
    const i = hes.length
    const h1: HalfEdge = { id: i, from: w.a, to: w.b, wall: w, ab: true, twin: i + 1, ang: Math.atan2(dy, dx), pos: 0 }
    const h2: HalfEdge = { id: i + 1, from: w.b, to: w.a, wall: w, ab: false, twin: i, ang: Math.atan2(-dy, -dx), pos: 0 }
    hes.push(h1, h2)
    let la = out.get(w.a)
    if (!la) out.set(w.a, (la = []))
    la.push(h1)
    let lb = out.get(w.b)
    if (!lb) out.set(w.b, (lb = []))
    lb.push(h2)
    if (!parent.has(w.a)) parent.set(w.a, w.a)
    if (!parent.has(w.b)) parent.set(w.b, w.b)
    const ra = findRoot(parent, w.a)
    const rb = findRoot(parent, w.b)
    if (ra !== rb) parent.set(ra, rb)
  }
  if (hes.length === 0) return []
  for (const list of out.values()) {
    list.sort((p, q) => p.ang - q.ang || (p.wall.id < q.wall.id ? -1 : p.wall.id > q.wall.id ? 1 : 0))
    list.forEach((h, k) => {
      h.pos = k
    })
  }
  const next = (h: HalfEdge): HalfEdge => {
    const t = hes[h.twin]
    const list = out.get(t.from) as HalfEdge[]
    return list[(t.pos - 1 + list.length) % list.length]
  }

  // ── cycles ──
  const seen = new Uint8Array(hes.length)
  const cycles: Cycle[] = []
  for (const h0 of hes) {
    if (seen[h0.id]) continue
    const cyc: HalfEdge[] = []
    let h = h0
    let guard = 0
    let closed = true
    do {
      seen[h.id] = 1
      cyc.push(h)
      h = next(h)
      if (++guard > hes.length) {
        closed = false
        break
      }
    } while (h !== h0)
    if (!closed) continue
    let area = 0
    for (const e of cyc) {
      const p = doc.nodes[e.from]
      const q = doc.nodes[e.to]
      area += p.x * q.y - q.x * p.y
    }
    cycles.push({ hes: cyc, area: area / 2, comp: findRoot(parent, cyc[0].from) })
  }

  // ── classification ──
  const faces: Face[] = []
  const outerOfComp = new Map<Id, Cycle>()
  for (const c of cycles) {
    if (c.area > AREA_EPS) {
      const edges: RoomBoundaryEdge[] = []
      const polygon = sideRing(c.hes, wallGeoms, edges)
      const ringArea = polygon.length >= 3 ? polygonArea(polygon) : 0
      if (ringArea <= 0) continue
      const ids = pruneSpurs(c.hes.map((h) => h.from))
      faces.push({
        cycle: c,
        polygon,
        ringArea,
        holes: [],
        holeArea: 0,
        edges,
        centerline: ids.map((id) => ({ x: doc.nodes[id].x, y: doc.nodes[id].y })),
        nodeKey: ids.slice().sort().join('|'),
      })
    } else {
      const cur = outerOfComp.get(c.comp)
      if (!cur || c.area < cur.area) outerOfComp.set(c.comp, c)
    }
  }

  // ── islands → holes of the innermost containing face ──
  for (const [comp, c] of outerOfComp) {
    const edges: RoomBoundaryEdge[] = []
    const ring = sideRing(c.hes, wallGeoms, edges)
    // an island made only of virtual walls has no footprint and is no hole
    if (ring.length < 3) continue
    const area = Math.abs(polygonArea(ring))
    if (area < 1) continue
    const probe = ring[0]
    let best: Face | null = null
    for (const f of faces) {
      if (f.cycle.comp === comp) continue
      if (best && f.ringArea >= best.ringArea) continue
      if (pointInPolygon(probe, f.polygon)) best = f
    }
    if (!best) continue
    best.holes.push(ring)
    best.holeArea += area
    for (const e of edges) best.edges.push(e)
  }

  // ── match Room records by anchor ──
  const records: Room[] = []
  for (const id in doc.rooms) if (doc.rooms[id].levelId === levelId) records.push(doc.rooms[id])

  const result: DerivedRoom[] = []
  const usedAuto = new Set<string>()
  const prepared: { face: Face; area: number; labelPoint: Vec2 }[] = []
  for (const f of faces) {
    const area = f.ringArea - f.holeArea
    if (area < MIN_FACE_AREA) continue
    prepared.push({ face: f, area, labelPoint: polylabel(f.polygon, f.holes) })
  }
  const winner = new Map<Face, Room>()
  for (const r of records) {
    if (!r.anchor || !Number.isFinite(r.anchor.x) || !Number.isFinite(r.anchor.y)) continue
    let hit: { face: Face; area: number; labelPoint: Vec2 } | null = null
    for (const p of prepared) {
      if (hit && p.area >= hit.area) continue
      if (pointInPolygon(r.anchor, p.face.polygon, p.face.holes)) hit = p
    }
    if (!hit) continue
    const cur = winner.get(hit.face)
    if (!cur) {
      winner.set(hit.face, r)
      continue
    }
    // two records in one face (rooms merged): a real room beats a technical void (a cutout whose
    // walls were removed is floor of the room again, not a shaft the size of the room); otherwise
    // the one closest to the label point survives
    if (!r.technical !== !cur.technical) {
      if (cur.technical) winner.set(hit.face, r)
      continue
    }
    const dNew = dist(r.anchor, hit.labelPoint)
    const dCur = dist(cur.anchor, hit.labelPoint)
    if (dNew < dCur - 1e-9 || (Math.abs(dNew - dCur) <= 1e-9 && r.id < cur.id)) winner.set(hit.face, r)
  }

  for (const p of prepared) {
    const f = p.face
    const rec = winner.get(f)
    let roomId: Id
    if (rec) {
      roomId = rec.id
    } else {
      let key = `auto_${hashString(`${levelId}:${f.nodeKey}`)}`
      while (usedAuto.has(key)) key += 'x'
      usedAuto.add(key)
      roomId = key
    }
    let perimeter = polygonPerimeter(f.polygon)
    for (const h of f.holes) perimeter += polygonPerimeter(h)
    result.push({
      roomId,
      levelId,
      polygon: f.polygon,
      holes: f.holes,
      centerline: f.centerline,
      edges: f.edges,
      area: p.area / 1e6,
      perimeter: perimeter / 1000,
      labelPoint: p.labelPoint,
    })
  }
  return result
}

/** true for the temporary ids given to faces that have no Room record */
export function isAutoRoomId(id: Id): boolean {
  return id.startsWith('auto_')
}
