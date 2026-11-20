/**
 * The published bake's manifest (assets/bake/bake.json), read by the viewer. It comes from the
 * site, so it is checked field by field: a page outside assets/bake/ or a number that is not one
 * leaves the viewer on the live light. No three.js here: the viewer's first chunk imports it.
 */
import type { BakedLevel, BakedPage, BakeManifest, BakeVariant } from '@/contracts'

export const BAKE_DIR = 'assets/bake'
export const BAKE_MANIFEST = `${BAKE_DIR}/bake.json`

/** a page of a level, as the manifest names it */
export function bakePagePath(levelId: string, variant: BakeVariant): string {
  return `${BAKE_DIR}/${levelId.replace(/[^\w-]/g, '_')}-${variant}.webp`
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

function pageOf(v: unknown): BakedPage | null {
  if (!isObj(v) || typeof v.file !== 'string' || !/^assets\/bake\/[\w-]{1,80}\.webp$/.test(v.file)) return null
  return num(v.scale, 1e-6, 1e6) ? { file: v.file, scale: v.scale } : null
}

function levelOf(v: unknown): BakedLevel | null {
  if (!isObj(v) || !isObj(v.layout)) return null
  const l = v.layout
  if (!num(l.density, 1, 200) || !num(l.maxSize, 64, 8192) || !num(l.minSize, 16, 8192) || !num(l.pad, 0, 16)) return null
  if (!str(v.layoutHash) || !str(v.geometry) || !str(v.lights) || !str(v.casters)) return null
  const closed = pageOf(v.closed)
  const open = pageOf(v.open)
  if (!closed || !open) return null
  return {
    closed,
    open,
    layout: { density: l.density, maxSize: l.maxSize, minSize: l.minSize, pad: l.pad },
    layoutHash: v.layoutHash,
    geometry: v.geometry,
    lights: v.lights,
    casters: v.casters,
  }
}

export function parseBakeManifest(json: unknown): BakeManifest | null {
  if (!isObj(json) || json.version !== 1 || !isObj(json.levels)) return null
  const levels: Record<string, BakedLevel> = Object.create(null)
  for (const id of Object.keys(json.levels)) {
    if (!/^[\w-]{1,64}$/.test(id)) continue
    const level = levelOf(json.levels[id])
    if (level) levels[id] = level
  }
  return Object.keys(levels).length ? { version: 1, levels } : null
}
