/**
 * Cross-module integration checks (core ↔ view3d/procedural ↔ UI ↔ bundled asset pack):
 *  - every builtin asset builds through the procedural factory into a finite, slot-tagged mesh tree
 *    that fills item.size;
 *  - every material id the generators, assets, defaults and UI refer to exists in the catalogue;
 *  - the bundled pack (resources/assets/catalog.json) does not shadow builtin ids and its local
 *    files exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { addItem, BUILTIN_ASSETS, BUILTIN_MATERIALS, createEmptyDoc, DEFAULT_MATERIALS, defaultCurtain } from '@core'
import type { CurtainKind, SurfaceFinish } from '@core/types'
import type { MaterialLibrary } from '@/contracts'
import { createProceduralFactory, listFallbackMaterialIds, listProceduralKinds } from '../index'

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..')
const builtinMaterialIds = new Set(BUILTIN_MATERIALS.map((m) => m.id))
const builtinAssetIds = new Set(BUILTIN_ASSETS.map((a) => a.id))

/** records every material id requested by the generators */
function recordingLibrary(): { lib: MaterialLibrary; requested: Set<string> } {
  const requested = new Set<string>()
  const lib: MaterialLibrary = {
    get(finish: SurfaceFinish | string) {
      requested.add(typeof finish === 'string' ? finish : finish.materialId)
      return new THREE.MeshStandardMaterial()
    },
    getForItem(materialId: string) {
      requested.add(materialId)
      return new THREE.MeshStandardMaterial()
    },
    dispose() {},
  }
  return { lib, requested }
}

function isOverflow(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (p.userData.overflow) return true
  return false
}

describe('procedural factory × builtin catalogue', () => {
  it('has a generator for every procedural kind used by BUILTIN_ASSETS and vice versa', () => {
    const kinds = new Set(listProceduralKinds())
    const used = new Set(BUILTIN_ASSETS.filter((a) => a.kind === 'procedural').map((a) => a.procedural))
    for (const k of used) expect(kinds.has(k!), `no generator for ${k}`).toBe(true)
    for (const k of kinds) expect(used.has(k), `no builtin asset for ${k}`).toBe(true)
  })

  it('falls back only to existing builtin materials', () => {
    for (const id of listFallbackMaterialIds()) expect(builtinMaterialIds.has(id), id).toBe(true)
  })

  it('builds every builtin asset: finite geometry, slot tags, fills item.size, known materials', () => {
    const factory = createProceduralFactory()
    const { lib, requested } = recordingLibrary()
    const doc = createEmptyDoc()
    const levelId = Object.keys(doc.levels)[0]
    const problems: string[] = []
    for (const asset of BUILTIN_ASSETS) {
      if (asset.kind !== 'procedural') continue
      for (const [slot, id] of Object.entries(asset.slots ?? {})) {
        if (!builtinMaterialIds.has(id)) problems.push(`${asset.id}: slot ${slot} → unknown material ${id}`)
      }
      const item = doc.items[addItem(doc, levelId, asset, 0, 0)]
      let root: THREE.Object3D
      try {
        root = factory.build(asset, item, lib)
      } catch (err) {
        problems.push(`${asset.id}: build threw ${(err as Error).message}`)
        continue
      }
      root.updateMatrixWorld(true)
      const box = new THREE.Box3()
      let meshes = 0
      root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        meshes++
        if (typeof mesh.userData.slot !== 'string' || !mesh.userData.slot) problems.push(`${asset.id}: mesh "${mesh.name}" has no userData.slot`)
        const pos = mesh.geometry.getAttribute('position')
        if (!pos || pos.count === 0) return
        for (let i = 0; i < pos.array.length; i++) {
          if (!Number.isFinite(pos.array[i])) {
            problems.push(`${asset.id}: non-finite vertex in "${mesh.name}"`)
            break
          }
        }
        if (isOverflow(mesh, root)) return
        mesh.geometry.computeBoundingBox()
        box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld))
      })
      if (meshes === 0) {
        problems.push(`${asset.id}: no meshes`)
        continue
      }
      const size = box.getSize(new THREE.Vector3())
      const tol = 0.005 // 5 mm
      const want = { w: item.size.w / 1000, h: item.size.h / 1000, d: item.size.d / 1000 }
      if (Math.abs(size.x - want.w) > tol || Math.abs(size.y - want.h) > tol || Math.abs(size.z - want.d) > tol) {
        problems.push(
          `${asset.id}: bounds ${size.x.toFixed(3)}×${size.y.toFixed(3)}×${size.z.toFixed(3)} m ≠ size ${want.w}×${want.h}×${want.d} m`,
        )
      }
      if (Math.abs(box.min.y) > tol) problems.push(`${asset.id}: does not stand on the floor (min y ${box.min.y.toFixed(3)})`)
    }
    for (const id of requested) if (!builtinMaterialIds.has(id)) problems.push(`generator requested unknown material ${id}`)
    expect(problems).toEqual([])
  }, 120_000) // ~110 assets with merged/creased geometry: several seconds in Node

  it('builds every curtain kind open, half and fully closed', () => {
    const factory = createProceduralFactory()
    const { lib, requested } = recordingLibrary()
    const kinds: CurtainKind[] = ['drapes', 'sheer', 'drapesAndSheer', 'roman', 'roller', 'blinds']
    for (const kind of kinds) {
      for (const closed of [0, 0.5, 1]) {
        const obj = factory.buildCurtain({ ...defaultCurtain(), kind, closed }, { width: 1.6, top: 2.55, bottom: 0.8 }, lib)
        let meshes = 0
        obj.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) meshes++
        })
        expect(meshes, `${kind} @ ${closed}`).toBeGreaterThan(0)
      }
    }
    for (const id of requested) expect(builtinMaterialIds.has(id), id).toBe(true)
  })
})

describe('material / asset ids across modules', () => {
  const catalogFile = join(REPO, 'resources/assets/catalog.json')
  const pack = existsSync(catalogFile)
    ? (JSON.parse(readFileSync(catalogFile, 'utf8')) as {
        materials: { id: string; remote?: boolean; maps?: Record<string, string>; thumb?: string }[]
        assets: { id: string; remote?: boolean; src?: string; thumb?: string }[]
        hdris: { id: string; remote?: boolean; src: string; thumb?: string }[]
      })
    : { materials: [], assets: [], hdris: [] }
  const packMaterialIds = new Set(pack.materials.map((m) => m.id))
  const packAssetIds = new Set(pack.assets.map((a) => a.id))

  it('DEFAULT_MATERIALS point at builtin materials', () => {
    for (const [k, id] of Object.entries(DEFAULT_MATERIALS)) expect(builtinMaterialIds.has(id), `${k} → ${id}`).toBe(true)
  })

  it('the bundled pack does not shadow builtin ids and its local files exist', () => {
    const problems: string[] = []
    for (const id of packMaterialIds) if (builtinMaterialIds.has(id)) problems.push(`material ${id} shadows a builtin`)
    for (const id of packAssetIds) if (builtinAssetIds.has(id)) problems.push(`asset ${id} shadows a builtin`)
    const local = (rel: string | undefined, what: string) => {
      if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel)) return
      if (!existsSync(join(REPO, 'resources/assets', rel.split('?')[0]))) problems.push(`${what}: missing ${rel}`)
    }
    for (const m of pack.materials) {
      local(m.thumb, m.id)
      if (!m.remote) for (const v of Object.values(m.maps ?? {})) local(v, m.id)
    }
    for (const a of pack.assets) {
      local(a.thumb, a.id)
      if (!a.remote) local(a.src, a.id)
    }
    for (const h of pack.hdris) {
      local(h.thumb, h.id)
      if (!h.remote) local(h.src, h.id)
    }
    expect(problems).toEqual([])
  })

  it('every mat_* / asset_* literal in the sources exists in the builtin catalogue or the bundled pack', () => {
    // ids that are intentionally not catalogue entries
    const allowed = new Set(['mat_fallback' /* view3d/materials.ts error material */, 'mat_custom' /* test fixture */])
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        if (f === 'node_modules' || f === '.cache' || f === '__tests__') continue
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(f)) files.push(p)
      }
    }
    walk(join(REPO, 'src'))
    walk(join(REPO, 'tools'))
    const problems: string[] = []
    for (const file of files) {
      if (/[\\/]core[\\/]defaults\.ts$/.test(file)) continue
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/['"`](mat_[a-z0-9_]+)['"`]/g)) {
        const id = m[1]
        if (!allowed.has(id) && !builtinMaterialIds.has(id) && !packMaterialIds.has(id)) problems.push(`${relative(REPO, file)}: ${id}`)
      }
      for (const m of text.matchAll(/['"`](asset_[a-z0-9_]+)['"`]/g)) {
        const id = m[1]
        if (!allowed.has(id) && !builtinAssetIds.has(id) && !packAssetIds.has(id)) problems.push(`${relative(REPO, file)}: ${id}`)
      }
    }
    expect(problems).toEqual([])
  })
})
