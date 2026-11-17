import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { specBuild, specValidate } from '../commands/spec'
import { docSpec } from '../commands/doc'
import { Args, parseArgs } from '../lib/args'
import { normalizeSpec } from '../lib/normalize'
import type { SpecJson } from '../lib/spec'

const dir = mkdtempSync(join(tmpdir(), 'dp-spec-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
const write = (spec: unknown): string => {
  const f = join(dir, `s${++n}.json`)
  writeFileSync(f, JSON.stringify(spec))
  return f
}
const run = (cmd: typeof specBuild, argv: string[]) => cmd(new Args(parseArgs(argv)))

/** a living room 4×3 m with a 0.6×1.0 m shaft in the corner (clear floor 11.4 m²) and a loggia 4×1 m printed ×0.5 */
const flat = (living: Record<string, unknown>, loggia: Record<string, unknown> = { labelledAreaCoef: 0.5 }, source: Record<string, unknown> = {}) => ({
  version: 1,
  units: 'mm',
  source,
  defaults: { exteriorThickness: 300 },
  rooms: [
    { id: 'a', name: 'Комната', type: 'living', rect: [0, 0, 4000, 3000], labelledArea: 11.4, ...living },
    { id: 'l', name: 'Лоджия', type: 'loggia', rect: [0, 3300, 4000, 1000], labelledArea: 2, edgeWall: { kind: 'parapet' }, ...loggia },
  ],
  openings: [
    { type: 'entranceDoor', at: [4150, 1500], width: 900, between: ['a', 'outside'] },
    { type: 'balconyDoor', at: [2000, 3150], width: 800, between: ['a', 'l'] },
    { type: 'window', at: [-150, 1500], width: 1200 },
  ],
})
const shaft = { cutouts: [{ rect: [0, 0, 600, 1000], kind: 'shaft' }] }

describe('dp spec build: gate', () => {
  it('refuses a spec whose room area does not match the printed one', async () => {
    const f = write(flat({})) // the shaft is missing → 12.0 vs 11.4 m² (+5.3 %)
    const out = join(dir, 'refused.doplan')
    const res = await run(specBuild, [f, '--out', out])
    expect(res.exitCode).toBe(1)
    expect(existsSync(out)).toBe(false)
    expect(res.text?.join('\n')).toMatch(/build gate: CLOSED/)
    expect(res.text?.join('\n')).toMatch(/AREA_MISMATCH/)
  })

  it('--force builds it anyway and says so', async () => {
    const f = write(flat({}))
    const out = join(dir, 'forced.doplan')
    const res = await run(specBuild, [f, '--out', out, '--force'])
    expect(res.exitCode ?? 0).toBe(0)
    expect(existsSync(out)).toBe(true)
    expect(res.text?.join('\n')).toMatch(/--force/)
  })

  it('an explained mismatch (areaNote) does not block the build', async () => {
    const f = write(flat({ areaNote: 'шахта не показана на плане, площадь по экспликации' }))
    const out = join(dir, 'explained.doplan')
    const res = await run(specBuild, [f, '--out', out])
    expect(res.exitCode ?? 0).toBe(0)
    expect(existsSync(out)).toBe(true)
  })

  it('cutouts + labelledAreaCoef make the areas match and the build passes', async () => {
    const f = write(flat(shaft))
    const v = await run(specValidate, [f])
    expect(v.exitCode).toBe(0)
    const data = v.data as { metrics: { rooms: { id: string; computed: number; status: string; coef?: number }[] }; issues: { code: string; level: string }[] }
    expect(data.metrics.rooms.find((r) => r.id === 'a')).toMatchObject({ computed: 11.4, status: 'ok' })
    expect(data.metrics.rooms.find((r) => r.id === 'l')).toMatchObject({ computed: 4, status: 'ok', coef: 0.5 })
    // the shaft void is a technical face, not a forgotten room
    expect(data.issues.some((i) => i.code === 'UNLABELLED_FACE')).toBe(false)
    expect(data.issues.some((i) => i.code === 'TECHNICAL_FACE' && i.level === 'info')).toBe(true)
    const out = join(dir, 'ok.doplan')
    const res = await run(specBuild, [f, '--out', out])
    expect(res.exitCode ?? 0).toBe(0)
    expect(existsSync(out)).toBe(true)
  })

  it('a loggia printed ×0.5 without labelledAreaCoef blocks the build with a hint', async () => {
    const f = write(flat(shaft, {}))
    const res = await run(specBuild, [f, '--out', join(dir, 'loggia.doplan')])
    expect(res.exitCode).toBe(1)
    expect(res.text?.join('\n')).toMatch(/labelledAreaCoef: 0\.5/)
  })

  it('--strict also blocks on warnings', async () => {
    const f = write(flat({ ...shaft, labelledArea: 11.2 })) // +1.8 % … 0.2 m² → warning
    const plain = await run(specBuild, [f, '--out', join(dir, 'warn.doplan')])
    expect(plain.exitCode ?? 0).toBe(0)
    const strict = await run(specBuild, [f, '--out', join(dir, 'warn-strict.doplan'), '--strict'])
    expect(strict.exitCode).toBe(1)
  })

  it('a total-area mismatch blocks unless source.areaNote explains it', async () => {
    const f = write(flat(shaft, undefined, { labelledTotalArea: 15 }))
    expect((await run(specBuild, [f, '--out', join(dir, 'total.doplan')])).exitCode).toBe(1)
    const g = write(flat(shaft, undefined, { labelledTotalArea: 15, areaNote: 'итог в экспликации включает кладовую на этаже' }))
    expect((await run(specBuild, [g, '--out', join(dir, 'total-ok.doplan')])).exitCode ?? 0).toBe(0)
  })
})

describe('dp spec normalize: cutouts', () => {
  it('converts cutout rects from px and snaps them to the room edges', () => {
    const spec: SpecJson = {
      version: 1,
      units: 'px',
      source: { mmPerPx: 10 },
      rooms: [{ id: 'a', rect: [0, 0, 400, 300], cutouts: [{ rect: [0.4, -0.3, 59.6, 100.1], kind: 'shaft' }] }],
      openings: [],
    }
    const { spec: out } = normalizeSpec(spec, {})
    expect(out.units).toBe('mm')
    expect(out.rooms[0].cutouts?.[0].rect).toEqual([0, 0, 600, 1000])
  })
})

describe('dp spec: cutouts round trip and technical voids', () => {
  /** a living room 4×3 m with a shaft and a box side by side along the top wall (10.8 m² of floor) */
  const cut = flat({ labelledArea: 10.8, cutouts: [{ rect: [0, 0, 600, 1000], kind: 'shaft' }, { rect: [600, 0, 600, 1000], kind: 'box' }] }, undefined, {
    labelledTotalArea: 12.8,
  })

  it('build → dp doc spec → validate → build passes the gate again', async () => {
    const out = join(dir, 'rt.doplan')
    expect((await run(specBuild, [write(cut), '--out', out])).exitCode ?? 0).toBe(0)
    const back = join(dir, 'rt.planspec.json')
    expect((await run(docSpec, [out, '--out', back])).exitCode ?? 0).toBe(0)
    const v = await run(specValidate, [back])
    expect(v.exitCode).toBe(0)
    const data = v.data as { issues: { code: string; level: string }[] }
    expect(data.issues.filter((i) => i.level === 'error')).toEqual([])
    expect(data.issues.some((i) => i.code === 'ROOM_UNREACHABLE')).toBe(false)
    expect((await run(specBuild, [back, '--out', join(dir, 'rt2.doplan')])).exitCode ?? 0).toBe(0)
  })

  it('a shaft over 1 m² is a technical face, not an unlabelled room, and stays out of the totals', async () => {
    const big = flat({ rect: [0, 0, 4000, 4000], labelledArea: 13.75, cutouts: [{ rect: [0, 0, 1500, 1500], kind: 'shaft' }] }, { rect: [0, 4300, 4000, 1000], labelledAreaCoef: 0.5 }, {
      labelledTotalArea: 15.75,
    })
    big.openings = [
      { type: 'entranceDoor', at: [4150, 2000], width: 900, between: ['a', 'outside'] },
      { type: 'balconyDoor', at: [2000, 4150], width: 800, between: ['a', 'l'] },
      { type: 'window', at: [-150, 2500], width: 1200 },
    ]
    const v = await run(specValidate, [write(big)])
    const data = v.data as { issues: { code: string; level: string }[] }
    expect(data.issues.filter((i) => i.level === 'error')).toEqual([])
    expect(data.issues.some((i) => i.code === 'UNLABELLED_FACE')).toBe(false)
    expect(data.issues.some((i) => i.code === 'TECHNICAL_FACE')).toBe(true)
  })
})
