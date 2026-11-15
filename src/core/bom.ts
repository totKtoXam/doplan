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
  PriceUnit,
  ProductRef,
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
  /**
   * id the row refers to and prices are keyed by: a material / asset id, or a synthetic key for
   * openings (`opening:door:800x2000`), lights (`light:spot`) and cornices (`cornice:60`)
   */
  refId?: Id
  /** room names the row comes from */
  rooms?: string[]
  /** a "to buy" row (with waste, in packs / pieces / litres / rolls) as opposed to a measured quantity */
  purchase?: boolean
  /** the same purchase in other units (tiles: шт and м²; packs: уп. and м²; paint: л and cans) */
  alt?: Partial<Record<PriceUnit, number>>
  /** price per `priceUnit` in the project currency, the unit it is quoted in, and the row total */
  price?: number
  priceUnit?: PriceUnit
  total?: number
  vendor?: string
  sku?: string
  url?: string
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

/** waste allowance: the pattern's own, else straight 10 %, diagonal 15 %, herringbone / chevron 20 % */
export function wasteFor(type: string, pattern?: TilePattern): number {
  if (pattern?.waste !== undefined) return pattern.waste
  if (type === 'herringbone' || type === 'chevron') return 0.2
  if (type === 'diagonal' || type === 'hex') return 0.15
  return 0.1
}

/**
 * The product (price, vendor, link) of a material / asset / synthetic key: the project's price list
 * entry over the material's own product card, field by field.
 */
export function productFor(doc: Doc, catalog: Catalog | undefined, refId: Id | undefined): ProductRef | undefined {
  if (!refId) return undefined
  const own = doc.design?.priceList?.[refId]
  const card = lookupMaterial(doc, catalog, refId)?.product
  if (own && card) return { ...card, ...own }
  return own ?? card
}

/** wallpaper strip length for a band height, with trimming allowance and pattern repeat */
export function wallpaperStrip(bandH: number, repeat = 0, match: 'straight' | 'offset' | 'free' = 'straight'): number {
  const base = bandH + 100
  if (repeat <= 0 || match === 'free') return base
  return Math.ceil(base / repeat) * repeat + (match === 'offset' ? repeat / 2 : 0)
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
    const key = p ? `${materialId}|${p.type}|${p.tileW}x${p.tileH}|${p.grout}|${p.waste ?? ''}` : materialId
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
        // bands: [from, to, materialId, pattern]
        type BandT = [number, number, Id, TilePattern | undefined]
        const bands: BandT[] = []
        const zones = (side.zones ?? [])
          .map((z) => [Math.max(0, z.from), Math.min(H, z.to), z.materialId, z.pattern] as BandT)
          .filter((z) => z[1] > z[0])
          .sort((a, b) => a[0] - b[0])
        let cur = 0
        for (const z of zones) {
          if (z[0] > cur) bands.push([cur, z[0], side.materialId, side.pattern])
          const zFrom = Math.max(cur, z[0])
          if (z[1] > zFrom) bands.push([zFrom, z[1], z[2], z[3]])
          cur = Math.max(cur, z[1])
        }
        if (cur < H) bands.push([cur, H, side.materialId, side.pattern])
        for (const [b0, b1, mid, bp] of bands) {
          let area = L * (b1 - b0)
          for (const { o, len } of ops) area -= len * overlap(o.sill, o.sill + o.height, b0, b1)
          area = Math.max(0, area) / 1e6
          const m = lookupMaterial(doc, catalog, mid)
          addAcc(walls, mid, m?.category === 'wallpaper' ? undefined : (bp ?? m?.pattern), area, rn)
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
  /**
   * Pack size of the product (m² per box, litres per can) when it is priced per pack, per its
   * content unit, or without a unit; a price per piece of something else leaves the pack unknown.
   */
  const packOf = (refId: Id, packUnit: PriceUnit, contentUnit: PriceUnit): number | undefined => {
    const p = productFor(doc, catalog, refId)
    return p?.pack && (!p.priceUnit || p.priceUnit === packUnit || p.priceUnit === contentUnit) ? p.pack : undefined
  }
  const paintRow = (group: BomGroup, m: Material, id: Id, area: number): BomRow => {
    const k = m.paint?.coats ?? coats
    const cov = m.paint?.coverage ?? coverage
    const litres = round((area * k) / cov, 1)
    const can = packOf(id, 'шт', 'л')
    const alt: BomRow['alt'] = { л: litres }
    if (can) alt['шт'] = Math.ceil(litres / can)
    return {
      group,
      name: `${materialName(m, id)} — краска`,
      unit: 'л',
      quantity: litres,
      note: `${k} ${k === 1 ? 'слой' : k < 5 ? 'слоя' : 'слоёв'}, расход ${fmt(1 / cov, 2)} л/м²${can ? `, ${alt['шт']} банок по ${fmt(can, 1)} л` : ''}`,
      refId: id,
      purchase: true,
      alt,
    }
  }
  const tileRow = (group: BomGroup, m: Material | undefined, id: Id, tile: { w: number; h: number; grout: number }, area: number, waste: number, cell: number): BomRow => {
    const count = Math.ceil((area * (1 + waste)) / cell)
    // boxes and per-m² prices are quoted in tile face area, not the laying pitch (tile + grout)
    const face = (tile.w * tile.h) / 1e6
    const pack = packOf(id, 'уп.', 'м²')
    const alt: BomRow['alt'] = { шт: count, 'м²': round(count * face) }
    if (pack) alt['уп.'] = Math.ceil((count * face) / pack)
    return {
      group,
      name: `${materialName(m, id)} — плитка ${Math.round(tile.w)}×${Math.round(tile.h)} мм`,
      unit: 'шт',
      quantity: count,
      note: `запас ${Math.round(waste * 100)}%, шов ${fmt(tile.grout, 1)} мм, ${fmt(count * face)} м²${pack ? `, ${alt['уп.']} уп. по ${fmt(pack)} м²` : ''}`,
      refId: id,
      purchase: true,
      alt,
    }
  }

  // ── floors
  for (const a of [...floors.values()].sort((x, y) => y.area - x.area)) {
    const m = lookupMaterial(doc, catalog, a.materialId)
    const pn = a.pattern ? PATTERN_NAMES[a.pattern.type] : undefined
    const name = materialName(m, a.materialId) + (pn ? ` (${pn})` : '')
    rows.push({ group: 'Полы', name, unit: 'м²', quantity: round(a.area), refId: a.materialId, rooms: sortedRooms(a.rooms) })
    const tile = tileOf(a.pattern, m)
    const planks = isPlankCategory(m) || a.pattern?.type === 'planks'
    if (planks && (m?.category === 'laminate' || m?.category === 'parquet' || !tile || a.pattern?.type === 'planks')) {
      const waste = wasteFor((a.pattern ?? m?.pattern)?.type ?? 'planks', a.pattern ?? m?.pattern)
      const need = a.area * (1 + waste)
      const pack = packOf(a.materialId, 'уп.', 'м²') ?? packArea
      const packs = Math.ceil(need / pack)
      rows.push({
        group: 'Полы',
        name: `${materialName(m, a.materialId)} — упаковки`,
        unit: 'уп.',
        quantity: packs,
        note: `${fmt(need)} м² с запасом ${Math.round(waste * 100)}%, упаковка ${fmt(pack)} м²`,
        refId: a.materialId,
        purchase: true,
        alt: { 'уп.': packs, 'м²': round(packs * pack) },
      })
    } else if (tile) {
      const waste = wasteFor(a.pattern?.type ?? tile.type, a.pattern ?? m?.pattern)
      const cell = ((tile.w + tile.grout) * (tile.h + tile.grout)) / 1e6
      rows.push(tileRow('Полы', m, a.materialId, tile, a.area, waste, cell))
    } else if (m?.category === 'carpet') {
      rows.push({
        group: 'Полы',
        name: `${materialName(m, a.materialId)} — с запасом`,
        unit: 'м²',
        quantity: round(a.area * 1.1),
        note: 'запас 10% на подрезку',
        refId: a.materialId,
        purchase: true,
      })
    }
  }

  // ── walls
  for (const a of [...walls.values()].sort((x, y) => y.area - x.area)) {
    const m = lookupMaterial(doc, catalog, a.materialId)
    const name = materialName(m, a.materialId)
    rows.push({ group: 'Стены', name, unit: 'м²', quantity: round(a.area), refId: a.materialId, rooms: sortedRooms(a.rooms), note: 'за вычетом проёмов' })
    if (!m || m.category === 'paint') {
      if (m) rows.push(paintRow('Стены', m, a.materialId, a.area))
    } else if (m.category === 'wallpaper') {
      const wp = wallpaper.get(a.materialId)
      if (wp) {
        const rw = m.wallpaper?.rollW ?? rollW
        const rl = m.wallpaper?.rollL ?? rollL
        const repeat = m.wallpaper?.repeat ?? 0
        const match = m.wallpaper?.match ?? 'straight'
        let rolls = 0
        for (const v of wp.perRoom.values()) {
          const stripH = wallpaperStrip(v.height, repeat, match)
          const perRoll = Math.max(1, Math.floor(rl / stripH))
          const strips = Math.ceil(v.length / rw)
          rolls += strips / perRoll
        }
        const rep = repeat > 0 && match !== 'free' ? `, раппорт ${Math.round(repeat)} мм${match === 'offset' ? ' со смещением' : ''}` : ''
        rows.push({
          group: 'Стены',
          name: `${name} — обои`,
          unit: 'рул.',
          quantity: Math.ceil(rolls),
          note: `рулон ${fmt(rw / 1000)}×${fmt(rl / 1000)} м${rep}, по полосам без вычета проёмов`,
          refId: a.materialId,
          purchase: true,
        })
      }
    } else {
      const tile = tileOf(a.pattern, m)
      if (tile && (isTileCategory(m) || a.pattern)) {
        const waste = wasteFor(a.pattern?.type ?? tile.type, a.pattern ?? m.pattern)
        const cell = ((tile.w + tile.grout) * (tile.h + tile.grout)) / 1e6
        rows.push(tileRow('Стены', m, a.materialId, tile, a.area, waste, cell))
      }
    }
  }

  // ── ceilings
  for (const a of [...ceilings.values()].sort((x, y) => y.area - x.area)) {
    const m = lookupMaterial(doc, catalog, a.materialId)
    const name = materialName(m, a.materialId)
    rows.push({ group: 'Потолки', name, unit: 'м²', quantity: round(a.area), refId: a.materialId, rooms: sortedRooms(a.rooms) })
    if (m?.category === 'paint') rows.push(paintRow('Потолки', m, a.materialId, a.area))
  }
  for (const c of cornice.values()) {
    const refId = `cornice:${Math.round(c.profile)}`
    const len = round(c.length * 1.05)
    const piece = packOf(refId, 'шт', 'м') ?? 2
    rows.push({
      group: 'Потолки',
      name: `Карниз потолочный ${Math.round(c.profile)} мм`,
      unit: 'м',
      quantity: len,
      note: `${Math.ceil(len / piece)} шт по ${fmt(piece, 1)} м, запас 5%`,
      rooms: sortedRooms(c.rooms),
      refId,
      purchase: true,
      alt: { м: len, шт: Math.ceil(len / piece) },
    })
  }

  // ── skirting
  for (const s of skirting.values()) {
    const m = lookupMaterial(doc, catalog, s.materialId)
    const need = s.length * 1.05
    const refId = `skirting:${s.materialId ?? ''}:${Math.round(s.height)}`
    const piece = packOf(refId, 'шт', 'м') ?? plank
    const pieces = Math.ceil(need / piece)
    rows.push({
      group: 'Плинтус',
      name: `Плинтус ${Math.round(s.height)} мм${s.materialId ? ` — ${materialName(m, s.materialId)}` : ''}`,
      unit: 'м',
      quantity: round(s.length),
      note: `${pieces} шт по ${fmt(piece, 1)} м (запас 5%), за вычетом дверных проёмов`,
      refId,
      rooms: sortedRooms(s.rooms),
      purchase: true,
      alt: { м: round(pieces * piece), шт: pieces },
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
    rows.push({ group: 'Двери и окна', name: `${OPENING_NAMES[e.kind]} ${e.w}×${e.h} мм`, unit: 'шт', quantity: e.n, refId: `opening:${e.kind}:${e.w}x${e.h}` })
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
        refId: `light:${kind}`,
      })
    } else {
      rows.push({ group: 'Освещение', name: LIGHT_NAMES[kind], unit: 'шт', quantity: e.n, note: `всего ${Math.round(e.lumens)} лм`, refId: `light:${kind}` })
    }
  }
  attachPrices(rows, doc, catalog)
  return rows
}

/** quantity of a row in `unit`, if it is known in that unit */
function qtyIn(r: BomRow, unit: PriceUnit): number | undefined {
  return r.alt?.[unit] ?? (r.unit === unit ? r.quantity : undefined)
}

/**
 * The rows of one refId within one group that a price goes on: every purchase row that has a
 * quantity in the price unit, else every measured row that has one. One material can produce
 * several rows (e.g. the same tile in two layouts), and each of them must be priced.
 * A price without a unit goes on the purchase rows in their own unit, else on the measured rows.
 */
export function priceTargets(list: BomRow[], priceUnit?: PriceUnit): BomRow[] {
  const buy = list.filter((r) => r.purchase)
  const measured = list.filter((r) => !r.purchase)
  if (!priceUnit) return buy.length ? buy : measured
  const has = (r: BomRow) => qtyIn(r, priceUnit) !== undefined
  return buy.some(has) ? buy.filter(has) : measured.filter(has)
}

/** rows grouped by `group|refId` (rows without a refId are left out) */
export function rowsByRef(rows: BomRow[]): Map<string, BomRow[]> {
  const byKey = new Map<string, BomRow[]>()
  for (const r of rows) {
    if (!r.refId) continue
    const k = `${r.group}|${r.refId}`
    const l = byKey.get(k) ?? []
    l.push(r)
    byKey.set(k, l)
  }
  return byKey
}

/** Put prices on the rows, see priceTargets. */
export function attachPrices(rows: BomRow[], doc: Doc, catalog?: Catalog): void {
  for (const list of rowsByRef(rows).values()) {
    const p = productFor(doc, catalog, list[0].refId)
    if (!p) continue
    for (const r of list) {
      if (p.vendor) r.vendor = p.vendor
      if (p.sku) r.sku = p.sku
      if (p.url) r.url = p.url
    }
    if (p.price === undefined) continue
    for (const target of priceTargets(list, p.priceUnit)) {
      const unit = p.priceUnit ?? (target.unit as PriceUnit)
      const q = qtyIn(target, unit) ?? target.quantity
      target.price = p.price
      target.priceUnit = unit
      target.total = round(p.price * q, 2)
    }
  }
}

export interface BomTotals {
  total: number
  byGroup: Partial<Record<BomGroup, number>>
  /** rows that carry a price / rows that could (have a refId) but do not */
  priced: number
  unpriced: number
}

export function bomTotals(rows: BomRow[]): BomTotals {
  const t: BomTotals = { total: 0, byGroup: {}, priced: 0, unpriced: 0 }
  const pricedKeys = new Set<string>()
  for (const r of rows) if (r.total !== undefined && r.refId) pricedKeys.add(`${r.group}|${r.refId}`)
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.total !== undefined) {
      t.total += r.total
      t.byGroup[r.group] = (t.byGroup[r.group] ?? 0) + r.total
      t.priced++
    } else if (r.refId) {
      const k = `${r.group}|${r.refId}`
      if (!pricedKeys.has(k) && !seen.has(k)) t.unpriced++
      seen.add(k)
    }
  }
  t.total = round(t.total, 2)
  return t
}

/** currencies offered in the project settings (ISO 4217); any other 3-letter code is accepted too */
export const CURRENCIES = ['KZT', 'RUB', 'USD', 'EUR', 'UZS', 'KGS', 'BYN', 'UAH', 'GEL', 'AMD', 'AZN', 'TRY', 'GBP', 'CNY', 'AED', 'PLN'] as const

/** money in the project currency ("12 500 ₸", "$1,200.00"); plain number when no currency is chosen */
export function formatMoney(v: number, currency?: string, locale = 'ru-RU'): string {
  const digits = Math.abs(v) >= 1000 || Number.isInteger(v) ? 0 : 2
  try {
    if (currency) return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v)
  } catch {
    /* unknown currency code: fall through to a plain number + code */
  }
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v)
  return currency ? `${n} ${currency}` : n
}

/** the currency's symbol (₸, ₽, $, €…) or the code itself */
export function currencySymbol(currency: string, locale = 'ru-RU'): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency')
    return part?.value ?? currency
  } catch {
    return currency
  }
}

const csvCell = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const csvNum = (v: number | undefined) => (v === undefined ? '' : String(v).replace('.', ','))

/** BOM rows as CSV (semicolon-separated, Excel-friendly in RU locales), with prices when present. */
export function bomToCsv(rows: BomRow[], currency?: string, t: (s: string) => string = (s) => s): string {
  const cur = currency ? ` (${currency})` : ''
  const head = ['Раздел', 'Наименование', 'Ед.', 'Кол-во', 'Примечание', 'Цена', 'За ед.', 'Сумма', 'Поставщик', 'Артикул', 'Ссылка']
  const lines = [head.map((h) => t(h) + (h === 'Цена' || h === 'Сумма' ? cur : '')).map(csvCell).join(';')]
  for (const r of rows)
    lines.push(
      [r.group, r.name, r.unit, csvNum(r.quantity), r.note ?? '', csvNum(r.price), r.priceUnit ?? '', csvNum(r.total), r.vendor ?? '', r.sku ?? '', r.url ?? '']
        .map(csvCell)
        .join(';'),
    )
  const totals = bomTotals(rows)
  if (totals.priced) lines.push([t('Итого'), '', '', '', '', '', '', csvNum(totals.total), '', '', ''].map(csvCell).join(';'))
  return lines.join('\n')
}

// ───────────────────────────── price list CSV ─────────────────────────────

const PRICE_HEADER = ['id', 'Наименование', 'Ед.', 'Цена', 'Упаковка', 'Поставщик', 'Артикул', 'Ссылка', 'Дата']
const UNITS: readonly PriceUnit[] = ['м²', 'м', 'шт', 'л', 'рул.', 'уп.']

/**
 * The project's price list as CSV: one line per priceable thing in the estimate (materials,
 * items, openings, lights…) plus any price-list entries not in the estimate. Fill the prices in
 * a spreadsheet and import it back with `parsePriceListCsv`.
 */
export function priceListToCsv(rows: BomRow[], doc: Doc, catalog?: Catalog): string {
  const lines = [PRICE_HEADER.join(';')]
  const seen = new Set<Id>()
  const line = (id: Id, name: string, unit: string, p: ProductRef | undefined) =>
    lines.push(
      [id, name, p?.priceUnit ?? unit, csvNum(p?.price), csvNum(p?.pack), p?.vendor ?? '', p?.sku ?? '', p?.url ?? '', p?.updatedAt ?? ''].map(csvCell).join(';'),
    )
  for (const r of rows) {
    if (!r.refId || seen.has(r.refId)) continue
    seen.add(r.refId)
    const purchase = rows.find((x) => x.refId === r.refId && x.purchase)
    line(r.refId, r.name.replace(/ — (упаковки|плитка .*|краска|обои|с запасом)$/, ''), (purchase ?? r).unit, productFor(doc, catalog, r.refId))
  }
  for (const [id, p] of Object.entries(doc.design?.priceList ?? {})) if (!seen.has(id)) line(id, '', p.priceUnit ?? '', p)
  return lines.join('\n')
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === sep) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function parseNum(s: string | undefined): number | undefined {
  if (!s) return undefined
  const n = Number(s.replace(/\s| /g, '').replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export interface PriceListImport {
  entries: Record<Id, ProductRef>
  /** 1-based line numbers that could not be read */
  skipped: number[]
}

/**
 * Text of a CSV file: UTF-8 (with or without BOM), else Windows-1251, which is what Excel's plain
 * «CSV (разделители)» writes on Russian-language Windows.
 */
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('windows-1251').decode(bytes)
  }
  return text.replace(/^﻿/, '')
}

/** a product link that can be opened: http(s) URLs as they are, a bare «shop.kz/item» gets https:// */
export function productUrl(s: string | undefined): string | undefined {
  const v = s?.trim()
  if (!v || /\s/.test(v)) return undefined
  if (/^https?:\/\/[^/]+\.[^/]/i.test(v)) return v
  if (/^[a-z]+:/i.test(v)) return undefined
  return /^[\p{L}\d-]+(\.[\p{L}\d-]+)+(\/|$|\?|#|:)/u.test(v) ? `https://${v}` : undefined
}

/** today's date in the user's time zone, YYYY-MM-DD (toISOString would give the UTC date) */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Read a price list CSV (`;` or `,` separated; header row with an `id` column). */
export function parsePriceListCsv(text: string, today = localDate()): PriceListImport {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const res: PriceListImport = { entries: {}, skipped: [] }
  const headerLine = lines.findIndex((l) => l.trim() !== '')
  if (headerLine < 0) return res
  const sep = (lines[headerLine].match(/;/g)?.length ?? 0) >= (lines[headerLine].match(/,/g)?.length ?? 0) ? ';' : ','
  const header = splitCsvLine(lines[headerLine], sep).map((h) => h.toLowerCase())
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)))
  const ci = {
    id: col('id', 'код'),
    unit: col('ед', 'unit'),
    price: col('цена', 'price'),
    pack: col('упаков', 'pack'),
    vendor: col('поставщик', 'vendor', 'магазин'),
    sku: col('артикул', 'sku'),
    url: col('ссылка', 'url', 'link'),
    date: col('дата', 'date', 'updated'),
  }
  if (ci.id < 0) {
    res.skipped.push(headerLine + 1)
    return res
  }
  for (let i = headerLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    const c = splitCsvLine(lines[i], sep)
    const id = c[ci.id]
    if (!id) {
      res.skipped.push(i + 1)
      continue
    }
    const p: ProductRef = { source: 'csv' }
    const price = parseNum(c[ci.price])
    if (price !== undefined) p.price = price
    const unit = c[ci.unit] as PriceUnit
    if (UNITS.includes(unit)) p.priceUnit = unit
    const pack = parseNum(c[ci.pack])
    if (pack) p.pack = pack
    if (ci.vendor >= 0 && c[ci.vendor]) p.vendor = c[ci.vendor]
    if (ci.sku >= 0 && c[ci.sku]) p.sku = c[ci.sku]
    const url = ci.url >= 0 ? productUrl(c[ci.url]) : undefined
    if (url) p.url = url
    p.updatedAt = (ci.date >= 0 && c[ci.date]) || today
    if (p.price === undefined && !p.vendor && !p.sku && !p.url && !p.pack) continue
    res.entries[id] = p
  }
  return res
}
