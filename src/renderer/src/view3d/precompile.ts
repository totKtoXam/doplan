/**
 * Shader precompilation (area: 3d-rendering).
 *
 * A material the renderer meets for the first time is compiled inside the frame that draws it: a
 * pause of tens to hundreds of milliseconds per material on a weak device (the 3D view opening, a
 * model arriving, a new finish, the baked light switching on). Instead the engine notices new
 * materials before a frame and compiles them with `renderer.compileAsync()`, which builds the
 * shaders in slices and lets the GPU driver compile in parallel, while the canvas keeps showing the
 * previous frame.
 *
 * Hidden parts (the lowered walls of the cut-away, the ceilings, hidden objects) and those out of
 * the camera's view are compiled too: they would otherwise compile in the frame that shows them.
 * Of the hidden ones only one object of each kind (material, geometry layout, flags: what a shader
 * depends on) that the drawn ones lack: the rest of the cut-away and the ceilings is not sent to the
 * GPU until a frame shows it.
 */
import type * as THREE from 'three'

/** materials compiled for the current light set; a new light set starts a new epoch */
export class CompiledMaterials {
  private seen = new WeakMap<THREE.Material, number>()
  private epoch = 0

  /** the lights changed: every material's shader is built again */
  reset(): void {
    this.epoch++
  }

  /** the visible materials under `roots` not compiled yet */
  pending(roots: THREE.Object3D[]): THREE.Material[] {
    const out = new Set<THREE.Material>()
    const add = (m: THREE.Material | null | undefined): void => {
      if (m && this.seen.get(m) !== this.epoch) out.add(m)
    }
    for (const root of roots) {
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
        if (!m) return
        if (Array.isArray(m)) m.forEach(add)
        else add(m)
      })
    }
    return [...out]
  }

  mark(materials: THREE.Material[]): void {
    for (const m of materials) this.seen.set(m, this.epoch)
  }
}

/**
 * Compiles everything under `roots` (with the lights and the environment of `scene`) for `camera`.
 * `viaPass` compiles through the post-processing scene pass (its target, outputs and context), so
 * the GPU pipelines are the ones its frames use. Resolves after `timeoutMs` at the latest: a frame
 * is then drawn anyway.
 */
export async function precompile(
  renderer: any,
  scene: THREE.Scene,
  camera: THREE.Camera,
  roots: THREE.Object3D[],
  viaPass: (() => Promise<void>) | null = null,
  timeoutMs = 15000,
): Promise<void> {
  if (!renderer || typeof renderer.compileAsync !== 'function') return
  // what is drawn now is compiled whole, out of view too: the next frames need its geometry anyway.
  // Of what is hidden, one object of each kind the drawn ones lack.
  const drawn = new Set<THREE.Object3D>()
  scene.traverseVisible((o) => void drawn.add(o))
  const kinds = new Set<string>()
  const culled: THREE.Object3D[] = []
  const cull = (o: THREE.Object3D): void => {
    if (o.frustumCulled) {
      o.frustumCulled = false
      culled.push(o)
    }
  }
  for (const root of roots) {
    root.traverseVisible((o) => {
      const key = shaderKey(o)
      if (key === null) return
      kinds.add(key)
      cull(o)
    })
  }
  const shown: THREE.Object3D[] = [] // were hidden, drawn for the compile
  const keep = new Set<THREE.Object3D>() // the hidden ones compiled and their parents
  for (const root of roots) {
    root.traverse((o) => {
      if (drawn.has(o)) return
      const key = shaderKey(o)
      if (key === null || kinds.has(key)) return
      kinds.add(key)
      cull(o)
      for (let a: THREE.Object3D | null = o; a && a !== root; a = a.parent) {
        keep.add(a)
        if (!a.visible) {
          a.visible = true
          shown.push(a)
        }
      }
    })
  }
  // the rest of what the shown groups hold stays out, their lights too: the light set is part of
  // every shader, and it is the one on now
  const hidden: THREE.Object3D[] = []
  if (shown.length) {
    for (const root of roots) {
      root.traverseVisible((o) => {
        if (drawn.has(o) || keep.has(o)) return
        if (shaderKey(o) !== null || (o as THREE.Light).isLight) {
          o.visible = false
          hidden.push(o)
        }
      })
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const prevTarget = renderer.getRenderTarget?.() ?? null
  const prevMrt = renderer.getMRT?.() ?? null
  const prevContext = renderer.contextNode
  try {
    const work = viaPass ? viaPass() : (renderer.compileAsync(scene, camera) as Promise<void>)
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    await Promise.race([work, late])
  } catch (err) {
    console.warn('[doplan] shader precompilation failed', err)
  } finally {
    if (timer) clearTimeout(timer)
    // the pass puts them back when its compile ends, which may be after the timeout: a frame drawn
    // meanwhile must go to the canvas
    if (viaPass) {
      renderer.setRenderTarget(prevTarget)
      renderer.setMRT?.(prevMrt)
      renderer.contextNode = prevContext
    }
    for (const o of hidden) o.visible = true
    for (const o of shown) o.visible = false
    for (const o of culled) o.frustumCulled = true
  }
}

/**
 * What the shader of a drawable depends on besides the lights, the environment and the render
 * target: its material, kind, geometry layout and shadow flags. Null for what draws nothing.
 * Instanced, batched and skinned objects are their own kind.
 */
export function shaderKey(o: THREE.Object3D): string | null {
  const d = o as THREE.Mesh & { isInstancedMesh?: boolean; isBatchedMesh?: boolean; isSkinnedMesh?: boolean; count?: number }
  const g = d.geometry as THREE.BufferGeometry | undefined
  if (!g || !d.material || !g.attributes) return null
  const mats = Array.isArray(d.material) ? d.material : [d.material]
  let key = d.type + '|' + mats.map((m) => m.uuid).join('+')
  if (Array.isArray(d.material)) key += '|g' + g.groups.map((gr) => gr.materialIndex).join('.')
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name] as THREE.BufferAttribute
    key += `|${name}:${a.itemSize}${a.normalized ? 'n' : ''}${a.array?.constructor?.name ?? ''}`
  }
  const morph = Object.keys(g.morphAttributes ?? {})
  if (morph.length) key += '|m' + morph.sort().join('.')
  if (g.index) key += '|i'
  if (d.isInstancedMesh || d.isBatchedMesh || d.isSkinnedMesh || (d.count ?? 1) > 1) key += '|' + d.uuid
  return key + (d.receiveShadow ? '|r' : '') + (d.castShadow ? '|c' : '')
}
