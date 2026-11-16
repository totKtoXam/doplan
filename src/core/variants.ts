/**
 * Furnishing variants: several furniture / lighting / finish layouts over one shared apartment.
 *
 * Model (see the "Furnishing variants" block in types.ts for what lives in a variant):
 *  - the ACTIVE variant's content lives in the document itself — `doc.items`, `doc.lights`, the
 *    finish fields of rooms / walls / openings, `doc.design.styleId` — so the 2D editor, 3D view,
 *    estimate, exports, AI chat and CLI work on it unchanged;
 *  - every inactive variant keeps its content in `doc.variants.list[id].stash`;
 *  - switching swaps the live content with the stash (one undoable edit).
 * A document without `variants` has one implicit variant.
 *
 * All mutators work on an Immer draft or on a plain object, and replace records instead of
 * mutating nested values, so `materializeVariant` can run them on a shallow copy.
 */
import { findAsset } from './catalog'
import { pointInPolygon, projectOnSegment } from './geom'
import { newId } from './ids'
import { usesLayers } from './layers'
import {
  DOC_VERSION,
  DOC_VERSION_V3,
  DOC_VERSION_VARIANTS,
  VARIANT_COLLECTIONS,
  VARIANT_OPENING_FIELDS,
  VARIANT_ROOM_FIELDS,
  VARIANT_WALL_FIELDS,
  type Catalog,
  type DerivedPlan,
  type Doc,
  type DocVariants,
  type EntityRef,
  type Id,
  type Item,
  type Light,
  type VariantCollection,
  type VariantFinishes,
  type VariantRecord,
  type VariantStash,
  type Vec2,
} from './types'

/** name of the implicit variant of a document that has never had variants */
export const FIRST_VARIANT_NAME = 'Вариант 1'
/** id of the implicit variant; kept when it is materialised, so it stays the same id */
export const IMPLICIT_VARIANT_ID = 'v_main'

/** finish fields per shared collection */
const FINISH_FIELDS = {
  rooms: VARIANT_ROOM_FIELDS,
  walls: VARIANT_WALL_FIELDS,
  openings: VARIANT_OPENING_FIELDS,
} as const
type FinishCollection = keyof typeof FINISH_FIELDS
const FINISH_COLLECTIONS = Object.keys(FINISH_FIELDS) as FinishCollection[]

type AnyRecord = Record<string, unknown>
type Coll = Record<Id, AnyRecord>

/** JSON-deep copy (works on Immer drafts too); the document is JSON data by contract */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function collOf(doc: Doc, key: string): Coll | undefined {
  return (doc as unknown as Record<string, Coll | undefined>)[key]
}

// ───────────────────────────── what is shared ─────────────────────────────

/**
 * Items that are part of the apartment itself, not of a furnishing: columns, stairs, boxing,
 * podiums (catalogue category `structure`). They are shown in every variant.
 */
export function isApartmentItem(doc: Doc, item: Item, catalog?: Catalog | null): boolean {
  return findAsset(doc, catalog, item.assetId)?.category === 'structure'
}

/** does an inactive variant hold an entity with this id? */
function heldByStash(doc: Doc, key: VariantCollection, id: Id): boolean {
  const v = doc.variants
  if (!v) return false
  for (const vid of v.order) {
    if (vid === v.activeId) continue
    const c = (v.list[vid]?.stash?.collections as Record<string, Coll | undefined> | undefined)?.[key]
    if (c?.[id]) return true
  }
  return false
}

/**
 * Does this entity of a variant collection belong to the variant (not to the shared apartment)?
 * Apartment items are shared, unless some variant holds its own piece under the same id: then the
 * id is per variant (a column replaced by furniture in one variant, or the reverse).
 */
function ownedByVariant(doc: Doc, key: VariantCollection, entity: AnyRecord, catalog?: Catalog | null): boolean {
  if (key === 'items') return !isApartmentItem(doc, entity as unknown as Item, catalog) || heldByStash(doc, key, entity.id as Id)
  return true
}

/**
 * Call before an item's model is replaced in the active variant. A shared apartment item (column,
 * boxing, podium) that becomes furniture changes in this variant only: every other variant keeps
 * its own copy of the item as it is now.
 */
export function beforeItemAssetChange(doc: Doc, itemId: Id, nextCategory: string | undefined, catalog?: Catalog | null): void {
  const v = doc.variants
  const it = doc.items[itemId]
  if (!v || !it || v.order.length < 2 || nextCategory === 'structure') return
  if (ownedByVariant(doc, 'items', it as unknown as AnyRecord, catalog)) return
  for (const vid of v.order) {
    const rec = v.list[vid]
    if (vid === v.activeId || !rec) continue
    const stash = rec.stash ?? { collections: {}, finishes: { rooms: {}, walls: {}, openings: {} } }
    const items = { ...(stash.collections.items ?? {}), [itemId]: clone(it) }
    v.list[vid] = { ...rec, stash: { ...stash, collections: { ...stash.collections, items } } }
  }
}

// ───────────────────────────── queries ─────────────────────────────

export interface VariantInfo {
  id: Id
  name: string
  active: boolean
}

/** the variants in display order (one implicit variant for a document without any) */
export function listVariants(doc: Doc): VariantInfo[] {
  const v = doc.variants
  if (!v) return [{ id: IMPLICIT_VARIANT_ID, name: FIRST_VARIANT_NAME, active: true }]
  return v.order.filter((id) => v.list[id]).map((id) => ({ id, name: v.list[id].name, active: id === v.activeId }))
}

export function activeVariantId(doc: Doc): Id {
  return doc.variants?.activeId ?? IMPLICIT_VARIANT_ID
}

export function activeVariantName(doc: Doc): string {
  const v = doc.variants
  return (v && v.list[v.activeId]?.name) || FIRST_VARIANT_NAME
}

export function variantCount(doc: Doc): number {
  return doc.variants ? doc.variants.order.length : 1
}

/** electrical points are new to formats 1–2: a 0.12 app would drop them on its next save */
function hasElectrical(doc: Doc): boolean {
  return !!doc.electrical && Object.keys(doc.electrical).length > 0
}

/**
 * file format version the document must be written with: the lowest one whose readers keep all its
 * data (format 3 for layers-panel data, see `usesLayers`, and for electrical points; format 2 for
 * several variants)
 */
export function docFormatVersion(doc: Doc): number {
  // layers-panel data or electrical points: format 3 (0.12.0 opens format 2 and would drop them on save)
  if (usesLayers(doc) || hasElectrical(doc)) return DOC_VERSION_V3
  return variantCount(doc) > 1 ? DOC_VERSION_VARIANTS : DOC_VERSION
}

/** a free "Вариант N" name */
export function nextVariantName(doc: Doc, base = 'Вариант'): string {
  const names = new Set(listVariants(doc).map((v) => v.name))
  for (let n = variantCount(doc) + 1; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`
}

/** variant-owned entities of a collection, as they are in the given variant (no copy) */
export function variantCollection<K extends VariantCollection>(doc: Doc, variantId: Id, key: K, catalog?: Catalog | null): NonNullable<Doc[K]> {
  if (variantId === activeVariantId(doc)) {
    const live = collOf(doc, key) ?? {}
    const out: Coll = {}
    for (const id in live) if (ownedByVariant(doc, key, live[id], catalog)) out[id] = live[id]
    return out as unknown as NonNullable<Doc[K]>
  }
  return (doc.variants?.list[variantId]?.stash?.collections[key] ?? {}) as NonNullable<Doc[K]>
}

// ───────────────────────────── capture / apply ─────────────────────────────

/** deep copy of the live (active) variant content */
export function captureVariant(doc: Doc, catalog?: Catalog | null): VariantStash {
  const collections: VariantStash['collections'] = {}
  for (const key of VARIANT_COLLECTIONS) {
    const live = collOf(doc, key)
    if (!live) continue
    const out: Coll = {}
    for (const id in live) if (ownedByVariant(doc, key, live[id], catalog)) out[id] = live[id]
    ;(collections as Record<string, Coll>)[key] = clone(out)
  }
  const finishes: VariantFinishes = { rooms: {}, walls: {}, openings: {} }
  for (const coll of FINISH_COLLECTIONS) {
    const src = collOf(doc, coll) ?? {}
    const dst = finishes[coll] as Record<Id, AnyRecord>
    for (const id in src) dst[id] = finishOf(coll, src[id])
  }
  const stash: VariantStash = { collections, finishes }
  if (doc.design?.styleId) stash.styleId = doc.design.styleId
  return stash
}

/** replaces the live variant content with `stash` (shared entities stay) */
function applyVariant(doc: Doc, stash: VariantStash, catalog?: Catalog | null): void {
  const d = doc as unknown as Record<string, Coll | undefined>
  for (const key of VARIANT_COLLECTIONS) {
    const live = d[key]
    const incoming = (stash.collections as Record<string, Coll | undefined>)[key] ?? {}
    if (!live) {
      if (Object.keys(incoming).length) d[key] = clone(incoming)
      continue
    }
    for (const id of Object.keys(live)) if (ownedByVariant(doc, key, live[id], catalog)) delete live[id]
    for (const id in incoming) {
      if (!live[id]) {
        live[id] = clone(incoming[id])
        continue
      }
      // the id is taken by a shared record (e.g. its model became a structure asset in another
      // variant): keep this variant's piece under a fresh id instead of dropping it
      const nid = newId(key === 'items' ? 'i' : 'l')
      live[nid] = { ...clone(incoming[id]), id: nid }
    }
  }
  for (const coll of FINISH_COLLECTIONS) {
    const live = d[coll]
    if (!live) continue
    const over = stash.finishes[coll] as Record<Id, AnyRecord>
    for (const id in over) {
      const rec = live[id]
      if (!rec) continue
      let same = true
      for (const field of FINISH_FIELDS[coll]) if (JSON.stringify(rec[field]) !== JSON.stringify(over[id][field])) same = false
      if (same) continue
      const next: AnyRecord = { ...rec }
      for (const field of FINISH_FIELDS[coll]) {
        if (over[id][field] !== undefined) next[field] = clone(over[id][field])
        else delete next[field]
      }
      live[id] = next
    }
  }
  if (stash.styleId) doc.design = { ...doc.design, styleId: stash.styleId }
  else if (doc.design?.styleId !== undefined) {
    const rest = { ...doc.design }
    delete rest.styleId
    doc.design = rest
  }
}

// ───────────────────────────── mutators ─────────────────────────────

/** materialises the implicit variant (no-op when the document already has variants) */
export function ensureVariants(doc: Doc): DocVariants {
  if (!doc.variants) {
    const id = IMPLICIT_VARIANT_ID
    doc.variants = { activeId: id, order: [id], list: { [id]: { id, name: FIRST_VARIANT_NAME } } }
  }
  return doc.variants
}

/** keeps `doc.version` equal to `docFormatVersion` (the store calls it after every edit) */
export function syncFormatVersion(doc: Doc): void {
  const v = docFormatVersion(doc)
  if (doc.version !== v) doc.version = v
}

export interface CreateVariantOptions {
  name?: string
  /** `copy`: a copy of the active variant; `empty`: no furniture and lights, finishes as in the active one */
  from: 'copy' | 'empty'
  /** make it the active variant (default true) */
  activate?: boolean
  /** with `copy`: the variant to copy (default: the active one); the new one is placed after it */
  source?: Id
}

/** adds a variant (after the active one); returns its id */
export function createVariant(doc: Doc, opts: CreateVariantOptions, catalog?: Catalog | null): Id {
  const v = ensureVariants(doc)
  const id = newId('v')
  const name = opts.name?.trim() || nextVariantName(doc)
  const src = opts.source && opts.source !== v.activeId ? v.list[opts.source]?.stash : undefined
  const stash = src ? clone(src) : captureVariant(doc, catalog)
  if (opts.from === 'empty') {
    // apartment items held per variant (see ownedByVariant) stay; furniture and lights go
    const items: Coll = {}
    for (const [iid, it] of Object.entries(stash.collections.items ?? {})) if (isApartmentItem(doc, it, catalog)) items[iid] = it as unknown as AnyRecord
    stash.collections = Object.keys(items).length ? { items: items as unknown as NonNullable<Doc['items']> } : {}
  }
  const rec: VariantRecord = { id, name, stash }
  v.list[id] = rec
  const at = v.order.indexOf(src && opts.source ? opts.source : v.activeId)
  v.order.splice(at < 0 ? v.order.length : at + 1, 0, id)
  syncFormatVersion(doc)
  if (opts.activate !== false) switchVariant(doc, id, catalog)
  return id
}

/** makes `id` the active variant; false when there is no such variant or it is already active */
export function switchVariant(doc: Doc, id: Id, catalog?: Catalog | null): boolean {
  const v = doc.variants
  if (!v || id === v.activeId) return false
  const target = v.list[id]
  if (!target) return false
  const prevId = v.activeId
  const outgoing = captureVariant(doc, catalog)
  const incoming = target.stash ?? { collections: {}, finishes: { rooms: {}, walls: {}, openings: {} } }
  applyVariant(doc, incoming, catalog)
  const prev = v.list[prevId]
  if (prev) v.list[prevId] = { ...prev, stash: outgoing }
  v.list[id] = { id: target.id, name: target.name }
  v.activeId = id
  return true
}

export function renameVariant(doc: Doc, id: Id, name: string): boolean {
  const n = name.trim()
  if (!n) return false
  if (!doc.variants) {
    if (id !== IMPLICIT_VARIANT_ID) return false
    ensureVariants(doc)
  }
  const rec = doc.variants!.list[id]
  if (!rec || rec.name === n) return false
  doc.variants!.list[id] = { ...rec, name: n }
  return true
}

/** removes a variant (the last one cannot be removed); the active one hands over to a neighbour */
export function deleteVariant(doc: Doc, id: Id, catalog?: Catalog | null): boolean {
  const v = doc.variants
  if (!v || !v.list[id] || v.order.length <= 1) return false
  const idx = v.order.indexOf(id)
  if (id === v.activeId) {
    const next = v.order[idx + 1] ?? v.order[idx - 1]
    switchVariant(doc, next, catalog)
  }
  delete v.list[id]
  v.order.splice(v.order.indexOf(id), 1)
  syncFormatVersion(doc)
  return true
}

/** moves a variant one place left (-1) or right (+1) in the display order */
export function moveVariant(doc: Doc, id: Id, dir: -1 | 1): boolean {
  const v = doc.variants
  if (!v) return false
  const i = v.order.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= v.order.length) return false
  ;[v.order[i], v.order[j]] = [v.order[j], v.order[i]]
  return true
}

/**
 * The document as it looks with `id` active (the given document when it already is), without
 * changing it: shallow copies of what a switch touches.
 */
export function materializeVariant(doc: Doc, id: Id, catalog?: Catalog | null): Doc {
  const v = doc.variants
  if (!v || id === v.activeId || !v.list[id]) return doc
  const copy: Doc = {
    ...doc,
    rooms: { ...doc.rooms },
    walls: { ...doc.walls },
    openings: { ...doc.openings },
    variants: { ...v, order: [...v.order], list: { ...v.list } },
  }
  if (doc.design) copy.design = { ...doc.design }
  const c = copy as unknown as Record<string, Coll | undefined>
  for (const key of VARIANT_COLLECTIONS) if (c[key]) c[key] = { ...c[key] }
  switchVariant(copy, id, catalog)
  return copy
}

// ───────────────────────────── upkeep after geometry edits ─────────────────────────────

/** deep copy of the finish fields of a shared record */
function finishOf(coll: FinishCollection, rec: AnyRecord): AnyRecord {
  const f: AnyRecord = {}
  for (const field of FINISH_FIELDS[coll]) if (rec[field] !== undefined) f[field] = clone(rec[field])
  return f
}

/**
 * Keeps inactive variants in step with the shared geometry (runs at the end of every syncRooms):
 *  - drops what they hold for things that no longer exist: finishes of deleted rooms / walls /
 *    openings, items and lights of deleted levels;
 *  - gives every room / wall / opening they have no entry for its current (creation-time) finish,
 *    so a new wall painted later in one variant does not carry that paint into the others.
 *    Entries written earlier in the same edit (wall split, level copy) are kept.
 * Writes only when something is stale or missing.
 */
export function pruneVariants(doc: Doc): void {
  const v = doc.variants
  if (!v) return
  for (const vid of v.order) {
    const stash = v.list[vid]?.stash
    if (!stash) continue
    for (const coll of FINISH_COLLECTIONS) {
      const over = stash.finishes[coll] as Record<Id, unknown> | undefined
      const live = collOf(doc, coll) ?? {}
      if (!over) continue
      for (const id of Object.keys(over)) if (!live[id]) delete over[id]
      for (const id in live) if (!over[id]) over[id] = finishOf(coll, live[id])
    }
    for (const key of VARIANT_COLLECTIONS) {
      const c = (stash.collections as Record<string, Coll | undefined>)[key]
      if (!c) continue
      for (const id of Object.keys(c)) {
        const lv = c[id].levelId
        if (typeof lv === 'string' && !doc.levels[lv]) delete c[id]
      }
    }
  }
  // stale ids from a hand-edited file
  if (v.order.some((id) => !v.list[id])) v.order = v.order.filter((id) => v.list[id])
}

/** a shared record was split / copied (`fromId` → `toId`): the new one gets the same finish in every inactive variant */
export function inheritVariantFinish(doc: Doc, coll: FinishCollection, fromId: Id, toId: Id): void {
  const v = doc.variants
  if (!v) return
  for (const vid of v.order) {
    const over = v.list[vid]?.stash?.finishes[coll] as Record<Id, unknown> | undefined
    if (over?.[fromId]) over[toId] = clone(over[fromId])
  }
}

export interface LevelCopyMaps {
  walls: ReadonlyMap<Id, Id>
  rooms: ReadonlyMap<Id, Id>
  openings: ReadonlyMap<Id, Id>
  /** old → new ids the live copy gave to items / lights; a variant's piece with the same id reuses it */
  items?: ReadonlyMap<Id, Id>
  lights?: ReadonlyMap<Id, Id>
}

/**
 * Copying a level: the inactive variants get their own furniture, lights and finishes of the
 * source level on the new one too (the live variant is copied by the caller).
 */
export function copyLevelInVariants(doc: Doc, srcLevel: Id, dstLevel: Id, maps: LevelCopyMaps, dx = 0, dy = 0): void {
  const v = doc.variants
  if (!v) return
  for (const vid of v.order) {
    const stash = v.list[vid]?.stash
    if (!stash) continue
    for (const key of VARIANT_COLLECTIONS) {
      const c = (stash.collections as Record<string, Coll | undefined>)[key]
      if (!c) continue
      const idMap = (maps as unknown as Record<string, ReadonlyMap<Id, Id> | undefined>)[key]
      for (const e of Object.values(c)) {
        if (e.levelId !== srcLevel) continue
        const reuse = idMap?.get(e.id as Id)
        const id = reuse && !c[reuse] ? reuse : newId(key === 'items' ? 'i' : 'l')
        const copy = clone(e)
        copy.id = id
        copy.levelId = dstLevel
        if (typeof copy.x === 'number') copy.x += dx
        if (typeof copy.y === 'number') copy.y += dy
        delete copy.groupId
        c[id] = copy
      }
    }
    for (const coll of FINISH_COLLECTIONS) {
      const over = stash.finishes[coll] as Record<Id, unknown>
      for (const [from, to] of maps[coll]) if (over[from]) over[to] = clone(over[from])
    }
  }
}

// ───────────────────────────── stray furniture ─────────────────────────────

const STRAY_TOL = 50

function insideSomeRoom(p: Vec2, plan: DerivedPlan): boolean {
  for (const r of plan.rooms) {
    if (r.polygon.length < 3) continue
    if (pointInPolygon(p, r.polygon) && !r.holes.some((h) => h.length >= 3 && pointInPolygon(p, h))) return true
    // on the face line (thin wall-hung items): tolerate a few centimetres
    for (let i = 0; i < r.polygon.length; i++) {
      const a = r.polygon[i]
      const b = r.polygon[(i + 1) % r.polygon.length]
      if (projectOnSegment(p, a, b).dist <= STRAY_TOL) return true
    }
  }
  return false
}

/**
 * Furniture and lights of a variant whose centre is outside every room (after walls were moved,
 * or inside a wall). Levels without detected rooms are not checked.
 */
export function strayEntities(doc: Doc, derived: Record<Id, DerivedPlan>, variantId: Id, catalog?: Catalog | null): EntityRef[] {
  const out: EntityRef[] = []
  const check = (kind: 'item' | 'light', e: Item | Light): void => {
    const plan = derived[e.levelId]
    if (!plan || plan.rooms.length === 0) return
    if (!insideSomeRoom(e, plan)) out.push({ kind, id: e.id })
  }
  for (const it of Object.values(variantCollection(doc, variantId, 'items', catalog))) check('item', it)
  for (const l of Object.values(variantCollection(doc, variantId, 'lights', catalog))) check('light', l)
  return out
}
