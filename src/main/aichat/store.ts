/**
 * Chat storage per project: <userData>/ai-chats/<projectKey>/{settings.json, <chatId>.json}.
 * The renderer names a project by a reference: `id:<id>` for a document that carries its own id
 * (Doc.meta.id: renames and crash recovery keep it), a file path for older files without one, and
 * `unsaved:<id>` for an older unsaved document. moveChats carries the chats along when that changes;
 * claimDocument tells a copy of a file (same id, other path) from the file itself.
 * Chats of unsaved documents from before 0.6 stay in the shared bucket (reference null) for good.
 * Also provides the agent working directory for projects without their own folder.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { type AiChatMeta, type AiChatRecord, type AiChatSettings, DEFAULT_AI_SETTINGS } from '../../shared/aiChat'
import { atomicWrite, ensureDir, exists, readJson } from '../fsutil'
import { DEFAULT_AGENTS_MD } from './prompt'

const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'api'])
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max'])
const MAX_CHAT_BYTES = 40 * 1024 * 1024

/** `id:<id>`: the document's own id (Doc.meta.id) */
const DOC_ID_RE = /^id:([A-Za-z0-9_-]{6,64})$/
/** `unsaved:<id>`: an unsaved document without an id of its own (older recovery snapshots) */
const UNSAVED_RE = /^unsaved:([A-Za-z0-9-]{8,64})$/
/** the bucket all unsaved documents shared before 0.6: its settings are the defaults for new projects */
const SHARED = 'unsaved'
/** files in a project folder that are not chats */
const WORKDIR_FILE = 'workdir.json'
const SAVED_FILE = 'saved.json'
const META_FILES = new Set(['settings.json', WORKDIR_FILE, SAVED_FILE])

/**
 * Folder name for a project reference: `p-<id>` for `id:<id>`, `unsaved-<id>` for `unsaved:<id>`,
 * a hash of the file path otherwise, `unsaved` (the shared bucket) for none.
 */
export function projectKey(ref: string | null | undefined): string {
  if (!ref || typeof ref !== 'string') return SHARED
  const d = DOC_ID_RE.exec(ref)
  if (d) return `p-${d[1]}`
  const m = UNSAVED_RE.exec(ref)
  if (m) return `unsaved-${m[1]}`
  return createHash('sha1').update(ref.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)
}

function chatsDir(ref: string | null): string {
  return join(app.getPath('userData'), 'ai-chats', projectKey(ref))
}

function ownWorkDir(ref: string | null): string {
  return join(app.getPath('userData'), 'ai-work', projectKey(ref))
}

function chatFile(ref: string | null, chatId: string): string {
  if (!CHAT_ID_RE.test(chatId)) throw new Error('Неверный id чата')
  return join(chatsDir(ref), `${chatId}.json`)
}

export function sanitizeSettings(raw: unknown): AiChatSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiChatSettings>
  const models: AiChatSettings['models'] = {}
  if (r.models && typeof r.models === 'object') {
    for (const [k, v] of Object.entries(r.models)) if (PROVIDERS.has(k) && typeof v === 'string' && v.length < 80) models[k as keyof typeof models] = v
  }
  return {
    provider: typeof r.provider === 'string' && PROVIDERS.has(r.provider) ? r.provider : DEFAULT_AI_SETTINGS.provider,
    models,
    effort: typeof r.effort === 'string' && EFFORTS.has(r.effort) ? r.effort : '',
    ultracode: r.ultracode === true,
    permission: r.permission === 'ask' ? 'ask' : 'auto',
    planMode: r.planMode === true,
  }
}

/** the project's settings; a project without its own takes the last choice made anywhere */
export async function getChatSettings(ref: string | null): Promise<AiChatSettings> {
  const own = await readJson<unknown>(join(chatsDir(ref), 'settings.json'), null)
  return sanitizeSettings(own ?? (await readJson<unknown>(join(chatsDir(null), 'settings.json'), DEFAULT_AI_SETTINGS)))
}

export async function setChatSettings(ref: string | null, s: unknown): Promise<void> {
  const json = JSON.stringify(sanitizeSettings(s), null, 2)
  for (const dir of new Set([chatsDir(ref), chatsDir(null)])) {
    await ensureDir(dir)
    await atomicWrite(join(dir, 'settings.json'), json)
  }
}

/** a chat record without its agent sessions: they belong to the folder and project they were made in */
function withoutResume(rec: AiChatRecord): AiChatRecord {
  const { resume: _drop, ...rest } = rec
  return rest
}

/**
 * The open document got a new reference. `copy` (Save As, a copied file): the chats are copied without
 * their agent sessions, so the two files do not continue one Claude Code / Codex conversation. Otherwise
 * they move and the agent keeps its old working folder, so a stored session still resumes; where that
 * cannot be (the target has a folder of its own) the moved chats start fresh sessions. Chats already at
 * the target win. `path`: the file the document is saved to now (its chats are never dropped as those
 * of an abandoned document). Resolves whether agent sessions still resume at the target: when not, the
 * renderer drops them from the chat it holds open too.
 */
export async function moveChats(from: string, to: string, copy: boolean, path: string | null): Promise<{ sessionsKept: boolean }> {
  if (!from || !to || projectKey(from) === SHARED || projectKey(to) === SHARED) throw new Error('Неверная ссылка на проект')
  const dst = chatsDir(to)
  let sessionsKept = true
  if (projectKey(from) !== projectKey(to)) {
    const src = chatsDir(from)
    const srcWork = (await existingWorkDir(from)) ?? ownWorkDir(from)
    const moved: string[] = []
    if (await exists(src)) {
      await ensureDir(dst)
      if (!(await exists(join(dst, 'settings.json'))) && (await exists(join(src, 'settings.json')))) {
        await atomicWrite(join(dst, 'settings.json'), JSON.stringify(await getChatSettings(from), null, 2))
      }
      for (const f of await readdir(src)) {
        if (!f.endsWith('.json') || META_FILES.has(f)) continue
        const target = join(dst, f)
        if (await exists(target)) continue
        if (copy) {
          const rec = await readJson<AiChatRecord | null>(join(src, f), null)
          if (rec && typeof rec === 'object') await atomicWrite(target, JSON.stringify(withoutResume(rec)))
        } else {
          await rename(join(src, f), target)
          moved.push(target)
        }
      }
      if (!copy) await rm(src, { recursive: true, force: true })
    }
    // the agent folder goes with the chats (also before the first chat is stored: a running turn has one)
    if (!copy && (await isDir(srcWork)) && !(await isDir(ownWorkDir(to))) && !(await exists(join(dst, WORKDIR_FILE)))) {
      await ensureDir(dst)
      await atomicWrite(join(dst, WORKDIR_FILE), JSON.stringify({ dir: srcWork }))
    }
    // sessions resume only in the folder they were made in
    sessionsKept = !copy && ((await existingWorkDir(to)) ?? ownWorkDir(to)) === srcWork
    if (!sessionsKept && !copy) {
      for (const f of moved) {
        const rec = await readJson<AiChatRecord | null>(f, null)
        if (rec?.resume) await atomicWrite(f, JSON.stringify(withoutResume(rec)))
      }
    }
  }
  if (path) {
    await ensureDir(dst)
    await atomicWrite(join(dst, SAVED_FILE), JSON.stringify({ path: resolve(path) }))
  }
  return { sessionsKept }
}

/** copies opened from another path than their original: `<id>|<lower-case path>` → their own id */
function copiesFile(): string {
  return join(app.getPath('userData'), 'ai-chats', 'copies.json')
}

const OWN_ID_RE = /^[A-Za-z0-9_-]{6,64}$/

/**
 * A saved document with an id was opened from `path`. The id travels with the file contents, so a copy
 * made outside the app (Explorer, a versioned flat-v2, a file sent back by a colleague) carries the same
 * one. The chat folder remembers the file it belongs to: the same path, or that file no longer exists
 * (renamed / moved) → the document is the file itself and keeps its chats. Another file still there →
 * this one is a copy: it gets an id of its own (the same one on every open, until it is saved with it),
 * and the chats are copied without agent sessions, as on Save As. Resolves the reference to use.
 */
export async function claimDocument(ref: string, path: string): Promise<string> {
  const d = DOC_ID_RE.exec(ref)
  if (!d || typeof path !== 'string' || !path) return ref
  const full = resolve(path)
  const dir = chatsDir(ref)
  const saved = await readJson<{ path?: unknown } | null>(join(dir, SAVED_FILE), null)
  const owner = typeof saved?.path === 'string' ? resolve(saved.path) : null
  if (owner && owner.toLowerCase() === full.toLowerCase()) return ref
  if (!owner || !(await exists(owner))) {
    await ensureDir(dir)
    await atomicWrite(join(dir, SAVED_FILE), JSON.stringify({ path: full }))
    return ref
  }
  const copies = await readJson<Record<string, unknown>>(copiesFile(), {})
  const key = `${d[1]}|${full.toLowerCase()}`
  const known = copies && typeof copies === 'object' ? copies[key] : undefined
  const id = typeof known === 'string' && OWN_ID_RE.test(known) ? known : randomBytes(12).toString('base64url')
  if (id !== known) {
    await moveChats(ref, `id:${id}`, true, full)
    await atomicWrite(copiesFile(), JSON.stringify({ ...(copies && typeof copies === 'object' ? copies : {}), [key]: id }))
  } else if (!(await exists(join(chatsDir(`id:${id}`), SAVED_FILE)))) {
    await moveChats(ref, `id:${id}`, true, full)
  }
  return `id:${id}`
}

/**
 * The chats of an unsaved document that is gone (replaced or closed without saving): nothing can reach
 * them any more. A project that was ever saved keeps its chats.
 */
export async function dropChats(ref: string | null): Promise<void> {
  if (!ref || projectKey(ref) === SHARED || !(DOC_ID_RE.test(ref) || UNSAVED_RE.test(ref))) return
  const dir = chatsDir(ref)
  if (await exists(join(dir, SAVED_FILE))) return
  await rm(dir, { recursive: true, force: true })
  await rm(ownWorkDir(ref), { recursive: true, force: true })
}

export async function listChats(projectPath: string | null): Promise<AiChatMeta[]> {
  const dir = chatsDir(projectPath)
  if (!(await exists(dir))) return []
  const out: AiChatMeta[] = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json') || META_FILES.has(f)) continue
    const rec = await readJson<Partial<AiChatRecord> | null>(join(dir, f), null)
    if (!rec || typeof rec.id !== 'string') continue
    out.push({
      id: rec.id,
      title: typeof rec.title === 'string' ? rec.title : 'Чат',
      provider: (rec.provider as AiChatMeta['provider']) ?? 'claude',
      createdAt: rec.createdAt ?? '',
      updatedAt: rec.updatedAt ?? '',
    })
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return out
}

export async function loadChat(projectPath: string | null, chatId: unknown): Promise<AiChatRecord | null> {
  if (typeof chatId !== 'string') return null
  const rec = await readJson<AiChatRecord | null>(chatFile(projectPath, chatId), null)
  return rec && rec.id === chatId && Array.isArray(rec.messages) ? rec : null
}

export async function saveChat(projectPath: string | null, chat: unknown): Promise<void> {
  const c = chat as AiChatRecord
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !Array.isArray(c.messages)) throw new Error('Неверная запись чата')
  const json = JSON.stringify(c)
  if (json.length > MAX_CHAT_BYTES) throw new Error('Чат слишком большой для сохранения')
  await ensureDir(chatsDir(projectPath))
  await atomicWrite(chatFile(projectPath, c.id), json)
}

export async function deleteChat(projectPath: string | null, chatId: unknown): Promise<void> {
  if (typeof chatId !== 'string') return
  await rm(chatFile(projectPath, chatId), { force: true })
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** the agent folder this project uses already: its own, or the one its chats came from (moveChats) */
async function existingWorkDir(projectPath: string | null): Promise<string | null> {
  const root = join(app.getPath('userData'), 'ai-work')
  const own = join(root, projectKey(projectPath))
  if (await isDir(own)) return own
  const ptr = await readJson<{ dir?: unknown } | null>(join(chatsDir(projectPath), WORKDIR_FILE), null)
  const dir = typeof ptr?.dir === 'string' ? resolve(ptr.dir) : null
  // only folders the app made itself
  return dir && dir.startsWith(resolve(root) + sep) && (await isDir(dir)) ? dir : null
}

/**
 * Per-project agent working directory under userData, seeded with the default instructions. Used
 * when there is no trusted project folder to run in (see aichat/index.ts agentPlace).
 */
export async function agentWorkDir(projectPath: string | null): Promise<string> {
  const dir = (await existingWorkDir(projectPath)) ?? join(app.getPath('userData'), 'ai-work', projectKey(projectPath))
  await ensureDir(dir)
  const agents = join(dir, 'AGENTS.md')
  if (!(await exists(agents))) await atomicWrite(agents, DEFAULT_AGENTS_MD)
  const claude = join(dir, 'CLAUDE.md')
  if (!(await exists(claude))) await atomicWrite(claude, '@AGENTS.md\n')
  return dir
}

export function tempDir(): string {
  return join(app.getPath('temp'), 'doplan-ai')
}
