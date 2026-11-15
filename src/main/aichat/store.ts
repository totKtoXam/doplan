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
import { readdir, realpath, rename, rm, stat } from 'node:fs/promises'
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
  const { resume: _drop, resumeCwd: _dropCwd, ...rest } = rec
  return rest
}

/**
 * A moved record keeps the sessions that know their folder (resumeCwd: the run checks it, see
 * aichat/index.ts resumesHere, so one made in a trusted project folder resumes there) and drops the
 * older ones, which counted as made in the project's ai-work folder.
 */
function withoutUnplacedResume(rec: AiChatRecord): AiChatRecord {
  const kept = Object.entries(rec.resume ?? {}).filter(([p]) => rec.resumeCwd?.[p as keyof typeof rec.resume])
  const { resume: _drop, ...rest } = rec
  return kept.length ? { ...rest, resume: Object.fromEntries(kept) } : rest
}

/**
 * The open document got a new reference. `copy` (Save As, a copied file): the chats are copied without
 * their agent sessions, so the two files do not continue one Claude Code / Codex conversation. Otherwise
 * they move and the agent keeps its old working folder, so a stored session still resumes; where that
 * cannot be (the target has a folder of its own) the moved chats start fresh sessions, except those made
 * in a folder they remember (withoutUnplacedResume). Chats already at
 * the target win. `path`: the file the document is saved to now (its chats are never dropped as those
 * of an abandoned document). Resolves whether agent sessions without a remembered folder still resume
 * at the target: when not, the renderer drops those from the chat it holds open too.
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
        if (rec?.resume) await atomicWrite(f, JSON.stringify(withoutUnplacedResume(rec)))
      }
    }
  }
  if (path) {
    await ensureDir(dst)
    await atomicWrite(join(dst, SAVED_FILE), JSON.stringify({ path: resolve(path) }))
  }
  return { sessionsKept }
}

/**
 * Copies of a file opened before their own id was saved into them: `<id>|<lower-case real path>` →
 * `{ id, ino }`, the copy's id and its file number. 0.10.0 wrote a bare id under the plain path.
 */
function copiesFile(): string {
  return join(app.getPath('userData'), 'ai-chats', 'copies.json')
}

const OWN_ID_RE = /^[A-Za-z0-9_-]{6,64}$/

interface CopyEntry {
  id: string
  /** the file number of the copy (renaming or moving it on the same disk keeps it); none from 0.10.0 */
  ino?: string
}

function copyEntry(v: unknown): CopyEntry | null {
  if (typeof v === 'string') return OWN_ID_RE.test(v) ? { id: v } : null
  if (!v || typeof v !== 'object') return null
  const { id, ino } = v as { id?: unknown; ino?: unknown }
  return typeof id === 'string' && OWN_ID_RE.test(id) ? { id, ...(typeof ino === 'string' && ino ? { ino } : {}) } : null
}

/** the path as the file system knows it: junctions, symlinks and mapped drives resolved */
async function canonicalPath(p: string): Promise<string> {
  const full = resolve(p)
  try {
    return await realpath(full)
  } catch {
    return full
  }
}

/** the file's number on its disk (the same file under any name), when the file system has one */
async function fileNumber(p: string): Promise<string | undefined> {
  try {
    const s = await stat(p, { bigint: true })
    return s.ino ? s.ino.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * Two paths that reach one and the same file: a hard link, or a share of a local disk (there the disk
 * number differs, so the size and modification time must match too).
 */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
    if (!x.ino || x.ino !== y.ino) return false
    return x.dev === y.dev || (x.size === y.size && x.mtimeNs === y.mtimeNs)
  } catch {
    return false
  }
}

/**
 * A saved document with an id was opened from `path`; resolves the reference its chats live under.
 * The id travels with the file contents, so a copy made outside the app (Explorer, a versioned
 * flat-v2, a file sent back by a colleague) carries the same one. The rules, in order:
 * 1. The file the id's chat folder belongs to (the same real path, or the same file by another path)
 *    → the document itself.
 * 2. A copy opened before (found by its path, or by its file number after a rename or move) → that
 *    copy's id. While the original is gone, a path counts only if the same file is still there.
 * 3. The file the folder belongs to is gone (renamed / moved) → this is it: the folder follows it.
 * 4. Otherwise it is a new copy: an id of its own, the chats copied without agent sessions (as on
 *    Save As). Nothing is written into the file here: the renderer marks the document changed, and
 *    the id reaches the file with the user's next save.
 * Limits, all with the same safe outcome (the copy gets a new id with the chats copied again; chats
 * are never deleted and never shown with another document): a copy that is renamed AND rewritten by
 * another program (or lives on a FAT drive) before it is saved; .json projects, read-only or locked
 * files simply stay unsaved copies (rules 2 and 4 keep finding them); a local and a network path to
 * one file that differ in size or time; an original moved onto the path of a deleted copy while
 * another file took the original's old place.
 */
export async function claimDocument(ref: string, path: string): Promise<string> {
  const d = DOC_ID_RE.exec(ref)
  if (!d || typeof path !== 'string' || !path) return ref
  const full = await canonicalPath(path)
  const dir = chatsDir(ref)
  const saved = await readJson<{ path?: unknown } | null>(join(dir, SAVED_FILE), null)
  const owner = typeof saved?.path === 'string' ? await canonicalPath(saved.path) : null
  if (owner && owner.toLowerCase() === full.toLowerCase()) return ref
  const ownerThere = !!owner && (await exists(owner))
  if (owner && ownerThere && (await sameFile(owner, full))) return ref

  const read = await readJson<Record<string, unknown>>(copiesFile(), {})
  const all: Record<string, unknown> = read && typeof read === 'object' ? { ...read } : {}
  const prefix = `${d[1]}|`
  const key = prefix + full.toLowerCase()
  const oldKey = prefix + resolve(path).toLowerCase()
  const no = await fileNumber(full)
  let found: string | null = null
  for (const k of [key, oldKey]) {
    const e = copyEntry(all[k])
    // with the original gone, a different file at a copy's old path is not that copy
    if (e && (ownerThere || !e.ino || !no || e.ino === no)) {
      found = k
      break
    }
  }
  if (!found && no) found = Object.keys(all).find((k) => k.startsWith(prefix) && copyEntry(all[k])?.ino === no) ?? null
  const entry = found ? copyEntry(all[found]) : null

  if (!entry && !ownerThere) {
    await ensureDir(dir)
    await atomicWrite(join(dir, SAVED_FILE), JSON.stringify({ path: full }))
    // an entry left at this path belonged to another file (a copy deleted since)
    if (key in all || oldKey in all) {
      delete all[key]
      delete all[oldKey]
      await atomicWrite(copiesFile(), JSON.stringify(all))
    }
    return ref
  }

  const id = entry?.id ?? randomBytes(12).toString('base64url')
  if (!entry || !(await exists(join(chatsDir(`id:${id}`), SAVED_FILE)))) await moveChats(ref, `id:${id}`, true, full)
  const before = JSON.stringify(all)
  if (found) delete all[found]
  delete all[oldKey]
  all[key] = { id, ...(no ? { ino: no } : {}) }
  const after = JSON.stringify(all)
  if (after !== before) await atomicWrite(copiesFile(), after)
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

/** agentWorkDir without creating or seeding anything: where a project's agent folder is or would be */
export async function agentWorkDirPath(projectPath: string | null): Promise<string> {
  return (await existingWorkDir(projectPath)) ?? ownWorkDir(projectPath)
}

export function tempDir(): string {
  return join(app.getPath('temp'), 'doplan-ai')
}
