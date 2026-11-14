/**
 * Chat storage per project: <userData>/ai-chats/<projectKey>/{settings.json, <chatId>.json}.
 * The project key is a hash of the project file path ('unsaved' for new projects).
 * Also provides the agent working directory for projects without their own folder.
 */
import { createHash } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { type AiChatMeta, type AiChatRecord, type AiChatSettings, DEFAULT_AI_SETTINGS } from '../../shared/aiChat'
import { atomicWrite, ensureDir, exists, readJson } from '../fsutil'
import { DEFAULT_AGENTS_MD } from './prompt'

const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'api'])
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max'])
const MAX_CHAT_BYTES = 40 * 1024 * 1024

export function projectKey(projectPath: string | null | undefined): string {
  if (!projectPath || typeof projectPath !== 'string') return 'unsaved'
  return createHash('sha1').update(projectPath.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)
}

function chatsDir(projectPath: string | null): string {
  return join(app.getPath('userData'), 'ai-chats', projectKey(projectPath))
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
  return sanitizeSettings(await readJson<unknown>(join(chatsDir(projectPath), 'settings.json'), DEFAULT_AI_SETTINGS))
}

export async function setChatSettings(projectPath: string | null, s: unknown): Promise<void> {
  await ensureDir(chatsDir(projectPath))
  await atomicWrite(join(chatsDir(projectPath), 'settings.json'), JSON.stringify(sanitizeSettings(s), null, 2))
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
export async function agentWorkDir(projectPath: string | null, projectRoot?: string | null): Promise<string> {
  if (projectRoot && typeof projectRoot === 'string' && (await isDir(projectRoot))) return projectRoot
  const dir = join(app.getPath('userData'), 'ai-work', projectKey(projectPath))
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
