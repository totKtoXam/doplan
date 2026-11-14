import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { addOpening, addWall, createEmptyDoc, doorLeafSize, openingForLeaf } from '@core'
import { computeWallGeoms } from '@core/joins'
import type { DoorLeafStyle, DoorSlide, OpeningKind } from '@core/types'
import type { ProceduralFactory } from '@/contracts'
import type { MaterialLibraryEx } from '../../materials'
import { buildOpening } from '../openings'

const lib = {
  resolve: () => ({ transmission: 0 }),
  get: () => new THREE.MeshBasicMaterial(),
  plain: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialLibraryEx

function build(kind: OpeningKind, leafW: number, leafH: number, extra: { slide?: DoorSlide; style?: DoorLeafStyle } = {}) {
  const doc = createEmptyDoc('t')
  const lv = doc.levelOrder[0]
  const [wallId] = addWall(doc, lv, { x: 0, y: 0 }, { x: 4000, y: 0 }, { thickness: 200, height: 2700 })
  const size = openingForLeaf(kind, extra.slide, leafW, leafH)
  const id = addOpening(doc, wallId, kind, 2000, { ...size, ...extra, hinge: 'a', swing: 'left' })
  const o = doc.openings[id]
  const g = buildOpening({ opening: o, wall: doc.walls[wallId], geom: computeWallGeoms(doc, lv)[wallId], interior: 'left', ceilingMm: 2700 }, lib, {} as ProceduralFactory)
  g.updateMatrixWorld(true)
  const leaf = g.children.find((c) => c.userData.part === 'leaf') as THREE.Mesh | undefined
  const pts: THREE.Vector3[] = []
  const pos = leaf?.geometry.getAttribute('position')
  for (let i = 0; i < (pos?.count ?? 0); i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos!, i))
  return { o, pts, g }
}

/** largest horizontal distance between two vertices (a rotated hinged leaf: its plan diagonal) */
function planDiag(pts: THREE.Vector3[]): number {
  let best = 0
  for (const a of pts) for (const b of pts) best = Math.max(best, Math.hypot(a.x - b.x, a.z - b.z))
  return best
}

const mm = (m: number) => Math.round(m * 1000)

describe('door leaf size is 1:1', () => {
  it('hinged door: the leaf is exactly the leaf size picked', () => {
    for (const [w, h] of [
      [600, 2000],
      [800, 2100],
      [900, 2300],
    ]) {
      const { o, pts } = build('door', w, h, { style: 'flush' })
      expect(doorLeafSize(o)).toEqual({ w, h })
      const ys = pts.map((p) => p.y)
      expect(mm(Math.max(...ys) - Math.min(...ys))).toBe(h)
      // plan diagonal of a leaf w × 40 mm
      expect(mm(Math.sqrt(planDiag(pts) ** 2 - 0.04 ** 2))).toBe(w)
    }
  })

  it('entrance door', () => {
    const { pts } = build('entranceDoor', 860, 2000, { style: 'flush' })
    const ys = pts.map((p) => p.y)
    expect(mm(Math.max(...ys) - Math.min(...ys))).toBe(2000)
    expect(mm(Math.sqrt(planDiag(pts) ** 2 - 0.07 ** 2))).toBe(860)
  })

  it('sliding doors: surface, pocket and barn leaves', () => {
    for (const slide of ['surface', 'pocket', 'barn'] as const) {
      const { pts } = build('slidingDoor', 800, 2000, { slide, style: 'flush' })
      const xs = pts.map((p) => p.x)
      const ys = pts.map((p) => p.y)
      expect(mm(Math.max(...xs) - Math.min(...xs)), slide).toBe(800)
      expect(mm(Math.max(...ys) - Math.min(...ys)), slide).toBe(2000)
    }
  })

  it('all-glass sliding leaves take the leaf material and paint as the leaf', () => {
    for (const slide of ['surface', 'pocket', 'barn', 'folding'] as const) {
      const { g } = build('slidingDoor', 800, 2000, { slide, style: 'glass' })
      const parts = g.children.map((c) => c.userData.part)
      expect(parts, slide).toContain('glassLeaf')
      expect(parts, slide).not.toContain('glass')
      expect(g.children.find((c) => c.userData.part === 'glassLeaf')!.userData.slot, slide).toBe('leaf')
    }
  })

  it('the glazed entrance door has a see-through lite: no leaf face covers it', () => {
    const { g } = build('entranceDoor', 860, 2000, { style: 'glazed' })
    // geometry and rays in the opening's local frame
    g.position.set(0, 0, 0)
    g.rotation.set(0, 0, 0)
    g.updateMatrixWorld(true)
    const leaf = g.children.find((c) => c.userData.part === 'leaf') as THREE.Mesh
    const glass = g.children.find((c) => c.userData.part === 'glass') as THREE.Mesh
    glass.geometry.computeBoundingBox()
    const c = glass.geometry.boundingBox!.getCenter(new THREE.Vector3())
    // a ray through the middle of the lite, square to the leaf (the entrance leaf is drawn closed)
    const hits = (dir: THREE.Vector3) => new THREE.Raycaster(c.clone().addScaledVector(dir, -1), dir, 0, 2).intersectObject(leaf).length
    leaf.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    const n = new THREE.Vector3(0, 0, 1)
    expect(hits(n)).toBe(0)
  })
})
