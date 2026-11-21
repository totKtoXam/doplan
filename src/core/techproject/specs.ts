/**
 * Specification sheets: двери и окна, сантехника, светильники, ведомость отделки помещений.
 * Tables only; long tables flow onto continuation sheets.
 */
import { OPENING_KIND_NAMES } from '../layers'
import type { DerivedRoom, Id, Opening, Vec2 } from '../types'
import { fmtNum, pointInPoly } from './annot'
import { itemTitle, levelCaption, lookupMaterial, materialTitle, roomTitle, sum } from './common'
import { roomFaces } from './elevations'
import { layBlockSheets, type SheetBlock } from './layout'
import type { AlbumCtx, PageDraft, SheetKind } from './model'
import { sheetInfo } from './model'
import { ceilingHeightOf, isPlumbingItem, LIGHT_RU, realRooms } from './plans'
import type { Table, TableRow } from './table'

const V = (x: number, y: number): Vec2 => ({ x, y })

function blockPages(ctx: AlbumCtx, kind: SheetKind, blocks: SheetBlock[], empty?: string): PageDraft[] {
  const title = sheetInfo(kind).title
  const sheets = layBlockSheets(ctx.paper, blocks)
  if (!sheets.length) return [{ kind, title, scale: 1, items: [], empty }]
  return sheets.map((items, i) => ({ kind, title: i ? `${title} (продолжение)` : title, scale: 1, items, empty: i ? undefined : empty }))
}

/** rooms a point belongs to (holes excluded) */
function roomAtPoint(ctx: AlbumCtx, levelId: Id, p: Vec2): DerivedRoom | undefined {
  return ctx.plans[levelId]?.rooms.find((r) => pointInPoly(p, r.polygon) && !r.holes.some((h) => pointInPoly(p, h)))
}

// ───────────────────────────── двери и окна ─────────────────────────────

export interface OpeningInfo {
  op: Opening
  levelId: Id
  /** centre on the wall axis */
  c: Vec2
  /** rooms on both sides (titles, «—» outside) */
  rooms: string[]
}

export function openingInfos(ctx: AlbumCtx): OpeningInfo[] {
  const { doc } = ctx
  const out: OpeningInfo[] = []
  for (const op of Object.values(doc.openings)) {
    if (op.hidden) continue
    const w = doc.walls[op.wallId]
    const a = w && doc.nodes[w.a]
    const b = w && doc.nodes[w.b]
    if (!w || !a || !b || !ctx.levels.includes(w.levelId)) continue
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const u = V((b.x - a.x) / L, (b.y - a.y) / L)
    const n = V(-u.y, u.x)
    const c = V(a.x + u.x * op.offset, a.y + u.y * op.offset)
    const k = w.thickness / 2 + 60
    const sides = [V(c.x + n.x * k, c.y + n.y * k), V(c.x - n.x * k, c.y - n.y * k)].map((p) => roomAtPoint(ctx, w.levelId, p))
    out.push({ op, levelId: w.levelId, c, rooms: sides.map((r) => (r ? roomTitle(doc, r) : '—')) })
  }
  return out.sort((x, y) => ctx.levels.indexOf(x.levelId) - ctx.levels.indexOf(y.levelId) || x.c.y - y.c.y || x.c.x - y.c.x)
}

const DOOR_KINDS = new Set(['door', 'doubleDoor', 'slidingDoor', 'entranceDoor', 'balconyDoor'])
const WINDOW_KINDS = new Set(['window', 'frenchWindow', 'balconyBlock'])

/**
 * Door hand as in RU practice: looking at the door from the side it opens towards (на себя),
 * hinges on the left — левая, on the right — правая.
 */
export function doorHand(op: Opening): 'левая' | 'правая' | '' {
  if (!DOOR_KINDS.has(op.kind) || op.kind === 'slidingDoor') return ''
  // standing on the `left` side facing the wall, node a is on the right hand
  const aOnRight = op.swing === 'left'
  const hingeRight = op.hinge === 'a' ? aOnRight : !aOnRight
  return hingeRight ? 'правая' : 'левая'
}

export function specOpeningsPages(ctx: AlbumCtx): PageDraft[] {
  const infos = openingInfos(ctx)
  const doors = infos.filter((i) => DOOR_KINDS.has(i.op.kind) || i.op.kind === 'arch' || i.op.kind === 'opening')
  const windows = infos.filter((i) => WINDOW_KINDS.has(i.op.kind))
  const mat = (id: Id | undefined) => (id ? materialTitle(lookupMaterial(ctx.doc, ctx.catalog, id), id) : '')
  const multi = ctx.levels.length > 1
  const where = (i: OpeningInfo) => {
    const rs = [...new Set(i.rooms.filter((s) => s !== '—'))]
    const s = rs.length === 2 ? `${rs[0]} — ${rs[1]}` : (rs[0] ?? '—')
    return multi ? `${ctx.doc.levels[i.levelId]?.name ?? ''}: ${s}` : s
  }
  const blocks: SheetBlock[] = []
  if (doors.length)
    blocks.push({
      kind: 'table',
      table: {
        title: 'Двери и проёмы',
        columns: [
          { title: 'Поз.', width: 12, align: 'middle' },
          { title: 'Тип', width: 38 },
          { title: 'Проём Ш×В, мм', width: 28, align: 'middle' },
          { title: 'Открыв.', width: 16, align: 'middle' },
          { title: 'Помещения', width: 60 },
          { title: 'Полотно / коробка', width: 46 },
        ],
        rows: doors.map((i, k) => [
          `Д${k + 1}`,
          i.op.name || OPENING_KIND_NAMES[i.op.kind]?.ru || i.op.kind,
          `${Math.round(i.op.width)}×${Math.round(i.op.height)}`,
          doorHand(i.op),
          where(i),
          [mat(i.op.leafMaterialId), mat(i.op.frameMaterialId)].filter(Boolean).join(' / '),
        ]),
        size: 2.3,
      },
    })
  if (windows.length)
    blocks.push({
      kind: 'table',
      table: {
        title: 'Окна и балконные блоки',
        columns: [
          { title: 'Поз.', width: 12, align: 'middle' },
          { title: 'Тип', width: 38 },
          { title: 'Проём Ш×В, мм', width: 28, align: 'middle' },
          { title: 'Низ, мм', width: 16, align: 'middle' },
          { title: 'Створок', width: 16, align: 'middle' },
          { title: 'Помещение', width: 50 },
          { title: 'Подоконник, мм', width: 24, align: 'middle' },
        ],
        rows: windows.map((i, k) => [
          `ОК${k + 1}`,
          i.op.name || OPENING_KIND_NAMES[i.op.kind]?.ru || i.op.kind,
          `${Math.round(i.op.width)}×${Math.round(i.op.height)}`,
          String(Math.round(i.op.sill)),
          i.op.sashes ? String(i.op.sashes) : '',
          where(i),
          i.op.sillBoard ? String(Math.round(i.op.sillBoard)) : '—',
        ]),
        size: 2.3,
      },
    })
  if (doors.length || windows.length)
    blocks.push({
      kind: 'notes',
      title: 'Примечания',
      lines: ['Размеры — проёма в стене; размеры блоков уточнить у поставщика после замера.', 'Открывание: левая / правая — если смотреть на дверь со стороны, куда она открывается.'],
      width: 150,
    })
  return blockPages(ctx, 'specOpenings', blocks, blocks.length ? undefined : 'В проекте нет дверей и окон')
}

// ───────────────────────────── сантехника ─────────────────────────────

export function specPlumbingPages(ctx: AlbumCtx): PageDraft[] {
  const { doc, catalog } = ctx
  const groups = new Map<string, { title: string; size: string; n: number; rooms: Set<string> }>()
  for (const lv of ctx.levels) {
    const list = Object.values(doc.items)
      .filter((it) => it.levelId === lv && !it.hidden && isPlumbingItem(ctx, it))
      .sort((a, b) => a.y - b.y || a.x - b.x)
    for (const it of list) {
      const title = itemTitle(doc, catalog, it)
      const size = `${Math.round(it.size.w)}×${Math.round(it.size.d)}×${Math.round(it.size.h)}`
      const key = `${title}|${size}`
      const g = groups.get(key) ?? { title, size, n: 0, rooms: new Set<string>() }
      g.n++
      const r = roomAtPoint(ctx, lv, it)
      g.rooms.add(levelCaption(ctx, r ? roomTitle(doc, r) : '—', ctx.levels.length > 1 ? lv : undefined))
      groups.set(key, g)
    }
  }
  const rows: TableRow[] = [...groups.values()].map((g, i) => [`С${i + 1}`, g.title, g.size, String(g.n), [...g.rooms].join(', '), ''])
  const blocks: SheetBlock[] = rows.length
    ? [
        {
          kind: 'table',
          table: {
            title: 'Спецификация сантехнического оборудования',
            columns: [
              { title: 'Поз.', width: 12, align: 'middle' },
              { title: 'Наименование', width: 70 },
              { title: 'Размер Ш×Г×В', width: 32, align: 'middle' },
              { title: 'Кол.', width: 12, align: 'middle' },
              { title: 'Помещение', width: 50 },
              { title: 'Артикул / поставщик', width: 44 },
            ],
            rows,
            size: 2.3,
          },
        },
      ]
    : []
  return blockPages(ctx, 'specPlumbing', blocks, rows.length ? undefined : 'В проекте нет сантехприборов')
}

// ───────────────────────────── светильники ─────────────────────────────

/** rough power of an LED light by its luminous flux (≈100 lm/W) */
export function ledWatts(lumens: number): number {
  return Math.max(1, Math.round(lumens / 100))
}

export function specLightsPages(ctx: AlbumCtx): PageDraft[] {
  const { doc } = ctx
  const groups = new Map<string, { kind: string; lm: number; k: number; n: number; rooms: Set<string>; len: number }>()
  for (const lv of ctx.levels) {
    for (const l of Object.values(doc.lights)) {
      if (l.levelId !== lv || l.hidden) continue
      const title = l.name || LIGHT_RU[l.kind] || l.kind
      const key = `${title}|${l.lumens}|${l.temperature}`
      const g = groups.get(key) ?? { kind: title, lm: l.lumens, k: l.temperature, n: 0, rooms: new Set<string>(), len: 0 }
      g.n++
      if (l.kind === 'strip' && l.size) g.len += Math.max(l.size.w, l.size.d)
      const r = roomAtPoint(ctx, lv, l)
      g.rooms.add(r ? roomTitle(doc, r) : '—')
      groups.set(key, g)
    }
  }
  const list = [...groups.values()]
  const rows: TableRow[] = list.map((g, i) => [
    `Св${i + 1}`,
    g.kind,
    String(g.n),
    g.len ? fmtNum(g.len / 1000, 1) : '',
    String(Math.round(g.lm)),
    `≈${ledWatts(g.lm)}`,
    String(Math.round(g.k)),
    [...g.rooms].join(', '),
  ])
  const total = sum(list, (g) => ledWatts(g.lm) * g.n)
  const blocks: SheetBlock[] = rows.length
    ? [
        {
          kind: 'table',
          table: {
            title: 'Спецификация светильников',
            columns: [
              { title: 'Поз.', width: 12, align: 'middle' },
              { title: 'Тип', width: 58 },
              { title: 'Кол.', width: 12, align: 'middle' },
              { title: 'Длина, м', width: 16, align: 'middle' },
              { title: 'Поток, лм', width: 18, align: 'middle' },
              { title: 'Мощн., Вт', width: 18, align: 'middle' },
              { title: 'T, K', width: 16, align: 'middle' },
              { title: 'Помещения', width: 60 },
            ],
            rows,
            size: 2.3,
            footer: [['', 'Итого (ориентировочно)', String(sum(list, (g) => g.n)), '', '', `≈${total}`, '', '']],
          },
        },
        { kind: 'notes', title: 'Примечания', lines: ['Мощность — ориентировочная для светодиодных источников (≈100 лм/Вт); уточнить по выбранным моделям.'], width: 150 },
      ]
    : []
  return blockPages(ctx, 'specLights', blocks, rows.length ? undefined : 'В проекте нет светильников')
}

// ───────────────────────────── ведомость отделки ─────────────────────────────

export interface RoomFinish {
  levelId: Id
  room: DerivedRoom
  floor: { title: string; area: number }
  /** wall finishes by material, net of openings, m² */
  walls: { title: string; area: number; label?: string }[]
  ceiling: { title: string; kind: string; area: number; height: number }
  /** skirting length net of door openings, m */
  skirting: { title: string; length: number; height: number } | null
}

const CEILING_KIND_RU: Record<string, string> = {
  flat: 'плоский',
  stretch: 'натяжной',
  multilevel: 'многоуровневый',
  coffered: 'кессонный',
  beams: 'с балками',
}

/** overlap of [a0,a1] and [b0,b1] */
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

export function roomFinishes(ctx: AlbumCtx): RoomFinish[] {
  const { doc, catalog } = ctx
  const mt = (id: Id | undefined) => materialTitle(lookupMaterial(doc, catalog, id), id)
  const out: RoomFinish[] = []
  for (const lv of ctx.levels) {
    const plan = ctx.plans[lv]
    if (!plan) continue
    for (const r of realRooms(doc, plan)) {
      const rec = doc.rooms[r.roomId]
      const H = ceilingHeightOf(doc, lv, r)
      const walls = new Map<string, { title: string; area: number; label?: string }>()
      const addWall = (id: Id, area: number, label?: string) => {
        if (area <= 0.0005) return
        const title = mt(id)
        const key = `${title}|${label ?? ''}`
        const w = walls.get(key) ?? { title, area: 0, label }
        w.area += area
        walls.set(key, w)
      }
      let doorCut = 0
      for (const f of roomFaces(doc, r)) {
        const w = doc.walls[f.wallId]
        const side = w[f.side]
        const a = doc.nodes[w.a]
        const b = doc.nodes[w.b]
        // openings on this face: interval along the face × height
        const holes: { t0: number; t1: number; z0: number; z1: number; door: boolean }[] = []
        if (a && b) {
          const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
          for (const op of Object.values(doc.openings)) {
            if (op.wallId !== w.id || op.hidden) continue
            const c = V(a.x + ((b.x - a.x) / L) * op.offset, a.y + ((b.y - a.y) / L) * op.offset)
            const t = (c.x - f.from.x) * f.u.x + (c.y - f.from.y) * f.u.y
            const t0 = Math.max(0, t - op.width / 2)
            const t1 = Math.min(f.length, t + op.width / 2)
            if (t1 <= t0) continue
            holes.push({ t0, t1, z0: op.sill, z1: Math.min(H, op.sill + op.height), door: op.sill < 50 })
          }
        }
        for (const h of holes) if (h.door) doorCut += h.t1 - h.t0
        const net = (z0: number, z1: number) => (f.length * (z1 - z0) - sum(holes, (h) => (h.t1 - h.t0) * overlap(z0, z1, h.z0, h.z1))) / 1e6
        const zones = [...(side.zones ?? [])].filter((z) => z.to > z.from).sort((p, q) => p.from - q.from)
        let z = 0
        for (const zn of zones) {
          const from = Math.max(z, Math.min(H, zn.from))
          const to = Math.min(H, zn.to)
          if (from > z) addWall(side.materialId, net(z, from))
          if (to > from) addWall(zn.materialId, net(from, to), zn.label)
          z = Math.max(z, to)
        }
        if (z < H) addWall(side.materialId, net(z, H))
      }
      const ck = rec?.ceiling?.kind ?? 'flat'
      out.push({
        levelId: lv,
        room: r,
        floor: { title: mt(rec?.floor?.materialId), area: r.area },
        walls: [...walls.values()],
        ceiling: { title: mt(rec?.ceiling?.materialId), kind: CEILING_KIND_RU[ck] ?? ck, area: r.area, height: H },
        skirting: rec && rec.skirting > 0 ? { title: rec.skirtingMaterialId ? mt(rec.skirtingMaterialId) : 'плинтус', length: Math.max(0, r.perimeter - doorCut / 1000), height: rec.skirting } : null,
      })
    }
  }
  return out
}

export function finishesTable(ctx: AlbumCtx, list: RoomFinish[] = roomFinishes(ctx)): Table {
  const multi = ctx.levels.length > 1
  return {
    title: 'Ведомость отделки помещений',
    columns: [
      { title: '№', width: 10, align: 'middle' },
      { title: 'Помещение', width: 34 },
      { title: 'Пол', width: 52 },
      { title: 'Стены', width: 82 },
      { title: 'Потолок', width: 52 },
      { title: 'Плинтус', width: 40 },
    ],
    rows: list.map((f, i) => [
      String(i + 1),
      `${roomTitle(ctx.doc, f.room)}${multi ? `\n${ctx.doc.levels[f.levelId]?.name ?? ''}` : ''}\n${fmtNum(f.room.area)} м²`,
      `${f.floor.title} — ${fmtNum(f.floor.area)} м²`,
      f.walls.length ? f.walls.map((w) => `${w.label ? `${w.label}: ` : ''}${w.title} — ${fmtNum(w.area)} м²`).join('\n') : '—',
      `${f.ceiling.title}, ${f.ceiling.kind} — ${fmtNum(f.ceiling.area)} м², h = ${fmtNum(f.ceiling.height / 1000)} м`,
      f.skirting ? `${f.skirting.title}, h ${Math.round(f.skirting.height)} — ${fmtNum(f.skirting.length, 1)} п. м` : '—',
    ]),
    size: 2.2,
  }
}

export function finishesPages(ctx: AlbumCtx): PageDraft[] {
  const list = roomFinishes(ctx)
  if (!list.length) return blockPages(ctx, 'finishes', [], 'В проекте нет помещений')
  return blockPages(ctx, 'finishes', [
    { kind: 'table', table: finishesTable(ctx, list) },
    {
      kind: 'notes',
      title: 'Примечания',
      lines: [
        'Площади стен — за вычетом проёмов, до отметки чистого потолка; без запаса на подрезку.',
        'Длина плинтуса — по периметру помещения за вычетом дверных проёмов.',
      ],
      width: 150,
    },
  ])
}

