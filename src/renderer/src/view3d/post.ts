/**
 * Post-processing pipeline of the 3D view (area: 3d-rendering).
 *
 * Built on three's TSL `RenderPipeline` and kept light: nothing accumulates over frames, so a frame
 * is finished when it is drawn and the view rests right after.
 *
 *   scene pass (output [+ normal for AO] + depth)
 *     → GTAO + denoise           (doc.render.occlusion, or a still; never over the baked light)
 *     → bloom                    (doc.render.bloom)
 *     → tone mapping + sRGB      (renderOutput)
 *     → selection / hover outline (editor only: the published viewer selects nothing)
 *     → FXAA
 *
 * Everything is guarded: if building or running a graph throws, the pipeline degrades first to
 * "scene pass + outline + FXAA" and finally to a plain `renderer.render()`.
 */
import * as THREE from 'three'
import { RenderPipeline } from 'three/webgpu'
import * as TSLModule from 'three/tsl'
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { outline } from 'three/addons/tsl/display/OutlineNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import type { QualityPreset } from '@core/types'
import type { EngineContext, PostPipeline } from '@/contracts'
import { docStore } from '@/store/document'
import { isViewOnly } from '@/store/viewOnly'
import { currentQuality, getShared, type PostInternals } from './quality'

// The TSL typings are far stricter than what a dynamically assembled graph can satisfy.
const T: any = TSLModule

/** 0 = everything asked for, 1 = safe minimum, 2 = no pipeline at all */
type DegradeLevel = 0 | 1 | 2

interface Features {
  ao: boolean
  bloom: boolean
  outline: boolean
  hoverOutline: boolean
}

function readAccent(container: HTMLElement): THREE.Vector3 {
  const c = new THREE.Color(0x4c9aff)
  try {
    const css = getComputedStyle(container).getPropertyValue('--accent').trim()
    if (css) c.setStyle(css)
  } catch {
    /* keep the default accent */
  }
  // the outline is mixed in after tone mapping, i.e. in display (sRGB) space
  const out = { r: 0, g: 0, b: 0 }
  c.getRGB(out, THREE.SRGBColorSpace)
  return new THREE.Vector3(out.r, out.g, out.b)
}

export function createPost(ctx: EngineContext): PostPipeline {
  const renderer = ctx.renderer
  const scene = ctx.scene
  const camera = ctx.camera
  const shared = getShared(ctx)

  let pipeline: InstanceType<typeof RenderPipeline> | null = null
  let disposables: Array<{ dispose?: () => void }> = []
  let dirty = true
  let disposed = false
  let degrade: DegradeLevel = 0
  let features: Features = { ao: false, bloom: false, outline: false, hoverOutline: false }
  let featureSig = ''
  /** a still is being rendered: it gets the occlusion pass even when the view runs without it */
  let stillAo = false

  // outline targets: the arrays are owned here and mutated in place (the nodes keep references)
  const selectedObjects: THREE.Object3D[] = []
  const hoveredObjects: THREE.Object3D[] = []

  const sizeBefore = new THREE.Vector2()

  function wantedFeatures(): Features {
    const q = currentQuality(ctx)
    const r = docStore.getState().doc.render
    const editor = !isViewOnly()
    return {
      // a baked light map already holds the occlusion of the walls and floors
      ao: (r.occlusion === true || stillAo) && !shared.baked,
      bloom: r.bloom === true,
      outline: editor,
      hoverOutline: editor && q.hoverOutline,
    }
  }

  function signature(f: Features): string {
    const q = currentQuality(ctx)
    return `${f.ao ? q.preset : '-'}|${f.ao ? 1 : 0}${f.bloom ? 1 : 0}${f.outline ? 1 : 0}${f.hoverOutline ? 1 : 0}|${degrade}`
  }

  function disposeGraph(): void {
    for (const d of disposables) {
      try {
        d.dispose?.()
      } catch {
        /* a node that was never built has nothing to free */
      }
    }
    disposables = []
    if (pipeline) {
      try {
        pipeline.dispose()
      } catch {
        /* ignore */
      }
      pipeline = null
    }
  }

  function track<N>(node: N): N {
    disposables.push(node as unknown as { dispose?: () => void })
    return node
  }

  function buildGraph(f: Features): any {
    const q = currentQuality(ctx)
    const scenePass = track(T.pass(scene, camera, { samples: 0 }))
    if (f.ao) scenePass.setMRT(T.mrt({ output: T.output, normal: T.directionToColor(T.normalView) }))

    let hdr: any = scenePass.getTextureNode('output')

    if (f.ao) {
      const depth = scenePass.getTextureNode('depth')
      const encoded = scenePass.getTextureNode('normal')
      const normal = T.sample((uv: any) => T.colorToDirection(encoded.sample(uv)))
      const aoNode: any = track((gtao as any)(depth, normal, camera))
      aoNode.resolutionScale = q.aoResolutionScale
      aoNode.samples.value = q.aoSamples
      aoNode.radius.value = 0.45
      aoNode.thickness.value = 1
      // no temporal filter to smooth the grain: a spatial one instead
      const smooth: any = track((denoise as any)(aoNode.getTextureNode(), depth, normal, camera))
      smooth.radius.value = 4
      // AO is a fill-light effect: keep 15 % of the occluded light so corners never go black
      const occlusion = T.mix(T.float(1), smooth.r, T.float(0.85))
      hdr = T.vec4(hdr.rgb.mul(occlusion), hdr.a)
    }

    if (f.bloom) {
      const glow: any = track((bloom as any)(hdr, 0.16, 0.5, 1.0))
      hdr = T.vec4(hdr.rgb.add(glow.rgb), hdr.a)
    }

    let display: any = T.renderOutput(hdr)
    if (f.outline) display = addOutlines(display, f.hoverOutline)
    return track((fxaa as any)(display))
  }

  function addOutlines(display: any, withHover: boolean): any {
    const accent = T.uniform(readAccent(ctx.container))
    const sel: any = track(
      (outline as any)(scene, camera, {
        selectedObjects,
        edgeThickness: T.uniform(1.5),
        edgeGlow: T.uniform(0),
      }),
    )
    const selMask = sel.visibleEdge.mul(3).add(sel.hiddenEdge.mul(1.1)).clamp(0, 1)
    let rgb = T.mix(display.rgb, accent, selMask)
    if (withHover) {
      const hov: any = track(
        (outline as any)(scene, camera, {
          selectedObjects: hoveredObjects,
          edgeThickness: T.uniform(1),
          edgeGlow: T.uniform(0),
        }),
      )
      const hovMask = hov.visibleEdge.mul(2.2).clamp(0, 1).mul(0.85)
      rgb = T.mix(rgb, T.vec3(1, 1, 1), hovMask)
    }
    return T.vec4(rgb, display.a)
  }

  function buildMinimalGraph(): any {
    const scenePass = track(T.pass(scene, camera, { samples: 0 }))
    let display: any = T.renderOutput(scenePass.getTextureNode('output'))
    if (!isViewOnly()) display = addOutlines(display, false)
    return track((fxaa as any)(display))
  }

  function rebuild(): void {
    dirty = false
    disposeGraph()
    features = wantedFeatures()
    featureSig = signature(features)
    if (degrade === 2) return
    try {
      const node = degrade === 0 ? buildGraph(features) : buildMinimalGraph()
      const p = new RenderPipeline(renderer)
      p.outputColorTransform = false
      p.outputNode = node
      p.needsUpdate = true
      pipeline = p
    } catch (err) {
      console.warn(`[post] pipeline build failed (level ${degrade})`, err)
      disposeGraph()
      degrade = (degrade < 2 ? degrade + 1 : 2) as DegradeLevel
      rebuild()
    }
  }

  function drawPlain(): void {
    renderer.render(scene, camera)
  }

  /** A node that throws mid-frame can leave the renderer bound to an internal target. */
  function restoreRendererState(target: THREE.RenderTarget | null): void {
    try {
      renderer.setRenderTarget(target)
      renderer.setMRT?.(null)
    } catch {
      /* nothing else to restore */
    }
  }

  function draw(): void {
    const target: THREE.RenderTarget | null = renderer.getRenderTarget()
    if (pipeline) {
      try {
        pipeline.render()
        return
      } catch (err) {
        console.warn(`[post] pipeline render failed (level ${degrade}), degrading`, err)
        restoreRendererState(target)
        degrade = (degrade < 2 ? degrade + 1 : 2) as DegradeLevel
        rebuild()
      }
    }
    const fallback = pipeline as InstanceType<typeof RenderPipeline> | null
    if (fallback) {
      try {
        fallback.render()
        return
      } catch (err) {
        console.warn('[post] minimal pipeline failed too, falling back to plain rendering', err)
        restoreRendererState(target)
        degrade = 2
        rebuild()
      }
    }
    drawPlain()
  }

  function render(): void {
    if (disposed) return
    if (!dirty && signature(wantedFeatures()) !== featureSig) dirty = true
    if (dirty) rebuild()
    camera.updateMatrixWorld()
    draw()
  }

  const internals: PostInternals = {
    renderToTarget(target, width, height) {
      if (disposed) return
      stillAo = true
      if (dirty || signature(wantedFeatures()) !== featureSig) rebuild()
      const helpersVisible = ctx.roots.helpers.visible
      const keepSelected = selectedObjects.splice(0, selectedObjects.length)
      const keepHovered = hoveredObjects.splice(0, hoveredObjects.length)
      const prevTarget = renderer.getRenderTarget()
      const prevOutput = renderer.getOutputRenderTarget ? renderer.getOutputRenderTarget() : null
      const prevAspect = camera.aspect
      renderer.getSize(sizeBefore)
      const prevDpr = renderer.getPixelRatio()
      ctx.roots.helpers.visible = false
      try {
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        if (pipeline) {
          // the scene pass sizes itself from the drawing buffer
          renderer.setDrawingBufferSize(width, height, 1)
          renderer.setRenderTarget(target)
          for (let i = 0; i < 2; i++) draw()
        }
        if (!pipeline) {
          // plain path: the renderer applies tone mapping + sRGB only in its output pass, which runs
          // when no render target is bound — so bind the target as the *output* target instead
          renderer.setDrawingBufferSize(width, height, 1)
          if (renderer.setOutputRenderTarget) {
            renderer.setOutputRenderTarget(target)
            renderer.setRenderTarget(null)
          } else renderer.setRenderTarget(target)
          renderer.render(scene, camera)
        }
      } finally {
        renderer.setOutputRenderTarget?.(prevOutput)
        renderer.setRenderTarget(prevTarget)
        renderer.setDrawingBufferSize(sizeBefore.x, sizeBefore.y, prevDpr)
        camera.aspect = prevAspect
        camera.updateProjectionMatrix()
        ctx.roots.helpers.visible = helpersVisible
        selectedObjects.push(...keepSelected)
        hoveredObjects.push(...keepHovered)
        stillAo = false
        ctx.invalidate()
      }
    },
    kick() {
      /* nothing accumulates over frames */
    },
  }
  shared.post = internals

  let lastRender = docStore.getState().doc.render
  const unsubDoc = docStore.subscribe((state) => {
    const r = state.doc.render
    if (r === lastRender) return
    const flagsChanged = r.occlusion !== lastRender.occlusion || r.bloom !== lastRender.bloom
    lastRender = r
    if (flagsChanged) dirty = true
    ctx.invalidate()
  })

  return {
    render,
    setSize(_w: number, _h: number, _dpr: number) {
      // render targets follow the renderer's drawing buffer
      ctx.invalidate()
    },
    setQuality(q: QualityPreset) {
      shared.setQuality(q)
      // a preset change is also a chance to retry passes that failed earlier
      if (degrade === 1) degrade = 0
      dirty = true
      ctx.invalidate()
    },
    setOutline(selected: THREE.Object3D[], hovered: THREE.Object3D | null) {
      let changed = selected.length !== selectedObjects.length
      if (!changed) {
        for (let i = 0; i < selected.length; i++) {
          if (selected[i] !== selectedObjects[i]) {
            changed = true
            break
          }
        }
      }
      if (changed) {
        selectedObjects.length = 0
        selectedObjects.push(...selected)
      }
      // an object that is already selected does not need a second outline
      const hover = hovered && !selected.includes(hovered) ? hovered : null
      if ((hoveredObjects[0] ?? null) !== hover || hoveredObjects.length > 1) {
        hoveredObjects.length = 0
        if (hover) hoveredObjects.push(hover)
        changed = true
      }
      if (changed) ctx.invalidate()
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubDoc()
      disposeGraph()
      selectedObjects.length = 0
      hoveredObjects.length = 0
      if (shared.post === internals) shared.post = null
    },
  }
}
