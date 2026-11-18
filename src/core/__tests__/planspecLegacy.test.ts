// Plans without cutouts are built by the base code (planspecBase.ts = planspec.ts at a56f5f4) and must
// come out bit for bit as at a56f5f4: walls, openings, derived faces and wall outlines, room areas,
// issues. The digests in fixtures/legacyPlans.a56f5f4.json were made by the a56f5f4 tree itself from
// the same seeded specs. The cutout geometry turns on only with a cutout (or a technical room / cutout
// wall); such a plan is always built and checked by the cutout compiler, and refused when its check refuses.
import { describe, expect, it } from 'vitest'
import { derivePlan } from '../derive'
import { compileCutoutSpec, compilePlanSpecDetailed, parsePlanSpec, usesCutoutLogic, validateCutoutSpec, validatePlanSpecDetailed, type PlanSpec } from '../planspec'
import * as base from '../planspecBase'
import { digestPlan, legacyPlan, type DigestApi, type PlanDigest } from './fixtures/legacyPlans'
import fixture from './fixtures/legacyPlans.a56f5f4.json'

const api = (validate: (s: never) => unknown, compile: (s: never) => unknown): DigestApi =>
  ({ parse: parsePlanSpec, validate, compile, derive: derivePlan }) as unknown as DigestApi
const PUBLIC = api(validatePlanSpecDetailed, compilePlanSpecDetailed)

describe('planspec without cutouts: exactly the a56f5f4 build', () => {
  const plans = (fixture as { plans: PlanDigest[] }).plans
  it('the fixture covers 300+ plans', () => {
    expect(plans.length).toBeGreaterThanOrEqual(300)
  })
  const chunk = 40
  for (let k = 0; k < plans.length; k += chunk) {
    it(`plans ${k + 1}–${Math.min(plans.length, k + chunk)}`, { timeout: 120_000 }, () => {
      for (const want of plans.slice(k, k + chunk)) {
        const spec = legacyPlan(want.seed)
        expect(usesCutoutLogic(spec), `seed ${want.seed}`).toBe(false)
        expect(digestPlan(want.seed, spec, PUBLIC), `seed ${want.seed}`).toEqual(want)
      }
    })
  }
})

const L: [number, number][] = [[0, 0], [2000, 0], [2000, 1000], [4000, 1000], [4000, 3000], [0, 3000]]
const sp = (rooms: unknown[]): PlanSpec =>
  ({ version: 1, units: 'mm', defaults: { exteriorThickness: 300, partitionThickness: 100, loadBearingThickness: 200 }, rooms, openings: [] }) as unknown as PlanSpec

describe('planspec: which compiler builds a plan', () => {
  it('cutouts, technical rooms and cutout walls turn the cutout compiler on; nothing else does', () => {
    expect(usesCutoutLogic(sp([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000] }]))).toBe(false)
    expect(usesCutoutLogic(sp([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [] }]))).toBe(false)
    expect(usesCutoutLogic(sp([{ id: 'a', type: 'living', rect: [0, 0, 4000, 3000], cutouts: [{ rect: [0, 0, 600, 600] }] }]))).toBe(true)
    expect(usesCutoutLogic(sp([{ id: 'a', type: 'other', rect: [0, 0, 600, 600], technical: true }]))).toBe(true)
    expect(usesCutoutLogic({ ...sp([]), walls: [{ id: 'w', path: [[0, 0], [600, 0]], cutout: true }] })).toBe(true)
    expect(usesCutoutLogic(null)).toBe(false)
  })

  it('a cutout plan both checks accept is built by the cutout compiler', () => {
    const spec = sp([{ id: 'a', type: 'living', polygon: L, cutouts: [{ rect: [0, 0, 600, 600], kind: 'shaft' }] }])
    expect(validateCutoutSpec(spec).ok).toBe(true)
    const v = validatePlanSpecDetailed(spec)
    expect(v.ok).toBe(true)
    expect(v.issues.some((i) => i.code === 'CUTOUT_BASE_BUILD')).toBe(false)
    const now = digestPlan(0, spec, PUBLIC)
    expect(now).toEqual(digestPlan(0, spec, api(validateCutoutSpec, compileCutoutSpec)))
  })

  it('a cutout plan the cutout check refuses is refused, even when the base check would accept it', () => {
    // two shafts across the line of a reflex corner: the cutout compiler refuses them (CUTOUT_AT_CORNER);
    // the base would build them, losing a shaft, floor and the technical mark, so it is never asked
    const spec = sp([{ id: 'a', type: 'living', polygon: L, cutouts: [{ rect: [1400, 1000, 600, 600], kind: 'shaft' }, { rect: [2000, 1000, 600, 600], kind: 'shaft' }] }])
    expect(base.validatePlanSpecDetailed(spec as unknown as base.PlanSpec).ok).toBe(true)
    const v = validatePlanSpecDetailed(spec)
    expect(v.ok).toBe(false)
    expect(v.issues.find((i) => i.code === 'CUTOUT_AT_CORNER')?.severity).toBe('error')
    expect(v).toEqual(validateCutoutSpec(spec))
    expect(v.issues.some((i) => i.code === 'CUTOUT_BASE_BUILD')).toBe(false)
    const res = compilePlanSpecDetailed(parsePlanSpec(spec))
    expect(res.issues.some((i) => i.code === 'CUTOUT_BASE_BUILD')).toBe(false)
    expect(digestPlan(0, spec, PUBLIC)).toEqual(digestPlan(0, spec, api(validateCutoutSpec, compileCutoutSpec)))
  })

  it('a refused shape (BUILT_SHAPE_MISMATCH) is not built by the base either', () => {
    const spec = {
      ...sp([
        { id: 'a', type: 'living', polygon: [[0, 0], [2500, 0], [2500, 1900], [4800, 1900], [4800, 3600], [0, 3600]], labelledArea: 12.5, cutouts: [{ rect: [2650, 1900, 750, 550], kind: 'shaft' }] },
        { id: 'b', type: 'bedroom', rect: [4800, 1900, 2000, 1700] },
      ]),
      defaults: { exteriorThickness: 510, partitionThickness: 100, loadBearingThickness: 200 },
    }
    const v = validatePlanSpecDetailed(spec)
    expect(v).toEqual(validateCutoutSpec(spec))
    expect(v.issues.some((i) => i.code === 'CUTOUT_BASE_BUILD')).toBe(false)
    expect(v.ok).toBe(false)
    expect(v.issues.find((i) => i.code === 'BUILT_SHAPE_MISMATCH')?.severity).toBe('error')
  })

  it('a cutout plan both checks refuse stays refused with the new check’s errors', () => {
    const spec = sp([{ id: 'a', type: 'living', polygon: L, cutouts: [{ rect: [1500, 500, 1000, 1000], kind: 'shaft' }] }])
    const v = validatePlanSpecDetailed(spec)
    expect(v.ok).toBe(false)
    expect(v.issues.map((i) => i.code)).toContain('CUTOUT_OUTSIDE')
    expect(v.issues.some((i) => i.code === 'CUTOUT_BASE_BUILD')).toBe(false)
  })
})
