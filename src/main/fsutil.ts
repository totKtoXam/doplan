import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** rename with retries: Windows antivirus / indexers often hold files briefly (EBUSY/EPERM/EACCES). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 30
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 8 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw err
      await sleep(delay)
      delay = Math.min(delay * 2, 1000)
    }
  }
}

/** Atomic write: tmp file in the same directory → fsync → rename over the target. */
export async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  const fh = await fsp.open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await renameWithRetry(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    let text = await fsp.readFile(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * Joins a relative, slash-separated path under `root`, rejecting absolute paths, drive letters,
 * `..` segments and NUL bytes. Returns null when the result would escape `root`.
 */
export function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return null
  const parts = cleaned.split('/')
  if (parts.some((p) => p === '..')) return null
  const full = resolve(root, normalize(cleaned))
  const r = relative(resolve(root), full)
  if (!r || r.startsWith('..') || isAbsolute(r)) return null
  return full
}

/** true if `child` is `root` itself or inside it (both absolute, already resolved) */
export function isInside(root: string, child: string): boolean {
  const r = relative(root, child)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

export function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

/** Accepts whatever structured clone produced for an ArrayBuffer argument. */
export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) return new Uint8Array(data)
  throw new Error('Ожидались двоичные данные (ArrayBuffer)')
}

/** sanitise a file extension: lowercase alphanumerics, max 8 chars */
export function cleanExt(ext: string, fallback = 'bin'): string {
  const e = String(ext ?? '')
    .replace(/^\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
  return e || fallback
}

/** file name safe for Windows */
export function cleanFileName(name: string, fallback = 'doplan'): string {
  const n = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120)
  return n || fallback
}

export async function rmrf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}


export type EntryKind = 'file' | 'dir' | 'link' | 'other'

/**
 * What a directory entry is, never following it, or null when it is gone. A Dirent that is plainly a
 * file or folder is taken as it is; anything else is asked of lstat: on Windows readdir reports every
 * reparse point as a link, cloud placeholders (OneDrive, Dropbox Files On-Demand) too, while lstat
 * reports only symlinks and junctions as links (and a placeholder as the file or folder it is).
 */
export async function entryKind(path: string, e: { isFile(): boolean; isDirectory(): boolean }): Promise<EntryKind | null> {
  if (e.isFile()) return 'file'
  if (e.isDirectory()) return 'dir'
  let st
  try {
    st = await fsp.lstat(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
  return st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
}
