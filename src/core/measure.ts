/**
 * «Обмер»: replace a guessed clear dimension with a tape measurement.
 *
 * The user picks a run (a clear inner face of a room, see core/provenance) and types its measured
 * length. The near end stays; the far end node moves along the run direction, and everything that
 * hangs on it through the node graph follows rigidly: walls NOT parallel to the run translate with the
 * node (the partition / exterior wall at the far end moves as a whole), walls parallel to the run
 * stretch and stop the propagation. Because the far wall line translates along the run, the clear
 * length changes by exactly the requested delta whatever the angle of that wall; a few correction
 * passes absorb mitre effects at odd angles. The faces of the run are then marked `measured`.
 *
 * Pure TS: mutates the passed Doc (an Immer draft inside docStore.transact) like core/ops.
 */
import { derivePlan } from './derive'
import { moveNodes } from './ops'
import { type EdgeRun, findRun, makeProvenance, roomEdgeRuns, runProvenance, sideKey } from './provenance'
import type { DerivedPlan, Doc, Id, Vec2 } from './types'
import { ROOM_TYPE_NAMES } from './defaults'

/** walls within this angle (cos) of the run direction stretch instead of moving */
const PARALLEL_COS = Math.cos((10 * Math.PI) / 180)

export type RunEnd = 'a' | 'b'

export interface MeasureConflict {
  key: string
  roomName: string
  before: number
  after: number
}

export interface MeasureResult {
  ok: boolean
  /** readable Russian reason when !ok */
  error?: string
  /** measured − previous length, mm */
  delta: number
  /** length before / after, mm */
  before: number
  after: number
  /** nodes that moved */
  moved: Id[]
  /** dimensions that were already measured and changed because of this one */
  conflicts: MeasureConflict[]
}

export interface MeasureOptions {
  /** ± mm of the measurement (default 2) */
  tol?: number
  /** ISO date (default today) */
  date?: string
  note?: string
}

/** the wall node at the given end of a run (the centreline node nearest to that face end) */
export function runEndNode(doc: Pick<Doc, 'walls' | 'nodes'>, run: EdgeRun, end: RunEnd): Id | null {
  const e = end === 'a' ? run.edges[0] : run.edges[run.edges.length - 1]
  const p = end === 'a' ? e.from : e.to
  const w = doc.walls[e.wallId]
  if (!w) return null
  const na = doc.nodes[w.a]
  const nb = doc.nodes[w.b]
  if (!na || !nb) return null
  return Math.hypot(na.x - p.x, na.y - p.y) <= Math.hypot(nb.x - p.x, nb.y - p.y) ? w.a : w.b
}

/**
 * Nodes that move together with the far end node: flood over walls that are not parallel to `u`.
 * Returns null when the flood reaches a node that must stay (the near end of the run).
 */
export function collectMovingNodes(doc: Pick<Doc, 'walls' | 'nodes'>, levelId: Id, start: Id, u: Vec2, fixed: ReadonlySet<Id>): Set<Id> | null {
  const adj = new Map<Id, Id[]>()
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.levelId !== levelId) continue
    const pa = doc.nodes[w.a]
    const pb = doc.nodes[w.b]
    if (!pa || !pb) continue
    const l = Math.hypot(pb.x - pa.x, pb.y - pa.y)
    if (l < 1e-6) continue
    if (Math.abs(((pb.x - pa.x) * u.x + (pb.y - pa.y) * u.y) / l) >= PARALLEL_COS) continue
    let la = adj.get(w.a)
    if (!la) adj.set(w.a, (la = []))
    la.push(w.b)
    let lb = adj.get(w.b)
    if (!lb) adj.set(w.b, (lb = []))
    lb.push(w.a)
  }
  const out = new Set<Id>([start])
  const queue = [start]
  while (queue.length) {
    const x = queue.pop()!
    for (const y of adj.get(x) ?? []) {
      if (out.has(y)) continue
      if (fixed.has(y)) return null
      out.add(y)
      queue.push(y)
    }
  }
  return out
}

function measuredRuns(doc: Doc, plan: DerivedPlan, skip: ReadonlySet<string>): Map<string, { run: EdgeRun; roomName: string }> {
  const out = new Map<string, { run: EdgeRun; roomName: string }>()
  for (const room of plan.rooms) {
    const rec = doc.rooms[room.roomId]
    const roomName = rec?.name || ROOM_TYPE_NAMES[rec?.type ?? 'other'].ru
    for (const run of roomEdgeRuns(room)) {
      if (run.edges.some((e) => skip.has(sideKey(e.wallId, e.side)))) continue
      if (runProvenance(doc, run).source === 'measured') out.set(run.key, { run, roomName })
    }
  }
  return out
}

/**
 * Sets the clear length of the run containing face `key` (`wallId:side`) to `measuredMm` by moving its
 * `movingEnd`, then marks the run `measured`. Mutates `doc`; on failure nothing is changed.
 */
export function applyMeasuredLength(doc: Doc, levelId: Id, key: string, measuredMm: number, movingEnd: RunEnd, opts: MeasureOptions = {}): MeasureResult {
  const fail = (error: string, before = 0): MeasureResult => ({ ok: false, error, delta: 0, before, after: before, moved: [], conflicts: [] })
  if (!Number.isFinite(measuredMm) || measuredMm < 10) return fail('Введите длину в миллиметрах (не меньше 10 мм)')
  let plan = derivePlan(doc, levelId)
  const run = findRun(plan, key)
  if (!run) return fail('Размер не найден: стена больше не ограничивает помещение')
  const before = run.length
  const runFaces = new Set(run.edges.map((e) => sideKey(e.wallId, e.side)))
  const nearEnd: RunEnd = movingEnd === 'a' ? 'b' : 'a'
  const far = runEndNode(doc, run, movingEnd)
  const near = runEndNode(doc, run, nearEnd)
  if (!far || !near || far === near) return fail('Не удалось определить концы размера', before)
  // direction in which the far end moves to make the run longer
  const dir: Vec2 = movingEnd === 'b' ? run.u : { x: -run.u.x, y: -run.u.y }

  // nodes of the run's walls other than the far one stay (the run line itself must not move)
  const fixed = new Set<Id>([near])
  for (const e of run.edges) {
    const w = doc.walls[e.wallId]
    if (!w) continue
    if (w.a !== far) fixed.add(w.a)
    if (w.b !== far) fixed.add(w.b)
  }
  const moving = collectMovingNodes(doc, levelId, far, dir, fixed)
  if (!moving)
    return fail(
      'Этот конец связан с противоположным через наклонные стены: сдвинуть его, не исказив помещение, нельзя. Попробуйте двигать другой конец',
      before,
    )

  const prevMeasured = measuredRuns(doc, plan, runFaces)
  // stretching walls must not collapse or flip
  const stretch: { a: Id; b: Id; ax: number; ay: number }[] = []
  for (const id in doc.walls) {
    const w = doc.walls[id]
    if (w.levelId !== levelId) continue
    const ma = moving.has(w.a)
    const mb = moving.has(w.b)
    if (ma === mb) continue
    const pa = doc.nodes[w.a]
    const pb = doc.nodes[w.b]
    if (pa && pb) stretch.push({ a: w.a, b: w.b, ax: pb.x - pa.x, ay: pb.y - pa.y })
  }

  const snapshot = new Map<Id, Vec2>()
  for (const id of moving) {
    const n = doc.nodes[id]
    if (n) snapshot.set(id, { x: n.x, y: n.y })
  }
  let total = 0
  let current = before
  let after = before
  for (let pass = 0; pass < 4; pass++) {
    const step = measuredMm - current
    if (Math.abs(step) < 0.01) break
    total += step
    const moves = new Map<Id, Vec2>()
    for (const [id, p] of snapshot) moves.set(id, { x: p.x + dir.x * total, y: p.y + dir.y * total })
    moveNodes(doc, moves)
    plan = derivePlan(doc, levelId)
    const now = findRun(plan, key)
    if (!now) {
      moveNodes(doc, snapshot)
      return fail('После сдвига стена перестала ограничивать помещение: проверьте выбранный конец', before)
    }
    current = now.length
    after = current
  }
  for (const s of stretch) {
    const pa = doc.nodes[s.a]
    const pb = doc.nodes[s.b]
    if (!pa || !pb) continue
    const nx = pb.x - pa.x
    const ny = pb.y - pa.y
    if (Math.hypot(nx, ny) < 1 || nx * s.ax + ny * s.ay <= 0) {
      moveNodes(doc, snapshot)
      return fail(`Сдвиг на ${Math.round(total)} мм схлопнул бы соседнюю стену: проверьте введённое значение или двигайте другой конец`, before)
    }
  }
  if (Math.abs(after - measuredMm) > 0.5) {
    moveNodes(doc, snapshot)
    return fail('Не удалось точно выставить длину: стены на этом конце расположены под слишком острым углом', before)
  }

  // mark every face of the run as measured, recording its current length
  const final = findRun(plan, key)!
  for (const e of final.edges) {
    const w = doc.walls[e.wallId]
    if (!w) continue
    const len = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y)
    const dims = w.dims ?? (w.dims = {})
    dims[e.side] = makeProvenance('measured', len, { tol: opts.tol ?? 2, date: opts.date, note: opts.note })
  }

  // which earlier measurements did this one change?
  const conflicts: MeasureConflict[] = []
  if (prevMeasured.size) {
    const nowRuns = new Map<string, EdgeRun>()
    for (const room of plan.rooms) for (const r of roomEdgeRuns(room)) nowRuns.set(r.key, r)
    for (const [k, { run: old, roomName }] of prevMeasured) {
      const cur = nowRuns.get(k)
      if (!cur || Math.abs(cur.length - old.length) > 0.5) conflicts.push({ key: k, roomName, before: old.length, after: cur?.length ?? 0 })
    }
  }
  return { ok: true, delta: total, before, after, moved: [...moving], conflicts }
}

/** marks a run with a provenance without changing the geometry (e.g. "this one is right as drawn") */
export function setRunSource(doc: Doc, levelId: Id, key: string, source: 'measured' | 'plan' | 'derived' | 'estimated' | 'drawn', opts: MeasureOptions = {}): boolean {
  const plan = derivePlan(doc, levelId)
  const run = findRun(plan, key)
  if (!run) return false
  for (const e of run.edges) {
    const w = doc.walls[e.wallId]
    if (!w) continue
    if (source === 'drawn') {
      if (w.dims) {
        delete w.dims[e.side]
        if (!w.dims.left && !w.dims.right) delete w.dims
      }
      continue
    }
    const len = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y)
    const dims = w.dims ?? (w.dims = {})
    dims[e.side] = makeProvenance(source, len, { tol: opts.tol, date: opts.date, note: opts.note })
  }
  return true
}
