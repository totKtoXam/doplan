// three ships its copy of potpack as plain JS, without typings
declare module 'three/addons/libs/potpack.module.js' {
  export function potpack(boxes: { w: number; h: number; x?: number; y?: number }[]): { w: number; h: number; fill: number }
}
