import { describe, expect, it } from 'vitest'
import { derivePlan } from '../derive'
import { displayListBounds } from '../display'
import { parseDoc, serializeDoc } from '../io'
import { compilePlanSpecDetailed, parsePlanSpec } from '../planspec'
import {
  captureBaseline,
  composeAlbum,
  defaultAlbumSettings,
  fixtureOutlets,
  pageDisplayList,
  pageDxf,
  pageFileName,
  pageSvg,
  planDiff,
  readAlbumSettings,
  roomFaces,
  roomFinishes,
  splitTable,
  tableHeight,
  type Table,
} from '../techproject'
import { tileJoints } from '../techproject/annot'
import type { Doc, Wall } from '../types'
import { DOC_VERSION_V5 } from '../types'

const SPEC = {
  version: 1,
  units: 'mm',
  name: 'Тестовая квартира',
  defaults: { ceilingHeight: 2700, exteriorThickness: 300, loadBearingThickness: 200, partitionThickness: 100 },
  snap: { orthogonal: true, gridMm: 10 },
  rooms: [
    { id: 'bath', name: 'С/у', type: 'combinedBathroom', rect: [0, 0, 1700, 2200] },
    { id: 'hall', name: 'Прихожая', type: 'hall', rect: [1800, 0, 3000, 3200] },
    { id: 'kitchen', name: 'Кухня', type: 'kitchen', rect: [4900, 0, 2500, 3200] },
    { id: 'bed', name: 'Спальня', type: 'bedroom', rect: [0, 3400, 3300, 4600] },
    { id: 'living', name: 'Гостиная', type: 'living', rect: [3500, 3400, 3900, 4600] },
  ],
  openings: [
    { id: 'd-entr', type: 'entranceDoor', at: [3050, -150], width: 900, between: ['hall', 'outside'], opensInto: 'outside', hinge: 'left' },
    { id: 'd-bath', type: 'door', at: [1750, 1000], width: 700, between: ['bath', 'hall'], opensInto: 'hall', hinge: 'right' },
    { id: 'd-kit', type: 'door', at: [4850, 2400], width: 800, between: ['hall', 'kitchen'], opensInto: 'kitchen', hinge: 'left' },
    { id: 'd-bed', type: 'door', at: [2500, 3300], width: 800, between: ['hall', 'bed'], opensInto: 'bed', hinge: 'right' },
    { id: 'd-liv', type: 'door', at: [4100, 3300], width: 800, between: ['hall', 'living'], opensInto: 'living', hinge: 'left' },
    { id: 'w-kit', type: 'window', at: [7550, 1600], width: 1200, sill: 850, height: 1500 },
    { id: 'w-liv', type: 'window', at: [5800, 8150], width: 1800, sill: 850, height: 1500 },
  ],
  fixtures: [
    { type: 'bathtub', rect: [0, 0, 1700, 700] },
    { type: 'toilet', at: [300, 1500], rotation: 90 },
  ],
}

function compile(): { doc: Doc; levelId: string } {
  const { doc, levelId } = compilePlanSpecDetailed(parsePlanSpec(SPEC))
  return { doc, levelId }
}

/** the wall between the bedroom and the living room (x ≈ 3400, y 3400…8000) */
function partition(doc: Doc): Wall {
  const w = Object.values(doc.walls).find((w) => {
    const a = doc.nodes[w.a]
    const b = doc.nodes[w.b]
    return Math.abs(a.x - 3400) < 60 && Math.abs(b.x - 3400) < 60 && Math.min(a.y, b.y) > 3000
  })
  if (!w) throw new Error('no partition')
  return w
}

describe('technical project album', () => {
  it('composes numbered A3 sheets with the title page first and the sheet list', () => {
    const { doc } = compile()
    const s = defaultAlbumSettings(doc, { today: '2026-11-21' })
    expect(s.format).toBe('A3')
    expect(s.author).toBeUndefined()
    const album = composeAlbum(doc, s, { today: '2026-11-21' })
    expect(album.pages.length).toBeGreaterThan(8)
    expect(album.pages[0].kind).toBe('title')
    expect(album.pages[0].bare).toBe(true)
    album.pages.forEach((p, i) => expect(p.no).toBe(i + 1))
    expect(album.toc.map((t) => t.sheet)).toEqual(album.pages.map((p) => p.no))
    const kinds = new Set(album.pages.map((p) => p.kind))
    for (const k of ['general', 'measure', 'floors', 'ceilings', 'plumbing', 'elevations', 'specOpenings', 'finishes'] as const) expect(kinds.has(k), k).toBe(true)
    // demolition needs a fixed measurement plan
    expect(kinds.has('demolition')).toBe(false)
  })

  it('keeps every sheet inside the page and writes the sheet count into the title block', () => {
    const { doc } = compile()
    const album = composeAlbum(doc, defaultAlbumSettings(doc, { today: '2026-11-21' }))
    for (const p of album.pages) {
      const dl = pageDisplayList(album, p)
      const b = displayListBounds(dl)
      expect(b.minX, p.title).toBeGreaterThanOrEqual(-0.5)
      expect(b.minY, p.title).toBeGreaterThanOrEqual(-0.5)
      expect(b.maxX, p.title).toBeLessThanOrEqual(420.5)
      expect(b.maxY, p.title).toBeLessThanOrEqual(297.5)
      if (!p.bare) {
        const texts = dl.items.filter((it) => it.t === 'text').map((it) => (it.t === 'text' ? it.text : ''))
        expect(texts).toContain(String(album.pages.length))
        expect(texts).toContain(String(p.no))
      }
    }
    const svg = pageSvg(album, album.pages[2])
    expect(svg.widthMm).toBe(420)
    expect(svg.svg).toContain('<svg')
    // DXF of a plan sheet: real millimetres, the frame on SHEET
    const measure = album.pages.find((p) => p.kind === 'measure')!
    const dxf = pageDxf(album, measure)
    expect(dxf).toContain('SHEET')
    expect(dxf).toContain('WALLS')
    expect(pageFileName(measure, album.pages.length)).toMatch(/^0\d Обмерный план$/)
  })

  it('draws plumbing outlets from the fixtures and wall faces of the bathroom', () => {
    const { doc, levelId } = compile()
    const album = composeAlbum(doc, defaultAlbumSettings(doc))
    const ctx = { doc, settings: album.settings, plans: { [levelId]: derivePlan(doc, levelId) }, levels: [levelId], paper: album.paper, date: album.date }
    const outs = fixtureOutlets(ctx, doc, levelId)
    expect(outs.some((o) => o.code === 'К1' && o.h === 200)).toBe(true) // toilet
    expect(outs.some((o) => o.code === 'Т3' && o.h === 800)).toBe(true) // bathtub mixer
    const bath = ctx.plans[levelId].rooms.find((r) => doc.rooms[r.roomId]?.name === 'С/у')!
    expect(roomFaces(doc, bath).length).toBe(4)
    expect(album.pages.some((p) => p.kind === 'elevations' && p.title.includes('С/у'))).toBe(true)
  })

  it('splits long tables repeating the header', () => {
    const t: Table = { title: 'T', columns: [{ title: 'A', width: 20 }, { title: 'B', width: 40 }], rows: Array.from({ length: 80 }, (_, i) => [String(i), 'x']) }
    const parts = splitTable(t, 100, 200)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.reduce((s, p) => s + p.rows.length, 0)).toBe(80)
    for (const p of parts) expect(tableHeight(p)).toBeLessThanOrEqual(200.01)
    expect(parts[1].title).toContain('продолжение')
  })

  it('clips tile joints to the room and its holes', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ]
    const hole = [
      { x: 400, y: 400 },
      { x: 600, y: 400 },
      { x: 600, y: 600 },
      { x: 400, y: 600 },
    ]
    const lines = tileJoints([ring, hole], { x: 0, y: 0 }, 300, 300, 0, 'grid', { color: '#000', width: 0.1 })
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      if (l.t !== 'line') continue
      for (const p of [l.a, l.b]) {
        expect(p.x).toBeGreaterThanOrEqual(-0.01)
        expect(p.x).toBeLessThanOrEqual(1000.01)
      }
      // no joint crosses the middle of the hole
      const mx = (l.a.x + l.b.x) / 2
      const my = (l.a.y + l.b.y) / 2
      expect(mx > 401 && mx < 599 && my > 401 && my < 599).toBe(false)
    }
  })

  it('finds demolished and new walls against the fixed measurement plan and keeps it in the file', () => {
    const { doc, levelId } = compile()
    doc.techProject = { baseline: captureBaseline(doc, '2026-11-01T00:00:00.000Z') }
    expect(planDiff(doc, levelId)).toEqual({ demolished: [], built: [], openings: [] })
    // remove the bedroom / living partition, add a new one across the living room
    const w = partition(doc)
    delete doc.walls[w.id]
    for (const id of Object.keys(doc.openings)) if (doc.openings[id].wallId === w.id) delete doc.openings[id]
    doc.nodes.n_new1 = { id: 'n_new1', levelId, x: 3500, y: 6000 }
    doc.nodes.n_new2 = { id: 'n_new2', levelId, x: 5500, y: 6000 }
    doc.walls.w_new = { ...w, id: 'w_new', a: 'n_new1', b: 'n_new2', kind: 'partition', thickness: 100 }
    const diff = planDiff(doc, levelId)!
    expect(diff.demolished.length).toBe(1)
    expect(diff.demolished[0].length).toBeGreaterThan(4000)
    expect(diff.built.length).toBe(1)
    expect(Math.round(diff.built[0].length)).toBe(2000)
    const album = composeAlbum(doc, defaultAlbumSettings(doc))
    expect(album.pages.some((p) => p.kind === 'demolition' && !p.empty)).toBe(true)
    expect(album.pages.some((p) => p.kind === 'construction' && !p.empty)).toBe(true)
    // format 5 round trip
    const back = parseDoc(JSON.parse(serializeDoc(doc)))
    expect(back.version).toBe(DOC_VERSION_V5)
    expect(Object.keys(back.techProject!.baseline!.walls).length).toBe(Object.keys(doc.techProject.baseline!.walls).length)
    expect(back.techProject!.baseline!.takenAt).toBe('2026-11-01T00:00:00.000Z')
  })

  it('reads saved album settings over the defaults', () => {
    const { doc } = compile()
    doc.techProject = { album: { format: 'A4', orientation: 'portrait', stage: 'ЭП', sheets: [{ kind: 'floors', on: true, scale: 75 }, { kind: 'bogus' }], author: 7 } }
    const s = readAlbumSettings(doc)
    expect(s.format).toBe('A4')
    expect(s.stage).toBe('ЭП')
    expect(s.sheets[0]).toEqual({ kind: 'floors', on: true, scale: 75 })
    expect(s.sheets.length).toBeGreaterThan(10)
    expect(s.author).toBeUndefined()
    const album = composeAlbum(doc, s)
    const floors = album.pages.find((p) => p.kind === 'floors')!
    expect(floors.scale).toBe(75)
    expect(album.paper).toEqual({ width: 210, height: 297 })
  })

  it('lists finishes per room with walls net of openings', () => {
    const { doc, levelId } = compile()
    const album = composeAlbum(doc, defaultAlbumSettings(doc))
    const ctx = { doc, settings: album.settings, plans: { [levelId]: derivePlan(doc, levelId) }, levels: [levelId], paper: album.paper, date: album.date }
    const list = roomFinishes(ctx)
    const kitchen = list.find((f) => doc.rooms[f.room.roomId]?.name === 'Кухня')!
    const walls = kitchen.walls.reduce((s, w) => s + w.area, 0)
    const gross = (kitchen.room.perimeter * kitchen.ceiling.height) / 1000
    // the door and the window are cut out
    expect(walls).toBeLessThan(gross - 0.8 * 2.1 - 1.2 * 1.5 + 0.2)
    expect(walls).toBeGreaterThan(gross - 5)
  })
})
