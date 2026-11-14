import { describe, expect, it } from 'vitest'
import { compilePlanSpecDetailed, docToPlanSpec, parsePlanSpec, validatePlanSpec, compilePlanSpec } from '../planspec'
import { buildDisplayList } from '../display'
import { toSvg } from '../export/svg'
import { toDxf } from '../export/dxf'
import { drawToCanvas, type Canvas2DLike } from '../export/canvas'
import { computeBom } from '../bom'
import { derivePlan } from '../derive'

const EXAMPLE_A = {
  version: 1,
  units: 'mm',
  name: 'ЖК Пример, корп. 3, кв. 41 — 2-комн. 57,4 м²',
  source: {
    image: '.doplan-work/kv41/src.png',
    size: [1652, 2212],
    kind: 'brochure',
    mmPerPx: 6.0,
    originPx: [160, 150],
    labelledTotalArea: 57.4,
    labelledLivingArea: 33.1,
  },
  defaults: { ceilingHeight: 2700, exteriorThickness: 300, loadBearingThickness: 200, partitionThickness: 100 },
  snap: { orthogonal: true, gridMm: 10 },
  rooms: [
    { id: 'bath', name: 'С/у', type: 'combinedBathroom', rect: [0, 0, 1700, 2200], labelledArea: 3.7 },
    { id: 'ward', name: 'Гардероб', type: 'wardrobe', rect: [0, 2300, 1700, 900], labelledArea: 1.5 },
    { id: 'hall', name: 'Прихожая', type: 'hall', rect: [1800, 0, 3000, 3200], labelledArea: 9.6 },
    { id: 'kitchen', name: 'Кухня', type: 'kitchen', rect: [4900, 0, 2500, 3200], labelledArea: 8.0 },
    { id: 'bed', name: 'Спальня', type: 'bedroom', rect: [0, 3400, 3300, 4600], labelledArea: 15.2 },
    { id: 'living', name: 'Гостиная', type: 'living', rect: [3500, 3400, 3900, 4600], labelledArea: 17.9 },
    {
      id: 'balc',
      name: 'Балкон',
      type: 'balcony',
      rect: [3500, 8300, 3900, 1200],
      labelledArea: 4.7,
      edgeWall: { kind: 'railing', thickness: 100, height: 1100 },
    },
  ],
  openings: [
    { id: 'd-entr', type: 'entranceDoor', at: [3050, -150], width: 900, between: ['hall', 'outside'], opensInto: 'outside', hinge: 'left' },
    { id: 'd-bath', type: 'door', at: [1750, 1000], width: 700, between: ['bath', 'hall'], opensInto: 'hall', hinge: 'right' },
    { id: 'd-ward', type: 'slidingDoor', at: [1750, 2750], width: 700, between: ['ward', 'hall'] },
    { id: 'd-kit', type: 'door', at: [4850, 2400], width: 800, between: ['hall', 'kitchen'], opensInto: 'kitchen', hinge: 'left' },
    { id: 'd-bed', type: 'door', at: [2500, 3300], width: 800, between: ['hall', 'bed'], opensInto: 'bed', hinge: 'right' },
    { id: 'd-liv', type: 'door', at: [4100, 3300], width: 800, between: ['hall', 'living'], opensInto: 'living', hinge: 'left' },
    { id: 'd-balc', type: 'balconyDoor', at: [4300, 8150], width: 800, between: ['living', 'balc'], opensInto: 'living', hinge: 'left' },
    { id: 'w-kit', type: 'window', at: [7550, 1600], width: 1200, sill: 850, height: 1500 },
    { id: 'w-bed', type: 'window', at: [1650, 8150], width: 1500, sill: 850, height: 1500 },
    { id: 'w-liv', type: 'window', at: [5800, 8150], width: 1800, sill: 850, height: 1500 },
  ],
  fixtures: [
    { type: 'riser', rect: [1450, 1950, 250, 250] },
    { type: 'bathtub', rect: [0, 0, 1700, 700] },
    { type: 'toilet', at: [300, 1500], rotation: 90 },
    { type: 'stove', rect: [6800, 300, 600, 600] },
  ],
  notes: ['Толщина наружной стены не подписана — принято 300 мм'],
}

const EXPECTED: Record<string, number> = {
  'С/у': 3.74,
  Гардероб: 1.53,
  Прихожая: 9.6,
  Кухня: 8.0,
  Спальня: 15.18,
  Гостиная: 17.94,
  Балкон: 4.68,
}

function compileA() {
  const spec = parsePlanSpec(EXAMPLE_A)
  return { spec, ...compilePlanSpecDetailed(spec) }
}

/** records every call; enough to exercise drawToCanvas */
function recordingCtx(): Canvas2DLike & { calls: string[] } {
  const calls: string[] = []
  const rec =
    (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name)
    }
  return {
    calls,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    rect: rec('rect'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    clip: rec('clip'),
    fillRect: rec('fillRect'),
    fillText: rec('fillText'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    setLineDash: rec('setLineDash'),
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  }
}

describe('planspec', () => {
  it('parses and validates example A without errors', () => {
    const spec = parsePlanSpec(EXAMPLE_A)
    const issues = validatePlanSpec(spec)
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([])
  })

  it('rejects malformed specs with a readable error', () => {
    expect(() => parsePlanSpec({ version: 1, units: 'mm', rooms: [{ id: 'x', rect: [0, 0, 'a', 1] }] })).toThrow()
    expect(() => parsePlanSpec(42)).toThrow()
  })

  it('compiles example A into 7 named rooms with the expected areas', () => {
    const { doc, levelId } = compileA()
    const plan = derivePlan(doc, levelId)
    const byName = new Map<string, number>()
    for (const r of plan.rooms) {
      const rec = doc.rooms[r.roomId]
      if (rec) byName.set(rec.name, r.area)
    }
    expect(plan.rooms.length).toBe(7)
    for (const [name, area] of Object.entries(EXPECTED)) {
      expect(byName.has(name), `room ${name}`).toBe(true)
      expect(Math.abs(byName.get(name)! - area), `${name}: ${byName.get(name)}`).toBeLessThan(0.08)
    }
  })

  it('places all openings of example A', () => {
    const { doc } = compileA()
    const kinds = Object.values(doc.openings).map((o) => o.kind)
    expect(kinds.filter((k) => k === 'window').length).toBe(3)
    expect(kinds.filter((k) => k === 'door').length).toBe(4)
    expect(kinds).toContain('entranceDoor')
    expect(kinds).toContain('balconyDoor')
    expect(kinds).toContain('slidingDoor')
  })

  it('round-trips through docToPlanSpec', () => {
    const { doc, levelId } = compileA()
    const spec2 = docToPlanSpec(doc, levelId)
    const doc2 = compilePlanSpec(spec2)
    const lv2 = doc2.levelOrder[0]
    const a1 = derivePlan(doc, levelId)
      .rooms.map((r) => r.area)
      .sort((a, b) => a - b)
    const a2 = derivePlan(doc2, lv2)
      .rooms.map((r) => r.area)
      .sort((a, b) => a - b)
    expect(a2.length).toBe(a1.length)
    a1.forEach((a, i) => expect(Math.abs(a - a2[i])).toBeLessThan(0.05))
    expect(Object.keys(doc2.openings).length).toBe(Object.keys(doc.openings).length)
  })
})

describe('display + exports', () => {
  it('builds a display list with walls, openings, rooms and dimensions', () => {
    const { doc, levelId } = compileA()
    const dl = buildDisplayList(doc, levelId, { dimensions: true, areas: true, titleBlock: true })
    const layers = new Set(dl.items.map((i) => i.layer))
    for (const l of ['rooms', 'walls', 'openings', 'text', 'dimensions', 'sheet']) expect(layers.has(l as never), l).toBe(true)
    expect(dl.bounds.maxX).toBeGreaterThan(dl.bounds.minX)
    expect(dl.items.some((i) => i.t === 'arc')).toBe(true)
    const texts = dl.items.filter((i) => i.t === 'text').map((i) => (i.t === 'text' ? i.text : ''))
    expect(texts).toContain('Гостиная')
    expect(texts.some((t) => /17,9\d м²/.test(t))).toBe(true)
  })

  it('exports SVG', () => {
    const { doc, levelId } = compileA()
    const dl = buildDisplayList(doc, levelId, { theme: 'blueprint' })
    const { svg, widthMm, heightMm } = toSvg(dl, { title: 'kv41' })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox=')
    expect(svg).toContain('Гостиная')
    expect(svg).toContain('Спальня')
    expect(svg).toContain('<pattern')
    expect(svg.trim().endsWith('</svg>')).toBe(true)
    expect(widthMm).toBeGreaterThan(80)
    expect(heightMm).toBeGreaterThan(100)
  })

  it('exports DXF', () => {
    const { doc, levelId } = compileA()
    const dxf = toDxf(doc, levelId)
    expect(dxf.length).toBeGreaterThan(1000)
    expect(dxf).toContain('ENTITIES')
    expect(dxf).toContain('WALLS')
    expect(dxf).toContain('LWPOLYLINE')
    expect(dxf).toContain('ARC')
    expect(dxf.trim().endsWith('EOF')).toBe(true)
  })

  it('draws to a Canvas2D-like context', () => {
    const { doc, levelId } = compileA()
    const dl = buildDisplayList(doc, levelId)
    const ctx = recordingCtx()
    drawToCanvas(ctx, dl, { pxPerMm: 0.1 })
    expect(ctx.calls.filter((c) => c === 'stroke').length).toBeGreaterThan(50)
    expect(ctx.calls).toContain('fillText')
    expect(ctx.calls).toContain('arc')
    expect(ctx.calls).toContain('clip')
    expect(ctx.calls[0]).toBe('save')
    expect(ctx.calls[ctx.calls.length - 1]).toBe('restore')
  })
})

describe('bom', () => {
  it('computes floor areas and opening counts', () => {
    const { doc, levelId } = compileA()
    const plan = derivePlan(doc, levelId)
    const total = plan.rooms.reduce((s, r) => s + r.area, 0)
    const rows = computeBom(doc)
    const floorM2 = rows.filter((r) => r.group === 'Полы' && r.unit === 'м²' && !/запас/.test(r.name)).reduce((s, r) => s + r.quantity, 0)
    expect(Math.abs(floorM2 - total)).toBeLessThan(0.05)
    const openings = rows.filter((r) => r.group === 'Двери и окна')
    const count = (re: RegExp) => openings.filter((r) => re.test(r.name)).reduce((s, r) => s + r.quantity, 0)
    expect(count(/^Окно/)).toBe(3)
    expect(count(/^Дверь межкомнатная/)).toBe(4)
    expect(count(/^Дверь входная/)).toBe(1)
    const walls = rows.filter((r) => r.group === 'Стены' && r.unit === 'м²').reduce((s, r) => s + r.quantity, 0)
    expect(walls).toBeGreaterThan(80)
    expect(walls).toBeLessThan(200)
    expect(rows.some((r) => r.group === 'Мебель и оборудование')).toBe(true)
    for (const r of rows) expect(Number.isFinite(r.quantity) && r.quantity >= 0, r.name).toBe(true)
  })
})
