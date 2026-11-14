/**
 * Bill of materials / quantity take-off for the whole document (all levels).
 *  - floors: m² per material + pattern, tile count with waste, laminate packs
 *  - walls: finish m² per material (zones respected, openings deducted), paint litres, wallpaper rolls, wall tiles
 *  - ceilings: m² per material, cornice metres
 *  - skirting: metres per material (door openings deducted), planks
 *  - openings by kind and size, items by asset, lights by kind
 * Pure TS.
 */
import type {
  Asset,
  Catalog,
  DerivedPlan,
  DerivedRoom,
  Doc,
  Id,
  LightKind,
  Material,
  OpeningKind,
  Room,
  TilePattern,
  Vec2,
  Wall,
} from './types'
import { BUILTIN_ASSETS, BUILTIN_MATERIALS, ROOM_TYPE_NAMES } from './defaults'
import { derivePlan } from './derive'

export type BomGroup = 'Полы' | 'Стены' | 'Потолки' | 'Плинтус' | 'Двери и окна' | 'Мебель и оборудование' | 'Освещение'

export interface BomRow {
  group: BomGroup
  name: string
  /** 'м²' | 'м' | 'шт' | 'л' | 'рул.' | 'уп.' */
  unit: string
  quantity: number
  note?: string
  /** material / asset id the row refers to, when applicable */
  refId?: Id
  /** room names the row comes from */
  rooms?: string[]
}

export interface BomOptions {
  /** precomputed derived plans per level id */
  derived?: Record<Id, DerivedPlan>
  /** paint: coats and coverage m² per litre per coat (defaults 2 and 10) */
  paintCoats?: number
  paintCoverage?: number
  /** wallpaper roll width × length, m (defaults 0.53 × 10.05) */
  rollWidth?: number
  rollLength?: number
  /** laminate / parquet pack area, m² (default 2.0) */
  packArea?: number
  /** skirting plank length, m (default 2.5) */
  skirtingPlank?: number
}

const DOOR_LIKE: ReadonlySet<OpeningKind> = new Set<OpeningKind>([
  'door',
  'doubleDoor',
  'slidingDoor',
  'entranceDoor',
  'arch',
  'opening',
  'balconyDoor',
  'frenchWindow',
])

const OPENING_NAMES: Record<OpeningKind, string> = {
  door: 'Дверь межкомнатная',
  doubleDoor: 'Дверь двустворчатая',
  slidingDoor: 'Дверь раздвижная',
  entranceDoor: 'Дверь входная',
  arch: 'Арка',
  opening: 'Проём',
  window: 'Окно',
  frenchWindow: 'Окно французское',
  balconyDoor: 'Дверь балконная',
  balconyBlock: 'Балконный блок',
}

const LIGHT_NAMES: Record<LightKind, string> = {
  ceiling: 'Светильник потолочный',
  spot: 'Светильник точечный',
  pendant: 'Светильник подвесной',
  point: 'Источник света точечный',
  strip: 'Светодиодная лента',
  area: 'Светильник панельный',
}

const round = (v: number, d = 2): number => {
  const k = 10 ** d
  return Math.round(v * k) / k
}
const fmt = (v: number, d = 2): string => String(round(v, d)).replace('.', ',')

function lookupMaterial(doc: Doc, catalog: Catalog | undefined, id: Id | undefined): Material | undefined {
  if (!id) return undefined
  return doc.materials[id] ?? catalog?.materials.find((m) => m.id === id) ?? BUILTIN_MATERIALS.find((m) => m.id === id)
}

function lookupAsset(doc: Doc, catalog: Catalog | undefined, id: Id): Asset | undefined {
  return doc.assets[id] ?? catalog?.assets.find((a) => a.id === id) ?? BUILTIN_ASSETS.find((a) => a.id === id)
}

function materialName(m: Material | undefined, id: Id): string {
  return m ? m.nameRu || m.name || id : id
}

function roomName(rec: Room | undefined, r: DerivedRoom): string {
  if (rec) return rec.name || ROOM_TYPE_NAMES[rec.type]?.ru || rec.id
  return r.roomId
}

const PATTERN_NAMES: Record<string, string> = {
  grid: 'прямая',
  brick: 'вразбежку 1/2',
  brickThird: 'вразбежку 1/3',
  herringbone: 'ёлочка',
  chevron: 'французская ёлка',
  hex: 'соты',
  basket: 'плетёнка',
  diagonal: 'по диагонали',
  planks: 'доска',
}

function isTileCategory(m: Material | undefined): boolean {
  return !!m && (m.category === 'tile' || m.category === 'stone' || m.category === 'marble')
}
function isPlankCategory(m: Material | undefined): boolean {
  return !!m && (m.category === 'laminate' || m.category === 'parquet' || m.category === 'wood')
}

/** tile size (mm) and grout from the pattern or the material */
function tileOf(pattern: TilePattern | undefined, m: Material | undefined): { w: number; h: number; grout: number; type: string } | null {
  const p = pattern && pattern.type !== 'none' ? pattern : m?.pattern && m.pattern.type !== 'none' ? m.pattern : undefined
  if (p && p.tileW > 0 && p.tileH > 0) return { w: p.tileW, h: p.tileH, grout: Math.max(0, p.grout || 0), type: p.type }
  if (isTileCategory(m) && m?.sizeMm && m.sizeMm[0] > 0 && m.sizeMm[1] > 0) return { w: m.sizeMm[0], h: m.sizeMm[1], grout: 2, type: 'grid' }
  return null
}

function wasteFor(type: string): number {
  return type === 'diagonal' || type === 'herringbone' || type === 'chevron' ? 0.15 : 0.1
}

interface Acc {
  key: string
  materialId: Id
  pattern?: TilePattern
  area: number
  rooms: Set<string>
}

interface WallpaperAcc {
  materialId: Id
  /** per room: total face length mm and band height mm */
  perRoom: Map<string, { length: number; height: number }>
  area: number
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

export function computeBom(doc: Doc, catalog?: Catalog, opts: BomOptions = {}): BomRow[] {
  const coats = opts.paintCoats ?? 2
  const coverage = opts.paintCoverage ?? 10
  const rollW = (opts.rollWidth ?? 0.53) * 1000
  const rollL = (opts.rollLength ?? 10.05) * 1000
  const packArea = opts.packArea ?? 2.0
  const plank = opts.skirtingPlank ?? 2.5

  const floors = new Map<string, Acc>()
  const walls = new Map<string, Acc>()
  const wallpaper = new Map<Id, WallpaperAcc>()
  const ceilings = new Map<string, Acc>()
  const cornice = new Map<string, { length: number; profile: number; rooms: Set<string> }>()
  const skirting = new Map<string, { length: number; height: number; materialId?: Id; rooms: Set<string> }>()

  const addAcc = (map: Map<string, Acc>, materialId: Id, pattern: TilePattern | undefined, area: number, room: string) => {
    if (area <= 1e-6) return
    const p = pattern && pattern.type !== 'none' ? pattern : undefined
    const key = p ? `${materialId}|${p.type}|${p.tileW}x${p.tileH}|${p.grout}` : materialId
    let a = map.get(key)
    if (!a) {
      a = { key, materialId, pattern: p, area: 0, rooms: new Set() }
      map.set(key, a)
    }
    a.area += area
    a.rooms.add(room)
  }

  const openingsByWall = new Map<Id, typeof doc.openings[string][]>()
  for (const o of Object.values(doc.openings)) {
    const l = openingsByWall.get(o.wallId) ?? []
    l.push(o)
    openingsByWall.set(o.wallId, l)
  }

  for (const levelId of doc.levelOrder.length ? doc.levelOrder : Object.keys(doc.levels)) {
    if (!doc.levels[levelId]) continue
    const plan = opts.derived?.[levelId] ?? derivePlan(doc, levelId)
    for (const r of plan.rooms) {
      const rec = doc.rooms[r.roomId]
      const rn = roomName(rec, r)
      // ── floor
      if (rec?.floor?.materialId) addAcc(floors, rec.floor.materialId, rec.floor.pattern, r.area, rn)
      // ── ceiling
      const outdoor = rec?.type === 'balcony' || rec?.type === 'loggia'
      if (rec?.ceiling?.materialId) {
        addAcc(ceilings, rec.ceiling.materialId, undefined, r.area, rn)
        if ((rec.ceiling.cornice ?? 0) > 0) {
          const key = `${rec.ceiling.cornice}`
          const c = cornice.get(key) ?? { length: 0, profile: rec.ceiling.cornice ?? 0, rooms: new Set<string>() }
          c.length += r.perimeter
          c.rooms.add(rn)
          cornice.set(key, c)
        }
      }
      // ── walls & skirting along the room's boundary edges
      let doorCut = 0
      const wpRoom = new Map<Id, { length: number; height: number }>()
      for (const e of r.edges) {
        const w: Wall | undefined = doc.walls[e.wallId]
        const g = plan.wallGeoms[e.wallId]
        if (!w || !g) continue
        if (w.kind === 'virtual' || w.kind === 'glazing') continue
        const L = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y)
        if (L < 1) continue
        const dir: Vec2 = g.length > 0 ? { x: (g.b.x - g.a.x) / g.length, y: (g.b.y - g.a.y) / g.length } : { x: 1, y: 0 }
        const u = (p: Vec2) => (p.x - g.a.x) * dir.x + (p.y - g.a.y) * dir.y
        const e0 = Math.min(u(e.from), u(e.to))
        const e1 = Math.max(u(e.from), u(e.to))
        const ceilingH = rec?.ceiling?.height ?? w.height
        const H = Math.max(0, Math.min(w.height, outdoor ? w.height : ceilingH))
        const ops = (openingsByWall.get(w.id) ?? [])
          .map((o) => ({ o, len: overlap(o.offset - o.width / 2, o.offset + o.width / 2, e0, e1) }))
          .filter((x) => x.len > 0)
        for (const { o, len } of ops) {
          if (o.sill <= 10 && DOOR_LIKE.has(o.kind)) doorCut += len
          else if (o.kind === 'balconyBlock') doorCut += Math.min(len, Math.min(800, o.width * 0.45))
        }
        const side = w[e.side]
        // bands: [from, to, materialId]
        const bands: [number, number, Id][] = []
        const zones = (side.zones ?? [])
          .map((z) => [Math.max(0, z.from), Math.min(H, z.to), z.materialId] as [number, number, Id])
          .filter((z) => z[1] > z[0])
          .sort((a, b) => a[0] - b[0])
        let cur = 0
        for (const z of zones) {
          if (z[0] > cur) bands.push([cur, z[0], side.materialId])
          const zFrom = Math.max(cur, z[0])
          if (z[1] > zFrom) bands.push([zFrom, z[1], z[2]])
          cur = Math.max(cur, z[1])
        }
        if (cur < H) bands.push([cur, H, side.materialId])
        for (const [b0, b1, mid] of bands) {
          let area = L * (b1 - b0)
          for (const { o, len } of ops) area -= len * overlap(o.sill, o.sill + o.height, b0, b1)
          area = Math.max(0, area) / 1e6
          const m = lookupMaterial(doc, catalog, mid)
          addAcc(walls, mid, m?.category === 'wallpaper' ? undefined : m?.pattern, area, rn)
          if (m?.category === 'wallpaper') {
            const k = wpRoom.get(mid) ?? { length: 0, height: 0 }
            k.length += L
            k.height = Math.max(k.height, b1 - b0)
            wpRoom.set(mid, k)
            const acc = wallpaper.get(mid) ?? { materialId: mid, perRoom: new Map(), area: 0 }
            acc.area += area
            wallpaper.set(mid, acc)
          }
        }
      }
      for (const [mid, v] of wpRoom) {
        const acc = wallpaper.get(mid)!
        const prev = acc.perRoom.get(rn)
        acc.perRoom.set(rn + (prev ? `#${r.roomId}` : ''), v)
      }
      // ── skirting
      if (rec && rec.skirting > 0 && !outdoor) {
        const len = Math.max(0, r.perimeter - doorCut / 1000)
        const key = `${rec.skirtingMaterialId ?? ''}|${rec.skirting}`
        const s = skirting.get(key) ?? { length: 0, height: rec.skirting, materialId: rec.skirtingMaterialId, rooms: new Set<string>() }
        s.length += len
        s.rooms.add(rn)
        skirting.set(key, s)
      }
    }
  }

  const rows: BomRow[] = []
  const sortedRooms = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, 'ru'))

  // ── floors
  for (const a of [...floors.values()].sort((x, y) => y.area - x.area)) {
    const m = lookupMaterial(doc, catalog, a.materialId)
    const pn = a.pattern ? PATTERN_NAMES[a.pattern.type] : undefined
    const name = materialName(m, a.materialId) + (pn ? ` (${pn})` : '')
    rows.push({ group: 'Полы', name, unit: 'м²', quantity: round(a.area), refId: a.materialId, rooms: sortedRooms(a.rooms) })
    const tile = tileOf(a.pattern, m)
    const planks = isPlankCategory(m) || a.pattern?.type === 'planks'
    if (planks && (m?.category === 'laminate' || m?.category === 'parquet' || !tile || a.pattern?.type === 'planks')) {
      const need = a.area * 1.1
      rows.push({
        group: 'Полы',
        name: `${materialName(m, a.materialId)} — упаковки`,
        unit: 'уп.',
        quantity: Math.ceil(need / packArea),
        note: `${fmt(need)} м² с запасом 10%, упаковка ${fmt(packArea)} м²`,
        refId: a.materialId,
      })
    } else if (tile) {
      const waste = wasteFor(a.pattern?.type ?? tile.type)
      const cell = ((tile.w + tile.grout) * (tile.h + tile.grout)) / 1e6
      const count = Math.ceil((a.area * (1 + waste)) / cell)
      rows.push({
        group: 'Полы',
        name: `${materialName(m, a.materialId)} — плитка ${Math.round(tile.w)}×${Math.round(tile.h)} мм`,
        unit: 'шт',
        quantity: count,
        note: `запас ${Math.round(waste * 100)}%, шов ${fmt(tile.grout, 1)} мм`,
        refId: a.materialId,
      })
    } else if (m?.category === 'carpet') {
      rows.push({
        group: 'Полы',
        name: `${materialName(m, a.materialId)} — с запасом`,
        unit: 'м²',
        quantity: round(a.area * 1.1),
        note: 'запас 10% на подрезку',
        refId: a.materialId,
      })
    }
  }

  // ── walls
  for (const a of [...walls.values()].sort((x, y) => y.area - x.area)) {
    const m = lookupMaterial(doc, catalog, a.materialId)
    const name = materialName(m, a.materialId)
    rows.push({ group: 'Стены', name, unit: 'м²', quantity: round(a.area), refId: a.materialId, rooms: sortedRooms(a.rooms), note: 'за вычетом проёмов' })
    if (!m || m.category === 'paint') {
      if (m) {
        const litres = (a.area * coats) / coverage
        rows.push({
          group: 'Стены',
          name: `${name} — краска`,
          unit: 'л',
          quantity: round(litres, 1),
          note: `${coats} слоя, расход ${fmt(1 / coverage, 2)} л/м²`,
          refId: a.materialId,
        })
      }
    } else if (m.category === 'wallpaper') {
      const wp = wallpaper.get(a.materialId)
      if (wp) {
        let rolls = 0
        for (const v of wp.perRoom.values()) {
          const stripH = v.height + 100
          const perRoll = Math.max(1, Math.floor(rollL / stripH))
          const strips = Math.ceil(v.length / rollW)
          rolls += strips / perRoll
        }
        rows.push({
          group: 'Стены',
          name: `${name} — обои`,
          unit: 'рул.',
          quantity: Math.ceil(rolls),
          note: `рулон ${fmt(rollW / 1000)}×${fmt(rollL / 1000)} м, по полосам без вычета проёмов`,
          refId: a.materialId,
        })
      }
    } else {
      const tile = tileOf(a.pattern, m)
      if (tile && (isTileCategory(m) || a.pattern)) {
        const waste = wasteFor(a.pattern?.type ?? tile.type)
        const cell = ((tile.w + tile.grout) * (tile.h + tile.grout)) / 1e6
        rows.push({
          group: 'Стены',
          name: `${name} — плитка ${Math.round(tile.w)}×${Math.round(tile.h)} мм`,
          unit: 'шт',
          quantity: Math.ceil((a.area * (1 + waste)) / cell),
          note: `запас ${Math.round(waste * 100)}%, шов ${fmt(tile.grout, 1)} мм`,
          refId: a.materialId,
        })
      }
    }
  }

  // ── ceilings
  for (const a of [...ceilings.values()].sort((x, y) => y.area - x.area)) {
    const m = lookupMaterial(doc, catalog, a.materialId)
    const name = materialName(m, a.materialId)
    rows.push({ group: 'Потолки', name, unit: 'м²', quantity: round(a.area), refId: a.materialId, rooms: sortedRooms(a.rooms) })
    if (m?.category === 'paint') {
      rows.push({
        group: 'Потолки',
        name: `${name} — краска`,
        unit: 'л',
        quantity: round((a.area * coats) / coverage, 1),
        note: `${coats} слоя, расход ${fmt(1 / coverage, 2)} л/м²`,
        refId: a.materialId,
      })
    }
  }
  for (const c of cornice.values()) {
    rows.push({
      group: 'Потолки',
      name: `Карниз потолочный ${Math.round(c.profile)} мм`,
      unit: 'м',
      quantity: round(c.length * 1.05),
      note: `${Math.ceil((c.length * 1.05) / 2)} шт по 2 м, запас 5%`,
      rooms: sortedRooms(c.rooms),
    })
  }

  // ── skirting
  for (const s of skirting.values()) {
    const m = lookupMaterial(doc, catalog, s.materialId)
    const need = s.length * 1.05
    rows.push({
      group: 'Плинтус',
      name: `Плинтус ${Math.round(s.height)} мм${s.materialId ? ` — ${materialName(m, s.materialId)}` : ''}`,
      unit: 'м',
      quantity: round(s.length),
      note: `${Math.ceil(need / plank)} шт по ${fmt(plank, 1)} м (запас 5%), за вычетом дверных проёмов`,
      refId: s.materialId,
      rooms: sortedRooms(s.rooms),
    })
  }

  // ── openings
  const openings = new Map<string, { kind: OpeningKind; w: number; h: number; n: number }>()
  for (const o of Object.values(doc.openings)) {
    if (!doc.walls[o.wallId]) continue
    const w = Math.round(o.width / 10) * 10
    const h = Math.round(o.height / 10) * 10
    const key = `${o.kind}|${w}|${h}`
    const e = openings.get(key) ?? { kind: o.kind, w, h, n: 0 }
    e.n++
    openings.set(key, e)
  }
  const kindOrder = Object.keys(OPENING_NAMES) as OpeningKind[]
  for (const e of [...openings.values()].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.w - b.w || a.h - b.h)) {
    rows.push({ group: 'Двери и окна', name: `${OPENING_NAMES[e.kind]} ${e.w}×${e.h} мм`, unit: 'шт', quantity: e.n })
  }

  // ── items
  const items = new Map<string, { name: string; n: number; sizes: Set<string>; assetId: Id }>()
  for (const it of Object.values(doc.items)) {
    const asset = lookupAsset(doc, catalog, it.assetId)
    const name = it.name || asset?.nameRu || asset?.name || it.assetId
    const key = `${it.assetId}|${name}`
    const e = items.get(key) ?? { name, n: 0, sizes: new Set<string>(), assetId: it.assetId }
    e.n++
    e.sizes.add(`${Math.round(it.size.w)}×${Math.round(it.size.d)}×${Math.round(it.size.h)}`)
    items.set(key, e)
  }
  for (const e of [...items.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
    rows.push({
      group: 'Мебель и оборудование',
      name: e.name,
      unit: 'шт',
      quantity: e.n,
      note: `${[...e.sizes].join(', ')} мм`,
      refId: e.assetId,
    })
  }

  // ── lights
  const lights = new Map<LightKind, { n: number; lumens: number; stripMm: number }>()
  for (const l of Object.values(doc.lights)) {
    const e = lights.get(l.kind) ?? { n: 0, lumens: 0, stripMm: 0 }
    e.n++
    e.lumens += l.lumens || 0
    if (l.kind === 'strip') e.stripMm += l.size?.w ?? 1000
    lights.set(l.kind, e)
  }
  for (const [kind, e] of lights) {
    if (kind === 'strip') {
      rows.push({
        group: 'Освещение',
        name: LIGHT_NAMES[kind],
        unit: 'м',
        quantity: round(e.stripMm / 1000),
        note: `${e.n} отрезк., всего ${Math.round(e.lumens)} лм`,
      })
    } else {
      rows.push({ group: 'Освещение', name: LIGHT_NAMES[kind], unit: 'шт', quantity: e.n, note: `всего ${Math.round(e.lumens)} лм` })
    }
  }
  return rows
}

/** BOM rows as CSV (semicolon-separated, Excel-friendly in RU locales). */
export function bomToCsv(rows: BomRow[]): string {
  const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = ['Раздел;Наименование;Ед.;Кол-во;Примечание']
  for (const r of rows) lines.push([r.group, r.name, r.unit, String(r.quantity).replace('.', ','), r.note ?? ''].map(q).join(';'))
  return lines.join('\n')
}
