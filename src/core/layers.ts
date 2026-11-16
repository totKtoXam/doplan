/**
 * Layers & outliner model (the layers panel, like Figma Layers / Blender Outliner).
 *
 *  - Every plan object may carry `LayerFlags` (types.ts): own `hidden` / `locked`, a user `name`
 *    and the flat user layer it is on (`layerId` → `Doc.layers`).
 *  - A whole kind can be hidden / locked at once (`Doc.groupFlags[kind]`).
 *  - Effective state = own ∨ group ∨ layer ∨ parent (an opening follows its wall).
 *    Hidden objects are not drawn in 2D, 3D and exports (`visibleDoc` / `visiblePlan`); locked ones
 *    cannot be picked on the plan / in 3D and are not deleted.
 *
 * The list of object kinds is a REGISTRY: a new kind of objects (electrical points, furniture
 * variants…) calls `registerEntityKind()` from its own core module and shows up in the panel, gets
 * filtered from drawings by `visibleDoc`, and keeps its flags / layer in saved files through
 * `readLayerFlags` (io). Nothing in this file needs to change for that.
 *
 * Pure TS: no DOM / Node imports.
 */
import { newId } from './ids'
import { ROOM_TYPE_NAMES } from './defaults'
import type {
  Annotation,
  DerivedPlan,
  Dimension,
  Doc,
  EntityRef,
  GroupFlags,
  Id,
  Item,
  Label,
  LayerFlags,
  Light,
  LightKind,
  Opening,
  OpeningKind,
  Room,
  Underlay,
  UserLayer,
  Wall,
  WallKind,
} from './types'

// ───────────────────────────── registry ─────────────────────────────

export type LayerLang = 'ru' | 'en'

/** what object names may need from outside the document */
export interface KindNameEnv {
  doc: Doc
  lang: LayerLang
  /** display name of an asset (the catalogue lives outside the document) */
  assetName?(assetId: Id): string | undefined
}

/** any plan object record (walls, items, a registered kind's records…) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntity = { id: Id } & Record<string, any>

/**
 * One kind of plan objects as the layers panel and the visibility filter see it.
 * Defaults assume the record has the optional `LayerFlags` fields (`hidden`, `locked`, `name`, `layerId`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface EntityKindDef<T extends { id: Id } = any> {
  /** `EntityRef.kind` of the objects (selection, hit-testing) */
  kind: string
  /** key of the `Record<Id, T>` table in the document (`doc[docKey]`) */
  docKey: string
  /** group title in the panel (plural) */
  title: { ru: string; en: string }
  /** icon id for the UI (lucide icon name in kebab-case, e.g. 'brick-wall'); unknown ids get a generic icon */
  icon: string
  /** sort order of the group in the panel */
  order: number
  /** level the object is on (objects of other levels are not listed for the active level) */
  level(obj: T, doc: Doc): Id | undefined
  /** display name: the user name or one generated from the object */
  name(obj: T, env: KindNameEnv): string
  /** sets the user name; '' resets to the generated one. Absent = not renamable */
  rename?(obj: T, name: string): void
  /** finer type shown next to the name and matched by the search ('Дверь', 'Перегородка') */
  subtype?(obj: T, env: KindNameEnv): string | undefined
  /** object whose hidden / locked state this one inherits (an opening → its wall) */
  parent?(obj: T, doc: Doc): EntityRef | undefined
  /** own flags, when the record does not use `hidden` / `locked` (underlays use `visible`) */
  isOwnHidden?(obj: T): boolean
  setOwnHidden?(obj: T, hidden: boolean): void
  isOwnLocked?(obj: T): boolean
  setOwnLocked?(obj: T, locked: boolean): void
  /** false = not listed in the panel (still filtered by visibility); default true */
  listed?: boolean
  /**
   * selection of these objects is not `uiStore.selection` (pencil marks live in their own store):
   * the UI attaches its own select adapter
   */
  customSelection?: boolean
}

const registry = new Map<string, EntityKindDef>()
let sortedCache: EntityKindDef[] | null = null

/** Registers (or replaces) a kind of plan objects. Call once at module load of the kind's core module. */
export function registerEntityKind<T extends { id: Id }>(def: EntityKindDef<T>): void {
  registry.set(def.kind, def as EntityKindDef)
  sortedCache = null
}

/** all registered kinds, in panel order */
export function entityKinds(): readonly EntityKindDef[] {
  if (!sortedCache) sortedCache = [...registry.values()].sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind))
  return sortedCache
}

export function entityKind(kind: string): EntityKindDef | undefined {
  return registry.get(kind)
}

/** the object table of a kind in a document (undefined when the document has none yet) */
export function kindTable(doc: Doc, def: EntityKindDef): Record<Id, AnyEntity> | undefined {
  const t = (doc as unknown as Record<string, unknown>)[def.docKey]
  return t && typeof t === 'object' ? (t as Record<Id, AnyEntity>) : undefined
}

/**
 * Every table of a kind: the live one and, for a variant collection (items, lights), the stash of
 * each inactive furnishing variant — flags and layer ids live there too.
 */
export function kindTables(doc: Doc, def: EntityKindDef): Record<Id, AnyEntity>[] {
  const out: Record<Id, AnyEntity>[] = []
  const live = kindTable(doc, def)
  if (live) out.push(live)
  const list = doc.variants?.list
  if (list) {
    for (const id in list) {
      const t = (list[id].stash?.collections as Record<string, unknown> | undefined)?.[def.docKey]
      if (t && typeof t === 'object') out.push(t as Record<Id, AnyEntity>)
    }
  }
  return out
}

/** layers-panel fields the first file format already had (older apps keep them) */
const V1_FIELDS: Record<string, readonly string[]> = { item: ['name', 'hidden', 'locked'], room: ['name'], label: ['name'] }

/**
 * Whether the document uses layers-panel data an older doplan would silently drop on its next save:
 * user layers, group flags, or an object's own hidden / locked / layer / user name (also in the
 * stashed furnishing variants). Such a document is written with a newer format version.
 */
export function usesLayers(doc: Doc): boolean {
  if (doc.layers && Object.keys(doc.layers).length) return true
  if (doc.layerOrder?.length) return true
  if (doc.groupFlags && Object.values(doc.groupFlags).some((g) => g.hidden || g.locked)) return true
  for (const def of entityKinds()) {
    const native = V1_FIELDS[def.kind] ?? []
    const flags = !def.isOwnHidden && !def.isOwnLocked
    for (const table of kindTables(doc, def)) {
      for (const id in table) {
        const o = table[id]
        if (o.layerId !== undefined) return true
        if (o.name !== undefined && !native.includes('name') && def.rename === setName) return true
        if (flags && !native.includes('hidden') && o.hidden === true) return true
        if (flags && !native.includes('locked') && o.locked === true) return true
      }
    }
  }
  return false
}

export function entityOf(doc: Doc, ref: { kind: string; id: Id }): AnyEntity | undefined {
  const def = registry.get(ref.kind)
  return def ? kindTable(doc, def)?.[ref.id] : undefined
}

function ownHidden(def: EntityKindDef, o: AnyEntity): boolean {
  return def.isOwnHidden ? def.isOwnHidden(o) : o.hidden === true
}

function ownLocked(def: EntityKindDef, o: AnyEntity): boolean {
  return def.isOwnLocked ? def.isOwnLocked(o) : o.locked === true
}

// ───────────────────────────── built-in kinds ─────────────────────────────

const WALL_KIND_NAMES: Record<WallKind, { ru: string; en: string }> = {
  wall: { ru: 'Стена', en: 'Wall' },
  partition: { ru: 'Перегородка', en: 'Partition' },
  parapet: { ru: 'Парапет', en: 'Parapet' },
  glazing: { ru: 'Остекление', en: 'Glazing' },
  virtual: { ru: 'Граница', en: 'Separator' },
}

export const OPENING_KIND_NAMES: Record<OpeningKind, { ru: string; en: string }> = {
  door: { ru: 'Дверь', en: 'Door' },
  doubleDoor: { ru: 'Двустворчатая дверь', en: 'Double door' },
  slidingDoor: { ru: 'Раздвижная дверь', en: 'Sliding door' },
  entranceDoor: { ru: 'Входная дверь', en: 'Entrance door' },
  arch: { ru: 'Арка', en: 'Arch' },
  opening: { ru: 'Проём', en: 'Opening' },
  window: { ru: 'Окно', en: 'Window' },
  frenchWindow: { ru: 'Французское окно', en: 'French window' },
  balconyDoor: { ru: 'Балконная дверь', en: 'Balcony door' },
  balconyBlock: { ru: 'Балконный блок', en: 'Balcony block' },
}

const WINDOW_KINDS: readonly OpeningKind[] = ['window', 'frenchWindow', 'balconyBlock']
const PASSAGE_KINDS: readonly OpeningKind[] = ['arch', 'opening']

const LIGHT_KIND_NAMES: Record<LightKind, { ru: string; en: string }> = {
  ceiling: { ru: 'Потолочный светильник', en: 'Ceiling light' },
  spot: { ru: 'Спот', en: 'Spot' },
  pendant: { ru: 'Подвесной светильник', en: 'Pendant' },
  point: { ru: 'Точечный свет', en: 'Point light' },
  strip: { ru: 'Светодиодная лента', en: 'LED strip' },
  area: { ru: 'Световая панель', en: 'Light panel' },
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

function badge(n: number): string {
  return n >= 1 && n <= 20 ? [...CIRCLED][n - 1] : `(${n})`
}

/** «3,25 м» / «3.25 m» */
function metres(mm: number, lang: LayerLang): string {
  const v = (mm / 1000).toFixed(2)
  return lang === 'ru' ? `${v.replace('.', ',')} м` : `${v} m`
}

function userName(o: { name?: unknown }): string | undefined {
  return typeof o.name === 'string' && o.name.trim() ? o.name : undefined
}

/** default rename: sets `name`, '' removes it */
function setName(o: LayerFlags, name: string): void {
  const v = name.trim()
  if (v) o.name = v
  else delete o.name
}

function setFlag(target: object, key: 'hidden' | 'locked', v: boolean): void {
  const o = target as { hidden?: boolean; locked?: boolean }
  if (v) o[key] = true
  else delete o[key]
}

function wallLen(doc: Doc, w: Wall): number {
  const a = doc.nodes[w.a]
  const b = doc.nodes[w.b]
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0
}

registerEntityKind<Wall>({
  kind: 'wall',
  docKey: 'walls',
  title: { ru: 'Стены', en: 'Walls' },
  icon: 'brick-wall',
  order: 10,
  level: (w) => w.levelId,
  name: (w, env) => userName(w) ?? `${WALL_KIND_NAMES[w.kind]?.[env.lang] ?? WALL_KIND_NAMES.wall[env.lang]} ${metres(wallLen(env.doc, w), env.lang)}`,
  rename: setName,
  subtype: (w, env) => WALL_KIND_NAMES[w.kind]?.[env.lang],
})

registerEntityKind<Room>({
  kind: 'room',
  docKey: 'rooms',
  title: { ru: 'Помещения', en: 'Rooms' },
  icon: 'square-dashed',
  order: 20,
  level: (r) => r.levelId,
  name: (r, env) => userName(r) ?? ROOM_TYPE_NAMES[r.type]?.[env.lang] ?? r.type,
  // a room always has a name: an empty one goes back to the type name
  rename: (r, name) => {
    r.name = name.trim() || ROOM_TYPE_NAMES[r.type]?.ru || r.name
  },
  subtype: (r, env) => ROOM_TYPE_NAMES[r.type]?.[env.lang],
})

registerEntityKind<Opening>({
  kind: 'opening',
  docKey: 'openings',
  title: { ru: 'Проёмы', en: 'Openings' },
  icon: 'door-open',
  order: 30,
  level: (o, doc) => doc.walls[o.wallId]?.levelId,
  name: (o, env) => userName(o) ?? `${OPENING_KIND_NAMES[o.kind]?.[env.lang] ?? o.kind} ${Math.round(o.width)}`,
  rename: setName,
  subtype: (o, env) =>
    WINDOW_KINDS.includes(o.kind)
      ? env.lang === 'ru'
        ? 'Окно'
        : 'Window'
      : PASSAGE_KINDS.includes(o.kind)
        ? env.lang === 'ru'
          ? 'Проём'
          : 'Opening'
        : env.lang === 'ru'
          ? 'Дверь'
          : 'Door',
  parent: (o) => ({ kind: 'wall', id: o.wallId }),
})

registerEntityKind<Item>({
  kind: 'item',
  docKey: 'items',
  title: { ru: 'Мебель и сантехника', en: 'Furniture & fixtures' },
  icon: 'sofa',
  order: 40,
  level: (i) => i.levelId,
  name: (i, env) => userName(i) ?? env.assetName?.(i.assetId) ?? i.assetId,
  rename: setName,
})

registerEntityKind<Light>({
  kind: 'light',
  docKey: 'lights',
  title: { ru: 'Светильники', en: 'Lights' },
  icon: 'lightbulb',
  order: 50,
  level: (l) => l.levelId,
  name: (l, env) => userName(l) ?? LIGHT_KIND_NAMES[l.kind]?.[env.lang] ?? l.kind,
  rename: setName,
  subtype: (l, env) => LIGHT_KIND_NAMES[l.kind]?.[env.lang],
})

registerEntityKind<Underlay>({
  kind: 'underlay',
  docKey: 'underlays',
  title: { ru: 'Подложки', en: 'Underlays' },
  icon: 'image',
  order: 60,
  level: (u) => u.levelId,
  name: (u, env) => userName(u) ?? (env.lang === 'ru' ? 'Подложка' : 'Underlay'),
  rename: setName,
  isOwnHidden: (u) => !u.visible,
  setOwnHidden: (u, v) => {
    u.visible = !v
  },
  isOwnLocked: (u) => u.locked,
  setOwnLocked: (u, v) => {
    u.locked = v
  },
})

registerEntityKind<Annotation>({
  kind: 'annotation',
  docKey: 'annotations',
  title: { ru: 'Пометки', en: 'Marks' },
  icon: 'pencil',
  order: 70,
  level: (a) => a.levelId,
  name: (a, env) => userName(a) ?? `${env.lang === 'ru' ? 'Пометка' : 'Mark'} ${badge(a.n)}`,
  rename: setName,
  customSelection: true,
})

registerEntityKind<Dimension>({
  kind: 'dimension',
  docKey: 'dimensions',
  title: { ru: 'Размеры', en: 'Dimensions' },
  icon: 'ruler',
  order: 80,
  level: (d) => d.levelId,
  name: (d, env) => userName(d) ?? `${env.lang === 'ru' ? 'Размер' : 'Dimension'} ${Math.round(Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y))}`,
  rename: setName,
})

registerEntityKind<Label>({
  kind: 'label',
  docKey: 'labels',
  title: { ru: 'Надписи', en: 'Labels' },
  icon: 'type',
  order: 90,
  level: (l) => l.levelId,
  name: (l, env) => (l.text.trim() ? l.text : env.lang === 'ru' ? 'Надпись' : 'Label'),
  // the name of a label is its text
  rename: (l, name) => {
    if (name.trim()) l.text = name.trim()
  },
})

// ───────────────────────────── effective state ─────────────────────────────

/** `${kind}:${id}` */
export function refKey(kind: string, id: Id): string {
  return `${kind}:${id}`
}

export interface LayerIndex {
  /** hidden by its own flag, its kind, its layer or its parent */
  hidden(kind: string, id: Id): boolean
  /** locked by its own flag, its kind, its layer or its parent (also: a node of a locked wall) */
  locked(kind: string, id: Id): boolean
  /** can be clicked / marquee-selected on the plan or in 3D: neither hidden nor locked */
  pickable(kind: string, id: Id): boolean
  /** true when nothing in the document is hidden */
  readonly noneHidden: boolean
  /** true when nothing in the document is locked */
  readonly noneLocked: boolean
  /** content signature: equal for documents with the same hidden / locked sets */
  readonly key: string
}

const indexCache = new WeakMap<Doc, LayerIndex>()

/** Effective hidden / locked state of every object (memoised per document object). */
export function layerIndex(doc: Doc): LayerIndex {
  let idx = indexCache.get(doc)
  if (!idx) {
    idx = computeIndex(doc)
    indexCache.set(doc, idx)
  }
  return idx
}

function computeIndex(doc: Doc): LayerIndex {
  const hidden = new Set<string>()
  const locked = new Set<string>()
  const layers = doc.layers ?? {}
  const groups = doc.groupFlags ?? {}
  // state of one object; parents resolve recursively (memo + cycle guard)
  const done = new Map<string, number>() // bit 1 hidden, bit 2 locked
  const visiting = new Set<string>()
  const resolve = (def: EntityKindDef, o: AnyEntity): number => {
    const key = refKey(def.kind, o.id)
    const known = done.get(key)
    if (known !== undefined) return known
    const g: GroupFlags = groups[def.kind] ?? {}
    const layer: UserLayer | undefined = typeof o.layerId === 'string' ? layers[o.layerId] : undefined
    let h = ownHidden(def, o) || g.hidden === true || layer?.hidden === true
    let l = ownLocked(def, o) || g.locked === true || layer?.locked === true
    if ((!h || !l) && def.parent && !visiting.has(key)) {
      const p = def.parent(o, doc)
      const pdef = p && registry.get(p.kind)
      const po = pdef && kindTable(doc, pdef)?.[p.id]
      if (pdef && po) {
        visiting.add(key)
        const ps = resolve(pdef, po)
        visiting.delete(key)
        h ||= (ps & 1) !== 0
        l ||= (ps & 2) !== 0
      }
    }
    const s = (h ? 1 : 0) | (l ? 2 : 0)
    done.set(key, s)
    if (h) hidden.add(key)
    if (l) locked.add(key)
    return s
  }
  for (const def of entityKinds()) {
    const table = kindTable(doc, def)
    if (!table) continue
    for (const id in table) resolve(def, table[id])
  }
  // nodes belong to walls: hidden when every wall at the node is hidden, locked when any of them is locked
  const nodeWalls = new Map<Id, { all: number; hidden: number; locked: boolean }>()
  for (const id in doc.walls) {
    const w = doc.walls[id]
    const k = refKey('wall', id)
    const wh = hidden.has(k)
    const wl = locked.has(k)
    for (const n of [w.a, w.b]) {
      let s = nodeWalls.get(n)
      if (!s) nodeWalls.set(n, (s = { all: 0, hidden: 0, locked: false }))
      s.all++
      if (wh) s.hidden++
      if (wl) s.locked = true
    }
  }
  for (const [n, s] of nodeWalls) {
    if (s.all > 0 && s.hidden === s.all) hidden.add(refKey('node', n))
    if (s.locked) locked.add(refKey('node', n))
  }
  const key = `${[...hidden].join(',')}|${[...locked].join(',')}`
  return {
    hidden: (kind, id) => hidden.has(refKey(kind, id)),
    locked: (kind, id) => locked.has(refKey(kind, id)),
    pickable: (kind, id) => !hidden.has(refKey(kind, id)) && !locked.has(refKey(kind, id)),
    noneHidden: hidden.size === 0,
    noneLocked: locked.size === 0,
    key,
  }
}

export function isHidden(doc: Doc, ref: { kind: string; id: Id }): boolean {
  return layerIndex(doc).hidden(ref.kind, ref.id)
}

export function isLocked(doc: Doc, ref: { kind: string; id: Id }): boolean {
  return layerIndex(doc).locked(ref.kind, ref.id)
}

/** refs that may be picked / deleted (neither hidden nor locked) */
export function pickableRefs<R extends { kind: string; id: Id }>(doc: Doc, refs: readonly R[]): R[] {
  const idx = layerIndex(doc)
  if (idx.noneHidden && idx.noneLocked) return [...refs]
  return refs.filter((r) => idx.pickable(r.kind, r.id))
}

/** refs that are not locked (delete / move protection) */
export function unlockedRefs<R extends { kind: string; id: Id }>(doc: Doc, refs: readonly R[]): R[] {
  const idx = layerIndex(doc)
  if (idx.noneLocked) return [...refs]
  return refs.filter((r) => !idx.locked(r.kind, r.id))
}

// ───────────────────────────── visible view ─────────────────────────────

/** filtered copies of tables, reused while the source table and its hidden ids stay the same */
const tableCache = new WeakMap<object, { key: string; out: Record<Id, AnyEntity> }>()
const viewCache = new WeakMap<Doc, Doc>()

/**
 * The document as drawings see it: every registered kind's table without its hidden objects.
 * Unchanged tables keep their identity (and so does the result when nothing is hidden), filtered
 * tables are reused across documents while the hidden set of that table is the same — so
 * `view.walls !== prev.walls` dirty checks keep working.
 * Use it ONLY for drawing (2D layers, 3D scene, exports); edits go to the real document.
 */
export function visibleDoc(doc: Doc): Doc {
  const idx = layerIndex(doc)
  if (idx.noneHidden) return doc
  const cached = viewCache.get(doc)
  if (cached) return cached
  const out: Record<string, unknown> = { ...doc }
  for (const def of entityKinds()) {
    const table = kindTable(doc, def)
    if (!table) continue
    const ids: Id[] = []
    for (const id in table) if (idx.hidden(def.kind, id)) ids.push(id)
    if (!ids.length) continue
    const key = ids.join(',')
    const prev = tableCache.get(table)
    if (prev && prev.key === key) {
      out[def.docKey] = prev.out
      continue
    }
    const filtered: Record<Id, AnyEntity> = {}
    for (const id in table) if (!idx.hidden(def.kind, id)) filtered[id] = table[id]
    tableCache.set(table, { key, out: filtered })
    out[def.docKey] = filtered
  }
  const view = out as unknown as Doc
  viewCache.set(doc, view)
  return view
}

const planCache = new WeakMap<DerivedPlan, { key: string; out: DerivedPlan }>()

/**
 * The derived plan as drawings see it: without hidden walls' outlines and hidden rooms.
 * Room detection itself always runs on the full document (hiding a wall never merges rooms).
 */
export function visiblePlan(doc: Doc, plan: DerivedPlan): DerivedPlan {
  const idx = layerIndex(doc)
  if (idx.noneHidden) return plan
  const walls: Id[] = []
  for (const id in plan.wallGeoms) if (idx.hidden('wall', id)) walls.push(id)
  const rooms: Id[] = []
  for (const r of plan.rooms) if (idx.hidden('room', r.roomId)) rooms.push(r.roomId)
  if (!walls.length && !rooms.length) return plan
  const key = `${walls.join(',')}|${rooms.join(',')}`
  const prev = planCache.get(plan)
  if (prev && prev.key === key) return prev.out
  const hw = new Set(walls)
  const hr = new Set(rooms)
  const wallGeoms: DerivedPlan['wallGeoms'] = {}
  for (const id in plan.wallGeoms) if (!hw.has(id)) wallGeoms[id] = plan.wallGeoms[id]
  const out: DerivedPlan = {
    ...plan,
    wallGeoms: walls.length ? wallGeoms : plan.wallGeoms,
    rooms: rooms.length ? plan.rooms.filter((r) => !hr.has(r.roomId)) : plan.rooms,
  }
  planCache.set(plan, { key, out })
  return out
}

// ───────────────────────────── edits (call on an Immer draft) ─────────────────────────────

/** sets the own hidden flag of the objects */
export function setHidden(doc: Doc, refs: readonly { kind: string; id: Id }[], hidden: boolean): void {
  for (const r of refs) {
    const def = registry.get(r.kind)
    const o = def && kindTable(doc, def)?.[r.id]
    if (!def || !o) continue
    if (def.setOwnHidden) def.setOwnHidden(o, hidden)
    else setFlag(o, 'hidden', hidden)
  }
}

/** sets the own locked flag of the objects */
export function setLocked(doc: Doc, refs: readonly { kind: string; id: Id }[], locked: boolean): void {
  for (const r of refs) {
    const def = registry.get(r.kind)
    const o = def && kindTable(doc, def)?.[r.id]
    if (!def || !o) continue
    if (def.setOwnLocked) def.setOwnLocked(o, locked)
    else setFlag(o, 'locked', locked)
  }
}

export function isOwnHidden(doc: Doc, ref: { kind: string; id: Id }): boolean {
  const def = registry.get(ref.kind)
  const o = def && kindTable(doc, def)?.[ref.id]
  return !!def && !!o && ownHidden(def, o)
}

export function isOwnLocked(doc: Doc, ref: { kind: string; id: Id }): boolean {
  const def = registry.get(ref.kind)
  const o = def && kindTable(doc, def)?.[ref.id]
  return !!def && !!o && ownLocked(def, o)
}

/** hides / locks (or shows / unlocks) a whole kind */
export function setGroupFlag(doc: Doc, kind: string, flag: keyof GroupFlags, value: boolean): void {
  const all = (doc.groupFlags ??= {})
  const g = { ...(all[kind] ?? {}) }
  if (value) g[flag] = true
  else delete g[flag]
  if (Object.keys(g).length) all[kind] = g
  else delete all[kind]
  if (!Object.keys(all).length) delete doc.groupFlags
}

/** renames an object; '' resets a generated name. Returns false when the kind is not renamable */
export function renameEntity(doc: Doc, ref: { kind: string; id: Id }, name: string): boolean {
  const def = registry.get(ref.kind)
  const o = def && kindTable(doc, def)?.[ref.id]
  if (!def?.rename || !o) return false
  def.rename(o, name)
  return true
}

/** next free «Слой N» name */
export function nextLayerName(doc: Doc, lang: LayerLang = 'ru'): string {
  const base = lang === 'ru' ? 'Слой' : 'Layer'
  const names = new Set(Object.values(doc.layers ?? {}).map((l) => l.name))
  for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}

/** creates a user layer at the end of the list; returns its id */
export function addLayer(doc: Doc, name?: string): Id {
  const id = newId('ly')
  const layers = (doc.layers ??= {})
  layers[id] = { id, name: name?.trim() || nextLayerName(doc) }
  ;(doc.layerOrder ??= []).push(id)
  return id
}

export function renameLayer(doc: Doc, layerId: Id, name: string): void {
  const l = doc.layers?.[layerId]
  if (l && name.trim()) l.name = name.trim()
}

export function setLayerFlag(doc: Doc, layerId: Id, flag: 'hidden' | 'locked', value: boolean): void {
  const l = doc.layers?.[layerId]
  if (l) setFlag(l, flag, value)
}

/** moves a layer to `index` in the panel order */
export function moveLayer(doc: Doc, layerId: Id, index: number): void {
  const order = orderedLayers(doc).map((l) => l.id)
  const from = order.indexOf(layerId)
  if (from < 0) return
  order.splice(from, 1)
  order.splice(Math.max(0, Math.min(order.length, index)), 0, layerId)
  doc.layerOrder = order
}

/** deletes a layer; its objects stay in the document without a layer */
export function deleteLayer(doc: Doc, layerId: Id): void {
  if (!doc.layers?.[layerId]) return
  for (const def of entityKinds()) {
    for (const table of kindTables(doc, def)) {
      for (const id in table) if (table[id].layerId === layerId) delete table[id].layerId
    }
  }
  delete doc.layers[layerId]
  if (doc.layerOrder) doc.layerOrder = doc.layerOrder.filter((id) => id !== layerId)
  if (!Object.keys(doc.layers).length) {
    delete doc.layers
    delete doc.layerOrder
  }
}

/** puts the objects on a layer (`null` = no layer) */
export function assignLayer(doc: Doc, refs: readonly { kind: string; id: Id }[], layerId: Id | null): void {
  if (layerId !== null && !doc.layers?.[layerId]) return
  for (const r of refs) {
    const def = registry.get(r.kind)
    const o = def && kindTable(doc, def)?.[r.id]
    if (!o) continue
    if (layerId) o.layerId = layerId
    else delete o.layerId
  }
}

/** user layers in panel order (layers missing from `layerOrder` go last) */
export function orderedLayers(doc: Doc): UserLayer[] {
  const layers = doc.layers ?? {}
  const out: UserLayer[] = []
  const seen = new Set<Id>()
  for (const id of doc.layerOrder ?? []) {
    if (layers[id] && !seen.has(id)) {
      out.push(layers[id])
      seen.add(id)
    }
  }
  for (const id in layers) if (!seen.has(id)) out.push(layers[id])
  return out
}

// ───────────────────────────── outline (panel model) ─────────────────────────────

export interface OutlineRow {
  ref: EntityRef
  name: string
  subtype?: string
  /** the object's own flags */
  ownHidden: boolean
  ownLocked: boolean
  /** effective state (own ∨ group ∨ layer ∨ parent) */
  hidden: boolean
  locked: boolean
  layerId?: Id
  /** the kind can be renamed */
  renamable: boolean
}

export interface OutlineGroup {
  kind: string
  title: string
  icon: string
  hidden: boolean
  locked: boolean
  rows: OutlineRow[]
}

export interface OutlineLayer {
  /** null = objects without a layer */
  layer: UserLayer | null
  rows: OutlineRow[]
}

function rowsOf(doc: Doc, def: EntityKindDef, levelId: Id, env: KindNameEnv, idx: LayerIndex): OutlineRow[] {
  const table = kindTable(doc, def)
  if (!table) return []
  const rows: OutlineRow[] = []
  for (const id in table) {
    const o = table[id]
    if (def.level(o, doc) !== levelId) continue
    const row: OutlineRow = {
      // EntityKind is a closed union in types.ts; registered kinds extend it at runtime
      ref: { kind: def.kind as EntityRef['kind'], id },
      name: def.name(o, env),
      ownHidden: ownHidden(def, o),
      ownLocked: ownLocked(def, o),
      hidden: idx.hidden(def.kind, id),
      locked: idx.locked(def.kind, id),
      renamable: !!def.rename,
    }
    const sub = def.subtype?.(o, env)
    if (sub) row.subtype = sub
    if (typeof o.layerId === 'string' && doc.layers?.[o.layerId]) row.layerId = o.layerId
    rows.push(row)
  }
  return rows
}

/** objects of one level grouped by kind (every listed kind, also empty ones) */
export function buildOutline(doc: Doc, levelId: Id, env: Omit<KindNameEnv, 'doc'>): OutlineGroup[] {
  const idx = layerIndex(doc)
  const full: KindNameEnv = { ...env, doc }
  const groups = doc.groupFlags ?? {}
  return entityKinds()
    .filter((def) => def.listed !== false)
    .map((def) => ({
      kind: def.kind,
      title: def.title[env.lang],
      icon: def.icon,
      hidden: groups[def.kind]?.hidden === true,
      locked: groups[def.kind]?.locked === true,
      rows: rowsOf(doc, def, levelId, full, idx),
    }))
}

/** objects of one level grouped by user layer: «no layer» first, then the layers in panel order */
export function buildLayerOutline(doc: Doc, levelId: Id, env: Omit<KindNameEnv, 'doc'>): OutlineLayer[] {
  const rows = buildOutline(doc, levelId, env).flatMap((g) => g.rows)
  const by = new Map<Id | null, OutlineRow[]>()
  for (const r of rows) {
    const k = r.layerId ?? null
    const list = by.get(k)
    if (list) list.push(r)
    else by.set(k, [r])
  }
  return [{ layer: null, rows: by.get(null) ?? [] }, ...orderedLayers(doc).map((layer) => ({ layer, rows: by.get(layer.id) ?? [] }))]
}

/** case-insensitive match of a row against a search text (name, type, kind title) */
export function outlineMatches(row: OutlineRow, groupTitle: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${row.name}\n${row.subtype ?? ''}\n${groupTitle}`.toLowerCase().includes(q)
}
