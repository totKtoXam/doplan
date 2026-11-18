import { describe, expect, it } from 'vitest'
import { createWebRecent, WEB_RECENT_KEY } from './webRecent'

// The web build has no file system: the welcome screen lists the documents kept in this browser.

function memoryStorage(limit = Infinity) {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new Error('QuotaExceededError')
      data.set(k, v)
    },
  }
}

const doc = (id: string, name: string, extra = '') => ({ meta: { id, name }, extra })
const svg = '<svg viewBox="0 0 1 1"/>'

describe('web recent projects', () => {
  it('keeps opened and saved documents newest first, one entry per project', () => {
    let tick = 0
    const r = createWebRecent(memoryStorage(), () => new Date(2026, 0, 1, 0, tick++))
    r.remember(doc('a', 'Квартира'), svg)
    r.remember(doc('b', 'Дача'), null)
    r.remember(doc('a', 'Квартира 2'), null)
    const list = r.list()
    expect(list.map((e) => [e.path, e.name, e.exists, e.kind])).toEqual([
      ['web:a', 'Квартира 2', true, 'web'],
      ['web:b', 'Дача', true, 'web'],
    ])
    // a save without a new thumbnail keeps the old one
    expect(list[0].thumb).toBe(svg)
    expect(JSON.parse(r.doc('web:a')!).meta.name).toBe('Квартира 2')
  })

  it('removes entries', () => {
    const r = createWebRecent(memoryStorage())
    r.remember(doc('a', 'A'), null)
    r.remember(doc('b', 'B'), null)
    r.remove('web:a')
    expect(r.list().map((e) => e.path)).toEqual(['web:b'])
    expect(r.doc('web:a')).toBeNull()
  })

  it('drops the oldest document copies when the storage is full (they stay listed as unavailable)', () => {
    const store = memoryStorage(3000)
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

  it('works without storage and ignores damaged data', () => {
    const none = createWebRecent(null)
    none.remember(doc('a', 'A'), null)
    expect(none.list()).toEqual([])
    const store = memoryStorage()
    store.data.set(WEB_RECENT_KEY, '{oops')
    expect(createWebRecent(store).list()).toEqual([])
  })
})
