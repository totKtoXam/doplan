/**
 * What a visitor has hidden in the viewer, kept in the URL hash so a copied link opens the same
 * picture: `#hide=item:abc,wall:w1&cats=furniture,doors&ceil=0`.
 *  - `hide`  single objects hidden from their cards;
 *  - `cats`  whole categories (furniture, lighting, doors, windows, electrical);
 *  - `ceil`  the ceiling, only when it differs from what the author published.
 * The plan itself never changes: the viewer applies this as a display filter.
 */
import { setGroupFlag, setHidden } from '@core'
import type { Asset, Doc, EntityKind, EntityRef, Id, OpeningKind } from '@core/types'

export const HIDE_CATS = ['furniture', 'lighting', 'doors', 'windows', 'electric'] as const
export type HideCat = (typeof HIDE_CATS)[number]

export const HIDE_CAT_NAMES: Record<HideCat, string> = {
  furniture: 'Мебель',
  lighting: 'Освещение',
  doors: 'Двери и проёмы',
  windows: 'Окна',
  electric: 'Электрика',
}

export interface HideState {
  refs: EntityRef[]
  cats: HideCat[]
  /** the ceiling's visibility chosen by the visitor (absent = the author's) */
  ceiling?: boolean
}

export const EMPTY_HIDE: HideState = { refs: [], cats: [] }

const KINDS: ReadonlySet<string> = new Set<EntityKind>(['item', 'wall', 'opening', 'room', 'light', 'electric'])
const WINDOWS: readonly OpeningKind[] = ['window', 'frenchWindow', 'balconyBlock', 'balconyDoor']

const sameRef = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id

/** an id as the editor makes them; never a name every object has (`__proto__`, `constructor`) */
export const isSafeId = (id: string): boolean => /^[\w-]{1,64}$/.test(id) && !(id in Object.prototype)

/** an entry of a document table by its own key only (an id from a link is not trusted) */
export function own<T>(table: Record<string, T> | undefined, id: string): T | undefined {
  return table && Object.hasOwn(table, id) ? table[id] : undefined
}

export function parseHideHash(hash: string): HideState {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const refs: EntityRef[] = []
  for (const part of (q.get('hide') ?? '').split(',')) {
    const i = part.indexOf(':')
    if (i <= 0) continue
    const kind = part.slice(0, i)
    const id = part.slice(i + 1)
    if (KINDS.has(kind) && isSafeId(id) && !refs.some((r) => r.kind === kind && r.id === id)) refs.push({ kind: kind as EntityKind, id })
  }
  const cats = (q.get('cats') ?? '')
    .split(',')
    .filter((c, i, all): c is HideCat => (HIDE_CATS as readonly string[]).includes(c) && all.indexOf(c) === i)
  const ceil = q.get('ceil')
  return { refs, cats, ...(ceil === '0' || ceil === '1' ? { ceiling: ceil === '1' } : {}) }
}

/** the hash for the state, keeping other parameters a hash may carry; '' when nothing is hidden */
export function hideHash(state: HideState, prev = ''): string {
  const q = new URLSearchParams(prev.replace(/^#/, ''))
  q.delete('hide')
  q.delete('cats')
  q.delete('ceil')
  if (state.refs.length) q.set('hide', state.refs.map((r) => `${r.kind}:${r.id}`).join(','))
  if (state.cats.length) q.set('cats', state.cats.join(','))
  if (state.ceiling !== undefined) q.set('ceil', state.ceiling ? '1' : '0')
  // ids and kinds are plain; keep ':' and ',' readable in the address bar
  const s = q.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',')
  return s ? `#${s}` : ''
}

export function toggleRef(state: HideState, ref: EntityRef, hidden: boolean): HideState {
  const refs = state.refs.filter((r) => !sameRef(r, ref))
  return { ...state, refs: hidden ? [...refs, { kind: ref.kind, id: ref.id }] : refs }
}

export function toggleCat(state: HideState, cat: HideCat, hidden: boolean): HideState {
  const cats = state.cats.filter((c) => c !== cat)
  return { ...state, cats: hidden ? [...cats, cat] : cats }
}

/** the categories an object belongs to (a lamp is furniture and lighting at once: lighting wins) */
export function catOf(ref: EntityRef, doc: Doc, asset: (id: Id) => Pick<Asset, 'category'> | undefined): HideCat | null {
  switch (ref.kind) {
    case 'item': {
      const it = own(doc.items, ref.id)
      if (!it) return null
      return asset(it.assetId)?.category === 'lighting' ? 'lighting' : 'furniture'
    }
    case 'light':
      return 'lighting'
    case 'opening': {
      const o = own(doc.openings, ref.id)
      return o ? (WINDOWS.includes(o.kind) ? 'windows' : 'doors') : null
    }
    case 'electric':
      return 'electric'
    default:
      return null
  }
}

/** every object the state hides (single ones that still exist + the members of hidden categories) */
export function hiddenRefs(state: HideState, doc: Doc, asset: (id: Id) => Pick<Asset, 'category'> | undefined): EntityRef[] {
  const out: EntityRef[] = []
  const tables: [EntityKind, Record<Id, unknown> | undefined][] = [
    ['item', doc.items],
    ['wall', doc.walls],
    ['opening', doc.openings],
    ['room', doc.rooms],
    ['light', doc.lights],
    ['electric', doc.electrical],
  ]
  const cats = new Set(state.cats)
  for (const [kind, table] of tables) {
    for (const id in table ?? {}) {
      const ref = { kind, id }
      const c = cats.size ? catOf(ref, doc, asset) : null
      if ((c && cats.has(c)) || state.refs.some((r) => sameRef(r, ref))) out.push(ref)
    }
  }
  return out
}

/**
 * Sets the objects' own hidden flags to "hidden by the author or by the visitor" (call on a draft).
 * `authorHidden` holds the `kind:id` keys of what the published plan had hidden itself.
 */
export function applyHidden(doc: Doc, hide: readonly EntityRef[], authorHidden: ReadonlySet<string>): void {
  const want = new Set(hide.map((r) => `${r.kind}:${r.id}`))
  const show: EntityRef[] = []
  const hideNow: EntityRef[] = []
  const tables: [EntityKind, Record<Id, { hidden?: boolean }> | undefined][] = [
    ['item', doc.items],
    ['wall', doc.walls],
    ['opening', doc.openings],
    ['room', doc.rooms],
    ['light', doc.lights],
    ['electric', doc.electrical],
  ]
  for (const [kind, table] of tables) {
    for (const id in table ?? {}) {
      const key = `${kind}:${id}`
      const target = want.has(key) || authorHidden.has(key)
      if (target !== (table?.[id]?.hidden === true)) (target ? hideNow : show).push({ kind, id })
    }
  }
  if (show.length) setHidden(doc, show, false)
  if (hideNow.length) setHidden(doc, hideNow, true)
}

/**
 * The viewer lets a visitor click everything that is shown: locks guard edits, and there are none here
 * (call on a draft). Hidden objects stay hidden and unpickable.
 */
export function unlockAll(doc: Doc): void {
  const tables: (Record<Id, { locked?: boolean }> | undefined)[] = [doc.items, doc.walls, doc.openings, doc.rooms, doc.lights, doc.electrical, doc.dimensions, doc.labels]
  for (const table of tables) for (const id in table ?? {}) if (table?.[id]?.locked) delete table[id].locked
  for (const kind in doc.groupFlags ?? {}) {
    const g = doc.groupFlags?.[kind]
    if (g?.locked) setGroupFlag(doc, kind, 'locked', false)
  }
  for (const id in doc.layers ?? {}) {
    const l = doc.layers?.[id]
    if (l?.locked) l.locked = false
  }
}
