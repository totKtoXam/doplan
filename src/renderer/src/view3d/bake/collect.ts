/**
 * What a bake is made of, read from the built scene: the receivers (the plan's walls, floors and
 * ceilings, which get the light map), the casters (everything solid that blocks light) and the
 * signatures the viewer compares to know the published light still fits what it shows.
 *
 * Receivers are found the same way in the editor and in the viewer: by the group they belong to and
 * their place in it, with the cut-away wall variants and hidden ceilings included, so the page
 * covers whatever the camera may show.
 */
import * as THREE from 'three'
import type { Doc, Id } from '@core/types'
import { fingerprint } from './unwrap'

export interface Receiver {
  key: string
  mesh: THREE.Mesh
  /** world-space triangles, 9 numbers each, in the order of the non-indexed geometry */
  positions: Float32Array
}

const RECEIVER_GROUP = /^(wall-set|room):/

function opaque(m: THREE.Material): boolean {
  const p = m as THREE.MeshPhysicalMaterial
  return !m.transparent && m.opacity >= 1 && !(p.transmission > 0) && m.visible !== false
}

function glowing(m: THREE.Material): boolean {
  const s = m as THREE.MeshStandardMaterial
  return !!s.emissive && s.emissiveIntensity > 0 && s.emissive.r + s.emissive.g + s.emissive.b > 0.01
}

/** world-space non-indexed triangles of a mesh (one instance, or the mesh itself) */
export function worldTriangles(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): Float32Array {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!pos) return new Float32Array(0)
  const index = geometry.index
  const count = index ? index.count : pos.count
  const out = new Float32Array(count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    const k = index ? index.getX(i) : i
    v.fromBufferAttribute(pos, k).applyMatrix4(matrix)
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  // a mirrored transform turns the triangles inside out: put the winding back
  if (matrix.determinant() < 0)
    for (let t = 0; t + 8 < out.length; t += 9)
      for (let c = 0; c < 3; c++) {
        const a = out[t + 3 + c]
        out[t + 3 + c] = out[t + 6 + c]
        out[t + 6 + c] = a
      }
  return out
}

/**
 * The receivers under the architecture root: single-material opaque meshes of walls and rooms (not
 * glass, not glowing strips). Keys name the group and the mesh's place in it.
 */
export function receiversOf(root: THREE.Object3D): Receiver[] {
  root.updateMatrixWorld(true)
  const out: Receiver[] = []
  const seen = new Map<string, number>()
  for (const anchor of root.children) {
    if (!RECEIVER_GROUP.test(anchor.name)) continue
    const walk = (o: THREE.Object3D, path: string): void => {
      o.children.forEach((child, i) => {
        const p = `${path}/${i}`
        const mesh = child as THREE.Mesh
        if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) {
          const m = mesh.material
          if (!Array.isArray(m) && opaque(m) && !glowing(m) && mesh.matrixWorld.determinant() > 0) {
            let key = `${anchor.name}${p}`
            const n = seen.get(key) ?? 0
            seen.set(key, n + 1)
            if (n) key += `#${n}`
            const positions = worldTriangles(mesh.geometry, mesh.matrixWorld)
            if (positions.length) out.push({ key, mesh, positions })
          }
        }
        walk(child, p)
      })
    }
    walk(anchor, '')
  }
  // the scene adds groups in the order they were last rebuilt: the layout must not depend on it
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** the receivers' keys and triangles in one short hash */
export function geometryHash(receivers: readonly Receiver[]): string {
  return fnv(receivers.map((r) => `${r.key}=${fingerprint(r.positions)}`).join(';'))
}

function shown(o: THREE.Object3D, stop: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== stop.parent; p = p.parent) if (!p.visible) return false
  return true
}

/** every visible opaque triangle under the roots, merged (what blocks the light) */
export function castersOf(roots: THREE.Object3D[]): Float32Array {
  const parts: Float32Array[] = []
  const m = new THREE.Matrix4()
  for (const root of roots) {
    root.updateMatrixWorld(true)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || o.userData.helper || !shown(o, root)) return
      const mat = mesh.material
      const mats = Array.isArray(mat) ? mat : [mat]
      if (!mats.some(opaque)) return
      const inst = mesh as THREE.InstancedMesh
      if (inst.isInstancedMesh) {
        for (let i = 0; i < inst.count; i++) {
          inst.getMatrixAt(i, m)
          parts.push(worldTriangles(mesh.geometry, m.premultiply(mesh.matrixWorld)))
        }
      } else parts.push(worldTriangles(mesh.geometry, mesh.matrixWorld))
    })
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    all.set(p, o)
    o += p.length
  }
  return all
}

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const r2 = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)

/**
 * What the light was baked for, from the shown document: the lights and the sky (`lights`) and the
 * things that throw shadows besides the walls and rooms (`casters`). A hidden lamp or chair in the
 * viewer changes them, and the viewer then lights the scene live.
 */
export function bakeSignature(doc: Doc, levelId: Id): { lights: string; casters: string } {
  const r = doc.render
  const sky = [r.sunAuto, r.timeOfDay, r.sunAzimuth, r.sunElevation, r.north, r.sunIntensity, r.hdriId, r.hdriIntensity, r.hdriRotation, r.lightsOn]
  const lights = Object.values(doc.lights)
    .filter((l) => l.levelId === levelId)
    .map((l) => [l.id, l.kind, l.x, l.y, l.elevation, l.temperature, l.lumens, l.on, l.rotation, l.size?.w, l.size?.d])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const ceiling = doc.levels[levelId]?.height ?? doc.settings.wallHeight
  const items = Object.values(doc.items)
    .filter((i) => i.levelId === levelId)
    .map((i) => [i.id, i.assetId, i.x, i.y, i.elevation, i.rotation, i.size.w, i.size.d, i.size.h, !!i.mirrored, i.params ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const openings = Object.values(doc.openings)
    .map((o) => JSON.stringify(o, r2))
    .sort()
  const electrical = Object.values(doc.electrical ?? {})
    .filter((e) => (e as { levelId?: Id }).levelId === levelId)
    .map((e) => JSON.stringify(e, r2))
    .sort()
  return {
    lights: fnv(JSON.stringify([levelId, sky, lights, ceiling], r2)),
    casters: fnv(JSON.stringify([levelId, items, openings, electrical], r2)),
  }
}
