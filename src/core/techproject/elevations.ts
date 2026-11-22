/**
 * Wall elevations (развёртки стен) of wet rooms and kitchens: each wall face of the room seen from
 * inside, with openings, finish bands and the tile joints, electrical points and plumbing outlets
 * with their ties, and the wall-side furniture (cabinets, fixtures) as outlines.
 *
 * Elevation coordinates: x = distance along the face from its left end as seen from inside the
 * room, y = −height above the finished floor (y down like the plan), world mm.
 */
import type { DisplayItem, DisplayLayer, DlPen } from '../display'
import { electricType } from '../electrical'
import type { DerivedRoom, Doc, Id, Item, Material, TilePattern, Vec2 } from '../types'
import { type Box, dimChain, fmtNum, label, marker, placeText, textWidth, tileJoints, type LayoutKind } from './annot'
import { itemTitle, lookupMaterial, materialTitle, roomTitle, settingOf } from './common'
import { contribute } from './contrib'
import { boundsOfItems, layBlockSheets, type SheetBlock, toPaper, workArea } from './layout'
import type { AlbumCtx, PageDraft } from './model'
import { stampRect, text } from './paper'
import { ceilingHeightOf, realRooms } from './plans'

const V = (x: number, y: number): Vec2 => ({ x, y })
const sub = (a: Vec2, b: Vec2) => V(a.x - b.x, a.y - b.y)
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y

export interface Face {
  wallId: Id
  side: 'left' | 'right'
  from: Vec2
  to: Vec2
  length: number
  /** unit vector along the face (left → right as seen from inside) */
  u: Vec2
  /** unit normal into the room */
  n: Vec2
  letter: string
}

const LETTERS = 'АБВГДЕЖИКЛМНПРСТУФ'

/** wall faces around a room, consecutive pieces of one wall face merged */
export function roomFaces(doc: Doc, r: DerivedRoom): Face[] {
  const out: Face[] = []
  for (const e of r.edges) {
    const w = doc.walls[e.wallId]
    if (!w || w.kind === 'virtual') continue
    const L = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y)
    if (L < 150) continue
    const last = out[out.length - 1]
    if (last && last.wallId === e.wallId && last.side === e.side && Math.hypot(last.to.x - e.from.x, last.to.y - e.from.y) < 5) {
      last.to = e.to
      last.length = Math.hypot(last.to.x - last.from.x, last.to.y - last.from.y)
      continue
    }
    const u = V((e.to.x - e.from.x) / L, (e.to.y - e.from.y) / L)
    out.push({ wallId: e.wallId, side: e.side, from: e.from, to: e.to, length: L, u, n: V(-u.y, u.x), letter: '' })
  }
  out.forEach((f, i) => (f.letter = LETTERS[i % LETTERS.length] + (i >= LETTERS.length ? String(Math.floor(i / LETTERS.length)) : '')))
  return out
}

/** rooms that get elevations by default: bathrooms, toilets, kitchens */
export function defaultElevationRooms(doc: Doc, ctx: Pick<AlbumCtx, 'plans' | 'levels'>): Id[] {
  const out: Id[] = []
  for (const lv of ctx.levels) {
    for (const r of ctx.plans[lv]?.rooms ?? []) {
      const t = doc.rooms[r.roomId]?.type
      if (t === 'bathroom' || t === 'toilet' || t === 'kitchen' || t === 'kitchenLiving') out.push(r.roomId)
    }
  }
  return out
}

function tileOf(pattern: TilePattern | undefined, m: Material | undefined): { w: number; h: number; type: string; rot: number; ox: number; oy: number } | null {
  const p = pattern && pattern.type !== 'none' ? pattern : m?.pattern && m.pattern.type !== 'none' ? m.pattern : undefined
  if (p && p.tileW > 0 && p.tileH > 0) return { w: p.tileW, h: p.tileH, type: p.type, rot: p.rotation || 0, ox: p.offsetX ?? 0, oy: p.offsetY ?? 0 }
  if (m && (m.category === 'tile' || m.category === 'stone' || m.category === 'marble') && m.sizeMm && m.sizeMm[0] > 0) return { w: m.sizeMm[0], h: m.sizeMm[1], type: 'grid', rot: 0, ox: 0, oy: 0 }
  return null
}

const STRAIGHT = new Set(['grid', 'brick', 'brickThird', 'planks', 'diagonal'])

interface ElevPoint {
  u: number
  h: number
  code: string
  color: string
  /** half size of the mark (world mm) */
  hw: number
  hh: number
  layer: DisplayLayer
}

function itemCorners(it: Item): Vec2[] {
  const r = (it.rotation * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const w = it.size.w / 2
  const d = it.size.d / 2
  return [V(-w, -d), V(w, -d), V(w, d), V(-w, d)].map((p) => V(it.x + p.x * c - p.y * s, it.y + p.x * s + p.y * c))
}

/** one wall face as a world drawing for 1:S */
export function faceDrawing(ctx: AlbumCtx, levelId: Id, r: DerivedRoom, f: Face, S: number, outlets: { x: number; y: number; h: number; code: string; color?: string }[]): DisplayItem[] {
  const { doc, catalog } = ctx
  const items: DisplayItem[] = []
  const H = ceilingHeightOf(doc, levelId, r)
  const L = f.length
  const thick: DlPen = { color: '#111111', width: 0.5 }
  const thin: DlPen = { color: '#111111', width: 0.18 }
  const joint: DlPen = { color: '#8a8a8a', width: 0.1 }
  const U = (p: Vec2) => dot(sub(p, f.from), f.u)
  const D = (p: Vec2) => dot(sub(p, f.from), f.n)
  const wall = doc.walls[f.wallId]
  const g = ctx.plans[levelId].wallGeoms[f.wallId]
  // openings in this face
  const holes: Vec2[][] = []
  if (wall && g) {
    const ax = V((g.b.x - g.a.x) / (g.length || 1), (g.b.y - g.a.y) / (g.length || 1))
    for (const o of Object.values(doc.openings)) {
      if (o.wallId !== f.wallId) continue
      const c = V(g.a.x + ax.x * o.offset, g.a.y + ax.y * o.offset)
      const uc = U(c)
      const u0 = Math.max(0, uc - o.width / 2)
      const u1 = Math.min(L, uc + o.width / 2)
      if (u1 - u0 < 10) continue
      const top = Math.min(H, o.sill + o.height)
      const ring = [V(u0, -o.sill), V(u1, -o.sill), V(u1, -top), V(u0, -top)]
      holes.push(ring)
      items.push({ t: 'poly', layer: 'openings', role: 'elev-opening', pts: ring, closed: true, stroke: thin, fill: { color: '#ffffff' } })
      // opening sign: diagonals to the hinge side for doors, a cross for windows
      const door = o.sill < 10
      items.push({ t: 'line', layer: 'openings', role: 'elev-opening', a: ring[door ? 0 : 0], b: ring[2], stroke: { ...thin, width: 0.1, dash: [1, 0.8] } })
      items.push({ t: 'line', layer: 'openings', role: 'elev-opening', a: ring[1], b: ring[3], stroke: { ...thin, width: 0.1, dash: [1, 0.8] } })
      items.push(label(V((u0 + u1) / 2, -top - 2.5 * S), `${Math.round(o.width)}×${Math.round(o.height)}`, 2, S, { color: '#333333' }))
    }
  }
  // finish bands of the face
  const side = wall?.[f.side]
  const zones = (side?.zones ?? []).map((z) => ({ from: Math.max(0, z.from), to: Math.min(H, z.to), materialId: z.materialId, pattern: z.pattern, label: z.label })).filter((z) => z.to > z.from)
  zones.sort((a, b) => a.from - b.from)
  const bands: { from: number; to: number; materialId: Id; pattern?: TilePattern; label?: string }[] = []
  let cur = 0
  for (const z of zones) {
    if (z.from > cur && side) bands.push({ from: cur, to: z.from, materialId: side.materialId, pattern: side.pattern })
    bands.push({ ...z, from: Math.max(cur, z.from) })
    cur = Math.max(cur, z.to)
  }
  if (cur < H && side) bands.push({ from: cur, to: H, materialId: side.materialId, pattern: side.pattern })
  const legend: string[] = []
  for (const b of bands) {
    const m = lookupMaterial(doc, catalog, b.materialId)
    const t = tileOf(b.pattern, m)
    const rect = [V(0, -b.from), V(L, -b.from), V(L, -b.to), V(0, -b.to)]
    if (t && Math.min(t.w, t.h) / S >= 1.2) {
      const kind: LayoutKind = (STRAIGHT.has(t.type) ? t.type : 'grid') as LayoutKind
      items.push(...tileJoints([rect, ...holes], V(t.ox, -b.from - t.oy), t.w, t.h, -t.rot, kind, STRAIGHT.has(t.type) ? joint : { ...joint, dash: [0.6, 0.6] }, 'rooms'))
    }
    if (b.from > 0) items.push({ t: 'line', layer: 'walls', role: 'elev-band', a: V(0, -b.from), b: V(L, -b.from), stroke: { ...thin, width: 0.3 } })
    const name = `${b.label ? `${b.label}: ` : ''}${materialTitle(m, b.materialId)}${t ? `, ${Math.round(t.w)}×${Math.round(t.h)}` : ''}`
    legend.push(name)
  }
  // outline of the face (floor and ceiling lines thick)
  items.push({ t: 'poly', layer: 'walls', role: 'elev-outline', pts: [V(0, 0), V(L, 0), V(L, -H), V(0, -H)], closed: true, stroke: thick })
  items.push({ t: 'line', layer: 'walls', role: 'elev-floor', a: V(-4 * S, 0), b: V(L + 4 * S, 0), stroke: thick })
  // furniture against the face (names placed after the points, clear of their marks)
  const names: { u0: number; u1: number; z0: number; z1: number; name: string }[] = []
  for (const it of Object.values(doc.items)) {
    if (it.levelId !== levelId || it.hidden || it.mount === 'ceiling') continue
    const cs = itemCorners(it)
    const ds = cs.map(D)
    const us = cs.map(U)
    const u0 = Math.max(0, Math.min(...us))
    const u1 = Math.min(L, Math.max(...us))
    if (u1 - u0 < 30 || Math.min(...ds) > 200 || Math.max(...ds) < -50) continue
    const z0 = Math.max(0, it.elevation)
    const z1 = Math.min(H, it.elevation + it.size.h)
    if (z1 - z0 < 10) continue
    items.push({ t: 'poly', layer: 'furniture', role: 'elev-item', pts: [V(u0, -z0), V(u1, -z0), V(u1, -z1), V(u0, -z1)], closed: true, stroke: { color: '#5a5a5a', width: 0.2, dash: [1.5, 0.8] } })
    const name = itemTitle(doc, catalog, it)
    if ((u1 - u0) / S > 12) names.push({ u0, u1, z0, z1, name: name.length > 28 ? `${name.slice(0, 27)}…` : name })
  }
  // electrical points and plumbing outlets on the face
  const pts: ElevPoint[] = []
  for (const p of Object.values(doc.electrical ?? {})) {
    if (p.levelId !== levelId || p.mount !== 'wall') continue
    const onFace = p.wallId === f.wallId && (!p.side || p.side === f.side)
    const near = Math.abs(D(p)) < 60
    if (!onFace && !near) continue
    const u = U(p)
    if (u < -10 || u > L + 10) continue
    const n = Math.max(1, p.gangs ?? 1)
    const w = 71 * n
    const vert = p.vertical === true
    const ww = vert ? 71 : w
    const hh = vert ? w : 71
    pts.push({ u, h: p.elevation, code: electricType(p.kind).code, color: '#b3261e', hw: ww / 2, hh: hh / 2, layer: 'electrical' })
    items.push({ t: 'poly', layer: 'electrical', role: 'elev-electric', pts: [V(u - ww / 2, -p.elevation - hh / 2), V(u + ww / 2, -p.elevation - hh / 2), V(u + ww / 2, -p.elevation + hh / 2), V(u - ww / 2, -p.elevation + hh / 2)], closed: true, stroke: { color: '#b3261e', width: 0.25 } })
  }
  for (const o of outlets) {
    if (Math.abs(D(o)) > 300) continue
    const u = U(o)
    if (u < -10 || u > L + 10) continue
    pts.push({ u, h: o.h, code: o.code, color: o.color ?? '#1d4e89', hw: 1.2 * S, hh: 1.2 * S, layer: 'annotations' })
    items.push({ t: 'circle', layer: 'annotations', role: 'elev-outlet', c: V(u, -o.h), r: 1.2 * S, stroke: { color: o.color ?? '#1d4e89', width: 0.25 }, fill: { color: '#ffffff' } })
  }
  // codes of the points: above, right, left, below, further out — never over another mark or code
  const taken: Box[] = pts.map((p) => ({ x0: p.u - p.hw - 0.3 * S, y0: -p.h - p.hh - 0.3 * S, x1: p.u + p.hw + 0.3 * S, y1: -p.h + p.hh + 0.3 * S }))
  const inFace = (c: Vec2, t: string, size: number) => {
    const w = textWidth(t, size) / 2
    return c.x - w > -2 * S && c.x + w < L + 2 * S && c.y + size * 0.6 < -0.3 * S && c.y - size * 0.6 > -H
  }
  const order = pts.map((_, i) => i).sort((a, b) => pts[a].u - pts[b].u || pts[b].h - pts[a].h)
  for (const i of order) {
    const p = pts[i]
    const size = 1.9 * S
    const tw = textWidth(p.code, size) / 2
    const dy = p.hh + size * 0.6 + 0.5 * S
    const dx = p.hw + tw + 0.6 * S
    const y = -p.h
    const cands = [V(p.u, y - dy), V(p.u + dx, y), V(p.u - dx, y), V(p.u, y + dy), V(p.u + dx, y - dy), V(p.u - dx, y - dy), V(p.u + dx, y + dy), V(p.u - dx, y + dy), V(p.u, y - dy - 2.4 * S), V(p.u + dx + 2 * tw + S, y)].filter((c) => inFace(c, p.code, size))
    const at = placeText(cands.length ? cands : [V(p.u, y - dy)], p.code, size, taken)
    items.push(label(at, p.code, 1.9, S, { color: p.color, layer: p.layer }))
  }
  for (const nm of names) {
    const size = 1.8 * S
    const cu = (nm.u0 + nm.u1) / 2
    const zs = [0.5, 0.3, 0.7, 0.15, 0.85].map((k) => -(nm.z0 + (nm.z1 - nm.z0) * k))
    const cands = zs.flatMap((y) => [V(cu, y), V(nm.u0 + (nm.u1 - nm.u0) * 0.3, y), V(nm.u0 + (nm.u1 - nm.u0) * 0.7, y)]).filter((c) => textWidth(nm.name, size) < nm.u1 - nm.u0 || c.x === cu)
    items.push(label(placeText(cands, nm.name, size, taken), nm.name, 1.8, S, { color: '#5a5a5a' }))
  }
  // ties: along the floor and heights at the right
  const us = [...new Set(pts.map((p) => Math.round(Math.max(0, Math.min(L, p.u)))))].sort((a, b) => a - b).filter((u) => u > 5 && u < L - 5)
  items.push(...dimChain([0, ...us, L].map((u) => V(u, 0)), -6 * S, S))
  if (us.length) items.push(...dimChain([0, L].map((u) => V(u, 0)), -13 * S, S))
  const hs = [...new Set(pts.map((p) => Math.round(p.h)))].sort((a, b) => a - b).filter((h) => h > 5 && h < H - 5)
  items.push(...dimChain([0, ...hs, H].map((h) => V(L, -h)), -6 * S, S))
  if (hs.length) items.push(...dimChain([0, H].map((h) => V(L, -h)), -13 * S, S))
  // band heights at the left
  const bh = [...new Set(bands.map((b) => Math.round(b.from)))].filter((h) => h > 5).sort((a, b) => a - b)
  if (bh.length) items.push(...dimChain([0, ...bh, H].map((h) => V(0, -h)), 6 * S, S))
  // caption
  items.push(label(V(L / 2, -H - 9 * S), `Развёртка ${f.letter}`, 3.2, S, { bold: true, layer: 'text' }))
  if (legend.length) {
    const s = [...new Set(legend)].join('; ')
    items.push(label(V(L / 2, 22 * S), s.length > 110 ? `${s.slice(0, 109)}…` : s, 2, S, { color: '#333333', layer: 'text' }))
  }
  return items
}

/** key plan of the room: outline with face letters and view arrows, paper mm, fitted into w × h */
function keyPlan(r: DerivedRoom, faces: Face[], w: number, h: number): DisplayItem[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of r.polygon) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const k = Math.min((w - 16) / Math.max(1, maxX - minX), (h - 16) / Math.max(1, maxY - minY))
  const ox = 8 + (w - 16 - (maxX - minX) * k) / 2
  const oy = 8 + (h - 16 - (maxY - minY) * k) / 2
  const P = (p: Vec2) => V(ox + (p.x - minX) * k, oy + (p.y - minY) * k)
  const items: DisplayItem[] = [{ t: 'poly', layer: 'sheet', role: 'keyplan', pts: r.polygon.map(P), closed: true, stroke: { color: '#111111', width: 0.4 }, fill: { color: '#f6f6f6' } }]
  for (const f of faces) {
    const m = P(V((f.from.x + f.to.x) / 2, (f.from.y + f.to.y) / 2))
    const c = V(m.x + f.n.x * 4.5, m.y + f.n.y * 4.5)
    items.push(...marker(c, f.letter, 1, { layer: 'sheet' }))
  }
  return items
}

/** sheets of wall elevations of the chosen rooms */
export function elevationSheets(ctx: AlbumCtx): PageDraft[] {
  const { doc } = ctx
  const ids = new Set(ctx.settings.elevationRooms ?? defaultElevationRooms(doc, ctx))
  const set = settingOf(ctx, 'elevations')
  const pages: PageDraft[] = []
  const wa = workArea(ctx.paper)
  const st = stampRect(ctx.paper)
  const maxW = wa.w
  const maxH = st.y - 6 - wa.y
  for (const lv of ctx.levels) {
    const plan = ctx.plans[lv]
    const outlets = contribute('plumbing', { ctx, doc, levelId: lv, plan, S: 25 }).points ?? []
    for (const r of realRooms(doc, plan)) {
      if (!ids.has(r.roomId)) continue
      const faces = roomFaces(doc, r)
      if (!faces.length) continue
      const blocks: SheetBlock[] = []
      const title = `Развёртки стен. ${roomTitle(doc, r)}`
      let usedS = set?.scale ?? 25
      blocks.push({ kind: 'items', items: [text(V(0, 3), title, 3.5, { bold: true, role: 'caption' }), ...keyPlan(r, faces, 60, 50).map((it) => shift(it, 0, 6))], w: 70, h: 58 })
      for (const f of faces) {
        let S = set?.scale ?? 25
        let world = faceDrawing(ctx, lv, r, f, S, outlets)
        let b = boundsOfItems(world)
        for (const alt of [S, 50, 75, 100]) {
          if (alt < S) continue
          if (alt !== S) {
            S = alt
            world = faceDrawing(ctx, lv, r, f, S, outlets)
            b = boundsOfItems(world)
          }
          if ((b.maxX - b.minX) / S <= maxW && (b.maxY - b.minY) / S <= maxH) break
        }
        usedS = Math.max(usedS, S)
        const items = toPaper(world, S, -b.minX / S, -b.minY / S)
        items.push(text(V((b.maxX - b.minX) / S / 2, (b.maxY - b.minY) / S + 1), `М 1:${S}`, 2.2, { anchor: 'middle', role: 'caption' }))
        blocks.push({ kind: 'items', items, w: (b.maxX - b.minX) / S, h: (b.maxY - b.minY) / S + 4 })
      }
      const laid = layBlockSheets(ctx.paper, blocks)
      laid.forEach((items, i) => pages.push({ kind: 'elevations', title: i ? `${title} (продолжение)` : title, scale: usedS, items, levelId: lv }))
    }
  }
  if (!pages.length) pages.push({ kind: 'elevations', title: 'Развёртки стен', scale: 1, items: [], empty: 'Нет помещений для развёрток (санузлы, кухни)' })
  return pages
}

function shift(it: DisplayItem, dx: number, dy: number): DisplayItem {
  const P = (p: Vec2) => V(p.x + dx, p.y + dy)
  switch (it.t) {
    case 'poly':
      return { ...it, pts: it.pts.map(P), holes: it.holes?.map((h) => h.map(P)) }
    case 'line':
      return { ...it, a: P(it.a), b: P(it.b) }
    case 'arc':
    case 'circle':
      return { ...it, c: P(it.c) }
    case 'text':
      return { ...it, p: P(it.p) }
  }
}

export { fmtNum }
