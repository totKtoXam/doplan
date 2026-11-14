/**
 * Executes doplan doc tools against a ToolHost (the live document via docStore.transact, or a
 * plan-mode draft). Arguments are re-validated with the shared zod schemas; every failure comes
 * back as a readable message for the agent, never as a thrown error.
 */
import {
  addItem,
  addOpening,
  addRectRoom,
  addWall,
  applyFinishToWallSide,
  compilePlanSpecDetailed,
  moveNode,
  parsePlanSpec,
  pointInPolygon,
  removeEntities,
  setWallLength,
  syncRooms,
  validatePlanSpec,
  newId,
} from '@core'
import type { Catalog, DerivedPlan, Doc, EntityRef, Id, Vec2 } from '@core/types'
import type { AiToolResult } from '@shared/aiChat'
import { AI_TOOL_TITLES, type AiToolArgs, type AiToolName, isAiToolName, MUTATING_TOOLS, parseToolArgs } from '@shared/aiTools'
import { chipFor, collectionOf, describePlan, entityLevel, entitySummary, findEntity, lookupFor, type Lookup, r0, r1, roomAt, roomName } from './summary'

export interface Snapshot {
  mime: 'image/png' | 'image/jpeg'
  /** base64 */
  data: string
  note?: string
}

export interface ToolHost {
  doc(): Doc
  derived(levelId: Id): DerivedPlan
  activeLevelId(): Id
  selection(): EntityRef[]
  catalog(): Catalog
  /** applies an undoable change (label shown in the history); throws on failure */
  mutate(label: string, fn: (d: Doc) => void): void
  snapshot(view: '2d' | '3d', width: number, levelId: Id): Promise<Snapshot>
}

export interface ToolOutcome {
  result: AiToolResult
  /** human list of what changed (doc tools) */
  changes?: string[]
}

class ToolError extends Error {}

const fail = (text: string): ToolOutcome => ({ result: { ok: false, text } })
const ok = (text: string, changes?: string[]): ToolOutcome => ({ result: { ok: true, text }, changes })
const pt = (p: Vec2) => `(${r0(p.x)}, ${r0(p.y)})`
const normDeg = (d: number) => ((Math.round(d * 100) / 100) % 360 + 360) % 360
const inside = (p: Vec2, poly: Vec2[]) => pointInPolygon(p, poly)

export function txLabel(tool: AiToolName): string {
  return `ИИ: ${AI_TOOL_TITLES[tool].toLowerCase()}`
}

function levelOf(host: ToolHost, levelId: Id | undefined): Id {
  const doc = host.doc()
  const id = levelId ?? host.activeLevelId()
  if (!doc.levels[id]) throw new ToolError(`Уровень не найден: ${id}. Есть: ${doc.levelOrder.join(', ')}`)
  return id
}

function nodeOrPoint(doc: Doc, levelId: Id, e: string | Vec2, what: string): Vec2 {
  if (typeof e !== 'string') return e
  const n = doc.nodes[e]
  if (!n) throw new ToolError(`${what}: узел ${e} не найден (возьми id из get_plan)`)
  if (n.levelId !== levelId) throw new ToolError(`${what}: узел ${e} на другом уровне (${n.levelId})`)
  return { x: n.x, y: n.y }
}

function requireMaterial(lk: Lookup, id: Id): void {
  if (!lk.material(id)) throw new ToolError(`Материал ${id} не найден (ищи через list_catalog kind=material)`)
}

function itemPatchSize(size: { w: number; d: number; h: number } | undefined) {
  return size ? { w: size.w, d: size.d, h: size.h } : undefined
}

function clearLevel(d: Doc, levelId: Id): void {
  const walls = new Set(Object.values(d.walls).filter((w) => w.levelId === levelId).map((w) => w.id))
  for (const o of Object.values(d.openings)) if (walls.has(o.wallId)) delete d.openings[o.id]
  for (const coll of ['nodes', 'walls', 'rooms', 'items', 'lights', 'dimensions', 'labels'] as const) {
    const rec = d[coll] as Record<Id, { levelId: Id }>
    for (const id of Object.keys(rec)) if (rec[id].levelId === levelId) delete rec[id]
  }
}

/** copies one level of `src` into `d` (fresh ids) — same as the PlanSpec import does */
function copyLevel(src: Doc, srcLevel: Id, d: Doc, dst: Id): void {
  const nodeMap = new Map<Id, Id>()
  const wallMap = new Map<Id, Id>()
  for (const n of Object.values(src.nodes)) {
    if (n.levelId !== srcLevel) continue
    const id = newId('n')
    nodeMap.set(n.id, id)
    d.nodes[id] = { ...n, id, levelId: dst }
  }
  for (const w of Object.values(src.walls)) {
    if (w.levelId !== srcLevel) continue
    const a = nodeMap.get(w.a)
    const b = nodeMap.get(w.b)
    if (!a || !b) continue
    const id = newId('w')
    wallMap.set(w.id, id)
    d.walls[id] = structuredClone({ ...w, id, levelId: dst, a, b })
  }
  for (const o of Object.values(src.openings)) {
    const wallId = wallMap.get(o.wallId)
    if (!wallId) continue
    const id = newId('o')
    d.openings[id] = structuredClone({ ...o, id, wallId })
  }
  for (const r of Object.values(src.rooms)) {
    if (r.levelId !== srcLevel) continue
    const id = newId('r')
    d.rooms[id] = structuredClone({ ...r, id, levelId: dst })
  }
  for (const it of Object.values(src.items)) {
    if (it.levelId !== srcLevel) continue
    const id = newId('i')
    d.items[id] = structuredClone({ ...it, id, levelId: dst, groupId: undefined })
  }
  for (const [id, m] of Object.entries(src.materials)) if (!d.materials[id]) d.materials[id] = structuredClone(m)
  for (const [id, a] of Object.entries(src.assets)) if (!d.assets[id]) d.assets[id] = structuredClone(a)
}

function catalogSearch(host: ToolHost, args: AiToolArgs<'list_catalog'>): string {
  const doc = host.doc()
  const cat = host.catalog()
  const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const limit = args.limit ?? 40
  const match = (hay: string) => words.every((w) => hay.includes(w)) || (words.length > 1 && words.some((w) => w.length > 3 && hay.includes(w)))
  if (args.kind === 'asset') {
    const all = [...Object.values(doc.assets), ...cat.assets.filter((a) => !doc.assets[a.id])]
    const list = all.filter((a) => (!args.category || a.category === args.category) && (!words.length || match(`${a.id} ${a.name} ${a.nameRu ?? ''} ${(a.tags ?? []).join(' ')} ${a.category}`.toLowerCase())))
    const cats = [...new Set(all.map((a) => a.category))].sort().join(', ')
    const lines = list.slice(0, limit).map((a) => `- ${a.id} — ${a.nameRu ?? a.name} (${a.category}) ${r0(a.size.w)}×${r0(a.size.d)}×${r0(a.size.h)} ${a.mount}${a.slots ? ` слоты: ${Object.keys(a.slots).join(',')}` : ''}`)
    return `Найдено ${list.length}${list.length > limit ? `, показаны первые ${limit}` : ''}. Размеры Ш×Г×В, мм.\n${lines.join('\n') || '(ничего)'}\nКатегории: ${cats}`
  }
  const all = [...Object.values(doc.materials), ...cat.materials.filter((m) => !doc.materials[m.id])]
  const list = all.filter((m) => (!args.category || m.category === args.category) && (!words.length || match(`${m.id} ${m.name} ${m.nameRu ?? ''} ${m.category}`.toLowerCase())))
  const cats = [...new Set(all.map((m) => m.category))].sort().join(', ')
  const lines = list.slice(0, limit).map((m) => `- ${m.id} — ${m.nameRu ?? m.name} (${m.category}) ${m.color}`)
  return `Найдено ${list.length}${list.length > limit ? `, показаны первые ${limit}` : ''}.\n${lines.join('\n') || '(ничего)'}\nКатегории: ${cats}`
}

function entityJson(host: ToolHost, id: Id): string {
  const doc = host.doc()
  const ref = findEntity(doc, id)
  if (!ref) throw new ToolError(`Объект ${id} не найден`)
  const rec = (doc[collectionOf(ref.kind)] as Record<Id, unknown>)[id]
  const level = entityLevel(doc, ref)
  const out: Record<string, unknown> = { kind: ref.kind, ...(rec as object) }
  if (level) {
    const plan = host.derived(level)
    if (ref.kind === 'room') {
      const d = plan.rooms.find((r) => r.roomId === id)
      if (d) Object.assign(out, { area_m2: r1(d.area), perimeter_m: r1(d.perimeter), labelPoint: d.labelPoint, polygon: d.polygon.map((p) => [r0(p.x), r0(p.y)]), edges: d.edges.map((e) => ({ wallId: e.wallId, side: e.side, from: [r0(e.from.x), r0(e.from.y)], to: [r0(e.to.x), r0(e.to.y)] })) })
    }
    if (ref.kind === 'wall') {
      const g = plan.wallGeoms[id]
      if (g) Object.assign(out, { length: r0(g.length), angleDeg: r1((g.angle * 180) / Math.PI), a_xy: [r0(g.a.x), r0(g.a.y)], b_xy: [r0(g.b.x), r0(g.b.y)], leftFace: g.left.map((p) => [r0(p.x), r0(p.y)]), rightFace: g.right.map((p) => [r0(p.x), r0(p.y)]) })
    }
  }
  return JSON.stringify(out)
}

async function run(host: ToolHost, name: AiToolName, a: Record<string, unknown>): Promise<ToolOutcome> {
  const doc = host.doc()
  const lk = lookupFor(doc, host.catalog())
  const label = txLabel(name)
  switch (name) {
    case 'get_plan': {
      const args = a as AiToolArgs<'get_plan'>
      const lv = levelOf(host, args.levelId)
      return ok(describePlan(doc, host.derived(lv), lv, lk, { full: args.detail !== 'brief', activeLevelId: host.activeLevelId() }))
    }
    case 'get_selection': {
      const sel = host.selection()
      if (!sel.length) return ok('Ничего не выделено.')
      return ok(
        sel
          .map((r) => {
            const lv = entityLevel(doc, r)
            return `- ${r.kind} ${r.id}: ${entitySummary(doc, lv ? host.derived(lv) : undefined, r, lk)}`
          })
          .join('\n'),
      )
    }
    case 'get_entity':
      return ok(entityJson(host, (a as AiToolArgs<'get_entity'>).id))
    case 'get_planspec_schema':
      return fail('get_planspec_schema обрабатывается приложением')
    case 'list_catalog':
      return ok(catalogSearch(host, a as AiToolArgs<'list_catalog'>))
    case 'render_snapshot': {
      const args = a as AiToolArgs<'render_snapshot'>
      const lv = levelOf(host, args.levelId)
      const snap = await host.snapshot(args.view, args.width ?? 1024, lv)
      return { result: { ok: true, text: `Снимок ${args.view === '2d' ? '2D-плана' : '3D-вида'}${snap.note ? `. ${snap.note}` : ''}`, image: { mime: snap.mime, data: snap.data } } }
    }

    case 'add_wall': {
      const args = a as AiToolArgs<'add_wall'>
      const lv = levelOf(host, args.levelId)
      const p1 = nodeOrPoint(doc, lv, args.from, 'from')
      const p2 = nodeOrPoint(doc, lv, args.to, 'to')
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      if (len < 10) throw new ToolError(`Слишком короткая стена: ${r0(len)} мм`)
      let ids: Id[] = []
      host.mutate(label, (d) => {
        ids = addWall(d, lv, p1, p2, { thickness: args.thickness, height: args.height, kind: args.kind })
      })
      if (!ids.length) return ok('Стена совпадает с существующей — ничего не добавлено.')
      return ok(`Добавлено стен: ${ids.length} (${ids.join(', ')}) от ${pt(p1)} до ${pt(p2)}, длина ${r0(len)} мм.`, [`Стена ${pt(p1)} → ${pt(p2)}, ${r0(len)} мм`])
    }
    case 'add_rect_room': {
      const args = a as AiToolArgs<'add_rect_room'>
      const lv = levelOf(host, args.levelId)
      const before = new Set(Object.keys(doc.rooms))
      let roomId: Id | null = null
      let walls: Id[] = []
      host.mutate(label, (d) => {
        walls = addRectRoom(d, lv, args.x, args.y, args.w, args.h, { thickness: args.thickness })
        syncRooms(d)
        const cx = args.x + args.w / 2
        const cy = args.y + args.h / 2
        const fresh = Object.values(d.rooms).filter((r) => r.levelId === lv && !before.has(r.id))
        const rec = fresh.find((r) => Math.abs(r.anchor.x - cx) < args.w / 2 && Math.abs(r.anchor.y - cy) < args.h / 2) ?? fresh[0]
        if (rec) {
          roomId = rec.id
          if (args.name) rec.name = args.name
          if (args.type) rec.type = args.type
        }
      })
      return ok(`Комната ${args.w}×${args.h} мм в (${r0(args.x)}, ${r0(args.y)}): стены ${walls.join(', ') || '—'}${roomId ? `, комната ${roomId}` : ''}.`, [`Комната ${r1((args.w * args.h) / 1e6)} м² (по осям)`])
    }
    case 'move_node': {
      const args = a as AiToolArgs<'move_node'>
      const n = doc.nodes[args.nodeId]
      if (!n) throw new ToolError(`Узел ${args.nodeId} не найден`)
      host.mutate(label, (d) => moveNode(d, args.nodeId, args.x, args.y))
      return ok(`Узел ${args.nodeId}: ${pt(n)} → ${pt(args)}.`, [`Узел ${pt(n)} → ${pt(args)}`])
    }
    case 'set_wall': {
      const args = a as AiToolArgs<'set_wall'>
      const w = doc.walls[args.wallId]
      if (!w) throw new ToolError(`Стена ${args.wallId} не найдена`)
      const ch: string[] = []
      if (args.thickness !== undefined) ch.push(`толщина ${r0(w.thickness)} → ${r0(args.thickness)}`)
      if (args.height !== undefined) ch.push(`высота ${r0(w.height)} → ${r0(args.height)}`)
      if (args.kind !== undefined) ch.push(`тип ${w.kind} → ${args.kind}`)
      if (args.length !== undefined) ch.push(`длина → ${r0(args.length)}`)
      if (!ch.length) throw new ToolError('Нечего менять: укажи thickness, height, kind или length')
      host.mutate(label, (d) => {
        const dw = d.walls[args.wallId]
        if (args.thickness !== undefined) dw.thickness = args.thickness
        if (args.height !== undefined) dw.height = args.height
        if (args.kind !== undefined) dw.kind = args.kind
        if (args.length !== undefined) setWallLength(d, args.wallId, args.length, args.anchor ?? 'a')
      })
      return ok(`Стена ${args.wallId}: ${ch.join(', ')}.`, [`Стена ${args.wallId}: ${ch.join(', ')}`])
    }
    case 'delete': {
      const args = a as AiToolArgs<'delete'>
      const refs: EntityRef[] = []
      const missing: string[] = []
      for (const id of args.ids) {
        const r = findEntity(doc, id)
        if (r) refs.push(r)
        else missing.push(id)
      }
      if (!refs.length) throw new ToolError(`Не найдены: ${missing.join(', ')}`)
      const desc = refs.map((r) => `${r.kind} ${r.id}`)
      host.mutate(label, (d) => removeEntities(d, refs))
      return ok(`Удалено: ${desc.join(', ')}${missing.length ? `. Не найдены: ${missing.join(', ')}` : ''}.`, [`Удалено: ${desc.join(', ')}`])
    }
    case 'add_opening': {
      const args = a as AiToolArgs<'add_opening'>
      const w = doc.walls[args.wallId]
      if (!w) throw new ToolError(`Стена ${args.wallId} не найдена`)
      const na = doc.nodes[w.a]
      const nb = doc.nodes[w.b]
      const len = Math.hypot(nb.x - na.x, nb.y - na.y)
      let offset = args.offset
      if (offset === undefined && args.at) {
        const t = ((args.at.x - na.x) * (nb.x - na.x) + (args.at.y - na.y) * (nb.y - na.y)) / (len * len || 1)
        offset = Math.max(0, Math.min(1, t)) * len
      }
      offset ??= len / 2
      if (offset > len) throw new ToolError(`offset ${r0(offset)} больше длины стены ${r0(len)}`)
      let id = ''
      host.mutate(label, (d) => {
        const patch: Record<string, number> = {}
        if (args.width !== undefined) patch.width = args.width
        if (args.height !== undefined) patch.height = args.height
        if (args.sill !== undefined) patch.sill = args.sill
        id = addOpening(d, args.wallId, args.kind, offset!, patch)
      })
      return ok(`Проём ${id} (${args.kind}) на ${args.wallId}, offset ${r0(offset)} мм от узла ${w.a} (длина стены ${r0(len)}).`, [`${args.kind} на стене ${args.wallId}`])
    }
    case 'set_room': {
      const args = a as AiToolArgs<'set_room'>
      const rec = doc.rooms[args.roomId]
      if (!rec) throw new ToolError(`Комната ${args.roomId} не найдена (id из get_plan)`)
      for (const m of [args.floorMaterialId, args.ceilingMaterialId, args.wallMaterialId]) if (m) requireMaterial(lk, m)
      const dr = host.derived(rec.levelId).rooms.find((r) => r.roomId === args.roomId)
      if (args.wallMaterialId && !dr) throw new ToolError('Контур комнаты не найден — стены не покрасить')
      const ch: string[] = []
      if (args.name) ch.push(`название «${args.name}»`)
      if (args.type) ch.push(`тип ${args.type}`)
      if (args.floorMaterialId) ch.push(`пол ${args.floorMaterialId}`)
      if (args.ceilingMaterialId) ch.push(`потолок ${args.ceilingMaterialId}`)
      if (args.wallMaterialId) ch.push(`стены ${args.wallMaterialId}`)
      if (args.ceilingHeight !== undefined) ch.push(`высота потолка ${r0(args.ceilingHeight)}`)
      if (args.skirting !== undefined) ch.push(`плинтус ${r0(args.skirting)}`)
      if (!ch.length) throw new ToolError('Нечего менять')
      host.mutate(label, (d) => {
        const r = d.rooms[args.roomId]
        if (args.name) r.name = args.name
        if (args.type) r.type = args.type
        if (args.floorMaterialId) r.floor.materialId = args.floorMaterialId
        if (args.ceilingMaterialId) r.ceiling.materialId = args.ceilingMaterialId
        if (args.ceilingHeight !== undefined) r.ceiling.height = args.ceilingHeight
        if (args.skirting !== undefined) r.skirting = args.skirting
        if (args.wallMaterialId && dr) for (const e of dr.edges) applyFinishToWallSide(d, e.wallId, e.side, args.wallMaterialId)
      })
      return ok(`Комната ${args.roomId} «${args.name ?? roomName(doc, args.roomId)}»: ${ch.join(', ')}.`, [`Комната «${args.name ?? roomName(doc, args.roomId)}»: ${ch.join(', ')}`])
    }
    case 'place_item': {
      const args = a as AiToolArgs<'place_item'>
      const asset = lk.asset(args.assetId)
      if (!asset) throw new ToolError(`Предмет каталога ${args.assetId} не найден (ищи через list_catalog kind=asset)`)
      let lv = levelOf(host, args.levelId)
      let x = args.x
      let y = args.y
      if (x === undefined || y === undefined) {
        if (!args.roomId) throw new ToolError('Укажи x и y или roomId')
        const rec = doc.rooms[args.roomId]
        if (rec) lv = rec.levelId
        const dr = host.derived(lv).rooms.find((r) => r.roomId === args.roomId)
        if (!dr) throw new ToolError(`Комната ${args.roomId} не найдена`)
        x ??= dr.labelPoint.x
        y ??= dr.labelPoint.y
      }
      const rotation = normDeg(args.rotation ?? 0)
      let id = ''
      host.mutate(label, (d) => {
        id = addItem(d, lv, asset, x!, y!, {
          rotation,
          ...(args.elevation !== undefined ? { elevation: args.elevation } : {}),
          ...(args.size ? { size: itemPatchSize(args.size) } : {}),
          ...(args.name ? { name: args.name } : {}),
        })
      })
      const room = roomAt(host.derived(lv), { x, y }, inside)
      const size = args.size ?? asset.size
      const nm = asset.nameRu ?? asset.name
      return ok(
        `Поставлен ${id} «${nm}» в ${pt({ x, y })}, поворот ${rotation}°, ${r0(size.w)}×${r0(size.d)}×${r0(size.h)} мм${room ? `, комната ${room} «${roomName(host.doc(), room)}»` : ', вне комнат'}.`,
        [`«${nm}» в ${pt({ x, y })}${room ? `, ${roomName(host.doc(), room)}` : ''}`],
      )
    }
    case 'move_item': {
      const args = a as AiToolArgs<'move_item'>
      const it = doc.items[args.itemId]
      if (!it) throw new ToolError(`Предмет ${args.itemId} не найден`)
      const ch: string[] = []
      if (args.x !== undefined || args.y !== undefined) ch.push(`${pt(it)} → ${pt({ x: args.x ?? it.x, y: args.y ?? it.y })}`)
      if (args.rotation !== undefined) ch.push(`поворот ${r0(it.rotation)}° → ${normDeg(args.rotation)}°`)
      if (args.elevation !== undefined) ch.push(`над полом ${r0(args.elevation)}`)
      if (args.size) ch.push(`размер ${r0(args.size.w)}×${r0(args.size.d)}×${r0(args.size.h)}`)
      if (!ch.length) throw new ToolError('Нечего менять')
      host.mutate(label, (d) => {
        const di = d.items[args.itemId]
        if (args.x !== undefined) di.x = args.x
        if (args.y !== undefined) di.y = args.y
        if (args.rotation !== undefined) di.rotation = normDeg(args.rotation)
        if (args.elevation !== undefined) di.elevation = args.elevation
        if (args.size) di.size = itemPatchSize(args.size)!
      })
      return ok(`Предмет ${args.itemId}: ${ch.join(', ')}.`, [`${chipFor(doc, undefined, { kind: 'item', id: args.itemId }, lk).label}: ${ch.join(', ')}`])
    }
    case 'set_material': {
      const args = a as AiToolArgs<'set_material'>
      requireMaterial(lk, args.materialId)
      const ref = findEntity(doc, args.targetId)
      if (!ref) throw new ToolError(`Объект ${args.targetId} не найден`)
      const m = lk.material(args.materialId)!
      const mName = m.nameRu ?? m.name
      if (ref.kind === 'room') {
        const surface = args.surface ?? 'floor'
        const rec = doc.rooms[ref.id]
        if (surface === 'walls') {
          const dr = host.derived(rec.levelId).rooms.find((r) => r.roomId === ref.id)
          if (!dr) throw new ToolError('Контур комнаты не найден')
          host.mutate(label, (d) => {
            for (const e of dr.edges) applyFinishToWallSide(d, e.wallId, e.side, args.materialId)
          })
        } else if (surface === 'floor' || surface === 'ceiling') {
          host.mutate(label, (d) => {
            d.rooms[ref.id][surface].materialId = args.materialId
          })
        } else throw new ToolError('surface для комнаты: floor | ceiling | walls')
        return ok(`Комната «${roomName(doc, ref.id)}»: ${surface} → ${mName}.`, [`«${roomName(doc, ref.id)}», ${surface}: ${mName}`])
      }
      if (ref.kind === 'wall') {
        const surface = args.surface ?? 'both'
        if (!['left', 'right', 'both'].includes(surface)) throw new ToolError('surface для стены: left | right | both')
        host.mutate(label, (d) => {
          if (surface !== 'right') applyFinishToWallSide(d, ref.id, 'left', args.materialId)
          if (surface !== 'left') applyFinishToWallSide(d, ref.id, 'right', args.materialId)
        })
        return ok(`Стена ${ref.id} (${surface}) → ${mName}.`, [`Стена ${ref.id} (${surface}): ${mName}`])
      }
      if (ref.kind === 'item') {
        const it = doc.items[ref.id]
        const asset = lk.asset(it.assetId)
        const slots = Object.keys(asset?.slots ?? {})
        if (!slots.length) throw new ToolError('У этого предмета нет настраиваемых материалов')
        if (args.surface && !slots.includes(args.surface)) throw new ToolError(`Слот ${args.surface} не найден. Есть: ${slots.join(', ')}`)
        const target = args.surface ? [args.surface] : slots
        host.mutate(label, (d) => {
          const di = d.items[ref.id]
          di.overrides = { ...(di.overrides ?? {}) }
          for (const s of target) di.overrides[s] = args.materialId
        })
        return ok(`Предмет ${ref.id}: ${target.join(', ')} → ${mName}.`, [`Предмет ${ref.id}: ${mName}`])
      }
      throw new ToolError(`Материал можно назначить комнате, стене или предмету, а не ${ref.kind}`)
    }
    case 'apply_planspec': {
      const args = a as AiToolArgs<'apply_planspec'>
      let spec
      try {
        spec = parsePlanSpec(args.spec)
      } catch (e) {
        throw new ToolError(`PlanSpec не разобран: ${(e as Error).message}`)
      }
      const issues = validatePlanSpec(spec)
      const errors = issues.filter((i) => (i as { severity?: string }).severity === 'error')
      if (errors.length) throw new ToolError(`PlanSpec с ошибками: ${errors.slice(0, 8).map((i) => (i as { message?: string }).message ?? JSON.stringify(i)).join('; ')}`)
      const compiled = compilePlanSpecDetailed(spec)
      const src = compiled.doc
      const srcLevel = compiled.levelId || src.levelOrder[0]
      const mode = args.mode ?? 'replace'
      let target = host.activeLevelId()
      host.mutate(label, (d) => {
        if (mode === 'replace') {
          clearLevel(d, target)
        } else {
          const last = d.levels[d.levelOrder[d.levelOrder.length - 1]]
          const lvSrc = src.levels[srcLevel]
          target = newId('lv')
          d.levels[target] = { ...lvSrc, id: target, elevation: last ? last.elevation + last.height + 200 : 0 }
          d.levelOrder.push(target)
        }
        copyLevel(src, srcLevel, d, target)
      })
      const plan = host.derived(target)
      const warn = issues.slice(0, 6).map((i) => (i as { message?: string }).message).filter(Boolean)
      return ok(
        `План построен на уровне ${target} (${mode}): стен ${Object.values(host.doc().walls).filter((w) => w.levelId === target).length}, комнат ${plan.rooms.length}.${warn.length ? ` Замечания: ${warn.join('; ')}` : ''}`,
        [`План из PlanSpec (${mode === 'replace' ? 'замена уровня' : 'новый этаж'})`],
      )
    }
  }
}

/** Validates and runs one tool; never throws. */
export async function executeTool(host: ToolHost, tool: string, args: unknown): Promise<ToolOutcome> {
  if (!isAiToolName(tool)) return fail(`Неизвестный инструмент: ${tool}`)
  const parsed = parseToolArgs(tool, args)
  if (!parsed.ok) return fail(parsed.error)
  try {
    return await run(host, tool, parsed.args as Record<string, unknown>)
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message)
    console.error(`[doplan] ai tool ${tool} failed`, e)
    return fail(`Ошибка при выполнении ${tool}: ${(e as Error)?.message ?? e}`)
  }
}

export function isMutating(tool: string): boolean {
  return isAiToolName(tool) && MUTATING_TOOLS.has(tool)
}

/** Short human description of a call (approval cards, plan-mode list). */
export function describeCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const p = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' ? pt(v as Vec2) : '?')
  switch (tool) {
    case 'add_wall':
      return `Стена от ${p(a.from)} до ${p(a.to)}`
    case 'add_rect_room':
      return `Комната ${a.w}×${a.h} в (${a.x}, ${a.y})${a.name ? ` «${a.name}»` : ''}`
    case 'move_node':
      return `Узел ${a.nodeId} → (${a.x}, ${a.y})`
    case 'set_wall':
      return `Стена ${a.wallId}: ${Object.keys(a).filter((k) => k !== 'wallId').join(', ')}`
    case 'delete':
      return `Удалить ${Array.isArray(a.ids) ? a.ids.join(', ') : ''}`
    case 'add_opening':
      return `${a.kind} на стене ${a.wallId}`
    case 'set_room':
      return `Комната ${a.roomId}: ${Object.keys(a).filter((k) => k !== 'roomId').join(', ')}`
    case 'place_item':
      return `Поставить ${a.assetId}${a.x !== undefined ? ` в (${a.x}, ${a.y})` : a.roomId ? ` в ${a.roomId}` : ''}`
    case 'move_item':
      return `Предмет ${a.itemId}: ${Object.keys(a).filter((k) => k !== 'itemId').join(', ')}`
    case 'set_material':
      return `${a.targetId}${a.surface ? ` (${a.surface})` : ''} → ${a.materialId}`
    case 'apply_planspec':
      return `Построить план (${a.mode ?? 'replace'})`
    default:
      return isAiToolName(tool) ? AI_TOOL_TITLES[tool] : tool
  }
}
