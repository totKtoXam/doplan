import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ASSETS,
  DOC_VERSION,
  DOC_VERSION_VARIANTS,
  activeVariantId,
  addItem,
  addLight,
  addOpening,
  addRectRoom,
  addWall,
  beforeItemAssetChange,
  computeBom,
  copyLevelInVariants,
  createEmptyDoc,
  createVariant,
  deleteVariant,
  derivePlan,
  docFormatVersion,
  listVariants,
  materializeVariant,
  moveVariant,
  moveWall,
  normalize,
  parseDoc,
  removeEntities,
  renameVariant,
  serializeDoc,
  splitWall,
  strayEntities,
  switchVariant,
  syncRooms,
  variantCollection,
  type Doc,
  type Id,
} from '@core'

enablePatches()

const sofa = BUILTIN_ASSETS.find((a) => a.category === 'sofa')!
const column = BUILTIN_ASSETS.find((a) => a.category === 'structure' && a.procedural === 'column')!

function apartment() {
  const doc = createEmptyDoc('Квартира')
  const level = doc.levelOrder[0]
  const walls = addRectRoom(doc, level, 0, 0, 4000, 3000)
  const door = addOpening(doc, walls[0], 'door', 900)
  syncRooms(doc)
  const sofaId = addItem(doc, level, sofa, 2000, 1500)
  const columnId = addItem(doc, level, column, 500, 500)
  const lightId = addLight(doc, level, 'ceiling', 2000, 1500)
  return { doc, level, walls, door, sofaId, columnId, lightId, roomId: Object.keys(doc.rooms)[0] }
}

describe('furnishing variants: model', () => {
  it('a document without variants has one implicit variant and the old format', () => {
    const { doc } = apartment()
    expect(listVariants(doc)).toEqual([{ id: activeVariantId(doc), name: 'Вариант 1', active: true }])
    expect(docFormatVersion(doc)).toBe(DOC_VERSION)
  })

  it('copy: the new variant starts as a copy, edits stay in their variant', () => {
    const { doc, sofaId, lightId } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy', name: 'Лофт' })
    expect(activeVariantId(doc)).toBe(b)
    expect(doc.variants!.list[a].name).toBe('Вариант 1')
    expect(doc.items[sofaId].x).toBe(2000)
    doc.items[sofaId] = { ...doc.items[sofaId], x: 3000 }
    delete doc.lights[lightId]

    expect(switchVariant(doc, a)).toBe(true)
    expect(doc.items[sofaId].x).toBe(2000)
    expect(doc.lights[lightId]).toBeDefined()
    switchVariant(doc, b)
    expect(doc.items[sofaId].x).toBe(3000)
    expect(doc.lights[lightId]).toBeUndefined()
    expect(docFormatVersion(doc)).toBe(DOC_VERSION_VARIANTS)
    expect(doc.version).toBe(DOC_VERSION_VARIANTS)
  })

  it('empty: no furniture and lights, apartment items (columns) and finishes stay', () => {
    const { doc, sofaId, columnId, walls } = apartment()
    doc.walls[walls[0]].left = { materialId: 'mat_custom_green' }
    createVariant(doc, { from: 'empty' })
    expect(doc.items[sofaId]).toBeUndefined()
    expect(doc.items[columnId]).toBeDefined()
    expect(Object.keys(doc.lights)).toHaveLength(0)
    expect(doc.walls[walls[0]].left.materialId).toBe('mat_custom_green')
  })

  it('apartment items are shared: moving a column shows in every variant', () => {
    const { doc, columnId } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy' })
    doc.items[columnId] = { ...doc.items[columnId], x: 900 }
    switchVariant(doc, a)
    expect(doc.items[columnId].x).toBe(900)
    expect(variantCollection(doc, b, 'items')[columnId]).toBeUndefined()
  })

  it('finishes and style are per variant', () => {
    const { doc, walls, roomId, door } = apartment()
    doc.design = { currency: 'KZT', styleId: 'style_scandi' }
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy' })
    doc.walls[walls[1]] = { ...doc.walls[walls[1]], right: { materialId: 'mat_b_wall' }, left: { materialId: 'mat_b_wall' } }
    doc.rooms[roomId] = { ...doc.rooms[roomId], floor: { materialId: 'mat_b_floor' }, design: { styleId: 'style_loft' } }
    doc.openings[door] = { ...doc.openings[door], leafMaterialId: 'mat_b_leaf', curtain: undefined }
    doc.design = { currency: 'KZT', styleId: 'style_loft' }
    switchVariant(doc, a)
    expect(doc.walls[walls[1]].left.materialId).not.toBe('mat_b_wall')
    expect(doc.rooms[roomId].floor.materialId).not.toBe('mat_b_floor')
    expect(doc.rooms[roomId].design).toBeUndefined()
    expect(doc.openings[door].leafMaterialId).not.toBe('mat_b_leaf')
    expect(doc.design).toEqual({ currency: 'KZT', styleId: 'style_scandi' })
    switchVariant(doc, b)
    expect(doc.walls[walls[1]].left.materialId).toBe('mat_b_wall')
    expect(doc.rooms[roomId].design).toEqual({ styleId: 'style_loft' })
    expect(doc.openings[door].leafMaterialId).toBe('mat_b_leaf')
    expect(doc.design.styleId).toBe('style_loft')
  })

  it('geometry stays shared: a wall moved in one variant is moved in all', () => {
    const { doc, walls } = apartment()
    const a = activeVariantId(doc)
    createVariant(doc, { from: 'copy' })
    moveWall(doc, walls[1], 500, 0)
    normalize(doc)
    syncRooms(doc)
    const nodes = JSON.stringify(doc.nodes)
    switchVariant(doc, a)
    expect(JSON.stringify(doc.nodes)).toBe(nodes)
  })

  it('rename, reorder, delete (never the last; the active one hands over)', () => {
    const { doc } = apartment()
    expect(renameVariant(doc, activeVariantId(doc), '  Основной  ')).toBe(true)
    const a = activeVariantId(doc)
    expect(doc.variants!.list[a].name).toBe('Основной')
    const b = createVariant(doc, { from: 'copy' })
    expect(doc.variants!.order).toEqual([a, b])
    expect(moveVariant(doc, b, -1)).toBe(true)
    expect(doc.variants!.order).toEqual([b, a])
    expect(deleteVariant(doc, b)).toBe(true)
    expect(activeVariantId(doc)).toBe(a)
    expect(deleteVariant(doc, a)).toBe(false)
    expect(docFormatVersion(doc)).toBe(DOC_VERSION)
  })

  it('deleting the active variant brings in the neighbour content', () => {
    const { doc, sofaId } = apartment()
    createVariant(doc, { from: 'empty' })
    const b = activeVariantId(doc)
    expect(doc.items[sofaId]).toBeUndefined()
    deleteVariant(doc, b)
    expect(doc.items[sofaId]).toBeDefined()
  })
})

describe('furnishing variants: immer, materialize, upkeep', () => {
  it('switching inside an Immer transaction is undoable through patches', () => {
    const base = produce(apartment().doc, (d) => {
      createVariant(d, { from: 'empty' })
    })
    const a = base.variants!.order[0]
    const [next, , inverse] = produceWithPatches(base, (d: Doc) => {
      switchVariant(d, a)
    })
    expect(Object.keys(next.items).length).toBeGreaterThan(Object.keys(base.items).length)
    const back = applyPatches(next, inverse)
    expect(back).toEqual(base)
  })

  it('materializeVariant gives the other variant without touching the document', () => {
    const { doc: raw, sofaId } = apartment()
    const doc = produce(raw, (d) => {
      createVariant(d, { from: 'copy' })
      d.items[sofaId].x = 3500
    })
    const a = doc.variants!.order[0]
    const before = JSON.stringify(doc)
    const view = materializeVariant(doc, a)
    expect(view.items[sofaId].x).toBe(2000)
    expect(JSON.stringify(doc)).toBe(before)
    expect(materializeVariant(doc, activeVariantId(doc))).toBe(doc)
    // estimate of each variant
    expect(computeBom(view).length).toBeGreaterThan(0)
  })

  it('deleting a wall forgets its finish in other variants; splitting a wall copies it', () => {
    const { doc, walls } = apartment()
    const a = activeVariantId(doc)
    createVariant(doc, { from: 'copy' })
    const over = () => doc.variants!.list[a].stash!.finishes.walls
    expect(over()[walls[2]]).toBeDefined()
    splitWall(doc, walls[2], { x: 2000, y: 3000 })
    const added = Object.keys(doc.walls).find((id) => !walls.includes(id))!
    expect(over()[added]).toEqual(over()[walls[2]])
    removeEntities(doc, [{ kind: 'wall', id: walls[0] }])
    normalize(doc)
    syncRooms(doc)
    expect(over()[walls[0]]).toBeUndefined()
  })

  it('items of a deleted level are dropped from inactive variants', () => {
    const { doc, sofaId } = apartment()
    const a = activeVariantId(doc)
    const lv2 = 'lv_second'
    doc.levels[lv2] = { id: lv2, name: 'Этаж 2', elevation: 3000, height: 2700, visible: true }
    doc.levelOrder.push(lv2)
    doc.items.i_up = { ...doc.items[sofaId], id: 'i_up', levelId: lv2 }
    createVariant(doc, { from: 'empty' })
    expect(variantCollection(doc, a, 'items').i_up).toBeDefined()
    delete doc.levels[lv2]
    doc.levelOrder = doc.levelOrder.filter((id) => id !== lv2)
    syncRooms(doc)
    expect(variantCollection(doc, a, 'items').i_up).toBeUndefined()
    expect(variantCollection(doc, a, 'items')[sofaId]).toBeDefined()
  })

  it('copying a level copies the furniture of inactive variants too', () => {
    const { doc, level, walls, roomId } = apartment()
    const a = activeVariantId(doc)
    createVariant(doc, { from: 'empty' })
    const maps = { walls: new Map([[walls[0], 'w_copy']]), rooms: new Map([[roomId, 'r_copy']]), openings: new Map<Id, Id>() }
    copyLevelInVariants(doc, level, 'lv_new', maps, 100, 0)
    const items = Object.values(variantCollection(doc, a, 'items')).filter((i) => i.levelId === 'lv_new')
    expect(items).toHaveLength(1)
    expect(items[0].x).toBe(2100)
    const fin = doc.variants!.list[a].stash!.finishes
    expect(fin.walls.w_copy).toEqual(fin.walls[walls[0]])
    expect(fin.rooms.r_copy).toEqual(fin.rooms[roomId])
  })

  it('reports furniture left outside the rooms after a wall edit, in every variant', () => {
    const { doc, level, walls, sofaId } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy' })
    doc.items[sofaId] = { ...doc.items[sofaId], x: 3800 }
    const derived = () => ({ [level]: derivePlan(doc, level) })
    expect(strayEntities(doc, derived(), a)).toEqual([])
    expect(strayEntities(doc, derived(), b)).toEqual([])
    // the right wall moves 600 mm in: the sofa of B (x 3800) is now outside, the one of A (x 2000) is not
    moveWall(doc, walls[1], -600, 0)
    normalize(doc)
    syncRooms(doc)
    expect(strayEntities(doc, derived(), b)).toEqual([{ kind: 'item', id: sofaId }])
    expect(strayEntities(doc, derived(), a)).toEqual([])
    // nothing is deleted
    switchVariant(doc, a)
    expect(variantCollection(doc, b, 'items')[sofaId].x).toBe(3800)
  })

  it('a wall drawn after the variants exist keeps its own finish in each variant', () => {
    const { doc, level } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy', activate: false })
    const c = createVariant(doc, { from: 'copy', activate: false })
    const [w] = addWall(doc, level, { x: 2000, y: 0 }, { x: 2000, y: 3000 })
    normalize(doc)
    syncRooms(doc)
    const initial = doc.walls[w].left
    switchVariant(doc, b)
    doc.walls[w] = { ...doc.walls[w], left: { materialId: 'mat_green' } }
    switchVariant(doc, c)
    expect(doc.walls[w].left).toEqual(initial)
    switchVariant(doc, a)
    expect(doc.walls[w].left).toEqual(initial)
    switchVariant(doc, b)
    expect(doc.walls[w].left).toEqual({ materialId: 'mat_green' })
  })

  it('furniture replaced by a column in one variant stays furniture in the others', () => {
    const { doc, sofaId } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy', activate: false })
    // in A the sofa's model becomes a structure asset; B still holds its sofa under that id
    doc.items[sofaId] = { ...doc.items[sofaId], assetId: column.id }
    for (let i = 0; i < 2; i++) {
      switchVariant(doc, b)
      expect(Object.values(doc.items).filter((it) => it.assetId === sofa.id)).toHaveLength(1)
      expect(doc.items[sofaId].assetId).toBe(sofa.id)
      switchVariant(doc, a)
      expect(doc.items[sofaId].assetId).toBe(column.id)
      expect(Object.values(doc.items).filter((it) => it.assetId === sofa.id)).toHaveLength(0)
    }
  })

  it('a shared column replaced by furniture in one variant stays a column in the others', () => {
    const { doc, columnId } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy', activate: false })
    const c = createVariant(doc, { from: 'empty', activate: false })
    beforeItemAssetChange(doc, columnId, sofa.category)
    doc.items[columnId] = { ...doc.items[columnId], assetId: sofa.id }
    for (let i = 0; i < 2; i++) {
      switchVariant(doc, b)
      expect(doc.items[columnId].assetId).toBe(column.id)
      switchVariant(doc, c)
      expect(doc.items[columnId].assetId).toBe(column.id)
      switchVariant(doc, a)
      expect(doc.items[columnId].assetId).toBe(sofa.id)
      expect(Object.values(doc.items).filter((it) => it.assetId === column.id)).toHaveLength(0)
    }
    // a column → column swap (or a variant-owned item) changes nothing in the stashes
    const before = JSON.stringify(doc.variants)
    beforeItemAssetChange(doc, columnId, 'structure')
    expect(JSON.stringify(doc.variants)).toBe(before)
  })

  it('an empty variant keeps the apartment items other variants hold per variant', () => {
    const { doc, columnId } = apartment()
    createVariant(doc, { from: 'copy', activate: false })
    beforeItemAssetChange(doc, columnId, sofa.category)
    doc.items[columnId] = { ...doc.items[columnId], assetId: sofa.id }
    const b = listVariants(doc).find((v) => !v.active)!.id
    switchVariant(doc, b)
    const e = createVariant(doc, { from: 'empty' })
    expect(activeVariantId(doc)).toBe(e)
    expect(doc.items[columnId]?.assetId).toBe(column.id)
  })

  it('copying a level keeps matching ids between identical variants', () => {
    const { doc, level, sofaId, lightId } = apartment()
    const a = activeVariantId(doc)
    createVariant(doc, { from: 'copy' })
    const maps = {
      walls: new Map<Id, Id>(),
      rooms: new Map<Id, Id>(),
      openings: new Map<Id, Id>(),
      items: new Map([[sofaId, 'i_sofa_copy']]),
      lights: new Map([[lightId, 'l_light_copy']]),
    }
    copyLevelInVariants(doc, level, 'lv_new', maps)
    expect(variantCollection(doc, a, 'items').i_sofa_copy?.levelId).toBe('lv_new')
    expect(variantCollection(doc, a, 'lights').l_light_copy?.levelId).toBe('lv_new')
  })

  it('a copy can be made from an inactive variant without switching to it', () => {
    const { doc, sofaId } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy' })
    doc.items[sofaId] = { ...doc.items[sofaId], x: 3000 }
    switchVariant(doc, a)
    const c = createVariant(doc, { from: 'copy', source: b, activate: false })
    expect(activeVariantId(doc)).toBe(a)
    expect(doc.variants!.order).toEqual([a, b, c])
    expect(variantCollection(doc, c, 'items')[sofaId].x).toBe(3000)
    expect(doc.items[sofaId].x).toBe(2000)
  })
})

describe('furnishing variants: file format', () => {
  it('round-trips two variants; the file says format 2', () => {
    const { doc, sofaId, walls } = apartment()
    const a = activeVariantId(doc)
    const b = createVariant(doc, { from: 'copy', name: 'Лофт' })
    doc.items[sofaId] = { ...doc.items[sofaId], x: 3100 }
    doc.walls[walls[0]] = { ...doc.walls[walls[0]], left: { materialId: 'mat_loft' } }
    const text = serializeDoc(doc)
    expect(JSON.parse(text).version).toBe(DOC_VERSION_VARIANTS)
    const back = parseDoc(text)
    expect(listVariants(back).map((v) => v.name)).toEqual(['Вариант 1', 'Лофт'])
    expect(activeVariantId(back)).toBe(b)
    expect(back.items[sofaId].x).toBe(3100)
    switchVariant(back, a)
    expect(back.items[sofaId].x).toBe(2000)
    expect(back.walls[walls[0]].left.materialId).not.toBe('mat_loft')
  })

  it('an old file opens as one variant with everything in it', () => {
    const { doc, sofaId } = apartment()
    const old = JSON.parse(JSON.stringify(doc))
    delete old.variants
    old.version = 1
    const back = parseDoc(old)
    expect(back.variants).toBeUndefined()
    expect(listVariants(back)).toHaveLength(1)
    expect(back.items[sofaId]).toBeDefined()
    expect(back.version).toBe(DOC_VERSION)
  })

  it('a file from a newer format is refused with a readable message', () => {
    const { doc } = apartment()
    expect(() => parseDoc({ ...JSON.parse(serializeDoc(doc)), version: DOC_VERSION_VARIANTS + 1 })).toThrow(/более новой версии/)
  })

  it('a broken active id never loses a stash', () => {
    const { doc, sofaId } = apartment()
    createVariant(doc, { from: 'empty' })
    const raw = JSON.parse(serializeDoc(doc))
    raw.variants.activeId = 'v_missing'
    const back = parseDoc(raw)
    expect(listVariants(back)).toHaveLength(3)
    const withSofa = listVariants(back).filter((v) => variantCollection(back, v.id, 'items')[sofaId])
    expect(withSofa).toHaveLength(1)
  })
})
