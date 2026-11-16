import { beforeEach, describe, expect, it } from 'vitest'
import { builtinCatalog, createEmptyDoc, derivePlan, roomEdgeRuns } from '@core'
import type { Catalog } from '@core/types'
import { formatAnswers, parseToolArgs, toolJsonSchema } from '@shared/aiTools'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import './i18n'
import { describeCall, executeTool, type ToolHost } from './tools'

const catalog: Catalog = builtinCatalog()
const st = () => docStore.getState()

/** the live host minus the UI stores: real docStore transactions (so undo works) */
const host: ToolHost = {
  doc: () => st().doc,
  derived: (lv) => derivePlan(st().doc, lv),
  activeLevelId: () => Object.keys(st().doc.levels)[0],
  selection: () => [],
  catalog: () => catalog,
  mutate: (label, fn) => st().transact(label, fn),
  snapshot: async () => ({ mime: 'image/png', data: '' }),
}

describe('parseToolArgs', () => {
  it('accepts node ids or points as wall ends', () => {
    expect(parseToolArgs('add_wall', { from: 'n_1', to: { x: 0, y: 3000 } }).ok).toBe(true)
  })

  it('rejects wrong types, unknown keys and out-of-range values with a readable message', () => {
    const bad = parseToolArgs('add_rect_room', { x: 0, y: 0, w: 'big', h: 10 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error).toContain('add_rect_room')
      expect(bad.error).toContain('w')
      expect(bad.error).toContain('h')
    }
    expect(parseToolArgs('add_wall', { from: { x: 0, y: 0, z: 1 }, to: 'n' }).ok).toBe(false)
    expect(parseToolArgs('add_wall', { from: { x: Number.NaN, y: 0 }, to: 'n' }).ok).toBe(false)
    expect(parseToolArgs('delete', { ids: [] }).ok).toBe(false)
    expect(parseToolArgs('get_plan', { detail: 'brief', extra: 1 }).ok).toBe(false)
  })

  it('exposes a JSON schema for every tool', () => {
    const s = toolJsonSchema('place_item') as { type: string; properties: Record<string, unknown>; required?: string[] }
    expect(s.type).toBe('object')
    expect(s.properties.assetId).toBeTruthy()
    expect(s.required).toContain('assetId')
  })
})

describe('ask_user', () => {
  const q = (n: number) => ({ question: 'Как назвать?', options: Array.from({ length: n }, (_, i) => ({ label: `вариант ${i}` })) })

  it('takes 1-4 questions of 2-4 options each', () => {
    expect(parseToolArgs('ask_user', { questions: [q(2)] }).ok).toBe(true)
    expect(parseToolArgs('ask_user', { questions: [q(4), { ...q(3), header: 'Комнаты', multiSelect: true }, q(2), q(2)] }).ok).toBe(true)
    expect(parseToolArgs('ask_user', { questions: [] }).ok).toBe(false)
    expect(parseToolArgs('ask_user', { questions: [q(2), q(2), q(2), q(2), q(2)] }).ok).toBe(false)
    expect(parseToolArgs('ask_user', { questions: [q(1)] }).ok).toBe(false)
    expect(parseToolArgs('ask_user', { questions: [q(5)] }).ok).toBe(false)
    expect(parseToolArgs('ask_user', { questions: [{ ...q(2), extra: 1 }] }).ok).toBe(false)
  })

  it('formats the answers for the agent: options, own words, unanswered, the chat note', () => {
    const text = formatAnswers(
      [{ question: 'Комната 1?' }, { question: 'Розетки?' }, { question: 'Пол?' }],
      [{ picked: ['Кухня'] }, { picked: ['Кухня', 'Спальня'], other: ' у окна ' }, { picked: [] }],
      ' остальное сам ',
    )
    expect(text).toBe(
      'Ответы пользователя:\n1. Комната 1?\n   Ответ: Кухня\n2. Розетки?\n   Ответ: Кухня; Спальня; своими словами: у окна\n3. Пол?\n   Ответ: (без ответа)\nПользователь ответил в чате своими словами: остальное сам',
    )
  })

  it('is not executed as a document tool', async () => {
    expect((await executeTool(host, 'ask_user', { questions: [q(2)] })).result.ok).toBe(false)
  })
})

describe('executeTool', () => {
  beforeEach(() => st().load(createEmptyDoc('T'), null))

  it('fails cleanly on unknown tools and bad arguments', async () => {
    expect((await executeTool(host, 'rm_rf', {})).result.ok).toBe(false)
    const r = await executeTool(host, 'add_wall', { from: 1 })
    expect(r.result.ok).toBe(false)
    expect(Object.keys(st().doc.walls)).toHaveLength(0)
  })

  it('adds a room, a wall between its nodes and a fridge; each step is one undo', async () => {
    const room = await executeTool(host, 'add_rect_room', { x: 0, y: 0, w: 4000, h: 3000, name: 'Кухня', type: 'kitchen' })
    expect(room.result.ok).toBe(true)
    expect(Object.keys(st().doc.walls)).toHaveLength(4)
    const roomId = Object.keys(st().doc.rooms)[0]
    expect(st().doc.rooms[roomId].name).toBe('Кухня')

    const plan = await executeTool(host, 'get_plan', {})
    expect(plan.result.text).toContain('Кухня')

    const nodes = Object.values(st().doc.nodes)
    const a = nodes.find((n) => n.x === 0 && n.y === 0)!
    const wall = await executeTool(host, 'add_wall', { from: a.id, to: { x: -2000, y: 0 } })
    expect(wall.result.ok).toBe(true)
    expect(wall.changes?.length).toBe(1)
    expect(Object.keys(st().doc.walls).length).toBeGreaterThan(4)

    const found = await executeTool(host, 'list_catalog', { kind: 'asset', query: 'холодильник' })
    const fridgeId = /- (\S+) —/.exec(found.result.text)?.[1]
    expect(fridgeId, found.result.text).toBeTruthy()
    const put = await executeTool(host, 'place_item', { assetId: fridgeId, roomId })
    expect(put.result.ok, put.result.text).toBe(true)
    expect(put.result.text).toContain('Кухня')
    expect(Object.keys(st().doc.items)).toHaveLength(1)

    st().undo()
    expect(Object.keys(st().doc.items)).toHaveLength(0)
    st().undo()
    expect(Object.keys(st().doc.walls)).toHaveLength(4)
  })

  it('change lines the user reads follow the UI language', async () => {
    uiStore.setState({ lang: 'en' })
    try {
      await executeTool(host, 'add_rect_room', { x: 0, y: 0, w: 4000, h: 3000, type: 'kitchen' })
      const roomId = Object.keys(st().doc.rooms)[0]
      // no name of its own: the room goes by its type
      st().transact('t', (d) => {
        d.rooms[roomId].name = ''
      })
      const found = await executeTool(host, 'list_catalog', { kind: 'asset', query: 'холодильник' })
      const fridgeId = /- (\S+) —/.exec(found.result.text)?.[1]
      const put = await executeTool(host, 'place_item', { assetId: fridgeId, roomId })
      const itemId = Object.keys(st().doc.items)[0]
      const moved = await executeTool(host, 'move_item', { itemId, rotation: 90, elevation: 100 })
      const room = await executeTool(host, 'set_room', { roomId, ceilingHeight: 2700 })
      const lines = [...(put.changes ?? []), ...(moved.changes ?? []), ...(room.changes ?? []), describeCall('move_node', { nodeId: 'n_1', x: 0, y: 0 })]
      expect(lines.length).toBe(4)
      for (const l of lines) expect(l, l).not.toMatch(/[А-Яа-яЁё]/)
      expect(put.changes?.[0]).toContain('Kitchen')
      expect(moved.changes?.[0]).toContain('rotation 0° → 90°')
    } finally {
      uiStore.setState({ lang: 'ru' })
    }
  })

  it('reports missing entities instead of throwing', async () => {
    const r = await executeTool(host, 'move_node', { nodeId: 'n_missing', x: 0, y: 0 })
    expect(r.result.ok).toBe(false)
    expect(r.result.text).toContain('n_missing')
    const p = await executeTool(host, 'place_item', { assetId: 'nope', x: 0, y: 0 })
    expect(p.result.ok).toBe(false)
  })
})

describe('apply_measurement', () => {
  beforeEach(() => st().load(createEmptyDoc('T'), null))

  it('maps a tape measurement onto a wall side in one undo step and ticks the mark', async () => {
    await executeTool(host, 'add_rect_room', { x: 0, y: 0, w: 4000, h: 3000, name: 'Кухня' })
    const lv = host.activeLevelId()
    const top = roomEdgeRuns(derivePlan(st().doc, lv).rooms[0]).find((r) => Math.abs(r.a.y - r.b.y) < 1 && r.a.y < 1000)!
    const before = Math.round(top.length)
    st().transact('mark', (d) => {
      d.annotations = {
        pm_1: {
          id: 'pm_1',
          levelId: lv,
          n: 1,
          shape: 'stroke',
          points: [
            { x: 0, y: 100 },
            { x: 3000, y: 100 },
          ],
        },
      }
    })

    const r = await executeTool(host, 'apply_measurement', { measurements: [{ side: top.key, length: before + 120, moveEnd: 'b' }], annotationId: 'pm_1' })
    expect(r.result.ok, r.result.text).toBe(true)
    expect(r.result.text).toContain('Кухня')
    expect(r.result.text).toContain(`${before} → ${before + 120}`)
    const runAfter = () => roomEdgeRuns(derivePlan(st().doc, lv).rooms[0]).find((x) => x.key === top.key)!
    expect(Math.round(runAfter().length)).toBe(before + 120)
    expect(st().doc.annotations?.pm_1.done).toBe(true)

    st().undo()
    expect(st().doc.annotations?.pm_1.done).toBeUndefined()
    expect(Math.round(runAfter().length)).toBe(before)
  })

  it('rejects the whole call when one measurement is wrong (nothing applied)', async () => {
    await executeTool(host, 'add_rect_room', { x: 0, y: 0, w: 4000, h: 3000 })
    const nodes = Object.values(st().doc.nodes)
    const a = nodes.find((n) => n.x === 0 && n.y === 0)!
    const b = nodes.find((n) => n.x === 4000 && n.y === 0)!
    const snap = JSON.stringify(st().doc.nodes)
    const bad = await executeTool(host, 'apply_measurement', {
      measurements: [
        { nodes: { fixed: a.id, move: b.id }, length: 4100 },
        { side: 'w_missing:left', length: 1000 },
      ],
    })
    expect(bad.result.ok).toBe(false)
    expect(bad.result.text).toContain('w_missing')
    expect(JSON.stringify(st().doc.nodes)).toBe(snap)
    const good = await executeTool(host, 'apply_measurement', { measurements: [{ nodes: { fixed: a.id, move: b.id }, length: 4100 }] })
    expect(good.result.ok, good.result.text).toBe(true)
    expect(Math.round(st().doc.nodes[b.id].x)).toBe(4100)
  })
})
