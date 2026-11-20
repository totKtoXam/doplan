import { describe, expect, it } from 'vitest'
import { createWebRecent, MAX_DOC_CHARS, setItemMakingRoom, WEB_RECENT_BUDGET, WEB_RECENT_KEY } from './webRecent'

// The web build has no file system: the welcome screen lists the documents kept in this browser.

/** like localStorage: one quota (characters) shared by all keys of the origin */
function sharedStorage(quota = Infinity) {
  const data = new Map<string, string>()
  const used = (except?: string) => [...data].reduce((n, [k, v]) => (k === except ? n : n + k.length + v.length), 0)
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (used(k) + k.length + v.length > quota) throw new Error('QuotaExceededError')
      data.set(k, v)
    },
  }
}

const doc = (id: string, name: string, extra = '') => ({ meta: { id, name }, extra })
const svg = '<svg viewBox="0 0 1 1"/>'

describe('web recent projects', () => {
  it('keeps opened and saved documents newest first, one entry per project', () => {
    let tick = 0
    const r = createWebRecent(sharedStorage(), () => new Date(2026, 0, 1, 0, tick++))
    r.remember(doc('a', 'Квартира'), svg)
    r.remember(doc('b', 'Дача'), null)
    r.remember(doc('a', 'Квартира 2'), undefined)
    const list = r.list()
    expect(list.map((e) => [e.path, e.name, e.exists, e.kind])).toEqual([
      ['web:a', 'Квартира 2', true, 'web'],
      ['web:b', 'Дача', true, 'web'],
    ])
    // a save whose picture could not be drawn keeps the old one
    expect(list[0].thumb).toBe(svg)
    expect(JSON.parse(r.doc('web:a')!).meta.name).toBe('Квартира 2')
  })

  it('drops the picture of a plan that has become empty', () => {
    const r = createWebRecent(sharedStorage())
    r.remember(doc('a', 'A'), svg)
    r.remember(doc('a', 'A'), null)
    expect(r.list()[0].thumb).toBeNull()
  })

  it('does not list a document without a project id (its first save gives it one)', () => {
    const r = createWebRecent(sharedStorage())
    r.remember({ meta: { name: 'Квартира' } }, null)
    r.remember({ meta: { name: 'Квартира' }, other: true } as never, null)
    expect(r.list()).toEqual([])
    r.remember(doc('id1', 'Квартира'), null)
    expect(r.list().map((e) => e.path)).toEqual(['web:id1'])
  })

  it('removes entries', () => {
    const r = createWebRecent(sharedStorage())
    r.remember(doc('a', 'A'), null)
    r.remember(doc('b', 'B'), null)
    r.remove('web:a')
    expect(r.list().map((e) => e.path)).toEqual(['web:b'])
    expect(r.doc('web:a')).toBeNull()
  })

  it('drops the oldest document copies when the storage is full (they stay listed as unavailable)', () => {
    const store = sharedStorage(3000)
    const r = createWebRecent(store)
    r.remember(doc('a', 'A', 'x'.repeat(1200)), null)
    r.remember(doc('b', 'B', 'y'.repeat(1200)), null)
    r.remember(doc('c', 'C', 'z'.repeat(1200)), null)
    const list = r.list()
    expect(list.map((e) => e.path)).toEqual(['web:c', 'web:b', 'web:a'])
    expect(list[0].exists).toBe(true)
    expect(list.some((e) => !e.exists)).toBe(true)
    expect(store.data.get(WEB_RECENT_KEY)!.length).toBeLessThanOrEqual(3000)
  })

  it('stays within its budget, leaving the rest of the storage to recovery and settings', () => {
    const store = sharedStorage(5_000_000)
    const r = createWebRecent(store)
    const big = MAX_DOC_CHARS - 1000
    for (const id of ['a', 'b', 'c', 'd']) r.remember(doc(id, id, 'x'.repeat(big)), null)
    expect(store.data.get(WEB_RECENT_KEY)!.length).toBeLessThanOrEqual(WEB_RECENT_BUDGET)
    // two copies of the largest kept size fit, the older ones are listed without theirs
    expect(r.list().map((e) => e.exists)).toEqual([true, true, false, false])
    // a crash-recovery copy of a large plan still fits next to it
    expect(() => store.setItem('doplan.recovery', 'r'.repeat(1_400_000))).not.toThrow()
  })

  it('gives way to the crash-recovery copy and the settings when the storage is full', () => {
    const store = sharedStorage(3_000_000)
    const r = createWebRecent(store)
    r.remember(doc('a', 'A', 'x'.repeat(900_000)), null)
    r.remember(doc('b', 'B', 'y'.repeat(900_000)), null)
    store.setItem('other', 'o'.repeat(500_000)) // something else of the page
    expect(() => store.setItem('doplan.recovery', 'r'.repeat(1_400_000))).toThrow()
    setItemMakingRoom('doplan.recovery', 'r'.repeat(1_400_000), store, r)
    expect(store.data.get('doplan.recovery')!.length).toBe(1_400_000)
    // the newest copy stays as long as there is room for it
    expect(r.list().map((e) => [e.path, e.exists])).toEqual([
      ['web:b', true],
      ['web:a', false],
    ])
    // with no copies left to drop, a write that cannot fit still fails
    expect(() => setItemMakingRoom('doplan.recovery', 'r'.repeat(3_000_000), store, r)).toThrow()
  })

  it('keeps the copies when the value would not fit even without them (a plan with a huge photo)', () => {
    const store = sharedStorage(3_000_000)
    const r = createWebRecent(store)
    r.remember(doc('a', 'A', 'x'.repeat(900_000)), null)
    r.remember(doc('b', 'B', 'y'.repeat(900_000)), null)
    const listed = store.data.get(WEB_RECENT_KEY)
    let sheds = 0
    const counting = { ...r, shed: () => (sheds++, r.shed()) }
    expect(() => setItemMakingRoom('doplan.recovery', 'r'.repeat(5_000_000), store, counting)).toThrow()
    expect(store.data.get(WEB_RECENT_KEY)).toBe(listed)
    expect(r.list().map((e) => e.exists)).toEqual([true, true])
    // the next autosave of the same plan does not try again
    sheds = 0
    expect(() => setItemMakingRoom('doplan.recovery', 'r'.repeat(5_000_100), store, counting)).toThrow()
    expect(sheds).toBe(0)
    expect(r.list().map((e) => e.exists)).toEqual([true, true])
    // a smaller one that fits once a copy goes still makes room
    setItemMakingRoom('doplan.recovery', 'r'.repeat(1_400_000), store, counting)
    expect(store.data.get('doplan.recovery')!.length).toBe(1_400_000)
    expect(r.list().map((e) => e.exists)).toEqual([true, false])
  })

  it('works without storage and ignores damaged data', () => {
    const none = createWebRecent(null)
    none.remember(doc('a', 'A'), null)
    expect(none.list()).toEqual([])
    const store = sharedStorage()
    store.data.set(WEB_RECENT_KEY, '{oops')
    expect(createWebRecent(store).list()).toEqual([])
  })
})
