/**
 * Smoke test of the photo-to-plan toolchain on the bundled example.
 *   pnpm exec tsx tools/dp/smoke.ts [--keep]
 * validate → render → (synthetic source image) → overlay → img lines → normalize px→mm → build → doc info/render
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docInfo, docRender } from './commands/doc'
import { imgGrid, imgInfo, imgLines } from './commands/img'
import { specBuild, specNormalize, specOverlay, specRender, specValidate } from './commands/spec'
import { Args, parseArgs } from './lib/args'
import type { CommandResult } from './lib/output'
import { mmToPx, readSpec, resolveScale, type SpecJson } from './lib/spec'

const here = fileURLToPath(new URL('.', import.meta.url))
const example = resolve(here, 'examples', 'two-room.planspec.json')
const work = join(tmpdir(), `doplan-dp-smoke-${Date.now()}`)
const keep = process.argv.includes('--keep')
let failures = 0

async function step(name: string, fn: (a: Args) => Promise<CommandResult>, argv: string[], check?: (r: CommandResult) => string | null): Promise<CommandResult | null> {
  const t0 = Date.now()
  try {
    const r = await fn(new Args(parseArgs(argv)))
    const problem = (r.exitCode ?? 0) !== 0 ? `exit code ${r.exitCode}` : check ? check(r) : null
    const status = problem ? 'FAIL' : 'ok'
    process.stdout.write(`[${status}] ${name} (${Date.now() - t0} ms)${problem ? ` — ${problem}` : ''}\n`)
    for (const line of r.text ?? []) process.stdout.write(`       ${line}\n`)
    if (problem) failures++
    return r
  } catch (e) {
    failures++
    process.stdout.write(`[FAIL] ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    return null
  }
}

/** px draft of the example (what an agent writes first), to test normalize px → mm */
function toPxDraft(spec: SpecJson): SpecJson {
  const sc = resolveScale(spec)
  if (!sc) throw new Error('example has no scale')
  const px = structuredClone(spec)
  px.units = 'px'
  const P = (p: number[]) => mmToPx(sc, p[0], p[1]).map((v) => Math.round(v * 10) / 10)
  for (const r of px.rooms) {
    if (r.rect) {
      const [x, y] = P(r.rect)
      r.rect = [x, y, r.rect[2] / sc.sx + 0.4, r.rect[3] / sc.sy - 0.3] // a little reading noise
    }
  }
  for (const o of px.openings) {
    if (o.at) o.at = P(o.at)
    o.width = o.width / sc.sx
  }
  for (const f of px.fixtures ?? []) {
    if (f.rect) {
      const [x, y] = P(f.rect)
      f.rect = [x, y, f.rect[2] / sc.sx, f.rect[3] / sc.sy]
    }
    if (f.at) f.at = P(f.at)
  }
  if (px.source) {
    delete px.source.mmPerPx
    px.source.calibration = [
      { p1: P([0, 3400]), p2: P([3300, 3400]), mm: 3300, label: 'спальня по ширине' },
      { p1: P([7400, 0]), p2: P([7400, 8000]), mm: 8000, label: 'кухня + гостиная по глубине' },
    ]
  }
  return px
}

async function main(): Promise<void> {
  mkdirSync(work, { recursive: true })
  const spec = join(work, 'two-room.planspec.json')
  copyFileSync(example, spec)
  process.stdout.write(`smoke dir: ${work}\n`)

  await step('spec validate (example)', specValidate, [spec], (r) => {
    const m = (r.data.metrics ?? null) as { rooms: { computed: number | null }[] } | null
    if (!m) return 'no area metrics (compile failed?)'
    if (m.rooms.some((x) => x.computed === null)) return 'some rooms were not found in the compiled plan'
    return null
  })
  await step('spec render', specRender, [spec, '--out', join(work, 'render.png'), '--px-per-m', '80'])
  // synthetic "source image" in the spec's own px frame (source.image = two-room.png)
  await step('spec render --frame source (synthetic source)', specRender, [spec, '--out', join(work, 'two-room.png'), '--frame', 'source', '--no-dims', '--no-furniture'])
  await step('img info', imgInfo, [join(work, 'two-room.png')])
  await step('img grid', imgGrid, [join(work, 'two-room.png'), '--out', join(work, 'grid.png')])
  await step('img lines', imgLines, [join(work, 'two-room.png'), '--out', join(work, 'lines.json'), '--overlay', join(work, 'lines.png')], (r) =>
    typeof r.data.walls === 'number' && r.data.walls >= 5 ? null : `expected ≥ 5 wall candidates, got ${String(r.data.walls)}`,
  )
  await step('spec overlay', specOverlay, [spec, '--out', join(work, 'overlay.png')], (r) => {
    const d = r.data.diff as { iou: number } | undefined
    return d && d.iou >= 0.5 ? null : `wall IoU too low against its own render: ${d?.iou}`
  })

  const draft = join(work, 'two-room.px.json')
  writeFileSync(draft, JSON.stringify(toPxDraft(readSpec(spec)), null, 2))
  const normOut = join(work, 'two-room.norm.json')
  await step('spec normalize (px draft → mm)', specNormalize, [draft, '--out', normOut], () => {
    const a = readSpec(spec)
    const b = readSpec(normOut)
    let worst = 0
    a.rooms.forEach((r, i) => {
      const q = b.rooms[i]
      if (r.rect && q.rect) for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(r.rect[k] - q.rect[k]))
    })
    return worst <= 20 ? null : `normalized rects differ from the original by up to ${worst} mm`
  })
  await step('spec validate (normalized draft)', specValidate, [normOut])

  const project = join(work, 'two-room.doplan')
  await step('spec build', specBuild, [spec, '--out', project])
  await step('doc info', docInfo, [project], (r) => {
    const lv = (r.data.levels as { rooms: unknown[] }[] | undefined)?.[0]
    return lv && lv.rooms.length >= 7 ? null : `expected ≥ 7 rooms, got ${lv?.rooms.length}`
  })
  await step('doc render', docRender, [project, '--out', join(work, 'doc.png')])

  process.stdout.write(failures ? `\nSMOKE FAILED: ${failures} step(s)\n` : '\nSMOKE OK\n')
  if (!keep && !failures) rmSync(work, { recursive: true, force: true })
  else process.stdout.write(`outputs kept in ${work}\n`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => {
  process.stdout.write(`smoke crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  process.exitCode = 1
})
