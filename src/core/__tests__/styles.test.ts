import { describe, expect, it } from 'vitest'
import { compilePlanSpecDetailed, parsePlanSpec } from '../planspec'
import { BUILTIN_MATERIALS } from '../defaults'
import { BUILTIN_STYLES, applyStyle, findStyle, styleMaterialIds, stylePalette } from '../styles'
import { STYLE_MATERIALS } from '../styleMaterials'
import { newId } from '../ids'
import { builtinCatalog, findAsset } from '../catalog'
import { parseDoc, serializeDoc } from '../io'
import type { Doc, Id, Item } from '../types'

const SPEC = {
  version: 1,
  units: 'mm',
  name: 'Style test',
  defaults: { ceilingHeight: 2700, exteriorThickness: 300, loadBearingThickness: 200, partitionThickness: 100 },
  rooms: [
    { id: 'bath', name: 'С/у', type: 'combinedBathroom', rect: [0, 0, 1700, 2200] },
    { id: 'hall', name: 'Прихожая', type: 'hall', rect: [1800, 0, 3000, 3200] },
    { id: 'kitchen', name: 'Кухня', type: 'kitchen', rect: [4900, 0, 2500, 3200] },
    { id: 'living', name: 'Гостиная', type: 'living', rect: [1800, 3300, 5600, 4600] },
  ],
  openings: [
    { id: 'd-bath', type: 'door', at: [1750, 1000], width: 700, between: ['bath', 'hall'], opensInto: 'hall', hinge: 'right' },
    { id: 'd-kit', type: 'door', at: [4850, 2400], width: 800, between: ['hall', 'kitchen'], opensInto: 'kitchen', hinge: 'left' },
    { id: 'd-liv', type: 'door', at: [3000, 3250], width: 800, between: ['hall', 'living'], opensInto: 'living', hinge: 'left' },
    { id: 'w-liv', type: 'window', at: [4600, 8050], width: 1800, sill: 850, height: 1500 },
  ],
}

function build() {
  const r = compilePlanSpecDetailed(parsePlanSpec(SPEC))
  const doc = r.doc
  const add = (assetId: string, x: number, y: number, size: Item['size'], extra: Partial<Item> = {}): Id => {
    const id = newId('i')
    doc.items[id] = { id, levelId: r.levelId, assetId, x, y, elevation: 0, rotation: 0, size, mount: 'floor', ...extra }
    return id
  }
  const base = add('asset_kitchen_base_600', 6000, 300, { w: 600, d: 600, h: 900 })
  const upper = add('asset_kitchen_wall_400', 6000, 160, { w: 400, d: 320, h: 720 }, { elevation: 1400, mount: 'wall' })
  const sofa = add('asset_sofa_3seat', 4600, 5000, { w: 2200, d: 950, h: 850 })
  const lightId = newId('l')
  doc.lights[lightId] = { id: lightId, levelId: r.levelId, kind: 'ceiling', x: 4600, y: 5600, elevation: 2650, temperature: 4000, lumens: 1500, on: true }
  return { ...r, doc, items: { base, upper, sofa }, lightId }
}

describe('styles: data', () => {
  const ids = new Set(BUILTIN_MATERIALS.map((m) => m.id))
  it('every style refers only to existing built-in materials', () => {
    for (const s of BUILTIN_STYLES) for (const id of styleMaterialIds(s)) expect(ids.has(id), `${s.id} → ${id}`).toBe(true)
  })
  it('style materials are part of BUILTIN_MATERIALS, ids are unique, paints carry a colour code', () => {
    expect(ids.size).toBe(BUILTIN_MATERIALS.length)
    for (const m of STYLE_MATERIALS) expect(ids.has(m.id)).toBe(true)
    const coded = STYLE_MATERIALS.filter((m) => m.colorCode)
    expect(coded.length).toBeGreaterThan(20)
    expect(coded.find((m) => m.id === 'mat_ncs_0502_y')?.colorCode).toEqual({ system: 'NCS', code: 'S 0502-Y' })
    expect(coded.find((m) => m.id === 'mat_ral_9010')?.colorCode).toEqual({ system: 'RAL', code: '9010' })
  })
  it('eight international styles with a 6-swatch palette', () => {
    expect(BUILTIN_STYLES).toHaveLength(8)
    expect(new Set(BUILTIN_STYLES.map((s) => s.id)).size).toBe(8)
    for (const s of BUILTIN_STYLES) expect(stylePalette(s)).toHaveLength(6)
    expect(findStyle('style_japandi')?.nameRu).toBe('Джапанди')
  })
})

describe('applyStyle', () => {
  const style = findStyle('style_scandi')!

  it('re-finishes one room and leaves the others alone', () => {
    const { doc, roomIds } = build()
    const before = JSON.parse(JSON.stringify(doc)) as Doc
    const liv = roomIds.living
    const rep = applyStyle(doc, style, { rooms: [liv] })
    expect(rep.rooms).toBe(1)
    const room = doc.rooms[liv]
    expect(room.floor.materialId).toBe(style.finishes.floorDry)
    expect(room.ceiling.materialId).toBe(style.finishes.ceiling)
    expect(room.skirting).toBe(style.skirtingHeight)
    expect(room.design?.styleId).toBe(style.id)
    expect(doc.design?.styleId).toBeUndefined()
    // other rooms untouched
    for (const k of ['bath', 'hall', 'kitchen']) expect(doc.rooms[roomIds[k]]).toEqual(before.rooms[roomIds[k]])
    // sofa re-skinned, kitchen cabinets untouched (outside the scope)
    expect(rep.items).toBe(1)
    expect(rep.lights).toBe(1)
    expect(doc.lights[Object.keys(doc.lights)[0]].temperature).toBe(style.lightTemperature)
  })

  it('accent wall: exactly one living-room face, without openings', () => {
    const { doc, roomIds } = build()
    applyStyle(doc, style, { rooms: [roomIds.living] })
    const accentWalls = Object.values(doc.walls).filter((w) => w.left.materialId === style.finishes.wallAccent || w.right.materialId === style.finishes.wallAccent)
    expect(accentWalls).toHaveLength(1)
    const withOpening = new Set(Object.values(doc.openings).map((o) => o.wallId))
    expect(withOpening.has(accentWalls[0].id)).toBe(false)
  })

  it('wet rooms get wet finishes, kitchen gets an apron band between base and wall units', () => {
    const { doc, roomIds } = build()
    applyStyle(doc, style, { rooms: 'all' })
    expect(doc.design?.styleId).toBe(style.id)
    const bath = doc.rooms[roomIds.bath]
    expect(bath.floor.materialId).toBe(style.finishes.floorWet)
    expect(bath.skirting).toBe(0)
    expect(doc.rooms[roomIds.hall].floor.materialId).toBe(style.finishes.floorHall)
    const zones = Object.values(doc.walls).flatMap((w) => [...(w.left.zones ?? []), ...(w.right.zones ?? [])])
    expect(zones).toEqual([{ from: 900, to: 1400, materialId: style.finishes.apron }])
  })

  it('furniture slots follow the style, appliances and doors as specified', () => {
    const { doc, items } = build()
    applyStyle(doc, style, { rooms: 'all' })
    const sofa = doc.items[items.sofa]
    const sofaAsset = findAsset(doc, builtinCatalog(), sofa.assetId)!
    const eff = (slot: string) => sofa.overrides?.[slot] ?? sofaAsset.slots![slot]
    expect(eff('fabric')).toBe(style.furnishing.textileMain)
    expect(eff('legs')).toBe(style.furnishing.woodFurniture)
    // an override equal to the asset default is not stored
    expect(sofa.overrides?.fabric).toBeUndefined()
    const base = doc.items[items.base]
    // scandi front is a coded RAL white, body equals the default (no override kept)
    expect(base.overrides?.front).toBe(style.furnishing.cabinetFront)
    expect(base.overrides?.body).toBeUndefined()
    expect(base.overrides?.worktop).toBe(style.furnishing.worktop)
    const doors = Object.values(doc.openings).filter((o) => o.kind === 'door')
    expect(doors.length).toBeGreaterThan(0)
    for (const d of doors) expect(d.leafMaterialId).toBe(style.finishes.doorLeaf)
  })

  it('is idempotent and respects part toggles', () => {
    const { doc } = build()
    applyStyle(doc, style, { rooms: 'all' })
    const once = JSON.stringify(doc)
    applyStyle(doc, style, { rooms: 'all' })
    expect(JSON.stringify(doc)).toBe(once)

    const b = build()
    const before = JSON.parse(JSON.stringify(b.doc)) as Doc
    applyStyle(b.doc, style, { rooms: 'all', parts: { finishes: true, accent: false, openings: false, furniture: false, lights: false } })
    expect(b.doc.items).toEqual(before.items)
    expect(b.doc.lights).toEqual(before.lights)
    expect(b.doc.openings).toEqual(before.openings)
    const accent = Object.values(b.doc.walls).some((w) => w.left.materialId === style.finishes.wallAccent || w.right.materialId === style.finishes.wallAccent)
    expect(accent).toBe(false)
  })

  it('design fields survive save → load', () => {
    const { doc, roomIds } = build()
    applyStyle(doc, style, { rooms: 'all' })
    doc.materials.mat_custom = { id: 'mat_custom', name: 'My paint', category: 'paint', color: '#abcdef', roughness: 0.9, metalness: 0, colorCode: { system: 'NCS', code: 'S 1020-Y' }, custom: true }
    const back = parseDoc(serializeDoc(doc))
    expect(back.design).toEqual({ styleId: style.id })
    expect(back.rooms[roomIds.living].design).toEqual({ styleId: style.id })
    expect(back.materials.mat_custom.colorCode).toEqual({ system: 'NCS', code: 'S 1020-Y' })
  })
})
