import { createReadStream, promises as fsp } from 'node:fs'
import { extname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { isInside, safeJoin } from './fsutil'
import { paths } from './paths'

export const APP_SCHEME = 'app'
export const ASSET_SCHEME = 'doplan-asset'
export const APP_ORIGIN = 'app://ui'

/** Must run before `app.ready`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true, corsEnabled: true },
    },
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.obj': 'model/obj',
  '.mtl': 'model/mtl',
  '.fbx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.ies': 'text/plain; charset=utf-8',
}

export function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range, If-None-Match, If-Modified-Since, Content-Type',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Type',
  'cross-origin-resource-policy': 'cross-origin',
}

type Range = { start: number; end: number }

/** Parses a single `bytes=` range. Returns 'invalid' for unsatisfiable ranges, null for none/multi. */
export function parseRange(header: string | null, size: number): Range | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, s, e] = m
  if (s === '' && e === '') return 'invalid'
  let start: number
  let end: number
  if (s === '') {
    const suffix = Number(e)
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(s)
    end = e === '' ? size - 1 : Math.min(Number(e), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
  return { start, end }
}

const realRoots = new Map<string, string>()
async function realRoot(root: string): Promise<string> {
  const cached = realRoots.get(root)
  if (cached) return cached
  let real: string
  try {
    real = await fsp.realpath(root)
  } catch {
    real = resolve(root)
  }
  realRoots.set(root, real)
  return real
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(status === 204 || status === 304 ? null : text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS_HEADERS, ...extra },
  })
}

/** Streams a file with ETag, single-range and HEAD support. `root` is the containment root. */
async function serveFile(
  req: Request,
  root: string,
  rel: string,
  cacheControl: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (req.method === 'OPTIONS') return plain(204, '')
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed')
  const candidate = safeJoin(root, rel)
  if (!candidate) return plain(403, 'Forbidden')
  let file: string
  let size: number
  let mtime: number
  try {
    file = await fsp.realpath(candidate)
    if (!isInside(await realRoot(root), file)) return plain(403, 'Forbidden')
    const st = await fsp.stat(file)
    if (!st.isFile()) return plain(404, 'Not found')
    size = st.size
    mtime = st.mtimeMs
  } catch {
    return plain(404, 'Not found')
  }
  const etag = `"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`
  const base: Record<string, string> = {
    'content-type': mimeOf(file),
    'accept-ranges': 'bytes',
    etag,
    'cache-control': cacheControl,
    ...CORS_HEADERS,
    ...extraHeaders,
  }
  const inm = req.headers.get('if-none-match')
  if (inm && inm === etag && !req.headers.get('range')) return new Response(null, { status: 304, headers: base })

  const range = parseRange(req.headers.get('range'), size)
  if (range === 'invalid') {
    return plain(416, 'Range not satisfiable', { 'content-range': `bytes */${size}` })
  }
  const status = range ? 206 : 200
  const headers: Record<string, string> = { ...base }
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
    headers['content-length'] = String(range.end - range.start + 1)
  } else {
    headers['content-length'] = String(size)
  }
  if (req.method === 'HEAD' || size === 0) return new Response(null, { status, headers })

  const stream = createReadStream(file, range ? { start: range.start, end: range.end } : undefined)
  const onAbort = () => stream.destroy()
  req.signal?.addEventListener('abort', onAbort, { once: true })
  stream.once('close', () => req.signal?.removeEventListener('abort', onAbort))
  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

function relPathOf(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
}

// ───────────── in-memory pages for print-to-PDF (app://print/<token>.html) ─────────────

const printPages = new Map<string, string>()
export function putPrintPage(token: string, html: string): string {
  printPages.set(token, html)
  return `${APP_SCHEME}://print/${token}.html`
}
export function dropPrintPage(token: string): void {
  printPages.delete(token)
}

const PRINT_CSP =
  "default-src 'none'; img-src data: blob: doplan-asset: app:; style-src 'unsafe-inline'; font-src data: doplan-asset: app:"

/** Must run after `app.ready`. */
export function registerProtocolHandlers(): void {
  protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url)
    if (url.host === 'print') {
      const token = url.pathname.replace(/^\/+/, '').replace(/\.html$/, '')
      const html = printPages.get(token)
      if (html == null) return plain(404, 'Not found')
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PRINT_CSP },
      })
    }
    if (url.host !== 'ui') return plain(404, 'Not found')
    let rel = relPathOf(url)
    if (rel == null) return plain(400, 'Bad request')
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'
    const isHtml = rel.endsWith('.html')
    const hashed = rel.startsWith('assets/')
    return serveFile(req, paths.rendererDir, rel, hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      .then((res) => {
        // SPA fallback: unknown extension-less routes → index.html
        if (res.status === 404 && !isHtml && !/\.[a-z0-9]+$/i.test(rel ?? '')) {
          return serveFile(req, paths.rendererDir, 'index.html', 'no-cache')
        }
        return res
      })
  })

  protocol.handle(ASSET_SCHEME, async (req) => {
    const url = new URL(req.url)
    const rel = relPathOf(url)
    if (rel == null) return plain(400, 'Bad request')
    switch (url.host) {
      case 'catalog':
        return serveFile(req, paths.catalogRoot, rel, 'public, max-age=31536000, immutable')
      case 'library':
        // library files can be replaced (thumbs) — callers add ?v= to bust; revalidate via ETag otherwise
        return serveFile(req, paths.library, rel, 'public, max-age=31536000')
      case 'project':
        // content-addressed (<sha256>.<ext>)
        return serveFile(req, paths.projectAssets, rel, 'public, max-age=31536000, immutable')
      default:
        return plain(404, 'Unknown host')
    }
  })
}
