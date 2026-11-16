/**
 * Electrical and low-voltage points: sockets, switches, USB, TV / data outlets, cable outlets for
 * appliances, junction boxes, the panel and sensors.
 *
 *  - `ELECTRIC_TYPES` — the catalog: names, letter codes, default mount and height, plan symbol, 3D look;
 *  - `electricSymbol` — plan symbols close to ГОСТ 21.210-2014 / ГОСТ 21.614-88 as primitives in a
 *    local frame, drawn by the display list (exports) and by the editor alike;
 *  - document operations: add, wall faces, keeping wall points on their face (`reattachElectrical`);
 *  - bindings to the room corners, BOM rows, file parsing.
 *
 * All the data lives in `Doc.electrical` (one optional record), see `ElectricPoint` in core/types.
 * Pure TS.
 */
import type { BomRow } from './bom'
import { newId } from './ids'
import { registerEntityKind } from './layers'
import { roomEdgeRuns } from './provenance'
import type { DerivedPlan, Doc, ElectricKind, ElectricMount, ElectricPoint, EntityKind, Id, Vec2, Wall, WallGeom } from './types'

// ───────────────────────────── catalog ─────────────────────────────

export type ElectricGroup = 'sockets' | 'usb' | 'switches' | 'lowVoltage' | 'outlets' | 'equipment'

export const ELECTRIC_GROUPS: readonly { id: ElectricGroup; ru: string; en: string }[] = [
  { id: 'sockets', ru: 'Розетки', en: 'Sockets' },
  { id: 'usb', ru: 'USB', en: 'USB' },
  { id: 'switches', ru: 'Выключатели', en: 'Switches' },
  { id: 'lowVoltage', ru: 'Слаботочные', en: 'Low voltage' },
  { id: 'outlets', ru: 'Выводы кабеля', en: 'Cable outlets' },
  { id: 'equipment', ru: 'Щиток, коробки, датчики', en: 'Panel, boxes, sensors' },
]

/** plan symbol family (see `electricSymbol`) */
export type ElectricSymbol =
  | 'socket'
  | 'socketDouble'
  | 'socketGround'
  | 'socketSealed'
  | 'socketPower'
  | 'usb'
  | 'switch'
  | 'switchPass'
  | 'switchCross'
  | 'dimmer'
  | 'bell'
  | 'data'
  | 'tv'
  | 'outlet'
  | 'ceilingOutlet'
  | 'junction'
  | 'panel'
  | 'sensor'
  | 'thermostat'

/** 3D look (view3d/electrical) */
export type ElectricDevice = 'socket' | 'switch' | 'usb' | 'data' | 'cable' | 'box' | 'panel' | 'sensor' | 'thermostat'

export interface ElectricType {
  kind: ElectricKind
  group: ElectricGroup
  ru: string
  en: string
  /** letter code written next to the plan symbol ('' = none) */
  code: string
  mount: ElectricMount
  /** default height of the centre above the floor, mm (ceiling points: ignored, the ceiling height is used) */
  elevation: number
  symbol: ElectricSymbol
  device: ElectricDevice
  /** switch keys shown on the symbol / the 3D key */
  keys?: number
  /** a flush device in a frame with a mounting box (BOM counts frames and boxes; gangs allowed) */
  framed: boolean
  /** rated current / note for the estimate */
  note?: string
}

const T = (
  kind: ElectricKind,
  group: ElectricGroup,
  ru: string,
  en: string,
  code: string,
  mount: ElectricMount,
  elevation: number,
  symbol: ElectricSymbol,
  device: ElectricDevice,
  framed: boolean,
  extra: Partial<ElectricType> = {},
): ElectricType => ({ kind, group, ru, en, code, mount, elevation, symbol, device, framed, ...extra })

export const ELECTRIC_TYPES: readonly ElectricType[] = [
  T('socket', 'sockets', 'Розетка одинарная', 'Socket', '', 'wall', 300, 'socket', 'socket', true, { note: '16 А, без заземления' }),
  T('socketDouble', 'sockets', 'Розетка двойная', 'Double socket', '2P', 'wall', 300, 'socketDouble', 'socket', true, { note: '16 А, с заземлением' }),
  T('socketGround', 'sockets', 'Розетка с заземлением', 'Grounded socket', '', 'wall', 300, 'socketGround', 'socket', true, { note: '16 А' }),
  T('socketIP44', 'sockets', 'Розетка влагозащищённая IP44', 'Splash-proof socket IP44', 'IP44', 'wall', 1000, 'socketSealed', 'socket', true, { note: '16 А, с заземлением' }),
  T('socketLid', 'sockets', 'Розетка с крышкой', 'Socket with a lid', 'Кр', 'wall', 1000, 'socketSealed', 'socket', true, { note: '16 А, с заземлением и шторками' }),
  T('socketPower', 'sockets', 'Розетка силовая (плита, духовка)', 'Power socket (cooker, oven)', '32А', 'wall', 150, 'socketPower', 'socket', true, { note: '32 А' }),
  T('socketUsbA', 'sockets', 'Розетка с USB-A', 'Socket with USB-A', 'USB-A', 'wall', 300, 'socketGround', 'socket', true),
  T('socketUsbC', 'sockets', 'Розетка с USB-C', 'Socket with USB-C', 'USB-C', 'wall', 300, 'socketGround', 'socket', true),
  T('socketUsbAC', 'sockets', 'Розетка с USB-A+C', 'Socket with USB-A+C', 'USB-AC', 'wall', 300, 'socketGround', 'socket', true),
  T('usbA', 'usb', 'USB-A зарядка', 'USB-A charger', 'USB-A', 'wall', 900, 'usb', 'usb', true),
  T('usbC', 'usb', 'USB-C зарядка', 'USB-C charger', 'USB-C', 'wall', 900, 'usb', 'usb', true),
  T('switch1', 'switches', 'Выключатель одноклавишный', 'One-gang switch', '', 'wall', 900, 'switch', 'switch', true, { keys: 1 }),
  T('switch2', 'switches', 'Выключатель двухклавишный', 'Two-gang switch', '', 'wall', 900, 'switch', 'switch', true, { keys: 2 }),
  T('switch3', 'switches', 'Выключатель трёхклавишный', 'Three-gang switch', '', 'wall', 900, 'switch', 'switch', true, { keys: 3 }),
  T('switchPass', 'switches', 'Выключатель проходной', 'Two-way switch', '', 'wall', 900, 'switchPass', 'switch', true, { keys: 1 }),
  T('switchCross', 'switches', 'Выключатель перекрёстный', 'Intermediate switch', '', 'wall', 900, 'switchCross', 'switch', true, { keys: 1 }),
  T('dimmer', 'switches', 'Диммер', 'Dimmer', '', 'wall', 900, 'dimmer', 'switch', true, { keys: 0 }),
  T('bell', 'switches', 'Кнопка звонка', 'Doorbell button', 'Зв', 'wall', 1500, 'bell', 'switch', true, { keys: 0 }),
  T('tv', 'lowVoltage', 'ТВ-розетка (антенна)', 'TV socket (coax)', 'TV', 'wall', 300, 'tv', 'data', true),
  T('rj45', 'lowVoltage', 'Интернет-розетка RJ45', 'Data socket RJ45', 'RJ45', 'wall', 300, 'data', 'data', true),
  T('phone', 'lowVoltage', 'Телефонная розетка RJ11', 'Phone socket RJ11', 'RJ11', 'wall', 300, 'data', 'data', true),
  T('hdmi', 'lowVoltage', 'Розетка HDMI', 'HDMI socket', 'HDMI', 'wall', 300, 'data', 'data', true),
  T('speaker', 'lowVoltage', 'Акустическая розетка', 'Speaker socket', 'Ак', 'wall', 300, 'data', 'data', true),
  T('outAc', 'outlets', 'Вывод под кондиционер', 'Outlet for air conditioner', 'К', 'wall', 2200, 'outlet', 'cable', false),
  T('outLight', 'outlets', 'Вывод под светильник', 'Outlet for a ceiling light', 'Св', 'ceiling', 0, 'ceilingOutlet', 'cable', false),
  T('outSconce', 'outlets', 'Вывод под бра', 'Outlet for a wall lamp', 'Бра', 'wall', 1500, 'outlet', 'cable', false),
  T('outHood', 'outlets', 'Вывод под вытяжку', 'Outlet for a cooker hood', 'Выт', 'wall', 2100, 'outlet', 'cable', false),
  T('outBoiler', 'outlets', 'Вывод под водонагреватель', 'Outlet for a water heater', 'ВН', 'wall', 1700, 'outlet', 'cable', false),
  T('outWasher', 'outlets', 'Вывод под стиральную машину', 'Outlet for a washing machine', 'СМ', 'wall', 1000, 'outlet', 'cable', false),
  T('junction', 'equipment', 'Распределительная коробка', 'Junction box', '', 'wall', 2300, 'junction', 'box', false),
  T('panel', 'equipment', 'Электрощиток', 'Distribution board', 'ЩК', 'wall', 1700, 'panel', 'panel', false),
  T('sensorLeak', 'equipment', 'Датчик протечки', 'Water leak sensor', 'ДП', 'floor', 0, 'sensor', 'sensor', false),
  T('sensorSmoke', 'equipment', 'Датчик дыма', 'Smoke detector', 'ИП', 'ceiling', 0, 'sensor', 'sensor', false),
  T('sensorMotion', 'equipment', 'Датчик движения', 'Motion sensor', 'ДД', 'wall', 2200, 'sensor', 'sensor', false),
  T('thermostat', 'equipment', 'Терморегулятор тёплого пола', 'Floor heating thermostat', 'ТР', 'wall', 900, 'thermostat', 'thermostat', true),
  T('other', 'equipment', 'Прочая точка', 'Other point', '?', 'wall', 300, 'data', 'data', false),
]

const TYPE_BY_KIND = new Map<ElectricKind, ElectricType>(ELECTRIC_TYPES.map((t) => [t.kind, t]))

export const ELECTRIC_KINDS: readonly ElectricKind[] = ELECTRIC_TYPES.map((t) => t.kind)

export function electricType(kind: ElectricKind | string): ElectricType {
  return TYPE_BY_KIND.get(kind as ElectricKind) ?? (TYPE_BY_KIND.get('other') as ElectricType)
}

/** catalog types of one group, in catalog order */
export function electricTypesOf(group: ElectricGroup): ElectricType[] {
  return ELECTRIC_TYPES.filter((t) => t.group === group && t.kind !== 'other')
}

/** standard mounting heights of the centre above the floor, mm */
export const ELECTRIC_HEIGHT_PRESETS: readonly { h: number; ru: string; en: string }[] = [
  { h: 150, ru: 'за техникой', en: 'behind appliances' },
  { h: 300, ru: 'розетки', en: 'sockets' },
  { h: 900, ru: 'выключатели', en: 'switches' },
  { h: 1000, ru: 'санузел', en: 'bathroom' },
  { h: 1100, ru: 'над столешницей', en: 'above the worktop' },
  { h: 1300, ru: 'за ТВ на стене', en: 'behind a wall TV' },
  { h: 2200, ru: 'под потолком', en: 'under the ceiling' },
]

export const MAX_GANGS = 5

/** posts in the frame of a point (1 for devices that are not framed) */
export function electricGangs(p: Pick<ElectricPoint, 'kind' | 'gangs'>): number {
  if (!electricType(p.kind).framed) return 1
  const g = Math.round(p.gangs ?? 1)
  return Number.isFinite(g) ? Math.min(MAX_GANGS, Math.max(1, g)) : 1
}

/**
 * Descriptor of this kind of objects for registries (layers panel, AI tools): the document record,
 * the entity kind of selections and the display-list layer of exports.
 */
export const ELECTRIC_OBJECT_KIND = {
  id: 'electrical',
  entityKind: 'electric' as EntityKind,
  collection: 'electrical' as const,
  displayLayer: 'electrical' as const,
  ru: 'Электрика',
  en: 'Electrical',
}

/** points of one level */
export function electricPointsOf(doc: Pick<Doc, 'electrical'>, levelId: Id): ElectricPoint[] {
  const out: ElectricPoint[] = []
  const rec = doc.electrical
  if (!rec) return out
  for (const id in rec) if (rec[id].levelId === levelId) out.push(rec[id])
  return out
}

// ───────────────────────────── plan symbols ─────────────────────────────

/**
 * One primitive of a plan symbol in the local frame of the point: unit = the radius of the socket
 * semicircle, origin = the point (on the wall face for wall points), +y = the direction the device
 * faces (into the room), +x = along the wall. Arc angles are degrees in the local frame from +x
 * towards +y, swept from `a0` to `a1` (a1 > a0).
 */
export type SymbolPrim =
  | { t: 'line'; a: Vec2; b: Vec2 }
  | { t: 'arc'; c: Vec2; r: number; a0: number; a1: number }
  | { t: 'circle'; c: Vec2; r: number; fill?: boolean }
  | { t: 'poly'; pts: Vec2[]; closed: boolean; fill?: boolean }

export interface ElectricSymbolShape {
  prims: SymbolPrim[]
  /** extent of the symbol in local units (for labels and hit boxes) */
  box: { minX: number; minY: number; maxX: number; maxY: number }
}

const v = (x: number, y: number): Vec2 => ({ x, y })
const L = (ax: number, ay: number, bx: number, by: number): SymbolPrim => ({ t: 'line', a: v(ax, ay), b: v(bx, by) })
const rect = (x0: number, y0: number, x1: number, y1: number, fill = false): SymbolPrim => ({
  t: 'poly',
  pts: [v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)],
  closed: true,
  fill,
})

/** semicircle on the wall: flat side on the face, the arc into the room */
function semi(fill: boolean): SymbolPrim[] {
  if (!fill) return [{ t: 'arc', c: v(0, 0), r: 1, a0: 0, a1: 180 }, L(-1, 0, 1, 0)]
  const pts: Vec2[] = []
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI
    pts.push(v(Math.cos(a), Math.sin(a)))
  }
  return [{ t: 'poly', pts, closed: true, fill: true }]
}

/** a switch: circle touching the wall, a lever at 45° with `ticks` short strokes at its end */
function switchLever(ticks: number, both = false): SymbolPrim[] {
  const c = v(0, 0.5)
  const r = 0.5
  const out: SymbolPrim[] = [{ t: 'circle', c, r }]
  const lever = (dx: number): void => {
    const u = v(dx * Math.SQRT1_2, Math.SQRT1_2)
    const s = v(c.x + u.x * r, c.y + u.y * r)
    const e = v(c.x + u.x * 1.7, c.y + u.y * 1.7)
    out.push({ t: 'line', a: s, b: e })
    const n = v(-u.y, u.x)
    for (let i = 0; i < Math.max(1, ticks); i++) {
      const k = 1.7 - i * 0.28
      const p = v(c.x + u.x * k, c.y + u.y * k)
      const side = dx > 0 ? -1 : 1
      out.push({ t: 'line', a: p, b: v(p.x + n.x * 0.35 * side, p.y + n.y * 0.35 * side) })
    }
  }
  lever(1)
  if (both) lever(-1)
  return out
}

/** Plan symbol of a point kind (one post). */
export function electricSymbol(kind: ElectricKind | string): ElectricSymbolShape {
  const ty = electricType(kind)
  let prims: SymbolPrim[]
  switch (ty.symbol) {
    case 'socket':
      prims = [...semi(false), L(0, 1, 0, 1.7)]
      break
    case 'socketDouble':
      prims = [...semi(false), L(-1, 1, 1, 1), L(-0.35, 1, -0.35, 1.7), L(0.35, 1, 0.35, 1.7)]
      break
    case 'socketGround':
      prims = [...semi(false), L(-1, 1, 1, 1), L(0, 1, 0, 1.7)]
      break
    case 'socketSealed':
      // protected design (IP44 and up): the semicircle is filled
      prims = [...semi(true), L(-1, 0, 1, 0), L(-1, 1, 1, 1), L(0, 1, 0, 1.7)]
      break
    case 'socketPower':
      prims = [...semi(false), L(-1, 1, 1, 1), L(-0.5, 1, -0.5, 1.7), L(0, 1, 0, 1.7), L(0.5, 1, 0.5, 1.7)]
      break
    case 'usb':
      prims = [rect(-0.7, 0, 0.7, 1), L(-0.35, 0.5, 0.35, 0.5)]
      break
    case 'switch':
      prims = switchLever(ty.keys ?? 1)
      break
    case 'switchPass':
      prims = switchLever(1, true)
      break
    case 'switchCross':
      prims = [...switchLever(1, true), L(-0.35, 0.15, 0.35, 0.85), L(-0.35, 0.85, 0.35, 0.15)]
      break
    case 'dimmer': {
      prims = [...switchLever(1), L(-0.55, -0.05, 0.55, 1.05), L(0.55, 1.05, 0.25, 0.95), L(0.55, 1.05, 0.45, 0.75)]
      break
    }
    case 'bell':
      prims = [{ t: 'circle', c: v(0, 0.5), r: 0.5 }, { t: 'circle', c: v(0, 0.5), r: 0.2, fill: true }]
      break
    case 'tv':
      prims = [rect(-0.7, 0, 0.7, 1.1), { t: 'circle', c: v(0, 0.55), r: 0.28 }]
      break
    case 'data':
      prims = [rect(-0.7, 0, 0.7, 1.1), L(-0.7, 1.1, 0, 0.55), L(0, 0.55, 0.7, 1.1)]
      break
    case 'outlet':
      prims = [L(0, 0, 0, 1.1), { t: 'circle', c: v(0, 1.4), r: 0.3 }, L(-0.4, 0, 0.4, 0)]
      break
    case 'ceilingOutlet':
      prims = [
        { t: 'circle', c: v(0, 0), r: 0.6 },
        L(-0.42, -0.42, 0.42, 0.42),
        L(-0.42, 0.42, 0.42, -0.42),
      ]
      break
    case 'junction':
      prims = [{ t: 'circle', c: v(0, 0.45), r: 0.45, fill: true }]
      break
    case 'panel':
      // distribution board: rectangle with the half to the room filled (ГОСТ 21.614)
      prims = [rect(-1.5, 0, 1.5, 0.9), { t: 'poly', pts: [v(-1.5, 0.9), v(1.5, 0), v(1.5, 0.9)], closed: true, fill: true }]
      break
    case 'thermostat':
      prims = [rect(-0.6, 0, 0.6, 1.2), L(0, 0.25, 0, 0.75), { t: 'circle', c: v(0, 0.9), r: 0.15, fill: true }]
      break
    case 'sensor':
    default:
      prims = [rect(-0.6, 0, 0.6, 1.2), { t: 'circle', c: v(0, 0.6), r: 0.3 }]
      break
  }
  return { prims, box: primsBox(prims) }
}

function primsBox(prims: SymbolPrim[]): ElectricSymbolShape['box'] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (p: Vec2, r = 0): void => {
    minX = Math.min(minX, p.x - r)
    minY = Math.min(minY, p.y - r)
    maxX = Math.max(maxX, p.x + r)
    maxY = Math.max(maxY, p.y + r)
  }
  for (const p of prims) {
    if (p.t === 'line') {
      add(p.a)
      add(p.b)
    } else if (p.t === 'poly') for (const q of p.pts) add(q)
    else if (p.t === 'circle') add(p.c, p.r)
    else {
      // arcs of the symbols are upper semicircles or less
      add(v(p.c.x - p.r, p.c.y))
      add(v(p.c.x + p.r, p.c.y + p.r))
    }
  }
  return { minX, minY, maxX, maxY }
}

function mapPrim(p: SymbolPrim, f: (q: Vec2) => Vec2): SymbolPrim {
  switch (p.t) {
    case 'line':
      return { t: 'line', a: f(p.a), b: f(p.b) }
    case 'poly':
      return { ...p, pts: p.pts.map(f) }
    case 'circle':
      return { ...p, c: f(p.c) }
    case 'arc':
      return { ...p, c: f(p.c) }
  }
}

/**
 * Whole plan symbol of a point in its local frame: the post symbol repeated along the wall for a
 * horizontal frame of several posts, centred on the origin for floor / ceiling points.
 */
export function electricPointSymbol(p: Pick<ElectricPoint, 'kind' | 'gangs' | 'vertical' | 'mount'>): ElectricSymbolShape {
  const one = electricSymbol(p.kind)
  const n = p.vertical ? 1 : electricGangs(p)
  let prims = one.prims
  if (n > 1) {
    const w = one.box.maxX - one.box.minX
    const pitch = w + 0.12
    prims = []
    for (let i = 0; i < n; i++) {
      const dx = (i - (n - 1) / 2) * pitch
      for (const q of one.prims) prims.push(mapPrim(q, (r) => v(r.x + dx, r.y)))
    }
  }
  if (p.mount !== 'wall') {
    const b = primsBox(prims)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    if (Math.abs(cx) > 1e-9 || Math.abs(cy) > 1e-9) prims = prims.map((q) => mapPrim(q, (r) => v(r.x - cx, r.y - cy)))
  }
  return { prims, box: primsBox(prims) }
}

/** unit vectors of the local frame of a point: x along the wall, y = facing direction */
export function electricFrame(rotationDeg: number): { ux: Vec2; uy: Vec2; theta: number } {
  const r = (rotationDeg * Math.PI) / 180
  const uy = v(Math.cos(r), Math.sin(r))
  const ux = v(Math.sin(r), -Math.cos(r))
  return { ux, uy, theta: rotationDeg - 90 }
}

/** local symbol coordinates → plan mm (`scale` = mm per symbol unit) */
export function electricToPlan(p: Pick<ElectricPoint, 'x' | 'y' | 'rotation'>, scale: number): (q: Vec2) => Vec2 {
  const { ux, uy } = electricFrame(p.rotation)
  return (q) => v(p.x + (ux.x * q.x + uy.x * q.y) * scale, p.y + (ux.y * q.x + uy.y * q.y) * scale)
}

/**
 * Text written next to the plan symbol: the letter code (with the post count of a vertical frame)
 * and the mounting height. Empty lines are dropped.
 */
export function electricLabelLines(p: ElectricPoint, opts: { heights?: boolean } = {}): string[] {
  const ty = electricType(p.kind)
  const n = electricGangs(p)
  const out: string[] = []
  const code = [p.vertical && n > 1 ? `${n}×` : '', ty.code].filter(Boolean).join(ty.code ? ' ' : '')
  if (code) out.push(code)
  if (opts.heights !== false && p.mount === 'wall') out.push(`h=${Math.round(p.elevation)}`)
  return out
}

/** display name of a point (the comment is not part of it) */
export function electricName(p: Pick<ElectricPoint, 'kind' | 'gangs'>, lang: 'ru' | 'en' = 'ru'): string {
  const ty = electricType(p.kind)
  const n = electricGangs(p)
  const base = lang === 'ru' ? ty.ru : ty.en
  return n > 1 ? `${base} ×${n}` : base
}

// layers panel: a group of its own; a wall point inherits the hidden / locked state of its wall
registerEntityKind<ElectricPoint>({
  kind: ELECTRIC_OBJECT_KIND.entityKind,
  docKey: ELECTRIC_OBJECT_KIND.collection,
  title: { ru: ELECTRIC_OBJECT_KIND.ru, en: ELECTRIC_OBJECT_KIND.en },
  icon: 'plug',
  order: 55,
  level: (p) => p.levelId,
  name: (p, env) => (typeof p.name === 'string' && p.name.trim() ? p.name : electricName(p, env.lang)),
  rename: (p, name) => {
    const v = name.trim()
    if (v) p.name = v
    else delete p.name
  },
  subtype: (p, env) => electricName({ kind: p.kind }, env.lang),
  parent: (p) => (p.wallId ? { kind: 'wall', id: p.wallId } : undefined),
})

// ───────────────────────────── walls ─────────────────────────────

export interface WallFaceHit {
  wallId: Id
  side: 'left' | 'right'
  /** distance along the wall axis from node `a`, mm */
  t: number
  /** the point on the face */
  point: Vec2
  /** facing direction (outward normal of the face), degrees */
  rotation: number
  /** distance from the query point to the face, mm */
  dist: number
}

function wallEnds(doc: Pick<Doc, 'nodes'>, w: Wall): { a: Vec2; b: Vec2; len: number; u: Vec2 } | null {
  const a = doc.nodes[w.a]
  const b = doc.nodes[w.b]
  if (!a || !b) return null
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < 1e-6) return null
  return { a, b, len, u: v((b.x - a.x) / len, (b.y - a.y) / len) }
}

/** walls that have faces to mount a point on (not a virtual separator, with a thickness) */
export function isMountableWall(w: Wall | undefined): boolean {
  return !!w && w.kind !== 'virtual' && w.thickness > 0
}

const mountable = isMountableWall

/** half the size of a point along its wall, mm: a frame keeps this far from an adjoining wall */
export function electricHalfWidth(p: Pick<ElectricPoint, 'kind' | 'gangs' | 'vertical'>): number {
  const ty = electricType(p.kind)
  // frame 86 mm, 71 mm per extra post (as built in 3D)
  if (ty.framed) return 43 + (p.vertical ? 0 : (electricGangs(p) - 1) * 35.5)
  if (ty.device === 'panel') return 150
  if (ty.device === 'box') return 42
  if (ty.device === 'cable') return 40
  return 30
}

/**
 * Where along a wall (`t` from node a) a point of half-size `half` fits on a face. The face ends
 * where an adjoining wall at node a or b covers it (the inner corner of a room), and the point keeps
 * `half` clear of such an end so its frame is not buried in that wall. At an outer corner the face
 * ends at the miter with the other wall's outer face (as computeWallGeoms draws it): past the node
 * usually, short of it when the other wall is thinner and the bend blunt, then the point keeps clear
 * of that end too. Free ends and straight joins do not limit it. A face shorter than the point: its middle.
 * Computed from the document alone, so `normalize` keeps every wall point inside it.
 */
export function wallFaceRange(
  doc: Pick<Doc, 'nodes' | 'walls'>,
  wallId: Id,
  side: 'left' | 'right',
  half = 0,
): { lo: number; hi: number; len: number } | null {
  const w = doc.walls[wallId]
  const e = w && wallEnds(doc, w)
  if (!w || !e) return null
  const nl = v(e.u.y, -e.u.x)
  const n = side === 'left' ? nl : v(-nl.x, -nl.y)
  const h = w.thickness / 2
  // the face line: a + u·t + n·h
  const fx = e.a.x + n.x * h
  const fy = e.a.y + n.y * h
  let f0 = 0
  let f1 = e.len
  for (const id in doc.walls) {
    if (id === wallId) continue
    const o = doc.walls[id]
    if (o.levelId !== w.levelId || !mountable(o)) continue
    for (const end of ['a', 'b'] as const) {
      const nodeId = end === 'a' ? w.a : w.b
      if (o.a !== nodeId && o.b !== nodeId) continue
      const oe = wallEnds(doc, o)
      const node = doc.nodes[nodeId]
      if (!oe || !node) continue
      // the other wall's direction away from the shared node
      const away = o.a === nodeId ? oe.u : v(-oe.u.x, -oe.u.y)
      const c1 = away.x * e.u.y - away.y * e.u.x
      // a straight join: no limit
      if (Math.abs(c1) < 0.05) continue
      // signed distance of the face line from the other wall's axis is c0 + c1·t; its body is |…| ≤ th/2,
      // its faces are at ±th/2 (t1, t2 where this face line crosses them)
      const c0 = away.x * (fy - node.y) - away.y * (fx - node.x)
      const ho = o.thickness / 2
      const t1 = (-ho - c0) / c1
      const t2 = (ho - c0) / c1
      if (away.x * n.x + away.y * n.y <= 1e-6) {
        // the other wall is on the far side of this face (an outer corner): the face ends at the
        // crossing with its outer face, the farther one; it only matters when that is short of the node
        if (end === 'a') f0 = Math.max(f0, Math.min(e.len, Math.min(t1, t2)))
        else f1 = Math.min(f1, Math.max(0, Math.max(t1, t2)))
        continue
      }
      if (end === 'a') f0 = Math.max(f0, Math.min(e.len, Math.max(t1, t2)))
      else f1 = Math.min(f1, Math.max(0, Math.min(t1, t2)))
    }
  }
  let lo = f0 > 0.5 ? Math.min(e.len, f0 + half) : 0
  let hi = f1 < e.len - 0.5 ? Math.max(0, f1 - half) : e.len
  if (lo > hi) {
    const mid = (f0 + f1) / 2
    lo = mid
    hi = mid
  }
  return { lo, hi, len: e.len }
}

/** `t` clamped to the part of the face where the point fits (see wallFaceRange) */
export function clampOnFace(doc: Pick<Doc, 'nodes' | 'walls'>, wallId: Id, side: 'left' | 'right', t: number, half = 0): number {
  const r = wallFaceRange(doc, wallId, side, half)
  return r ? Math.min(r.hi, Math.max(r.lo, t)) : t
}

/** the point at `t` mm from node `a` on one face of a wall, and the face direction */
export function wallFacePoint(doc: Pick<Doc, 'nodes' | 'walls'>, wallId: Id, side: 'left' | 'right', t: number): { point: Vec2; rotation: number; len: number } | null {
  const w = doc.walls[wallId]
  const e = w && wallEnds(doc, w)
  if (!w || !e) return null
  // left normal in y-down coordinates: (dy, -dx)
  const nl = v(e.u.y, -e.u.x)
  const n = side === 'left' ? nl : v(-nl.x, -nl.y)
  const h = w.thickness / 2
  const tt = Math.min(e.len, Math.max(0, t))
  return {
    point: v(e.a.x + e.u.x * tt + n.x * h, e.a.y + e.u.y * tt + n.y * h),
    rotation: normDeg((Math.atan2(n.y, n.x) * 180) / Math.PI),
    len: e.len,
  }
}

function normDeg(a: number): number {
  const r = ((a % 360) + 360) % 360
  return Math.abs(r - 360) < 1e-9 ? 0 : r
}

/**
 * A wall hidden in the layers panel (own flag, the walls group or its user layer; walls have no
 * parent). Points are not put on it: the user does not see it.
 */
export function wallHidden(doc: Partial<Pick<Doc, 'layers' | 'groupFlags'>>, w: Wall): boolean {
  return w.hidden === true || doc.groupFlags?.wall?.hidden === true || (typeof w.layerId === 'string' && doc.layers?.[w.layerId]?.hidden === true)
}

/**
 * The wall face nearest to `p` on a level within `tol` mm of the face. `skipHidden`: walls hidden in
 * the layers panel do not count — for putting a point somewhere (the user does not see them); never
 * when re-seating a point of a hidden wall after a wall edit (a split or merged hidden wall must keep
 * its points). `allowHidden`: hidden walls that still count with `skipHidden`. (the projection must fall
 * on the wall). `prefer` (a wall id) wins ties so a point keeps its wall at junctions.
 */
export function nearestWallFace(
  doc: Pick<Doc, 'nodes' | 'walls'> & Partial<Pick<Doc, 'layers' | 'groupFlags'>>,
  levelId: Id,
  p: Vec2,
  tol: number,
  opts: { prefer?: Id; exclude?: ReadonlySet<Id>; skipHidden?: boolean; allowHidden?: ReadonlySet<Id> } = {},
): WallFaceHit | null {
  let best: WallFaceHit | null = null
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.levelId !== levelId || !mountable(w) || opts.exclude?.has(id) || (opts.skipHidden && !opts.allowHidden?.has(id) && wallHidden(doc, w))) continue
    const e = wallEnds(doc, w)
    if (!e) continue
    const t = (p.x - e.a.x) * e.u.x + (p.y - e.a.y) * e.u.y
    if (t < -1 || t > e.len + 1) continue
    // signed distance from the axis, positive on the left side
    const s = (p.x - e.a.x) * e.u.y - (p.y - e.a.y) * e.u.x
    const side: 'left' | 'right' = s >= 0 ? 'left' : 'right'
    const d = Math.abs(Math.abs(s) - w.thickness / 2)
    // inside the wall body counts as on the nearer face
    if (d > tol) continue
    const score = d - (opts.prefer === id ? 0.5 : 0)
    const bestScore = best ? best.dist - (opts.prefer === best.wallId ? 0.5 : 0) : Infinity
    if (score >= bestScore) continue
    const f = wallFacePoint(doc, id, side, t)
    if (!f) continue
    best = { wallId: id, side, t: Math.min(e.len, Math.max(0, t)), point: f.point, rotation: f.rotation, dist: d }
  }
  return best
}

/** distance along the wall axis from node `a` of the projection of `p` */
export function alongWall(doc: Pick<Doc, 'nodes' | 'walls'>, wallId: Id, p: Vec2): number | null {
  const w = doc.walls[wallId]
  const e = w && wallEnds(doc, w)
  if (!e) return null
  return (p.x - e.a.x) * e.u.x + (p.y - e.a.y) * e.u.y
}

/** writes only when the value changes (minimal Immer patches) */
function setIf<K extends 'x' | 'y' | 'rotation'>(o: ElectricPoint, k: K, val: number): void {
  if (Math.abs(o[k] - val) > 1e-6) o[k] = val
}

/** Puts a point on a wall face at `t` mm from node `a` (the facing direction follows the face). */
export function placeElectricOnWall(doc: Doc, id: Id, wallId: Id, side: 'left' | 'right', t: number): void {
  const p = doc.electrical?.[id]
  const f = wallFacePoint(doc, wallId, side, t)
  if (!p || !f) return
  setIf(p, 'x', f.point.x)
  setIf(p, 'y', f.point.y)
  setIf(p, 'rotation', f.rotation)
  if (p.wallId !== wallId) p.wallId = wallId
  if (p.side !== side) p.side = side
  if (p.mount !== 'wall') p.mount = 'wall'
}

/** Detaches a point from its wall (keeps the position). */
export function detachElectric(p: ElectricPoint): void {
  if (p.wallId !== undefined) delete p.wallId
  if (p.side !== undefined) delete p.side
}

/**
 * Keeps wall points on their faces after any edit (called at the end of `normalize`):
 *  - a point whose wall was split, merged or deleted moves to the wall face it lies on (or is detached);
 *  - a point on an existing wall is put back on the face (the wall moved or changed thickness);
 *  - points of deleted levels are removed, posts are clamped.
 * `onHiddenWall`: points on a hidden wall before the edit with that wall's axis (`electricOnHiddenWalls`).
 * Only such a point may be re-seated on a hidden wall, and only on one continuing that old wall (on its
 * axis and overlapping it: the wall merged; a split moves points to their half itself,
 * `splitElectricOnWall`); a point dragged to another hidden wall, even one meeting it end to end, and
 * any other point, never lands on what is not seen.
 */
export function reattachElectrical(doc: Doc, onHiddenWall?: ReadonlyMap<Id, HiddenWallSeat>): void {
  const rec = doc.electrical
  if (!rec) return
  for (const id in rec) {
    const p = rec[id]
    if (!doc.levels[p.levelId]) {
      delete rec[id]
      continue
    }
    if (p.gangs !== undefined && p.gangs !== electricGangs(p)) p.gangs = electricGangs(p)
    if (p.mount !== 'wall') {
      if (p.wallId !== undefined || p.side !== undefined) detachElectric(p)
      continue
    }
    if (!p.wallId) continue
    const w = doc.walls[p.wallId]
    const t = w && w.levelId === p.levelId && mountable(w) ? alongWall(doc, p.wallId, p) : null
    const len = w ? (wallEnds(doc, w)?.len ?? 0) : 0
    const half = electricHalfWidth(p)
    if (t !== null && t >= -0.5 && t <= len + 0.5) {
      // kept clear of the adjoining walls (a wider frame, a moved wall, a point put near a corner)
      const side = p.side === 'right' ? 'right' : 'left'
      placeElectricOnWall(doc, id, p.wallId, side, clampOnFace(doc, p.wallId, side, t, half))
      continue
    }
    // the wall is gone or no longer under the point: the face the point sits on, if it looks the same
    // way (a split or merged wall). A face turned another way is a neighbour wall at a corner: the
    // point is detached in place rather than moved and turned onto it.
    const seat = onHiddenWall?.get(id)
    const hit = nearestWallFace(doc, p.levelId, p, 60, { skipHidden: true, allowHidden: seat ? continuingWalls(doc, p.levelId, seat) : undefined })
    if (hit && Math.abs(((hit.rotation - p.rotation + 540) % 360) - 180) < 1) placeElectricOnWall(doc, id, hit.wallId, hit.side, clampOnFace(doc, hit.wallId, hit.side, hit.t, half))
    else detachElectric(p)
  }
  // the record stays even when empty: deleting it would turn the next edit into a whole-record patch
}

/**
 * A wall is split at `s` mm from node `a` (called while it is still whole): its points beyond the
 * split move to the second half `newWallId` (same direction, same faces), like openings.
 */
export function splitElectricOnWall(doc: Doc, wallId: Id, newWallId: Id, s: number): void {
  const rec = doc.electrical
  if (!rec) return
  for (const id in rec) {
    const p = rec[id]
    if (p.wallId !== wallId) continue
    const t = alongWall(doc, wallId, p)
    if (t !== null && t > s) p.wallId = newWallId
  }
}

/** axis of the hidden wall a point stood on before an edit */
export interface HiddenWallSeat {
  a: Vec2
  b: Vec2
}

/** points sitting on a wall hidden in the layers panel, with its axis (taken before an edit, for `reattachElectrical`) */
export function electricOnHiddenWalls(doc: Doc): Map<Id, HiddenWallSeat> {
  const out = new Map<Id, HiddenWallSeat>()
  const rec = doc.electrical
  if (!rec) return out
  for (const id in rec) {
    const w = rec[id].wallId ? doc.walls[rec[id].wallId!] : undefined
    const a = w && doc.nodes[w.a]
    const b = w && doc.nodes[w.b]
    if (w && a && b && wallHidden(doc, w)) out.set(id, { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } })
  }
  return out
}

/** walls continuing an old wall: on its axis (±1 mm) and overlapping its segment (touching end to end is not enough) */
function continuingWalls(doc: Doc, levelId: Id, s: HiddenWallSeat): Set<Id> {
  const out = new Set<Id>()
  for (const id in doc.walls) {
    const w = doc.walls[id]
    const e = w.levelId === levelId ? wallEnds(doc, w) : null
    if (!e) continue
    const across = (q: Vec2) => Math.abs((q.x - e.a.x) * e.u.y - (q.y - e.a.y) * e.u.x)
    if (across(s.a) > 1 || across(s.b) > 1) continue
    const ta = (s.a.x - e.a.x) * e.u.x + (s.a.y - e.a.y) * e.u.y
    const tb = (s.b.x - e.a.x) * e.u.x + (s.b.y - e.a.y) * e.u.y
    if (Math.max(ta, tb) > 1 && Math.min(ta, tb) < e.len - 1) out.add(id)
  }
  return out
}

/** wall-attached points of some walls with their distance from node `a` (taken before the walls move) */
export interface ElectricAnchor {
  id: Id
  wallId: Id
  t: number
  len: number
}

export function captureElectricAnchors(doc: Doc, wallIds: Iterable<Id>): ElectricAnchor[] {
  const rec = doc.electrical
  if (!rec) return []
  const set = new Set(wallIds)
  if (set.size === 0) return []
  const out: ElectricAnchor[] = []
  for (const id in rec) {
    const p = rec[id]
    if (p.mount !== 'wall' || !p.wallId || !set.has(p.wallId)) continue
    const w = doc.walls[p.wallId]
    const e = w && wallEnds(doc, w)
    const t = alongWall(doc, p.wallId, p)
    if (!e || t === null) continue
    out.push({ id, wallId: p.wallId, t, len: e.len })
  }
  return out
}

/**
 * Moves wall points with their walls after the wall nodes moved: like openings, a point keeps its
 * distance from the end of the wall that did not move.
 */
export function restoreElectricAnchors(doc: Doc, anchors: readonly ElectricAnchor[], moved: ReadonlySet<Id> | Map<Id, unknown>): void {
  for (const an of anchors) {
    const p = doc.electrical?.[an.id]
    const w = doc.walls[an.wallId]
    const e = w && wallEnds(doc, w)
    if (!p || !w || !e) continue
    const onlyA = moved.has(w.a) && !moved.has(w.b)
    const t = onlyA ? e.len - (an.len - an.t) : an.t
    placeElectricOnWall(doc, an.id, an.wallId, p.side === 'right' ? 'right' : 'left', Math.min(e.len, Math.max(0, t)))
  }
}

// ───────────────────────────── operations ─────────────────────────────

export interface AddElectricOptions extends Partial<Omit<ElectricPoint, 'id' | 'levelId' | 'kind' | 'x' | 'y'>> {
  /** snap to the nearest wall face within this distance, mm (wall kinds; default 400) */
  snap?: number
}

/**
 * Adds a point. A wall kind near a wall is put on the nearest face (facing the room); the height
 * defaults to the catalog height (ceiling points: the level height). Returns the new id.
 */
export function addElectric(doc: Doc, levelId: Id, kind: ElectricKind, x: number, y: number, opts: AddElectricOptions = {}): Id {
  const level = doc.levels[levelId]
  if (!level) throw new Error(`Уровень не найден: ${levelId}`)
  const ty = electricType(kind)
  const { snap, ...patch } = opts
  const mount = patch.mount ?? ty.mount
  const ceiling = level.height || doc.settings.wallHeight || 2700
  const p: ElectricPoint = {
    id: newId('e'),
    levelId,
    kind: ty.kind,
    mount,
    x,
    y,
    elevation: mount === 'ceiling' ? ceiling : mount === 'floor' ? 0 : ty.elevation,
    rotation: 0,
  }
  if (patch.elevation !== undefined && Number.isFinite(patch.elevation)) p.elevation = Math.max(0, patch.elevation)
  if (patch.rotation !== undefined && Number.isFinite(patch.rotation)) p.rotation = normDeg(patch.rotation)
  if (patch.gangs !== undefined && ty.framed) p.gangs = Math.min(MAX_GANGS, Math.max(1, Math.round(patch.gangs)))
  if (patch.vertical) p.vertical = true
  if (patch.comment) p.comment = patch.comment
  ;(doc.electrical ??= {})[p.id] = p
  if (mount === 'wall') {
    const half = electricHalfWidth(p)
    // a given wall counts only when a point can sit on it (else: the nearest face, as without it)
    const w = patch.wallId ? doc.walls[patch.wallId] : undefined
    if (patch.wallId && w && w.levelId === levelId && isMountableWall(w) && !wallHidden(doc, w)) {
      const side = patch.side ?? nearestWallFace(doc, levelId, p, Infinity, { prefer: patch.wallId, skipHidden: true })?.side ?? 'left'
      const t = clampOnFace(doc, patch.wallId, side, alongWall(doc, patch.wallId, p) ?? 0, half)
      placeElectricOnWall(doc, p.id, patch.wallId, side, t)
      return p.id
    }
    const hit = nearestWallFace(doc, levelId, p, snap ?? 400, { skipHidden: true })
    if (hit) placeElectricOnWall(doc, p.id, hit.wallId, hit.side, clampOnFace(doc, hit.wallId, hit.side, hit.t, half))
  }
  return p.id
}

/**
 * Copies points shifted by (dx, dy): a copy of a wall point stays on its face, shifted along it.
 * `copiedWalls`: walls copied in the same duplication — a copy moved off its wall may sit on one of
 * them even when it is hidden; any other hidden wall is skipped (the copy is put somewhere new).
 */
export function duplicateElectric(doc: Doc, ids: readonly Id[], dx: number, dy: number, copiedWalls?: ReadonlySet<Id>): Id[] {
  const out: Id[] = []
  const rec = doc.electrical
  if (!rec) return out
  for (const id of ids) {
    const p = rec[id]
    if (!p) continue
    const c: ElectricPoint = { ...p, id: newId('e'), x: p.x + dx, y: p.y + dy }
    rec[c.id] = c
    if (c.mount === 'wall' && c.wallId) {
      const w = doc.walls[c.wallId]
      const e = w && wallEnds(doc, w)
      const across = e ? Math.abs(dx * e.u.y - dy * e.u.x) : 0
      // moved off its wall (e.g. copied together with the walls): sit on the face found there
      const hit = e && across > 50 ? nearestWallFace(doc, c.levelId, c, 60, { skipHidden: true, allowHidden: copiedWalls }) : null
      if (hit) {
        placeElectricOnWall(doc, c.id, hit.wallId, hit.side, hit.t)
      } else if (e) {
        // a lone copy stays on the wall of the original, shifted along it
        let shift = dx * e.u.x + dy * e.u.y
        if (Math.abs(shift) < 1) shift = 250
        const t0 = alongWall(doc, c.wallId, p) ?? 0
        let t = t0 + shift
        if (t > e.len) t = t0 - Math.abs(shift)
        placeElectricOnWall(doc, c.id, c.wallId, c.side === 'right' ? 'right' : 'left', Math.min(e.len, Math.max(0, t)))
      }
    }
    out.push(c.id)
  }
  return out
}

// ───────────────────────────── bindings ─────────────────────────────

export interface ElectricBinding {
  /** the face segment the distances are measured along (room corners when the point is in a room) */
  a: Vec2
  b: Vec2
  /** foot of the point on the face line */
  foot: Vec2
  /** distances from the ends of the face, mm */
  fromA: number
  fromB: number
  /** unit normal pointing into the room */
  n: Vec2
  /** true: the ends are room corners; false: ends of the wall face */
  room: boolean
}

/**
 * Where a wall point is tied to: the distances along the wall face to the room corners on both
 * sides (the face of the room the point is in), or to the ends of the wall face.
 */
export function electricBinding(doc: Doc, plan: DerivedPlan | undefined, p: ElectricPoint): ElectricBinding | null {
  if (p.mount !== 'wall') return null
  const along = (a: Vec2, b: Vec2): { t: number; d: number; len: number; u: Vec2 } | null => {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1) return null
    const u = v((b.x - a.x) / len, (b.y - a.y) / len)
    const t = (p.x - a.x) * u.x + (p.y - a.y) * u.y
    const d = Math.abs((p.x - a.x) * u.y - (p.y - a.y) * u.x)
    return { t, d, len, u }
  }
  let best: ElectricBinding | null = null
  let bestD = Infinity
  if (plan) {
    for (const room of plan.rooms) {
      if (room.levelId !== p.levelId) continue
      for (const run of roomEdgeRuns(room)) {
        const r = along(run.a, run.b)
        if (!r || r.d > 15 || r.t < -1 || r.t > r.len + 1 || r.d >= bestD) continue
        // the point must face this room
        const { uy } = electricFrame(p.rotation)
        if (uy.x * run.n.x + uy.y * run.n.y < 0.5) continue
        bestD = r.d
        const tt = Math.min(r.len, Math.max(0, r.t))
        best = { a: run.a, b: run.b, foot: v(run.a.x + r.u.x * tt, run.a.y + r.u.y * tt), fromA: tt, fromB: r.len - tt, n: run.n, room: true }
      }
    }
  }
  if (best) return best
  const g: WallGeom | undefined = p.wallId ? plan?.wallGeoms[p.wallId] : undefined
  if (g) {
    const [a, b] = p.side === 'right' ? g.right : g.left
    const r = along(a, b)
    if (r) {
      const tt = Math.min(r.len, Math.max(0, r.t))
      const { uy } = electricFrame(p.rotation)
      return { a, b, foot: v(a.x + r.u.x * tt, a.y + r.u.y * tt), fromA: tt, fromB: r.len - tt, n: uy, room: false }
    }
  }
  return null
}

/**
 * The binding ends as seen by someone in the room facing the wall: the distance to the corner on
 * the left and on the right (aIsLeft: the end `a` of the binding is the left one).
 */
export function electricSides(b: ElectricBinding): { left: number; right: number; aIsLeft: boolean } {
  const len = Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) || 1
  const u = { x: (b.b.x - b.a.x) / len, y: (b.b.y - b.a.y) / len }
  // facing the wall the viewer looks along −n; their right hand points along (n.y, −n.x)
  const bIsRight = u.x * b.n.y - u.y * b.n.x > 0
  return bIsRight ? { left: b.fromA, right: b.fromB, aIsLeft: true } : { left: b.fromB, right: b.fromA, aIsLeft: false }
}

// ───────────────────────────── BOM ─────────────────────────────

/** Estimate rows: devices by kind (posts counted), frames by post count, mounting boxes. */
export function electricBomRows(doc: Pick<Doc, 'electrical'>): BomRow[] {
  const rows: BomRow[] = []
  const rec = doc.electrical
  if (!rec) return rows
  const byKind = new Map<ElectricKind, { n: number; heights: Map<number, number> }>()
  const frames = new Map<number, number>()
  let boxes = 0
  for (const id in rec) {
    const p = rec[id]
    const ty = electricType(p.kind)
    const n = electricGangs(p)
    const e = byKind.get(ty.kind) ?? { n: 0, heights: new Map<number, number>() }
    e.n += n
    if (p.mount === 'wall') {
      const h = Math.round(p.elevation / 10) * 10
      e.heights.set(h, (e.heights.get(h) ?? 0) + n)
    }
    byKind.set(ty.kind, e)
    if (ty.framed && p.mount === 'wall') {
      frames.set(n, (frames.get(n) ?? 0) + 1)
      boxes += n
    }
  }
  for (const ty of ELECTRIC_TYPES) {
    const e = byKind.get(ty.kind)
    if (!e) continue
    const hs = [...e.heights.entries()].sort((a, b) => a[0] - b[0]).map(([h, c]) => `h ${h} мм ×${c}`)
    const note = [ty.note, hs.join(', ')].filter(Boolean).join('; ')
    rows.push({ group: 'Электрика', name: ty.ru, unit: 'шт', quantity: e.n, note: note || undefined, refId: `electric:${ty.kind}` })
  }
  for (const [n, c] of [...frames.entries()].sort((a, b) => a[0] - b[0])) {
    rows.push({ group: 'Электрика', name: n === 1 ? 'Рамка одноместная' : `Рамка на ${n} ${n >= 5 ? 'постов' : 'поста'}`, unit: 'шт', quantity: c, refId: `electric:frame:${n}` })
  }
  if (boxes > 0) rows.push({ group: 'Электрика', name: 'Подрозетник', unit: 'шт', quantity: boxes, note: 'по числу постов', refId: 'electric:box' })
  return rows
}

// ───────────────────────────── files ─────────────────────────────

type Raw = Record<string, unknown>

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** One point read from a file (null when unusable). Unknown kinds become `other`. */
export function parseElectricPoint(id: Id, raw: Raw, levelId: Id, levelHeight: number): ElectricPoint | null {
  if (!fin(raw.x) || !fin(raw.y)) return null
  const kind: ElectricKind = (ELECTRIC_KINDS as readonly string[]).includes(raw.kind as string) ? (raw.kind as ElectricKind) : 'other'
  const ty = electricType(kind)
  const mount: ElectricMount = raw.mount === 'wall' || raw.mount === 'floor' || raw.mount === 'ceiling' ? raw.mount : ty.mount
  const p: ElectricPoint = {
    id,
    levelId,
    kind,
    mount,
    x: raw.x,
    y: raw.y,
    elevation: fin(raw.elevation) ? Math.min(100000, Math.max(0, raw.elevation)) : mount === 'ceiling' ? levelHeight : mount === 'floor' ? 0 : ty.elevation,
    rotation: fin(raw.rotation) ? normDeg(raw.rotation) : 0,
  }
  if (mount === 'wall' && typeof raw.wallId === 'string' && raw.wallId) {
    p.wallId = raw.wallId
    p.side = raw.side === 'right' ? 'right' : 'left'
  }
  if (fin(raw.gangs) && ty.framed) p.gangs = Math.min(MAX_GANGS, Math.max(1, Math.round(raw.gangs)))
  if (raw.vertical === true) p.vertical = true
  if (typeof raw.comment === 'string' && raw.comment.trim()) p.comment = raw.comment.slice(0, 2000)
  return p
}
