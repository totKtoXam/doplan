/**
 * Starter sample apartment built entirely through core ops (so it is a valid, normalised document):
 * living room, bedroom, kitchen, hallway and bathroom with doors, windows, finishes, furniture and lights.
 */
import { produce } from 'immer'
import {
  addItem,
  addLight,
  addOpening,
  addRectRoom,
  addWall,
  applyFinishToWallSide,
  BUILTIN_ASSETS,
  BUILTIN_MATERIALS,
  createEmptyDoc,
  defaultCurtain,
  derivePlan,
  normalize,
  ROOM_TYPE_NAMES,
  syncRooms,
} from '@core'
import type {
  Asset,
  DerivedRoom,
  Doc,
  Id,
  Material,
  MaterialCategory,
  OpeningKind,
  ProceduralKind,
  RoomType,
  TilePattern,
  Vec2,
} from '@core/types'

const EXT = 250 // exterior wall thickness, mm
const INT = 100 // partition thickness, mm

function insidePolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** wall of the level whose centreline passes closest to `p`, with the offset of `p` along it */
function wallAt(doc: Doc, levelId: Id, p: Vec2): { wallId: Id; offset: number } | null {
  let best: { wallId: Id; offset: number; d: number } | null = null
  for (const w of Object.values(doc.walls)) {
    if (w.levelId !== levelId) continue
    const a = doc.nodes[w.a]
    const b = doc.nodes[w.b]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    if (l2 < 1) continue
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    const qx = a.x + dx * t
    const qy = a.y + dy * t
    const d = Math.hypot(p.x - qx, p.y - qy)
    if (!best || d < best.d) best = { wallId: w.id, offset: t * Math.sqrt(l2), d }
  }
  return best && best.d < 50 ? { wallId: best.wallId, offset: best.offset } : null
}

function pickMaterial(cats: MaterialCategory[], hint?: RegExp): Material | undefined {
  for (const c of cats) {
    const list = BUILTIN_MATERIALS.filter((m: Material) => m.category === c)
    const hinted = hint ? list.find((m: Material) => hint.test(`${m.id} ${m.name} ${m.nameRu ?? ''}`)) : undefined
    if (hinted) return hinted
    if (list.length) return list[0]
  }
  return undefined
}

function assetOf(kind: ProceduralKind): Asset | undefined {
  return BUILTIN_ASSETS.find((a: Asset) => a.procedural === kind)
}

export function buildSampleApartment(name = 'Пример квартиры'): Doc {
  const base = createEmptyDoc(name)
  return produce(base, (d: Doc) => {
    const lv = d.levelOrder[0]
    const level = d.levels[lv]
    const H = level.height || d.settings.wallHeight || 2700

    // ── walls ──
    addRectRoom(d, lv, 0, 0, 10000, 7200, { thickness: EXT, height: H })
    addWall(d, lv, { x: 0, y: 4400 }, { x: 10000, y: 4400 }, { thickness: INT, height: H, kind: 'partition' })
    addWall(d, lv, { x: 5600, y: 0 }, { x: 5600, y: 4400 }, { thickness: INT, height: H, kind: 'partition' })
    addWall(d, lv, { x: 3600, y: 4400 }, { x: 3600, y: 7200 }, { thickness: INT, height: H, kind: 'partition' })
    addWall(d, lv, { x: 7400, y: 4400 }, { x: 7400, y: 7200 }, { thickness: INT, height: H, kind: 'partition' })
    normalize(d)

    // ── openings ──
    const openings: [Vec2, OpeningKind][] = [
      [{ x: 5000, y: 7200 }, 'entranceDoor'],
      [{ x: 4600, y: 4400 }, 'door'],
      [{ x: 6500, y: 4400 }, 'door'],
      [{ x: 7400, y: 6300 }, 'door'],
      [{ x: 3600, y: 5800 }, 'arch'],
      [{ x: 1500, y: 0 }, 'window'],
      [{ x: 4000, y: 0 }, 'window'],
      [{ x: 7800, y: 0 }, 'balconyDoor'],
      [{ x: 0, y: 5800 }, 'window'],
    ]
    for (const [p, kind] of openings) {
      const hit = wallAt(d, lv, p)
      if (!hit) continue
      try {
        const id = addOpening(d, hit.wallId, kind, hit.offset)
        const o = d.openings[id]
        if (o && (kind === 'window' || kind === 'balconyDoor')) {
          o.curtain = { ...defaultCurtain(), kind: 'drapesAndSheer', closed: 0.15, overhang: 200, fullHeight: true }
          // curtains hang on the room side: the outer wall's inner side faces +y for the top wall
          const w = d.walls[o.wallId]
          const a = d.nodes[w.a]
          const b = d.nodes[w.b]
          // left normal of a→b in y-down coords is (dy, -dx)
          const nx = b.y - a.y
          const ny = -(b.x - a.x)
          const toCentre = { x: 5000 - p.x, y: 3600 - p.y }
          o.curtain.side = nx * toCentre.x + ny * toCentre.y > 0 ? 'left' : 'right'
        }
      } catch (err) {
        console.warn('[doplan] sample opening failed', err)
      }
    }
    normalize(d)
    syncRooms(d)

    // ── rooms: types, names, finishes ──
    const plan = derivePlan(d, lv)
    const wood = pickMaterial(['parquet', 'wood', 'laminate'], /oak|дуб/i)
    const floorTile = pickMaterial(['tile', 'stone', 'concrete'], /grey|gray|сер/i)
    const wallTile = pickMaterial(['tile'], /white|бел/i) ?? floorTile
    const accentPaint = pickMaterial(['paint'], /green|sage|зел|olive/i) ?? pickMaterial(['paint'])
    const hallFloor = pickMaterial(['stone', 'tile', 'concrete'], /terrazzo|marble|beige|беж/i) ?? floorTile

    const herringbone: TilePattern = { type: 'herringbone', tileW: 600, tileH: 100, grout: 1, groutColor: '#3b2f25', rotation: 0, variation: 0.25 }
    const planks: TilePattern = { type: 'planks', tileW: 1200, tileH: 180, grout: 1, groutColor: '#3b2f25', rotation: 0, variation: 0.2 }
    const tileGrid = (size: number, color: string): TilePattern => ({ type: 'grid', tileW: size, tileH: size, grout: 2, groutColor: color, rotation: 0 })

    const specs: { at: Vec2; type: RoomType; floor?: { m?: Material; pattern?: TilePattern }; wallTile?: boolean; accent?: boolean }[] = [
      { at: { x: 2800, y: 2200 }, type: 'living', floor: { m: wood, pattern: herringbone }, accent: true },
      { at: { x: 7800, y: 2200 }, type: 'bedroom', floor: { m: wood, pattern: planks } },
      { at: { x: 1800, y: 5800 }, type: 'kitchen', floor: { m: floorTile, pattern: tileGrid(600, '#9a9a96') } },
      { at: { x: 5500, y: 5800 }, type: 'hallway', floor: { m: hallFloor, pattern: tileGrid(600, '#b8b2a8') } },
      { at: { x: 8700, y: 5800 }, type: 'bathroom', floor: { m: floorTile, pattern: tileGrid(300, '#d8d8d4') }, wallTile: true },
    ]
    for (const s of specs) {
      const dr = plan.rooms.find((r: DerivedRoom) => insidePolygon(s.at, r.polygon))
      if (!dr) continue
      const room = d.rooms[dr.roomId]
      if (!room) continue
      room.type = s.type
      room.name = ROOM_TYPE_NAMES[s.type]?.ru ?? room.name
      if (s.floor?.m) room.floor = { ...room.floor, materialId: s.floor.m.id, pattern: s.floor.pattern }
      if (s.type === 'bathroom') room.skirting = 0
      if (s.type === 'living') room.ceiling = { ...room.ceiling, kind: 'multilevel', borderWidth: 600, borderDrop: 100, coveLight: true, cornice: 0 }
      try {
        if (s.wallTile && wallTile) {
          for (const e of dr.edges) applyFinishToWallSide(d, e.wallId, e.side, wallTile.id)
        }
        if (s.accent && accentPaint) {
          // accent the longest wall face of the living room
          const longest = [...dr.edges].sort(
            (a, b) => Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y) - Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y),
          )[0]
          if (longest) applyFinishToWallSide(d, longest.wallId, longest.side, accentPaint.id)
        }
      } catch (err) {
        console.warn('[doplan] sample finish failed', err)
      }
    }

    // ── furniture ──
    const inner = EXT / 2
    const part = INT / 2
    const put = (kind: ProceduralKind, place: (a: Asset) => { x: number; y: number; rotation: number }) => {
      const asset = assetOf(kind)
      if (!asset) return
      const p = place(asset)
      try {
        addItem(d, lv, asset, p.x, p.y, { rotation: p.rotation })
      } catch (err) {
        console.warn('[doplan] sample item failed', kind, err)
      }
    }
    // rotation 0 → front faces +y (down on the plan); 180 → up; 90 → left; 270 → right
    // living room (0..5600 × 0..4400)
    put('sofa', (a) => ({ x: 2800, y: 4400 - part - a.size.d / 2 - 250, rotation: 180 }))
    put('rug', () => ({ x: 2800, y: 2700, rotation: 0 }))
    put('table', (a) => ({ x: 2800, y: 4400 - part - 250 - 1000 - a.size.d / 2 - 200, rotation: 0 }))
    put('tv', (a) => ({ x: 2800, y: inner + a.size.d / 2 + 30, rotation: 0 }))
    put('shelf', (a) => ({ x: inner + a.size.d / 2 + 20, y: 2000, rotation: 270 }))
    put('plantPot', (a) => ({ x: 5600 - part - a.size.w / 2 - 150, y: inner + a.size.d / 2 + 150, rotation: 0 }))
    put('radiator', (a) => ({ x: 1500, y: inner + a.size.d / 2 + 40, rotation: 0 }))
    // bedroom (5600..10000 × 0..4400)
    put('bed', (a) => ({ x: 10000 - inner - a.size.d / 2 - 20, y: 2400, rotation: 90 }))
    put('wardrobe', (a) => ({ x: 5600 + part + a.size.d / 2 + 10, y: 1700, rotation: 270 }))
    put('rug', () => ({ x: 8300, y: 2400, rotation: 90 }))
    // kitchen (0..3600 × 4400..7200)
    const kb = assetOf('kitchenBase')
    const kw = kb?.size.w ?? 600
    const kd = kb?.size.d ?? 600
    const ky = 7200 - inner - kd / 2
    put('kitchenBase', () => ({ x: inner + kw / 2, y: ky, rotation: 180 }))
    put('sink', () => ({ x: inner + kw * 1.5, y: ky, rotation: 180 }))
    put('stove', (a) => ({ x: inner + kw * 2 + a.size.w / 2, y: 7200 - inner - a.size.d / 2, rotation: 180 }))
    put('kitchenBase', () => ({ x: inner + kw * 3.5, y: ky, rotation: 180 }))
    put('hood', (a) => ({ x: inner + kw * 2 + (assetOf('stove')?.size.w ?? 600) / 2, y: 7200 - inner - a.size.d / 2, rotation: 180 }))
    put('kitchenWall', (a) => ({ x: inner + kw / 2, y: 7200 - inner - a.size.d / 2, rotation: 180 }))
    put('fridge', (a) => ({ x: 3600 - part - a.size.w / 2 - 20, y: 7200 - inner - a.size.d / 2, rotation: 180 }))
    put('table', () => ({ x: 1700, y: 5300, rotation: 0 }))
    put('chair', (a) => ({ x: 1700, y: 5300 - 550 - a.size.d / 2 + 250, rotation: 0 }))
    put('chair', (a) => ({ x: 1700, y: 5300 + 550 + a.size.d / 2 - 250, rotation: 180 }))
    // bathroom (7400..10000 × 4400..7200)
    put('bathtub', (a) => ({ x: 10000 - inner - a.size.d / 2, y: 7200 - inner - a.size.w / 2, rotation: 90 }))
    put('toilet', (a) => ({ x: 7400 + part + 450, y: 7200 - inner - a.size.d / 2, rotation: 180 }))
    put('washbasin', (a) => ({ x: 8500, y: 4400 + part + a.size.d / 2, rotation: 0 }))
    put('washingMachine', (a) => ({ x: 7400 + part + a.size.d / 2, y: 4400 + part + a.size.w / 2 + 40, rotation: 270 }))
    // hallway (3600..7400 × 4400..7200)
    put('wardrobe', (a) => ({ x: 7400 - part - a.size.d / 2, y: 7200 - inner - a.size.w / 2 - 50, rotation: 90 }))
    put('mirror', (a) => ({ x: 3600 + part + a.size.d / 2 + 5, y: 6600, rotation: 270 }))

    // ── lights ──
    const lights: [Vec2, 'ceiling' | 'pendant' | 'spot'][] = [
      [{ x: 2800, y: 2200 }, 'pendant'],
      [{ x: 7800, y: 2200 }, 'ceiling'],
      [{ x: 1700, y: 5300 }, 'pendant'],
      [{ x: 5500, y: 5800 }, 'ceiling'],
      [{ x: 8700, y: 5800 }, 'spot'],
    ]
    for (const [p, kind] of lights) {
      try {
        addLight(d, lv, kind, p.x, p.y)
      } catch (err) {
        console.warn('[doplan] sample light failed', err)
      }
    }

    normalize(d)
    syncRooms(d)
    d.meta.modifiedAt = new Date().toISOString()
  })
}
