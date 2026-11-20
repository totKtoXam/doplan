// Random PlanSpecs without cutouts and a canonical digest of what the compiler builds from them.
// The digest (legacyPlans.a56f5f4.json) was produced by the a56f5f4 compiler — the code before the
// cutout work — from these very specs; planspecLegacy.test.ts checks that the current public entry
// builds every one of them bit for bit the same. Pure module: the compiler is passed in, so the same
// code digests both trees.
type P = [number, number]
type Box = { x0: number; y0: number; x1: number; y1: number }

const orient =
  (o: number) =>
  (p: P): P => {
    let [x, y] = p
    if (o & 4) x = -x
    for (let k = 0; k < (o & 3); k++) [x, y] = [-y, x]
    return [x, y]
  }

/** a seeded random plan: an L / T / rectangular main room, up to six neighbours on its sides or on each
 *  other's (open plan at 0 mm, partitions at 40–120 mm, exterior gaps up to 700 mm), balconies and
 *  loggias, some neighbours notched into an L, exterior walls 200–640 mm, doors, windows, labelled
 *  areas. On top (a second random stream, see addExtras): spec walls — closed boxes and columns free
 *  in a room, set against its wall or overlapping it, open partitions, an L-shaped one —, fixtures,
 *  edge walls of balconies, snap settings, dimension sources, and some plans drawn in walls mode (an
 *  exterior loop, partitions, rooms by label point). The whole plan is turned into one of the 8
 *  orientations */
export function legacyPlan(seedIn: number): Record<string, unknown> {
  let seed = (seedIn * 7919 + 101) % 2147483648
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
  const g = (lo: number, hi: number, st = 50): number => Math.round((lo + rnd() * (hi - lo)) / st) * st
  const T = rnd() < 0.5 ? pick([200, 250, 300, 380, 400, 510, 640]) : g(200, 640, 10)
  const part = pick([80, 100, 100, 120])
  const nRooms = 1 + Math.floor(rnd() * 7)
  const rooms: Record<string, unknown>[] = []
  const openings: Record<string, unknown>[] = []
  const boxes: Box[] = []
  const types = ['living', 'bedroom', 'kitchen', 'kitchenLiving', 'bathroom', 'toilet', 'hallway', 'corridor', 'storage', 'wardrobe', 'kids', 'office']
  const W = g(2500, 6500)
  const H = g(2500, 5500)
  const sh = rnd()
  let main: P[]
  if (sh < 0.3) {
    const nx = g(1000, W - 1000)
    const ny = g(1000, H - 1000)
    const c = Math.floor(rnd() * 4)
    main = [[0, 0], [nx, 0], [nx, ny], [W, ny], [W, H], [0, H]]
    if (c === 1) main = [[0, 0], [W, 0], [W, H], [nx, H], [nx, ny], [0, ny]]
    if (c === 2) main = [[0, 0], [W, 0], [W, ny], [nx, ny], [nx, H], [0, H]]
    if (c === 3) main = [[nx, 0], [W, 0], [W, H], [0, H], [0, ny], [nx, ny]]
  } else if (sh < 0.5) {
    const h1 = g(1000, H - 1000)
    const x1 = g(500, W / 2 - 300)
    const x2 = g(W / 2 + 300, W - 500)
    main = [[0, 0], [W, 0], [W, h1], [x2, h1], [x2, H], [x1, H], [x1, h1], [0, h1]]
  } else main = [[0, 0], [W, 0], [W, H], [0, H]]
  const a: Record<string, unknown> = { id: 'a', type: pick(['living', 'living', 'kitchenLiving', 'hallway']) }
  if (main.length === 4 && rnd() < 0.7) a.rect = [0, 0, W, H]
  else a.polygon = main
  rooms.push(a)
  boxes.push({ x0: 0, y0: 0, x1: W, y1: H })
  const overlaps = (b: Box, m: number): boolean => boxes.some((o) => b.x0 < o.x1 + m && b.x1 > o.x0 - m && b.y0 < o.y1 + m && b.y1 > o.y0 - m)
  let tries = 0
  while (rooms.length < nRooms && tries++ < 80) {
    const base = boxes[Math.floor(rnd() * boxes.length)]
    const side = Math.floor(rnd() * 4)
    const r0 = rnd()
    const gap = r0 < 0.25 ? 0 : r0 < 0.4 ? pick([40, 60, 80, 95, 100, 120]) : g(40, 700, 10)
    const balcony = rnd() < 0.15
    const d = balcony ? g(900, 1600) : g(1200, 4000)
    const along = side < 2 ? base.x1 - base.x0 : base.y1 - base.y0
    const len = pick([along, along, g(1200, along + 600), g(1500, 4500)])
    const off = pick([0, 0, along - len, g(-400, 400, 10), g(0, Math.max(0, along - len), 10)])
    let b: Box
    if (side === 0) b = { x0: base.x0 + off, y0: base.y0 - gap - d, x1: base.x0 + off + len, y1: base.y0 - gap }
    else if (side === 1) b = { x0: base.x0 + off, y0: base.y1 + gap, x1: base.x0 + off + len, y1: base.y1 + gap + d }
    else if (side === 2) b = { x0: base.x0 - gap - d, y0: base.y0 + off, x1: base.x0 - gap, y1: base.y0 + off + len }
    else b = { x0: base.x1 + gap, y0: base.y0 + off, x1: base.x1 + gap + d, y1: base.y0 + off + len }
    if (b.x1 - b.x0 < 800 || b.y1 - b.y0 < 800) continue
    if (overlaps({ x0: b.x0 + 1, y0: b.y0 + 1, x1: b.x1 - 1, y1: b.y1 - 1 }, gap > 0 ? Math.min(gap, 39) - 1 : 0)) continue
    const room: Record<string, unknown> = { id: String.fromCharCode(97 + rooms.length), type: balcony ? pick(['balcony', 'loggia']) : pick(types) }
    const w = b.x1 - b.x0
    const h = b.y1 - b.y0
    if (!balcony && w >= 2000 && h >= 2000 && rnd() < 0.2) {
      // an L: one corner notched off (the notch stays inside the box, so nothing overlaps)
      const nx = g(800, w - 800)
      const ny = g(800, h - 800)
      const c = Math.floor(rnd() * 4)
      const [x0, y0, x1, y1] = [b.x0, b.y0, b.x1, b.y1]
      const X = x0 + nx
      const Y = y0 + ny
      room.polygon =
        c === 0
          ? [[x0, y0], [X, y0], [X, Y], [x1, Y], [x1, y1], [x0, y1]]
          : c === 1
            ? [[x0, y0], [x1, y0], [x1, y1], [X, y1], [X, Y], [x0, Y]]
            : c === 2
              ? [[x0, y0], [x1, y0], [x1, Y], [X, Y], [X, y1], [x0, y1]]
              : [[X, y0], [x1, y0], [x1, y1], [x0, y1], [x0, Y], [X, Y]]
    } else room.rect = [b.x0, b.y0, w, h]
    if (balcony && rnd() < 0.3) room.glazed = true
    if (rnd() < 0.2) room.labelledArea = Math.round(((w * h) / 1e6) * (0.9 + rnd() * 0.15) * 10) / 10
    rooms.push(room)
    boxes.push(b)
  }
  // a door on the main room's first side, a window on its third, sometimes a door into a neighbour
  const mid = (p: P, q: P): P => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
  if (rnd() < 0.7) openings.push({ type: 'entranceDoor', at: mid(main[0], main[1]), width: 900 })
  if (rnd() < 0.6) openings.push({ type: 'window', at: mid(main[2], main[3]), width: pick([900, 1200, 1500]) })
  if (rooms.length > 1 && rnd() < 0.5) {
    const n = boxes[1]
    openings.push({ type: 'door', at: [(n.x0 + n.x1) / 2, n.y0], width: 800 })
  }
  if (rnd() < 0.2) a.labelledArea = Math.round(((W * H) / 1e6) * (0.85 + rnd() * 0.2) * 10) / 10
  const o8 = Math.floor(rnd() * 8)
  const extra = addExtras(seedIn, rooms, boxes, main, T, part)
  const f = orient(o8)
  for (const r of rooms) {
    if (r.rect) {
      const [x, y, w, h] = r.rect as number[]
      const p = f([x, y])
      const q = f([x + w, y + h])
      r.rect = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])]
    }
    if (r.polygon) r.polygon = (r.polygon as P[]).map(f)
  }
  for (const o of openings) o.at = f(o.at as P)
  for (const r of extra.rooms) if (r.at) r.at = f(r.at as P)
  for (const w of extra.walls) w.path = (w.path as P[]).map(f)
  for (const x of extra.fixtures) {
    const [rx, ry, rw, rh] = x.rect as number[]
    const p = f([rx, ry])
    const q = f([rx + rw, ry + rh])
    x.rect = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])]
  }
  return {
    version: 1,
    units: 'mm',
    defaults: { exteriorThickness: T, partitionThickness: part, loadBearingThickness: pick([200, 250, 300]) },
    ...(extra.snap ? { snap: extra.snap } : {}),
    ...(extra.dimSource ? { dimSource: extra.dimSource } : {}),
    ...(extra.walls.length ? { walls: extra.walls } : {}),
    rooms: extra.rooms,
    openings,
    ...(extra.fixtures.length ? { fixtures: extra.fixtures } : {}),
  }
}

type Rec = Record<string, unknown>
/** the second random stream of legacyPlan (the rooms and openings of a seed stay as they were) */
function addExtras(seedIn: number, rooms: Rec[], boxes: Box[], main: P[], T: number, part: number) {
  let seed = (seedIn * 104729 + 7) % 2147483648
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <X>(a: X[]): X => a[Math.floor(rnd() * a.length)]
  const g = (lo: number, hi: number, st = 50): number => Math.round((lo + rnd() * (hi - lo)) / st) * st
  const walls: Rec[] = []
  const fixtures: Rec[] = []
  let out = rooms
  // walls mode: a rectangular main room drawn as an exterior loop split by a partition, the rooms
  // found by their label points (what `dp doc spec` and hand-drawn projects give)
  if (main.length === 4 && rnd() < 0.15) {
    const { x1: W, y1: H } = boxes[0]
    const X = g(1000, W - 1000)
    walls.push({ id: 'ext', path: [[0, 0], [W, 0], [W, H], [0, H]], closed: true, align: 'inner', thickness: T, kind: 'exterior' })
    walls.push({ id: 'p0', path: [[X, 0], [X, H]], thickness: part, kind: pick(['partition', 'loadBearing', 'glass']) })
    out = [
      { id: 'a', type: rooms[0].type, at: [X / 2, H / 2] },
      { id: 'b', type: pick(['bedroom', 'kitchen', 'office']), at: [(X + W) / 2, H / 2] },
    ]
    boxes = [{ x0: 0, y0: 0, x1: X, y1: H }, { x0: X, y0: 0, x1: W, y1: H }]
  }
  // islands: closed boxes / columns free in a room, set against its wall, or overlapping it
  const nIsl = rnd() < 0.45 ? 1 + Math.floor(rnd() * 3) : 0
  for (let k = 0; k < nIsl; k++) {
    const i = Math.floor(rnd() * boxes.length)
    const b = boxes[i]
    if (i === 0 && main.length !== 4) continue
    const sw = g(300, 1200)
    const sh = g(300, 1200)
    const t = pick([80, 100, 120, 200, 250])
    if (b.x1 - b.x0 < sw + 700 || b.y1 - b.y0 < sh + 700) continue
    let x = g(b.x0 + 300, b.x1 - 300 - sw, 10)
    let y = g(b.y0 + 300, b.y1 - 300 - sh, 10)
    if (rnd() < 0.6) {
      // against one side: the box's centreline `off` mm from the clear face (under t/2 it overlaps)
      const off = pick([-100, -50, 0, 20, 50, 100, 170, 180, 200, 300])
      const side = Math.floor(rnd() * 4)
      if (side === 0) y = b.y0 + off
      else if (side === 1) y = b.y1 - off - sh
      else if (side === 2) x = b.x0 + off
      else x = b.x1 - off - sw
      if (rnd() < 0.3) {
        // in a corner
        if (side < 2) x = rnd() < 0.5 ? b.x0 + off : b.x1 - off - sw
        else y = rnd() < 0.5 ? b.y0 + off : b.y1 - off - sh
      }
    }
    const w: Rec = { id: `i${k}`, path: [[x, y], [x + sw, y], [x + sw, y + sh], [x, y + sh]], closed: true, thickness: t }
    if (rnd() < 0.3) w.align = pick(['inner', 'outer', 'center'])
    if (rnd() < 0.4) w.kind = pick(['partition', 'loadBearing', 'separator'])
    if (rnd() < 0.2) w.height = pick([1200, 2100, 2700])
    walls.push(w)
  }
  // open partitions from a wall into the room: dangling, across, or an L
  const nPart = rnd() < 0.35 ? 1 + Math.floor(rnd() * 2) : 0
  for (let k = 0; k < nPart; k++) {
    const i = Math.floor(rnd() * boxes.length)
    const b = boxes[i]
    if (i === 0 && main.length !== 4) continue
    if (b.x1 - b.x0 < 1600 || b.y1 - b.y0 < 1600) continue
    const vertical = rnd() < 0.5
    const across = rnd() < 0.4
    let path: P[]
    if (vertical) {
      const X = g(b.x0 + 600, b.x1 - 600, 10)
      path = [[X, b.y0], [X, across ? b.y1 : g(b.y0 + 600, b.y1 - 400, 10)]]
    } else {
      const Y = g(b.y0 + 600, b.y1 - 600, 10)
      path = [[b.x0, Y], [across ? b.x1 : g(b.x0 + 600, b.x1 - 400, 10), Y]]
    }
    if (!across && rnd() < 0.3) {
      const e = path[1]
      path.push(vertical ? [Math.min(b.x1 - 200, e[0] + g(400, 1200)), e[1]] : [e[0], Math.min(b.y1 - 200, e[1] + g(400, 1200))])
    }
    walls.push({ id: `p${k + 1}`, path, thickness: pick([50, 80, 100, 120]), kind: pick(['partition', 'partition', 'glass', 'separator', 'railing']) })
  }
  // fixtures and furniture inside a room
  const nFix = rnd() < 0.4 ? 1 + Math.floor(rnd() * 4) : 0
  for (let k = 0; k < nFix; k++) {
    const b = boxes[Math.floor(rnd() * boxes.length)]
    const fw = g(300, 1800)
    const fh = g(300, 900)
    if (b.x1 - b.x0 < fw + 200 || b.y1 - b.y0 < fh + 200) continue
    const types = ['toilet', 'bathtub', 'sink', 'stove', 'riser', 'shower', 'washer', 'fridge', 'wardrobe', 'bed', 'sofa', 'table']
    const x: Rec = { type: pick(types), rect: [g(b.x0 + 100, b.x1 - 100 - fw, 10), g(b.y0 + 100, b.y1 - 100 - fh, 10), fw, fh] }
    if (rnd() < 0.3) x.rotation = pick([90, 180, 270])
    if (rnd() < 0.15) x.elevation = pick([400, 800])
    fixtures.push(x)
  }
  // edge walls of balconies, dimension sources, snap settings
  // a measured dimension is stamped with the day it was measured (today when none is given): a fixed one
  const sources = ['plan', 'derived', 'estimated', { source: 'measured', date: '2026-11-01' }, 'drawn']
  for (const r of out) {
    if ((r.type === 'balcony' || r.type === 'loggia') && rnd() < 0.4) r.edgeWall = { kind: pick(['railing', 'glass', 'parapet']), thickness: pick([50, 100, 150]) }
    if (rnd() < 0.1) r.source = pick(sources)
    if (rnd() < 0.05) r.ceilingHeight = pick([2500, 3000])
  }
  const snap =
    rnd() < 0.2
      ? { gridMm: pick([10, 50]), orthogonal: rnd() < 0.7, ...(rnd() < 0.5 ? { mergeMm: pick([60, 150, 300]) } : {}), ...(rnd() < 0.3 ? { standardThickness: false } : {}) }
      : undefined
  const dimSource = rnd() < 0.15 ? pick(sources) : undefined
  return { rooms: out, walls, fixtures, snap, dimSource }
}

export interface DigestApi {
  parse: (spec: unknown) => unknown
  validate: (spec: unknown) => { ok: boolean; issues: { severity: string; code: string }[] }
  compile: (spec: unknown) => { doc: { nodes: object; walls: object; rooms: object; openings: object } & Record<string, unknown>; levelId: string; issues: unknown[]; roomIds: Record<string, string> }
  derive: (doc: never, levelId: string) => unknown
}

/** cyrb53: a 53-bit string hash (pure, no node:crypto) */
function hash(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export interface PlanDigest {
  seed: number
  /** hashes of the canonical walls (ends, thickness, height, kind, openings in them), the derived faces
   *  (outline, holes, area, perimeter; wall outlines), the issues (the check's and the compiler's), the
   *  whole built doc but its meta (every collection and field: room records, items, materials…) and the
   *  whole derived plan with the room ids the compiler reports */
  hash: { walls: string; faces: string; issues: string; doc: string; plan: string }
  walls: number
  faces: number
  /** spec room id → floor area, m² */
  areas: Record<string, number>
  issues: string[]
}

/** what the compiler builds from a spec, with the random ids replaced by their order of appearance */
export function digestPlan(seed: number, spec: unknown, api: DigestApi): PlanDigest {
  const v = api.validate(spec)
  const res = api.compile(api.parse(spec))
  type Rec = Record<string, Record<string, unknown>>
  const doc = res.doc as unknown as Record<string, Rec>
  const plan = api.derive(res.doc as never, res.levelId) as { rooms: { roomId: string; area: number }[]; wallGeoms: unknown }
  const ids = new Set<string>()
  for (const v of Object.values(doc)) if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of Object.keys(v)) if (/^[a-z]+_[A-Za-z0-9_-]{10}$/.test(k)) ids.add(k)
  // only what the compiler decides: fields the editor's defaults add (materials, render settings) are left out
  const pickOf = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))
  const node = (id: unknown): unknown => {
    const n = doc.nodes[id as string]
    return n ? [n.x, n.y] : null
  }
  const walls = Object.values(doc.walls).map((w) => ({ ...pickOf(w, ['id', 'thickness', 'height', 'kind', 'offset', 'justify']), a: node(w.a), b: node(w.b) }))
  const openings = Object.values(doc.openings).map((o) => pickOf(o, ['wallId', 'kind', 'offset', 'width', 'height', 'sill', 'hinge', 'swing']))
  const rooms = Object.values(doc.rooms).map((r) => pickOf(r, ['id', 'name', 'type', 'anchor', 'technical', 'outdoor', 'areaCoef', 'labelledArea']))
  const names = new Map<string, string>()
  const canon = (x: unknown): unknown => {
    if (typeof x === 'string') {
      if (!ids.has(x) && !/^auto_/.test(x)) return x
      if (!names.has(x)) names.set(x, `#${names.size}`)
      return names.get(x)
    }
    if (Array.isArray(x)) return x.map(canon)
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, y] of Object.entries(x)) o[(canon(k) as string) ?? k] = canon(y)
      return o
    }
    return x
  }
  const issues = [...v.issues, ...(res.issues as { severity: string; code: string }[])]
  const part = (x: unknown): string => hash(JSON.stringify(canon(x)))
  // meta holds the doc's name, a random id and the time of the build: all else is compared
  const whole: Record<string, unknown> = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'meta'))
  // the render settings as a56f5f4 wrote them: its always-on `ao` and the screen-space passes since
  // removed stood where the switch `occlusion` (off by default) stands now
  if (whole.render) {
    whole.render = Object.fromEntries(
      Object.entries(whole.render as Record<string, unknown>).flatMap(([k, v]): [string, unknown][] =>
        k === 'occlusion' ? [['ao', true], ['ssgi', false], ['ssr', false]] : [[k, v]],
      ),
    )
  }
  const h = {
    walls: part({ walls, openings }),
    faces: part({ rooms, faces: plan.rooms.map((x) => pickOf(x as unknown as Record<string, unknown>, ['roomId', 'levelId', 'polygon', 'holes', 'centerline', 'edges', 'area', 'perimeter', 'labelPoint'])), wallGeoms: plan.wallGeoms, roomIds: res.roomIds }),
    issues: part(issues),
    doc: part(whole),
    // every field of the derived plan but the faces' \`nodes\` (the node ids of a face's loop, added for
    // the voids that follow their walls: a56f5f4 has no such field)
    plan: part({ plan: { ...plan, rooms: plan.rooms.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'nodes'))) }, roomIds: res.roomIds, levelId: res.levelId }),
  }
  const areas: Record<string, number> = {}
  for (const [sid, rid] of Object.entries(res.roomIds)) {
    const face = plan.rooms.find((x) => x.roomId === rid)
    areas[sid] = face ? face.area : -1
  }
  return {
    seed,
    hash: h,
    walls: Object.keys(res.doc.walls).length,
    faces: plan.rooms.length,
    areas,
    issues: issues.map((i) => `${i.severity}:${i.code}`),
  }
}
