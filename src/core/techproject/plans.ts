/**
 * Plan sheets: обмерный план, расстановка мебели, полы, потолки, освещение и выключатели, розетки,
 * сантехника, тёплый пол. Each builds a world drawing for 1:S over the base plan plus its legend.
 */
import { wasteFor } from '../bom'
import { ceilingBaseHeight } from '../ceiling'
import type { DisplayItem, DlPen } from '../display'
import { electricName, electricType } from '../electrical'
import { insetPolygon } from '../inset'
import type { DerivedPlan, DerivedRoom, Doc, ElectricPoint, Id, Item, Light, Room, TilePattern, Vec2 } from '../types'
import { isApartmentItem } from '../variants'
import { arrow, dimChain, fmtLevel, fmtM2, fmtNum, label, marker, pointInPoly, polyBounds, tileJoints, type LayoutKind } from './annot'
import { basePlan, itemTitle, lookupAsset, lookupMaterial, materialTitle, planPages, roomTitle, sum, tint } from './common'
import { contribute } from './contrib'
import type { SheetBlock } from './layout'
import type { AlbumCtx, PageDraft } from './model'
import type { Table, TableRow } from './table'

const V = (x: number, y: number): Vec2 => ({ x, y })

const isOutdoor = (r: Room | undefined) => r?.type === 'balcony' || r?.type === 'loggia'

/** rooms that count as floor (technical voids left out) */
export function realRooms(doc: Doc, plan: DerivedPlan): DerivedRoom[] {
  return plan.rooms.filter((r) => !doc.rooms[r.roomId]?.technical)
}

/** height of a room before renovation: the walls around it (median) or the level height */
function structuralHeight(doc: Doc, levelId: Id, r: DerivedRoom): number {
  const hs = r.edges.map((e) => doc.walls[e.wallId]?.height).filter((h): h is number => typeof h === 'number' && h > 0).sort((a, b) => a - b)
  return hs.length ? hs[Math.floor(hs.length / 2)] : (doc.levels[levelId]?.height ?? doc.settings.wallHeight)
}

/** finished ceiling height of a room */
export function ceilingHeightOf(doc: Doc, levelId: Id, r: DerivedRoom): number {
  const rec = doc.rooms[r.roomId]
  if (rec?.ceiling?.height) return rec.ceiling.height
  return ceilingBaseHeight(doc, r, rec?.ceiling, levelId) || structuralHeight(doc, levelId, r)
}

/** extra lines under a room's name (world mm for 1:S) */
function roomNote(r: DerivedRoom, lines: string[], S: number, from = 1): DisplayItem[] {
  const out: DisplayItem[] = []
  lines.forEach((s, i) => out.push(label(V(r.labelPoint.x, r.labelPoint.y + (from + i) * 3.4 * S), s, 2.3, S, { color: '#444444' })))
  return out
}

export function explicationTable(ctx: AlbumCtx, levelId: Id, doc: Doc = ctx.doc, plan: DerivedPlan = ctx.plans[levelId]): Table {
  const rooms = realRooms(doc, plan)
  let living = 0
  let total = 0
  const rows: TableRow[] = rooms.map((r, i) => {
    const rec = doc.rooms[r.roomId]
    const k = rec?.type === 'balcony' ? 0.3 : rec?.type === 'loggia' ? 0.5 : 1
    total += r.area * k
    if (rec && ['living', 'bedroom', 'kids', 'office'].includes(rec.type)) living += r.area
    return [String(i + 1), roomTitle(doc, r), fmtNum(r.area), k < 1 ? `k = ${fmtNum(k, 1)}` : '']
  })
  return {
    title: 'Экспликация помещений',
    columns: [
      { title: '№', width: 10, align: 'middle' },
      { title: 'Наименование', width: 70 },
      { title: 'Площадь, м²', width: 25, align: 'end' },
      { title: 'Прим.', width: 20 },
    ],
    rows,
    footer: [
      ['', 'Жилая площадь', fmtNum(living), ''],
      ['', 'Общая площадь', fmtNum(total), ''],
    ],
  }
}

function roomNumbers(doc: Doc, plan: DerivedPlan, S: number): DisplayItem[] {
  return realRooms(doc, plan).map((r, i) => marker(V(r.labelPoint.x, r.labelPoint.y - 4.2 * S), String(i + 1), S)).flat()
}

// ───────────────────────────── обмерный план ─────────────────────────────

export function measureSheet(ctx: AlbumCtx, levelId: Id, doc: Doc, plan: DerivedPlan, baseline: boolean): PageDraft[] {
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { dimensions: true, areas: true, northArrow: true }, doc)
    items.push(...roomNumbers(doc, plan, S))
    for (const r of realRooms(doc, plan)) items.push(...roomNote(r, [`h = ${fmtNum(structuralHeight(doc, levelId, r) / 1000)} м`], S, 2))
    return items
  }
  const notes = baseline
    ? ['Обмерный план — состояние до ремонта, зафиксированное в проекте.', 'h — высота от черновой стяжки до плиты перекрытия.']
    : ['Обмер не зафиксирован: показан текущий план. Зафиксируйте обмерный план до перепланировки, чтобы получить планы демонтажа и монтажа.', 'h — высота стен по проекту.']
  const blocks: SheetBlock[] = [
    { kind: 'table', table: explicationTable(ctx, levelId, doc, plan) },
    { kind: 'notes', title: 'Примечания', lines: notes, width: 125 },
  ]
  return planPages(ctx, 'measure', levelId, build, blocks)
}

// ───────────────────────────── мебель ─────────────────────────────

interface Position {
  no: number
  title: string
  size: string
  items: Item[]
  rooms: Set<string>
}

function roomOfPoint(doc: Doc, plan: DerivedPlan, p: Vec2): string {
  const r = plan.rooms.find((x) => pointInPoly(p, x.polygon) && !x.holes.some((h) => pointInPoly(p, h)))
  return r ? roomTitle(doc, r) : '—'
}

function furniturePositions(ctx: AlbumCtx, levelId: Id, filter: (it: Item) => boolean): Position[] {
  const { doc, catalog } = ctx
  const plan = ctx.plans[levelId]
  const map = new Map<string, Position>()
  const list = Object.values(doc.items)
    .filter((it) => it.levelId === levelId && !it.hidden && filter(it))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  for (const it of list) {
    const title = itemTitle(doc, catalog, it)
    const size = `${Math.round(it.size.w)}×${Math.round(it.size.d)}×${Math.round(it.size.h)}`
    const key = `${title}|${size}`
    let p = map.get(key)
    if (!p) {
      p = { no: map.size + 1, title, size, items: [], rooms: new Set() }
      map.set(key, p)
    }
    p.items.push(it)
    p.rooms.add(roomOfPoint(doc, plan, it))
  }
  return [...map.values()]
}

export function furnitureSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const { doc, catalog } = ctx
  const positions = furniturePositions(ctx, levelId, (it) => !isApartmentItem(doc, it, catalog))
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { furniture: true, outerDimensions: true, innerDimensions: false })
    for (const p of positions) for (const it of p.items) items.push(...marker(V(it.x, it.y), String(p.no), S, { color: '#1d4e89' }))
    return items
  }
  const table: Table = {
    title: 'Спецификация мебели и оборудования',
    columns: [
      { title: 'Поз.', width: 10, align: 'middle' },
      { title: 'Наименование', width: 70 },
      { title: 'Размер Ш×Г×В', width: 32, align: 'middle' },
      { title: 'Кол.', width: 12, align: 'middle' },
      { title: 'Помещение', width: 41 },
    ],
    rows: positions.map((p) => [String(p.no), p.title, p.size, String(p.items.length), [...p.rooms].join(', ')]),
    size: 2.3,
  }
  return planPages(ctx, 'furniture', levelId, build, positions.length ? [{ kind: 'table', table }] : [], {
    empty: positions.length ? undefined : 'На уровне нет мебели',
  })
}

// ───────────────────────────── полы ─────────────────────────────

const PATTERN_RU: Record<string, string> = {
  none: 'без раскладки',
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

interface FloorSpec {
  key: string
  code: string
  materialId: Id
  title: string
  color: string
  pattern?: TilePattern
  tile?: { w: number; h: number; type: string }
  category?: string
  area: number
  rooms: Set<string>
}

function floorPatternOf(ctx: AlbumCtx, rec: Room | undefined): { pattern?: TilePattern; tile?: { w: number; h: number; type: string }; category?: string } {
  if (!rec?.floor?.materialId) return {}
  const m = lookupMaterial(ctx.doc, ctx.catalog, rec.floor.materialId)
  const p = rec.floor.pattern && rec.floor.pattern.type !== 'none' ? rec.floor.pattern : m?.pattern && m.pattern.type !== 'none' ? m.pattern : undefined
  if (p && p.tileW > 0 && p.tileH > 0) return { pattern: p, tile: { w: p.tileW, h: p.tileH, type: p.type }, category: m?.category }
  const tileCat = m && (m.category === 'tile' || m.category === 'stone' || m.category === 'marble')
  if (tileCat && m?.sizeMm && m.sizeMm[0] > 0) return { tile: { w: m.sizeMm[0], h: m.sizeMm[1], type: 'grid' }, category: m.category }
  return { category: m?.category }
}

function floorSpecs(ctx: AlbumCtx, levelId: Id): { specs: FloorSpec[]; byRoom: Map<Id, FloorSpec> } {
  const { doc, catalog } = ctx
  const plan = ctx.plans[levelId]
  const specs = new Map<string, FloorSpec>()
  const byRoom = new Map<Id, FloorSpec>()
  for (const r of realRooms(doc, plan)) {
    const rec = doc.rooms[r.roomId]
    if (!rec?.floor?.materialId) continue
    const m = lookupMaterial(doc, catalog, rec.floor.materialId)
    const pt = floorPatternOf(ctx, rec)
    const key = `${rec.floor.materialId}|${pt.tile ? `${pt.tile.type}|${pt.tile.w}x${pt.tile.h}|${pt.pattern?.rotation ?? 0}` : ''}`
    let s = specs.get(key)
    if (!s) {
      s = { key, code: `П${specs.size + 1}`, materialId: rec.floor.materialId, title: materialTitle(m, rec.floor.materialId), color: rec.floor.tint ?? m?.color ?? '#dddddd', ...pt, area: 0, rooms: new Set() }
      specs.set(key, s)
    }
    s.area += r.area
    s.rooms.add(roomTitle(doc, r))
    byRoom.set(r.roomId, s)
  }
  return { specs: [...specs.values()], byRoom }
}

const LAYOUTS: ReadonlySet<string> = new Set(['grid', 'brick', 'brickThird', 'planks', 'diagonal'])

export function floorsSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const { doc } = ctx
  const plan = ctx.plans[levelId]
  const { specs, byRoom } = floorSpecs(ctx, levelId)
  const joint: DlPen = { color: '#7a7a7a', width: 0.1 }
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { labels: true, outerDimensions: false, innerDimensions: true })
    const over: DisplayItem[] = []
    for (const r of realRooms(doc, plan)) {
      const s = byRoom.get(r.roomId)
      if (!s) continue
      const rings = [r.polygon, ...r.holes]
      over.push({ t: 'poly', layer: 'rooms', role: 'tp-floor', pts: r.polygon, holes: r.holes.length ? r.holes : undefined, closed: true, fill: { color: tint(s.color, 0.7) } })
      const b = polyBounds(r.polygon)
      const origin = V(b.minX + (s.pattern?.offsetX ?? 0), b.minY + (s.pattern?.offsetY ?? 0))
      const rot = s.pattern?.rotation ?? 0
      if (s.tile && LAYOUTS.has(s.tile.type)) {
        // planks run along their long side: tileH is the plank length in TilePattern
        const plank = s.tile.type === 'planks'
        const tw = plank ? Math.max(s.tile.w, s.tile.h) : s.tile.w
        const th = plank ? Math.min(s.tile.w, s.tile.h) : s.tile.h
        const kind: LayoutKind = s.tile.type as LayoutKind
        // a joint every 2 mm on paper is the densest that still reads
        if (Math.min(tw, th) / S >= 1.2) over.push(...tileJoints(rings, origin, tw, th, rot, kind, joint, 'rooms'))
        if (!plank) over.push({ t: 'circle', layer: 'rooms', role: 'tp-origin', c: origin, r: 1 * S, fill: { color: '#c0392b' } })
      } else if (s.tile) {
        // patterns without a straight joint grid: the module grid, faint
        if (Math.min(s.tile.w, s.tile.h) / S >= 1.2) over.push(...tileJoints(rings, origin, s.tile.w, s.tile.h, rot, 'grid', { ...joint, dash: [0.6, 0.6] }, 'rooms'))
      }
      if (s.tile?.type === 'planks' || s.category === 'laminate' || s.category === 'parquet' || s.category === 'wood') {
        const a = (rot * Math.PI) / 180
        const d = V(Math.cos(a), Math.sin(a))
        const c = V(r.labelPoint.x, r.labelPoint.y + 9 * S)
        const L = Math.min(18 * S, (b.maxX - b.minX) * 0.35)
        over.push(...arrow(V(c.x - (d.x * L) / 2, c.y - (d.y * L) / 2), V(c.x + (d.x * L) / 2, c.y + (d.y * L) / 2), S, { color: '#8a5a1e', width: 0.35 }, 'annotations'))
      }
      over.push(...marker(V(r.labelPoint.x, r.labelPoint.y + 4.5 * S), s.code, S, { color: '#5b3d12' }))
    }
    // fills under the walls, joints over the fills
    const firstWall = items.findIndex((it) => it.layer === 'walls')
    const at = firstWall < 0 ? items.length : firstWall
    items.splice(at, 0, ...over.filter((x) => x.role === 'tp-floor'), ...over.filter((x) => x.role === 'tp-tile' || x.role === 'tp-origin'))
    items.push(...over.filter((x) => x.role !== 'tp-floor' && x.role !== 'tp-tile' && x.role !== 'tp-origin'))
    return items
  }
  const rows: TableRow[] = specs.map((s) => {
    const waste = s.tile ? wasteFor(s.tile.type, s.pattern) : s.category === 'laminate' || s.category === 'parquet' ? 0.07 : 0.05
    const layout = s.tile ? `${PATTERN_RU[s.tile.type] ?? s.tile.type}, ${Math.round(s.tile.w)}×${Math.round(s.tile.h)}${s.pattern?.rotation ? `, ${Math.round(s.pattern.rotation)}°` : ''}` : '—'
    return [
      { text: s.code, swatch: { kind: 'fill', fill: { color: tint(s.color, 0.7) } } },
      s.title,
      layout,
      fmtNum(s.area),
      `${fmtNum(s.area * (1 + waste))} (+${Math.round(waste * 100)} %)`,
      [...s.rooms].join(', '),
    ]
  })
  const table: Table = {
    title: 'Экспликация полов',
    columns: [
      { title: 'Обозн.', width: 19 },
      { title: 'Покрытие', width: 46 },
      { title: 'Раскладка', width: 34 },
      { title: 'Площадь, м²', width: 18, align: 'end' },
      { title: 'С запасом, м²', width: 26, align: 'end' },
      { title: 'Помещения', width: 37 },
    ],
    rows,
    footer: [['', 'Итого', '', fmtNum(sum(specs, (s) => s.area)), '', '']],
    size: 2.3,
  }
  const notes = ['● — начало раскладки плитки. Стрелка — направление укладки ламината (доски).', 'Площади даны по чистовым стенам без учёта порогов.']
  return planPages(ctx, 'floors', levelId, build, specs.length ? [{ kind: 'table', table }, { kind: 'notes', lines: notes, width: 180 }] : [], {
    empty: specs.length ? undefined : 'Покрытия полов не заданы',
  })
}

// ───────────────────────────── потолки ─────────────────────────────

const CEILING_RU: Record<string, string> = {
  flat: 'Окраска по выровненному основанию',
  stretch: 'Натяжной',
  multilevel: 'Многоуровневый (ГКЛ)',
  coffered: 'Кессонный',
  beams: 'С балками',
}

export function ceilingsSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const { doc, catalog } = ctx
  const plan = ctx.plans[levelId]
  interface CSpec {
    code: string
    title: string
    material: string
    level: number
    area: number
    perimeter: number
    rooms: Set<string>
    cornice: number
  }
  const specs = new Map<string, CSpec>()
  const byRoom = new Map<Id, CSpec>()
  for (const r of realRooms(doc, plan)) {
    const rec = doc.rooms[r.roomId]
    const kind = rec?.ceiling?.kind ?? 'flat'
    const h = ceilingHeightOf(doc, levelId, r)
    const m = lookupMaterial(doc, catalog, rec?.ceiling?.materialId)
    const key = `${kind}|${rec?.ceiling?.materialId ?? ''}|${Math.round(h)}|${rec?.ceiling?.cornice ?? 0}`
    let s = specs.get(key)
    if (!s) {
      s = { code: `Пт${specs.size + 1}`, title: CEILING_RU[kind] ?? kind, material: m ? materialTitle(m, m.id) : '—', level: h, area: 0, perimeter: 0, rooms: new Set(), cornice: rec?.ceiling?.cornice ?? 0 }
      specs.set(key, s)
    }
    s.area += r.area
    s.perimeter += r.perimeter
    s.rooms.add(roomTitle(doc, r))
    byRoom.set(r.roomId, s)
  }
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { lights: true, labels: true })
    for (const r of realRooms(doc, plan)) {
      const rec = doc.rooms[r.roomId]
      const s = byRoom.get(r.roomId)
      if (!s) continue
      const c = rec?.ceiling
      if (c?.kind === 'multilevel' && (c.borderWidth ?? 0) > 0) {
        const inner = insetPolygon(r.polygon, c.borderWidth ?? 0)
        if (inner && inner.length >= 3) {
          items.push({ t: 'poly', layer: 'annotations', role: 'tp-ceiling-level', pts: inner, closed: true, stroke: { color: '#1d4e89', width: 0.3, dash: [2, 1] } })
          if (c.coveLight) {
            const cove = insetPolygon(r.polygon, Math.max(20, (c.borderWidth ?? 0) - 60))
            if (cove) items.push({ t: 'poly', layer: 'annotations', role: 'tp-cove', pts: cove, closed: true, stroke: { color: '#b7791f', width: 0.25, dash: [1.5, 0.8] } })
          }
        }
      }
      if ((c?.cornice ?? 0) > 0) {
        const k = insetPolygon(r.polygon, Math.min(80, Math.max(30, c?.cornice ?? 50)))
        if (k) items.push({ t: 'poly', layer: 'annotations', role: 'tp-cornice', pts: k, closed: true, stroke: { color: '#555555', width: 0.15 } })
      }
      items.push(...marker(V(r.labelPoint.x - 6 * S, r.labelPoint.y + 4.2 * S), s.code, S, { color: '#1d4e89' }))
      items.push(label(V(r.labelPoint.x + 1.5 * S, r.labelPoint.y + 4.2 * S), fmtLevel(s.level), 2.4, S, { anchor: 'start', color: '#1d4e89' }))
    }
    return items
  }
  const rows: TableRow[] = [...specs.values()].map((s) => [s.code, s.title, s.material, fmtLevel(s.level), fmtNum(s.area), fmtNum(s.perimeter), [...s.rooms].join(', ')])
  const table: Table = {
    title: 'Экспликация потолков',
    columns: [
      { title: 'Обозн.', width: 12 },
      { title: 'Тип', width: 38 },
      { title: 'Материал', width: 34 },
      { title: 'Отметка, м', width: 18, align: 'middle' },
      { title: 'Площадь, м²', width: 18, align: 'end' },
      { title: 'Периметр, м', width: 18, align: 'end' },
      { title: 'Помещения', width: 42 },
    ],
    rows,
    footer: [['', 'Итого', '', '', fmtNum(sum([...specs.values()], (s) => s.area)), fmtNum(sum([...specs.values()], (s) => s.perimeter)), '']],
    size: 2.3,
  }
  const notes = ['Отметки потолков даны от уровня чистого пола.', 'Пунктир — граница уровня (короба); штрихпунктир жёлтым — скрытая подсветка; тонкая линия у стен — карниз (галтель).']
  return planPages(ctx, 'ceilings', levelId, build, [{ kind: 'table', table }, { kind: 'notes', lines: notes, width: 180 }])
}

// ───────────────────────────── освещение и выключатели ─────────────────────────────

export const LIGHT_RU: Record<string, string> = {
  ceiling: 'Светильник потолочный',
  spot: 'Светильник точечный встраиваемый',
  pendant: 'Светильник подвесной',
  point: 'Источник света',
  strip: 'Светодиодная лента',
  area: 'Светильник панельный',
}

const isSwitch = (p: ElectricPoint) => electricType(p.kind).group === 'switches'

function roomOf(plan: DerivedPlan, p: Vec2): DerivedRoom | undefined {
  return plan.rooms.find((r) => pointInPoly(p, r.polygon) && !r.holes.some((h) => pointInPoly(p, h)))
}

/** groups of a room's lights in walking order from its switch (nearest neighbour chain) */
function chain(from: Vec2, pts: Vec2[]): Vec2[] {
  const left = [...pts]
  const out: Vec2[] = []
  let cur = from
  while (left.length) {
    let bi = 0
    let bd = Infinity
    left.forEach((p, i) => {
      const d = Math.hypot(p.x - cur.x, p.y - cur.y)
      if (d < bd) {
        bd = d
        bi = i
      }
    })
    cur = left.splice(bi, 1)[0]
    out.push(cur)
  }
  return out
}

function uniqueSorted(vs: number[], tol = 15): number[] {
  const s = [...vs].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v)
  return out
}

export function lightingSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const { doc } = ctx
  const plan = ctx.plans[levelId]
  const lights = Object.values(doc.lights).filter((l) => l.levelId === levelId)
  const switches = Object.values(doc.electrical ?? {}).filter((p) => p.levelId === levelId && isSwitch(p))
  const swDoc: Doc = { ...doc, electrical: Object.fromEntries(switches.map((p) => [p.id, p])) }
  const groups: { letter: string; sw?: ElectricPoint; lights: Light[]; room: string }[] = []
  {
    let n = 0
    for (const r of realRooms(doc, plan)) {
      const inRoom = lights.filter((l) => roomOf(plan, l) === r)
      if (!inRoom.length) continue
      const sws = switches.filter((s) => roomOf(plan, s) === r || (s.wallId && r.edges.some((e) => e.wallId === s.wallId) && Math.hypot(s.x - r.labelPoint.x, s.y - r.labelPoint.y) < 6000))
      const letter = String.fromCharCode(65 + (n % 26)) + (n >= 26 ? String(Math.floor(n / 26)) : '')
      n++
      groups.push({ letter, sw: sws[0], lights: inRoom, room: roomTitle(doc, r) })
    }
  }
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { lights: true, electrical: true, electricalHeights: true, electricalDims: true, labels: true }, swDoc)
    const groupPen: DlPen = { color: '#1d4e89', width: 0.18, dash: [2, 1] }
    for (const g of groups) {
      const pts = chain(g.sw ?? g.lights[0], g.lights.map((l) => V(l.x, l.y)))
      const path = g.sw ? [V(g.sw.x, g.sw.y), ...pts] : pts
      for (let i = 0; i + 1 < path.length; i++) items.push({ t: 'line', layer: 'annotations', role: 'tp-group', a: path[i], b: path[i + 1], stroke: groupPen })
      if (g.sw) items.push(label(V(g.sw.x + 3.2 * S, g.sw.y - 3.2 * S), g.letter, 2.6, S, { color: '#1d4e89', bold: true }))
      else items.push(label(V(pts[0].x + 3 * S, pts[0].y - 3 * S), g.letter, 2.6, S, { color: '#1d4e89', bold: true }))
    }
    // ties of the spots: one chain along x above, one along y at the left of each room
    for (const r of realRooms(doc, plan)) {
      const inRoom = lights.filter((l) => roomOf(plan, l) === r && (l.kind === 'spot' || l.kind === 'pendant' || l.kind === 'ceiling'))
      if (!inRoom.length) continue
      const b = polyBounds(r.polygon)
      const xs = uniqueSorted(inRoom.map((l) => l.x))
      const ys = uniqueSorted(inRoom.map((l) => l.y))
      if (xs.length <= 8) items.push(...dimChain([b.minX, ...xs, b.maxX].map((x) => V(x, b.minY)), -4 * S, S, { color: '#555555' }).map((x) => ({ ...x, layer: 'dimensions' as const })))
      if (ys.length <= 8) items.push(...dimChain([b.minY, ...ys, b.maxY].map((y) => V(b.minX, y)), 4 * S, S, { color: '#555555' }))
    }
    return items
  }
  const byKind = new Map<string, { n: number; lm: number; k: Set<number>; rooms: Set<string> }>()
  for (const l of lights) {
    const key = l.kind
    const v = byKind.get(key) ?? { n: 0, lm: 0, k: new Set<number>(), rooms: new Set<string>() }
    v.n++
    v.lm = Math.max(v.lm, l.lumens)
    v.k.add(l.temperature)
    const r = roomOf(plan, l)
    if (r) v.rooms.add(roomTitle(doc, r))
    byKind.set(key, v)
  }
  const swCount = new Map<string, number>()
  for (const s of switches) {
    const key = `${electricName(s)}|${Math.round(s.elevation)}`
    swCount.set(key, (swCount.get(key) ?? 0) + 1)
  }
  const legend: TableRow[] = [
    ...[...byKind.entries()].map(([k, v]): TableRow => [LIGHT_RU[k] ?? k, `${[...v.k].sort().join('/')} K, до ${Math.round(v.lm)} лм`, String(v.n)]),
    ...[...swCount.entries()].map(([k, n]): TableRow => {
      const [name, h] = k.split('|')
      return [name, `h = ${h} мм`, String(n)]
    }),
  ]
  const groupRows: TableRow[] = groups.map((g) => [g.letter, g.room, String(g.lights.length), g.sw ? electricName(g.sw) : 'не задан'])
  const blocks: SheetBlock[] = []
  if (legend.length)
    blocks.push({
      kind: 'table',
      table: { title: 'Условные обозначения', columns: [{ title: 'Наименование', width: 80 }, { title: 'Характеристика', width: 50 }, { title: 'Кол.', width: 14, align: 'middle' }], rows: legend, size: 2.3 },
    })
  if (groupRows.length)
    blocks.push({
      kind: 'table',
      table: {
        title: 'Группы освещения',
        columns: [{ title: 'Гр.', width: 10, align: 'middle' }, { title: 'Помещение', width: 60 }, { title: 'Светильников', width: 25, align: 'middle' }, { title: 'Выключатель', width: 50 }],
        rows: groupRows,
        size: 2.3,
      },
    })
  blocks.push({
    kind: 'notes',
    lines: ['Группы показаны по помещениям: светильники помещения на выключателе этого помещения. Уточните группы с электриком.', 'Привязки светильников даны от чистовых стен; высоты выключателей — до центра изделия.'],
    width: 180,
  })
  return planPages(ctx, 'lighting', levelId, build, blocks, { empty: lights.length || switches.length ? undefined : 'Нет светильников и выключателей' })
}

// ───────────────────────────── розетки и выводы ─────────────────────────────

export function socketsSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const { doc } = ctx
  const pts = Object.values(doc.electrical ?? {}).filter((p) => p.levelId === levelId && !isSwitch(p) && electricType(p.kind).kind !== 'thermostat')
  const eDoc: Doc = { ...doc, electrical: Object.fromEntries(pts.map((p) => [p.id, p])) }
  const build = (S: number) => basePlan(ctx, levelId, S, { electrical: true, electricalHeights: true, electricalDims: true, labels: true, furniture: true }, { ...eDoc, items: {} })
  const rows = new Map<string, { code: string; name: string; h: number; n: number; mount: string }>()
  for (const p of pts) {
    const ty = electricType(p.kind)
    const key = `${p.kind}|${p.gangs ?? 1}|${Math.round(p.elevation)}`
    const r = rows.get(key) ?? { code: ty.code, name: electricName(p), h: Math.round(p.elevation), n: 0, mount: p.mount }
    r.n++
    rows.set(key, r)
  }
  const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.h - b.h)
  const table: Table = {
    title: 'Ведомость электроустановочных изделий',
    columns: [
      { title: 'Код', width: 14, align: 'middle' },
      { title: 'Наименование', width: 90 },
      { title: 'Высота, мм', width: 22, align: 'middle' },
      { title: 'Кол.', width: 14, align: 'middle' },
    ],
    rows: list.map((r) => [r.code, r.name, r.mount === 'wall' ? String(r.h) : r.mount === 'floor' ? 'в полу' : 'потолок', String(r.n)]),
    footer: [['', 'Итого', '', String(pts.length)]],
    size: 2.3,
  }
  const notes = ['Высоты — до центра изделия от уровня чистого пола. Привязки — от чистовых углов помещения.', 'Розетки в санузле — IP44, не ближе 600 мм от ванны и душа.']
  return planPages(ctx, 'sockets', levelId, build, pts.length ? [{ kind: 'table', table }, { kind: 'notes', lines: notes, width: 140 }] : [], {
    empty: pts.length ? undefined : 'Розетки и выводы не расставлены',
  })
}

// ───────────────────────────── сантехника ─────────────────────────────

export function plumbingSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const { doc } = ctx
  const plan = ctx.plans[levelId]
  const probe = contribute('plumbing', { ctx, doc, levelId, plan, S: 50 })
  const keep = new Set<Id>()
  for (const it of Object.values(doc.items)) if (it.levelId === levelId && isPlumbingItem(ctx, it)) keep.add(it.id)
  const pDoc: Doc = { ...doc, items: Object.fromEntries(Object.entries(doc.items).filter(([id]) => keep.has(id))) }
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { furniture: true, labels: true, innerDimensions: true }, pDoc)
    items.push(...contribute('plumbing', { ctx, doc, levelId, plan, S }).items)
    return items
  }
  const blocks: SheetBlock[] = []
  if (probe.schedule?.length)
    blocks.push({
      kind: 'table',
      table: {
        title: 'Ведомость сантехнических выводов',
        columns: [
          { title: 'Поз.', width: 10, align: 'middle' },
          { title: 'Прибор', width: 42 },
          { title: 'Вывод', width: 46 },
          { title: 'Высота, мм', width: 18, align: 'middle' },
          { title: 'Помещение', width: 32 },
        ],
        rows: probe.schedule,
        size: 2.2,
      },
    })
  if (probe.legend?.length)
    blocks.push({ kind: 'table', table: { title: 'Условные обозначения', columns: [{ title: 'Обозн.', width: 18 }, { title: 'Наименование', width: 80 }], rows: probe.legend, size: 2.3 } })
  if (probe.notes?.length) blocks.push({ kind: 'notes', lines: probe.notes, width: 150 })
  return planPages(ctx, 'plumbing', levelId, build, blocks, { empty: probe.items.length ? undefined : 'Нет сантехприборов и выводов' })
}

const PLUMBING_PROC = new Set(['sink', 'washbasin', 'toilet', 'bathtub', 'shower', 'washingMachine', 'dishwasher', 'radiator'])
const PLUMBING_NAME = /унитаз|раковин|мойк|ванн|душ|биде|писсуар|инсталляц|стиральн|посудомо|бойлер|водонагрев|полотенцесуш|трап|toilet|sink|basin|bath|shower|bidet|washer|boiler/i

export function isPlumbingItem(ctx: AlbumCtx, it: Item): boolean {
  const a = lookupAsset(ctx.doc, ctx.catalog, it.assetId)
  if (a?.procedural && PLUMBING_PROC.has(a.procedural)) return true
  if (a?.category === 'bathroom') return true
  return PLUMBING_NAME.test(`${it.name ?? ''} ${a?.nameRu ?? ''} ${a?.name ?? ''} ${(a?.tags ?? []).join(' ')}`)
}

export function plumbingKind(ctx: AlbumCtx, it: Item): string {
  const a = lookupAsset(ctx.doc, ctx.catalog, it.assetId)
  if (a?.procedural && PLUMBING_PROC.has(a.procedural)) return a.procedural
  const s = `${it.name ?? ''} ${a?.nameRu ?? ''} ${a?.name ?? ''}`.toLowerCase()
  if (/унитаз|toilet|инсталляц/.test(s)) return 'toilet'
  if (/ванн|bath/.test(s) && !/комнат/.test(s)) return 'bathtub'
  if (/душ|shower/.test(s)) return 'shower'
  if (/мойк|sink/.test(s)) return 'sink'
  if (/раковин|basin/.test(s)) return 'washbasin'
  if (/стиральн|washer/.test(s)) return 'washingMachine'
  if (/посудомо|dishwasher/.test(s)) return 'dishwasher'
  if (/бойлер|водонагрев|boiler/.test(s)) return 'boiler'
  if (/полотенцесуш/.test(s)) return 'towelRail'
  return 'other'
}

// ───────────────────────────── тёплый пол ─────────────────────────────

export function underfloorSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const { doc } = ctx
  const plan = ctx.plans[levelId]
  const probe = contribute('underfloor', { ctx, doc, levelId, plan, S: 50 })
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { labels: true, areas: true }, { ...doc, electrical: {} })
    items.push(...contribute('underfloor', { ctx, doc, levelId, plan, S }).items)
    return items
  }
  const blocks: SheetBlock[] = []
  if (probe.schedule?.length)
    blocks.push({
      kind: 'table',
      table: {
        title: 'Зоны тёплого пола',
        columns: [{ title: 'Зона', width: 14, align: 'middle' }, { title: 'Помещение', width: 50 }, { title: 'Площадь, м²', width: 22, align: 'end' }, { title: 'Система', width: 50 }],
        rows: probe.schedule,
        size: 2.3,
      },
    })
  if (probe.legend?.length)
    blocks.push({ kind: 'table', table: { title: 'Условные обозначения', columns: [{ title: 'Обозн.', width: 18 }, { title: 'Наименование', width: 80 }], rows: probe.legend, size: 2.3 } })
  const notes = [...(probe.notes ?? [])]
  if (!probe.items.length) notes.unshift('Зоны тёплого пола в проекте не заданы. Лист заполнится, когда в плане появятся зоны тёплого пола и терморегуляторы.')
  notes.push('Под мебелью без ножек и сантехникой тёплый пол не укладывается.')
  blocks.push({ kind: 'notes', lines: notes, width: 160 })
  return planPages(ctx, 'underfloor', levelId, build, blocks, { empty: probe.items.length ? undefined : 'Зоны тёплого пола не заданы' })
}

/** floor area of a room, m² (re-exported for the contributors) */
export function roomArea(r: DerivedRoom): number {
  return r.area
}

export { fmtM2, isOutdoor }
