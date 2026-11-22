import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { precompile, shaderKey } from './precompile'

function scene() {
  const s = new THREE.Scene()
  const root = new THREE.Group()
  s.add(root)
  const box = new THREE.BoxGeometry()
  const plain = new THREE.MeshStandardMaterial()
  const other = new THREE.MeshStandardMaterial()
  const a = new THREE.Mesh(box, plain)
  const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), plain) // same kind as a
  const cutaway = new THREE.Group()
  cutaway.visible = false
  const c = new THREE.Mesh(box, other) // hidden, a kind of its own
  const d = new THREE.Mesh(box, plain) // hidden, same kind as a
  const lamp = new THREE.PointLight()
  cutaway.add(c, d, lamp)
  const sun = new THREE.DirectionalLight()
  root.add(a, b, cutaway, sun)
  return { s, root, a, b, c, d, cutaway, lamp, sun }
}

const drawn = (s: THREE.Scene) => {
  const out: THREE.Object3D[] = []
  s.traverseVisible((o) => out.push(o))
  return out
}

describe('precompile', () => {
  it('a shader kind is material, geometry layout and flags, not the object', () => {
    const { a, b, c } = scene()
    expect(shaderKey(a)).toBe(shaderKey(b))
    expect(shaderKey(a)).not.toBe(shaderKey(c))
    b.receiveShadow = true
    expect(shaderKey(a)).not.toBe(shaderKey(b))
    expect(shaderKey(new THREE.Group())).toBeNull()
  })

  it('compiles what is drawn and one hidden object of each kind it lacks, with the lights that are on', async () => {
    const { s, root, a, b, c, d, cutaway, lamp, sun } = scene()
    let seen: THREE.Object3D[] = []
    const renderer = { compileAsync: async () => void (seen = drawn(s)) }
    await precompile(renderer, s, new THREE.PerspectiveCamera(), [root])
    expect(seen).toContain(a)
    expect(seen).toContain(c)
    expect(seen).toContain(b)
    expect(seen).not.toContain(d)
    expect(seen).toContain(sun)
    expect(seen).not.toContain(lamp)
    // all put back
    expect([a.visible, b.visible, cutaway.visible, c.visible, d.visible, lamp.visible]).toEqual([true, true, false, true, true, true])
    expect(a.frustumCulled && c.frustumCulled).toBe(true)
  })
})
