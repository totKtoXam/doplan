/**
 * Interior style presets ("dress the apartment in a style") and `applyStyle`, which re-finishes rooms:
 * walls, floor, ceiling, skirting, wet-zone tiling, kitchen apron, an accent wall, doors, curtains,
 * furniture material slots and light colour temperature — all from one preset, as one edit.
 *
 * Styles are international (not tied to one market). The style ↔ furniture-slot mapping lives here,
 * not in the asset catalogue: slots are matched by name and by the category of their default material.
 *
 * Pure: `applyStyle` mutates the given doc (an immer draft inside `tx`) and touches nothing else.
 */
import type {
  Asset,
  Catalog,
  DerivedPlan,
  DerivedRoom,
  Doc,
  FinishZone,
  Id,
  Material,
  Room,
  RoomType,
  Vec2,
} from './types'
import { builtinCatalog, findAsset, findMaterial } from './catalog'
import { derivePlan } from './derive'
import { pointInPolygon, projectOnSegment } from './geom'

// ───────────────────────────── model ─────────────────────────────

/** Finish surfaces a style decides. */
export interface StyleFinishes {
  /** walls of dry rooms */
  wallMain: Id
  /** one accent wall in living rooms / bedrooms (absent = no accent wall) */
  wallAccent?: Id
  /** walls of bathrooms and toilets (full height) */
  wallWet: Id
  /** kitchen splashback between worktop and wall units */
  apron: Id
  floorDry: Id
  floorWet: Id
  /** hallway / corridor / balcony floor (absent = floorDry) */
  floorHall?: Id
  ceiling: Id
  skirting: Id
  doorLeaf: Id
  doorFrame: Id
}

/** Furniture and textile materials, matched to item material slots (see `slotRole`). */
export interface StyleFurnishing {
  woodFurniture: Id
  /** kitchen and wardrobe fronts */
  cabinetFront: Id
  kitchenBody: Id
  worktop: Id
  /** upholstery of sofas, armchairs, beds */
  textileMain: Id
  /** upholstery of chairs, cushions, other textiles */
  textileAccent: Id
  linen: Id
  metal: Id
  rug: Id
  curtain: Id
  sheer: Id
}

export type FurnishingRole = keyof StyleFurnishing

export interface StylePreset {
  id: Id
  name: string
  nameRu: string
  description: string
  descriptionRu: string
  finishes: StyleFinishes
  furnishing: StyleFurnishing
  /** skirting board height mm (dry rooms) */
  skirtingHeight: number
  /** ceiling cornice height mm (dry rooms), 0 = none */
  cornice: number
  /** colour temperature of the lights, K */
  lightTemperature: number
  tags?: string[]
  custom?: boolean
}

export type SwatchRole = 'base' | 'secondary' | 'accent' | 'floor' | 'wood' | 'metal'

export interface StyleSwatch {
  role: SwatchRole
  materialId: Id
}

/** 60 / 30 / 10 palette of a style plus its floor, wood and metal (for swatch strips). */
export function stylePalette(s: StylePreset): StyleSwatch[] {
  const out: StyleSwatch[] = [
    { role: 'base', materialId: s.finishes.wallMain },
    { role: 'secondary', materialId: s.finishes.wallAccent ?? s.furnishing.textileMain },
    { role: 'accent', materialId: s.furnishing.textileAccent },
    { role: 'floor', materialId: s.finishes.floorDry },
    { role: 'wood', materialId: s.furnishing.woodFurniture },
    { role: 'metal', materialId: s.furnishing.metal },
  ]
  return out
}

/** every material id a style refers to (for validation and for "materials of this style" filters) */
export function styleMaterialIds(s: StylePreset): Id[] {
  const ids = new Set<Id>()
  for (const v of Object.values(s.finishes)) if (v) ids.add(v)
  for (const v of Object.values(s.furnishing)) if (v) ids.add(v)
  return [...ids]
}

// ───────────────────────────── built-in styles ─────────────────────────────

const SHEER = 'mat_fabric_sheer_white'

export const BUILTIN_STYLES: StylePreset[] = [
  {
    id: 'style_warm_minimal',
    name: 'Warm minimalism',
    nameRu: 'Тёплый минимализм',
    description: 'Warm whites and greige, natural oak, bouclé, travertine; few objects, soft 2700 K light.',
    descriptionRu: 'Тёплый белый и грейдж, натуральный дуб, букле, травертин; мало предметов, мягкий свет 2700 K.',
    finishes: {
      wallMain: 'mat_ncs_0502_y',
      wallAccent: 'mat_ncs_2005_y20r',
      wallWet: 'mat_tile_beige',
      apron: 'mat_tile_white_matt',
      floorDry: 'mat_parquet_oak',
      floorWet: 'mat_st_travertine',
      floorHall: 'mat_st_travertine',
      ceiling: 'mat_ceiling_white',
      skirting: 'mat_ncs_0502_y',
      doorLeaf: 'mat_ncs_0502_y',
      doorFrame: 'mat_ncs_0502_y',
    },
    furnishing: {
      woodFurniture: 'mat_wood_oak_natural',
      cabinetFront: 'mat_ncs_1002_y',
      kitchenBody: 'mat_wood_white',
      worktop: 'mat_stone_quartz_white',
      textileMain: 'mat_st_fabric_boucle_ivory',
      textileAccent: 'mat_fabric_linen_beige',
      linen: 'mat_fabric_white',
      metal: 'mat_metal_brass',
      rug: 'mat_st_carpet_wool_cream',
      curtain: 'mat_fabric_linen_beige',
      sheer: SHEER,
    },
    skirtingHeight: 60,
    cornice: 0,
    lightTemperature: 2700,
    tags: ['minimal', 'warm'],
  },
  {
    id: 'style_scandi',
    name: 'Scandinavian',
    nameRu: 'Скандинавский',
    description: 'White walls, bleached oak, grey textiles with a mustard accent, black metal; bright 3000 K.',
    descriptionRu: 'Белые стены, беленый дуб, серый текстиль с горчичным акцентом, чёрный металл; светло, 3000 K.',
    finishes: {
      wallMain: 'mat_ral_9010',
      wallAccent: 'mat_ncs_2010_r90b',
      wallWet: 'mat_tile_white_matt',
      apron: 'mat_tile_metro_white',
      floorDry: 'mat_parquet_light',
      floorWet: 'mat_tile_grey',
      floorHall: 'mat_tile_grey',
      ceiling: 'mat_ceiling_white',
      skirting: 'mat_ral_9010',
      doorLeaf: 'mat_ral_9010',
      doorFrame: 'mat_ral_9010',
    },
    furnishing: {
      woodFurniture: 'mat_wood_oak_bleached',
      cabinetFront: 'mat_ral_9016',
      kitchenBody: 'mat_wood_white',
      worktop: 'mat_wood_oak_bleached',
      textileMain: 'mat_fabric_grey',
      textileAccent: 'mat_fabric_mustard',
      linen: 'mat_fabric_white',
      metal: 'mat_metal_black',
      rug: 'mat_carpet_grey',
      curtain: 'mat_fabric_white',
      sheer: SHEER,
    },
    skirtingHeight: 80,
    cornice: 0,
    lightTemperature: 3000,
    tags: ['scandi', 'light'],
  },
  {
    id: 'style_neoclassic',
    name: 'Neoclassic',
    nameRu: 'Неоклассика',
    description: 'Cream walls with cornices and tall skirting, chevron parquet, marble, brass, velvet.',
    descriptionRu: 'Кремовые стены, карнизы и высокий плинтус, паркет «ёлка», мрамор, латунь, бархат.',
    finishes: {
      wallMain: 'mat_ral_9001',
      wallAccent: 'mat_ncs_2010_g30y',
      wallWet: 'mat_marble_white',
      apron: 'mat_marble_white',
      floorDry: 'mat_st_parquet_oak_chevron',
      floorWet: 'mat_marble_beige',
      floorHall: 'mat_tile_checker',
      ceiling: 'mat_ceiling_white',
      skirting: 'mat_ral_9010',
      doorLeaf: 'mat_ral_9010',
      doorFrame: 'mat_ral_9010',
    },
    furnishing: {
      woodFurniture: 'mat_wood_walnut',
      cabinetFront: 'mat_ral_9001',
      kitchenBody: 'mat_wood_white',
      worktop: 'mat_marble_white',
      textileMain: 'mat_fabric_velvet_green',
      textileAccent: 'mat_fabric_linen_beige',
      linen: 'mat_fabric_white',
      metal: 'mat_metal_brass',
      rug: 'mat_carpet_beige',
      curtain: 'mat_fabric_linen_beige',
      sheer: SHEER,
    },
    skirtingHeight: 120,
    cornice: 120,
    lightTemperature: 3000,
    tags: ['classic'],
  },
  {
    id: 'style_quiet_luxury',
    name: 'Quiet luxury',
    nameRu: 'Тихая роскошь',
    description: 'Linen beige and taupe, Venetian plaster, smoked oak herringbone, travertine, cognac leather.',
    descriptionRu: 'Льняной беж и тауп, венецианская штукатурка, копчёный дуб «ёлочкой», травертин, коньячная кожа.',
    finishes: {
      wallMain: 'mat_ncs_1505_y40r',
      wallAccent: 'mat_plaster_venetian_beige',
      wallWet: 'mat_st_travertine',
      apron: 'mat_marble_beige',
      floorDry: 'mat_st_parquet_oak_smoked',
      floorWet: 'mat_st_travertine',
      floorHall: 'mat_marble_beige',
      ceiling: 'mat_ceiling_white',
      skirting: 'mat_ncs_1505_y40r',
      doorLeaf: 'mat_st_wood_oak_smoked',
      doorFrame: 'mat_st_wood_oak_smoked',
    },
    furnishing: {
      woodFurniture: 'mat_st_wood_oak_smoked',
      cabinetFront: 'mat_ncs_2005_y20r',
      kitchenBody: 'mat_st_wood_oak_smoked',
      worktop: 'mat_marble_beige',
      textileMain: 'mat_st_fabric_boucle_taupe',
      textileAccent: 'mat_leather_cognac',
      linen: 'mat_fabric_linen_beige',
      metal: 'mat_metal_brass',
      rug: 'mat_st_carpet_wool_cream',
      curtain: 'mat_fabric_linen_beige',
      sheer: SHEER,
    },
    skirtingHeight: 100,
    cornice: 60,
    lightTemperature: 2700,
    tags: ['luxury', 'warm'],
  },
  {
    id: 'style_japandi',
    name: 'Japandi',
    nameRu: 'Джапанди',
    description: 'Calm light greige, natural oak everywhere, microcement, linen and olive, jute; low and quiet.',
    descriptionRu: 'Спокойный светлый грейдж, натуральный дуб, микроцемент, лён и олива, джут; низко и тихо.',
    finishes: {
      wallMain: 'mat_ncs_1002_y',
      wallAccent: 'mat_ncs_3005_y20r',
      wallWet: 'mat_st_microcement_warm',
      apron: 'mat_st_tile_zellige_white',
      floorDry: 'mat_parquet_oak',
      floorWet: 'mat_st_microcement_warm',
      floorHall: 'mat_st_tile_concrete',
      ceiling: 'mat_ceiling_white',
      skirting: 'mat_ncs_1002_y',
      doorLeaf: 'mat_wood_oak_natural',
      doorFrame: 'mat_wood_oak_natural',
    },
    furnishing: {
      woodFurniture: 'mat_wood_oak_natural',
      cabinetFront: 'mat_wood_oak_natural',
      kitchenBody: 'mat_wood_oak_natural',
      worktop: 'mat_st_microcement_warm',
      textileMain: 'mat_fabric_linen_beige',
      textileAccent: 'mat_st_fabric_linen_olive',
      linen: 'mat_fabric_linen_beige',
      metal: 'mat_metal_black',
      rug: 'mat_st_carpet_jute',
      curtain: 'mat_fabric_linen_beige',
      sheer: SHEER,
    },
    skirtingHeight: 40,
    cornice: 0,
    lightTemperature: 2700,
    tags: ['japandi', 'natural'],
  },
  {
    id: 'style_loft',
    name: 'Loft',
    nameRu: 'Лофт',
    description: 'Concrete-look plaster, a brick accent wall, dark wood, graphite fronts, black metal, leather.',
    descriptionRu: 'Штукатурка под бетон, кирпичная стена-акцент, тёмное дерево, графитовые фасады, чёрный металл, кожа.',
    finishes: {
      wallMain: 'mat_plaster_grey',
      wallAccent: 'mat_brick_red',
      wallWet: 'mat_st_tile_concrete',
      apron: 'mat_tile_metro_white',
      floorDry: 'mat_laminate_dark',
      floorWet: 'mat_st_tile_concrete',
      floorHall: 'mat_st_tile_concrete',
      ceiling: 'mat_concrete_light',
      skirting: 'mat_ral_9005',
      doorLeaf: 'mat_ral_9005',
      doorFrame: 'mat_metal_black',
    },
    furnishing: {
      woodFurniture: 'mat_wood_walnut',
      cabinetFront: 'mat_ral_7016',
      kitchenBody: 'mat_ral_7016',
      worktop: 'mat_wood_walnut',
      textileMain: 'mat_leather_cognac',
      textileAccent: 'mat_fabric_graphite',
      linen: 'mat_fabric_grey',
      metal: 'mat_metal_black',
      rug: 'mat_carpet_grey',
      curtain: 'mat_fabric_blackout_grey',
      sheer: SHEER,
    },
    skirtingHeight: 60,
    cornice: 0,
    lightTemperature: 3000,
    tags: ['loft', 'industrial'],
  },
  {
    id: 'style_eco',
    name: 'Eco / biophilic',
    nameRu: 'Эко',
    description: 'Warm white and sage, oak, terracotta and green zellige tiles, linen and jute; plants welcome.',
    descriptionRu: 'Тёплый белый и шалфей, дуб, терракота и зелёный зеллиж, лён и джут; место для растений.',
    finishes: {
      wallMain: 'mat_ncs_0502_y',
      wallAccent: 'mat_ncs_2010_g30y',
      wallWet: 'mat_tile_beige',
      apron: 'mat_st_tile_zellige_green',
      floorDry: 'mat_parquet_oak',
      floorWet: 'mat_stone_sandstone',
      floorHall: 'mat_tile_terracotta',
      ceiling: 'mat_ceiling_white',
      skirting: 'mat_wood_oak_natural',
      doorLeaf: 'mat_wood_oak_natural',
      doorFrame: 'mat_wood_oak_natural',
    },
    furnishing: {
      woodFurniture: 'mat_wood_oak_natural',
      cabinetFront: 'mat_ncs_2010_g30y',
      kitchenBody: 'mat_wood_oak_natural',
      worktop: 'mat_wood_oak_natural',
      textileMain: 'mat_fabric_linen_beige',
      textileAccent: 'mat_st_fabric_linen_olive',
      linen: 'mat_fabric_linen_beige',
      metal: 'mat_metal_black',
      rug: 'mat_st_carpet_jute',
      curtain: 'mat_fabric_linen_beige',
      sheer: SHEER,
    },
    skirtingHeight: 60,
    cornice: 0,
    lightTemperature: 2700,
    tags: ['eco', 'natural'],
  },
  {
    id: 'style_mid_century',
    name: 'Mid-century modern',
    nameRu: 'Мид-сенчури',
    description: 'Walnut, cream walls with a teal accent, terrazzo, mustard and terracotta textiles, brass.',
    descriptionRu: 'Орех, кремовые стены с бирюзовым акцентом, терраццо, горчичный и терракотовый текстиль, латунь.',
    finishes: {
      wallMain: 'mat_ral_9001',
      wallAccent: 'mat_ncs_5020_b50g',
      wallWet: 'mat_tile_white_matt',
      apron: 'mat_tile_metro_white',
      floorDry: 'mat_parquet_walnut',
      floorWet: 'mat_st_terrazzo',
      floorHall: 'mat_st_terrazzo',
      ceiling: 'mat_ceiling_white',
      skirting: 'mat_wood_walnut',
      doorLeaf: 'mat_wood_walnut',
      doorFrame: 'mat_wood_walnut',
    },
    furnishing: {
      woodFurniture: 'mat_wood_walnut',
      cabinetFront: 'mat_wood_walnut',
      kitchenBody: 'mat_wood_walnut',
      worktop: 'mat_stone_quartz_white',
      textileMain: 'mat_fabric_mustard',
      textileAccent: 'mat_st_fabric_linen_terracotta',
      linen: 'mat_fabric_white',
      metal: 'mat_metal_brass',
      rug: 'mat_carpet_beige',
      curtain: 'mat_fabric_linen_beige',
      sheer: SHEER,
    },
    skirtingHeight: 60,
    cornice: 0,
    lightTemperature: 2700,
    tags: ['retro'],
  },
]

export function findStyle(id: Id | undefined): StylePreset | undefined {
  return id ? BUILTIN_STYLES.find((s) => s.id === id) : undefined
}

// ───────────────────────────── slot mapping ─────────────────────────────

/** asset categories a style never re-skins (appliances keep their steel, plumbing its ceramic…) */
const KEEP_ASSETS = new Set<Asset['category']>(['appliance', 'electronics', 'bathroom', 'structure', 'plant', 'lighting', 'outdoor'])

/**
 * Which furnishing role an item material slot takes. Matched by slot name first (front, body, worktop,
 * linen), then by the category of the slot's default material (fabric, wood, metal…). Undefined = keep.
 */
export function slotRole(asset: Asset, slot: string, defaultMaterial?: Material): FurnishingRole | undefined {
  const cat = asset.category
  if (KEEP_ASSETS.has(cat)) return undefined
  const mc = defaultMaterial?.category
  if (slot === 'linen') return 'linen'
  if (asset.procedural === 'rug' || mc === 'carpet') return 'rug'
  if (cat === 'kitchen') {
    if (slot === 'front') return 'cabinetFront'
    if (slot === 'body') return 'kitchenBody'
    if (slot === 'worktop') return 'worktop'
  }
  if (cat === 'storage' && slot === 'front') return 'cabinetFront'
  if (mc === 'fabric' || mc === 'leather') return cat === 'sofa' || cat === 'armchair' || cat === 'bed' ? 'textileMain' : 'textileAccent'
  if (mc === 'wood' || mc === 'parquet' || mc === 'laminate') return 'woodFurniture'
  if (mc === 'metal') return 'metal'
  return undefined
}

// ───────────────────────────── applyStyle ─────────────────────────────

export interface ApplyStyleParts {
  /** walls, floor, ceiling, skirting, wet zones, kitchen apron */
  finishes: boolean
  /** one accent wall in living rooms / bedrooms */
  accent: boolean
  /** door leaves / frames, curtain fabrics */
  openings: boolean
  /** material slots of furniture inside the rooms */
  furniture: boolean
  /** colour temperature of lights inside the rooms */
  lights: boolean
}

export const ALL_STYLE_PARTS: ApplyStyleParts = { finishes: true, accent: true, openings: true, furniture: true, lights: true }

export interface ApplyStyleOptions {
  /** room ids, or 'all' for every room of the project */
  rooms: Id[] | 'all'
  parts?: Partial<ApplyStyleParts>
  /** catalogue to resolve item assets / material categories (default: built-in) */
  catalog?: Catalog | null
  /** already derived plans per level (the store's); computed when absent */
  derived?: Record<Id, DerivedPlan | undefined>
}

export interface ApplyStyleReport {
  rooms: number
  faces: number
  openings: number
  items: number
  lights: number
}

const WET_ROOMS: RoomType[] = ['bathroom', 'toilet']
const KITCHEN_ROOMS: RoomType[] = ['kitchen', 'kitchenLiving']
const HALL_ROOMS: RoomType[] = ['hallway', 'corridor', 'balcony', 'loggia']
const ACCENT_ROOMS: RoomType[] = ['living', 'bedroom', 'kids', 'office', 'kitchenLiving']
const DOOR_KINDS = new Set(['door', 'doubleDoor', 'slidingDoor'])
const WINDOW_KINDS = new Set(['window', 'frenchWindow', 'balconyDoor', 'balconyBlock'])
/** how far behind a cabinet's back its wall face may be, mm */
const APRON_REACH = 150
const MIN_ACCENT_LENGTH = 1500

interface Face {
  wallId: Id
  side: 'left' | 'right'
  length: number
}

const faceKey = (wallId: Id, side: 'left' | 'right'): string => `${wallId}:${side}`

function roomFaces(doc: Doc, dr: DerivedRoom): Face[] {
  const map = new Map<string, Face>()
  for (const e of dr.edges) {
    const w = doc.walls[e.wallId]
    if (!w || w.kind === 'virtual' || w.kind === 'glazing') continue
    const k = faceKey(e.wallId, e.side)
    const len = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y)
    const f = map.get(k)
    if (f) f.length += len
    else map.set(k, { wallId: e.wallId, side: e.side, length: len })
  }
  return [...map.values()]
}

/** the wall face nearest behind a cabinet, if it is within reach */
function faceBehind(doc: Doc, dr: DerivedRoom, c: Vec2, depth: number): string | undefined {
  let best: string | undefined
  let bestDist = depth / 2 + APRON_REACH
  for (const e of dr.edges) {
    const w = doc.walls[e.wallId]
    if (!w || w.kind === 'virtual' || w.kind === 'glazing') continue
    const p = projectOnSegment(c, e.from, e.to)
    if (p.t <= 0 || p.t >= 1) continue
    if (p.dist <= bestDist) {
      bestDist = p.dist
      best = faceKey(e.wallId, e.side)
    }
  }
  return best
}

/** apron band per kitchen wall face: from the top of base units to the bottom of wall units */
function apronBands(doc: Doc, catalog: Catalog, dr: DerivedRoom): Map<string, { from: number; to: number }> {
  const top = new Map<string, number>()
  const bottom = new Map<string, number>()
  for (const it of Object.values(doc.items)) {
    if (it.levelId !== dr.levelId || it.hidden) continue
    const c = { x: it.x, y: it.y }
    if (!pointInPolygon(c, dr.polygon, dr.holes)) continue
    const a = findAsset(doc, catalog, it.assetId)
    if (!a || a.category !== 'kitchen') continue
    const isWall = a.procedural === 'kitchenWall' || it.mount === 'wall'
    const isBase = !isWall && (a.procedural === 'kitchenBase' || it.size.h <= 1000) && !(it.params?.island ?? a.defaultParams?.island)
    if (!isWall && !isBase) continue
    const k = faceBehind(doc, dr, c, it.size.d)
    if (!k) continue
    if (isBase) top.set(k, Math.max(top.get(k) ?? 0, it.elevation + it.size.h))
    else bottom.set(k, Math.min(bottom.get(k) ?? Infinity, it.elevation))
  }
  const out = new Map<string, { from: number; to: number }>()
  for (const [k, from] of top) {
    const to = bottom.get(k) ?? from + 600
    if (to - from >= 100) out.set(k, { from: Math.round(from), to: Math.round(to) })
  }
  return out
}

/** same value (plain data): used to skip assignments that would only record an empty undo step */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** two walls lie on one straight line (within 1 mm) */
function sameLine(doc: Doc, a: Id, b: Id): boolean {
  if (a === b) return true
  const wa = doc.walls[a]
  const wb = doc.walls[b]
  const p = doc.nodes[wa?.a]
  const q = doc.nodes[wa?.b]
  if (!p || !q || !wb) return false
  const len = Math.hypot(q.x - p.x, q.y - p.y)
  if (len <= 0) return false
  const off = (id: Id) => {
    const n = doc.nodes[id]
    return n ? Math.abs((q.x - p.x) * (n.y - p.y) - (q.y - p.y) * (n.x - p.x)) / len : Infinity
  }
  return off(wb.a) <= 1 && off(wb.b) <= 1
}

/** after walls were copied under new ids: point a room's remembered accent face at the copy (or '' when it was not copied) */
export function remapAccentFace(room: Room, wallMap: ReadonlyMap<Id, Id>): void {
  const key = room.design?.accentFace
  if (!key || !room.design) return
  const i = key.lastIndexOf(':')
  const wallId = wallMap.get(key.slice(0, i))
  // a room copied without that wall has no accent wall from the style any more
  room.design.accentFace = wallId ? `${wallId}${key.slice(i)}` : ''
}

function setOverride(overrides: Record<string, Id>, slot: string, materialId: Id, defaultId: Id): void {
  if (materialId === defaultId) delete overrides[slot]
  else overrides[slot] = materialId
}

/**
 * Dress rooms in a style. Mutates `doc` (call inside one `tx` so it is a single undo step).
 * Rooms are matched to their derived outline; rooms without one (not closed) are skipped.
 * Re-applying the same style is a no-op.
 */
export function applyStyle(doc: Doc, style: StylePreset, opts: ApplyStyleOptions): ApplyStyleReport {
  const parts: ApplyStyleParts = { ...ALL_STYLE_PARTS, ...opts.parts }
  const catalog = opts.catalog ?? builtinCatalog()
  const report: ApplyStyleReport = { rooms: 0, faces: 0, openings: 0, items: 0, lights: 0 }
  const plans = new Map<Id, DerivedPlan>()
  const planFor = (levelId: Id): DerivedPlan => {
    let p = opts.derived?.[levelId] ?? plans.get(levelId)
    if (!p) {
      p = derivePlan(doc, levelId)
      plans.set(levelId, p)
    }
    return p
  }
  const roomIds = opts.rooms === 'all' ? Object.keys(doc.rooms) : opts.rooms.filter((id) => doc.rooms[id])
  const F = style.finishes
  const T = style.furnishing
  const touchedOpenings = new Set<Id>()

  for (const roomId of roomIds) {
    const room = doc.rooms[roomId]
    if (!room || !doc.levels[room.levelId]) continue
    const dr = planFor(room.levelId).rooms.find((r) => r.roomId === roomId)
    if (!dr) continue
    report.rooms++
    const wet = WET_ROOMS.includes(room.type)
    const faces = roomFaces(doc, dr)
    const sideOf = new Map<Id, 'left' | 'right'>()
    for (const f of faces) sideOf.set(f.wallId, f.side)

    if (parts.finishes) {
      const floorId = wet ? F.floorWet : HALL_ROOMS.includes(room.type) ? (F.floorHall ?? F.floorDry) : F.floorDry
      const fm = findMaterial(doc, catalog, floorId)
      room.floor.materialId = floorId
      if (fm?.pattern) {
        if (!same(room.floor.pattern, fm.pattern)) room.floor.pattern = { ...fm.pattern }
      } else delete room.floor.pattern
      delete room.floor.tint
      room.ceiling.materialId = F.ceiling
      delete room.ceiling.tint
      room.ceiling.cornice = wet ? 0 : style.cornice
      if (wet) {
        room.skirting = 0
        delete room.skirtingMaterialId
      } else {
        room.skirting = style.skirtingHeight
        room.skirtingMaterialId = F.skirting
      }

    }

    if (parts.finishes || parts.accent) {
      const aprons = KITCHEN_ROOMS.includes(room.type) ? apronBands(doc, catalog, dr) : new Map<string, { from: number; to: number }>()
      let accent: Face | undefined
      if (parts.accent && F.wallAccent && ACCENT_ROOMS.includes(room.type)) {
        const withOpenings = new Set(Object.values(doc.openings).map((o) => o.wallId))
        for (const f of faces) {
          if (withOpenings.has(f.wallId) || aprons.has(faceKey(f.wallId, f.side)) || f.length < MIN_ACCENT_LENGTH) continue
          if (!accent || f.length > accent.length + 1 || (Math.abs(f.length - accent.length) <= 1 && f.wallId < accent.wallId)) accent = f
        }
      }
      const accentKey = accent ? faceKey(accent.wallId, accent.side) : undefined
      const prevAccent = room.design?.accentFace
      // the face the style made the accent last time, if it still is a face of this room (a copied
      // room or level, or a deleted wall, leave a stale key)
      const prevFace = faces.find((f) => faceKey(f.wallId, f.side) === prevAccent)
      const accentMat = (f: Face) => doc.walls[f.wallId][f.side].materialId === F.wallAccent
      /**
       * Faces this style made the accent before: the remembered face and its pieces after a wall
       * split (accent-material faces on its side, on its line, joined to it node by node; a separate
       * wall on the same line behind a niche does not count). A room this style was applied to by
       * 0.8.0, which kept no face, falls back to every accent-material face. A stale key (the wall
       * was deleted) or '' (applied without an accent) resets nothing: those faces are the user's.
       */
      const oldAccents = new Set<string>()
      if (prevFace && accentMat(prevFace)) {
        const nodes = new Set([doc.walls[prevFace.wallId].a, doc.walls[prevFace.wallId].b])
        oldAccents.add(faceKey(prevFace.wallId, prevFace.side))
        for (let grew = true; grew; ) {
          grew = false
          for (const f of faces) {
            const k = faceKey(f.wallId, f.side)
            const w = doc.walls[f.wallId]
            if (oldAccents.has(k) || f.side !== prevFace.side || !accentMat(f) || !(nodes.has(w.a) || nodes.has(w.b))) continue
            if (!sameLine(doc, f.wallId, prevFace.wallId)) continue
            oldAccents.add(k)
            nodes.add(w.a)
            nodes.add(w.b)
            grew = true
          }
        }
      } else if (prevAccent === undefined && room.design?.styleId === style.id && ACCENT_ROOMS.includes(room.type)) {
        for (const f of faces) if (accentMat(f)) oldAccents.add(faceKey(f.wallId, f.side))
      }
      const wasAccent = (f: Face): boolean => oldAccents.has(faceKey(f.wallId, f.side))
      /** the finish the room's other walls have (most common), for the face that stops being the accent */
      const roomFinish = (): Id => {
        const n = new Map<Id, number>()
        for (const f of faces) {
          const id = doc.walls[f.wallId][f.side].materialId
          if (faceKey(f.wallId, f.side) === accentKey || id === F.wallAccent) continue
          if (id) n.set(id, (n.get(id) ?? 0) + 1)
        }
        let best: Id = F.wallMain
        let most = 0
        for (const [id, c] of n) if (c > most) [best, most] = [id, c]
        return best
      }
      for (const f of faces) {
        const side = doc.walls[f.wallId][f.side]
        const k = faceKey(f.wallId, f.side)
        const isAccent = k === accentKey
        // with finishes off only the accent face is dressed, and the face this style made the accent
        // before (the accent moved, e.g. a window was cut into it) gets the room's wall finish back;
        // accent walls the user placed are left alone
        const oldAccent = !parts.finishes && parts.accent && !isAccent && wasAccent(f)
        if (!parts.finishes && !isAccent && !oldAccent) continue
        const materialId = wet ? F.wallWet : isAccent ? F.wallAccent! : oldAccent ? roomFinish() : F.wallMain
        if (side.materialId !== materialId) {
          side.materialId = materialId
          // an old layout must not be laid with the new material: the material's own pattern applies
          delete side.pattern
        }
        if (parts.finishes) {
          if (wet) delete side.zones
          const band = aprons.get(k)
          if (band) {
            const keep = (side.zones ?? []).filter((z) => z.to <= band.from || z.from >= band.to)
            const zones: FinishZone[] = [...keep, { from: band.from, to: band.to, materialId: F.apron }].sort((a, b) => a.from - b.from)
            if (!same(side.zones, zones)) side.zones = zones
          }
        }
        report.faces++
      }
      // with finishes on and the accent off the old accent face was given the main finish above;
      // '' records that this room has no accent wall from the style
      const nextAccent = parts.accent ? (accentKey ?? '') : ''
      if (room.design?.accentFace !== nextAccent) room.design = { ...room.design, accentFace: nextAccent }
    }

    if (parts.openings) {
      for (const o of Object.values(doc.openings)) {
        const side = sideOf.get(o.wallId)
        if (!side) continue
        if (DOOR_KINDS.has(o.kind)) {
          o.leafMaterialId = F.doorLeaf
          o.frameMaterialId = F.doorFrame
          touchedOpenings.add(o.id)
        } else if (WINDOW_KINDS.has(o.kind) && o.curtain && o.curtain.kind !== 'none' && o.curtain.side === side) {
          o.curtain.materialId = T.curtain
          if (o.curtain.kind === 'sheer' || o.curtain.kind === 'drapesAndSheer') o.curtain.sheerMaterialId = T.sheer
          touchedOpenings.add(o.id)
        }
      }
    }

    if (parts.furniture) {
      for (const it of Object.values(doc.items)) {
        if (it.levelId !== room.levelId || it.locked) continue
        if (!pointInPolygon({ x: it.x, y: it.y }, dr.polygon, dr.holes)) continue
        const a = findAsset(doc, catalog, it.assetId)
        if (!a?.slots) continue
        const overrides: Record<string, Id> = { ...(it.overrides ?? {}) }
        let changed = false
        for (const [slot, defId] of Object.entries(a.slots)) {
          const role = slotRole(a, slot, findMaterial(doc, catalog, defId))
          if (!role) continue
          setOverride(overrides, slot, T[role], defId)
          changed = true
        }
        if (!changed) continue
        if (Object.keys(overrides).length) {
          if (!same(it.overrides, overrides)) it.overrides = overrides
        } else delete it.overrides
        report.items++
      }
    }

    if (parts.lights) {
      for (const l of Object.values(doc.lights)) {
        if (l.levelId !== room.levelId) continue
        if (!pointInPolygon({ x: l.x, y: l.y }, dr.polygon, dr.holes)) continue
        l.temperature = style.lightTemperature
        report.lights++
      }
    }

    if (room.design?.styleId !== style.id) room.design = { ...room.design, styleId: style.id }
  }

  report.openings = touchedOpenings.size
  if (opts.rooms === 'all' && doc.design?.styleId !== style.id) doc.design = { ...doc.design, styleId: style.id }
  return report
}
