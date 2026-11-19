/**
 * Post-processing pipeline of the 3D view (area: 3d-rendering).
 *
 * Built on three's TSL `RenderPipeline` (the class formerly called `PostProcessing`):
 *
 *   scene pass (MRT: output [+ normal, velocity, metal/rough, diffuse] + depth)
 *     → SSGI (GI + AO)  or  GTAO
 *     → SSR
 *     → bloom
 *     → TRAA                      (temporal presets, WebGPU backend)
 *     → tone mapping + sRGB       (renderOutput)
 *     → selection / hover outline
 *     → FXAA                      (non temporal presets)
 *
 * Which passes exist is decided by the quality preset, doc.render switches and the backend.
 * Everything is guarded: if building or running a graph throws, the pipeline degrades first
 * to "scene pass + outline + FXAA" and finally to a plain `renderer.render()`.
 */
import * as THREE from 'three'
import { RenderPipeline } from 'three/webgpu'
import * as TSLModule from 'three/tsl'
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js'
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { outline } from 'three/addons/tsl/display/OutlineNode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import type { QualityPreset } from '@core/types'
import type { EngineContext, PostPipeline } from '@/contracts'
import { docStore } from '@/store/document'
import { currentQuality, getShared, isWebGPU, type PostInternals } from './quality'

// The TSL typings are far stricter than what a dynamically assembled graph can satisfy.
const T: any = TSLModule

/** 0 = everything the preset asks for, 1 = safe minimum, 2 = no pipeline at all */
type DegradeLevel = 0 | 1 | 2

interface Features {
  ao: boolean
  ssgi: boolean
  ssr: boolean
  bloom: boolean
  traa: boolean
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
  let features: Features = { ao: false, ssgi: false, ssr: false, bloom: false, traa: false, hoverOutline: false }
  let featureSig = ''

  // outline targets: the arrays are owned here and mutated in place (the nodes keep references)
  const selectedObjects: THREE.Object3D[] = []
  const hoveredObjects: THREE.Object3D[] = []

  // temporal convergence tail
  let tailLength = 0
  let tailRemaining = 0
  let selfInvalidated = false
  let kicked = true
  const lastCamera = new Float32Array(32)

  const sizeBefore = new THREE.Vector2()

  function wantedFeatures(): Features {
    const q = currentQuality(ctx)
    const r = docStore.getState().doc.render
    const gpu = isWebGPU(renderer)
    const temporal = q.antialias === 'traa' && gpu
    return {
      // a baked light map already holds the occlusion of the walls and floors
      ao: q.ao && r.ao !== false && !shared.baked,
      // SSGI is tuned for temporal accumulation; without TRAA it is too noisy to show
      ssgi: q.ssgi && r.ssgi === true && gpu && temporal && !shared.baked,
      ssr: q.ssr && r.ssr === true && gpu,
      bloom: q.bloom && r.bloom !== false,
      traa: temporal,
      hoverOutline: q.hoverOutline,
    }
  }

  function signature(f: Features): string {
    return `${currentQuality(ctx).preset}|${f.ao ? 1 : 0}${f.ssgi ? 1 : 0}${f.ssr ? 1 : 0}${f.bloom ? 1 : 0}${f.traa ? 1 : 0}${f.hoverOutline ? 1 : 0}|${degrade}`
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

    const needNormal = f.ssgi || f.ssr || (f.ao && f.traa)
    const targets: Record<string, any> = { output: T.output }
    if (needNormal) targets.normal = T.directionToColor(T.normalView)
    if (f.traa) targets.velocity = T.velocity
    if (f.ssr) targets.metalrough = T.vec2(T.metalness, T.roughness)
    if (f.ssgi) targets.diffuse = T.diffuseColor
    if (Object.keys(targets).length > 1) scenePass.setMRT(T.mrt(targets))

    const color = scenePass.getTextureNode('output')
    const depth = scenePass.getTextureNode('depth')
    let normal: any = null
    if (needNormal) {
      const encoded = scenePass.getTextureNode('normal')
      normal = T.sample((uv: any) => T.colorToDirection(encoded.sample(uv)))
    }

    let hdr: any = color

    if (f.ssgi) {
      const gi: any = track((ssgi as any)(color, depth, normal, camera))
      gi.sliceCount.value = q.ssgiSlices
      gi.stepCount.value = q.ssgiSteps
      gi.radius.value = 5
      gi.thickness.value = 0.5
      gi.giIntensity.value = 8
      gi.aoIntensity.value = 1
      gi.useTemporalFiltering = true
      const diffuse = scenePass.getTextureNode('diffuse')
      const occlusion = gi.getAONode().r
      const bounce = gi.getGINode().rgb
      hdr = T.vec4(color.rgb.mul(occlusion).add(diffuse.rgb.mul(bounce)), color.a)
    } else if (f.ao) {
      const aoNode: any = track((gtao as any)(depth, normal, camera))
      aoNode.resolutionScale = q.aoResolutionScale
      aoNode.samples.value = q.aoSamples
      aoNode.radius.value = 0.45
      aoNode.thickness.value = 1
      aoNode.useTemporalFiltering = f.traa
      let aoTexture: any = aoNode.getTextureNode()
      // a preset made for TRAA that runs without it (WebGL 2) gets the denoise pass instead of raw grain
      if (!f.traa && (q.aoDenoise || q.antialias === 'traa')) {
        const smooth: any = track((denoise as any)(aoTexture, depth, normal, camera))
        smooth.radius.value = 4
        aoTexture = smooth
      }
      // AO is a fill-light effect: keep 15 % of the occluded light so corners never go black
      const occlusion = T.mix(T.float(1), aoTexture.r, T.float(0.85))
      hdr = T.vec4(color.rgb.mul(occlusion), color.a)
    }

    if (f.ssr) {
      const metalRough = scenePass.getTextureNode('metalrough')
      const reflections: any = track(
        (ssr as any)(color, depth, normal, {
          metalnessNode: metalRough.r,
          roughnessNode: metalRough.g,
          reflectNonMetals: true,
          camera,
        }),
      )
      reflections.maxDistance.value = 4
      reflections.thickness.value = 0.06
      reflections.quality.value = q.ssrQuality
      reflections.resolutionScale = q.ssrResolutionScale
      // glossy surfaces only; dielectrics reflect far less than metals
      const smoothness = T.float(1).sub(metalRough.g.clamp(0, 1))
      const weight = smoothness.mul(smoothness).mul(T.mix(T.float(0.3), T.float(1), metalRough.r.clamp(0, 1)))
      hdr = T.vec4(hdr.rgb.add(reflections.rgb.mul(weight)), hdr.a)
    }

    if (f.bloom) {
      const glow: any = track((bloom as any)(hdr, 0.16, 0.5, 1.0))
      hdr = T.vec4(hdr.rgb.add(glow.rgb), hdr.a)
    }

    let display: any
    if (f.traa) {
      const resolved: any = track((traa as any)(hdr, depth, scenePass.getTextureNode('velocity'), camera))
      display = T.renderOutput(resolved)
    } else {
      display = T.renderOutput(hdr)
    }

    display = addOutlines(display, f.hoverOutline)

    if (!f.traa) display = track((fxaa as any)(display))
    return display
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
    display = addOutlines(display, false)
    return track((fxaa as any)(display))
  }

  function rebuild(): void {
    dirty = false
    disposeGraph()
    features = wantedFeatures()
    featureSig = signature(features)
    const q = currentQuality(ctx)
    tailLength = 0
    if (degrade === 2) return
    try {
      const node = degrade === 0 ? buildGraph(features) : buildMinimalGraph()
      const p = new RenderPipeline(renderer)
      p.outputColorTransform = false
      p.outputNode = node
      p.needsUpdate = true
      pipeline = p
      tailLength = degrade === 0 && features.traa ? q.temporalTail : 0
    } catch (err) {
      console.warn(`[post] pipeline build failed (level ${degrade})`, err)
      disposeGraph()
      degrade = (degrade < 2 ? degrade + 1 : 2) as DegradeLevel
      rebuild()
    }
    kicked = true
  }

  function cameraMoved(): boolean {
    const a = camera.matrixWorld.elements
    const b = camera.projectionMatrix.elements
    let moved = false
    for (let i = 0; i < 16; i++) {
      if (lastCamera[i] !== a[i]) {
        lastCamera[i] = a[i]
        moved = true
      }
      if (lastCamera[16 + i] !== b[i]) {
        lastCamera[16 + i] = b[i]
        moved = true
      }
    }
    return moved
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
    const moved = cameraMoved()
    draw()
    // temporal effects need a few more frames after the last change
    if (tailLength > 0) {
      if (moved || kicked || (tailRemaining === 0 && !selfInvalidated)) tailRemaining = tailLength
      kicked = false
      selfInvalidated = false
      if (tailRemaining > 0) {
        tailRemaining--
        selfInvalidated = true
        ctx.invalidate()
      }
    } else {
      kicked = false
      selfInvalidated = false
      tailRemaining = 0
    }
  }

  const internals: PostInternals = {
    renderToTarget(target, width, height) {
      if (disposed) return
      if (dirty) rebuild()
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
          const frames = tailLength > 0 ? Math.min(Math.max(tailLength, 8), 24) : 2
          for (let i = 0; i < frames; i++) draw()
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
        kicked = true
        ctx.invalidate()
      }
    },
    kick() {
      kicked = true
    },
  }
  shared.post = internals

  let lastRender = docStore.getState().doc.render
  const unsubDoc = docStore.subscribe((state) => {
    const r = state.doc.render
    if (r === lastRender) return
    const flagsChanged = r.ao !== lastRender.ao || r.ssgi !== lastRender.ssgi || r.ssr !== lastRender.ssr || r.bloom !== lastRender.bloom
    lastRender = r
    kicked = true
    if (flagsChanged) dirty = true
    ctx.invalidate()
  })
  const unsubScene = ctx.onSceneChanged(() => {
    kicked = true
  })

  return {
    render,
    setSize(_w: number, _h: number, _dpr: number) {
      // render targets follow the renderer's drawing buffer; only the accumulation restarts
      kicked = true
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
      if (changed) {
        kicked = true
        ctx.invalidate()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubDoc()
      unsubScene()
      disposeGraph()
      selectedObjects.length = 0
      hoveredObjects.length = 0
      if (shared.post === internals) shared.post = null
    },
  }
}
