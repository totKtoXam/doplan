/**
 * Asset feeds: where on-demand catalog entries (`remote: true` in catalog.json) are downloaded from.
 *
 * Like NuGet package sources: an ordered list, each feed can be switched off, and the first enabled feed
 * that has the entry wins. Two feeds are built in and cannot be removed or re-pointed:
 *  - `doplan`: doplan's own mirror (release assets of the doplan-assets repository): every entry as one
 *    zip, textures already re-encoded, no dependence on third-party sites;
 *  - `upstream`: each entry's original source as written in catalog.json (Poly Haven, ambientCG, Khronos,
 *    the Objaverse mirror of Sketchfab).
 * Users may add their own feeds: an https:// base URL or a local folder laid out like the doplan mirror
 * (`index.json` + `<entry id>.zip`, see docs/ASSET-FEEDS.md), e.g. an office share for offline machines.
 */

export interface AssetFeed {
  /** 'doplan' | 'upstream' for the built-in feeds, a generated id for user feeds */
  id: string
  name: string
  /** https:// base URL or absolute local folder of a doplan feed; null = the entry's original source (upstream) */
  url: string | null
  enabled: boolean
  /** built-in feeds can be switched off and reordered, not removed or edited */
  builtin?: boolean
}

/** doplan's own mirror: `index.json` and `<id>.zip` files attached to release `feed-1` of totKtoXam/doplan-assets */
export const DOPLAN_FEED_URL = 'https://github.com/totKtoXam/doplan-assets/releases/download/feed-1/'

export const DEFAULT_FEEDS: readonly AssetFeed[] = [
  { id: 'doplan', name: 'doplan', url: DOPLAN_FEED_URL, enabled: true, builtin: true },
  { id: 'upstream', name: 'Poly Haven, ambientCG, Khronos, Sketchfab', url: null, enabled: true, builtin: true },
]

export const MAX_FEEDS = 20

/** an absolute local folder: `C:\…`, `\\server\share\…` or `/…` */
export const isLocalFeedPath = (u: string): boolean => /^[a-zA-Z]:[\\/]/.test(u) || /^\\\\[^\\]/.test(u) || u.startsWith('/')

/** a usable user feed location (https:// URL or absolute local folder), normalised; null when refused */
export function cleanFeedUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const u = raw.trim()
  if (!u || u.length > 1000 || u.includes('\0')) return null
  if (isLocalFeedPath(u)) return u
  try {
    const p = new URL(u)
    if (p.protocol !== 'https:' || p.username || p.password) return null
    return p.href.endsWith('/') ? p.href : `${p.href}/`
  } catch {
    return null
  }
}

/**
 * Sanitises a stored or renderer-supplied feed list: keeps the order, both built-in feeds always present
 * (re-added at the end when missing, with their fixed name and URL), user feeds need a valid location,
 * ids are unique, at most MAX_FEEDS entries.
 */
export function sanitizeFeeds(raw: unknown): AssetFeed[] {
  const out: AssetFeed[] = []
  const seen = new Set<string>()
  const builtins = new Map(DEFAULT_FEEDS.map((f) => [f.id, f]))
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || typeof x !== 'object') continue
    const r = x as Partial<AssetFeed>
    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 64) : ''
    if (!id || seen.has(id)) continue
    const enabled = r.enabled !== false
    const def = builtins.get(id)
    if (def) {
      out.push({ ...def, enabled })
    } else {
      const url = cleanFeedUrl(r.url)
      if (!url) continue
      const name = (typeof r.name === 'string' ? r.name.trim() : '').slice(0, 80) || url
      out.push({ id, name, url, enabled })
    }
    seen.add(id)
    if (out.length >= MAX_FEEDS) break
  }
  for (const def of DEFAULT_FEEDS) if (!seen.has(def.id)) out.push({ ...def })
  return out
}
