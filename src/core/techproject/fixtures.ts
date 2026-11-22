/**
 * Builtin contributors of the engineering sheets while the plan has no plumbing / heating entities:
 *  - `fixtures`: water and drain outlets inferred from the sanitary fixtures on the plan, with the
 *    usual heights (по типовым высотам выводов; уточняются по паспортам приборов);
 *  - `thermostats`: underfloor heating zones guessed from the thermostats (rooms with a thermostat).
 * The utilities module replaces them by registering a contributor with `supersedes`.
 */
import type { DisplayItem } from '../display'
import type { Doc, Id, Item, Vec2 } from '../types'
import { fmtNum, label, marker, pointInPoly } from './annot'
import { itemTitle, roomTitle } from './common'
import { type Contribution, registerSheetContributor } from './contrib'
import type { AlbumCtx } from './model'
import { isPlumbingItem, plumbingKind } from './plans'
import type { TableRow } from './table'

const V = (x: number, y: number): Vec2 => ({ x, y })

export interface OutletSpec {
  /** В1 cold water, Т3 hot water, К1 drain */
  code: 'В1' | 'Т3' | 'К1'
  /** along the fixture's width from its axis (− = left as seen from the front) */
  dx: number
  /** height above the finished floor, mm */
  h: number
  note: string
}

/** typical outlet heights by fixture kind (mm above the finished floor) */
export const FIXTURE_OUTLETS: Record<string, { name: string; outlets: OutletSpec[] }> = {
  washbasin: {
    name: 'Раковина',
    outlets: [
      { code: 'Т3', dx: -75, h: 550, note: 'ГВС ½″' },
      { code: 'В1', dx: 75, h: 550, note: 'ХВС ½″' },
      { code: 'К1', dx: 0, h: 500, note: 'Канализация Ø50' },
    ],
  },
  sink: {
    name: 'Мойка кухонная',
    outlets: [
      { code: 'Т3', dx: -75, h: 500, note: 'ГВС ½″' },
      { code: 'В1', dx: 75, h: 500, note: 'ХВС ½″' },
      { code: 'К1', dx: 0, h: 450, note: 'Канализация Ø50' },
    ],
  },
  toilet: {
    name: 'Унитаз',
    outlets: [
      { code: 'В1', dx: 200, h: 200, note: 'ХВС ½″ (для инсталляции — по паспорту, ≈1000)' },
      { code: 'К1', dx: 0, h: 200, note: 'Канализация Ø110 (инсталляция ≈230)' },
    ],
  },
  bathtub: {
    name: 'Ванна',
    outlets: [
      { code: 'Т3', dx: -75, h: 800, note: 'ГВС ½″, смеситель' },
      { code: 'В1', dx: 75, h: 800, note: 'ХВС ½″, смеситель' },
      { code: 'К1', dx: 0, h: 50, note: 'Канализация Ø50' },
    ],
  },
  shower: {
    name: 'Душ',
    outlets: [
      { code: 'Т3', dx: -75, h: 1100, note: 'ГВС ½″, смеситель' },
      { code: 'В1', dx: 75, h: 1100, note: 'ХВС ½″, смеситель' },
      { code: 'К1', dx: 0, h: 0, note: 'Трап Ø50' },
    ],
  },
  washingMachine: {
    name: 'Стиральная машина',
    outlets: [
      { code: 'В1', dx: 150, h: 600, note: 'ХВС ¾″, кран' },
      { code: 'К1', dx: -150, h: 600, note: 'Канализация Ø50 с сифоном' },
    ],
  },
  dishwasher: {
    name: 'Посудомоечная машина',
    outlets: [
      { code: 'В1', dx: 150, h: 400, note: 'ХВС ¾″, кран' },
      { code: 'К1', dx: -150, h: 400, note: 'Канализация Ø40' },
    ],
  },
  boiler: {
    name: 'Водонагреватель',
    outlets: [
      { code: 'В1', dx: 100, h: 1300, note: 'ХВС ½″' },
      { code: 'Т3', dx: -100, h: 1300, note: 'ГВС ½″' },
    ],
  },
}

export const OUTLET_COLOR: Record<OutletSpec['code'], string> = { В1: '#1d4e89', Т3: '#c0392b', К1: '#6d4c1f' }

export interface FixtureOutlet {
  item: Item
  no: number
  kind: string
  name: string
  code: OutletSpec['code']
  h: number
  note: string
  /** plan position, mm */
  p: Vec2
}

export function fixtureOutlets(ctx: AlbumCtx, doc: Doc, levelId: Id): FixtureOutlet[] {
  const out: FixtureOutlet[] = []
  const list = Object.values(doc.items)
    .filter((it) => it.levelId === levelId && !it.hidden && isPlumbingItem(ctx, it))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  let no = 0
  for (const it of list) {
    const kind = plumbingKind(ctx, it)
    const spec = FIXTURE_OUTLETS[kind]
    if (!spec) continue
    no++
    const r = (it.rotation * Math.PI) / 180
    const ux = V(Math.cos(r), Math.sin(r))
    const uy = V(-Math.sin(r), Math.cos(r))
    const k = it.mirrored ? -1 : 1
    for (const o of spec.outlets) {
      const lx = Math.max(-it.size.w / 2 + 40, Math.min(it.size.w / 2 - 40, o.dx)) * k
      const ly = -it.size.d / 2 + 30
      out.push({
        item: it,
        no,
        kind,
        name: itemTitle(doc, ctx.catalog, it) || spec.name,
        code: o.code,
        h: o.h,
        note: o.note,
        p: V(it.x + ux.x * lx + uy.x * ly, it.y + ux.y * lx + uy.y * ly),
      })
    }
  }
  return out
}

function roomAt(ctx: AlbumCtx, levelId: Id, p: Vec2): string {
  const plan = ctx.plans[levelId]
  const r = plan?.rooms.find((x) => pointInPoly(p, x.polygon))
  return r ? roomTitle(ctx.doc, r) : '—'
}

registerSheetContributor({
  id: 'fixtures',
  sheets: ['plumbing'],
  has: (doc) => Object.keys(doc.items).length > 0,
  draw: (_sheet, { ctx, doc, levelId, S }): Contribution | null => {
    const outs = fixtureOutlets(ctx, doc, levelId)
    if (!outs.length) return null
    const items: DisplayItem[] = []
    const seen = new Set<Id>()
    for (const o of outs) {
      const c = OUTLET_COLOR[o.code]
      items.push({ t: 'circle', layer: 'annotations', role: 'tp-outlet', c: o.p, r: 1.1 * S, stroke: { color: c, width: 0.25 }, fill: { color: '#ffffff' } })
      items.push(label(V(o.p.x, o.p.y - 2.6 * S), o.code, 1.8, S, { color: c }))
      if (!seen.has(o.item.id)) {
        seen.add(o.item.id)
        items.push(...marker(V(o.item.x, o.item.y), `С${o.no}`, S, { color: '#1d4e89' }))
      }
    }
    const schedule: TableRow[] = outs.map((o) => [`С${o.no}`, o.name, `${o.code} — ${o.note}`, String(o.h), roomAt(ctx, levelId, o.p)])
    return {
      items,
      schedule,
      legend: [
        [{ text: 'В1', swatch: { kind: 'line', stroke: { color: OUTLET_COLOR.В1, width: 0.5 } } }, 'Водопровод холодной воды (ХВС)'],
        [{ text: 'Т3', swatch: { kind: 'line', stroke: { color: OUTLET_COLOR.Т3, width: 0.5 } } }, 'Водопровод горячей воды (ГВС)'],
        [{ text: 'К1', swatch: { kind: 'line', stroke: { color: OUTLET_COLOR.К1, width: 0.5 } } }, 'Канализация бытовая'],
      ],
      notes: [
        'Выводы показаны по сантехприборам плана с типовыми высотами от уровня чистого пола; уточнить по паспортам выбранных приборов до начала черновых работ.',
        'Горячая вода — слева, холодная — справа (если смотреть на прибор).',
      ],
      points: outs.map((o) => ({ x: o.p.x, y: o.p.y, h: o.h, code: o.code, color: OUTLET_COLOR[o.code] })),
    }
  },
})

registerSheetContributor({
  id: 'thermostats',
  sheets: ['underfloor'],
  has: (doc) => Object.values(doc.electrical ?? {}).some((p) => p.kind === 'thermostat'),
  draw: (_sheet, { ctx, doc, levelId, plan, S }): Contribution | null => {
    const ths = Object.values(doc.electrical ?? {}).filter((p) => p.levelId === levelId && p.kind === 'thermostat')
    if (!ths.length) return null
    const items: DisplayItem[] = []
    const schedule: TableRow[] = []
    let n = 0
    const done = new Set<Id>()
    for (const t of ths) {
      items.push(...marker(V(t.x, t.y), 'ТР', S, { color: '#c0392b' }))
      items.push(label(V(t.x, t.y + 3.6 * S), `h=${Math.round(t.elevation)}`, 1.8, S, { color: '#c0392b' }))
      const r = plan.rooms.find((x) => pointInPoly(t, x.polygon)) ?? plan.rooms.find((x) => x.edges.some((e) => e.wallId === t.wallId))
      if (!r || done.has(r.roomId)) continue
      done.add(r.roomId)
      n++
      items.push({
        t: 'poly',
        layer: 'annotations',
        role: 'tp-heating',
        pts: r.polygon,
        closed: true,
        stroke: { color: '#c0392b', width: 0.3, dash: [3, 1] },
        fill: { color: '#c0392b', opacity: 0.08, hatch: { color: '#c0392b', angle: 45, spacing: 3, width: 0.1 } },
      })
      schedule.push([`ТП${n}`, roomTitle(ctx.doc, r), fmtNum(r.area), 'по проекту (мат / кабель)'])
    }
    return {
      items,
      schedule,
      legend: [
        [{ text: 'ТР', swatch: { kind: 'fill', fill: { color: '#c0392b', opacity: 0.15 } } }, 'Зона тёплого пола; ТР — терморегулятор'],
      ],
      notes: ['Зоны определены по помещениям с терморегулятором; уточнить укладку и мощность по выбранной системе.'],
    }
  },
})
