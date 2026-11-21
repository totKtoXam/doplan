/**
 * The measurement plan fixed before the renovation (обмерный план) and what changed since:
 * demolished walls and new openings cut in the old walls (план демонтажа), new partitions and
 * openings to brick up (план монтажа перегородок). Walls are matched by geometry, not by id: a wall
 * split by a new T-junction or redrawn over the old one still counts as the old wall.
 */
import { derivePlan } from '../derive'
import type { DisplayItem } from '../display'
import type { Doc, Id, Opening, TechBaseline, Vec2, Wall, WallKind } from '../types'
import { dim, fmtNum, label, marker } from './annot'
import { basePlan, planPages, sum } from './common'
import type { SheetBlock } from './layout'
import type { AlbumCtx, PageDraft } from './model'
import { measureSheet } from './plans'
import type { Table, TableRow } from './table'

const V = (x: number, y: number): Vec2 => ({ x, y })

export function captureBaseline(doc: Doc, takenAt: string = new Date().toISOString()): TechBaseline {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
  return { takenAt, nodes: clone(doc.nodes), walls: clone(doc.walls), openings: clone(doc.openings), rooms: clone(doc.rooms) }
}

/** the document as measured: the baseline walls and rooms, nothing placed */
export function baselineDoc(doc: Doc): Doc | null {
  const b = doc.techProject?.baseline
  if (!b) return null
  return { ...doc, nodes: b.nodes, walls: b.walls, openings: b.openings, rooms: b.rooms, items: {}, lights: {}, electrical: {}, dimensions: {}, labels: {}, annotations: {} }
}

// ───────────────────────────── geometry diff ─────────────────────────────

interface Seg {
  wall: Wall
  a: Vec2
  b: Vec2
  L: number
  u: Vec2
}

function segs(doc: Doc, levelId: Id): Seg[] {
  const out: Seg[] = []
  for (const w of Object.values(doc.walls)) {
    if (w.levelId !== levelId || w.kind === 'virtual') continue
    const a = doc.nodes[w.a]
    const b = doc.nodes[w.b]
    if (!a || !b) continue
    const L = Math.hypot(b.x - a.x, b.y - a.y)
    if (L < 1) continue
    out.push({ wall: w, a: V(a.x, a.y), b: V(b.x, b.y), L, u: V((b.x - a.x) / L, (b.y - a.y) / L) })
  }
  return out
}

/** parts [t0, t1] (mm from `s.a`) of a segment not covered by collinear segments of `others` */
function uncovered(s: Seg, others: Seg[], tol = 40, minLen = 100): [number, number][] {
  const cover: [number, number][] = []
  for (const o of others) {
    const cross = Math.abs(s.u.x * o.u.y - s.u.y * o.u.x)
    if (cross > 0.035) continue // > 2°
    const off = (p: Vec2) => Math.abs((p.x - s.a.x) * -s.u.y + (p.y - s.a.y) * s.u.x)
    const t = Math.max(tol, Math.abs(s.wall.thickness - o.wall.thickness) / 2 + 20)
    if (off(o.a) > t || off(o.b) > t) continue
    const ta = (o.a.x - s.a.x) * s.u.x + (o.a.y - s.a.y) * s.u.y
    const tb = (o.b.x - s.a.x) * s.u.x + (o.b.y - s.a.y) * s.u.y
    const lo = Math.max(0, Math.min(ta, tb))
    const hi = Math.min(s.L, Math.max(ta, tb))
    if (hi > lo) cover.push([lo, hi])
  }
  cover.sort((p, q) => p[0] - q[0])
  const out: [number, number][] = []
  let cur = 0
  for (const [lo, hi] of cover) {
    if (lo - cur >= minLen) out.push([cur, lo])
    cur = Math.max(cur, hi)
  }
  if (s.L - cur >= minLen) out.push([cur, s.L])
  return out
}

export interface WallChange {
  wallId: Id
  levelId: Id
  kind: WallKind
  a: Vec2
  b: Vec2
  length: number
  thickness: number
  height: number
}

export interface OpeningChange {
  op: Opening
  levelId: Id
  /** centre on the wall axis */
  c: Vec2
  u: Vec2
  thickness: number
  /** new: cut in an old wall; wider: an old opening enlarged; closed: an old opening to brick up */
  kind: 'new' | 'wider' | 'closed'
}

export interface PlanDiff {
  demolished: WallChange[]
  built: WallChange[]
  openings: OpeningChange[]
}

function pieces(s: Seg, parts: [number, number][], levelId: Id): WallChange[] {
  return parts.map(([t0, t1]) => ({
    wallId: s.wall.id,
    levelId,
    kind: s.wall.kind,
    a: V(s.a.x + s.u.x * t0, s.a.y + s.u.y * t0),
    b: V(s.a.x + s.u.x * t1, s.a.y + s.u.y * t1),
    length: t1 - t0,
    thickness: s.wall.thickness,
    height: s.wall.height,
  }))
}

interface OpAt {
  op: Opening
  seg: Seg
  c: Vec2
}

function openingsAt(doc: Doc, ss: Seg[]): OpAt[] {
  const byWall = new Map(ss.map((s) => [s.wall.id, s]))
  const out: OpAt[] = []
  for (const op of Object.values(doc.openings)) {
    const s = byWall.get(op.wallId)
    if (!s || op.hidden) continue
    out.push({ op, seg: s, c: V(s.a.x + s.u.x * op.offset, s.a.y + s.u.y * op.offset) })
  }
  return out
}

/** is the point on one of the segments' parts that are NOT in `parts` (i.e. on old wall) */
function onKeptPart(p: Vec2, s: Seg, gone: [number, number][]): boolean {
  const t = (p.x - s.a.x) * s.u.x + (p.y - s.a.y) * s.u.y
  return !gone.some(([t0, t1]) => t >= t0 - 1 && t <= t1 + 1)
}

export function planDiff(doc: Doc, levelId: Id): PlanDiff | null {
  const base = baselineDoc(doc)
  if (!base) return null
  const was = segs(base, levelId)
  const now = segs(doc, levelId)
  const demolished: WallChange[] = []
  const built: WallChange[] = []
  const goneOf = new Map<Seg, [number, number][]>()
  const newOf = new Map<Seg, [number, number][]>()
  for (const s of was) {
    const parts = uncovered(s, now)
    goneOf.set(s, parts)
    demolished.push(...pieces(s, parts, levelId))
  }
  for (const s of now) {
    const parts = uncovered(s, was)
    newOf.set(s, parts)
    built.push(...pieces(s, parts, levelId))
  }
  const oldOps = openingsAt(base, was)
  const newOps = openingsAt(doc, now)
  const match = (o: OpAt, list: OpAt[]) =>
    list.find((x) => Math.hypot(x.c.x - o.c.x, x.c.y - o.c.y) < Math.max(150, (o.op.width + x.op.width) / 4) && Math.abs(x.seg.u.x * o.seg.u.y - x.seg.u.y * o.seg.u.x) < 0.035)
  const openings: OpeningChange[] = []
  for (const o of newOps) {
    // openings of new partitions belong to the partition
    if (!onKeptPart(o.c, o.seg, newOf.get(o.seg) ?? [])) continue
    const m = match(o, oldOps)
    const ch = (kind: OpeningChange['kind']): OpeningChange => ({ op: o.op, levelId, c: o.c, u: o.seg.u, thickness: o.seg.wall.thickness, kind })
    if (!m) openings.push(ch('new'))
    else if (o.op.width > m.op.width + 50 || o.op.height > m.op.height + 50) openings.push(ch('wider'))
  }
  for (const o of oldOps) {
    // openings of demolished walls go with the wall
    if (!onKeptPart(o.c, o.seg, goneOf.get(o.seg) ?? [])) continue
    if (!match(o, newOps)) openings.push({ op: o.op, levelId, c: o.c, u: o.seg.u, thickness: o.seg.wall.thickness, kind: 'closed' })
  }
  return { demolished, built, openings }
}

// ───────────────────────────── drawing ─────────────────────────────

const RED = '#c0392b'
const NEW = '#8a5a00'

function band(a: Vec2, b: Vec2, th: number): Vec2[] {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const n = V((-(b.y - a.y) / L) * (th / 2), ((b.x - a.x) / L) * (th / 2))
  return [V(a.x + n.x, a.y + n.y), V(b.x + n.x, b.y + n.y), V(b.x - n.x, b.y - n.y), V(a.x - n.x, a.y - n.y)]
}

function hatched(pts: Vec2[], color: string, role: string, dashed: boolean): DisplayItem {
  return {
    t: 'poly',
    layer: 'annotations',
    role,
    pts,
    closed: true,
    stroke: { color, width: 0.35, dash: dashed ? [2, 1] : undefined },
    fill: { color: '#ffffff', opacity: 1, hatch: { color, angle: 45, spacing: 1.2, width: 0.13 } },
  }
}

function openingBand(o: OpeningChange): Vec2[] {
  const h = o.op.width / 2
  return band(V(o.c.x - o.u.x * h, o.c.y - o.u.y * h), V(o.c.x + o.u.x * h, o.c.y + o.u.y * h), o.thickness + 20)
}

const WALL_RU: Record<string, string> = { wall: 'Стена', partition: 'Перегородка', parapet: 'Парапет', glazing: 'Остекление' }

function mid(a: Vec2, b: Vec2): Vec2 {
  return V((a.x + b.x) / 2, (a.y + b.y) / 2)
}

/** a marker beside a wall piece (outside the wall band) */
function sideMarker(w: { a: Vec2; b: Vec2; thickness: number }, text: string, S: number, color: string): DisplayItem[] {
  const m = mid(w.a, w.b)
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
  const n = V(-(w.b.y - w.a.y) / L, (w.b.x - w.a.x) / L)
  const k = w.thickness / 2 + 4.5 * S
  return marker(V(m.x + n.x * k, m.y + n.y * k), text, S, { color })
}

function noBaselinePage(ctx: AlbumCtx, kind: 'demolition' | 'construction', levelId: Id): PageDraft[] {
  const blocks: SheetBlock[] = [
    {
      kind: 'notes',
      title: 'Примечания',
      lines: [
        'Обмерный план не зафиксирован. Зафиксируйте обмер (состояние до ремонта) в окне «Технический проект», затем внесите перепланировку — лист покажет снесённые и возводимые стены.',
      ],
      width: 150,
    },
  ]
  return planPages(ctx, kind, levelId, (S) => basePlan(ctx, levelId, S, { outerDimensions: true }), blocks, { empty: 'Обмер не зафиксирован' })
}

export function demolitionSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const diff = planDiff(ctx.doc, levelId)
  const base = baselineDoc(ctx.doc)
  if (!diff || !base) return noBaselinePage(ctx, 'demolition', levelId)
  const cuts = diff.openings.filter((o) => o.kind !== 'closed')
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { outerDimensions: true, labels: true }, base)
    diff.demolished.forEach((w, i) => {
      items.push(hatched(band(w.a, w.b, w.thickness), RED, 'tp-demolish', true))
      items.push(...sideMarker(w, `Д${i + 1}`, S, RED))
      items.push(...dim(w.a, w.b, w.thickness / 2 + 9 * S, S, { color: RED }))
    })
    cuts.forEach((o, i) => {
      items.push(hatched(openingBand(o), RED, 'tp-demolish-opening', false))
      items.push(label(V(o.c.x, o.c.y - (o.thickness / 2 + 3 * S)), `Пр${i + 1}`, 2.2, S, { color: RED, bold: true }))
    })
    return items
  }
  const rows: TableRow[] = [
    ...diff.demolished.map((w, i) => [
      `Д${i + 1}`,
      `Демонтаж: ${(WALL_RU[w.kind] ?? 'стена').toLowerCase()}`,
      String(Math.round(w.length)),
      String(Math.round(w.thickness)),
      String(Math.round(w.height)),
      fmtNum((w.length * w.height) / 1e6),
      fmtNum((w.length * w.height * w.thickness) / 1e9, 2),
    ]),
    ...cuts.map((o, i) => [
      `Пр${i + 1}`,
      o.kind === 'wider' ? 'Расширение проёма' : 'Устройство проёма',
      String(Math.round(o.op.width)),
      String(Math.round(o.thickness)),
      String(Math.round(o.op.height)),
      fmtNum((o.op.width * o.op.height) / 1e6),
      fmtNum((o.op.width * o.op.height * o.thickness) / 1e9, 2),
    ]),
  ]
  const blocks: SheetBlock[] = []
  if (rows.length) {
    const table: Table = {
      title: 'Ведомость демонтажа',
      columns: [
        { title: 'Поз.', width: 12, align: 'middle' },
        { title: 'Работа', width: 50 },
        { title: 'Длина / ширина, мм', width: 22, align: 'middle' },
        { title: 'Толщ., мм', width: 16, align: 'middle' },
        { title: 'Высота, мм', width: 16, align: 'middle' },
        { title: 'Площадь, м²', width: 18, align: 'end' },
        { title: 'Объём, м³', width: 18, align: 'end' },
      ],
      rows,
      size: 2.3,
      footer: [
        [
          '',
          'Итого демонтаж стен',
          fmtNum(sum(diff.demolished, (w) => w.length) / 1000, 2) + ' п. м',
          '',
          '',
          fmtNum(sum(diff.demolished, (w) => w.length * w.height) / 1e6),
          fmtNum(sum(diff.demolished, (w) => w.length * w.height * w.thickness) / 1e9, 2),
        ],
      ],
    }
    blocks.push({ kind: 'table', table })
  }
  blocks.push({
    kind: 'notes',
    title: 'Примечания',
    lines: [
      'Показано состояние по обмеру; демонтируемые конструкции заштрихованы.',
      'Демонтаж несущих стен и устройство проёмов в них — только по проекту перепланировки, согласованному в установленном порядке.',
    ],
    width: 150,
  })
  return planPages(ctx, 'demolition', levelId, build, blocks, { empty: rows.length ? undefined : 'Демонтажа нет: план совпадает с обмером' })
}

export function constructionSheet(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const diff = planDiff(ctx.doc, levelId)
  if (!diff) return noBaselinePage(ctx, 'construction', levelId)
  const closed = diff.openings.filter((o) => o.kind === 'closed')
  const build = (S: number) => {
    const items = basePlan(ctx, levelId, S, { outerDimensions: true, innerDimensions: true, labels: true })
    diff.built.forEach((w, i) => {
      items.push(hatched(band(w.a, w.b, w.thickness), NEW, 'tp-build', false))
      items.push(...sideMarker(w, `П${i + 1}`, S, NEW))
    })
    closed.forEach((o, i) => {
      items.push(hatched(openingBand(o), NEW, 'tp-build-opening', false))
      items.push(label(V(o.c.x, o.c.y - (o.thickness / 2 + 3 * S)), `З${i + 1}`, 2.2, S, { color: NEW, bold: true }))
    })
    return items
  }
  const rows: TableRow[] = [
    ...diff.built.map((w, i) => [
      `П${i + 1}`,
      WALL_RU[w.kind] ?? 'Стена',
      String(Math.round(w.length)),
      String(Math.round(w.thickness)),
      String(Math.round(w.height)),
      fmtNum((w.length * w.height) / 1e6),
      '',
    ]),
    ...closed.map((o, i) => [`З${i + 1}`, 'Закладка проёма', String(Math.round(o.op.width)), String(Math.round(o.thickness)), String(Math.round(o.op.height)), fmtNum((o.op.width * o.op.height) / 1e6), '']),
  ]
  const blocks: SheetBlock[] = []
  if (rows.length)
    blocks.push({
      kind: 'table',
      table: {
        title: 'Ведомость возводимых перегородок',
        columns: [
          { title: 'Поз.', width: 12, align: 'middle' },
          { title: 'Конструкция', width: 36 },
          { title: 'Длина, мм', width: 18, align: 'middle' },
          { title: 'Толщ., мм', width: 16, align: 'middle' },
          { title: 'Высота, мм', width: 16, align: 'middle' },
          { title: 'Площадь, м²', width: 18, align: 'end' },
          { title: 'Материал', width: 36 },
        ],
        rows,
        size: 2.3,
        footer: [['', 'Итого', fmtNum(sum(diff.built, (w) => w.length) / 1000, 2) + ' п. м', '', '', fmtNum(sum(diff.built, (w) => w.length * w.height) / 1e6), '']],
      },
    })
  blocks.push({
    kind: 'notes',
    title: 'Примечания',
    lines: ['Возводимые перегородки заштрихованы; размеры даны от чистовых поверхностей существующих стен.', 'Материал перегородок (ГКЛ, ПГП, газобетон) — по согласованию с заказчиком.'],
    width: 150,
  })
  return planPages(ctx, 'construction', levelId, build, blocks, { empty: rows.length ? undefined : 'Новых перегородок нет: план совпадает с обмером' })
}

/** the measurement plan: the baseline when fixed, otherwise the current plan */
export function measurePages(ctx: AlbumCtx, levelId: Id): PageDraft[] {
  const base = baselineDoc(ctx.doc)
  if (base && Object.values(base.walls).some((w) => w.levelId === levelId)) return measureSheet(ctx, levelId, base, derivePlan(base, levelId), true)
  return measureSheet(ctx, levelId, ctx.doc, ctx.plans[levelId], false)
}
