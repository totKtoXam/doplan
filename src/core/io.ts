/**
 * Project (de)serialisation. `parseDoc` is deliberately tolerant: it accepts hand-written or older
 * documents, fills every missing field with a default, drops entities with broken references and
 * only throws (with a readable Russian message) when the input is not a doplan document at all.
 */
import { DEFAULT_MATERIALS, OPENING_DEFAULTS, ROOM_TYPE_NAMES, createEmptyDoc, defaultRenderSettings, defaultSettings } from './defaults'
import { newId, type IdPrefix } from './ids'
import { normalize, syncRooms, type PinnedNode } from './ops'
import {
  DOC_VERSION,
  type Asset,
  type AssetCategory,
  type CameraBookmark,
  type CeilingKind,
  type CeilingSpec,
  type CurtainKind,
  type CurtainSpec,
  type DimProvenance,
  type DimSource,
  type Dimension,
  type Doc,
  type FinishZone,
  type Id,
  type Item,
  type Label,
  type Level,
  type Light,
  type LightKind,
  type Material,
  type MaterialCategory,
  type MaterialMaps,
  type MountKind,
  type Opening,
  type OpeningKind,
  type ProceduralKind,
  type QualityPreset,
  type Room,
  type RoomType,
  type SurfaceFinish,
  type TilePattern,
  type TilePatternType,
  type Underlay,
  type Vec2,
  type Wall,
  type WallDims,
  type WallKind,
  type WallSide,
} from './types'

type Obj = Record<string, unknown>

const DIM_SOURCES: readonly DimSource[] = ['plan', 'derived', 'estimated', 'measured', 'drawn']
const WALL_KINDS: readonly WallKind[] = ['wall', 'partition', 'parapet', 'glazing', 'virtual']
const OPENING_KINDS: readonly OpeningKind[] = [
  'door',
  'doubleDoor',
  'slidingDoor',
  'entranceDoor',
  'arch',
  'opening',
  'window',
  'frenchWindow',
  'balconyDoor',
  'balconyBlock',
]
const CURTAIN_KINDS: readonly CurtainKind[] = ['none', 'drapes', 'sheer', 'drapesAndSheer', 'roman', 'roller', 'blinds']
const ROOM_TYPES = Object.keys(ROOM_TYPE_NAMES) as RoomType[]
const PATTERN_TYPES: readonly TilePatternType[] = [
  'none',
  'grid',
  'brick',
  'brickThird',
  'herringbone',
  'chevron',
  'hex',
  'basket',
  'diagonal',
  'planks',
]
const CEILING_KINDS: readonly CeilingKind[] = ['flat', 'stretch', 'multilevel', 'coffered', 'beams']
const MOUNT_KINDS: readonly MountKind[] = ['floor', 'wall', 'ceiling', 'surface']
const LIGHT_KINDS: readonly LightKind[] = ['ceiling', 'spot', 'pendant', 'point', 'strip', 'area']
const MATERIAL_CATEGORIES: readonly MaterialCategory[] = [
  'paint',
  'wallpaper',
  'plaster',
  'wood',
  'parquet',
  'laminate',
  'tile',
  'stone',
  'marble',
  'concrete',
  'brick',
  'fabric',
  'carpet',
  'leather',
  'metal',
  'glass',
  'plastic',
  'ceiling',
  'outdoor',
  'other',
]
const ASSET_CATEGORIES: readonly AssetCategory[] = [
  'sofa',
  'armchair',
  'chair',
  'table',
  'bed',
  'storage',
  'kitchen',
  'appliance',
  'bathroom',
  'lighting',
  'decor',
  'plant',
  'textile',
  'electronics',
  'outdoor',
  'kids',
  'office',
  'structure',
  'other',
]
const PROCEDURAL_KINDS: readonly ProceduralKind[] = [
  'box',
  'kitchenBase',
  'kitchenWall',
  'kitchenTall',
  'worktop',
  'wardrobe',
  'shelf',
  'bed',
  'sofa',
  'table',
  'chair',
  'fridge',
  'stove',
  'oven',
  'hood',
  'dishwasher',
  'washingMachine',
  'tv',
  'sink',
  'toilet',
  'bathtub',
  'shower',
  'washbasin',
  'radiator',
  'rug',
  'mirror',
  'picture',
  'column',
  'stairs',
  'airConditioner',
  'plantPot',
]
const QUALITIES: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra']

// ───────────────────────────── primitive readers ─────────────────────────────

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, def: number, min = -Infinity, max = Infinity): number {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v)
  else return def
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function optNum(v: unknown, min = -Infinity, max = Infinity): number | undefined {
  const n = num(v, Number.NaN, min, max)
  return Number.isNaN(n) ? undefined : n
}

function str(v: unknown, def: string): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return def
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def
}

function oneOf<T extends string>(v: unknown, list: readonly T[], def: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : def
}

function color(v: unknown, def: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : typeof v === 'string' && /^#[0-9a-fA-F]{3}$/.test(v)
    ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase()
    : def
}

function optColor(v: unknown): string | undefined {
  const c = color(v, '')
  return c === '' ? undefined : c
}

function vec2(v: unknown): Vec2 | null {
  if (Array.isArray(v) && v.length >= 2) {
    const x = optNum(v[0])
    const y = optNum(v[1])
    return x === undefined || y === undefined ? null : { x, y }
  }
  if (!isObj(v)) return null
  const x = optNum(v.x)
  const y = optNum(v.y)
  return x === undefined || y === undefined ? null : { x, y }
}

function triple(v: unknown, def: [number, number, number]): [number, number, number] {
  if (Array.isArray(v) && v.length >= 3) return [num(v[0], def[0]), num(v[1], def[1]), num(v[2], def[2])]
  if (isObj(v)) return [num(v.x, def[0]), num(v.y, def[1]), num(v.z, def[2])]
  return def
}

/** Entities may come as a map {id: entity} or as an array of entities with ids. */
function entries(v: unknown, prefix: IdPrefix): [Id, Obj][] {
  const out: [Id, Obj][] = []
  const seen = new Set<Id>()
  const push = (rawId: unknown, e: unknown): void => {
    if (!isObj(e)) return
    let id = typeof rawId === 'string' && rawId !== '' ? rawId : typeof e.id === 'string' && e.id !== '' ? e.id : ''
    if (id === '' || seen.has(id)) id = newId(prefix)
    seen.add(id)
    out.push([id, e])
  }
  if (Array.isArray(v)) for (const e of v) push(isObj(e) ? e.id : undefined, e)
  else if (isObj(v)) for (const key of Object.keys(v)) push(key, v[key])
  return out
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, string> = {}
  let n = 0
  for (const k of Object.keys(v)) {
    const s = v[k]
    if (typeof s === 'string' && s !== '') {
      out[k] = s
      n++
    }
  }
  return n ? out : undefined
}

function paramRecord(v: unknown): Record<string, number | string | boolean> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, number | string | boolean> = {}
  let n = 0
  for (const k of Object.keys(v)) {
    const s = v[k]
    if (typeof s === 'string' || typeof s === 'boolean' || (typeof s === 'number' && Number.isFinite(s))) {
      out[k] = s
      n++
    }
  }
  return n ? out : undefined
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((s): s is string => typeof s === 'string')
  return out.length ? out : undefined
}

// ───────────────────────────── entity readers ─────────────────────────────

function readPattern(v: unknown): TilePattern | undefined {
  if (!isObj(v)) return undefined
  const type = oneOf(v.type, PATTERN_TYPES, 'none')
  const p: TilePattern = {
    type,
    tileW: num(v.tileW, 600, 1, 100000),
    tileH: num(v.tileH, 600, 1, 100000),
    grout: num(v.grout, 2, 0, 100),
    groutColor: color(v.groutColor, '#cccccc'),
    rotation: num(v.rotation, 0),
  }
  const variation = optNum(v.variation, 0, 1)
  if (variation !== undefined) p.variation = variation
  const alt = optColor(v.altColor)
  if (alt) p.altColor = alt
  return p
}

function readFinish(v: unknown, defMaterial: Id): SurfaceFinish {
  if (typeof v === 'string' && v !== '') return { materialId: v }
  const o = isObj(v) ? v : {}
  const f: SurfaceFinish = { materialId: str(o.materialId, defMaterial) || defMaterial }
  const pattern = readPattern(o.pattern)
  if (pattern) f.pattern = pattern
  const tint = optColor(o.tint)
  if (tint) f.tint = tint
  return f
}

function readCeiling(v: unknown): CeilingSpec {
  const o = isObj(v) ? v : {}
  const c: CeilingSpec = { ...readFinish(v, DEFAULT_MATERIALS.ceiling), kind: oneOf(o.kind, CEILING_KINDS, 'flat') }
  const height = optNum(o.height, 100, 100000)
  if (height !== undefined) c.height = height
  const borderWidth = optNum(o.borderWidth, 0, 100000)
  if (borderWidth !== undefined) c.borderWidth = borderWidth
  const borderDrop = optNum(o.borderDrop, 0, 5000)
  if (borderDrop !== undefined) c.borderDrop = borderDrop
  if (typeof o.coveLight === 'boolean') c.coveLight = o.coveLight
  const cornice = optNum(o.cornice, 0, 1000)
  if (cornice !== undefined) c.cornice = cornice
  return c
}

function readSide(v: unknown): WallSide {
  if (typeof v === 'string' && v !== '') return { materialId: v }
  const o = isObj(v) ? v : {}
  const side: WallSide = { materialId: str(o.materialId, DEFAULT_MATERIALS.wall) || DEFAULT_MATERIALS.wall }
  if (Array.isArray(o.zones)) {
    const zones: FinishZone[] = []
    for (const z of o.zones) {
      if (!isObj(z)) continue
      const from = optNum(z.from, 0)
      const to = optNum(z.to, 0)
      const materialId = optStr(z.materialId)
      if (from === undefined || to === undefined || !materialId || to - from < 1) continue
      zones.push({ from, to, materialId })
    }
    zones.sort((p, q) => p.from - q.from)
    if (zones.length) side.zones = zones
  }
  return side
}

function readProvenance(v: unknown): DimProvenance | undefined {
  if (typeof v === 'string') return (DIM_SOURCES as readonly string[]).includes(v) && v !== 'drawn' ? { source: v as DimSource } : undefined
  if (!isObj(v)) return undefined
  const source = oneOf(v.source, DIM_SOURCES, 'drawn')
  // 'drawn' is the default: storing it adds nothing
  if (source === 'drawn') return undefined
  const p: DimProvenance = { source }
  const tol = optNum(v.tol, 0, 10000)
  if (tol !== undefined) p.tol = tol
  const value = optNum(v.value, 0, 1e7)
  if (value !== undefined) p.value = value
  const date = optStr(v.date)
  if (date && /^\d{4}-\d{2}-\d{2}/.test(date)) p.date = date.slice(0, 10)
  const note = optStr(v.note)
  if (note) p.note = note
  return p
}

function readWallDims(v: unknown): WallDims | undefined {
  if (!isObj(v)) return undefined
  const left = readProvenance(v.left)
  const right = readProvenance(v.right)
  if (!left && !right) return undefined
  const d: WallDims = {}
  if (left) d.left = left
  if (right) d.right = right
  return d
}

function readCurtain(v: unknown): CurtainSpec | undefined {
  if (!isObj(v)) return undefined
  const c: CurtainSpec = {
    kind: oneOf(v.kind, CURTAIN_KINDS, 'none'),
    closed: num(v.closed, 0.3, 0, 1),
    side: oneOf(v.side, ['left', 'right'] as const, 'left'),
    overhang: num(v.overhang, 200, 0, 5000),
    fullHeight: bool(v.fullHeight, true),
  }
  const m = optStr(v.materialId)
  if (m) c.materialId = m
  const s = optStr(v.sheerMaterialId)
  if (s) c.sheerMaterialId = s
  return c
}

function readMaterial(id: Id, v: Obj): Material {
  const m: Material = {
    id,
    name: str(v.name, str(v.nameRu, id)),
    category: oneOf(v.category, MATERIAL_CATEGORIES, 'other'),
    color: color(v.color, '#cccccc'),
    roughness: num(v.roughness, 0.8, 0, 1),
    metalness: num(v.metalness, 0, 0, 1),
  }
  const nameRu = optStr(v.nameRu)
  if (nameRu) m.nameRu = nameRu
  const maps = stringRecord(v.maps) as MaterialMaps | undefined
  if (maps) m.maps = maps
  if (Array.isArray(v.sizeMm) && v.sizeMm.length >= 2) m.sizeMm = [num(v.sizeMm[0], 1000, 1), num(v.sizeMm[1], 1000, 1)]
  const pattern = readPattern(v.pattern)
  if (pattern) m.pattern = pattern
  for (const key of ['transmission', 'opacity', 'sheen', 'clearcoat'] as const) {
    const n = optNum(v[key], 0, 1)
    if (n !== undefined) m[key] = n
  }
  const ior = optNum(v.ior, 1, 3)
  if (ior !== undefined) m.ior = ior
  const emissive = optColor(v.emissive)
  if (emissive) m.emissive = emissive
  const ei = optNum(v.emissiveIntensity, 0, 1000)
  if (ei !== undefined) m.emissiveIntensity = ei
  const ns = optNum(v.normalScale, 0, 10)
  if (ns !== undefined) m.normalScale = ns
  const tags = stringList(v.tags)
  if (tags) m.tags = tags
  for (const key of ['source', 'licence', 'thumb'] as const) {
    const s = optStr(v[key])
    if (s) m[key] = s
  }
  if (typeof v.remote === 'boolean') m.remote = v.remote
  if (typeof v.custom === 'boolean') m.custom = v.custom
  return m
}

function readSize(v: unknown, def: { w: number; d: number; h: number }): { w: number; d: number; h: number } {
  if (Array.isArray(v) && v.length >= 3) return { w: num(v[0], def.w, 1), d: num(v[1], def.d, 1), h: num(v[2], def.h, 1) }
  const o = isObj(v) ? v : {}
  return { w: num(o.w, def.w, 1, 1e6), d: num(o.d, def.d, 1, 1e6), h: num(o.h, def.h, 1, 1e6) }
}

function readAsset(id: Id, v: Obj): Asset {
  const procedural = typeof v.procedural === 'string' && (PROCEDURAL_KINDS as readonly string[]).includes(v.procedural) ? (v.procedural as ProceduralKind) : undefined
  const src = optStr(v.src)
  const a: Asset = {
    id,
    name: str(v.name, str(v.nameRu, id)),
    category: oneOf(v.category, ASSET_CATEGORIES, 'other'),
    kind: v.kind === 'model' || (v.kind !== 'procedural' && src && !procedural) ? 'model' : 'procedural',
    size: readSize(v.size, { w: 500, d: 500, h: 500 }),
    mount: oneOf(v.mount, MOUNT_KINDS, 'floor'),
  }
  if (a.kind === 'procedural') a.procedural = procedural ?? 'box'
  if (src) a.src = src
  const nameRu = optStr(v.nameRu)
  if (nameRu) a.nameRu = nameRu
  const elevation = optNum(v.elevation, 0, 1e5)
  if (elevation !== undefined) a.elevation = elevation
  const slots = stringRecord(v.slots)
  if (slots) a.slots = slots
  const params = paramRecord(v.defaultParams)
  if (params) a.defaultParams = params
  const tags = stringList(v.tags)
  if (tags) a.tags = tags
  for (const key of ['thumb', 'source', 'licence', 'author'] as const) {
    const s = optStr(v[key])
    if (s) a[key] = s
  }
  if (typeof v.remote === 'boolean') a.remote = v.remote
  if (typeof v.custom === 'boolean') a.custom = v.custom
  return a
}

// ───────────────────────────── public API ─────────────────────────────

/** JSON text of the document (current schema version). */
export function serializeDoc(doc: Doc): string {
  return JSON.stringify({ ...doc, version: DOC_VERSION })
}

/**
 * Validates and upgrades a parsed (or textual) project document: fills defaults, drops entities with
 * broken references, normalises the wall graph and syncs room records.
 * Throws an Error with a readable message when the input is not a doplan project.
 */
export function parseDoc(json: unknown): Doc {
  let raw: unknown = json
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new Error('Файл проекта повреждён: это не корректный JSON')
    }
  }
  if (!isObj(raw)) throw new Error('Файл не является проектом doplan: ожидался объект документа')
  const meta = isObj(raw.meta) ? raw.meta : {}
  const looksLikeDoc =
    meta.app === 'doplan' || isObj(raw.walls) || Array.isArray(raw.walls) || isObj(raw.nodes) || Array.isArray(raw.nodes) || isObj(raw.levels) || Array.isArray(raw.levels)
  if (!looksLikeDoc) throw new Error('Файл не является проектом doplan: в нём нет уровней, узлов и стен')
  if (typeof meta.app === 'string' && meta.app !== 'doplan') {
    throw new Error(`Файл создан другим приложением («${meta.app}») и не может быть открыт`)
  }
  const version = raw.version === undefined ? DOC_VERSION : num(raw.version, Number.NaN)
  if (Number.isNaN(version) || version < 1) throw new Error('Файл проекта повреждён: некорректный номер версии')
  if (version > DOC_VERSION) {
    throw new Error(`Проект создан в более новой версии doplan (формат ${version}). Обновите приложение, чтобы открыть его`)
  }

  const doc = createEmptyDoc(str(meta.name, 'Без названия'))
  const fallbackLevel = doc.levels[doc.levelOrder[0]]
  doc.meta.createdAt = str(meta.createdAt, doc.meta.createdAt)
  doc.meta.modifiedAt = str(meta.modifiedAt, doc.meta.modifiedAt)

  // ── settings & render ──
  const s = isObj(raw.settings) ? raw.settings : {}
  const ds = defaultSettings()
  doc.settings = {
    gridMm: num(s.gridMm, ds.gridMm, 1, 100000),
    snapGrid: bool(s.snapGrid, ds.snapGrid),
    snapObjects: bool(s.snapObjects, ds.snapObjects),
    snapAngle: bool(s.snapAngle, ds.snapAngle),
    wallThickness: num(s.wallThickness, ds.wallThickness, 1, 5000),
    wallHeight: num(s.wallHeight, ds.wallHeight, 100, 100000),
    showDimensions: bool(s.showDimensions, ds.showDimensions),
    showAreas: bool(s.showAreas, ds.showAreas),
    showFurniture2d: bool(s.showFurniture2d, ds.showFurniture2d),
    showItemSizes: bool(s.showItemSizes, ds.showItemSizes),
    units: oneOf(s.units, ['mm', 'cm', 'm'] as const, ds.units),
  }
  const r = isObj(raw.render) ? raw.render : {}
  const dr = defaultRenderSettings()
  doc.render = {
    quality: oneOf(r.quality, QUALITIES, dr.quality),
    sunAzimuth: num(r.sunAzimuth, dr.sunAzimuth),
    sunElevation: num(r.sunElevation, dr.sunElevation, -90, 90),
    sunIntensity: num(r.sunIntensity, dr.sunIntensity, 0, 100),
    timeOfDay: num(r.timeOfDay, dr.timeOfDay, 0, 24),
    sunAuto: bool(r.sunAuto, dr.sunAuto),
    north: num(r.north, dr.north),
    hdriIntensity: num(r.hdriIntensity, dr.hdriIntensity, 0, 100),
    hdriRotation: num(r.hdriRotation, dr.hdriRotation),
    exposure: num(r.exposure, dr.exposure, 0, 100),
    toneMapping: oneOf(r.toneMapping, ['agx', 'aces', 'neutral'] as const, dr.toneMapping),
    ao: bool(r.ao, dr.ao),
    ssgi: bool(r.ssgi, dr.ssgi),
    ssr: bool(r.ssr, dr.ssr),
    bloom: bool(r.bloom, dr.bloom),
    wallCutaway: bool(r.wallCutaway, dr.wallCutaway),
    ceilingVisible: bool(r.ceilingVisible, dr.ceilingVisible),
    lightsOn: bool(r.lightsOn, dr.lightsOn),
  }
  const hdriId = optStr(r.hdriId)
  if (hdriId) doc.render.hdriId = hdriId

  // ── what the source plan states ──
  if (isObj(raw.source)) {
    const src: NonNullable<Doc['source']> = {}
    const kind = optStr(raw.source.kind)
    if (kind) src.kind = kind
    const total = optNum(raw.source.labelledTotalArea, 0, 1e7)
    if (total !== undefined && total > 0) src.labelledTotalArea = total
    const living = optNum(raw.source.labelledLivingArea, 0, 1e7)
    if (living !== undefined && living > 0) src.labelledLivingArea = living
    if (Object.keys(src).length) doc.source = src
  }

  // ── levels ──
  const levels: Record<Id, Level> = {}
  for (const [id, v] of entries(raw.levels, 'lv')) {
    levels[id] = {
      id,
      name: str(v.name, `Этаж ${Object.keys(levels).length + 1}`),
      elevation: num(v.elevation, 0),
      height: num(v.height, doc.settings.wallHeight, 100, 100000),
      visible: bool(v.visible, true),
    }
  }
  if (Object.keys(levels).length === 0) levels[fallbackLevel.id] = fallbackLevel
  doc.levels = levels
  const order: Id[] = []
  if (Array.isArray(raw.levelOrder)) {
    for (const id of raw.levelOrder) if (typeof id === 'string' && levels[id] && !order.includes(id)) order.push(id)
  }
  for (const id of Object.keys(levels)) if (!order.includes(id)) order.push(id)
  doc.levelOrder = order
  const firstLevel = order[0]
  const levelOf = (v: unknown): Id => (typeof v === 'string' && levels[v] ? v : firstLevel)

  // ── nodes ──
  for (const [id, v] of entries(raw.nodes, 'n')) {
    const p = vec2(v)
    if (!p) continue
    const n: PinnedNode = { id, levelId: levelOf(v.levelId), x: p.x, y: p.y }
    if (v.pinned === true) n.pinned = true
    doc.nodes[id] = n
  }

  // ── walls ──
  for (const [id, v] of entries(raw.walls, 'w')) {
    const a = typeof v.a === 'string' ? doc.nodes[v.a] : undefined
    const b = typeof v.b === 'string' ? doc.nodes[v.b] : undefined
    if (!a || !b || a.id === b.id || a.levelId !== b.levelId) continue
    const kind = oneOf(v.kind, WALL_KINDS, 'wall')
    const wall: Wall = {
      id,
      levelId: a.levelId,
      a: a.id,
      b: b.id,
      thickness: num(v.thickness, doc.settings.wallThickness, 0, 5000),
      height: num(v.height, levels[a.levelId].height, 1, 100000),
      kind,
      left: readSide(v.left),
      right: readSide(v.right),
    }
    const dims = readWallDims(v.dims)
    if (dims) wall.dims = dims
    doc.walls[id] = wall
  }

  // ── openings ──
  for (const [id, v] of entries(raw.openings, 'o')) {
    const wall = typeof v.wallId === 'string' ? doc.walls[v.wallId] : undefined
    if (!wall) continue
    const kind = oneOf(v.kind, OPENING_KINDS, 'door')
    const def = OPENING_DEFAULTS[kind]
    const o: Opening = {
      id,
      wallId: wall.id,
      kind,
      offset: num(v.offset, Number.NaN, 0),
      width: num(v.width, def.width, 1, 100000),
      height: num(v.height, def.height, 1, 100000),
      sill: num(v.sill, def.sill, 0, 100000),
      hinge: oneOf(v.hinge, ['a', 'b'] as const, 'a'),
      swing: oneOf(v.swing, ['left', 'right'] as const, 'left'),
    }
    const frame = optStr(v.frameMaterialId)
    if (frame) o.frameMaterialId = frame
    const leaf = optStr(v.leafMaterialId)
    if (leaf) o.leafMaterialId = leaf
    const sashes = optNum(v.sashes, 1, 12)
    if (sashes !== undefined) o.sashes = Math.round(sashes)
    const sillBoard = optNum(v.sillBoard, 0, 2000)
    if (sillBoard !== undefined) o.sillBoard = sillBoard
    const curtain = readCurtain(v.curtain)
    if (curtain) o.curtain = curtain
    doc.openings[id] = o
  }

  // ── rooms ──
  for (const [id, v] of entries(raw.rooms, 'r')) {
    const anchor = vec2(v.anchor)
    if (!anchor) continue
    const type = oneOf(v.type, ROOM_TYPES, 'other')
    const room: Room = {
      id,
      levelId: levelOf(v.levelId),
      anchor,
      name: str(v.name, ROOM_TYPE_NAMES[type].ru),
      type,
      floor: readFinish(v.floor, DEFAULT_MATERIALS.floor),
      ceiling: readCeiling(v.ceiling),
      skirting: num(v.skirting, 80, 0, 1000),
    }
    const sk = optStr(v.skirtingMaterialId)
    room.skirtingMaterialId = sk ?? DEFAULT_MATERIALS.skirting
    const labelledArea = optNum(v.labelledArea, 0, 1e6)
    if (labelledArea !== undefined && labelledArea > 0) room.labelledArea = labelledArea
    doc.rooms[id] = room
  }

  // ── items ──
  for (const [id, v] of entries(raw.items, 'i')) {
    const assetId = optStr(v.assetId)
    const p = vec2(v)
    if (!assetId || !p) continue
    const item: Item = {
      id,
      levelId: levelOf(v.levelId),
      assetId,
      x: p.x,
      y: p.y,
      elevation: num(v.elevation, 0, -100000, 100000),
      rotation: num(v.rotation, 0),
      size: readSize(v.size, { w: 500, d: 500, h: 500 }),
      mount: oneOf(v.mount, MOUNT_KINDS, 'floor'),
    }
    const name = optStr(v.name)
    if (name) item.name = name
    if (v.mirrored === true) item.mirrored = true
    const overrides = stringRecord(v.overrides)
    if (overrides) item.overrides = overrides
    const tint = optColor(v.tint)
    if (tint) item.tint = tint
    const params = paramRecord(v.params)
    if (params) item.params = params
    if (v.locked === true) item.locked = true
    if (v.hidden === true) item.hidden = true
    const groupId = optStr(v.groupId)
    if (groupId) item.groupId = groupId
    doc.items[id] = item
  }

  // ── lights ──
  for (const [id, v] of entries(raw.lights, 'l')) {
    const p = vec2(v)
    if (!p) continue
    const levelId = levelOf(v.levelId)
    const light: Light = {
      id,
      levelId,
      kind: oneOf(v.kind, LIGHT_KINDS, 'ceiling'),
      x: p.x,
      y: p.y,
      elevation: num(v.elevation, levels[levelId].height - 60, 0, 100000),
      temperature: num(v.temperature, 3000, 1000, 20000),
      lumens: num(v.lumens, 1500, 0, 1e6),
      on: bool(v.on, true),
    }
    const rotation = optNum(v.rotation)
    if (rotation !== undefined) light.rotation = rotation
    if (isObj(v.size)) light.size = { w: num(v.size.w, 600, 1, 100000), d: num(v.size.d, 600, 1, 100000) }
    doc.lights[id] = light
  }

  // ── annotations ──
  for (const [id, v] of entries(raw.dimensions, 'd')) {
    const a = vec2(v.a)
    const b = vec2(v.b)
    if (!a || !b) continue
    const d: Dimension = { id, levelId: levelOf(v.levelId), a, b, offset: num(v.offset, 300) }
    doc.dimensions[id] = d
  }
  for (const [id, v] of entries(raw.labels, 't')) {
    const p = vec2(v)
    if (!p) continue
    const l: Label = { id, levelId: levelOf(v.levelId), x: p.x, y: p.y, text: str(v.text, ''), size: num(v.size, 200, 1, 100000) }
    doc.labels[id] = l
  }
  for (const [id, v] of entries(raw.underlays, 'u')) {
    const src = optStr(v.src)
    if (!src) continue
    const u: Underlay = {
      id,
      levelId: levelOf(v.levelId),
      src,
      x: num(v.x, 0),
      y: num(v.y, 0),
      scale: num(v.scale, 10, 1e-6, 1e6),
      rotation: num(v.rotation, 0),
      opacity: num(v.opacity, 0.5, 0, 1),
      visible: bool(v.visible, true),
      locked: bool(v.locked, false),
      widthPx: num(v.widthPx, 0, 0),
      heightPx: num(v.heightPx, 0, 0),
    }
    doc.underlays[id] = u
  }
  for (const [id, v] of entries(raw.cameras, 'c')) {
    const c: CameraBookmark = {
      id,
      name: str(v.name, 'Камера'),
      position: triple(v.position, [0, 1.6, 0]),
      target: triple(v.target, [0, 1.2, -1]),
      fov: num(v.fov, 60, 5, 150),
      mode: oneOf(v.mode, ['orbit', 'walk'] as const, 'orbit'),
    }
    doc.cameras[id] = c
  }

  // ── project-local catalogue ──
  for (const [id, v] of entries(raw.materials, 'm')) doc.materials[id] = readMaterial(id, v)
  for (const [id, v] of entries(raw.assets, 'a')) doc.assets[id] = readAsset(id, v)

  // openings without an offset go to the middle of their wall (clamping happens in normalize)
  for (const id in doc.openings) {
    const o = doc.openings[id]
    if (Number.isNaN(o.offset)) {
      const w = doc.walls[o.wallId]
      const a = doc.nodes[w.a]
      const b = doc.nodes[w.b]
      o.offset = Math.hypot(b.x - a.x, b.y - a.y) / 2
    }
  }

  normalize(doc)
  syncRooms(doc)
  return doc
}
