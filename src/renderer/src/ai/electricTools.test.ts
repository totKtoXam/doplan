import { beforeEach, describe, expect, it } from 'vitest'
import { ELECTRIC_KINDS, builtinCatalog, createEmptyDoc, derivePlan } from '@core'
import type { Catalog } from '@core/types'
import { ELECTRIC_KIND_IDS, MUTATING_TOOLS } from '@shared/aiTools'
import { docStore } from '@/store/document'
import './i18n'
import { describeCall, executeTool, type ToolHost } from './tools'

const catalog: Catalog = builtinCatalog()
const st = () => docStore.getState()

const host: ToolHost = {
  doc: () => st().doc,
  derived: (lv) => derivePlan(st().doc, lv),
  activeLevelId: () => Object.keys(st().doc.levels)[0],
  selection: () => [],
  catalog: () => catalog,
  mutate: (label, fn) => st().transact(label, fn),
  snapshot: async () => ({ mime: 'image/png', data: '' }),
}

const points = () => Object.values(st().doc.electrical ?? {})

/** the top wall of a 4000×3000 room at (0, 0): its id */
async function room(): Promise<string> {
  const r = await executeTool(host, 'add_rect_room', { x: 0, y: 0, w: 4000, h: 3000, thickness: 200 })
  expect(r.result.ok, r.result.text).toBe(true)
  const top = Object.values(st().doc.walls).find((w) => {
    const a = st().doc.nodes[w.a]
    const b = st().doc.nodes[w.b]
    return a.y === 0 && b.y === 0
  })
  return top!.id
}

describe('electrical AI tools', () => {
  beforeEach(() => st().load(createEmptyDoc('T'), null))

  it('the shared kind list matches the core catalog', () => {
    expect([...ELECTRIC_KIND_IDS]).toEqual([...ELECTRIC_KINDS])
    expect(MUTATING_TOOLS.has('place_electric')).toBe(true)
    expect(MUTATING_TOOLS.has('set_electric')).toBe(true)
    expect(MUTATING_TOOLS.has('list_electric' as never)).toBe(false)
  })

  it('places a double socket on the room side of a wall, lists it, changes and deletes it', async () => {
    const wallId = await room()
    const put = await executeTool(host, 'place_electric', { kind: 'socketDouble', wallId, offset: 1000, comment: 'под ТВ' })
    expect(put.result.ok, put.result.text).toBe(true)
    expect(points()).toHaveLength(1)
    const p = points()[0]
    // the inner face of the top wall (the room is below it): y = 100, facing down
    expect(p.y).toBeCloseTo(100)
    expect(p.x).toBeCloseTo(1000)
    expect(p.rotation).toBeCloseTo(90)
    expect(p.elevation).toBe(300)
    expect(p.comment).toBe('под ТВ')
    expect(put.result.text).toContain('до углов комнаты')

    const list = await executeTool(host, 'list_electric', { catalog: true })
    expect(list.result.text).toContain(p.id)
    expect(list.result.text).toContain('socketDouble')
    expect(list.result.text).toContain('switch1 —')
    // from the corners of the room (inner faces at x = 100 and x = 3900): 900 and 2900
    expect(list.result.text).toMatch(/слева (900|2900), справа (900|2900)/)

    const set = await executeTool(host, 'set_electric', { electricId: p.id, kind: 'socketUsbAC', offset: 2000, gangs: 2, comment: '' })
    expect(set.result.ok, set.result.text).toBe(true)
    const q = st().doc.electrical![p.id]
    expect(q.kind).toBe('socketUsbAC')
    expect(q.x).toBeCloseTo(2000)
    expect(q.gangs).toBe(2)
    expect(q.comment).toBeUndefined()

    const bad = await executeTool(host, 'set_electric', { electricId: p.id, kind: 'junction', gangs: 3 })
    expect(bad.result.ok).toBe(false)

    const del = await executeTool(host, 'delete', { ids: [p.id] })
    expect(del.result.ok, del.result.text).toBe(true)
    expect(st().doc.electrical).toBeUndefined()

    // every call was one undo step
    st().undo()
    expect(points()).toHaveLength(1)
    st().undo()
    expect(st().doc.electrical![p.id].kind).toBe('socketDouble')
  })

  it('snaps a wall kind to the nearest wall from a point, keeps a ceiling outlet free', async () => {
    await room()
    const sw = await executeTool(host, 'place_electric', { kind: 'switch1', at: { x: 3000, y: 2950 } })
    expect(sw.result.ok, sw.result.text).toBe(true)
    const s = points()[0]
    expect(s.wallId).toBeTruthy()
    expect(s.y).toBeCloseTo(2900)
    expect(s.elevation).toBe(900)

    const light = await executeTool(host, 'place_electric', { kind: 'outLight', at: { x: 2000, y: 1500 } })
    expect(light.result.ok, light.result.text).toBe(true)
    const l = points().find((p) => p.kind === 'outLight')!
    expect(l.mount).toBe('ceiling')
    expect(l.wallId).toBeUndefined()
  })

  it('rejects calls without a place and unknown walls', async () => {
    await room()
    expect((await executeTool(host, 'place_electric', { kind: 'socket' })).result.ok).toBe(false)
    expect((await executeTool(host, 'place_electric', { kind: 'socket', wallId: 'w_none', offset: 10 })).result.ok).toBe(false)
    expect((await executeTool(host, 'place_electric', { kind: 'socket', wallId: Object.keys(st().doc.walls)[0], offset: 99999 })).result.ok).toBe(false)
    expect((await executeTool(host, 'place_electric', { kind: 'toaster', at: { x: 0, y: 0 } })).result.ok).toBe(false)
    expect(points()).toHaveLength(0)
    expect(describeCall('place_electric', { kind: 'socket', wallId: 'w_1' })).toContain('w_1')
  })
})
