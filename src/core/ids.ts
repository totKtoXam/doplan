import { nanoid } from 'nanoid'
import type { Id } from './types'

/**
 * Entity id prefixes:
 *  n node · w wall · o opening · r room · i item · l light · d dimension · t label (text) ·
 *  u underlay · c camera · m material · a asset · lv level
 */
export type IdPrefix = 'n' | 'w' | 'o' | 'r' | 'i' | 'l' | 'd' | 't' | 'u' | 'c' | 'm' | 'a' | 'lv' | 'pm'

/** `${prefix}_${nanoid(10)}` */
export function newId(prefix: IdPrefix): Id {
  return `${prefix}_${nanoid(10)}`
}

/** a document id (Doc.meta.id) */
export function newProjectId(): string {
  return nanoid(16)
}

export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/

/** Small deterministic string hash (FNV-1a, 32 bit) rendered in base36 — used for `auto_<hash>` room ids. */
export function hashString(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
