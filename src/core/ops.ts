/**
 * Document operations. Every function mutates the passed Doc IN PLACE (it is called on an Immer
 * draft inside `docStore.transact`) and returns the ids it created. Writes are skipped when a value
 * does not change, so the resulting patch sets stay minimal.
 */
import { DEFAULT_MATERIALS, OPENING_DEFAULTS, ROOM_TYPE_NAMES, defaultRoom, defaultWallSide } from './defaults'
import { EPS, dist, projectOnSegment, segIntersect } from './geom'
import { newId } from './ids'
import { computeWallGeoms } from './joins'
import { MIN_ROOM_AREA_M2, detectRooms, isAutoRoomId } from './rooms'
import { inheritVariantFinish, pruneVariants } from './variants'
import type {
  Asset,
  Doc,
  EntityRef,
  FinishZone,
  Id,
  Item,
  Light,
  LightKind,
  Opening,
  OpeningKind,
  PlanNode,
  Vec2,
  Wall,
  WallSide,
} from './types'

/**
 * Contract extension: a node created by an explicit user split (`splitWall`) is pinned and is never
 * removed by the automatic "merge collinear walls" step of `normalize`. Stored as an extra JSON field.
 */
export type PinnedNode = PlanNode & { pinned?: boolean }

/** max deviation (mm) of a degree-2 node from the straight line for its two walls to be merged */
const COLLINEAR_TOL = 0.1

// ───────────────────────────── small helpers ─────────────────────────────

function nodePos(doc: Doc, id: Id): Vec2 {
  const n = doc.nodes[id]
  return n ? { x: n.x, y: n.y } : { x: 0, y: 0 }
}

/** Centreline length of a wall, mm (0 when a node is missing). */
export function wallLength(doc: Doc, wall: Wall): number {
  const a = doc.nodes[wall.a]
  const b = doc.nodes[wall.b]
  if (!a || !b) return 0
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Walls incident to a node. */
export function wallsAtNode(doc: Doc, nodeId: Id): Wall[] {
  const out: Wall[] = []
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.a === nodeId || w.b === nodeId) out.push(w)
  }
  return out
}

/** The wall connecting two nodes (in any direction), if any. */
export function findWallBetween(doc: Doc, n1: Id, n2: Id): Wall | undefined {
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if ((w.a === n1 && w.b === n2) || (w.a === n2 && w.b === n1)) return w
  }
  return undefined
}

/** Openings hosted by a wall, sorted by offset. */
export function openingsOfWall(doc: Doc, wallId: Id): Opening[] {
  const out: Opening[] = []
  for (const id in doc.openings) if (doc.openings[id].wallId === wallId) out.push(doc.openings[id])
  return out.sort((p, q) => p.offset - q.offset)
}

function levelWalls(doc: Doc, levelId: Id): Wall[] {
  const out: Wall[] = []
  for (const id in doc.walls) if (doc.walls[id].levelId === levelId) out.push(doc.walls[id])
  return out
}

function cloneSide(s: WallSide | undefined): WallSide {
  if (!s) return defaultWallSide()
  const out: WallSide = { materialId: s.materialId }
  if (s.zones && s.zones.length) out.zones = s.zones.map((z) => ({ from: z.from, to: z.to, materialId: z.materialId }))
  return out
}

function sideEquals(a: WallSide | undefined, b: WallSide | undefined): boolean {
  if (!a || !b) return a === b
  if (a.materialId !== b.materialId) return false
  const za = a.zones ?? []
  const zb = b.zones ?? []
  if (za.length !== zb.length) return false
  for (let i = 0; i < za.length; i++) {
    if (za[i].from !== zb[i].from || za[i].to !== zb[i].to || za[i].materialId !== zb[i].materialId) return false
  }
  return true
}

/** Mirrors an opening when its host wall direction is reversed (a ↔ b). */
function flipOpening(o: Opening): void {
  o.hinge = o.hinge === 'a' ? 'b' : 'a'
  o.swing = o.swing === 'left' ? 'right' : 'left'
  if (o.curtain) o.curtain.side = o.curtain.side === 'left' ? 'right' : 'left'
}

function setNum<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): void {
  if (obj[key] !== value) obj[key] = value
}

/** Keeps an opening inside its wall: width ≤ wall length, centre within [w/2, len − w/2]. */
function clampOpening(doc: Doc, o: Opening): void {
  const wall = doc.walls[o.wallId]
  if (!wall) return
  const length = wallLength(doc, wall)
  if (!Number.isFinite(o.width) || o.width <= 0) o.width = OPENING_DEFAULTS[o.kind]?.width ?? 800
  if (o.width > length) setNum(o, 'width', Math.max(1, length))
  const half = o.width / 2
  const off = Number.isFinite(o.offset) ? o.offset : length / 2
  setNum(o, 'offset', Math.min(Math.max(off, half), Math.max(half, length - half)))
  if (!Number.isFinite(o.sill) || o.sill < 0) o.sill = 0
  if (!Number.isFinite(o.height) || o.height <= 0) o.height = OPENING_DEFAULTS[o.kind]?.height ?? 2100
  if (wall.height > 0 && o.sill + o.height > wall.height) {
    if (o.sill >= wall.height - 100) setNum(o, 'sill', Math.max(0, wall.height - Math.min(o.height, wall.height)))
    if (o.sill + o.height > wall.height) setNum(o, 'height', Math.max(1, wall.height - o.sill))
  }
}

function findNodeNear(doc: Doc, levelId: Id, p: Vec2, tol = EPS): Id | null {
  let best: Id | null = null
  let bestD = tol
  for (const id in doc.nodes) {
    const n = doc.nodes[id]
    if (n.levelId !== levelId) continue
    const d = Math.hypot(n.x - p.x, n.y - p.y)
    if (d <= bestD) {
      bestD = d
      best = id
    }
  }
  return best
}

function createNode(doc: Doc, levelId: Id, p: Vec2, pinned = false): Id {
  const n: PinnedNode = { id: newId('n'), levelId, x: p.x, y: p.y }
  if (pinned) n.pinned = true
  doc.nodes[n.id] = n
  return n.id
}

/**
 * Splits `wall` at an existing node located `s` mm from its `a` end. The wall keeps a → node,
 * a new wall (same props, cloned finishes) takes node → b; openings follow their centre.
 */
function splitWallAtNode(doc: Doc, wall: Wall, nodeId: Id, s: number): Id {
  const w2: Wall = {
    id: newId('w'),
    levelId: wall.levelId,
    a: nodeId,
    b: wall.b,
    thickness: wall.thickness,
    height: wall.height,
    kind: wall.kind,
    left: cloneSide(wall.left),
    right: cloneSide(wall.right),
  }
  // the face provenance travels with both halves; each half's recorded length no longer matches,
  // so a split dimension shows as changed until it is measured again (see core/provenance)
  if (wall.dims) w2.dims = JSON.parse(JSON.stringify(wall.dims)) as NonNullable<Wall['dims']>
  doc.walls[w2.id] = w2
  inheritVariantFinish(doc, 'walls', wall.id, w2.id)
  wall.b = nodeId
  for (const id in doc.openings) {
    const o = doc.openings[id]
    if (o.wallId !== wall.id) continue
    if (o.offset >= s) {
      o.wallId = w2.id
      o.offset -= s
    }
  }
  for (const id in doc.openings) {
    const o = doc.openings[id]
    if (o.wallId === wall.id || o.wallId === w2.id) clampOpening(doc, o)
  }
  return w2.id
}

function splitWallInternal(doc: Doc, wall: Wall, at: Vec2, pinned: boolean): Id {
  const a = nodePos(doc, wall.a)
  const b = nodePos(doc, wall.b)
  const length = dist(a, b)
  const pr = projectOnSegment(at, a, b)
  const s = pr.t * length
  if (s <= EPS) return wall.a
  if (s >= length - EPS) return wall.b
  const nodeId = createNode(doc, wall.levelId, pr.point, pinned)
  splitWallAtNode(doc, wall, nodeId, s)
  return nodeId
}

// ───────────────────────────── walls ─────────────────────────────

type WallTemplate = Pick<Wall, 'thickness' | 'height' | 'kind' | 'left' | 'right'>

interface ChainPiece {
  wallId: Id
  /** distances from the start of the inserted segment, mm */
  from: number
  to: number
  created: boolean
  /** the wall runs against the direction of the inserted segment */
  reversed: boolean
}

/** existing node within EPS → that node; point on a wall → T-insertion (wall is split); else a new node */
function resolveEndpoint(doc: Doc, levelId: Id, p: Vec2): Id {
  const near = findNodeNear(doc, levelId, p)
  if (near) return near
  let bestWall: Wall | null = null
  let bestD = EPS
  for (const w of levelWalls(doc, levelId)) {
    const a = doc.nodes[w.a]
    const b = doc.nodes[w.b]
    if (!a || !b) continue
    const pr = projectOnSegment(p, a, b)
    if (pr.dist <= bestD) {
      bestD = pr.dist
      bestWall = w
    }
  }
  if (bestWall) return splitWallInternal(doc, bestWall, p, false)
  return createNode(doc, levelId, p)
}

/**
 * Inserts a straight wall p1 → p2 keeping the graph planar: end points snap to nodes or split the
 * wall they touch, crossed walls are split at the crossing, nodes lying on the segment become joints.
 * Stretches already covered by a wall are not duplicated.
 */
function insertSegment(doc: Doc, levelId: Id, p1: Vec2, p2: Vec2, tpl: WallTemplate): ChainPiece[] {
  if (!doc.levels[levelId]) throw new Error(`Уровень не найден: ${levelId}`)
  if (![p1.x, p1.y, p2.x, p2.y].every(Number.isFinite)) throw new Error('Некорректные координаты стены')
  if (dist(p1, p2) <= EPS) return []
  const A = resolveEndpoint(doc, levelId, p1)
  const B = resolveEndpoint(doc, levelId, p2)
  if (A === B) return []
  const pa = nodePos(doc, A)
  const pb = nodePos(doc, B)
  const L = dist(pa, pb)
  if (L <= EPS) return []

  // split every wall properly crossed by the new segment
  for (const w of levelWalls(doc, levelId)) {
    if (w.a === A || w.b === A || w.a === B || w.b === B) continue
    const wa = nodePos(doc, w.a)
    const wb = nodePos(doc, w.b)
    const hit = segIntersect(pa, pb, wa, wb)
    if (!hit) continue
    const wl = dist(wa, wb)
    const sW = hit.u * wl
    const sN = hit.t * L
    if (sW <= EPS || sW >= wl - EPS) continue // passes through an existing node of w
    if (sN <= EPS || sN >= L - EPS) continue
    splitWallInternal(doc, w, hit.point, false)
  }

  // every node lying on the segment becomes a joint of the chain
  const joints: { id: Id; s: number }[] = []
  for (const id in doc.nodes) {
    if (id === A || id === B) continue
    const n = doc.nodes[id]
    if (n.levelId !== levelId) continue
    const pr = projectOnSegment(n, pa, pb)
    const s = pr.t * L
    if (pr.dist <= EPS && s > EPS && s < L - EPS) joints.push({ id, s })
  }
  joints.sort((p, q) => p.s - q.s)
  const chain: { id: Id; s: number }[] = [{ id: A, s: 0 }, ...joints, { id: B, s: L }]

  const pieces: ChainPiece[] = []
  for (let i = 0; i + 1 < chain.length; i++) {
    const u = chain[i]
    const v = chain[i + 1]
    if (u.id === v.id) continue
    const existing = findWallBetween(doc, u.id, v.id)
    if (existing) {
      pieces.push({ wallId: existing.id, from: u.s, to: v.s, created: false, reversed: existing.a !== u.id })
      continue
    }
    const w: Wall = {
      id: newId('w'),
      levelId,
      a: u.id,
      b: v.id,
      thickness: tpl.thickness,
      height: tpl.height,
      kind: tpl.kind,
      left: cloneSide(tpl.left),
      right: cloneSide(tpl.right),
    }
    doc.walls[w.id] = w
    pieces.push({ wallId: w.id, from: u.s, to: v.s, created: true, reversed: false })
  }
  return pieces
}

/**
 * Adds a wall from p1 to p2. Snaps to existing nodes (EPS), splits crossed walls, inserts nodes on
 * the walls its ends touch (openings and finishes of split walls are preserved).
 * Returns the ids of the created wall pieces, ordered from p1 to p2.
 */
export function addWall(
  doc: Doc,
  levelId: Id,
  p1: Vec2,
  p2: Vec2,
  opts?: Partial<Pick<Wall, 'thickness' | 'height' | 'kind'>>,
): Id[] {
  const level = doc.levels[levelId]
  if (!level) throw new Error(`Уровень не найден: ${levelId}`)
  const kind = opts?.kind ?? 'wall'
  const thickness = opts?.thickness ?? doc.settings.wallThickness
  const height = opts?.height ?? level.height ?? doc.settings.wallHeight
  const tpl: WallTemplate = {
    kind,
    thickness: Number.isFinite(thickness) && thickness >= 0 ? thickness : doc.settings.wallThickness,
    height: Number.isFinite(height) && height > 0 ? height : doc.settings.wallHeight,
    left: { materialId: DEFAULT_MATERIALS.wall },
    right: { materialId: DEFAULT_MATERIALS.wall },
  }
  return insertSegment(doc, levelId, p1, p2, tpl)
    .filter((p) => p.created)
    .map((p) => p.wallId)
}

/** Four walls along the rectangle (x, y, w, h) given by wall centrelines. Returns created wall ids. */
export function addRectRoom(
  doc: Doc,
  levelId: Id,
  x: number,
  y: number,
  w: number,
  h: number,
  opts?: Partial<Pick<Wall, 'thickness' | 'height' | 'kind'>>,
): Id[] {
  const x0 = Math.min(x, x + w)
  const x1 = Math.max(x, x + w)
  const y0 = Math.min(y, y + h)
  const y1 = Math.max(y, y + h)
  if (x1 - x0 <= EPS || y1 - y0 <= EPS) return []
  const c = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
  const out: Id[] = []
  for (let i = 0; i < 4; i++) out.push(...addWall(doc, levelId, c[i], c[(i + 1) % 4], opts))
  return out
}

/**
 * Moves several nodes at once. Openings keep their position relative to the end of the wall that
 * did not move (when only node `a` moved the offsets are shifted by the change of length).
 */
export function moveNodes(doc: Doc, moves: Map<Id, Vec2>): void {
  const affected: { wall: Wall; oldLen: number }[] = []
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (moves.has(w.a) || moves.has(w.b)) affected.push({ wall: w, oldLen: wallLength(doc, w) })
  }
  for (const [id, p] of moves) {
    const n = doc.nodes[id]
    if (!n || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    setNum(n, 'x', p.x)
    setNum(n, 'y', p.y)
  }
  for (const { wall, oldLen } of affected) {
    const newLen = wallLength(doc, wall)
    const delta = newLen - oldLen
    const onlyA = moves.has(wall.a) && !moves.has(wall.b)
    for (const id in doc.openings) {
      const o = doc.openings[id]
      if (o.wallId !== wall.id) continue
      if (onlyA && Math.abs(delta) > 1e-9) o.offset += delta
      clampOpening(doc, o)
    }
  }
}

export function moveNode(doc: Doc, nodeId: Id, x: number, y: number): void {
  if (!doc.nodes[nodeId]) return
  moveNodes(doc, new Map([[nodeId, { x, y }]]))
}

/** Translates a wall (both its nodes); connected walls stretch. */
export function moveWall(doc: Doc, wallId: Id, dx: number, dy: number): void {
  const w = doc.walls[wallId]
  if (!w) return
  const a = doc.nodes[w.a]
  const b = doc.nodes[w.b]
  if (!a || !b) return
  const moves = new Map<Id, Vec2>()
  moves.set(w.a, { x: a.x + dx, y: a.y + dy })
  moves.set(w.b, { x: b.x + dx, y: b.y + dy })
  moveNodes(doc, moves)
}

/**
 * Splits a wall at the point of its axis closest to `at`. Returns the id of the node at the split
 * (an existing end node when `at` is within EPS of it). The new node is pinned.
 */
export function splitWall(doc: Doc, wallId: Id, at: Vec2): Id {
  const wall = doc.walls[wallId]
  if (!wall) throw new Error(`Стена не найдена: ${wallId}`)
  return splitWallInternal(doc, wall, at, true)
}

/** Sets the centreline length keeping end `a`, end `b` or the middle in place. */
export function setWallLength(doc: Doc, wallId: Id, lengthMm: number, anchor: 'a' | 'b' | 'center'): void {
  const w = doc.walls[wallId]
  if (!w || !Number.isFinite(lengthMm)) return
  const a = doc.nodes[w.a]
  const b = doc.nodes[w.b]
  if (!a || !b) return
  const target = Math.max(1, lengthMm)
  const cur = Math.hypot(b.x - a.x, b.y - a.y)
  const dx = cur > 1e-9 ? (b.x - a.x) / cur : 1
  const dy = cur > 1e-9 ? (b.y - a.y) / cur : 0
  const moves = new Map<Id, Vec2>()
  if (anchor === 'a') {
    moves.set(w.b, { x: a.x + dx * target, y: a.y + dy * target })
  } else if (anchor === 'b') {
    moves.set(w.a, { x: b.x - dx * target, y: b.y - dy * target })
  } else {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    moves.set(w.a, { x: mx - (dx * target) / 2, y: my - (dy * target) / 2 })
    moves.set(w.b, { x: mx + (dx * target) / 2, y: my + (dy * target) / 2 })
  }
  moveNodes(doc, moves)
}

// ───────────────────────────── openings ─────────────────────────────

const DOOR_KINDS: ReadonlySet<OpeningKind> = new Set(['door', 'doubleDoor', 'slidingDoor', 'entranceDoor', 'balconyDoor'])
const WINDOW_KINDS: ReadonlySet<OpeningKind> = new Set(['window', 'frenchWindow', 'balconyBlock'])

/** Adds an opening whose centre is `offset` mm from node `a` of the wall (clamped to the wall). */
export function addOpening(doc: Doc, wallId: Id, kind: OpeningKind, offset: number, patch?: Partial<Opening>): Id {
  const wall = doc.walls[wallId]
  if (!wall) throw new Error(`Стена не найдена: ${wallId}`)
  const def = OPENING_DEFAULTS[kind] ?? OPENING_DEFAULTS.door
  const o: Opening = {
    id: newId('o'),
    wallId,
    kind,
    offset,
    width: def.width,
    height: def.height,
    sill: def.sill,
    hinge: 'a',
    swing: 'left',
  }
  if (DOOR_KINDS.has(kind)) {
    o.frameMaterialId = kind === 'balconyDoor' ? DEFAULT_MATERIALS.frame : DEFAULT_MATERIALS.door
    o.leafMaterialId = kind === 'balconyDoor' ? DEFAULT_MATERIALS.frame : DEFAULT_MATERIALS.door
  }
  if (WINDOW_KINDS.has(kind)) {
    o.frameMaterialId = DEFAULT_MATERIALS.frame
    o.sashes = def.width <= 900 ? 1 : def.width <= 1700 ? 2 : 3
    o.sillBoard = kind === 'window' || kind === 'balconyBlock' ? 200 : 0
  }
  if (patch) {
    const { id: _id, wallId: _wallId, ...rest } = patch
    Object.assign(o, rest)
    if (patch.width !== undefined && patch.sashes === undefined && WINDOW_KINDS.has(o.kind)) {
      o.sashes = o.width <= 900 ? 1 : o.width <= 1700 ? 2 : 3
    }
  }
  doc.openings[o.id] = o
  clampOpening(doc, o)
  return o.id
}

/** Moves an opening along its wall or onto another wall. */
export function moveOpening(doc: Doc, openingId: Id, wallId: Id, offset: number): void {
  const o = doc.openings[openingId]
  if (!o || !doc.walls[wallId]) return
  setNum(o, 'wallId', wallId)
  if (Number.isFinite(offset)) setNum(o, 'offset', offset)
  clampOpening(doc, o)
}

// ───────────────────────────── items & lights ─────────────────────────────

export function addItem(doc: Doc, levelId: Id, asset: Asset, x: number, y: number, patch?: Partial<Item>): Id {
  const level = doc.levels[levelId]
  if (!level) throw new Error(`Уровень не найден: ${levelId}`)
  const size = { w: asset.size.w, d: asset.size.d, h: asset.size.h }
  let elevation = asset.elevation ?? 0
  if (asset.elevation === undefined && asset.mount === 'ceiling') elevation = Math.max(0, level.height - size.h)
  const item: Item = {
    id: newId('i'),
    levelId,
    assetId: asset.id,
    x,
    y,
    elevation,
    rotation: 0,
    size,
    mount: asset.mount,
  }
  if (asset.defaultParams) item.params = { ...asset.defaultParams }
  if (patch) {
    const { id: _id, levelId: _levelId, ...rest } = patch
    Object.assign(item, rest)
    if (patch.size) item.size = { w: patch.size.w, d: patch.size.d, h: patch.size.h }
    if (patch.overrides) item.overrides = { ...patch.overrides }
    if (patch.params) item.params = { ...(asset.defaultParams ?? {}), ...patch.params }
  }
  doc.items[item.id] = item
  return item.id
}

const LIGHT_DEFAULTS: Record<LightKind, { lumens: number; temperature: number; drop: number; size?: { w: number; d: number } }> = {
  ceiling: { lumens: 2000, temperature: 3000, drop: 60 },
  spot: { lumens: 500, temperature: 3000, drop: 10 },
  pendant: { lumens: 1200, temperature: 2700, drop: 700 },
  point: { lumens: 800, temperature: 2700, drop: 1200 },
  strip: { lumens: 1500, temperature: 3000, drop: 80, size: { w: 1000, d: 20 } },
  area: { lumens: 2500, temperature: 4000, drop: 10, size: { w: 600, d: 600 } },
}

export function addLight(doc: Doc, levelId: Id, kind: LightKind, x: number, y: number, patch?: Partial<Light>): Id {
  const level = doc.levels[levelId]
  if (!level) throw new Error(`Уровень не найден: ${levelId}`)
  const def = LIGHT_DEFAULTS[kind] ?? LIGHT_DEFAULTS.ceiling
  const light: Light = {
    id: newId('l'),
    levelId,
    kind,
    x,
    y,
    elevation: Math.max(0, (level.height || doc.settings.wallHeight) - def.drop),
    temperature: def.temperature,
    lumens: def.lumens,
    on: true,
  }
  if (def.size) light.size = { ...def.size }
  if (kind === 'spot' || kind === 'strip' || kind === 'area') light.rotation = 0
  if (patch) {
    const { id: _id, levelId: _levelId, ...rest } = patch
    Object.assign(light, rest)
    if (patch.size) light.size = { ...patch.size }
  }
  doc.lights[light.id] = light
  return light.id
}

// ───────────────────────────── remove / duplicate ─────────────────────────────

function removeWall(doc: Doc, wallId: Id): void {
  const w = doc.walls[wallId]
  if (!w) return
  for (const id in doc.openings) if (doc.openings[id].wallId === wallId) delete doc.openings[id]
  delete doc.walls[wallId]
  for (const nodeId of [w.a, w.b]) {
    if (doc.nodes[nodeId] && wallsAtNode(doc, nodeId).length === 0) delete doc.nodes[nodeId]
  }
}

/** Deletes entities with cascade: wall → its openings and orphan nodes; node → its walls. */
export function removeEntities(doc: Doc, refs: EntityRef[]): void {
  for (const ref of refs) {
    switch (ref.kind) {
      case 'wall':
        removeWall(doc, ref.id)
        break
      case 'node': {
        if (!doc.nodes[ref.id]) break
        for (const w of wallsAtNode(doc, ref.id)) removeWall(doc, w.id)
        delete doc.nodes[ref.id]
        break
      }
      case 'opening':
        delete doc.openings[ref.id]
        break
      case 'room':
        // the geometry is derived: deleting the record resets the room to defaults on the next sync
        delete doc.rooms[ref.id]
        break
      case 'item':
        delete doc.items[ref.id]
        break
      case 'light':
        delete doc.lights[ref.id]
        break
      case 'dimension':
        delete doc.dimensions[ref.id]
        break
      case 'label':
        delete doc.labels[ref.id]
        break
      case 'underlay':
        delete doc.underlays[ref.id]
        break
    }
  }
}

function cloneOpening(o: Opening): Opening {
  const c: Opening = { ...o, id: newId('o') }
  if (o.curtain) c.curtain = { ...o.curtain }
  return c
}

/**
 * Copies entities shifted by (dx, dy). Walls are re-inserted through the planar insertion routine
 * (so copies join / split existing walls) together with their openings; an opening duplicated on
 * its own stays on the same wall, shifted along it. Rooms and bare nodes are not duplicated.
 */
export function duplicateEntities(doc: Doc, refs: EntityRef[], dx: number, dy: number): EntityRef[] {
  const out: EntityRef[] = []
  const wallIds = new Set<Id>()
  for (const r of refs) if (r.kind === 'wall' && doc.walls[r.id]) wallIds.add(r.id)
  const groupMap = new Map<Id, Id>()
  const seen = new Set<string>()

  // snapshot the source walls first: inserting copies may split the originals
  const sources = [...wallIds].map((id) => {
    const w = doc.walls[id]
    return {
      levelId: w.levelId,
      a: nodePos(doc, w.a),
      b: nodePos(doc, w.b),
      tpl: { thickness: w.thickness, height: w.height, kind: w.kind, left: cloneSide(w.left), right: cloneSide(w.right) },
      openings: openingsOfWall(doc, id).map((o) => ({ ...o, curtain: o.curtain ? { ...o.curtain } : undefined })),
    }
  })
  for (const src of sources) {
    const pieces = insertSegment(
      doc,
      src.levelId,
      { x: src.a.x + dx, y: src.a.y + dy },
      { x: src.b.x + dx, y: src.b.y + dy },
      src.tpl,
    )
    for (const p of pieces) if (p.created) out.push({ kind: 'wall', id: p.wallId })
    for (const o of src.openings) {
      const piece =
        pieces.find((p) => p.created && o.offset >= p.from && o.offset <= p.to) ??
        pieces.find((p) => o.offset >= p.from && o.offset <= p.to)
      if (!piece) continue
      const c = cloneOpening(o as Opening)
      if (!o.curtain) delete c.curtain
      c.wallId = piece.wallId
      c.offset = piece.reversed ? piece.to - o.offset : o.offset - piece.from
      if (piece.reversed) flipOpening(c)
      doc.openings[c.id] = c
      clampOpening(doc, c)
      out.push({ kind: 'opening', id: c.id })
    }
  }

  for (const r of refs) {
    const key = `${r.kind}:${r.id}`
    if (seen.has(key)) continue
    seen.add(key)
    switch (r.kind) {
      case 'opening': {
        const o = doc.openings[r.id]
        if (!o || wallIds.has(o.wallId)) break
        const wall = doc.walls[o.wallId]
        if (!wall) break
        const a = nodePos(doc, wall.a)
        const b = nodePos(doc, wall.b)
        const length = dist(a, b)
        let shift = length > 1e-9 ? ((b.x - a.x) * dx + (b.y - a.y) * dy) / length : 0
        if (Math.abs(shift) < 1) shift = o.width + 100
        if (o.offset + shift + o.width / 2 > length && o.offset - Math.abs(shift) - o.width / 2 >= 0) shift = -Math.abs(shift)
        const c = cloneOpening(o)
        c.offset = o.offset + shift
        doc.openings[c.id] = c
        clampOpening(doc, c)
        out.push({ kind: 'opening', id: c.id })
        break
      }
      case 'item': {
        const it = doc.items[r.id]
        if (!it) break
        const c: Item = { ...it, id: newId('i'), x: it.x + dx, y: it.y + dy, size: { ...it.size } }
        if (it.overrides) c.overrides = { ...it.overrides }
        if (it.params) c.params = { ...it.params }
        if (it.groupId) {
          let g = groupMap.get(it.groupId)
          if (!g) groupMap.set(it.groupId, (g = newId('i')))
          c.groupId = g
        }
        doc.items[c.id] = c
        out.push({ kind: 'item', id: c.id })
        break
      }
      case 'light': {
        const l = doc.lights[r.id]
        if (!l) break
        const c: Light = { ...l, id: newId('l'), x: l.x + dx, y: l.y + dy }
        if (l.size) c.size = { ...l.size }
        doc.lights[c.id] = c
        out.push({ kind: 'light', id: c.id })
        break
      }
      case 'dimension': {
        const d = doc.dimensions[r.id]
        if (!d) break
        const id = newId('d')
        doc.dimensions[id] = { ...d, id, a: { x: d.a.x + dx, y: d.a.y + dy }, b: { x: d.b.x + dx, y: d.b.y + dy } }
        out.push({ kind: 'dimension', id })
        break
      }
      case 'label': {
        const l = doc.labels[r.id]
        if (!l) break
        const id = newId('t')
        doc.labels[id] = { ...l, id, x: l.x + dx, y: l.y + dy }
        out.push({ kind: 'label', id })
        break
      }
      case 'underlay': {
        const u = doc.underlays[r.id]
        if (!u) break
        const id = newId('u')
        doc.underlays[id] = { ...u, id, x: u.x + dx, y: u.y + dy }
        out.push({ kind: 'underlay', id })
        break
      }
      default:
        break
    }
  }
  return out
}

// ───────────────────────────── finishes ─────────────────────────────

/**
 * Paints one face of a wall. Without `zone` the base material of the side is replaced and its bands
 * are cleared; with `zone` a horizontal band (mm above floor) is added, cutting the bands it overlaps.
 */
export function applyFinishToWallSide(
  doc: Doc,
  wallId: Id,
  side: 'left' | 'right',
  materialId: Id,
  zone?: { from: number; to: number },
): void {
  const wall = doc.walls[wallId]
  if (!wall) return
  if (!wall[side]) wall[side] = defaultWallSide()
  const s = wall[side]
  if (!zone) {
    setNum(s, 'materialId', materialId)
    if (s.zones) delete s.zones
    return
  }
  const from = Math.max(0, Math.min(zone.from, zone.to))
  const to = Math.max(zone.from, zone.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 1) return
  const zones: FinishZone[] = []
  for (const z of s.zones ?? []) {
    if (z.to <= from || z.from >= to) {
      zones.push({ from: z.from, to: z.to, materialId: z.materialId })
      continue
    }
    if (z.from < from) zones.push({ from: z.from, to: from, materialId: z.materialId })
    if (z.to > to) zones.push({ from: to, to: z.to, materialId: z.materialId })
  }
  zones.push({ from, to, materialId })
  zones.sort((p, q) => p.from - q.from)
  const merged: FinishZone[] = []
  for (const z of zones) {
    const last = merged[merged.length - 1]
    if (last && last.materialId === z.materialId && Math.abs(last.to - z.from) < 0.5) last.to = z.to
    else merged.push(z)
  }
  s.zones = merged
}

// ───────────────────────────── normalize ─────────────────────────────

/**
 * Restores the graph invariants after any edit:
 *  1. coincident nodes (≤ EPS apart, same level) are merged;
 *  2. degenerate walls (a = b, missing node) and duplicate walls (same node pair) are dropped —
 *     openings of a dropped duplicate move to the surviving wall;
 *  3. two collinear walls meeting at an unpinned degree-2 node are merged when their kind, thickness,
 *     height and finishes are identical (openings are re-offset);
 *  4. orphan nodes and openings without a wall are removed, openings are clamped to their wall.
 */
export function normalize(doc: Doc): void {
  // ── 1. merge coincident nodes ──
  const byLevel = new Map<Id, PinnedNode[]>()
  for (const id in doc.nodes) {
    const n = doc.nodes[id] as PinnedNode
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      n.x = Number.isFinite(n.x) ? n.x : 0
      n.y = Number.isFinite(n.y) ? n.y : 0
    }
    let list = byLevel.get(n.levelId)
    if (!list) byLevel.set(n.levelId, (list = []))
    list.push(n)
  }
  const remap = new Map<Id, Id>()
  for (const list of byLevel.values()) {
    if (list.length < 2) continue
    const order = new Map<Id, number>()
    list.forEach((n, i) => order.set(n.id, i))
    const sorted = list.slice().sort((p, q) => p.x - q.x)
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i]
      if (remap.has(p.id)) continue
      for (let j = i + 1; j < sorted.length; j++) {
        const q = sorted[j]
        if (q.x - p.x > EPS) break
        if (remap.has(q.id)) continue
        if (Math.hypot(q.x - p.x, q.y - p.y) <= EPS) remap.set(q.id, p.id)
      }
    }
  }
  if (remap.size > 0) {
    for (const [from, to] of remap) {
      const gone = doc.nodes[from] as PinnedNode | undefined
      const kept = doc.nodes[to] as PinnedNode | undefined
      if (gone?.pinned && kept && !kept.pinned) kept.pinned = true
      delete doc.nodes[from]
    }
    for (const id in doc.walls) {
      const w = doc.walls[id]
      const a = remap.get(w.a)
      const b = remap.get(w.b)
      if (a) w.a = a
      if (b) w.b = b
    }
  }

  // ── 2. degenerate and duplicate walls ──
  const byPair = new Map<string, Wall>()
  const dropped = new Map<Id, { keep: Wall | null; reversed: boolean }>()
  for (const id in doc.walls) {
    const w = doc.walls[id]
    const na = doc.nodes[w.a]
    const nb = doc.nodes[w.b]
    if (!na || !nb || w.a === w.b || !doc.levels[w.levelId]) {
      dropped.set(id, { keep: null, reversed: false })
      continue
    }
    if (na.levelId !== w.levelId || nb.levelId !== w.levelId) {
      dropped.set(id, { keep: null, reversed: false })
      continue
    }
    const key = w.a < w.b ? `${w.a}|${w.b}` : `${w.b}|${w.a}`
    const first = byPair.get(key)
    if (first) dropped.set(id, { keep: first, reversed: first.a !== w.a })
    else byPair.set(key, w)
  }
  if (dropped.size > 0) {
    for (const id in doc.openings) {
      const o = doc.openings[id]
      const d = dropped.get(o.wallId)
      if (!d) continue
      if (!d.keep) {
        delete doc.openings[id]
        continue
      }
      const length = wallLength(doc, d.keep)
      o.wallId = d.keep.id
      if (d.reversed) {
        o.offset = length - o.offset
        flipOpening(o)
      }
    }
    for (const id of dropped.keys()) delete doc.walls[id]
  }

  // ── 3. merge collinear walls at unpinned degree-2 nodes ──
  const adj = new Map<Id, Wall[]>()
  for (const id in doc.walls) {
    const w = doc.walls[id]
    let la = adj.get(w.a)
    if (!la) adj.set(w.a, (la = []))
    la.push(w)
    let lb = adj.get(w.b)
    if (!lb) adj.set(w.b, (lb = []))
    lb.push(w)
  }
  const cache: { map: Map<Id, Opening[]> | null } = { map: null }
  const openingMap = (): Map<Id, Opening[]> => {
    if (!cache.map) {
      const m = new Map<Id, Opening[]>()
      for (const id in doc.openings) {
        const o = doc.openings[id]
        let l = m.get(o.wallId)
        if (!l) m.set(o.wallId, (l = []))
        l.push(o)
      }
      cache.map = m
    }
    return cache.map
  }
  const openingsOf = (wallId: Id): Opening[] => openingMap().get(wallId) ?? []
  for (const nodeId of [...adj.keys()]) {
    const list = adj.get(nodeId)
    if (!list || list.length !== 2) continue
    const n = doc.nodes[nodeId] as PinnedNode
    if (!n || n.pinned) continue
    const [w1, w2] = list
    if (w1 === w2) continue
    if (w1.kind !== w2.kind || w1.thickness !== w2.thickness || w1.height !== w2.height || w1.levelId !== w2.levelId) continue
    // orientation relative to the direction p → n → q
    const w1fwd = w1.b === nodeId
    const w2fwd = w2.a === nodeId
    const pId = w1fwd ? w1.a : w1.b
    const qId = w2fwd ? w2.b : w2.a
    if (pId === qId) continue
    const p = doc.nodes[pId]
    const q = doc.nodes[qId]
    if (!p || !q) continue
    const pq = Math.hypot(q.x - p.x, q.y - p.y)
    if (pq <= EPS) continue
    const off = Math.abs((q.x - p.x) * (n.y - p.y) - (q.y - p.y) * (n.x - p.x)) / pq
    if (off > COLLINEAR_TOL) continue
    if ((n.x - p.x) * (q.x - n.x) + (n.y - p.y) * (q.y - n.y) <= 0) continue
    const l1 = w1fwd ? w1.left : w1.right
    const r1 = w1fwd ? w1.right : w1.left
    const l2 = w2fwd ? w2.left : w2.right
    const r2 = w2fwd ? w2.right : w2.left
    if (!sideEquals(l1, l2) || !sideEquals(r1, r2)) continue

    const len1 = Math.hypot(n.x - p.x, n.y - p.y)
    const len2 = Math.hypot(q.x - n.x, q.y - n.y)
    const own = openingsOf(w1.id)
    const moved = openingsOf(w2.id)
    if (w1fwd) {
      w1.b = qId
      for (const o of moved) {
        o.wallId = w1.id
        o.offset = len1 + (w2fwd ? o.offset : len2 - o.offset)
        if (!w2fwd) flipOpening(o)
      }
    } else {
      w1.a = qId
      for (const o of own) o.offset += len2
      for (const o of moved) {
        o.wallId = w1.id
        o.offset = w2fwd ? len2 - o.offset : o.offset
        if (w2fwd) flipOpening(o)
      }
    }
    // the merged faces are new dimensions: their recorded provenance no longer applies
    if (w1.dims) delete w1.dims
    openingMap().set(w1.id, [...own, ...moved])
    openingMap().delete(w2.id)
    delete doc.walls[w2.id]
    delete doc.nodes[nodeId]
    adj.delete(nodeId)
    const lq = adj.get(qId)
    if (lq) {
      const i = lq.indexOf(w2)
      if (i >= 0) lq[i] = w1
    }
  }

  // ── 4. orphan nodes, stale openings, clamping ──
  for (const id in doc.nodes) if (!adj.has(id)) delete doc.nodes[id]
  for (const id in doc.openings) {
    const o = doc.openings[id]
    if (!doc.walls[o.wallId]) {
      delete doc.openings[id]
      continue
    }
    clampOpening(doc, o)
  }
}

// ───────────────────────────── rooms ─────────────────────────────

function nextRoomName(doc: Doc, levelId: Id): string {
  const base = ROOM_TYPE_NAMES.other.ru
  const used = new Set<string>()
  let count = 0
  for (const id in doc.rooms) {
    const r = doc.rooms[id]
    if (r.levelId !== levelId) continue
    used.add(r.name)
    count++
  }
  let n = count + 1
  while (used.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/**
 * Keeps Room records in sync with the detected faces (anchor-based identity):
 *  - a record whose anchor lies in a face keeps describing that face; its anchor moves to the label point;
 *  - faces without a record get a default record (faces under 0.1 m² are treated as voids);
 *  - records whose anchor is in no face (or that lost a face to another record) are deleted.
 */
export function syncRooms(doc: Doc): void {
  const levelIds = new Set<Id>(doc.levelOrder)
  for (const id in doc.levels) levelIds.add(id)
  const keep = new Set<Id>()
  for (const levelId of levelIds) {
    if (!doc.levels[levelId]) continue
    const derived = detectRooms(doc, levelId, computeWallGeoms(doc, levelId))
    for (const d of derived) {
      const rec = isAutoRoomId(d.roomId) ? undefined : doc.rooms[d.roomId]
      if (rec) {
        if (!rec.anchor || Math.hypot(rec.anchor.x - d.labelPoint.x, rec.anchor.y - d.labelPoint.y) > 0.01) {
          rec.anchor = { x: d.labelPoint.x, y: d.labelPoint.y }
        }
        keep.add(rec.id)
        continue
      }
      if (d.area < MIN_ROOM_AREA_M2) continue
      const room = defaultRoom(levelId, d.labelPoint)
      room.name = nextRoomName(doc, levelId)
      doc.rooms[room.id] = room
      keep.add(room.id)
    }
  }
  for (const id in doc.rooms) if (!keep.has(id)) delete doc.rooms[id]
  // inactive furnishing variants forget finishes of records that are gone
  pruneVariants(doc)
}

// ───────────────────────────── planarize (extra) ─────────────────────────────

/**
 * Optional helper (not called by `normalize`, so drags never grow joints by themselves): makes the
 * wall graph of a level planar again — nodes touching a wall are inserted into it and crossing walls
 * are split at the crossing. Call it once when a move / drag is committed.
 */
export function planarize(doc: Doc, levelId?: Id): void {
  const levels = levelId ? [levelId] : Object.keys(doc.levels)
  for (const lv of levels) {
    let guard = 0
    let changed = true
    while (changed && guard++ < 1000) {
      changed = false
      const walls = levelWalls(doc, lv)
      // T-touches: a node lying on the interior of a wall
      outer: for (const w of walls) {
        const a = doc.nodes[w.a]
        const b = doc.nodes[w.b]
        if (!a || !b) continue
        const length = Math.hypot(b.x - a.x, b.y - a.y)
        if (length <= EPS * 2) continue
        for (const id in doc.nodes) {
          if (id === w.a || id === w.b) continue
          const n = doc.nodes[id]
          if (n.levelId !== lv) continue
          const pr = projectOnSegment(n, a, b)
          const s = pr.t * length
          if (pr.dist <= EPS && s > EPS && s < length - EPS) {
            splitWallAtNode(doc, w, id, s)
            changed = true
            break outer
          }
        }
      }
      if (changed) continue
      // proper crossings
      cross: for (let i = 0; i < walls.length; i++) {
        const w = walls[i]
        const a = nodePos(doc, w.a)
        const b = nodePos(doc, w.b)
        for (let j = i + 1; j < walls.length; j++) {
          const o = walls[j]
          if (o.a === w.a || o.a === w.b || o.b === w.a || o.b === w.b) continue
          const c = nodePos(doc, o.a)
          const d = nodePos(doc, o.b)
          const hit = segIntersect(a, b, c, d)
          if (!hit) continue
          const lw = dist(a, b)
          const lo = dist(c, d)
          const sw = hit.t * lw
          const so = hit.u * lo
          if (sw <= EPS || sw >= lw - EPS || so <= EPS || so >= lo - EPS) continue
          const nodeId = createNode(doc, lv, hit.point)
          splitWallAtNode(doc, w, nodeId, sw)
          splitWallAtNode(doc, o, nodeId, so)
          changed = true
          break cross
        }
      }
    }
  }
}
