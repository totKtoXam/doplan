import * as THREE from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { describe, expect, it } from 'vitest'
import { crease } from '../common'

function maxNormalDiff(a: THREE.BufferGeometry, b: THREE.BufferGeometry): number {
  const na = a.getAttribute('normal')
  const nb = b.getAttribute('normal')
  expect(na.count).toBe(nb.count)
  let worst = 0
  for (let i = 0; i < na.count; i++)
    worst = Math.max(worst, Math.abs(na.getX(i) - nb.getX(i)), Math.abs(na.getY(i) - nb.getY(i)), Math.abs(na.getZ(i) - nb.getZ(i)))
  return worst
}

describe('crease', () => {
  it('matches three toCreasedNormals where corners are far apart', () => {
    for (const make of [() => new THREE.BoxGeometry(1, 0.5, 0.3), () => new THREE.CylinderGeometry(0.4, 0.4, 1, 24), () => new THREE.SphereGeometry(0.5, 16, 12)]) {
      const ours = crease(make(), 0.7)
      const theirs = toCreasedNormals(make().toNonIndexed(), 0.7)
      expect(maxNormalDiff(ours, theirs)).toBeLessThan(1e-5)
    }
  })

  it('keeps small bevels apart: corners closer than 1 cm are not averaged together', () => {
    // a 4 mm cube: three's 1 cm cells would merge all 8 corners and smooth across the hard edges
    const g = crease(new THREE.BoxGeometry(0.004, 0.004, 0.004), 0.7)
    const n = g.getAttribute('normal')
    for (let i = 0; i < n.count; i++) {
      const v = new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i))
      expect(Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z))).toBeCloseTo(1, 5)
    }
  })
})
