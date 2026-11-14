/**
 * Path tracing denoiser (area: 3d-rendering): an edge-aware à-trous wavelet filter on the GPU.
 *
 * The tracer accumulates the first-hit albedo and normal next to the colour once a denoiser with
 * `useAuxiliaryBuffers` is attached (packed in an r32uint array texture, see the library's
 * `nodes/aux.wgsl.js`). The filter:
 *  1. demodulates the colour by the albedo (textures stay sharp, only the lighting is filtered)
 *  2. runs five 5×5 B3-spline passes with growing steps (1, 2, 4, 8, 16); every tap is weighted by
 *     the normal and albedo similarity and by the luminance difference, whose tolerance shrinks
 *     with 1/√spp, so the filter fades by itself as the image converges
 *  3. multiplies the albedo back and mixes with the raw image by `amount`
 *
 * The library only calls `denoiser.update()` once the render has finished; it presents
 * `denoiser.texture` (when not null) in place of the raw image on every frame though. So this
 * object reports itself as `complete` and the path tracer module runs `run()` itself, throttled,
 * while the image accumulates. The result is a StorageTexture laid out like the tracer's output,
 * so the library's blit (y flip included) draws it unchanged.
 *
 * Loaded lazily together with the path tracer.
 */
import * as THREE from 'three'
import { StorageTexture } from 'three/webgpu'
import { globalId, textureStore, uniform } from 'three/tsl'
import * as BVHGPU from 'three-mesh-bvh/webgpu'
import { ComputeKernel } from 'three-gpu-pathtracer/src/webgpu/compute/ComputeKernel.js'
import { createAuxTarget, createOutputTarget } from 'three-gpu-pathtracer/src/webgpu/compute/targets.js'
import { unpackAuxAlbedoFn, unpackAuxNormalFn } from 'three-gpu-pathtracer/src/webgpu/nodes/aux.wgsl.js'

// exported at runtime (the path tracer's kernels use it) but missing from the typings
const wgslTagFn = (BVHGPU as unknown as { wgslTagFn: (s: TemplateStringsArray, ...v: unknown[]) => any }).wgslTagFn

/** the luminance tolerance at 1 spp, relative to the pixel's luminance */
const SIGMA_LUMA = 4
const STEPS = [1, 2, 4, 8, 16]
/** albedo floor of the demodulation (black surfaces would divide by zero) */
const ALBEDO_FLOOR = 0.02

function createImage(name: string): StorageTexture {
  const t = new StorageTexture(1, 1)
  t.format = THREE.RGBAFormat
  t.type = THREE.HalfFloatType
  t.name = name
  t.generateMipmaps = false
  return t
}

/** colour / albedo → irradiance */
class DemodulateKernel extends ComputeKernel {
  declare color: THREE.Texture
  declare aux: THREE.Texture
  declare target: THREE.Texture
  constructor() {
    const params = {
      color: textureStore(createOutputTarget()).toReadOnly(),
      aux: textureStore(createAuxTarget()).toReadOnly(),
      target: textureStore(createImage('')).toWriteOnly(),
      globalId,
    }
    const fn = wgslTagFn/* wgsl */ `
      fn compute( globalId: vec3u ) -> void {
        let dims = textureDimensions( ${params.color} );
        if ( globalId.x >= dims.x || globalId.y >= dims.y ) {
          return;
        }
        let p = globalId.xy;
        let packed = vec3u( textureLoad( ${params.aux}, p, 0 ).r, textureLoad( ${params.aux}, p, 1 ).r, textureLoad( ${params.aux}, p, 2 ).r );
        let albedo = max( ${unpackAuxAlbedoFn}( packed ), vec3f( ${ALBEDO_FLOOR} ) );
        let c = textureLoad( ${params.color}, p );
        textureStore( ${params.target}, p, vec4f( c.rgb / albedo, c.a ) );
      }
    `
    super(fn(params))
    this.defineUniformAccessors(params)
  }
}

/** one à-trous pass; the last one re-modulates and mixes with the raw image */
class AtrousKernel extends ComputeKernel {
  declare source: THREE.Texture
  declare color: THREE.Texture
  declare aux: THREE.Texture
  declare target: THREE.Texture
  declare stepSize: number
  declare sigma: number
  declare last: number
  declare amount: number
  constructor() {
    const params = {
      source: textureStore(createImage('')).toReadOnly(),
      color: textureStore(createOutputTarget()).toReadOnly(),
      aux: textureStore(createAuxTarget()).toReadOnly(),
      target: textureStore(createImage('')).toWriteOnly(),
      stepSize: uniform(1, 'int'),
      sigma: uniform(1),
      last: uniform(0, 'uint'),
      amount: uniform(1),
      globalId,
    }
    const fn = wgslTagFn/* wgsl */ `
      fn compute( stepSize: i32, sigma: f32, last: u32, amount: f32, globalId: vec3u ) -> void {
        let dims = vec2i( textureDimensions( ${params.source} ) );
        let p = vec2i( globalId.xy );
        if ( p.x >= dims.x || p.y >= dims.y ) {
          return;
        }
        let lumW = vec3f( 0.2126, 0.7152, 0.0722 );

        let packedP = vec3u( textureLoad( ${params.aux}, p, 0 ).r, textureLoad( ${params.aux}, p, 1 ).r, textureLoad( ${params.aux}, p, 2 ).r );
        let albP = ${unpackAuxAlbedoFn}( packedP );
        let nRawP = ${unpackAuxNormalFn}( packedP ) * 2.0 - 1.0;
        let lenP = length( nRawP );
        let nP = nRawP / max( lenP, 1e-4 );
        let cP = textureLoad( ${params.source}, p );
        let lumP = dot( cP.rgb, lumW );
        let tol = sigma * ( lumP + 0.02 ) + 1e-4;

        var sum = vec3f( 0.0 );
        var wsum = 0.0;
        for ( var dy = -2; dy <= 2; dy ++ ) {
          for ( var dx = -2; dx <= 2; dx ++ ) {
            let q = clamp( p + vec2i( dx, dy ) * stepSize, vec2i( 0 ), dims - vec2i( 1 ) );
            let packedQ = vec3u( textureLoad( ${params.aux}, q, 0 ).r, textureLoad( ${params.aux}, q, 1 ).r, textureLoad( ${params.aux}, q, 2 ).r );
            let albQ = ${unpackAuxAlbedoFn}( packedQ );
            let nRawQ = ${unpackAuxNormalFn}( packedQ ) * 2.0 - 1.0;
            let lenQ = length( nRawQ );
            let cQ = textureLoad( ${params.source}, q ).rgb;

            let ax = abs( dx );
            let ay = abs( dy );
            let hx = select( select( 0.0625, 0.25, ax == 1 ), 0.375, ax == 0 );
            let hy = select( select( 0.0625, 0.25, ay == 1 ), 0.375, ay == 0 );

            // background (no hit) only mixes with background
            var wn = 1.0;
            let hitP = lenP > 0.3;
            let hitQ = lenQ > 0.3;
            if ( hitP && hitQ ) {
              wn = pow( max( dot( nP, nRawQ / lenQ ), 0.0 ), 64.0 );
            } else if ( hitP != hitQ ) {
              wn = 0.0;
            }
            let da = albP - albQ;
            let wa = exp( - dot( da, da ) * 40.0 );
            let wl = exp( - abs( lumP - dot( cQ, lumW ) ) / tol );
            let w = hx * hy * wn * wa * wl;
            sum += cQ * w;
            wsum += w;
          }
        }
        var outC = sum / max( wsum, 1e-6 );
        if ( last == 1u ) {
          let raw = textureLoad( ${params.color}, p );
          let albedo = max( albP, vec3f( ${ALBEDO_FLOOR} ) );
          textureStore( ${params.target}, p, vec4f( mix( raw.rgb, outC * albedo, amount ), raw.a ) );
        } else {
          textureStore( ${params.target}, p, vec4f( outC, cP.a ) );
        }
      }
    `
    super(fn(params))
    this.defineUniformAccessors(params)
  }
}

export class AtrousDenoiser extends THREE.EventDispatcher<{ progress: { progress: number } }> {
  /** asks the tracer to accumulate the albedo / normal images */
  readonly useAuxiliaryBuffers = true
  /** the library never calls `update()`: the path tracer module runs `run()` itself */
  readonly complete = true
  readonly running = false
  renderer: any = null
  private demod = new DemodulateKernel().setWorkgroupSize(8, 8, 1) as DemodulateKernel
  private atrous = new AtrousKernel().setWorkgroupSize(8, 8, 1) as AtrousKernel
  private ping = createImage('Denoiser A')
  private pong = createImage('Denoiser B')
  private out = createImage('Denoiser Out')
  private valid = false

  /** the filtered image (presented by the tracer), or null to show the raw one */
  get texture(): THREE.Texture | null {
    return this.valid ? this.out : null
  }

  init(renderer: unknown): void {
    this.renderer = renderer
  }

  /** never called while `complete`; part of the library's denoiser interface */
  update(): THREE.Texture | null {
    return this.texture
  }

  /** the image changed: show the raw one until the next `run()` */
  reset(): void {
    this.valid = false
  }

  /**
   * Filters the tracer's current image.
   * @param spp average samples per pixel of the image
   * @param amount 0 = raw … 1 = fully filtered
   */
  run(color: THREE.Texture, aux: THREE.Texture | null, spp: number, amount: number): void {
    const renderer = this.renderer
    if (!renderer || !aux || amount <= 0) {
      this.valid = false
      return
    }
    const { width, height } = color.image as { width: number; height: number }
    if (width < 2 || height < 2) return
    for (const t of [this.ping, this.pong, this.out]) {
      const img = t.image as { width: number; height: number }
      if (img.width !== width || img.height !== height) t.setSize(width, height, 1)
    }
    const { demod, atrous } = this
    const dispatch = demod.getDispatchSize(width, height)
    demod.color = color
    demod.aux = aux
    demod.target = this.ping
    renderer.compute(demod.kernel, dispatch)

    atrous.color = color
    atrous.aux = aux
    atrous.sigma = SIGMA_LUMA / Math.sqrt(Math.max(1, spp))
    atrous.amount = Math.min(1, amount)
    let src = this.ping
    let dst = this.pong
    STEPS.forEach((step, i) => {
      const last = i === STEPS.length - 1
      atrous.source = src
      atrous.target = last ? this.out : dst
      atrous.stepSize = step
      atrous.last = last ? 1 : 0
      renderer.compute(atrous.kernel, dispatch)
      ;[src, dst] = [dst, src]
    })
    this.valid = true
  }

  dispose(): void {
    this.valid = false
    this.demod.dispose()
    this.atrous.dispose()
    this.ping.dispose()
    this.pong.dispose()
    this.out.dispose()
  }
}
