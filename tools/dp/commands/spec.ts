/** `dp spec …` — PlanSpec scale, normalise, validate, render, overlay, check and build. */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { openInApp } from '../lib/app'
import type { Args } from '../lib/args'
import { derivePlan } from '../lib/core'
import { autoMinThick, binarize, compareMasks, type MaskDiff, open, otsu } from '../lib/cv'
import { haloText, LABEL_FONT, loadPng, savePng } from '../lib/draw'
import { ensureDirFor, loadGray } from '../lib/image'
import { normalizeSpec } from '../lib/normalize'
import { type CommandResult, DpError, r2, r4 } from '../lib/output'
import {
  type AreaMetrics,
  areaMetrics,
  compileOrThrow,
  compileSpecJson,
  drawPlanOverlay,
  embedUnderlay,
  firstLevel,
  type Issue,
  mergeIssues,
  planWallMask,
  renderDoc,
  type ToPx,
  writeDoplan,
} from '../lib/plan'
import { areaScale, calibrationScale, readSpec, resolveScale, type SpecJson } from '../lib/spec'

// ───────────────────────── spec scale ─────────────────────────

export async function specScale(a: Args): Promise<CommandResult> {
  const fromAreas = a.str('from-areas')
  if (fromAreas) {
    const spec = readSpec(resolve(fromAreas))
    const fit = areaScale(spec)
    if (!fit) throw new DpError('no room has both labelledArea and rect/polygon to fit a scale from')
    const res = {
      ok: true,
      method: 'areas',
      mmPerPx: r4(fit.s),
      pxPerMm: r4(1 / fit.s),
      pxPerM: r2(1000 / fit.s),
      residualsPct: fit.residualsPct,
    }
    const cal = spec.source?.calibration ? calibrationScale(spec.source.calibration) : null
    const notes: string[] = []
    if (cal) {
      const d = (Math.abs(cal.sx - fit.s) / cal.sx) * 100
      notes.push(`dimension calibration gives ${r4(cal.sx)} mm/px (${r2(d)}% apart)${d > 3 ? ' — SCALE_INCONSISTENT: plan probably not to scale, trust printed numbers' : ''}`)
    }
    return {
      data: { ...res, notes },
      text: [
        `mmPerPx ${res.mmPerPx} (fit over ${fit.residualsPct.length} labelled rooms)`,
        `residuals: ${fit.residualsPct.map((r) => `${r.id} ${r.pct > 0 ? '+' : ''}${r.pct}%`).join(', ')}`,
        'outliers (> ±5 %) usually mean a misread rectangle or a wrong labelledArea',
        ...notes,
      ],
    }
  }
  const mm = a.num('mm')
  if (mm === undefined || mm <= 0) throw new DpError('missing --mm <real length in mm>', 1, 'e.g. pnpm dp spec scale --px 550 --mm 3300')
  let px = a.num('px')
  const ref = a.nums('ref', 4)
  if (ref) px = Math.hypot(ref[2] - ref[0], ref[3] - ref[1])
  if (px === undefined || px <= 0) throw new DpError('give --px <length in px> or --ref x1,y1,x2,y2')
  const mmPerPx = mm / px
  const data: Record<string, unknown> = {
    ok: true,
    method: 'dimension',
    px: r2(px),
    mm,
    mmPerPx: r4(mmPerPx),
    pxPerMm: r4(1 / mmPerPx),
    pxPerM: r2(1000 / mmPerPx),
  }
  const specPath = a.str('spec')
  const text = [`mmPerPx ${r4(mmPerPx)}  (1 m = ${r2(1000 / mmPerPx)} px)`]
  if (specPath) {
    const file = resolve(specPath)
    const spec = readSpec(file)
    spec.source = { ...(spec.source ?? {}) }
    if (ref) {
      const cal = [...(spec.source.calibration ?? []), { p1: [ref[0], ref[1]], p2: [ref[2], ref[3]], mm, label: a.str('label') }]
      spec.source.calibration = cal
      const c = calibrationScale(cal)
      if (c) {
        spec.source.mmPerPx = r4(c.sx)
        if (c.sy !== c.sx) spec.source.mmPerPxY = r4(c.sy)
        data.calibration = c
        text.push(`calibration refs: ${cal.length}, residuals ${c.residualsPct.join('%, ')}%, anisotropy ${c.anisotropyPct}%`)
      }
    } else spec.source.mmPerPx = r4(mmPerPx)
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`)
    data.spec = file
    text.push(`written to ${file} (source.mmPerPx = ${spec.source.mmPerPx})`)
  }
  return { data, text }
}

// ───────────────────────── spec normalize ─────────────────────────

export async function specNormalize(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<spec.json>'))
  const out = resolve(a.req('out'))
  const spec = readSpec(file)
  const { spec: norm, report } = normalizeSpec(spec, {
    mmPerPx: a.num('mm-per-px'),
    gridMm: a.num('grid'),
    orthoTolDeg: a.num('ortho-tol'),
    mergeMm: a.num('merge'),
  })
  ensureDirFor(out)
  writeFileSync(out, `${JSON.stringify(norm, null, 2)}\n`)
  const sc = report.scale
  return {
    data: { ok: true, out, ...report },
    text: [
      `normalized → ${out} (units mm${report.fromUnits !== 'mm' ? `, from ${report.fromUnits}` : ''})`,
      ...(sc
        ? [`scale: ${r4(sc.sx)}${sc.sy !== sc.sx ? ` x / ${r4(sc.sy)} y` : ''} mm/px from ${sc.from}, origin px [${sc.ox}, ${sc.oy}]${sc.residualsPct ? `, residuals ${sc.residualsPct.join('%, ')}%` : ''}`]
        : []),
      `ortho-snapped edges ${report.orthoSnapped}, merged coords ${report.merged} (max shift ${report.maxShiftMm} mm), grid ${report.gridMm} mm, thickness snaps ${report.thicknessSnapped}` +
        (report.nonOrthoEdges ? `, non-orthogonal edges kept ${report.nonOrthoEdges}` : ''),
      `next: pnpm dp spec validate ${out}`,
    ],
  }
}

// ───────────────────────── spec validate ─────────────────────────

interface ValidateOut {
  ok: boolean
  errors: number
  warnings: number
  issues: Issue[]
  metrics?: AreaMetrics
  counts?: { walls: number; openings: number; rooms: number; faces: number }
}

function runValidate(spec: SpecJson): ValidateOut {
  const scale = resolveScale(spec)
  const compiled = compileSpecJson(spec)
  const extra: Issue[] = []
  if (spec.units === 'px') {
    extra.push({
      level: 'info',
      code: 'PX_UNITS',
      msg: scale ? 'spec is in px — run `pnpm dp spec normalize` and continue in mm' : 'spec is in px without a scale — area checks skipped; calibrate first',
    })
  }
  let metrics: AreaMetrics | undefined
  let counts: ValidateOut['counts']
  if (compiled.doc) {
    const doc = compiled.doc
    const lvl = firstLevel(doc)
    try {
      const plan = derivePlan(doc, lvl)
      const am = areaMetrics(spec, doc, plan, scale)
      metrics = am.metrics
      extra.push(...am.issues)
      counts = {
        walls: Object.values(doc.walls).filter((w) => w.levelId === lvl).length,
        openings: Object.keys(doc.openings).length,
        rooms: Object.values(doc.rooms).filter((r) => r.levelId === lvl).length,
        faces: plan.rooms.length,
      }
    } catch (e) {
      extra.push({ level: 'error', code: 'DERIVE', msg: `cannot derive rooms from the compiled plan: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  const issues = mergeIssues(compiled.issues, extra)
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.filter((i) => i.level === 'warn').length
  return { ok: errors === 0, errors, warnings, issues, metrics, counts }
}

function validateText(v: ValidateOut, file: string): string[] {
  const t = [
    `${v.ok ? 'OK' : 'INVALID'} ${basename(file)}: ${v.errors} error(s), ${v.warnings} warning(s)` +
      (v.counts ? ` — walls ${v.counts.walls}, openings ${v.counts.openings}, rooms ${v.counts.rooms}, closed areas ${v.counts.faces}` : ''),
  ]
  for (const i of v.issues) t.push(`  ${i.level.toUpperCase().padEnd(5)} ${i.code}: ${i.msg}`)
  if (v.metrics) {
    const m = v.metrics
    t.push('rooms (computed / labelled m²):')
    const w = Math.max(4, ...m.rooms.map((r) => r.id.length))
    for (const r of m.rooms) {
      const comp = r.computed === null ? '   —  ' : r.computed.toFixed(2).padStart(6)
      const lab = r.labelled === undefined ? '   —  ' : r.labelled.toFixed(2).padStart(6)
      t.push(`  ${r.id.padEnd(w)} ${r.name.padEnd(16)} ${comp} / ${lab}  ${r.status}${r.pct !== undefined ? ` (${r.pct > 0 ? '+' : ''}${r.pct}%)` : ''}`)
    }
    t.push(
      `total ${m.totalArea.toFixed(2)} m² (rooms ${m.roomsArea.toFixed(2)})${m.labelledTotalArea !== undefined ? ` vs labelled ${m.labelledTotalArea}` : ''}; ` +
        `living ${m.livingArea.toFixed(2)}${m.labelledLivingArea !== undefined ? ` vs labelled ${m.labelledLivingArea}` : ''}`,
    )
  }
  return t
}

export async function specValidate(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<spec.json>'))
  const v = runValidate(readSpec(file))
  const strictFail = a.bool('strict') && v.warnings > 0
  return { data: { file, ...v }, text: validateText(v, file), exitCode: v.ok && !strictFail ? 0 : 1 }
}

// ───────────────────────── spec render ─────────────────────────

function sourceFrame(spec: SpecJson): { width: number; height: number; pxPerMm: number; offsetX: number; offsetY: number } {
  const sc = resolveScale(spec)
  const size = spec.source?.size
  if (!sc || !Array.isArray(size) || size.length < 2) {
    throw new DpError('--frame source needs source.size and a scale (source.mmPerPx or calibration)')
  }
  return { width: size[0], height: size[1], pxPerMm: 1 / sc.sx, offsetX: sc.ox, offsetY: sc.oy }
}

export async function specRender(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<spec.json>'))
  const out = resolve(a.req('out'))
  const spec = readSpec(file)
  const { doc } = compileOrThrow(spec)
  const lvl = firstLevel(doc)
  const frame = a.str('frame') === 'source' ? sourceFrame(spec) : undefined
  const r = renderDoc(doc, lvl, {
    pxPerMm: a.num('px-per-m', 100) / 1000,
    frame,
    dimensions: a.bool('dims', true),
    furniture: a.bool('furniture', true),
    theme: a.str('theme') === 'blueprint' ? 'blueprint' : 'light',
  })
  ensureDirFor(out)
  writeFileSync(out, r.png)
  return {
    data: { ok: true, out, size: [r.width, r.height], pxPerMm: r4(r.pxPerMm), offset: [r2(r.offsetX), r2(r.offsetY)], boundsMm: r.boundsMm },
    text: [
      `render: ${out} (${r.width}x${r.height}, ${r2(r.pxPerMm * 1000)} px/m${frame ? ', source frame' : ''})`,
      `plan bounds mm: x ${Math.round(r.boundsMm.minX)}…${Math.round(r.boundsMm.maxX)}, y ${Math.round(r.boundsMm.minY)}…${Math.round(r.boundsMm.maxY)}`,
    ],
  }
}

// ───────────────────────── spec overlay ─────────────────────────

function resolveSourceImage(spec: SpecJson, specFile: string, explicit?: string): string {
  if (explicit) {
    const p = resolve(explicit)
    if (!existsSync(p)) throw new DpError(`image not found: ${p}`)
    return p
  }
  const img = spec.source?.image
  if (!img) throw new DpError('no --image given and spec.source.image is not set')
  const cands = isAbsolute(img) ? [img] : [resolve(dirname(specFile), img), resolve(img)]
  const found = cands.find((c) => existsSync(c))
  if (!found) throw new DpError(`source image not found: ${img}`, 1, 'pass --image <work.png>')
  return found
}

interface OverlayOut {
  out: string
  image: string
  size: number[]
  diff?: MaskDiff
  metrics?: AreaMetrics
}

async function runOverlay(
  spec: SpecJson,
  specFile: string,
  out: string,
  o: { image?: string; alpha: number; diff: boolean; minThick?: number },
): Promise<OverlayOut> {
  const image = resolveSourceImage(spec, specFile, o.image)
  const sc = resolveScale(spec)
  if (!sc) throw new DpError('spec has no scale: set source.mmPerPx (+ originPx) or source.calibration', 1, 'pnpm dp spec scale --ref x1,y1,x2,y2 --mm N --spec <spec.json>')
  const { doc } = compileOrThrow(spec)
  const lvl = firstLevel(doc)
  const plan = derivePlan(doc, lvl)
  const img = await loadPng(image)
  const size = spec.source?.size
  const fx = Array.isArray(size) && size[0] > 0 ? img.width / size[0] : 1
  const fy = Array.isArray(size) && size[1] > 0 ? img.height / size[1] : fx
  const toPx: ToPx = (x, y) => [(x / sc.sx + sc.ox) * fx, (y / sc.sy + sc.oy) * fy]

  const am = areaMetrics(spec, doc, plan, sc)
  const labels = new Map<string, string[]>()
  for (const [faceId, specId] of am.faceToSpec) {
    const m = am.metrics.rooms.find((r) => r.id === specId)
    if (!m) continue
    labels.set(faceId, [
      m.name,
      `${m.computed?.toFixed(2) ?? '?'}${m.labelled !== undefined ? ` / ${m.labelled.toFixed(2)}` : ''} m²${m.status === 'warn' || m.status === 'error' ? ' !' : ''}`,
    ])
  }

  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, img.width, img.height)
  ctx.drawImage(img, 0, 0)
  drawPlanOverlay(ctx, doc, plan, toPx, labels, o.alpha)

  let diff: MaskDiff | undefined
  if (o.diff) {
    const g = await loadGray(image)
    const k = o.minThick ?? autoMinThick(g.width, g.height)
    const srcMask = open(binarize(g, otsu(g)), k)
    const planMask = planWallMask(doc, plan, toPx, g.width, g.height)
    diff = compareMasks(srcMask, { data: planMask, width: g.width, height: g.height })
    ctx.lineWidth = 2
    ctx.font = `bold 12px ${LABEL_FONT}`
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'left'
    ctx.setLineDash([5, 3])
    diff.missing.forEach((b, i) => {
      ctx.strokeStyle = '#ff2a00'
      ctx.strokeRect(b.x, b.y, b.w, b.h)
      haloText(ctx, `M${i + 1}`, b.x + 2, b.y - 1, '#ff2a00')
    })
    diff.extra.forEach((b, i) => {
      ctx.strokeStyle = '#0055ff'
      ctx.strokeRect(b.x, b.y, b.w, b.h)
      haloText(ctx, `E${i + 1}`, b.x + 2, b.y - 1, '#0055ff')
    })
    ctx.setLineDash([])
  }
  // legend
  ctx.font = `12px ${LABEL_FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const legend = [
    'plan walls = magenta, doors = blue, windows = green',
    ...(diff ? [`M = source walls missing in plan (red), E = extra plan walls (blue); wall IoU ${diff.iou}`] : []),
  ]
  legend.forEach((t, i) => haloText(ctx, t, 6, 6 + i * 15, '#000000'))
  savePng(canvas, out)
  return { out, image, size: [img.width, img.height], diff, metrics: am.metrics }
}

function overlayText(o: OverlayOut): string[] {
  const t = [`overlay: ${o.out} (${o.size.join('x')}, over ${basename(o.image)})`]
  if (o.diff) {
    const d = o.diff
    t.push(`wall IoU ${d.iou} (recall ${d.recall}, precision ${d.precision}) — HINT ONLY: hatched/hollow walls and furniture distort it`)
    if (d.missing.length) t.push(`missing in plan (px x,y,w,h): ${d.missing.map((b, i) => `M${i + 1}=${b.x},${b.y},${b.w},${b.h}`).join('  ')}`)
    if (d.extra.length) t.push(`extra in plan (px x,y,w,h): ${d.extra.map((b, i) => `E${i + 1}=${b.x},${b.y},${b.w},${b.h}`).join('  ')}`)
  }
  return t
}

export async function specOverlay(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<spec.json>'))
  const out = resolve(a.req('out'))
  const spec = readSpec(file)
  const o = await runOverlay(spec, file, out, {
    image: a.str('image'),
    alpha: Math.max(0.05, Math.min(1, a.num('alpha', 0.5))),
    diff: a.bool('diff', true),
    minThick: a.num('min-thick'),
  })
  return { data: { ok: true, ...o }, text: overlayText(o) }
}

// ───────────────────────── spec check (validate + render + overlay) ─────────────────────────

export async function specCheck(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<spec.json>'))
  const outDir = resolve(a.str('out-dir') ?? a.str('out') ?? join(dirname(file), 'check'))
  const spec = readSpec(file)
  let iter = a.num('iter')
  if (iter === undefined) {
    iter = 1
    if (existsSync(outDir)) {
      const nums = readdirSync(outDir)
        .map((f) => /^render-(\d+)\.png$/.exec(f)?.[1])
        .filter((v): v is string => !!v)
        .map(Number)
      if (nums.length) iter = Math.max(...nums) + 1
    }
  }
  const nn = String(iter).padStart(2, '0')
  const v = runValidate(spec)
  const text = validateText(v, file)
  const data: Record<string, unknown> = { file, iter, validate: v }
  if (v.counts) {
    const { doc } = compileOrThrow(spec)
    const r = renderDoc(doc, firstLevel(doc), { pxPerMm: a.num('px-per-m', 100) / 1000 })
    const renderFile = join(outDir, `render-${nn}.png`)
    ensureDirFor(renderFile)
    writeFileSync(renderFile, r.png)
    data.render = renderFile
    text.push(`render: ${renderFile} (${r.width}x${r.height})`)
    const hasImage = !!a.str('image') || !!spec.source?.image
    if (hasImage && resolveScale(spec)) {
      try {
        const o = await runOverlay(spec, file, join(outDir, `overlay-${nn}.png`), {
          image: a.str('image'),
          alpha: a.num('alpha', 0.5),
          diff: a.bool('diff', true),
          minThick: a.num('min-thick'),
        })
        data.overlay = { out: o.out, diff: o.diff }
        text.push(...overlayText(o))
      } catch (e) {
        text.push(`overlay skipped: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else text.push('overlay skipped: no source image / scale in the spec')
  }
  writeFileSync(join(outDir, `check-${nn}.json`), JSON.stringify(data, null, 2))
  return { data, text, exitCode: v.ok ? 0 : 1 }
}

// ───────────────────────── spec build ─────────────────────────

export async function specBuild(a: Args): Promise<CommandResult> {
  const file = resolve(a.pos(0, '<spec.json>'))
  const outArg = a.str('out') ?? join(dirname(file), `${basename(file, extname(file)).replace(/\.planspec$/, '')}.doplan`)
  const out = resolve(outArg.endsWith('.doplan') ? outArg : `${outArg}.doplan`)
  const spec = readSpec(file)
  const v = runValidate(spec)
  if (a.bool('strict') && !v.ok) {
    return { data: { ok: false, file, validate: v }, text: [...validateText(v, file), 'not built (--strict and validation errors)'], exitCode: 1 }
  }
  const { doc } = compileOrThrow(spec)
  const name = a.str('name') ?? spec.name ?? basename(file, extname(file))
  doc.meta.name = name
  const now = new Date().toISOString()
  doc.meta.modifiedAt = now
  if (!doc.meta.createdAt) doc.meta.createdAt = now
  const { assets, notes } = await embedUnderlay(doc, spec, file, a.bool('underlay', true))
  const { bytes } = writeDoplan(out, doc, name, assets)
  const text = [
    `built ${out} (${Math.round(bytes / 1024)} KB): ${Object.keys(doc.walls).length} walls, ${Object.keys(doc.openings).length} openings, ${Object.keys(doc.rooms).length} rooms`,
    ...notes,
  ]
  if (!v.ok) text.push(`WARNING: spec has ${v.errors} validation error(s) — run pnpm dp spec validate ${file}`)
  let launch: ReturnType<typeof openInApp> | undefined
  if (a.bool('open')) {
    launch = openInApp(out)
    text.push(launch.launched ? `opened in doplan (${launch.how})` : `not opened: ${launch.reason}. File: ${out}`)
  }
  return {
    data: { ok: true, out, bytes, name, errors: v.errors, warnings: v.warnings, notes, launch },
    text,
  }
}
