import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { patternOffset } from '../patterns'

/** texture coordinate three computes for a surface point (u, v in metres), as in materials.ts */
function texAt(uMm: number, vMm: number, period: [number, number], rotationDeg: number, off: [number, number]): THREE.Vector2 {
  const t = new THREE.Texture()
  t.repeat.set(1000 / period[0], 1000 / period[1])
  t.center.set(0, 0)
  t.rotation = THREE.MathUtils.degToRad(rotationDeg)
  t.offset.set(off[0], off[1])
  t.updateMatrix()
  return new THREE.Vector2(uMm / 1000, vMm / 1000).applyMatrix3(t.matrix)
}

describe('layout start (pattern offset)', () => {
  for (const rot of [0, 30, 45, 90]) {
    it(`moves the pattern along the surface axes at ${rot}°`, () => {
      const period: [number, number] = [600, 900]
      const [dx, dy] = [250, -120]
      const shifted = patternOffset(dx, dy, THREE.MathUtils.degToRad(rot), period)
      // the shifted pattern at (u + dx, v + dy) shows what the plain one shows at (u, v)
      for (const [u, v] of [[0, 0], [1234, 567], [-300, 2000]]) {
        const a = texAt(u, v, period, rot, [0, 0])
        const b = texAt(u + dx, v + dy, period, rot, shifted)
        expect(b.x).toBeCloseTo(a.x, 9)
        expect(b.y).toBeCloseTo(a.y, 9)
      }
    })
  }
})
