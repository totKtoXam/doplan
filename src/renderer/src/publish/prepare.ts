/**
 * What the publish dialog sends to main: the site content with lighter models and textures
 * (./optimize) and the preview picture (./preview). Sources are read the way the editor reads them,
 * through doplan-asset:// URLs.
 */
import type { SiteContent, SiteFile } from '@shared/pagesSite'
import { BAKE_DIR } from '@/view3d/bake/manifest'
import { captureBake } from './bake'
import type { OptimizeReport } from './optimize'
import { capturePreview, PREVIEW_PATH } from './preview'

/** the optimizer's worker, kept for the session: it caches its results (a quick republish) */
let worker: Worker | null = null
/** the optimizer and its results are kept this long after a publish (a quick republish), then let go */
export const OPTIMIZER_IDLE_MS = 5 * 60_000
let idleTimer: ReturnType<typeof setTimeout> | undefined

export function assetUrlOf(f: Pick<SiteFile, 'host' | 'rel'>): string {
  return `doplan-asset://${f.host}/${f.rel.split('/').map(encodeURIComponent).join('/')}`
}

async function readSource(f: SiteFile): Promise<Uint8Array> {
  const res = await fetch(assetUrlOf(f))
  if (!res.ok) throw new Error(`${res.status} ${f.rel}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** lighter models and textures, worked out in ./optimize.worker so the editor stays responsive */
function optimizeInWorker(content: SiteContent, onProgress: (done: number, total: number) => void): Promise<{ content: SiteContent; report: OptimizeReport }> {
  clearTimeout(idleTimer)
  if (!worker) worker = new Worker(new URL('./optimize.worker.ts', import.meta.url), { type: 'module' })
  const w = worker
  const idle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (worker !== w) return
      w.terminate()
      worker = null
    }, OPTIMIZER_IDLE_MS)
  }
  return new Promise((resolve, reject) => {
    const fail = (err: Error): void => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
      // a worker that failed may hold a half-done state: the next publish starts a new one
      w.terminate()
      if (worker === w) worker = null
      reject(err)
    }
    const onError = (ev: ErrorEvent): void => fail(new Error(ev.message || 'optimizer worker failed'))
    const onMessage = (ev: MessageEvent): void => {
      const msg = ev.data
      if (msg?.type === 'read') {
        readSource(msg.file as SiteFile).then(
          (data) => w.postMessage({ type: 'read', id: msg.id, data }, [data.buffer]),
          (err: unknown) => w.postMessage({ type: 'read', id: msg.id, error: err instanceof Error ? err.message : String(err) }),
        )
      } else if (msg?.type === 'progress') onProgress(msg.done, msg.total)
      else if (msg?.type === 'done') {
        w.removeEventListener('message', onMessage)
        w.removeEventListener('error', onError)
        idle()
        resolve({ content: msg.content as SiteContent, report: msg.report as OptimizeReport })
      } else if (msg?.type === 'error') fail(new Error(String(msg.message)))
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    w.postMessage({ type: 'run', content })
  })
}

export interface PrepareSteps {
  optimize(done: number, total: number): void
  preview(): void
  /** baking the light, 0…1 */
  bake(part: number): void
}

export interface PrepareOptions {
  /** bake the light of the walls, floors and ceilings */
  bake: boolean
}

export async function prepareSite(content: SiteContent, steps: PrepareSteps, opts: PrepareOptions = { bake: false }): Promise<{ content: SiteContent; report: OptimizeReport | null }> {
  let out = content
  let report: OptimizeReport | null = null
  try {
    const r = await optimizeInWorker(content, steps.optimize)
    out = r.content
    report = r.report
  } catch (err) {
    // the site goes out with the files as they are
    console.warn('[doplan] publish: optimization skipped', err)
  }
  steps.preview()
  const preview = await capturePreview()
  if (preview) out = { ...out, files: [...out.files.filter((f) => f.path !== PREVIEW_PATH), { host: 'project', rel: 'preview.webp', path: PREVIEW_PATH, data: preview }] }
  out = { ...out, files: out.files.filter((f) => !f.path.startsWith(`${BAKE_DIR}/`)) }
  if (opts.bake) {
    steps.bake(0)
    const baked = await captureBake(steps.bake)
    if (baked) out = { ...out, files: [...out.files, ...baked.files.map((f) => ({ host: 'project' as const, rel: f.path.slice('assets/'.length), path: f.path, data: f.data }))] }
  }
  if (report) console.info('[doplan] publish: models and textures', report)
  return { content: out, report }
}
