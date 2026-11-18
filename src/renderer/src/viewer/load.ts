/**
 * Loading a published plan: view-plan.json, view-catalog.json and view-site.json next to the viewer page.
 * Relative asset URLs (`./assets/…`) are resolved against the page so the renderer's loaders
 * (which treat bare paths as the bundled catalog) get absolute https URLs.
 */
import type { Catalog } from '@core/types'
import { mapStrings, SITE_FILES, SITE_URL_PREFIX, type SiteInfo } from '@shared/pagesSite'

export interface LoadedSite {
  doc: unknown
  catalog: Partial<Catalog>
  info: SiteInfo | null
}

/** `./assets/…` strings → absolute URLs against `base` (the page URL) */
export function resolveSiteUrls<T>(value: T, base: string): T {
  return mapStrings(value, (s) => (s.startsWith(SITE_URL_PREFIX) ? new URL(s, base).href : s))
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export async function loadSite(base: string, fetchFn: FetchLike = (u) => fetch(u, { cache: 'no-cache' })): Promise<LoadedSite> {
  const get = async (name: string, optional: boolean): Promise<unknown> => {
    const res = await fetchFn(new URL(name, base).href)
    if (!res.ok) {
      if (optional) return null
      throw new Error(`${name}: HTTP ${res.status}`)
    }
    return res.json()
  }
  const [doc, catalog, info] = await Promise.all([get(SITE_FILES.plan, false), get(SITE_FILES.catalog, true), get(SITE_FILES.site, true)])
  return {
    doc: resolveSiteUrls(doc, base),
    catalog: resolveSiteUrls((catalog as Partial<Catalog> | null) ?? {}, base),
    info: (info as SiteInfo | null) ?? null,
  }
}
