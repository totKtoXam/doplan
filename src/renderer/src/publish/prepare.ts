/**
 * What the publish dialog sends to main: the site content with lighter models and textures
 * (./optimize) and the preview picture (./preview). Sources are read the way the editor reads them,
 * through doplan-asset:// URLs.
 */
import type { SiteContent, SiteFile } from '@shared/pagesSite'
import { browserCodec } from './browserCodec'
import { type OptimizeReport, optimizeSite } from './optimize'
import { capturePreview, PREVIEW_PATH } from './preview'

/** results by source, kept for the session: publishing again after a small edit is quick */
const cache = new Map<string, Promise<Uint8Array | null>>()

export function assetUrlOf(f: Pick<SiteFile, 'host' | 'rel'>): string {
  return `doplan-asset://${f.host}/${f.rel.split('/').map(encodeURIComponent).join('/')}`
}

async function readSource(f: SiteFile): Promise<Uint8Array> {
  const res = await fetch(assetUrlOf(f))
  if (!res.ok) throw new Error(`${res.status} ${f.rel}`)
  return new Uint8Array(await res.arrayBuffer())
}

export interface PrepareSteps {
  optimize(done: number, total: number): void
  preview(): void
}

export async function prepareSite(content: SiteContent, steps: PrepareSteps): Promise<{ content: SiteContent; report: OptimizeReport | null }> {
  let out = content
  let report: OptimizeReport | null = null
  try {
    const r = await optimizeSite(content, { read: readSource, codec: browserCodec, cache, onProgress: steps.optimize })
    out = r.content
    report = r.report
  } catch (err) {
    // the site goes out with the files as they are
    console.warn('[doplan] publish: optimization skipped', err)
  }
  steps.preview()
  const preview = await capturePreview()
  if (preview) out = { ...out, files: [...out.files.filter((f) => f.path !== PREVIEW_PATH), { host: 'project', rel: 'preview.webp', path: PREVIEW_PATH, data: preview }] }
  if (report) console.info('[doplan] publish: models and textures', report)
  return { content: out, report }
}
