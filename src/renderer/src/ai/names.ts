/**
 * What the user reads about a plan object: its kind, size and room — never its internal id. Used by the
 * action log of the chat (what a tool call changed) and by the id chips in the agent's text.
 */
import { electricName, markBadge, roomDisplayName } from '@core'
import type { DerivedPlan, Doc, EntityRef, Id } from '@core/types'
import { t } from '@/i18n'
import { OPENING_NAMES, WALL_KIND_NAMES } from '@/ui/shell/kindNames'
import { chipFor, findEntity, type Lookup, r0 } from './summary'
import '@/ui/electricI18n'
import './i18n'

export interface NameCtx {
  doc: Doc
  /** the derived plan of a level (rooms around walls, wall lengths) */
  plan(levelId: Id): DerivedPlan | undefined
  lk: Lookup
  lang: 'ru' | 'en'
}

/** an internal document id as it may show up in text: `w_UEecTYeFRN`, `pm_…`, `lv_…`, `auto_…` (rooms) */
export const ID_RE = /(?<![\w-])(?:(?:lv|pm|ly|[nworiltducamve])_[A-Za-z0-9_-]{10}|auto_[a-z0-9]{4,12})(?![\w-])/g

/** the whole string is one id */
export function isIdLike(s: string): boolean {
  return [...s.matchAll(ID_RE)].some((m) => m[0] === s)
}

/** a room as the user calls it: its name, else its type */
const roomLabel = (doc: Doc, roomId: Id) => t(roomDisplayName(doc, roomId))

/** the rooms around some walls: « (Кухня / Прихожая)», or '' */
export function roomsOfWalls(c: NameCtx, wallIds: Id[]): string {
  const names: string[] = []
  const levels = new Set(wallIds.map((id) => c.doc.walls[id]?.levelId).filter(Boolean) as Id[])
  for (const lv of levels) {
    for (const r of c.plan(lv)?.rooms ?? []) {
      if (!r.edges.some((e) => wallIds.includes(e.wallId))) continue
      const n = roomLabel(c.doc, r.roomId)
      if (!names.includes(n)) names.push(n)
    }
  }
  return names.length ? ` (${names.join(' / ')})` : ''
}

/** the room a side of a wall faces, if any */
export function sideRoom(c: NameCtx, wallId: Id, side: 'left' | 'right'): string | undefined {
  const w = c.doc.walls[wallId]
  const r = w ? c.plan(w.levelId)?.rooms.find((x) => x.edges.some((e) => e.wallId === wallId && e.side === side)) : undefined
  return r ? roomLabel(c.doc, r.roomId) : undefined
}

/** «Стена (Кухня / Прихожая)»: the kind and the rooms, without the length */
export function wallTitle(c: NameCtx, wallId: Id): string {
  const w = c.doc.walls[wallId]
  return `${t(WALL_KIND_NAMES[w?.kind ?? 'wall'] ?? 'Стена')}${w ? roomsOfWalls(c, [wallId]) : ''}`
}

function wallLength(c: NameCtx, wallId: Id): number {
  const w = c.doc.walls[wallId]
  const g = w ? c.plan(w.levelId)?.wallGeoms[wallId] : undefined
  if (g) return g.length
  const a = w && c.doc.nodes[w.a]
  const b = w && c.doc.nodes[w.b]
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0
}

/** «Стена 3425 мм (Кухня / Прихожая)», «Дверь 800×2100 (Кухня)», «Диван», «Кухня» */
export function entityName(c: NameCtx, ref: EntityRef): string {
  const { doc } = c
  switch (ref.kind) {
    case 'wall': {
      const w = doc.walls[ref.id]
      if (!w) return t('Стена')
      return `${t(WALL_KIND_NAMES[w.kind] ?? 'Стена')} ${r0(wallLength(c, ref.id))} ${t('мм')}${roomsOfWalls(c, [ref.id])}`
    }
    case 'opening': {
      const o = doc.openings[ref.id]
      if (!o) return t('Проём')
      return `${t(OPENING_NAMES[o.kind] ?? 'Проём')} ${r0(o.width)}×${r0(o.height)}${roomsOfWalls(c, [o.wallId])}`
    }
    case 'node': {
      // a junction: named by the rooms of the walls that meet there
      const walls = Object.values(doc.walls).filter((w) => w.a === ref.id || w.b === ref.id)
      return `${t('Узел')}${roomsOfWalls(c, walls.map((w) => w.id))}`
    }
    case 'room':
      return doc.rooms[ref.id] ? roomLabel(doc, ref.id) : t('Помещение')
    case 'electric': {
      const p = doc.electrical?.[ref.id]
      if (!p) return t('Электроточка')
      return `${electricName(p, c.lang)}${p.wallId ? roomsOfWalls(c, [p.wallId]) : ''}`
    }
    default:
      return t(chipFor(doc, undefined, ref, c.lk, c.lang).label)
  }
}

/** the readable name behind any id the document knows (objects, marks, levels, materials, assets); null = gone */
export function nameOfId(c: NameCtx, id: string): { name: string; ref?: EntityRef; mark?: Id; levelId?: Id } | null {
  const ref = findEntity(c.doc, id)
  if (ref) return { name: entityName(c, ref), ref }
  // a room of the derived plan that is not stored yet (auto_…)
  for (const lv of c.doc.levelOrder) {
    if (c.plan(lv)?.rooms.some((r) => r.roomId === id)) return { name: t('Помещение') }
  }
  const m = c.doc.annotations?.[id]
  if (m) return { name: t('Пометка {n}', { n: markBadge(m.n) }), mark: id }
  const lv = c.doc.levels[id]
  if (lv) return { name: lv.name, levelId: id }
  const mat = c.lk.material(id)
  if (mat) return { name: c.lang === 'en' ? mat.name : (mat.nameRu ?? mat.name) }
  const asset = c.lk.asset(id)
  if (asset) return { name: c.lang === 'en' ? asset.name : (asset.nameRu ?? asset.name) }
  return null
}

/** the name of an id, or «(удалённый объект)» */
export function idName(c: NameCtx, id: string): string {
  return nameOfId(c, id)?.name ?? t('(удалённый объект)')
}

/** text with the ids it carries put into words */
export function nameIds(c: NameCtx, text: string): string {
  return text.replace(ID_RE, (id) => idName(c, id))
}

/** splits text into plain runs and id tokens (for chips in the agent's answer) */
export function splitIds(text: string): (string | { id: string })[] {
  const out: (string | { id: string })[] = []
  let last = 0
  for (const m of text.matchAll(ID_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push({ id: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
