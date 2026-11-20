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
  const hidden: THREE.Object3D[] = []
  const culled: THREE.Object3D[] = []
  for (const root of roots) {
    root.traverse((o) => {
      if (!o.visible && o !== root) {
        o.visible = true
        hidden.push(o)
      }
      if ((o as THREE.Mesh).isMesh && o.frustumCulled) {
        o.frustumCulled = false
        culled.push(o)
      }
    })
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
    for (const o of hidden) o.visible = false
    for (const o of culled) o.frustumCulled = true
  }
}
