import { describe, expect, it } from 'vitest'
import { compilePlanSpecDetailed, parsePlanSpec } from '../planspec'
import { BUILTIN_MATERIALS } from '../defaults'
import {
  bomToCsv,
  bomTotals,
  computeBom,
  decodeCsvBytes,
  formatMoney,
  localDate,
  parsePriceListCsv,
  priceListToCsv,
  productFor,
  productUrl,
  wallpaperStrip,
  wasteFor,
  type BomRow,
} from '../bom'
import { parseDoc, serializeDoc } from '../io'
import type { Doc, Material, TilePattern } from '../types'

const SPEC = {
  version: 1,
  units: 'mm',
  name: 'Estimate test',
  defaults: { ceilingHeight: 2700, exteriorThickness: 300, loadBearingThickness: 200, partitionThickness: 100 },
  rooms: [{ id: 'r', name: 'Комната', type: 'living', rect: [0, 0, 3000, 4000] }],
}

const TILE = BUILTIN_MATERIALS.find((m) => m.category === 'tile')!
const PAINT_ID = 'mat_ncs_0502_y'

function build(): { doc: Doc; roomId: string } {
  const r = compilePlanSpecDetailed(parsePlanSpec(SPEC))
  const roomId = Object.keys(r.doc.rooms)[0]
  return { doc: r.doc, roomId }
}

const floorTileRow = (rows: BomRow[]) => rows.find((r) => r.group === 'Полы' && r.purchase && r.unit === 'шт')!

function withFloorTile(pattern: TilePattern) {
  const { doc, roomId } = build()
  doc.rooms[roomId].floor = { ...doc.rooms[roomId].floor, materialId: TILE.id, pattern }
  return { doc, roomId }
}

const GRID: TilePattern = { type: 'grid', tileW: 600, tileH: 600, grout: 2, groutColor: '#bdbdbd', rotation: 0 }

describe('estimate: waste', () => {
  it('defaults by layout, pattern override wins', () => {
    expect(wasteFor('grid')).toBe(0.1)
    expect(wasteFor('diagonal')).toBe(0.15)
    expect(wasteFor('herringbone')).toBe(0.2)
    expect(wasteFor('chevron')).toBe(0.2)
    expect(wasteFor('herringbone', { ...GRID, type: 'herringbone', waste: 0.07 })).toBe(0.07)
  })

  it('herringbone floor buys more tiles than straight; own waste is used', () => {
    const straight = floorTileRow(computeBom(withFloorTile(GRID).doc))
    const herring = floorTileRow(computeBom(withFloorTile({ ...GRID, type: 'herringbone' }).doc))
    const tight = floorTileRow(computeBom(withFloorTile({ ...GRID, waste: 0.02 }).doc))
    expect(herring.quantity).toBeGreaterThan(straight.quantity)
    expect(tight.quantity).toBeLessThan(straight.quantity)
    expect(herring.note).toContain('запас 20%')
    expect(tight.note).toContain('запас 2%')
  })
})

describe('estimate: wall layouts and wallpaper', () => {
  it('wall side pattern turns a wall finish into a tile count', () => {
    const { doc } = build()
    for (const w of Object.values(doc.walls)) {
      w.left = { materialId: TILE.id, pattern: { ...GRID, tileW: 300, tileH: 75, type: 'brick' } }
      w.right = { materialId: TILE.id, pattern: { ...GRID, tileW: 300, tileH: 75, type: 'brick' } }
    }
    const rows = computeBom(doc)
    const tile = rows.find((r) => r.group === 'Стены' && r.purchase)!
    expect(tile.name).toContain('300×75')
    expect(tile.unit).toBe('шт')
  })

  it('zone pattern is counted apart from the side finish', () => {
    const { doc } = build()
    for (const w of Object.values(doc.walls))
      for (const s of [w.left, w.right]) {
        s.materialId = PAINT_ID
        s.zones = [{ from: 0, to: 1200, materialId: TILE.id, pattern: { ...GRID, tileW: 200, tileH: 100 } }]
      }
    const rows = computeBom(doc)
    expect(rows.some((r) => r.group === 'Стены' && r.name.includes('200×100'))).toBe(true)
    expect(rows.some((r) => r.group === 'Стены' && r.unit === 'л')).toBe(true)
  })

  it('pattern repeat lengthens wallpaper strips and never lowers the roll count', () => {
    expect(wallpaperStrip(2600)).toBe(2700)
    expect(wallpaperStrip(2600, 640)).toBe(3200)
    expect(wallpaperStrip(2600, 640, 'offset')).toBe(3520)
    expect(wallpaperStrip(2600, 640, 'free')).toBe(2700)

    const rolls = (repeat?: number) => {
      const { doc } = build()
      const wp: Material = {
        id: 'm_wp',
        name: 'Обои тест',
        category: 'wallpaper',
        color: '#ddd',
        roughness: 0.8,
        metalness: 0,
        wallpaper: { rollW: 530, rollL: 10050, ...(repeat ? { repeat } : {}) },
      }
      doc.materials[wp.id] = wp
      for (const w of Object.values(doc.walls)) {
        w.left = { materialId: wp.id }
        w.right = { materialId: wp.id }
      }
      return computeBom(doc).find((r) => r.unit === 'рул.')!.quantity
    }
    expect(rolls(1500)).toBeGreaterThanOrEqual(rolls())
  })
})

describe('estimate: prices', () => {
  it('a per-m² price goes on the tile purchase row through its m² equivalent', () => {
    const { doc } = withFloorTile(GRID)
    doc.design = { currency: 'KZT', priceList: { [TILE.id]: { price: 5000, priceUnit: 'м²', vendor: 'Shop', url: 'https://example.com/t' } } }
    const rows = computeBom(doc)
    const tile = floorTileRow(rows)
    expect(tile.price).toBe(5000)
    expect(tile.priceUnit).toBe('м²')
    expect(tile.total).toBeCloseTo(5000 * tile.alt!['м²']!, 2)
    expect(rows.filter((r) => r.refId === TILE.id).every((r) => r.vendor === 'Shop' && r.url === 'https://example.com/t')).toBe(true)
    const t = bomTotals(rows)
    expect(t.total).toBeCloseTo(tile.total!, 2)
    expect(t.byGroup['Полы']).toBeCloseTo(tile.total!, 2)
    expect(t.priced).toBe(1)
    expect(t.unpriced).toBeGreaterThan(0)
  })

  it('a box size is used even when the tile is priced per m²', () => {
    const { doc } = withFloorTile(GRID)
    doc.design = { priceList: { [TILE.id]: { price: 7900.5, priceUnit: 'м²', pack: 1.44 } } }
    const tile = floorTileRow(computeBom(doc))
    expect(tile.alt!['уп.']).toBe(Math.ceil(tile.alt!['м²']! / 1.44))
    expect(tile.note).toContain('уп. по 1,44 м²')
    expect(tile.priceUnit).toBe('м²')
  })

  it('price dates are local, not UTC', () => {
    expect(localDate(new Date(2026, 10, 15, 0, 30))).toBe('2026-11-15')
  })

  it('a price without a unit goes on the purchase row in its own unit', () => {
    const { doc } = withFloorTile(GRID)
    doc.design = { priceList: { [TILE.id]: { price: 300 } } }
    const tile = floorTileRow(computeBom(doc))
    expect(tile.priceUnit).toBe('шт')
    expect(tile.total).toBeCloseTo(300 * tile.quantity, 2)
  })

  it('project price list entry overrides the material card field by field', () => {
    const { doc } = build()
    doc.materials.m_x = { id: 'm_x', name: 'X', category: 'paint', color: '#fff', roughness: 1, metalness: 0, product: { vendor: 'Card', price: 1, priceUnit: 'л' } }
    doc.design = { priceList: { m_x: { price: 2 } } }
    expect(productFor(doc, undefined, 'm_x')).toMatchObject({ vendor: 'Card', price: 2, priceUnit: 'л' })
  })

  it('formats money in the project currency, plain number without one', () => {
    expect(formatMoney(12500, 'KZT')).toMatch(/12\s?500/)
    expect(formatMoney(12500, 'KZT')).toContain('₸')
    expect(formatMoney(12500)).not.toMatch(/[₸₽$€]/)
    expect(formatMoney(10, 'XQQ')).toContain('XQQ')
  })

  it('estimate CSV carries price columns and a total line', () => {
    const { doc } = withFloorTile(GRID)
    doc.design = { currency: 'EUR', priceList: { [TILE.id]: { price: 2.5 } } }
    const csv = bomToCsv(computeBom(doc), 'EUR')
    expect(csv.split('\n')[0]).toContain('Цена (EUR)')
    expect(csv).toMatch(/\nИтого;/)
  })

  it('price list CSV round trip', () => {
    const { doc } = withFloorTile(GRID)
    const rows = computeBom(doc)
    const csv = priceListToCsv(rows, doc)
    const lines = csv.split('\n')
    expect(lines[0].startsWith('id;')).toBe(true)
    // fill the tile line's price, as a user would in a spreadsheet
    const i = lines.findIndex((l) => l.startsWith(`${TILE.id};`))
    expect(i).toBeGreaterThan(0)
    const cells = lines[i].split(';')
    cells[3] = '1 234,50'
    cells[5] = 'Shop'
    lines[i] = cells.join(';')
    const res = parsePriceListCsv(`﻿${lines.join('\r\n')}`, '2026-01-01')
    expect(res.skipped).toEqual([])
    // untouched lines have no price and are not imported
    expect(Object.keys(res.entries)).toEqual([TILE.id])
    expect(res.entries[TILE.id]).toMatchObject({ price: 1234.5, vendor: 'Shop', source: 'csv', updatedAt: '2026-01-01', priceUnit: 'шт' })
  })

  it('price list CSV without an id column is rejected, comma separator works', () => {
    expect(parsePriceListCsv('name;price\nx;1').skipped).toEqual([1])
    const res = parsePriceListCsv('id,price,unit\nm_a,10,м²', '2026-01-01')
    expect(res.entries.m_a).toMatchObject({ price: 10, priceUnit: 'м²' })
  })
})

describe('estimate: file format', () => {
  it('currency, price list, product cards, wallpaper and layout offsets survive save/load', () => {
    const { doc, roomId } = withFloorTile({ ...GRID, offsetX: 150, offsetY: -40, waste: 0.12 })
    doc.design = { ...(doc.design ?? {}), currency: 'kzt', priceList: { [TILE.id]: { price: 5000, priceUnit: 'м²', source: 'manual', updatedAt: '2026-01-01' } } }
    doc.materials.m_wp = {
      id: 'm_wp',
      name: 'Обои',
      category: 'wallpaper',
      color: '#eee',
      roughness: 0.8,
      metalness: 0,
      wallpaper: { rollW: 1060, rollL: 10050, repeat: 640, match: 'offset' },
      paint: { coverage: 9 },
      product: { vendor: 'V', sku: 'S-1', url: 'https://example.com/w', price: 4200, priceUnit: 'рул.', pack: 1, source: 'link' },
    }
    const wall = Object.values(doc.walls)[0]
    wall.left = { materialId: TILE.id, pattern: { ...GRID, offsetX: 10 }, zones: [{ from: 0, to: 900, materialId: PAINT_ID, label: 'Фартук', pattern: GRID }] }

    const back = parseDoc(serializeDoc(doc))
    expect(back.design?.currency).toBe('KZT')
    expect(back.design?.priceList?.[TILE.id]).toMatchObject({ price: 5000, priceUnit: 'м²', source: 'manual' })
    expect(back.materials.m_wp.wallpaper).toEqual({ rollW: 1060, rollL: 10050, repeat: 640, match: 'offset' })
    expect(back.materials.m_wp.product).toMatchObject({ vendor: 'V', sku: 'S-1', url: 'https://example.com/w', price: 4200, priceUnit: 'рул.', pack: 1 })
    expect(back.rooms[roomId].floor.pattern).toMatchObject({ offsetX: 150, offsetY: -40, waste: 0.12 })
    const lw = back.walls[wall.id].left
    expect(lw.pattern?.offsetX).toBe(10)
    expect(lw.zones?.[0]).toMatchObject({ label: 'Фартук', pattern: { type: 'grid' } })
  })
})

describe('estimate: review fixes', () => {
  it('one material in two wall layouts: both purchase rows are priced and counted in the total', () => {
    const { doc } = build()
    for (const w of Object.values(doc.walls))
      for (const s of [w.left, w.right]) {
        s.materialId = TILE.id
        s.pattern = { ...GRID, tileW: 300, tileH: 75, type: 'brick' }
        s.zones = [{ from: 0, to: 1200, materialId: TILE.id, pattern: { ...GRID, tileW: 200, tileH: 100 } }]
      }
    doc.design = { priceList: { [TILE.id]: { price: 4000, priceUnit: 'м²' } } }
    const rows = computeBom(doc)
    const buy = rows.filter((r) => r.group === 'Стены' && r.refId === TILE.id && r.purchase)
    expect(buy).toHaveLength(2)
    for (const r of buy) expect(r.total).toBeCloseTo(4000 * r.alt!['м²']!, 2)
    expect(bomTotals(rows).byGroup['Стены']).toBeCloseTo(buy[0].total! + buy[1].total!, 2)
  })

  it('tile m² and boxes use the tile face, the count uses the laying pitch', () => {
    const { doc } = withFloorTile({ ...GRID, tileW: 100, tileH: 100, grout: 2 })
    doc.design = { priceList: { [TILE.id]: { price: 1000, priceUnit: 'м²', pack: 1 } } }
    const tile = floorTileRow(computeBom(doc))
    // 12 m² × 1.1 / (0.102 × 0.102) tiles, each 0.01 m² of face
    expect(tile.quantity).toBe(Math.ceil((12 * 1.1) / (0.102 * 0.102)))
    expect(tile.alt!['м²']).toBeCloseTo(tile.quantity * 0.01, 2)
    expect(tile.alt!['уп.']).toBe(Math.ceil(tile.quantity * 0.01))
  })

  it('plank waste falls back to the layout stored on the material', () => {
    const { doc, roomId } = build()
    doc.materials.m_lam = {
      id: 'm_lam',
      name: 'Ламинат ёлка',
      category: 'laminate',
      color: '#a87',
      roughness: 0.6,
      metalness: 0,
      pattern: { type: 'chevron', tileW: 600, tileH: 100, grout: 0, groutColor: '#000', rotation: 0 },
    }
    const floor = { ...doc.rooms[roomId].floor, materialId: 'm_lam' }
    delete floor.pattern
    doc.rooms[roomId].floor = floor
    const packs = computeBom(doc).find((r) => r.group === 'Полы' && r.unit === 'уп.')!
    expect(packs.note).toContain('запасом 20%')
  })

  it('price list CSV in Windows-1251 is decoded, UTF-8 BOM is dropped', () => {
    // "id;цена" in cp1251
    const cp = new Uint8Array([0x69, 0x64, 0x3b, 0xf6, 0xe5, 0xed, 0xe0])
    expect(decodeCsvBytes(cp)).toBe('id;цена')
    const utf = new TextEncoder().encode('\uFEFFid;цена')
    expect(decodeCsvBytes(utf)).toBe('id;цена')
  })

  it('product links: http(s) kept, bare domains get https, other schemes rejected', () => {
    expect(productUrl('https://shop.kz/item?id=1')).toBe('https://shop.kz/item?id=1')
    expect(productUrl(' shop.kz/item ')).toBe('https://shop.kz/item')
    expect(productUrl('javascript:alert(1)')).toBeUndefined()
    expect(productUrl('file:///C:/x')).toBeUndefined()
    expect(productUrl('просто текст')).toBeUndefined()
    expect(parsePriceListCsv('id;price;url\nm_a;10;javascript:alert(1)\nm_b;5;shop.kz/b').entries).toMatchObject({
      m_a: { price: 10 },
      m_b: { url: 'https://shop.kz/b' },
    })
    expect(parsePriceListCsv('id;price;url\nm_a;10;javascript:alert(1)').entries.m_a.url).toBeUndefined()
  })

  it('estimate CSV header and total line go through the translator', () => {
    const { doc } = withFloorTile(GRID)
    doc.design = { currency: 'EUR', priceList: { [TILE.id]: { price: 2.5 } } }
    const tr = (s: string) => ({ Цена: 'Price', Итого: 'Total' })[s] ?? s
    const csv = bomToCsv(computeBom(doc), 'EUR', tr)
    expect(csv.split('\n')[0]).toContain('Price (EUR)')
    expect(csv).toMatch(/\nTotal;/)
  })
})
