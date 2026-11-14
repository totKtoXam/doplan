/**
 * Compile / measure / render / pack helpers shared by `dp spec …` and `dp doc …`.
 * All doplan semantics come from core (lib/core.ts); this file only adapts IO and drawing.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import sharp from 'sharp'
import {
  buildDisplayList,
  compilePlanSpec,
  type DerivedPlan,
  type Doc,
  derivePlan,
  drawToCanvas,
  parseDoc,
  parsePlanSpec,
  serializeDoc,
  type Underlay,
  validatePlanSpec,
} from './core'
import { haloText, LABEL_FONT } from './draw'
import { ensureDirFor } from './image'
import { DpError, errMsg, r2 } from './output'
import {
  LIVING_TYPES,
  metricFactor,
  pointInPoly,
  pxToMm,
  resolveScale,
  roomRefPoint,
  type Scale,
  type SpecJson,
  SUMMER_COEF,
} from './spec'

// ───────────────────────── issues ─────────────────────────

export type IssueLevel = 'error' | 'warn' | 'info'

export interface Issue {
  level: IssueLevel
  code: string
  msg: string
  ids?: string[]
  bbox?: unknown
}

/** Accepts whatever shape core's PlanIssue has ({level|severity, code, msg|message, ids?, bbox?}). */
export function normIssue(raw: unknown): Issue {
  if (typeof raw === 'string') return { level: 'warn', code: 'ISSUE', msg: raw }
  const o = (raw ?? {}) as Record<string, unknown>
  const lv = String(o.level ?? o.severity ?? o.type ?? 'warn').toLowerCase()
  const level: IssueLevel = lv.startsWith('err') ? 'error' : lv.startsWith('info') || lv === 'hint' ? 'info' : 'warn'
  const msg = String(o.msg ?? o.message ?? o.text ?? JSON.stringify(o))
  const idsRaw = o.ids ?? o.refs ?? (o.id !== undefined ? [o.id] : undefined)
  const ids = Array.isArray(idsRaw) ? idsRaw.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : undefined
  return { level, code: String(o.code ?? 'ISSUE'), msg, ...(ids ? { ids } : {}), ...(o.bbox !== undefined ? { bbox: o.bbox } : {}) }
}

export function firstLevel(doc: Doc): string {
  const id = doc.levelOrder[0] ?? Object.keys(doc.levels)[0]
  if (!id) throw new DpError('document has no levels')
  return id
}

// ───────────────────────── compile ─────────────────────────

export interface Compiled {
  doc: Doc | null
  issues: Issue[]
}

/** parse → validate → compile, collecting every problem instead of throwing */
export function compileSpecJson(spec: SpecJson): Compiled {
  const issues: Issue[] = []
  let parsed: ReturnType<typeof parsePlanSpec>
  try {
    parsed = parsePlanSpec(spec)
  } catch (e) {
    return { doc: null, issues: [{ level: 'error', code: 'SCHEMA', msg: errMsg(e) }] }
  }
  try {
    for (const i of validatePlanSpec(parsed) as unknown[]) issues.push(normIssue(i))
  } catch (e) {
    issues.push({ level: 'error', code: 'VALIDATOR_CRASH', msg: errMsg(e) })
  }
  let doc: Doc | null = null
  try {
    doc = compilePlanSpec(parsed)
  } catch (e) {
    issues.push({ level: 'error', code: 'COMPILE', msg: errMsg(e) })
  }
  return { doc, issues }
}

/** compile or throw a readable error (used by render / build) */
export function compileOrThrow(spec: SpecJson): { doc: Doc; issues: Issue[] } {
  const c = compileSpecJson(spec)
  if (!c.doc) {
    const first = c.issues.find((i) => i.level === 'error')
    throw new DpError(`cannot compile PlanSpec: ${first ? `${first.code}: ${first.msg}` : 'unknown error'}`, 1, 'run: pnpm dp spec validate <spec.json>')
  }
  return { doc: c.doc, issues: c.issues }
}

// ───────────────────────── area metrics ─────────────────────────

export interface RoomMetric {
  id: string
  name: string
  type: string
  /** m², inner faces, null if the room was not found in the compiled plan */
  computed: number | null
  labelled?: number
  delta?: number
  pct?: number
  status: 'ok' | 'warn' | 'error' | 'missing' | 'n/a'
}

export interface AreaMetrics {
  rooms: RoomMetric[]
  /** Σ heated rooms (no balconies/loggias), m² */
  roomsArea: number
  /** общая площадь with summer coefficients (balcony ×0.3, loggia ×0.5, terrace ×0.3), m² */
  totalArea: number
  /** Σ without coefficients, m² */
  grossArea: number
  livingArea: number
  labelledTotalArea?: number
  labelledLivingArea?: number
  unmatchedFaces: { roomId: string; name?: string; area: number }[]
}

export function areaTol(labelled: number): { warn: number; error: number } {
  return { warn: Math.max(0.15, labelled * 0.02), error: Math.max(0.4, labelled * 0.05) }
}

export function areaMetrics(spec: SpecJson, doc: Doc, plan: DerivedPlan, scale: Scale | null): { metrics: AreaMetrics; issues: Issue[]; faceToSpec: Map<string, string> } {
  const issues: Issue[] = []
  const rooms: RoomMetric[] = []
  const usedFaces = new Map<string, string>()
  let roomsArea = 0
  let totalArea = 0
  let grossArea = 0
  let livingArea = 0
  for (const r of spec.rooms) {
    const ref = roomRefPoint(r)
    let mm: [number, number] | null = null
    if (ref) {
      const f = metricFactor(spec.units)
      if (f === null) mm = scale ? pxToMm(scale, ref) : null
      else mm = [ref[0] * f, ref[1] * f]
    }
    const face = mm
      ? plan.rooms.find(
          (f) => pointInPoly(mm[0], mm[1], f.polygon) && !f.holes.some((h) => pointInPoly(mm[0], mm[1], h)),
        )
      : undefined
    const rName = r.name ?? r.id
    const rType = r.type ?? 'other'
    const m: RoomMetric = { id: r.id, name: rName, type: rType, computed: face ? r2(face.area) : null, status: 'n/a' }
    if (typeof r.labelledArea === 'number') m.labelled = r.labelledArea
    if (!face) {
      m.status = 'missing'
      issues.push({
        level: 'warn',
        code: 'ROOM_NOT_FOUND',
        msg: `room "${rName}" (${r.id}): its ${r.at ? 'label point' : 'interior'} is not inside any closed room of the compiled plan (open walls, or the point lies in a wall)`,
        ids: [r.id],
      })
    } else {
      const prev = usedFaces.get(face.roomId)
      if (prev) {
        issues.push({
          level: 'warn',
          code: 'ROOMS_SHARE_FACE',
          msg: `rooms "${prev}" and "${r.id}" fall into the same closed area — a wall or separator between them is missing`,
          ids: [prev, r.id],
        })
      } else {
        usedFaces.set(face.roomId, r.id)
        const coef = r.balcony === true ? 0.3 : SUMMER_COEF[rType]
        grossArea += face.area
        if (coef !== undefined) totalArea += face.area * coef
        else {
          totalArea += face.area
          roomsArea += face.area
        }
        if (LIVING_TYPES.has(rType)) livingArea += face.area
      }
      if (m.labelled !== undefined) {
        const d = face.area - m.labelled
        m.delta = r2(d)
        m.pct = m.labelled > 0 ? Math.round((d / m.labelled) * 1000) / 10 : undefined
        const tol = areaTol(m.labelled)
        m.status = Math.abs(d) > tol.error ? 'error' : Math.abs(d) > tol.warn ? 'warn' : 'ok'
      } else m.status = 'ok'
    }
    rooms.push(m)
  }
  const unmatchedFaces = plan.rooms
    .filter((f) => !usedFaces.has(f.roomId))
    .map((f) => ({ roomId: f.roomId, name: doc.rooms[f.roomId]?.name, area: r2(f.area) }))
  const src = spec.source ?? {}
  const metrics: AreaMetrics = {
    rooms,
    roomsArea: r2(roomsArea),
    totalArea: r2(totalArea),
    grossArea: r2(grossArea),
    livingArea: r2(livingArea),
    labelledTotalArea: typeof src.labelledTotalArea === 'number' ? src.labelledTotalArea : undefined,
    labelledLivingArea: typeof src.labelledLivingArea === 'number' ? src.labelledLivingArea : undefined,
    unmatchedFaces,
  }
  for (const m of rooms) {
    if (m.status === 'warn' || m.status === 'error') {
      issues.push({
        level: m.status,
        code: 'AREA_MISMATCH',
        msg: `${m.name} (${m.id}): computed ${m.computed?.toFixed(2)} m² vs labelled ${m.labelled?.toFixed(2)} m² (${m.delta && m.delta > 0 ? '+' : ''}${m.delta?.toFixed(2)} m², ${m.pct}%)`,
        ids: [m.id],
      })
    }
  }
  const totalCheck = (code: string, label: string, computed: number, labelled?: number, alt?: number) => {
    if (labelled === undefined) return
    const tol = areaTol(labelled)
    const d = computed - labelled
    // some plans state "общая" without summer rooms, some with — accept whichever matches better
    const dAlt = alt !== undefined ? alt - labelled : Number.POSITIVE_INFINITY
    const best = Math.abs(dAlt) < Math.abs(d) ? dAlt : d
    if (Math.abs(best) > tol.warn) {
      issues.push({
        level: Math.abs(best) > tol.error ? 'error' : 'warn',
        code,
        msg: `${label}: computed ${(labelled + best).toFixed(2)} m² vs labelled ${labelled.toFixed(2)} m² (${best > 0 ? '+' : ''}${best.toFixed(2)})`,
      })
    }
  }
  totalCheck('TOTAL_AREA_MISMATCH', 'total area (balcony ×0.3, loggia ×0.5)', metrics.totalArea, metrics.labelledTotalArea, metrics.roomsArea)
  totalCheck('LIVING_AREA_MISMATCH', 'living area', metrics.livingArea, metrics.labelledLivingArea)
  if (unmatchedFaces.length) {
    issues.push({
      level: 'warn',
      code: 'UNLABELLED_FACE',
      msg: `${unmatchedFaces.length} closed area(s) of the compiled plan have no room in the spec: ${unmatchedFaces.map((f) => `${f.area} m²`).join(', ')}`,
    })
  }
  return { metrics, issues, faceToSpec: usedFaces }
}

/** core codes that already cover one of the CLI's own checks */
const EQUIVALENT: Record<string, string[]> = {
  ROOM_NOT_FOUND: ['ROOM_OPEN', 'ROOM_NO_GEOMETRY'],
  ROOMS_SHARE_FACE: ['ROOM_MERGED'],
  UNLABELLED_FACE: ['FACE_UNLABELLED'],
  LIVING_AREA_MISMATCH: ['TOTAL_AREA_MISMATCH'],
}

/** merge my issues into core's without duplicating codes core already reported for the same ids */
export function mergeIssues(core: Issue[], mine: Issue[]): Issue[] {
  const out = [...core]
  for (const i of mine) {
    const codes = [i.code, ...(EQUIVALENT[i.code] ?? [])]
    const dup = core.some(
      (c) =>
        codes.includes(c.code) &&
        (i.code === 'LIVING_AREA_MISMATCH' ? /жил|living/i.test(c.msg) : true) &&
        (!i.ids || !c.ids || i.ids.some((id) => c.ids?.includes(id) || c.msg.includes(id))),
    )
    if (!dup) out.push(i)
  }
  const rank: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.level] - rank[b.level])
}

// ───────────────────────── rendering ─────────────────────────

type DisplayList = ReturnType<typeof buildDisplayList>

export interface BoundsMm {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** reads the display list bounds whatever their exact shape; falls back to the derived plan bounds */
export function displayBounds(dl: DisplayList, plan: DerivedPlan): BoundsMm {
  const b = (dl as unknown as { bounds?: unknown }).bounds as Record<string, number> | number[] | undefined
  const ok = (v: BoundsMm) => [v.minX, v.minY, v.maxX, v.maxY].every(Number.isFinite) && v.maxX > v.minX && v.maxY > v.minY
  if (Array.isArray(b) && b.length === 4) {
    const v = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] }
    if (ok(v)) return v
  } else if (b && typeof b === 'object') {
    if ('minX' in b) {
      const v = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }
      if (ok(v)) return v
    }
    if ('x' in b && 'y' in b) {
      const w = b.w ?? b.width
      const h = b.h ?? b.height
      const v = { minX: b.x, minY: b.y, maxX: b.x + w, maxY: b.y + h }
      if (ok(v)) return v
    }
  }
  const pb = plan.bounds
  if (ok(pb)) return { ...pb }
  return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
}

export interface RenderOptions {
  /** px per mm (default 0.1 = 100 px per metre) */
  pxPerMm?: number
  marginPx?: number
  /** render in a fixed frame (e.g. the source image frame): screen = mm·pxPerMm + offset */
  frame?: { width: number; height: number; pxPerMm: number; offsetX: number; offsetY: number }
  maxSide?: number
  dimensions?: boolean
  furniture?: boolean
  theme?: 'light' | 'blueprint'
}

export interface Rendered {
  png: Buffer
  width: number
  height: number
  pxPerMm: number
  offsetX: number
  offsetY: number
  boundsMm: BoundsMm
}

/** core display list → @napi-rs/canvas (the same drawing code as the app's exports) */
export function renderDoc(doc: Doc, levelId: string, o: RenderOptions = {}): Rendered {
  const plan = derivePlan(doc, levelId)
  const dl = buildDisplayList(doc, levelId, {
    dimensions: o.dimensions ?? true,
    areas: true,
    labels: true,
    furniture: o.furniture ?? true,
    grid: false,
    titleBlock: false,
    theme: o.theme ?? 'light',
  })
  const bounds = displayBounds(dl, plan)
  let width: number
  let height: number
  let pxPerMm: number
  let offsetX: number
  let offsetY: number
  if (o.frame) {
    ;({ width, height, pxPerMm, offsetX, offsetY } = o.frame)
  } else {
    const margin = o.marginPx ?? 40
    pxPerMm = o.pxPerMm ?? 0.1
    const maxSide = o.maxSide ?? 8000
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    if (span * pxPerMm + 2 * margin > maxSide) pxPerMm = (maxSide - 2 * margin) / span
    width = Math.ceil((bounds.maxX - bounds.minX) * pxPerMm + 2 * margin)
    height = Math.ceil((bounds.maxY - bounds.minY) * pxPerMm + 2 * margin)
    offsetX = margin - bounds.minX * pxPerMm
    offsetY = margin - bounds.minY * pxPerMm
  }
  const canvas = createCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
  const ctx = canvas.getContext('2d')
  const background = o.theme === 'blueprint' ? '#0f2a4a' : '#ffffff'
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  drawToCanvas(ctx as unknown as Parameters<typeof drawToCanvas>[0], dl, { pxPerMm, offsetX, offsetY, background })
  return { png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height, pxPerMm, offsetX, offsetY, boundsMm: bounds }
}

// ───────────────────────── overlay drawing ─────────────────────────

const DOOR_KINDS = new Set(['door', 'doubleDoor', 'slidingDoor', 'entranceDoor', 'arch', 'opening', 'balconyDoor'])

export type ToPx = (x: number, y: number) => [number, number]

/** wall polygons of the compiled plan in source px (for overlay drawing and masks) */
export function wallPolygonsPx(doc: Doc, plan: DerivedPlan, toPx: ToPx): { poly: [number, number][]; virtual: boolean; a: [number, number]; b: [number, number] }[] {
  return Object.values(plan.wallGeoms).map((g) => ({
    poly: g.polygon.map((p) => toPx(p.x, p.y)),
    virtual: doc.walls[g.wallId]?.kind === 'virtual',
    a: toPx(g.a.x, g.a.y),
    b: toPx(g.b.x, g.b.y),
  }))
}

export function drawPlanOverlay(
  ctx: SKRSContext2D,
  doc: Doc,
  plan: DerivedPlan,
  toPx: ToPx,
  roomLabels: Map<string, string[]>,
  alpha = 0.45,
): void {
  // walls
  for (const w of wallPolygonsPx(doc, plan, toPx)) {
    if (w.virtual || w.poly.length < 3) {
      ctx.save()
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = '#ff005a'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(w.a[0], w.a[1])
      ctx.lineTo(w.b[0], w.b[1])
      ctx.stroke()
      ctx.restore()
      continue
    }
    ctx.beginPath()
    ctx.moveTo(w.poly[0][0], w.poly[0][1])
    for (const p of w.poly.slice(1)) ctx.lineTo(p[0], p[1])
    ctx.closePath()
    ctx.fillStyle = `rgba(255, 0, 90, ${alpha})`
    ctx.fill()
    ctx.strokeStyle = '#ff005a'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  // openings
  for (const o of Object.values(doc.openings)) {
    const g = plan.wallGeoms[o.wallId]
    const wall = doc.walls[o.wallId]
    if (!g || !wall) continue
    const L = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y)
    if (L <= 0) continue
    const ux = (g.b.x - g.a.x) / L
    const uy = (g.b.y - g.a.y) / L
    const c0 = o.offset - o.width / 2
    const c1 = o.offset + o.width / 2
    const p0 = toPx(g.a.x + ux * c0, g.a.y + uy * c0)
    const p1 = toPx(g.a.x + ux * c1, g.a.y + uy * c1)
    const nx = -uy * (wall.thickness / 2 + 60)
    const ny = ux * (wall.thickness / 2 + 60)
    const color = DOOR_KINDS.has(o.kind) ? '#00a2ff' : '#00c853'
    const q0 = toPx(g.a.x + ux * c0 + nx, g.a.y + uy * c0 + ny)
    const q0b = toPx(g.a.x + ux * c0 - nx, g.a.y + uy * c0 - ny)
    const q1 = toPx(g.a.x + ux * c1 + nx, g.a.y + uy * c1 + ny)
    const q1b = toPx(g.a.x + ux * c1 - nx, g.a.y + uy * c1 - ny)
    const z0 = toPx(0, 0)
    const z1 = toPx(1000, 0)
    const tPx = Math.max(3, (wall.thickness * Math.hypot(z1[0] - z0[0], z1[1] - z0[1])) / 1000 * 0.8)
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = Math.min(1, alpha + 0.3)
    ctx.lineWidth = tPx
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(p0[0], p0[1])
    ctx.lineTo(p1[0], p1[1])
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(q0[0], q0[1])
    ctx.lineTo(q0b[0], q0b[1])
    ctx.moveTo(q1[0], q1[1])
    ctx.lineTo(q1b[0], q1b[1])
    ctx.stroke()
    ctx.restore()
  }
  // room labels
  ctx.font = `bold 13px ${LABEL_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const f of plan.rooms) {
    const [x, y] = toPx(f.labelPoint.x, f.labelPoint.y)
    const lines = roomLabels.get(f.roomId) ?? [doc.rooms[f.roomId]?.name ?? '?', `${f.area.toFixed(2)} m²`]
    lines.forEach((t, i) => haloText(ctx, t, x, y + (i - (lines.length - 1) / 2) * 15, '#0030d0'))
  }
}


/** rasterised wall mask of the compiled plan in source px */
export function planWallMask(doc: Doc, plan: DerivedPlan, toPx: ToPx, width: number, height: number): Uint8Array {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000000'
  for (const w of wallPolygonsPx(doc, plan, toPx)) {
    if (w.virtual || w.poly.length < 3) continue
    ctx.beginPath()
    ctx.moveTo(w.poly[0][0], w.poly[0][1])
    for (const p of w.poly.slice(1)) ctx.lineTo(p[0], p[1])
    ctx.closePath()
    ctx.fill()
  }
  const img = ctx.getImageData(0, 0, width, height)
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4 + 3] > 127 ? 1 : 0
  return out
}

// ───────────────────────── .doplan container ─────────────────────────

export interface DoplanManifest {
  app: 'doplan'
  format: 1
  name: string
  createdAt: string
  [k: string]: unknown
}

export interface PackedAsset {
  /** file name inside assets/, e.g. "<sha256>.png" */
  name: string
  data: Uint8Array
}

/** .doplan = ZIP { manifest.json, doc.json, assets/<sha256>.<ext> } — same container as the app */
export function writeDoplan(file: string, doc: Doc, name: string, assets: PackedAsset[] = []): { bytes: number } {
  const manifest: DoplanManifest = { app: 'doplan', format: 1, name, createdAt: new Date().toISOString() }
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'doc.json': strToU8(serializeDoc(doc)),
  }
  for (const a of assets) entries[`assets/${a.name}`] = a.data
  const zip = zipSync(entries, { level: 6 })
  ensureDirFor(file)
  writeFileSync(file, zip)
  return { bytes: zip.byteLength }
}

export function readDoplan(file: string): { manifest: Record<string, unknown>; doc: Doc; entries: string[] } {
  if (!existsSync(file)) throw new DpError(`file not found: ${file}`)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(readFileSync(file)))
  } catch (e) {
    throw new DpError(`${file} is not a .doplan (zip) file: ${errMsg(e)}`)
  }
  const docEntry = files['doc.json']
  if (!docEntry) throw new DpError(`${file}: doc.json is missing in the archive`)
  let manifest: Record<string, unknown> = {}
  if (files['manifest.json']) {
    try {
      manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
    } catch {
      manifest = {}
    }
  }
  let doc: Doc
  try {
    doc = parseDoc(JSON.parse(strFromU8(docEntry)))
  } catch (e) {
    throw new DpError(`${file}: invalid doc.json: ${errMsg(e)}`)
  }
  return { manifest, doc, entries: Object.keys(files) }
}

// ───────────────────────── underlay ─────────────────────────

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function resolveImage(p: string, specFile: string): string | null {
  if (/^(data:|doplan-asset:|https?:)/.test(p)) return null
  const cands = isAbsolute(p) ? [p] : [resolve(dirname(specFile), p), resolve(p)]
  return cands.find((c) => existsSync(c)) ?? null
}

function newUnderlayId(): string {
  const abc = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-'
  const b = randomBytes(10)
  let s = ''
  for (const v of b) s += abc[v & 63]
  return `u_${s}`
}

/**
 * Embeds the source image as the plan underlay (assets/<sha256>.<ext>, src doplan-asset://project/…).
 * Fixes up underlays created by core whose src is a local path; adds one if core did not.
 */
export async function embedUnderlay(
  doc: Doc,
  spec: SpecJson,
  specFile: string,
  add: boolean,
): Promise<{ assets: PackedAsset[]; notes: string[] }> {
  const assets: PackedAsset[] = []
  const notes: string[] = []
  const pack = (path: string): string => {
    const data = new Uint8Array(readFileSync(path))
    const sha = createHash('sha256').update(data).digest('hex')
    const ext = extname(path).toLowerCase().replace('.jpeg', '.jpg')
    const name = `${sha}${ext}`
    if (!assets.some((a) => a.name === name)) assets.push({ name, data })
    return `doplan-asset://project/${name}`
  }
  for (const u of Object.values(doc.underlays)) {
    if (/^(data:|doplan-asset:)/.test(u.src)) continue
    const path = resolveImage(u.src, specFile)
    if (path && IMG_EXT.has(extname(path).toLowerCase())) {
      u.src = pack(path)
      notes.push(`underlay embedded from ${path}`)
    } else {
      delete doc.underlays[u.id]
      notes.push(`underlay dropped: image "${u.src}" not found`)
    }
  }
  if (!add || Object.keys(doc.underlays).length > 0) return { assets, notes }
  const img = spec.source?.image
  if (!img) return { assets, notes }
  const path = resolveImage(img, specFile)
  if (!path || !IMG_EXT.has(extname(path).toLowerCase())) {
    notes.push(`no underlay: source image "${img}" not found`)
    return { assets, notes }
  }
  const scale = resolveScale(spec)
  if (!scale) {
    notes.push('no underlay: spec has no scale (source.mmPerPx / calibration)')
    return { assets, notes }
  }
  const meta = await sharp(path).metadata()
  const levelId = firstLevel(doc)
  const u: Underlay = {
    id: newUnderlayId(),
    levelId,
    src: pack(path),
    x: -scale.ox * scale.sx,
    y: -scale.oy * scale.sy,
    scale: scale.sx,
    rotation: 0,
    opacity: 0.4,
    visible: true,
    locked: true,
    widthPx: meta.width ?? 0,
    heightPx: meta.height ?? 0,
  }
  doc.underlays[u.id] = u
  notes.push(`underlay added from ${path} (${r2(scale.sx)} mm/px)`)
  if (Math.abs(scale.sx - scale.sy) / scale.sx > 0.01) notes.push('underlay uses mm/px of X; the image is anisotropic')
  return { assets, notes }
}
