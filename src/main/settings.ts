import { basename, isAbsolute, resolve } from 'node:path'
import { safeStorage } from 'electron'
import type { AppSettings, RecentProject } from '../shared/ipc'
import { atomicWrite, readJson } from './fsutil'
import { paths } from './paths'

interface TrustedFolder {
  /** resolved, lower-cased path */
  path: string
  /** identity of the folder (and its .git) on disk when it was recorded: a folder replaced at the same path differs */
  id: string
  /** the user trusts the folder itself (doplan created it or the user confirmed it): the AI agent may run in it.
   *  false: only the git repository is doplan's own (doplan ran git init in a folder that had none). */
  folder: boolean
}

interface StoredSettings {
  lang: AppSettings['lang']
  theme: AppSettings['theme']
  backend: AppSettings['backend']
  autosaveSec: number
  recent: RecentProject[]
  /** default parent folder for new projects; absent → Documents/doplan */
  projectsDir?: string
  /** project folders whose git repository doplan created or the user trusted, with the identity they had then */
  trustedFolders?: TrustedFolder[]
  /** base64 of safeStorage-encrypted API key */
  apiKeyEnc?: string
}

const DEFAULTS: StoredSettings = {
  lang: 'ru',
  theme: 'dark',
  backend: 'webgpu',
  autosaveSec: 30,
  recent: [],
}

const MAX_RECENT = 12

let cache: StoredSettings | null = null
/** key kept only in memory when OS encryption is unavailable */
let sessionKey: string | null = null
let writeChain: Promise<void> = Promise.resolve()
const listeners = new Set<(s: AppSettings) => void>()

function sanitize(raw: Partial<StoredSettings> | null | undefined): StoredSettings {
  const r = raw && typeof raw === 'object' ? raw : {}
  const recent = Array.isArray(r.recent)
    ? r.recent
        .filter((x): x is RecentProject => !!x && typeof x.path === 'string')
        .map((x) => ({
          path: x.path,
          name: typeof x.name === 'string' ? x.name : basename(x.path),
          modifiedAt: typeof x.modifiedAt === 'string' ? x.modifiedAt : new Date().toISOString(),
        }))
        .slice(0, MAX_RECENT)
    : []
  return {
    lang: r.lang === 'en' ? 'en' : 'ru',
    theme: r.theme === 'light' ? 'light' : 'dark',
    backend: r.backend === 'webgl' ? 'webgl' : 'webgpu',
    autosaveSec:
      typeof r.autosaveSec === 'number' && Number.isFinite(r.autosaveSec)
        ? Math.max(0, Math.min(3600, Math.round(r.autosaveSec)))
        : DEFAULTS.autosaveSec,
    recent,
    projectsDir: typeof r.projectsDir === 'string' && isAbsolute(r.projectsDir) ? r.projectsDir : undefined,
    trustedFolders: Array.isArray(r.trustedFolders)
      ? r.trustedFolders
          .filter((x): x is TrustedFolder => !!x && typeof x.path === 'string' && isAbsolute(x.path) && typeof x.id === 'string' && !!x.id)
          .map((x) => ({ path: x.path, id: x.id, folder: x.folder === true }))
          .slice(-500)
      : undefined,
    apiKeyEnc: typeof r.apiKeyEnc === 'string' && r.apiKeyEnc ? r.apiKeyEnc : undefined,
  }
}

async function load(): Promise<StoredSettings> {
  if (!cache) cache = sanitize(await readJson<Partial<StoredSettings>>(paths.settingsFile, DEFAULTS))
  return cache
}

function persist(s: StoredSettings): Promise<void> {
  cache = s
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => atomicWrite(paths.settingsFile, JSON.stringify(s, null, 2)))
  return writeChain
}

function toPublic(s: StoredSettings): AppSettings {
  return {
    lang: s.lang,
    theme: s.theme,
    backend: s.backend,
    autosaveSec: s.autosaveSec,
    anthropicApiKeySet: !!s.apiKeyEnc || !!sessionKey,
    recent: s.recent.map((r) => ({ ...r })),
    projectsDir: s.projectsDir ?? null,
  }
}

function emit(s: StoredSettings): void {
  const pub = toPublic(s)
  for (const l of listeners) l(pub)
}

export function onSettingsChanged(cb: (s: AppSettings) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export async function getSettings(): Promise<AppSettings> {
  return toPublic(await load())
}

export async function setSettings(patch: unknown): Promise<AppSettings> {
  const cur = await load()
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<StoredSettings>
  const next = sanitize({
    ...cur,
    lang: p.lang ?? cur.lang,
    theme: p.theme ?? cur.theme,
    backend: p.backend ?? cur.backend,
    autosaveSec: p.autosaveSec ?? cur.autosaveSec,
  })
  next.apiKeyEnc = cur.apiKeyEnc
  next.recent = cur.recent
  // a custom projects folder is chosen only through the main-process folder picker (setProjectsDir);
  // the renderer may only reset it to the default
  next.trustedFolders = cur.trustedFolders
  next.projectsDir = 'projectsDir' in p && p.projectsDir == null ? undefined : cur.projectsDir
  await persist(next)
  emit(next)
  return toPublic(next)
}

/** UI language as last stored (main-process messages follow it); 'ru' before the settings are loaded */
export function uiLang(): 'ru' | 'en' {
  return cache?.lang ?? 'ru'
}

/** picks the Russian or English text of a main-process message by the UI language */
export function msg(ru: string, en: string): string {
  return uiLang() === 'en' ? en : ru
}

const folderKey = (root: string) => resolve(root).toLowerCase()

/** what is recorded about a project folder (see projectFolder.folderTrust), or null */
export async function trustRecord(root: string): Promise<{ id: string; folder: boolean } | null> {
  const k = folderKey(root)
  const r = (await load()).trustedFolders?.find((f) => f.path === k)
  return r ? { id: r.id, folder: r.folder } : null
}

export async function setTrustRecord(root: string, id: string, folder: boolean): Promise<void> {
  const cur = await load()
  const k = folderKey(root)
  const list = (cur.trustedFolders ?? []).filter((f) => f.path !== k)
  list.push({ path: k, id, folder })
  await persist({ ...cur, trustedFolders: list.slice(-500) })
}

/** custom default parent folder for new projects, or null (→ Documents/doplan) */
export async function getProjectsDir(): Promise<string | null> {
  return (await load()).projectsDir ?? null
}

export async function setProjectsDir(dir: string | null): Promise<AppSettings> {
  const cur = await load()
  const next = { ...cur, projectsDir: dir && isAbsolute(dir) ? dir : undefined }
  await persist(next)
  emit(next)
  return toPublic(next)
}

export async function addRecent(path: string, name?: string): Promise<void> {
  const cur = await load()
  const entry: RecentProject = {
    path,
    name: name?.trim() || basename(path).replace(/\.doplan$/i, ''),
    modifiedAt: new Date().toISOString(),
  }
  const recent = [entry, ...cur.recent.filter((r) => r.path.toLowerCase() !== path.toLowerCase())].slice(0, MAX_RECENT)
  const next = { ...cur, recent }
  await persist(next)
  emit(next)
}

export async function isRecentPath(path: string): Promise<boolean> {
  const cur = await load()
  return cur.recent.some((r) => r.path.toLowerCase() === path.toLowerCase())
}

// ───────────── API key (safeStorage async API, Electron 45) ─────────────

type SafeStorageAsync = {
  isAsyncEncryptionAvailable?: () => Promise<boolean>
  encryptStringAsync?: (s: string) => Promise<Buffer>
  decryptStringAsync?: (b: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

const ss = safeStorage as unknown as SafeStorageAsync & typeof safeStorage

async function asyncAvailable(): Promise<boolean> {
  try {
    if (typeof ss.isAsyncEncryptionAvailable === 'function' && typeof ss.encryptStringAsync === 'function') {
      return await ss.isAsyncEncryptionAvailable()
    }
  } catch {
    /* fall through */
  }
  return false
}

async function encrypt(key: string): Promise<string | null> {
  if (await asyncAvailable()) {
    const buf = await ss.encryptStringAsync!(key)
    return `a:${Buffer.from(buf).toString('base64')}`
  }
  return null
}

async function decrypt(stored: string): Promise<{ key: string; reEncrypt: boolean } | null> {
  const [mode, b64] = stored.includes(':') ? [stored.slice(0, 1), stored.slice(2)] : ['a', stored]
  if (mode !== 'a' || !b64) return null
  if (typeof ss.decryptStringAsync !== 'function') return null
  try {
    const res = await ss.decryptStringAsync(Buffer.from(b64, 'base64'))
    return { key: res.result, reEncrypt: !!res.shouldReEncrypt }
  } catch {
    return null
  }
}

export async function setApiKey(key: string | null): Promise<void> {
  const cur = await load()
  const trimmed = typeof key === 'string' ? key.trim() : ''
  sessionKey = null
  let apiKeyEnc: string | undefined
  if (trimmed) {
    const enc = await encrypt(trimmed)
    if (enc) apiKeyEnc = enc
    else sessionKey = trimmed // OS encryption unavailable: keep for this session only, never on disk
  }
  const next = { ...cur, apiKeyEnc }
  await persist(next)
  emit(next)
}

export async function getApiKey(): Promise<string | null> {
  if (sessionKey) return sessionKey
  const cur = await load()
  if (!cur.apiKeyEnc) return null
  const dec = await decrypt(cur.apiKeyEnc)
  if (!dec) return null
  if (dec.reEncrypt) {
    const enc = await encrypt(dec.key)
    if (enc) await persist({ ...cur, apiKeyEnc: enc })
  }
  return dec.key
}
