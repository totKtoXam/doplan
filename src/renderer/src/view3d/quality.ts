/**
 * Quality presets of the 3D viewport (area: 3d-rendering) + the small per-engine registry
 * the rendering sub-modules (lighting / post / controls / interaction) use to
 * talk to each other without widening the public contracts.
 *
 * Target hardware is an Intel Arc class integrated GPU: `low` and `medium` must stay
 * interactive there, `high` is for an idle iGPU or a discrete card, `ultra` is discrete only.
 */
import type * as THREE from 'three'
import type { QualityPreset } from '@core/types'
import type { EngineContext } from '@/contracts'
import type { BakeLights } from './bake/trace'

export type ShadowKind = 'basic' | 'pcf' | 'vsm'
export type AntiAliasing = 'fxaa' | 'traa'

export interface QualitySettings {
  preset: QualityPreset
  /** upper bound of the device pixel ratio while the camera rests */
  dprCap: number
  /** upper bound of the device pixel ratio while the camera moves (adaptive DPR) */
  dprMoving: number
  /** sun shadow map edge, px */
  shadowMapSize: number
  shadowType: ShadowKind
  /** PCF blur radius of the sun shadow */
  shadowRadius: number
  sunShadows: boolean
  /** how many fixtures (doc.lights) may cast shadows at once */
  maxShadowLights: number
  fixtureShadowMapSize: number
  /** how many doc lights are turned into real three lights (brightest first) */
  maxLights: number
  /** how many window "sky portal" area lights are created (largest windows first) */
  maxPortals: number
  /** ground-truth ambient occlusion */
  ao: boolean
  aoResolutionScale: number
  aoSamples: number
  /** spatial denoise of the AO buffer when no temporal AA is available */
  aoDenoise: boolean
  /** screen-space global illumination (WebGPU backend only) */
  ssgi: boolean
  ssgiSlices: number
  ssgiSteps: number
  /** screen-space reflections (WebGPU backend only) */
  ssr: boolean
  ssrQuality: number
  ssrResolutionScale: number
  bloom: boolean
  antialias: AntiAliasing
  /** extra hover outline (the selection outline is always on) */
  hoverOutline: boolean
  /** extra frames rendered after the last change so temporal effects converge */
  temporalTail: number
  /** anisotropic filtering for surface textures (MaterialLibrary reads this) */
  anisotropy: number
  /** longest texture edge the material library should upload, px */
  maxTextureSize: number
  /** equirect width of the procedural sky, px */
  skyWidth: number
}

export const QUALITY_PRESETS: Record<QualityPreset, QualitySettings> = {
  low: {
    preset: 'low',
    dprCap: 1,
    dprMoving: 0.75,
    shadowMapSize: 1024,
    shadowType: 'pcf',
    shadowRadius: 1.5,
    sunShadows: true,
    maxShadowLights: 0,
    fixtureShadowMapSize: 512,
    maxLights: 8,
    maxPortals: 3,
    ao: false,
    aoResolutionScale: 0.5,
    aoSamples: 8,
    aoDenoise: false,
    ssgi: false,
    ssgiSlices: 1,
    ssgiSteps: 8,
    ssr: false,
    ssrQuality: 0.3,
    ssrResolutionScale: 0.5,
    bloom: false,
    antialias: 'fxaa',
    hoverOutline: false,
    temporalTail: 0,
    anisotropy: 2,
    maxTextureSize: 1024,
    skyWidth: 512,
  },
  medium: {
    preset: 'medium',
    dprCap: 1.25,
    dprMoving: 0.85,
    shadowMapSize: 2048,
    shadowType: 'pcf',
    shadowRadius: 2,
    sunShadows: true,
    maxShadowLights: 1,
    fixtureShadowMapSize: 512,
    maxLights: 16,
    maxPortals: 6,
    ao: true,
    aoResolutionScale: 0.5,
    aoSamples: 12,
    aoDenoise: true,
    ssgi: false,
    ssgiSlices: 1,
    ssgiSteps: 8,
    ssr: false,
    ssrQuality: 0.4,
    ssrResolutionScale: 0.5,
    bloom: true,
    antialias: 'fxaa',
    hoverOutline: true,
    temporalTail: 0,
    anisotropy: 4,
    maxTextureSize: 2048,
    skyWidth: 768,
  },
  high: {
    preset: 'high',
    dprCap: 1.5,
    dprMoving: 1,
    shadowMapSize: 4096,
    shadowType: 'pcf',
    shadowRadius: 2.5,
    sunShadows: true,
    maxShadowLights: 3,
    fixtureShadowMapSize: 1024,
    maxLights: 32,
    maxPortals: 12,
    ao: true,
    aoResolutionScale: 1,
    aoSamples: 16,
    aoDenoise: false,
    ssgi: true,
    ssgiSlices: 2,
    ssgiSteps: 8,
    ssr: true,
    ssrQuality: 0.5,
    ssrResolutionScale: 0.5,
    bloom: true,
    antialias: 'traa',
    hoverOutline: true,
    temporalTail: 20,
    anisotropy: 8,
    maxTextureSize: 2048,
    skyWidth: 1024,
  },
  ultra: {
    preset: 'ultra',
    dprCap: 2,
    dprMoving: 1.25,
    shadowMapSize: 4096,
    shadowType: 'pcf',
    shadowRadius: 3,
    sunShadows: true,
    maxShadowLights: 6,
    fixtureShadowMapSize: 1024,
    maxLights: 64,
    maxPortals: 24,
    ao: true,
    aoResolutionScale: 1,
    aoSamples: 24,
    aoDenoise: false,
    ssgi: true,
    ssgiSlices: 3,
    ssgiSteps: 12,
    ssr: true,
    ssrQuality: 0.7,
    ssrResolutionScale: 1,
    bloom: true,
    antialias: 'traa',
    hoverOutline: true,
    temporalTail: 28,
    anisotropy: 16,
    maxTextureSize: 4096,
    skyWidth: 1024,
  },
}

export const QUALITY_ORDER: QualityPreset[] = ['low', 'medium', 'high', 'ultra']

export function getQuality(preset: QualityPreset | undefined | null): QualitySettings {
  return QUALITY_PRESETS[preset ?? 'medium'] ?? QUALITY_PRESETS.medium
}

/** Pixel ratio the engine should hand to `renderer.setPixelRatio()` for a preset. */
export function effectiveDpr(preset: QualityPreset, deviceDpr: number, moving = false): number {
  const q = getQuality(preset)
  const cap = moving ? q.dprMoving : q.dprCap
  return Math.max(0.5, Math.min(deviceDpr || 1, cap))
}

/**
 * How a page that only shows the scene (the published viewer) trades sharpness for speed: at rest
 * the device's own pixel ratio up to `restMax`, while moving not below `movingMin` until the frame
 * rate stays low. Applies to `high` and `ultra`; the app keeps the presets' iGPU budget (null).
 */
export interface DprPolicy {
  restMax: number
  movingMin: number
}

let dprPolicy: DprPolicy | null = null

export function setDprPolicy(p: DprPolicy | null): void {
  dprPolicy = p
}

/**
 * Pixel ratio of one frame. `dynScale` (≤ 1) is the engine's adaptive factor: it drops only while
 * frames take longer than ~25 ms; the policy's floor gives way after it dropped twice. `floor` lets
 * the engine keep the floor off until the factor is back to 1 (hysteresis: no sharp/soft swings).
 */
export function frameDpr(
  preset: QualityPreset,
  deviceDpr: number,
  moving: boolean,
  dynScale = 1,
  policy: DprPolicy | null = dprPolicy,
  floor = dynScale > 0.8,
): number {
  const q = getQuality(preset)
  const sharp = !!policy && (q.preset === 'high' || q.preset === 'ultra')
  const rest = sharp ? Math.max(q.dprCap, policy.restMax) : q.dprCap
  let cap = moving ? Math.min(rest, q.dprMoving * dynScale) : rest
  if (moving && sharp && floor) cap = Math.max(cap, Math.min(rest, policy.movingMin))
  return Math.max(0.5, Math.min(deviceDpr || 1, cap))
}

/** True when the renderer runs on the real WebGPU backend (not the WebGL2 fallback). */
export function isWebGPU(renderer: any): boolean {
  return !!renderer && !!renderer.backend && renderer.backend.isWebGPUBackend === true
}

// ───────────────────────── shared per-engine state (module internal) ─────────────────────────

/** Extra entry points of the post pipeline used by `renderStill('realtime')`. */
export interface PostInternals {
  /**
   * Renders the current pipeline at `width`×`height` into `target` (tone mapped, sRGB encoded).
   * Synchronous: the drawing buffer and camera aspect are restored before it returns.
   */
  renderToTarget(target: THREE.RenderTarget, width: number, height: number): void
  /** restart temporal accumulation + keep rendering the convergence tail */
  kick(): void
}

/** Extra entry points of the camera controls used by interaction and stills. */
export interface ControlsInternals {
  enabled: boolean
  readonly mode: 'orbit' | 'walk' | 'top'
}

export interface LightingChange {
  /** objects were added/removed (the path tracer must rebuild its scene) */
  structure: boolean
}

export interface RenderShared {
  post: PostInternals | null
  controls: ControlsInternals | null
  /** preset pushed through `PostPipeline.setQuality()`; falls back to `ctx.quality` */
  quality: QualityPreset | null
  /** true while a still is being rendered: interaction and controls stay passive */
  stillBusy: boolean
  /**
   * The walls, floors and ceilings show a baked light map (they ignore the live lights then); the
   * screen-space occlusion and indirect light are off, they are in the map. The furniture keeps the
   * live light with its shadows: the walls and ceilings still block the sun and the lamps for it.
   */
  baked: boolean
  onBakedChanged(cb: (on: boolean) => void): () => void
  setBaked(on: boolean): void
  /**
   * set by the lighting rig: every light of the shown level for a bake, as the live view has them,
   * once the HDRI is loaded; null when the HDRI could not be had
   */
  bakeLights: (() => Promise<BakeLights | null>) | null
  onLightingChanged(cb: (c: LightingChange) => void): () => void
  emitLightingChanged(c: LightingChange): void
  onQualityChanged(cb: (q: QualityPreset) => void): () => void
  setQuality(q: QualityPreset): void
}

const registry = new WeakMap<object, RenderShared>()

function emitter<T>(): { on(cb: (v: T) => void): () => void; emit(v: T): void } {
  const set = new Set<(v: T) => void>()
  return {
    on(cb) {
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },
    emit(v) {
      for (const cb of Array.from(set)) {
        try {
          cb(v)
        } catch (err) {
          console.error('[view3d] listener failed', err)
        }
      }
    },
  }
}

/** Per-engine blackboard. Keyed by the EngineContext object, garbage collected with it. */
export function getShared(ctx: EngineContext): RenderShared {
  let s = registry.get(ctx)
  if (s) return s
  const lighting = emitter<LightingChange>()
  const quality = emitter<QualityPreset>()
  const baked = emitter<boolean>()
  const shared: RenderShared = {
    post: null,
    controls: null,
    quality: null,
    stillBusy: false,
    baked: false,
    onBakedChanged: baked.on,
    setBaked(on) {
      if (shared.baked === on) return
      shared.baked = on
      baked.emit(on)
    },
    bakeLights: null,
    onLightingChanged: lighting.on,
    emitLightingChanged: lighting.emit,
    onQualityChanged: quality.on,
    setQuality(q) {
      if (shared.quality === q) return
      shared.quality = q
      quality.emit(q)
    },
  }
  s = shared
  registry.set(ctx, s)
  return s
}

/** Preset currently in force for an engine. */
export function currentQuality(ctx: EngineContext): QualitySettings {
  return getQuality(getShared(ctx).quality ?? ctx.quality)
}
