/**
 * Stand-in for `ndarray-pixels` and `ndarray-lanczos` in the renderer build (see the alias in
 * electron.vite.config.ts). Both pull in `ndarray-ops`, which compiles its kernels with
 * `new Function` as soon as it loads; the app's CSP has no 'unsafe-eval', so loading them throws.
 * The publish optimizer never decodes pixels through gltf-transform (images go through our own
 * browser codec, and `prune` keeps solid-colour textures), so these are never called.
 */
const unavailable = (name: string) => (): never => {
  throw new Error(`${name} is not available in the app (no 'unsafe-eval')`)
}

export const getPixels = unavailable('ndarray-pixels getPixels')
export const savePixels = unavailable('ndarray-pixels savePixels')
export const lanczos2 = unavailable('ndarray-lanczos lanczos2')
export const lanczos3 = unavailable('ndarray-lanczos lanczos3')
