/**
 * Compact text views of the document for agents (get_plan / get_entity / selection chips).
 * Pure: works on any Doc + DerivedPlan (the real document or a plan-mode draft).
 */
import { ROOM_TYPE_NAMES, electricName, electricPointsOf } from '@core'
import type { Asset, Catalog, DerivedPlan, Doc, ElectricPoint, EntityKind, EntityRef, Id, Material } from '@core/types'
import type { AiChip } from '@shared/aiChat'

export const r0 = (n: number) => Math.round(n)
export const r1 = (n: number) => Math.round(n * 10) / 10
const pt = (p: { x: number; y: number }) => `(${r0(p.x)}, ${r0(p.y)})`

const COLLECTIONS: [keyof Doc, EntityKind][] = [
  ['nodes', 'node'],
  ['walls', 'wall'],
  ['openings', 'opening'],
  ['rooms', 'room'],
  ['items', 'item'],
  ['lights', 'light'],
  ['electrical', 'electric'],
  ['dimensions', 'dimension'],
  ['labels', 'label'],
  ['underlays', 'underlay'],
]

export function findEntity(doc: Doc, id: Id): EntityRef | null {
  for (const [coll, kind] of COLLECTIONS) {
    const rec = doc[coll] as Record<Id, unknown>
    if (rec && Object.prototype.hasOwnProperty.call(rec, id)) return { kind, id }
  }
  return null
}

export function collectionOf(kind: EntityKind): keyof Doc {
  return COLLECTIONS.find((c) => c[1] === kind)![0]
}

export function entityLevel(doc: Doc, ref: EntityRef): Id | null {
  const e = (doc[collectionOf(ref.kind)] as Record<Id, { levelId?: Id; wallId?: Id }>)[ref.id]
  if (!e) return null
  if (e.levelId) return e.levelId
  if (ref.kind === 'opening' && e.wallId) return doc.walls[e.wallId]?.levelId ?? null
  return null
}

export function roomName(doc: Doc, roomId: Id): string {
  const r = doc.rooms[roomId]
  if (!r) return roomId
  return r.name || ROOM_TYPE_NAMES[r.type]?.ru || r.id
}

export interface Lookup {
  asset(id: Id): Asset | undefined
  material(id: Id): Material | undefined
}

export function lookupFor(doc: Doc, catalog: Catalog): Lookup {
  const assets = new Map(catalog.assets.map((a) => [a.id, a]))
  const materials = new Map(catalog.materials.map((m) => [m.id, m]))
  return {
    asset: (id) => doc.assets[id] ?? assets.get(id),
    material: (id) => doc.materials[id] ?? materials.get(id),
  }
}

const matName = (lk: Lookup, id: Id | undefined) => {
  if (!id) return '—'
  const m = lk.material(id)
  return m ? `${m.nameRu ?? m.name} [${id}]` : id
}

function bbox(poly: { x: number; y: number }[]): string {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of poly) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return `x ${r0(x0)}…${r0(x1)}, y ${r0(y0)}…${r0(y1)}`
}

/** Room that contains a point (inner faces), if any. */
export function roomAt(plan: DerivedPlan, p: { x: number; y: number }, inside: (p: { x: number; y: number }, poly: { x: number; y: number }[]) => boolean): Id | null {
  for (const r of plan.rooms) if (inside(p, r.polygon)) return r.roomId
  return null
}

export function describePlan(doc: Doc, plan: DerivedPlan, levelId: Id, lk: Lookup, opts: { full: boolean; activeLevelId: Id }): string {
  const lines: string[] = []
  const lv = doc.levels[levelId]
  const others = doc.levelOrder.filter((id) => id !== levelId).map((id) => `${id} «${doc.levels[id]?.name ?? id}»`)
  lines.push(`Уровень ${levelId} «${lv?.name ?? '?'}»${levelId === opts.activeLevelId ? ' (активный)' : ''}, высота стен по умолчанию ${r0(lv?.height ?? 0)} мм.${others.length ? ` Другие уровни: ${others.join(', ')}.` : ''}`)
  lines.push('Единицы: мм; x вправо, y вниз; углы по часовой.')
  const b = plan.bounds
  if (Number.isFinite(b.minX)) lines.push(`Габариты плана: x ${r0(b.minX)}…${r0(b.maxX)}, y ${r0(b.minY)}…${r0(b.maxY)}.`)

  lines.push('', `Комнаты (${plan.rooms.length}):`)
  for (const r of plan.rooms) {
    const rec = doc.rooms[r.roomId]
    const name = rec ? roomName(doc, r.roomId) : 'без записи'
    const walls = r.edges.map((e) => `${e.wallId}:${e.side}`).join(' ')
    let s = `- ${r.roomId} «${name}» ${rec?.type ?? ''} ${r1(r.area)} м², центр ${pt(r.labelPoint)}, внутр. ${bbox(r.polygon)}`
    if (opts.full && rec) s += `; пол ${matName(lk, rec.floor.materialId)}, потолок ${matName(lk, rec.ceiling.materialId)}${rec.ceiling.height ? ` h=${r0(rec.ceiling.height)}` : ''}`
    s += `; стены (стена:сторона к комнате): ${walls}`
    lines.push(s)
  }

  const nodes = Object.values(doc.nodes).filter((n) => n.levelId === levelId)
  const walls = Object.values(doc.walls).filter((w) => w.levelId === levelId)
  if (opts.full) {
    lines.push('', `Узлы (${nodes.length}): ${nodes.map((n) => `${n.id}${pt(n)}`).join(' ')}`)
  }
  lines.push('', `Стены (${walls.length}):`)
  for (const w of walls) {
    const g = plan.wallGeoms[w.id]
    const a = doc.nodes[w.a]
    const bn = doc.nodes[w.b]
    const len = g?.length ?? (a && bn ? Math.hypot(bn.x - a.x, bn.y - a.y) : 0)
    let s = `- ${w.id} ${w.a}${a ? pt(a) : ''} → ${w.b}${bn ? pt(bn) : ''} L=${r0(len)} t=${r0(w.thickness)} h=${r0(w.height)}${w.kind !== 'wall' ? ` ${w.kind}` : ''}`
    if (opts.full) s += `; left ${matName(lk, w.left?.materialId)}, right ${matName(lk, w.right?.materialId)}`
    lines.push(s)
  }

  const openings = Object.values(doc.openings).filter((o) => doc.walls[o.wallId]?.levelId === levelId)
  lines.push('', `Проёмы (${openings.length}):`)
  for (const o of openings) lines.push(`- ${o.id} ${o.kind} на ${o.wallId} offset=${r0(o.offset)} ширина ${r0(o.width)} высота ${r0(o.height)}${o.sill ? ` низ ${r0(o.sill)}` : ''}`)

  const items = Object.values(doc.items).filter((i) => i.levelId === levelId)
  lines.push('', `Предметы (${items.length}):`)
  for (const it of items) {
    const a = lk.asset(it.assetId)
    lines.push(
      `- ${it.id} «${it.name ?? a?.nameRu ?? a?.name ?? it.assetId}» [${it.assetId}] центр ${pt(it)} поворот ${r0(it.rotation)}° ${r0(it.size.w)}×${r0(it.size.d)}×${r0(it.size.h)}${it.elevation ? ` над полом ${r0(it.elevation)}` : ''}`,
    )
  }
  const lights = Object.values(doc.lights).filter((l) => l.levelId === levelId)
  if (lights.length) {
    lines.push('', `Свет (${lights.length}): ${lights.map((l) => `${l.id} ${l.kind}${pt(l)}`).join(' ')}`)
  }
  const points = electricPointsOf(doc, levelId)
  if (points.length) {
    lines.push('', `Электрика (${points.length}):`)
    for (const p of points) lines.push(`- ${electricLine(p)}`)
  }
  return lines.join('\n')
}

function electricLine(p: ElectricPoint): string {
  const wall = p.mount === 'wall' ? (p.wallId ? ` на ${p.wallId} (${p.side})` : ' на стене (не привязана)') : p.mount === 'floor' ? ' в полу' : ' на потолке'
  return `${p.id} ${p.kind}${p.gangs && p.gangs > 1 ? ` ×${p.gangs}${p.vertical ? ' вертикально' : ''}` : ''} ${pt(p)}${wall}, высота ${r0(p.elevation)}, поворот ${r0(p.rotation)}°${p.comment ? ` — «${p.comment}»` : ''}`
}

/** One-line summary of an entity (chips, approval cards). */
export function entitySummary(doc: Doc, plan: DerivedPlan | undefined, ref: EntityRef, lk: Lookup): string {
  switch (ref.kind) {
    case 'node': {
      const n = doc.nodes[ref.id]
      return n ? `узел ${pt(n)}` : 'узел'
    }
    case 'wall': {
      const w = doc.walls[ref.id]
      if (!w) return 'стена'
      const a = doc.nodes[w.a]
      const b = doc.nodes[w.b]
      const len = plan?.wallGeoms[w.id]?.length ?? (a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0)
      return `стена ${w.a}${a ? pt(a) : ''}→${w.b}${b ? pt(b) : ''}, длина ${r0(len)}, толщина ${r0(w.thickness)}, высота ${r0(w.height)}`
    }
    case 'opening': {
      const o = doc.openings[ref.id]
      return o ? `${o.kind} ${r0(o.width)}×${r0(o.height)} на стене ${o.wallId}, offset ${r0(o.offset)}` : 'проём'
    }
    case 'room': {
      const r = doc.rooms[ref.id]
      const d = plan?.rooms.find((x) => x.roomId === ref.id)
      return r ? `комната «${roomName(doc, ref.id)}» (${r.type})${d ? `, ${r1(d.area)} м², центр ${pt(d.labelPoint)}` : ''}` : 'комната'
    }
    case 'item': {
      const it = doc.items[ref.id]
      if (!it) return 'предмет'
      const a = lk.asset(it.assetId)
      return `«${it.name ?? a?.nameRu ?? a?.name ?? it.assetId}» [${it.assetId}] центр ${pt(it)}, поворот ${r0(it.rotation)}°, ${r0(it.size.w)}×${r0(it.size.d)}×${r0(it.size.h)}`
    }
    case 'light': {
      const l = doc.lights[ref.id]
      return l ? `свет ${l.kind} ${pt(l)}` : 'свет'
    }
    case 'electric': {
      const p = doc.electrical?.[ref.id]
      return p ? electricLine(p) : 'электроточка'
    }
    case 'dimension':
      return 'размерная линия'
    case 'label': {
      const l = doc.labels[ref.id]
      return l ? `подпись «${l.text}»` : 'подпись'
    }
    case 'underlay':
      return 'подложка'
  }
}

const KIND_LABEL: Record<EntityKind, string> = {
  node: 'Узел',
  wall: 'Стена',
  opening: 'Проём',
  room: 'Комната',
  item: 'Предмет',
  light: 'Свет',
  electric: 'Электроточка',
  dimension: 'Размер',
  label: 'Подпись',
  underlay: 'Подложка',
}

/** `lang`: the chip label is shown to the user (the summary goes to the agent) */
export function chipFor(doc: Doc, plan: DerivedPlan | undefined, ref: EntityRef, lk: Lookup, lang: 'ru' | 'en' = 'ru'): AiChip {
  let label = KIND_LABEL[ref.kind]
  if (ref.kind === 'room' && doc.rooms[ref.id]) label = roomName(doc, ref.id)
  if (ref.kind === 'electric') {
    const p = doc.electrical?.[ref.id]
    if (p) label = electricName(p, lang)
  }
  if (ref.kind === 'item') {
    const it = doc.items[ref.id]
    const a = it ? lk.asset(it.assetId) : undefined
    if (it) label = it.name ?? (a ? (lang === 'en' ? a.name : (a.nameRu ?? a.name)) : label)
  }
  return { kind: ref.kind, id: ref.id, label, summary: entitySummary(doc, plan, ref, lk) }
}
