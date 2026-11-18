import { describe, expect, it } from 'vitest'
import { loadSite, resolveSiteUrls } from './load'

const base = 'https://me.github.io/flat/?cam=walk'

describe('viewer site loading', () => {
  it('resolves ./assets/ strings against the page, leaves the rest', () => {
    const v = resolveSiteUrls({ a: './assets/c/x%20y.glb', b: ['./assets/p/u.png', 'oak', 'https://x.org/a.hdr'] }, base)
    expect(v).toEqual({ a: 'https://me.github.io/flat/assets/c/x%20y.glb', b: ['https://me.github.io/flat/assets/p/u.png', 'oak', 'https://x.org/a.hdr'] })
  })

  it('loads plan.json (required) and the optional catalog.json / site.json', async () => {
    const files: Record<string, unknown> = {
      'https://me.github.io/flat/plan.json': { meta: { name: 'P' }, underlay: './assets/p/u.png' },
      'https://me.github.io/flat/site.json': { title: 'P', publishedAt: 'x', contentHash: 'h', app: 'a' },
    }
    const fetchFn = async (url: string) => ({ ok: url in files, status: url in files ? 200 : 404, json: async () => files[url] })
    const site = await loadSite(base, fetchFn)
    expect((site.doc as { underlay: string }).underlay).toBe('https://me.github.io/flat/assets/p/u.png')
    expect(site.catalog).toEqual({})
    expect(site.info?.title).toBe('P')

    delete files['https://me.github.io/flat/plan.json']
    await expect(loadSite(base, fetchFn)).rejects.toThrow(/plan\.json: HTTP 404/)
  })
})
