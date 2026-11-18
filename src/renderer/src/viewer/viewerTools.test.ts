import { describe, expect, it } from 'vitest'
import { addItem, addOpening, addRectRoom, createEmptyDoc, derivePlan, isHidden, syncRooms } from '@core'
import type { Asset, Material } from '@core/types'
import { gapBetween, planGap, pointGap, shapeOf } from './distance'
import { elementInfo, type InfoEnv } from './elementInfo'
import { applyHidden, EMPTY_HIDE, hiddenRefs, hideHash, parseHideHash, toggleCat, toggleRef } from './hideState'

const velvet = { id: 'velvet', name: 'Velvet', nameRu: 'Бархат', category: 'fabric', color: '#888888', roughness: 1, metalness: 0, product: { price: 1000 } } as unknown as Material
const sofa = {
  id: 'sofa-a',
  name: 'Sofa',
  nameRu: 'Диван Олаф',
  category: 'sofa',
  kind: 'procedural',
  size: { w: 2000, d: 900, h: 800 },
  mount: 'floor',
  slots: { fabric: 'velvet' },
} as unknown as Asset
const lamp = { ...sofa, id: 'lamp-a', name: 'Lamp', nameRu: 'Торшер', category: 'lighting', size: { w: 400, d: 400, h: 1600 } } as unknown as Asset

function plan() {
  const doc = createEmptyDoc('test')
  const lid = doc.levelOrder[0]
  const walls = addRectRoom(doc, lid, 0, 0, 4000, 3000)
  syncRooms(doc)
  const door = addOpening(doc, walls[0], 'door', 1000)
  const win = addOpening(doc, walls[1], 'window', 1500)
  const s = addItem(doc, lid, sofa, 1500, 1000)
  const l = addItem(doc, lid, lamp, 3000, 2000)
  const derived = derivePlan(doc, lid)
  return { doc, lid, walls, door, win, sofa: s, lamp: l, derived }
}

const envOf = (p: ReturnType<typeof plan>): InfoEnv => ({
  doc: p.doc,
  plan: p.derived,
  catalog: { assets: [sofa, lamp], materials: [velvet] },
  lang: 'ru',
  t: (s) => s,
})

describe('element card', () => {
  it('an item: catalogue name, category, W×D×H and its material — no price', () => {
    const p = plan()
    const info = elementInfo({ kind: 'item', id: p.sofa }, envOf(p))
    expect(info?.name).toBe('Диван Олаф')
    expect(info?.type).toBe('Диван')
    expect(info?.rows.find((r) => r.label === 'Размеры (Ш × Г × В)')?.value).toMatch(/^2\s000 × 900 × 800 мм$/)
    expect(info?.rows).toContainEqual({ label: 'Материал', value: 'Бархат' })
    expect(JSON.stringify(info)).not.toMatch(/1000|price/)
  })

  it('a wall: length, thickness, height; an opening: width, height, sill; a room: area, perimeter, ceiling', () => {
    const p = plan()
    const env = envOf(p)
    const wall = elementInfo({ kind: 'wall', id: p.walls[0] }, env)
    expect(wall?.rows.map((r) => r.label)).toEqual(expect.arrayContaining(['Длина', 'Толщина', 'Высота']))
    const door = elementInfo({ kind: 'opening', id: p.door }, env)
    expect(door?.type).toBe('Дверь')
    expect(door?.rows.map((r) => r.label)).toEqual(['Ширина', 'Высота'])
    const win = elementInfo({ kind: 'opening', id: p.win }, env)
    expect(win?.type).toBe('Окно')
    expect(win?.rows.map((r) => r.label)).toContain('Подоконник (от пола)')
    const room = p.derived.rooms[0]
    const card = elementInfo({ kind: 'room', id: room.roomId }, env)
    expect(card?.rows.map((r) => r.label)).toEqual(expect.arrayContaining(['Площадь', 'Периметр', 'Высота потолка']))
    expect(card?.rows.find((r) => r.label === 'Площадь')?.value).toMatch(/м²$/)
  })

  it('an electrical point never shows the author note', () => {
    const p = plan()
    p.doc.electrical = { e1: { id: 'e1', levelId: p.lid, kind: 'socket', mount: 'wall', x: 0, y: 500, elevation: 300, rotation: 0, comment: 'кофемашина, линия 3' } }
    const info = elementInfo({ kind: 'electric', id: 'e1' }, envOf(p))
    expect(info?.rows).toEqual([{ label: 'Высота установки', value: '300 мм' }])
    expect(JSON.stringify(info)).not.toMatch(/кофемашина/)
  })

  it('unknown objects have no card', () => {
    const p = plan()
    expect(elementInfo({ kind: 'item', id: 'nope' }, envOf(p))).toBeNull()
    expect(elementInfo({ kind: 'dimension', id: 'x' }, envOf(p))).toBeNull()
  })
})

describe('distances', () => {
  it('between footprints: shortest, with the closest points', () => {
    const sq = (x: number, y: number, s = 100) => [
      { x, y },
      { x: x + s, y },
      { x: x + s, y: y + s },
      { x, y: y + s },
    ]
    const g = planGap(sq(0, 0), sq(300, 0))
    expect(g.dist).toBeCloseTo(200)
    expect(g.a.x).toBeCloseTo(100)
    expect(g.b.x).toBeCloseTo(300)
    expect(planGap(sq(0, 0), sq(50, 50)).dist).toBe(0)
    // diagonal neighbours: corner to corner
    expect(planGap(sq(0, 0), sq(400, 500)).dist).toBeCloseTo(500)
    // a point (a light) to a box
    expect(planGap([{ x: 50, y: 400 }], sq(0, 0)).dist).toBeCloseTo(300)
  })

  it('between two objects: X / Y gaps and the height gap', () => {
    const p = plan()
    const a = shapeOf({ kind: 'item', id: p.sofa }, p.doc, p.derived)
    const b = shapeOf({ kind: 'item', id: p.lamp }, p.doc, p.derived)
    if (!a || !b) throw new Error('no shape')
    const g = gapBetween(a, b)
    // sofa 500–2500 × 550–1450, lamp 2800–3200 × 1800–2200
    expect(g.dx).toBeCloseTo(300)
    expect(g.dy).toBeCloseTo(350)
    expect(g.dz).toBe(0)
    expect(g.shortest).toBeCloseTo(Math.hypot(300, 350))
    const shelf = { poly: a.poly, z0: 2000, z1: 2300 }
    expect(gapBetween(a, shelf).dz).toBe(1200)
    expect(gapBetween(a, shelf).shortest).toBe(1200)
  })

  it('two measured points', () => {
    expect(pointGap({ x: 0, y: 0, z: 0 }, { x: 300, y: 400, z: 1200 })).toEqual({ shortest: 1300, dx: 300, dy: 400, dz: 1200 })
  })
})

describe('hiding in the URL hash', () => {
  it('round-trips refs, categories and the ceiling, keeping other hash parameters', () => {
    let s = toggleRef(EMPTY_HIDE, { kind: 'item', id: 'a1' }, true)
    s = toggleRef(s, { kind: 'wall', id: 'w_2' }, true)
    s = toggleCat(s, 'furniture', true)
    s = { ...s, ceiling: false }
    const hash = hideHash(s, '#foo=1')
    expect(hash).toBe('#foo=1&hide=item:a1,wall:w_2&cats=furniture&ceil=0')
    expect(parseHideHash(hash)).toEqual(s)
    expect(hideHash(EMPTY_HIDE, '')).toBe('')
    expect(hideHash(toggleRef(s, { kind: 'item', id: 'a1' }, false), '')).toBe('#hide=wall:w_2&cats=furniture&ceil=0')
  })

  it('ignores junk in an edited link', () => {
    expect(parseHideHash('#hide=bogus:1,item:,:x,item:a,item:a&cats=furniture,nope,furniture&ceil=maybe')).toEqual({
      refs: [{ kind: 'item', id: 'a' }],
      cats: ['furniture'],
    })
  })

  it('categories: a lamp is lighting, a sofa furniture; doors and windows apart', () => {
    const p = plan()
    const asset = (id: string) => [sofa, lamp].find((a) => a.id === id)
    const keys = (cats: Parameters<typeof toggleCat>[1][]) =>
      hiddenRefs({ refs: [], cats }, p.doc, asset)
        .map((r) => r.id)
        .sort()
    expect(keys(['furniture'])).toEqual([p.sofa])
    expect(keys(['lighting'])).toEqual([p.lamp])
    expect(keys(['doors'])).toEqual([p.door])
    expect(keys(['windows'])).toEqual([p.win])
  })

  it('applies as hidden flags and restores what the author had hidden', () => {
    const p = plan()
    p.doc.items[p.lamp].hidden = true
    const author = new Set([`item:${p.lamp}`])
    // every edit is a new document in the app (Immer): the hidden index is cached per object
    const a = structuredClone(p.doc)
    applyHidden(a, [{ kind: 'item', id: p.sofa }], author)
    expect(isHidden(a, { kind: 'item', id: p.sofa })).toBe(true)
    expect(isHidden(a, { kind: 'item', id: p.lamp })).toBe(true)
    const b = structuredClone(a)
    applyHidden(b, [], author)
    expect(isHidden(b, { kind: 'item', id: p.sofa })).toBe(false)
    expect(isHidden(b, { kind: 'item', id: p.lamp })).toBe(true)
  })
})
