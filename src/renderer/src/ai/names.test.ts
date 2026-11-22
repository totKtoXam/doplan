import { beforeEach, describe, expect, it } from 'vitest'
import { builtinCatalog, createEmptyDoc, derivePlan } from '@core'
import type { Catalog, Id } from '@core/types'
import { docStore } from '@/store/document'
import { marksStore } from '@/store/marks'
import { uiStore } from '@/store/ui'
import { AGENT_SYSTEM_PROMPT } from '../../../main/aichat/prompt'
import { showOnPlan } from './IdChip'
import { ID_RE, idName, isIdLike, nameIds, nameOfId, splitIds } from './names'
import { describeCall, executeTool, hostNames, type ToolHost } from './tools'
import './i18n'

// The user never reads internal ids (w_UEecTYeFRN): the action log names objects by kind, size and
// room, the agent is told not to write ids, and an id it writes anyway is shown as the object's name.

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
const lv = () => host.activeLevelId()
const hasId = (s: string) => new RegExp(ID_RE.source).test(s)
const grey = catalog.materials.find((m) => m.nameRu === 'Светло-серый')!

/** «Кухня» 4000×3000 and «Спальня» next to it, sharing the wall at x = 4000 */
async function twoRooms(): Promise<{ shared: Id }> {
  expect((await executeTool(host, 'add_rect_room', { x: 0, y: 0, w: 4000, h: 3000, name: 'Кухня' })).result.ok).toBe(true)
  expect((await executeTool(host, 'add_rect_room', { x: 4000, y: 0, w: 3000, h: 3000, name: 'Спальня' })).result.ok).toBe(true)
  const shared = Object.values(st().doc.walls).find((w) => {
    const a = st().doc.nodes[w.a]
    const b = st().doc.nodes[w.b]
    return Math.abs(a.x - 4000) < 1 && Math.abs(b.x - 4000) < 1
  })!
  return { shared: shared.id }
}

beforeEach(() => {
  uiStore.setState({ lang: 'ru', selection: [] })
  st().load(createEmptyDoc('T'), null)
})

describe('the action log', () => {
  it('names walls, openings and points by kind, size and room — never by id', async () => {
    const { shared } = await twoRooms()
    const lines: string[] = []
    const run = async (tool: string, args: unknown) => {
      const r = await executeTool(host, tool, args)
      expect(r.result.ok, r.result.text).toBe(true)
      lines.push(...(r.changes ?? []))
      return r
    }
    await run('set_wall', { wallId: shared, thickness: 120, kind: 'partition' })
    await run('set_material', { targetId: shared, materialId: grey.id, surface: 'left' })
    await run('add_opening', { wallId: shared, kind: 'door', width: 800 })
    await run('place_electric', { kind: 'socket', wallId: shared, offset: 500 })
    const roomId = Object.values(st().doc.rooms).find((r) => r.name === 'Кухня')!.id
    await run('set_room', { roomId, floorMaterialId: grey.id, type: 'kitchen' })
    await run('add_wall', { from: { x: 1000, y: 0 }, to: { x: 1000, y: 3000 }, kind: 'partition' })
    const door = Object.keys(st().doc.openings)[0]
    await run('delete', { ids: [door, shared] })

    for (const l of lines) expect(l, l).not.toSatisfy(hasId)
    const all = lines.join('\n')
    expect(all).toContain('Стена 3000 мм (Кухня / Спальня): толщина 200 → 120, тип Стена → Перегородка')
    expect(all).toMatch(/Перегородка \(Кухня \/ Спальня\), сторона «(Кухня|Спальня)»: Светло-серый/)
    expect(all).toContain('Добавлено: Дверь 800×')
    expect(all).toContain('Электроточка «Розетка одинарная» (Кухня / Спальня), h 300')
    expect(all).toContain('Комната «Кухня»: тип Кухня, пол Светло-серый')
    expect(all).toContain('Добавлено: Перегородка 3000 мм (')
    expect(all).toMatch(/Удалено: Дверь 800×\d+ \(Кухня \/ Спальня\), Перегородка 3000 мм/)
    expect(all).not.toMatch(/\b(left|right|wall|partition|door|kitchen)\b/)
  })

  it('a tape measurement names the wall and the room its side faces', async () => {
    const { shared } = await twoRooms()
    const w = st().doc.walls[shared]
    const r = await executeTool(host, 'apply_measurement', { measurements: [{ side: `${shared}:left`, length: 2900 }] })
    expect(r.result.ok, r.result.text).toBe(true)
    const line = r.changes![0]
    expect(line).not.toSatisfy(hasId)
    expect(line).toMatch(/^Стена \(Кухня \/ Спальня\), сторона «(Кухня|Спальня)»: \d+ → 2900 мм/)
    expect(line).not.toMatch(/конец|end/)
    // two nodes of one wall: the wall is named
    const n = await executeTool(host, 'apply_measurement', { measurements: [{ nodes: { fixed: w.a, move: w.b }, length: 3100 }] })
    expect(n.changes![0]).toMatch(/^Стена \(Кухня \/ Спальня\): 3\d+ → 3100 мм/)
  })

  it('describes a pending call with names, and a gone object neutrally', async () => {
    const { shared } = await twoRooms()
    const names = hostNames(host)
    expect(describeCall('set_wall', { wallId: shared, thickness: 100, anchor: 'a' }, names)).toBe('Стена 3000 мм (Кухня / Спальня): толщина')
    expect(describeCall('delete', { ids: [shared, 'w_AAAAAAAAAA'] }, names)).toBe('Удалить Стена 3000 мм (Кухня / Спальня), (удалённый объект)')
    expect(describeCall('set_material', { targetId: shared, materialId: grey.id, surface: 'left' }, names)).toBe('Стена 3000 мм (Кухня / Спальня) (левая сторона) → Светло-серый')
    expect(describeCall('place_electric', { kind: 'socket', wallId: shared }, names)).not.toSatisfy(hasId)
    expect(describeCall('add_opening', { wallId: shared, kind: 'door' }, names)).toBe('Дверь на стене Стена 3000 мм (Кухня / Спальня)')
    uiStore.setState({ lang: 'en' })
    try {
      const en = describeCall('set_wall', { wallId: shared, thickness: 100, height: 2500 }, hostNames(host))
      expect(en).toBe('Wall 3000 mm (Kitchen / Bedroom): thickness, height')
    } finally {
      uiStore.setState({ lang: 'ru' })
    }
  })
})

describe('ids in the agent’s text', () => {
  it('finds ids of every kind, and leaves ordinary words alone', () => {
    const text = 'Стена w_UEecTYeFRN, узел n_0123456789, пометка pm_abcdefghij, этаж lv_ABCDEFGHIJ, комната auto_1x2y3z. Не id: w_short, my_variable_name, foo_w_UEecTYeFRNx'
    expect(text.match(ID_RE)).toEqual(['w_UEecTYeFRN', 'n_0123456789', 'pm_abcdefghij', 'lv_ABCDEFGHIJ', 'auto_1x2y3z'])
    expect(isIdLike('w_UEecTYeFRN')).toBe(true)
    expect(isIdLike('w_UEecTYeFRN и')).toBe(false)
    expect(splitIds('до w_UEecTYeFRN после')).toEqual(['до ', { id: 'w_UEecTYeFRN' }, ' после'])
  })

  it('an existing object becomes its name, a gone one «(удалённый объект)»', async () => {
    const { shared } = await twoRooms()
    const names = hostNames(host)
    const room = Object.values(st().doc.rooms).find((r) => r.name === 'Спальня')!.id
    expect(nameIds(names, `Покрасил ${shared} в ${room}.`)).toBe('Покрасил Стена 3000 мм (Кухня / Спальня) в Спальня.')
    expect(nameIds(names, 'Удалил w_L4jkZe4Fcm.')).toBe('Удалил (удалённый объект).')
    expect(idName(names, grey.id)).toBe('Светло-серый')
    expect(idName(names, lv())).toBe(st().doc.levels[lv()].name)
  })

  it('a chip click selects the object on the plan (and its level), a mark selects the mark', async () => {
    const { shared } = await twoRooms()
    const hit = nameOfId(hostNames(host), shared)!
    showOnPlan(hit)
    expect(uiStore.getState().selection).toEqual([{ kind: 'wall', id: shared }])
    expect(uiStore.getState().activeLevelId).toBe(lv())

    const { addMark } = await import('@/store/marks')
    const m = addMark(lv(), 'stroke', [
      { x: 0, y: 0 },
      { x: 900, y: 0 },
    ])
    const mark = nameOfId(hostNames(host), m)!
    expect(mark.name).toBe('Пометка ①')
    showOnPlan(mark)
    expect(marksStore.getState().selected).toBe(m)
  })

  it('the agent is told never to show ids, and the chat turns its ids into chips', async () => {
    expect(AGENT_SYSTEM_PROMPT).not.toContain('Mention ids only when useful')
    expect(AGENT_SYSTEM_PROMPT).toMatch(/NEVER show internal ids/)
    expect(AGENT_SYSTEM_PROMPT).toContain('новая стена 330 мм между Комнатой и Спальней')
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/say which end moved/)
    const fs = await import('node:fs')
    const path = await import('node:path')
    const chat = fs.readFileSync(path.resolve(__dirname, './ChatPanel.tsx'), 'utf8')
    expect(chat).toMatch(/<RichText key=\{i\} text=\{b\.part\.text\} className="my-1" ids \/>/)
    uiStore.setState({ lang: 'en' })
    try {
      expect(idName(hostNames(host), 'w_L4jkZe4Fcm')).toBe('(deleted object)')
    } finally {
      uiStore.setState({ lang: 'ru' })
    }
  })
})
