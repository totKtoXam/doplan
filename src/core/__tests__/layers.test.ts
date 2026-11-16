import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { BUILTIN_ASSETS, createEmptyDoc } from '../defaults'
import { addItem, addLight, addOpening, addRectRoom, normalize, splitWall, syncRooms } from '../ops'
import { derivePlan } from '../derive'
import { parseDoc, readLayerFlags, serializeDoc } from '../io'
import { activeVariantId, createVariant, docFormatVersion, switchVariant } from '../variants'
import { buildDisplayList } from '../display'
import { toDxf } from '../export/dxf'
import {
  addLayer,
  assignLayer,
  buildLayerOutline,
  buildOutline,
  deleteLayer,
  entityKinds,
  isHidden,
  isLocked,
  layerIndex,
  moveLayer,
  orderedLayers,
  outlineMatches,
  pickableRefs,
  registerEntityKind,
  renameEntity,
  setGroupFlag,
  setHidden,
  setLayerFlag,
  setLocked,
  unlockedRefs,
  visibleDoc,
  visiblePlan,
} from '../layers'
import { DOC_VERSION, DOC_VERSION_VARIANTS, type Doc, type EntityRef, type Id, type LayerFlags } from '../types'

/** one 4×3 m room with a door, a sofa and a ceiling light */
function sample(): { doc: Doc; lv: Id; walls: Id[]; door: Id; sofa: Id; light: Id; room: Id } {
  const doc = createEmptyDoc('t')
  const lv = doc.levelOrder[0]
  addRectRoom(doc, lv, 0, 0, 4000, 3000)
  normalize(doc)
  syncRooms(doc)
  const walls = Object.keys(doc.walls)
  const door = addOpening(doc, walls[0], 'door', 1000)
  const sofa = addItem(doc, lv, BUILTIN_ASSETS.find((a) => a.procedural === 'sofa') ?? BUILTIN_ASSETS[0], 2000, 1500)
  const light = addLight(doc, lv, 'ceiling', 2000, 1500)
  const room = Object.keys(doc.rooms)[0]
  return { doc, lv, walls, door, sofa, light, room }
}

const ref = (kind: string, id: Id): EntityRef => ({ kind: kind as EntityRef['kind'], id })

describe('layers: effective visibility and lock', () => {
  it('own flags, group flags and layer flags combine', () => {
    const { doc, sofa, light, walls } = sample()
    expect(isHidden(doc, ref('item', sofa))).toBe(false)

    const d1 = produce(doc, (d) => setHidden(d, [ref('item', sofa)], true))
    expect(d1.items[sofa].hidden).toBe(true)
    expect(isHidden(d1, ref('item', sofa))).toBe(true)
    expect(isHidden(d1, ref('light', light))).toBe(false)

    // showing again removes the flag instead of storing `false`
    const d1b = produce(d1, (d) => setHidden(d, [ref('item', sofa)], false))
    expect('hidden' in d1b.items[sofa]).toBe(false)

    const d2 = produce(doc, (d) => setGroupFlag(d, 'light', 'hidden', true))
    expect(isHidden(d2, ref('light', light))).toBe(true)
    expect(isHidden(d2, ref('item', sofa))).toBe(false)
    const d2b = produce(d2, (d) => setGroupFlag(d, 'light', 'hidden', false))
    expect(d2b.groupFlags).toBeUndefined()

    let layerId = ''
    const d3 = produce(doc, (d) => {
      layerId = addLayer(d, 'Демонтаж')
      assignLayer(d, [ref('wall', walls[1]), ref('item', sofa)], layerId)
      setLayerFlag(d, layerId, 'locked', true)
    })
    expect(isLocked(d3, ref('wall', walls[1]))).toBe(true)
    expect(isLocked(d3, ref('item', sofa))).toBe(true)
    expect(isLocked(d3, ref('wall', walls[0]))).toBe(false)
    expect(isHidden(d3, ref('wall', walls[1]))).toBe(false)
  })

  it('an opening follows its wall; nodes follow their walls', () => {
    const { doc, walls, door } = sample()
    const w = doc.walls[walls[0]]
    const d = produce(doc, (x) => setHidden(x, [ref('wall', w.id)], true))
    expect(isHidden(d, ref('opening', door))).toBe(true)
    // a corner node is shared with a visible wall: still shown
    expect(isHidden(d, ref('node', w.a))).toBe(false)
    const all = produce(doc, (x) => setGroupFlag(x, 'wall', 'hidden', true))
    expect(isHidden(all, ref('node', w.a))).toBe(true)

    const locked = produce(doc, (x) => setLocked(x, [ref('wall', w.id)], true))
    expect(isLocked(locked, ref('opening', door))).toBe(true)
    expect(isLocked(locked, ref('node', w.a))).toBe(true)
    expect(isLocked(locked, ref('node', w.b))).toBe(true)
  })

  it('underlays keep using visible / locked', () => {
    const { doc, lv } = sample()
    const d = produce(doc, (x) => {
      x.underlays.u_1 = { id: 'u_1', levelId: lv, src: 'data:,', x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5, visible: true, locked: false, widthPx: 10, heightPx: 10 }
      setHidden(x, [ref('underlay', 'u_1')], true)
      setLocked(x, [ref('underlay', 'u_1')], true)
    })
    expect(d.underlays.u_1.visible).toBe(false)
    expect(d.underlays.u_1.locked).toBe(true)
    expect(isHidden(d, ref('underlay', 'u_1'))).toBe(true)
  })

  it('pickable / unlocked filters drop hidden and locked objects', () => {
    const { doc, sofa, light, walls } = sample()
    const d = produce(doc, (x) => {
      setHidden(x, [ref('item', sofa)], true)
      setLocked(x, [ref('light', light)], true)
    })
    const refs = [ref('item', sofa), ref('light', light), ref('wall', walls[0])]
    expect(pickableRefs(d, refs)).toEqual([ref('wall', walls[0])])
    expect(unlockedRefs(d, refs)).toEqual([ref('item', sofa), ref('wall', walls[0])])
  })

  it('the index is memoised per document and its key tracks content', () => {
    const { doc, sofa } = sample()
    expect(layerIndex(doc)).toBe(layerIndex(doc))
    expect(layerIndex(doc).noneHidden).toBe(true)
    const moved = produce(doc, (x) => {
      x.items[sofa].x += 100
    })
    expect(layerIndex(moved).key).toBe(layerIndex(doc).key)
    const hid = produce(doc, (x) => setHidden(x, [ref('item', sofa)], true))
    expect(layerIndex(hid).key).not.toBe(layerIndex(doc).key)
  })
})

describe('layers: visible view for drawings', () => {
  it('returns the same document when nothing is hidden', () => {
    const { doc, lv } = sample()
    const plan = derivePlan(doc, lv)
    expect(visibleDoc(doc)).toBe(doc)
    expect(visiblePlan(doc, plan)).toBe(plan)
  })

  it('filters hidden objects and keeps table identities stable', () => {
    const { doc, lv, sofa, walls, room } = sample()
    const d = produce(doc, (x) => {
      setHidden(x, [ref('item', sofa), ref('wall', walls[2]), ref('room', room)], true)
    })
    const v = visibleDoc(d)
    expect(v.items[sofa]).toBeUndefined()
    expect(v.walls[walls[2]]).toBeUndefined()
    expect(v.lights).toBe(d.lights)
    // the real document is untouched
    expect(d.items[sofa]).toBeDefined()

    // an unrelated edit (move the light) keeps the filtered tables
    const d2 = produce(d, (x) => {
      const l = Object.values(x.lights)[0]
      l.x += 10
    })
    const v2 = visibleDoc(d2)
    expect(v2.items).toBe(v.items)
    expect(v2.walls).toBe(v.walls)
    expect(v2.lights).not.toBe(v.lights)

    const plan = derivePlan(d, lv)
    const vp = visiblePlan(d, plan)
    // hiding a wall never changes room detection: the room still exists in the full plan
    expect(plan.rooms.length).toBe(1)
    expect(vp.rooms.length).toBe(0)
    expect(vp.wallGeoms[walls[2]]).toBeUndefined()
    expect(Object.keys(vp.wallGeoms).length).toBe(Object.keys(plan.wallGeoms).length - 1)
    expect(visiblePlan(d, plan)).toBe(vp)
  })

  it('exports skip hidden objects unless asked to include them', () => {
    const { doc, lv, sofa, light } = sample()
    const d = produce(doc, (x) => {
      setHidden(x, [ref('item', sofa)], true)
      setGroupFlag(x, 'light', 'hidden', true)
    })
    const refsOf = (dl: ReturnType<typeof buildDisplayList>) => new Set(dl.items.map((i) => (i.ref ? `${i.ref.kind}:${i.ref.id}` : '')))
    const all = refsOf(buildDisplayList(doc, lv))
    expect(all.has(`item:${sofa}`)).toBe(true)
    expect(all.has(`light:${light}`)).toBe(true)
    const vis = refsOf(buildDisplayList(d, lv))
    expect(vis.has(`item:${sofa}`)).toBe(false)
    expect(vis.has(`light:${light}`)).toBe(false)
    expect(refsOf(buildDisplayList(d, lv, { includeHidden: true })).has(`light:${light}`)).toBe(true)
  })

  it('DXF puts objects of a user layer on a layer with its name', () => {
    const { doc, lv, sofa } = sample()
    const d = produce(doc, (x) => {
      const id = addLayer(x, 'Мебель: вариант Б')
      assignLayer(x, [ref('item', sofa)], id)
    })
    const dxf = toDxf(d, lv)
    expect(dxf).toContain('Мебель_ вариант Б')
    expect(toDxf(doc, lv)).not.toContain('вариант Б')
  })
})

describe('layers: user layers', () => {
  it('add, order, rename, delete (objects stay without a layer)', () => {
    const { doc, sofa } = sample()
    let a = ''
    let b = ''
    const d = produce(doc, (x) => {
      a = addLayer(x)
      b = addLayer(x)
      assignLayer(x, [ref('item', sofa)], a)
      moveLayer(x, b, 0)
    })
    expect(orderedLayers(d).map((l) => l.name)).toEqual(['Слой 2', 'Слой 1'])
    expect(d.items[sofa].layerId).toBe(a)
    const d2 = produce(d, (x) => deleteLayer(x, a))
    expect(d2.items[sofa].layerId).toBeUndefined()
    expect(d2.items[sofa]).toBeDefined()
    expect(orderedLayers(d2).map((l) => l.id)).toEqual([b])
    const d3 = produce(d2, (x) => deleteLayer(x, b))
    expect(d3.layers).toBeUndefined()
    expect(d3.layerOrder).toBeUndefined()
  })

  it('assigning to a missing layer does nothing', () => {
    const { doc, sofa } = sample()
    const d = produce(doc, (x) => assignLayer(x, [ref('item', sofa)], 'ly_missing'))
    expect(d.items[sofa].layerId).toBeUndefined()
  })
})

describe('layers: outline (panel model)', () => {
  it('groups objects of the level by kind with names', () => {
    const { doc, lv } = sample()
    const groups = buildOutline(doc, lv, { lang: 'ru', assetName: () => 'Диван' })
    const by = Object.fromEntries(groups.map((g) => [g.kind, g]))
    expect(by.wall.rows).toHaveLength(4)
    expect(by.wall.rows[0].name).toMatch(/^Стена \d+,\d\d м$/)
    expect(by.opening.rows[0].name).toBe('Дверь 800')
    expect(by.opening.rows[0].subtype).toBe('Дверь')
    expect(by.item.rows[0].name).toBe('Диван')
    expect(by.room.rows).toHaveLength(1)
    expect(by.underlay.rows).toHaveLength(0)
    // every built-in kind is listed in a fixed order
    expect(groups.map((g) => g.kind)).toEqual(['wall', 'room', 'opening', 'item', 'light', 'underlay', 'annotation', 'dimension', 'label'])
  })

  it('rename sets a user name, empty resets it', () => {
    const { doc, lv, walls } = sample()
    const d = produce(doc, (x) => {
      renameEntity(x, ref('wall', walls[0]), '  Несущая  ')
    })
    expect(d.walls[walls[0]].name).toBe('Несущая')
    const row = buildOutline(d, lv, { lang: 'ru' }).find((g) => g.kind === 'wall')!.rows.find((r) => r.ref.id === walls[0])!
    expect(row.name).toBe('Несущая')
    const d2 = produce(d, (x) => {
      renameEntity(x, ref('wall', walls[0]), '')
    })
    expect(d2.walls[walls[0]].name).toBeUndefined()
  })

  it('groups by user layer: no layer first', () => {
    const { doc, lv, sofa } = sample()
    let id = ''
    const d = produce(doc, (x) => {
      id = addLayer(x, 'Вариант Б')
      assignLayer(x, [ref('item', sofa)], id)
    })
    const out = buildLayerOutline(d, lv, { lang: 'ru' })
    expect(out[0].layer).toBeNull()
    expect(out[1].layer?.id).toBe(id)
    expect(out[1].rows.map((r) => r.ref.id)).toEqual([sofa])
    expect(out[0].rows.some((r) => r.ref.id === sofa)).toBe(false)
  })

  it('search matches name, type and group title', () => {
    const { doc, lv } = sample()
    const g = buildOutline(doc, lv, { lang: 'ru' }).find((x) => x.kind === 'opening')!
    expect(outlineMatches(g.rows[0], g.title, 'двер')).toBe(true)
    expect(outlineMatches(g.rows[0], g.title, 'проём')).toBe(true)
    expect(outlineMatches(g.rows[0], g.title, 'окно')).toBe(false)
  })
})

describe('layers: registry of kinds', () => {
  it('a registered kind is listed, filtered and keeps its flags in files', () => {
    interface Socket extends LayerFlags {
      id: Id
      levelId: Id
      x: number
    }
    registerEntityKind<Socket>({
      kind: 'testSocket',
      docKey: 'testSockets',
      title: { ru: 'Розетки', en: 'Sockets' },
      icon: 'plug',
      order: 45,
      level: (s) => s.levelId,
      name: (s, env) => s.name ?? (env.lang === 'ru' ? 'Розетка' : 'Socket'),
    })
    const { doc, lv } = sample()
    const d = produce(doc, (x) => {
      ;(x as unknown as Record<string, unknown>).testSockets = { s1: { id: 's1', levelId: lv, x: 0 }, s2: { id: 's2', levelId: lv, x: 1 } }
      setHidden(x, [ref('testSocket', 's1')], true)
    })
    expect(entityKinds().some((k) => k.kind === 'testSocket')).toBe(true)
    const g = buildOutline(d, lv, { lang: 'ru' }).find((x) => x.kind === 'testSocket')!
    expect(g.rows.map((r) => [r.ref.id, r.hidden])).toEqual([
      ['s1', true],
      ['s2', false],
    ])
    const v = visibleDoc(d) as unknown as { testSockets: Record<Id, unknown> }
    expect(Object.keys(v.testSockets)).toEqual(['s2'])

    // the kind's own reader keeps the flags with readLayerFlags
    const target: LayerFlags = {}
    readLayerFlags({ hidden: true, locked: 'yes', name: ' Щит ', layerId: 'ly_1' }, target)
    expect(target).toEqual({ hidden: true, name: 'Щит', layerId: 'ly_1' })
  })
})

describe('layers: files', () => {
  it('old files without layer fields open with everything visible', () => {
    const { doc, lv } = sample()
    const json = JSON.parse(serializeDoc(doc))
    delete json.layers
    delete json.groupFlags
    const back = parseDoc(json)
    expect(back.layers).toBeUndefined()
    expect(back.groupFlags).toBeUndefined()
    expect(layerIndex(back).noneHidden).toBe(true)
    expect(layerIndex(back).noneLocked).toBe(true)
    expect(Object.keys(back.walls)).toHaveLength(4)
    expect(buildOutline(back, lv, { lang: 'ru' }).find((g) => g.kind === 'wall')!.rows.every((r) => !r.hidden && !r.locked)).toBe(true)
  })

  it('flags, names, layers and group flags survive save / load', () => {
    const { doc, sofa, walls, door, light } = sample()
    let layerId = ''
    const d = produce(doc, (x) => {
      layerId = addLayer(x, 'Демонтаж')
      setLayerFlag(x, layerId, 'hidden', true)
      assignLayer(x, [ref('wall', walls[1]), ref('opening', door)], layerId)
      setHidden(x, [ref('item', sofa)], true)
      setLocked(x, [ref('light', light)], true)
      renameEntity(x, ref('wall', walls[0]), 'Несущая')
      setGroupFlag(x, 'dimension', 'locked', true)
      setGroupFlag(x, 'testSocket', 'hidden', true)
    })
    const back = parseDoc(serializeDoc(d))
    expect(back.layers?.[layerId]).toEqual({ id: layerId, name: 'Демонтаж', hidden: true })
    expect(back.layerOrder).toEqual([layerId])
    expect(back.walls[walls[1]].layerId).toBe(layerId)
    expect(back.openings[door].layerId).toBe(layerId)
    expect(back.items[sofa].hidden).toBe(true)
    expect(back.lights[light].locked).toBe(true)
    expect(back.walls[walls[0]].name).toBe('Несущая')
    // group flags of kinds this build does not know are kept
    expect(back.groupFlags).toEqual({ dimension: { locked: true }, testSocket: { hidden: true } })
    expect(isHidden(back, ref('wall', walls[1]))).toBe(true)
  })

  it('drops broken layer references and bad group keys', () => {
    const { doc, sofa } = sample()
    const json = JSON.parse(serializeDoc(doc))
    json.items[sofa].layerId = 'ly_gone'
    json.layers = [{ id: 'ly_a', name: '' }, { name: 'B', hidden: 'yes' }]
    json.layerOrder = ['nope', 'ly_a', 'ly_a']
    json.groupFlags = { 'bad key!': { hidden: true }, wall: { hidden: 1, locked: true }, item: 'x' }
    const back = parseDoc(json)
    expect(back.items[sofa].layerId).toBeUndefined()
    const ls = orderedLayers(back)
    expect(ls).toHaveLength(2)
    expect(ls[0]).toEqual({ id: 'ly_a', name: 'Слой 1' })
    expect(ls[1].name).toBe('B')
    expect(ls[1].hidden).toBeUndefined()
    expect(back.groupFlags).toEqual({ wall: { locked: true } })
  })
})

describe('layers: wall graph edits keep the flags', () => {
  it('a split wall keeps hidden / locked / layer on both halves', () => {
    const { doc, walls } = sample()
    let layerId = ''
    const d = produce(doc, (x) => {
      layerId = addLayer(x)
      assignLayer(x, [ref('wall', walls[0])], layerId)
      setLocked(x, [ref('wall', walls[0])], true)
      const w = x.walls[walls[0]]
      const a = x.nodes[w.a]
      const b = x.nodes[w.b]
      splitWall(x, w.id, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    })
    const pieces = Object.values(d.walls).filter((w) => w.layerId === layerId)
    expect(pieces).toHaveLength(2)
    expect(pieces.every((w) => w.locked)).toBe(true)
  })

  it('normalize does not merge collinear walls with different flags', () => {
    const doc = createEmptyDoc('t')
    const lv = doc.levelOrder[0]
    addRectRoom(doc, lv, 0, 0, 4000, 3000)
    const top = Object.values(doc.walls).find((w) => doc.nodes[w.a].y === 0 && doc.nodes[w.b].y === 0)!
    const n = splitWall(doc, top.id, { x: 2000, y: 0 })
    const half = Object.values(doc.walls).find((w) => w.id !== top.id && (w.a === n || w.b === n) && doc.nodes[w.a].y === 0 && doc.nodes[w.b].y === 0)!
    half.hidden = true
    // unpin the split node so normalize may merge it
    delete (doc.nodes[n] as { pinned?: boolean }).pinned
    normalize(doc)
    expect(doc.walls[half.id]).toBeDefined()
    expect(doc.walls[top.id]).toBeDefined()
  })
})

describe('layers: furnishing variants and the file format', () => {
  it('flags and layers of an inactive variant survive save / load and switching', () => {
    const { doc, sofa, light } = sample()
    const a = activeVariantId(doc)
    const layerId = addLayer(doc, 'Мебель')
    assignLayer(doc, [ref('item', sofa), ref('light', light)], layerId)
    setLocked(doc, [ref('item', sofa)], true)
    setHidden(doc, [ref('light', light)], true)
    renameEntity(doc, ref('light', light), 'Люстра')
    // variant B: a copy without the flags; A goes to its stash
    createVariant(doc, { from: 'copy', name: 'Б' })
    setLocked(doc, [ref('item', sofa)], false)
    setHidden(doc, [ref('light', light)], false)
    assignLayer(doc, [ref('item', sofa), ref('light', light)], null)

    const back = parseDoc(serializeDoc(doc))
    const stash = back.variants!.list[a].stash!.collections
    expect(stash.items![sofa]).toMatchObject({ locked: true, layerId })
    expect(stash.lights![light]).toMatchObject({ hidden: true, layerId, name: 'Люстра' })
    expect(back.items[sofa].locked).toBeUndefined()
    expect(back.lights[light].layerId).toBeUndefined()

    switchVariant(back, a)
    expect(isLocked(back, ref('item', sofa))).toBe(true)
    expect(isHidden(back, ref('light', light))).toBe(true)
    expect(back.items[sofa].layerId).toBe(layerId)
  })

  it('layer ids of stashed objects pointing nowhere are dropped on read and by deleteLayer', () => {
    const { doc, sofa } = sample()
    const a = activeVariantId(doc)
    const keep = addLayer(doc, 'Остаётся')
    const gone = addLayer(doc, 'Удаляется')
    assignLayer(doc, [ref('item', sofa)], keep)
    createVariant(doc, { from: 'copy' })
    const raw = JSON.parse(serializeDoc(doc))
    raw.variants.list[a].stash.collections.items[sofa].layerId = 'ly_missing'
    expect(parseDoc(raw).variants!.list[a].stash!.collections.items![sofa].layerId).toBeUndefined()

    assignLayer(doc, [ref('item', sofa)], gone) // live copy in B
    doc.variants!.list[a].stash!.collections.items![sofa].layerId = gone
    deleteLayer(doc, gone)
    expect(doc.items[sofa].layerId).toBeUndefined()
    expect(doc.variants!.list[a].stash!.collections.items![sofa].layerId).toBeUndefined()
    expect(keep in doc.layers!).toBe(true)
  })

  it('plain files stay format 1; layers-panel data raises the format', () => {
    const v = (d: Doc): number => JSON.parse(serializeDoc(d)).version
    const { doc, sofa, walls, light, door } = sample()
    expect(v(doc)).toBe(DOC_VERSION)
    // item lock / hide and item names were in format 1 already
    expect(v(produce(doc, (d) => setLocked(d, [ref('item', sofa)], true)))).toBe(DOC_VERSION)
    expect(v(produce(doc, (d) => setHidden(d, [ref('item', sofa)], true)))).toBe(DOC_VERSION)
    expect(v(produce(doc, (d) => { renameEntity(d, ref('item', sofa), 'Диван') }))).toBe(DOC_VERSION)

    expect(v(produce(doc, (d) => setHidden(d, [ref('wall', walls[0])], true)))).toBe(DOC_VERSION_VARIANTS)
    expect(v(produce(doc, (d) => setLocked(d, [ref('light', light)], true)))).toBe(DOC_VERSION_VARIANTS)
    expect(v(produce(doc, (d) => { renameEntity(d, ref('opening', door), 'Вход') }))).toBe(DOC_VERSION_VARIANTS)
    expect(v(produce(doc, (d) => setGroupFlag(d, 'item', 'locked', true)))).toBe(DOC_VERSION_VARIANTS)
    expect(v(produce(doc, (d) => { addLayer(d, 'Пустой') }))).toBe(DOC_VERSION_VARIANTS)
    expect(v(produce(doc, (d) => assignLayer(d, [ref('item', sofa)], addLayer(d, 'Мебель'))))).toBe(DOC_VERSION_VARIANTS)

    // undoing it all returns to format 1
    const d1 = produce(doc, (d) => setGroupFlag(d, 'item', 'hidden', true))
    const d2 = produce(d1, (d) => setGroupFlag(d, 'item', 'hidden', false))
    expect(v(d2)).toBe(DOC_VERSION)
    expect(docFormatVersion(d2)).toBe(DOC_VERSION)
  })

  it('a raised-format file reads back here; an app knowing only format 1 refuses it', () => {
    const { doc, walls } = sample()
    const d = produce(doc, (x) => setLocked(x, [ref('wall', walls[0])], true))
    const raw = JSON.parse(serializeDoc(d))
    expect(raw.version).toBe(DOC_VERSION_VARIANTS)
    const back = parseDoc(raw)
    expect(back.version).toBe(DOC_VERSION_VARIANTS)
    expect(back.walls[walls[0]].locked).toBe(true)
    // the check of format-1 apps (doplan ≤ 0.11): `version > DOC_VERSION` → refuse
    expect(raw.version > DOC_VERSION).toBe(true)
    expect(() => parseDoc({ ...raw, version: DOC_VERSION_VARIANTS + 1 })).toThrow(/более новой версии doplan \(формат 3\)/)
  })
})
