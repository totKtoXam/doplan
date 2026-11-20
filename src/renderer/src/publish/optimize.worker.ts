/**
 * The publish optimizer in a worker: simplifying and compressing the models (meshopt) and fitting
 * and re-encoding the textures (WebP) take seconds of CPU that would otherwise freeze the editor.
 * The worker also runs outside the page's content security policy, which forbids the `new Function`
 * a dependency of the model tools uses.
 *
 * Messages in:  { type: 'run', content } — one at a time; { type: 'read', id, data | error } — a
 *               source file the page read for it (doplan-asset:// URLs are the page's to fetch).
 * Messages out: { type: 'read', id, file }, { type: 'progress', done, total },
 *               { type: 'done', content, report } or { type: 'error', message }.
 */
import type { SiteContent, SiteFile } from '@shared/pagesSite'
import { browserCodec } from './browserCodec'
import { optimizeSite } from './optimize'

/** results by source, kept while the worker lives (the session): a republish after a small edit is quick */
const cache = new Map<string, Promise<Uint8Array | null>>()
const reads = new Map<number, { resolve(d: Uint8Array): void; reject(e: Error): void }>()
let nextRead = 0

const post = (msg: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer)

function read(f: SiteFile): Promise<Uint8Array> {
  const id = nextRead++
  return new Promise((resolve, reject) => {
    reads.set(id, { resolve, reject })
    post({ type: 'read', id, file: { host: f.host, rel: f.rel, path: f.path } })
  })
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data
  if (msg?.type === 'read') {
    const r = reads.get(msg.id)
    reads.delete(msg.id)
    if (!r) return
    if (msg.data) r.resolve(msg.data as Uint8Array)
    else r.reject(new Error(String(msg.error ?? 'read failed')))
    return
  }
  if (msg?.type !== 'run') return
  try {
    const { content, report } = await optimizeSite(msg.content as SiteContent, {
      read,
      codec: browserCodec,
      cache,
      onProgress: (done, total) => post({ type: 'progress', done, total }),
    })
    // the cache keeps the results: copies go out, and those are moved rather than cloned again
    const files = content.files.map((f) => (f.data ? { ...f, data: f.data.slice() } : f))
    const transfer = files.flatMap((f) => (f.data ? [f.data.buffer as ArrayBuffer] : []))
    post({ type: 'done', content: { ...content, files }, report }, transfer)
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
