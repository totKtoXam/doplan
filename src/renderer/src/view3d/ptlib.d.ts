// Internal modules of three-gpu-pathtracer used by the denoiser (shipped as plain JS, no typings).
declare module 'three-gpu-pathtracer/src/webgpu/compute/ComputeKernel.js' {
  export class ComputeKernel {
    constructor(fn: unknown, options?: { workgroupSize?: number[]; context?: object })
    readonly kernel: any
    defineUniformAccessors(parameters: Record<string, unknown>): void
    setWorkgroupSize(x?: number, y?: number, z?: number): this
    getDispatchSize(tx?: number, ty?: number, tz?: number, target?: number[]): number[]
    dispose(): void
  }
}
declare module 'three-gpu-pathtracer/src/webgpu/compute/targets.js' {
  import type { StorageTexture, StorageArrayTexture } from 'three/webgpu'
  export function createOutputTarget(name?: string): StorageTexture
  export function createAuxTarget(name?: string): StorageArrayTexture
  export function createAuxImageTarget(name?: string): StorageTexture
}
declare module 'three-gpu-pathtracer/src/webgpu/nodes/aux.wgsl.js' {
  export const unpackAuxAlbedoFn: any
  export const unpackAuxNormalFn: any
  export const AUX_LAYERS: number
}

declare module 'three/addons/libs/potpack.module.js' {
  export function potpack(boxes: { w: number; h: number; x?: number; y?: number }[]): { w: number; h: number; fill: number }
}
