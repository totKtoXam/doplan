/**
 * PlanSpec JSON helpers used by the CLI WITHOUT going through core (so normalisation and px↔mm
 * transforms work on drafts that core would still reject). Field names follow
 * docs/research/photo-to-plan.md §4.2 (PlanSpec v1).
 *
 * Unit convention (binding for dp):
 *  - units "px": every plan-plane value is px of `source.image` — points, rect, polygon, at, opening
 *    width/offset. Wall/edgeWall `thickness`, all heights, sills, ceilingHeight and `defaults` are ALWAYS mm.
 *  - units "mm" | "cm" | "m": everything on the plan plane in that unit (thickness / heights still mm).
 */
import { readFileSync } from 'node:fs'
import { DpError, errMsg } from './output'

export type Pt = number[]

export interface SpecCalibration {
  p1: Pt
  p2: Pt
  mm: number
  label?: string
}

export interface SpecSource {
  image?: string
  size?: number[]
  kind?: string
  mmPerPx?: number
  mmPerPxY?: number
  originPx?: Pt
  calibration?: SpecCalibration[]
  labelledTotalArea?: number
  labelledLivingArea?: number
  toScale?: boolean
  [k: string]: unknown
}

export interface SpecWall {
  id?: string
  path: Pt[]
  closed?: boolean
  align?: 'center' | 'inner' | 'outer'
  thickness?: number
  kind?: string
  height?: number
  confidence?: number
  [k: string]: unknown
}

export interface SpecRoom {
  id: string
  name?: string
  type?: string
  number?: string
  rect?: number[]
  polygon?: Pt[]
  at?: Pt
  labelledArea?: number
  ceilingHeight?: number
  edgeWall?: { kind: string; thickness?: number; height?: number }
  confidence?: number
  [k: string]: unknown
}

export interface SpecOpening {
  id?: string
  type: string
  at?: Pt
  wall?: string
  offset?: number
  width: number
  height?: number
  sill?: number
  between?: string[]
  opensInto?: string
  hinge?: 'left' | 'right'
  confidence?: number
  [k: string]: unknown
}

export interface SpecFixture {
  type: string
  rect?: number[]
  at?: Pt
  rotation?: number
  [k: string]: unknown
}

export interface SpecJson {
  version: number
  units: 'mm' | 'cm' | 'm' | 'px'
  name?: string
  source?: SpecSource
  defaults?: Record<string, number | undefined>
  snap?: { orthogonal?: boolean; orthoToleranceDeg?: number; angleStepDeg?: number; gridMm?: number; mergeMm?: number }
  walls?: SpecWall[]
  rooms: SpecRoom[]
  openings: SpecOpening[]
  fixtures?: SpecFixture[]
  notes?: string[]
  [k: string]: unknown
}

export function readJsonFile(file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new DpError(`cannot read ${file}: ${errMsg(e)}`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    throw new DpError(`${file} is not valid JSON: ${errMsg(e)}`)
  }
}

/** light structural check (core's parsePlanSpec does the full validation) */
export function asSpecJson(raw: unknown, file: string): SpecJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DpError(`${file}: PlanSpec must be a JSON object`)
  const s = raw as SpecJson
  if (!['mm', 'cm', 'm', 'px'].includes(s.units)) throw new DpError(`${file}: "units" must be "mm", "cm", "m" or "px"`)
  if (!Array.isArray(s.rooms)) throw new DpError(`${file}: "rooms" must be an array`)
  if (s.openings === undefined) s.openings = []
  if (!Array.isArray(s.openings)) throw new DpError(`${file}: "openings" must be an array`)
  if (s.version === undefined) s.version = 1
  return s
}

export function readSpec(file: string): SpecJson {
  return asSpecJson(readJsonFile(file), file)
}

// ───────────────────────── scale / transform ─────────────────────────

export interface Scale {
  /** mm per px along x and y */
  sx: number
  sy: number
  /** px position of mm (0,0) */
  ox: number
  oy: number
  from: 'mmPerPx' | 'calibration' | 'areas' | 'override'
  residualsPct?: number[]
  anisotropyPct?: number
}

const isPt = (p: unknown): p is Pt => Array.isArray(p) && p.length >= 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v))

export function calibrationScale(cal: SpecCalibration[]): { sx: number; sy: number; residualsPct: number[]; anisotropyPct: number } | null {
  const refs = cal
    .filter((c) => isPt(c.p1) && isPt(c.p2) && c.mm > 0)
    .map((c) => {
      const dx = c.p2[0] - c.p1[0]
      const dy = c.p2[1] - c.p1[1]
      const len = Math.hypot(dx, dy)
      return { len, mpp: c.mm / len, horiz: Math.abs(dx) >= Math.abs(dy) }
    })
    .filter((r) => r.len > 0)
  if (refs.length === 0) return null
  const wavg = (rs: typeof refs) => rs.reduce((a, r) => a + r.mpp * r.len, 0) / rs.reduce((a, r) => a + r.len, 0)
  const all = wavg(refs)
  const hs = refs.filter((r) => r.horiz)
  const vs = refs.filter((r) => !r.horiz)
  let sx = all
  let sy = all
  let anisotropyPct = 0
  if (hs.length && vs.length) {
    const h = wavg(hs)
    const v = wavg(vs)
    anisotropyPct = (Math.abs(h - v) / ((h + v) / 2)) * 100
    if (anisotropyPct > 2) {
      sx = h
      sy = v
    }
  }
  const residualsPct = refs.map((r) => Math.round(((r.mpp - (r.horiz ? sx : sy)) / (r.horiz ? sx : sy)) * 1000) / 10)
  return { sx, sy, residualsPct, anisotropyPct: Math.round(anisotropyPct * 10) / 10 }
}

/** Least-squares mm/px from labelled room areas: A_i ≈ s²·P_i  →  s² = Σ A_i P_i / Σ P_i² */
export function areaScale(spec: SpecJson): { s: number; residualsPct: { id: string; pct: number }[] } | null {
  const rows: { id: string; A: number; P: number }[] = []
  for (const r of spec.rooms) {
    if (!(typeof r.labelledArea === 'number' && r.labelledArea > 0)) continue
    const P = roomPxArea(r)
    if (P && P > 0) rows.push({ id: r.id, A: r.labelledArea * 1e6, P })
  }
  if (rows.length === 0) return null
  const num = rows.reduce((a, r) => a + r.A * r.P, 0)
  const den = rows.reduce((a, r) => a + r.P * r.P, 0)
  const s = Math.sqrt(num / den)
  return {
    s,
    residualsPct: rows.map((r) => ({ id: r.id, pct: Math.round(((s * s * r.P - r.A) / r.A) * 1000) / 10 })),
  }
}

/** area of a room's rect/polygon in spec units² (null for label-point-only rooms) */
export function roomPxArea(r: SpecRoom): number | null {
  if (Array.isArray(r.rect) && r.rect.length === 4) return Math.abs(r.rect[2] * r.rect[3])
  if (Array.isArray(r.polygon) && r.polygon.length >= 3 && r.polygon.every(isPt)) return Math.abs(polyArea(r.polygon))
  return null
}

export function resolveScale(spec: SpecJson, override?: number): Scale | null {
  const src = spec.source ?? {}
  const o = isPt(src.originPx) ? src.originPx : [0, 0]
  if (override && override > 0) return { sx: override, sy: override, ox: o[0], oy: o[1], from: 'override' }
  if (typeof src.mmPerPx === 'number' && src.mmPerPx > 0) {
    const sy = typeof src.mmPerPxY === 'number' && src.mmPerPxY > 0 ? src.mmPerPxY : src.mmPerPx
    return { sx: src.mmPerPx, sy, ox: o[0], oy: o[1], from: 'mmPerPx' }
  }
  if (Array.isArray(src.calibration) && src.calibration.length) {
    const c = calibrationScale(src.calibration)
    if (c) return { sx: c.sx, sy: c.sy, ox: o[0], oy: o[1], from: 'calibration', residualsPct: c.residualsPct, anisotropyPct: c.anisotropyPct }
  }
  if (spec.units === 'px') {
    const a = areaScale(spec)
    if (a) return { sx: a.s, sy: a.s, ox: o[0], oy: o[1], from: 'areas', residualsPct: a.residualsPct.map((r) => r.pct) }
  }
  return null
}

export function pxToMm(sc: Scale, p: Pt): [number, number] {
  return [(p[0] - sc.ox) * sc.sx, (p[1] - sc.oy) * sc.sy]
}

export function mmToPx(sc: Scale, x: number, y: number): [number, number] {
  return [x / sc.sx + sc.ox, y / sc.sy + sc.oy]
}

// ───────────────────────── geometry helpers ─────────────────────────

export function polyArea(p: Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i][0] * q[1] - q[0] * p[i][1]
  }
  return a / 2
}

export function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * A point inside the room (spec units): `at`, rect centre, or a point inside the polygon
 * (centroid if inside, else the middle of the widest horizontal chord through the polygon).
 */
export function roomRefPoint(r: SpecRoom): Pt | null {
  if (isPt(r.at)) return [r.at[0], r.at[1]]
  if (Array.isArray(r.rect) && r.rect.length === 4) return [r.rect[0] + r.rect[2] / 2, r.rect[1] + r.rect[3] / 2]
  if (Array.isArray(r.polygon) && r.polygon.length >= 3 && r.polygon.every(isPt)) {
    const pts = r.polygon.map((p) => ({ x: p[0], y: p[1] }))
    const a = polyArea(r.polygon)
    let cx = 0
    let cy = 0
    for (let i = 0; i < r.polygon.length; i++) {
      const p = r.polygon[i]
      const q = r.polygon[(i + 1) % r.polygon.length]
      const f = p[0] * q[1] - q[0] * p[1]
      cx += (p[0] + q[0]) * f
      cy += (p[1] + q[1]) * f
    }
    if (a !== 0) {
      cx /= 6 * a
      cy /= 6 * a
      if (pointInPoly(cx, cy, pts)) return [cx, cy]
    }
    // widest chord on a few scanlines
    const ys = pts.map((p) => p.y)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    let best: Pt | null = null
    let bestW = -1
    for (let k = 1; k < 16; k++) {
      const y = minY + ((maxY - minY) * k) / 16
      const xs: number[] = []
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const p = pts[i]
        const q = pts[j]
        if (p.y > y !== q.y > y) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y))
      }
      xs.sort((u, v) => u - v)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        if (xs[i + 1] - xs[i] > bestW) {
          bestW = xs[i + 1] - xs[i]
          best = [(xs[i] + xs[i + 1]) / 2, y]
        }
      }
    }
    return best
  }
  return null
}

/** area coefficients for "общая площадь" (SP 54.13330 / BTI practice) */
export const SUMMER_COEF: Record<string, number> = { balcony: 0.3, loggia: 0.5, terrace: 0.3 }
export const LIVING_TYPES = new Set(['living', 'bedroom', 'kids', 'study'])

/** mm per spec unit for metric units (null for px) */
export function metricFactor(units: SpecJson['units']): number | null {
  return units === 'cm' ? 10 : units === 'm' ? 1000 : units === 'mm' ? 1 : null
}
