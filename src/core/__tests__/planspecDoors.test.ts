import { describe, expect, it } from 'vitest'
import { compilePlanSpecDetailed, docToPlanSpec, parsePlanSpec } from '../planspec'

const spec = (openings: unknown[]) => ({
  version: 1,
  units: 'mm',
  walls: [{ path: [[0, 0], [6000, 0], [6000, 4000], [0, 4000], [0, 0]], thickness: 200, kind: 'exterior' }],
  rooms: [{ id: 'r', type: 'living', at: [3000, 2000] }],
  openings,
})

describe('planspec: door slide and leaf style', () => {
  it('compiles pocket/folding aliases, barn slide and style, and exports them back', () => {
    const res = compilePlanSpecDetailed(parsePlanSpec(spec([
      { id: 'p', type: 'pocketDoor', width: 840, at: [1000, 0] },
      { id: 'f', type: 'foldingDoor', width: 864, at: [3000, 0], style: 'glazed' },
      { id: 'b', type: 'slidingDoor', slide: 'barn', width: 800, at: [5000, 0], style: 'glass' },
      { id: 's', type: 'slidingDoor', width: 800, at: [6000, 2000] },
      { id: 'd', type: 'door', width: 868, at: [3000, 4000], style: 'panel' },
    ])))
    const ops = Object.values(res.doc.openings)
    const by = (style: string | undefined, slide: string | undefined) => ops.filter((o) => o.style === style && o.slide === slide)
    expect(ops.filter((o) => o.kind === 'slidingDoor')).toHaveLength(4)
    expect(by(undefined, 'pocket')).toHaveLength(1)
    expect(by('glazed', 'folding')).toHaveLength(1)
    expect(by('glass', 'barn')).toHaveLength(1)
    expect(ops.find((o) => o.kind === 'door')?.style).toBe('panel')

    const back = docToPlanSpec(res.doc, res.levelId)
    const types = back.openings.map((o) => `${o.type}/${o.slide ?? '-'}/${o.style ?? '-'}`).sort()
    expect(types).toEqual(['door/-/panel', 'foldingDoor/-/glazed', 'pocketDoor/-/-', 'slidingDoor/-/-', 'slidingDoor/barn/glass'])

    // and the exported spec compiles to the same doors
    const again = compilePlanSpecDetailed(parsePlanSpec(JSON.parse(JSON.stringify(back))))
    const sig = (d: typeof res.doc) => Object.values(d.openings).map((o) => `${o.kind}/${o.slide ?? '-'}/${o.style ?? '-'}`).sort()
    expect(sig(again.doc)).toEqual(sig(res.doc))
  })

  it('rejects an unknown slide or style', () => {
    expect(() => parsePlanSpec(spec([{ type: 'slidingDoor', slide: 'swing', width: 800, at: [1000, 0] }]))).toThrow()
    expect(() => parsePlanSpec(spec([{ type: 'door', style: 'oak', width: 800, at: [1000, 0] }]))).toThrow()
  })
})
