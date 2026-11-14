/**
 * Chat storage per project: <userData>/ai-chats/<projectKey>/{settings.json, <chatId>.json}.
 * The project key is a hash of the project file path; an unsaved document has its own
 * `unsaved-<id>` folder until it is saved (moveChats).
 * Also provides the agent working directory for projects without their own folder.
 */
import { createHash } from 'node:crypto'
import { copyFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { type AiChatMeta, type AiChatRecord, type AiChatSettings, DEFAULT_AI_SETTINGS } from '../../shared/aiChat'
import { atomicWrite, ensureDir, exists, readJson } from '../fsutil'
import { DEFAULT_AGENTS_MD } from './prompt'

const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'api'])
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max'])
const MAX_CHAT_BYTES = 40 * 1024 * 1024

/** `unsaved:<id>`: a document without a file yet; each one keeps its own chats until it is saved */
const UNSAVED_RE = /^unsaved:([A-Za-z0-9-]{8,64})$/

export function isUnsavedRef(projectPath: string | null | undefined): boolean {
  return !projectPath || UNSAVED_RE.test(projectPath)
}

/**
 * Folder name for a project: a hash of its file path, `unsaved-<id>` for an unsaved document
 * (the renderer passes `unsaved:<id>`), `unsaved` for older callers without an id.
 */
export function projectKey(projectPath: string | null | undefined): string {
  if (!projectPath || typeof projectPath !== 'string') return 'unsaved'
  const m = UNSAVED_RE.exec(projectPath)
  if (m) return `unsaved-${m[1]}`
  return createHash('sha1').update(projectPath.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)
}

function chatsDir(projectPath: string | null): string {
  return join(app.getPath('userData'), 'ai-chats', projectKey(projectPath))
}

/** settings of unsaved documents are shared (the last choice carries over to the next new project) */
function settingsFile(projectPath: string | null): string {
  return join(isUnsavedRef(projectPath) ? chatsDir(null) : chatsDir(projectPath), 'settings.json')
}

function chatFile(projectPath: string | null, chatId: string): string {
  if (!CHAT_ID_RE.test(chatId)) throw new Error('Неверный id чата')
  return join(chatsDir(projectPath), `${chatId}.json`)
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

export async function getChatSettings(projectPath: string | null): Promise<AiChatSettings> {
  return sanitizeSettings(await readJson<unknown>(settingsFile(projectPath), DEFAULT_AI_SETTINGS))
}

export async function setChatSettings(projectPath: string | null, s: unknown): Promise<void> {
  const f = settingsFile(projectPath)
  await ensureDir(dirname(f))
  await atomicWrite(f, JSON.stringify(sanitizeSettings(s), null, 2))
}

/**
 * The document got a (new) file: Save of a new project moves its chats, Save As copies them (the old
 * file keeps its history). Chats already at the target win. The agent keeps its old working folder,
 * so a stored Claude Code session still resumes.
 */
export async function moveChats(from: string | null, to: string | null): Promise<void> {
  if (!from || !to || isUnsavedRef(to) || projectKey(from) === projectKey(to)) return
  const src = chatsDir(from)
  const dst = chatsDir(to)
  const move = isUnsavedRef(from)
  await ensureDir(dst)
  if (!(await exists(join(dst, 'settings.json')))) await setChatSettings(to, await getChatSettings(from))
  if (await exists(src)) {
    for (const f of await readdir(src)) {
      if (!f.endsWith('.json') || f === 'settings.json' || f === WORKDIR_FILE) continue
      const target = join(dst, f)
      if (await exists(target)) continue
      if (move) await rename(join(src, f), target)
      else await copyFile(join(src, f), target)
    }
  }
  const work = await existingWorkDir(from)
  if (work && !(await exists(join(app.getPath('userData'), 'ai-work', projectKey(to)))) && !(await exists(join(dst, WORKDIR_FILE)))) {
    await atomicWrite(join(dst, WORKDIR_FILE), JSON.stringify({ dir: work }))
  }
  if (move) await rm(src, { recursive: true, force: true })
}

export async function listChats(projectPath: string | null): Promise<AiChatMeta[]> {
  const dir = chatsDir(projectPath)
  if (!(await exists(dir))) return []
  const out: AiChatMeta[] = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json') || f === 'settings.json') continue
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

/**
 * Agent working directory: the project folder when the app knows one (its CLAUDE.md / AGENTS.md load
 * natively), otherwise a per-project folder under userData seeded with the default instructions.
 */
const WORKDIR_FILE = 'workdir.json'

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

export async function agentWorkDir(projectPath: string | null, projectRoot?: string | null): Promise<string> {
  if (projectRoot && typeof projectRoot === 'string' && (await isDir(projectRoot))) return projectRoot
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
