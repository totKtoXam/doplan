/**
 * AI chat in the main process: provider detection, agent runs, chat storage IPC.
 * Wired from src/main/index.ts (registerAiChat on ready, shutdownAiChat on quit).
 */
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getApiKey } from '../settings'
import type { AiChip, AiProviderId, AiProviderInfo, AiRunEvent, AiRunRequest } from '../../shared/aiChat'
import { CH } from '../channels'
import { handleIpc, onIpc } from '../ipc'
import { sendToRenderer } from '../window'
import { API_MODELS, runAnthropicApi } from './anthropicApi'
import { abortRunCalls, closeRun, forgetRun, onToolResult } from './bridge'
import { runClaude, runCodex, runGemini, type RunCtx } from './cliRunners'
import { binVersion, findOnPath, killTree, type ResolvedBin } from './detect'
import { authStatus, cancelLogin, isAuthError, loginInput, startLogin } from './login'
import { closeMcpServer, openEndpoint, revokeRun } from './mcpServer'
import { AGENT_SYSTEM_PROMPT, PLAN_MODE_NOTE } from './prompt'
import { agentWorkDir, deleteChat, getChatSettings, listChats, loadChat, moveChats, sanitizeSettings, saveChat, setChatSettings } from './store'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

interface Detected {
  info: AiProviderInfo
  bin?: ResolvedBin
}

let detected: Promise<Detected[]> | null = null

/** Codex lists the models available to the signed-in account in ~/.codex/models_cache.json. */
function codexModels(): { models: { id: string; label: string }[]; efforts: string[] } {
  const models = [{ id: '', label: 'По умолчанию' }]
  const efforts = new Set<string>()
  try {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex')
    const cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')) as { models?: unknown[] }
    for (const raw of cache.models ?? []) {
      const m = raw as { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_reasoning_levels?: { effort?: unknown }[] }
      if (typeof m.slug !== 'string' || m.visibility !== 'list') continue
      models.push({ id: m.slug, label: typeof m.display_name === 'string' ? m.display_name : m.slug })
      for (const l of m.supported_reasoning_levels ?? []) if (typeof l.effort === 'string') efforts.add(l.effort)
    }
  } catch {
    // no cache yet: only the CLI default
  }
  return { models, efforts: efforts.size ? EFFORTS.filter((e) => efforts.has(e)) : ['low', 'medium', 'high'] }
}

async function detectCli(id: AiProviderId, name: string, label: string, base: Omit<AiProviderInfo, 'id' | 'label' | 'available'>): Promise<Detected> {
  const bin = findOnPath(name)
  if (!bin) return { info: { id, label, available: false, reason: `${name} не найден в PATH`, ...base } }
  const canLogin = id === 'claude' || id === 'codex'
  const [version, st] = await Promise.all([binVersion(bin), canLogin ? authStatus(id, bin) : Promise.resolve(undefined)])
  return { bin, info: { id, label, available: true, path: bin.path, version, ...base, auth: st?.auth, account: st?.account, canLogin } }
}

async function detectAll(): Promise<Detected[]> {
  const [claude, codex, gemini, key] = await Promise.all([
    detectCli('claude', 'claude', 'Claude Code', {
      // exact model ids (the CLI's aliases opus/sonnet/… would hide the version)
      models: [{ id: '', label: 'По умолчанию' }, ...API_MODELS.map((m) => ({ id: m.id, label: m.label.replace(/^Claude /, '') }))],
      efforts: EFFORTS,
      reportsCost: true,
      images: true,
    }),
    detectCli('codex', 'codex', 'Codex CLI', {
      ...codexModels(),
      reportsCost: false,
      images: true,
    }),
    detectCli('gemini', 'gemini', 'Gemini CLI', { models: [{ id: '', label: 'По умолчанию' }], efforts: [], reportsCost: false, images: false }),
    getApiKey().catch(() => null),
  ])
  const api: Detected = {
    info: {
      id: 'api',
      label: 'Anthropic API',
      available: !!key,
      reason: key ? undefined : 'Не задан API-ключ (Настройки → ИИ)',
      models: API_MODELS,
      efforts: EFFORTS,
      reportsCost: false,
      images: true,
    },
  }
  // Gemini is offered only when installed
  return [claude, codex, ...(gemini.info.available ? [gemini] : []), api]
}

async function providers(refresh: boolean): Promise<Detected[]> {
  if (!detected || refresh) detected = detectAll()
  const list = await detected
  // the API key can be set at any time: re-check it on every call
  const key = await getApiKey().catch(() => null)
  const api = list.find((p) => p.info.id === 'api')
  if (api) Object.assign(api.info, { available: !!key, reason: key ? undefined : 'Не задан API-ключ (Настройки → ИИ)' })
  return list
}

// ───────────── runs ─────────────

interface Run {
  abort: AbortController
  children: Set<ChildProcess>
}

const runs = new Map<string, Run>()
const MAX_TEXT = 100_000
const MAX_IMAGES = 8

function chipsText(chips: AiChip[]): string {
  if (!chips.length) return ''
  const lines = chips.slice(0, 50).map((c) => `- ${c.kind} ${c.id}: ${c.summary}`.slice(0, c.kind === 'annotation' ? 6000 : 600))
  return `Контекст (объекты, которые пользователь добавил в чат):\n${lines.join('\n')}\n\n`
}

function validRequest(raw: unknown): AiRunRequest {
  const r = raw as AiRunRequest
  if (!r || typeof r !== 'object' || typeof r.runId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(r.runId)) throw new Error('Неверный запрос')
  if (typeof r.text !== 'string') throw new Error('Неверный текст')
  const images = Array.isArray(r.images)
    ? r.images
        .filter((im) => im && typeof im.data === 'string' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(im.mime) && im.data.length < 14_000_000)
        .slice(0, MAX_IMAGES)
    : []
  const chips = Array.isArray(r.chips) ? r.chips.filter((c) => c && typeof c.id === 'string' && typeof c.summary === 'string') : []
  return {
    runId: r.runId,
    chatId: typeof r.chatId === 'string' ? r.chatId : '',
    projectPath: typeof r.projectPath === 'string' ? r.projectPath : null,
    projectRoot: typeof r.projectRoot === 'string' ? r.projectRoot : null,
    settings: sanitizeSettings(r.settings),
    text: r.text.slice(0, MAX_TEXT),
    images,
    chips,
    resumeId: typeof r.resumeId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(r.resumeId) ? r.resumeId : undefined,
    apiHistory: Array.isArray(r.apiHistory) ? r.apiHistory : undefined,
  }
}

function systemPrompt(req: AiRunRequest): string {
  const parts = [AGENT_SYSTEM_PROMPT]
  if (req.settings.planMode) parts.push(PLAN_MODE_NOTE)
  if (req.settings.permission === 'ask') parts.push('The user approves each document change in the app; a rejected change comes back as an error saying so.')
  return parts.join('\n\n')
}

async function startRun(raw: unknown): Promise<void> {
  const req = validRequest(raw)
  if (runs.has(req.runId)) throw new Error('Запуск уже идёт')
  const list = await providers(false)
  const prov = list.find((p) => p.info.id === req.settings.provider)
  if (!prov || !prov.info.available) throw new Error(prov?.info.reason ?? 'Провайдер недоступен')

  const run: Run = { abort: new AbortController(), children: new Set() }
  runs.set(req.runId, run)
  let finished = false
  const emit = (ev: AiRunEvent) => {
    if (finished) return
    if (ev.type === 'done') {
      finished = true
      if (!ev.ok && !ev.stopped && isAuthError(ev.error)) {
        ev = { ...ev, authRequired: true }
        prov.info.auth = 'required'
      }
    }
    sendToRenderer(CH.evAiChatEvent, req.runId, ev)
  }
  const userText = chipsText(req.chips) + req.text

  void (async () => {
    try {
      if (prov.info.id === 'api') {
        await runAnthropicApi({ req, emit, signal: run.abort.signal, systemPrompt: systemPrompt(req), userText })
      } else {
        const endpoint = await openEndpoint(req.runId)
        // stopped while the endpoint was opening: the token is born revoked
        if (run.abort.signal.aborted) {
          revokeRun(req.runId)
          return
        }
        const ctx: RunCtx = {
          req,
          emit,
          signal: run.abort.signal,
          endpoint,
          cwd: await agentWorkDir(req.projectPath, req.projectRoot),
          systemPrompt: systemPrompt(req),
          userText,
          track: (c) => {
            run.children.add(c)
            c.once('close', () => run.children.delete(c))
          },
        }
        const bin = prov.bin!
        if (prov.info.id === 'claude') await runClaude(ctx, bin)
        else if (prov.info.id === 'codex') await runCodex(ctx, bin)
        else await runGemini(ctx, bin)
      }
    } catch (e) {
      emit({ type: 'done', ok: false, error: (e as Error).message })
    } finally {
      emit({ type: 'done', ok: !run.abort.signal.aborted, stopped: run.abort.signal.aborted })
      revokeRun(req.runId)
      abortRunCalls(req.runId, 'Запуск завершён')
      forgetRun(req.runId)
      runs.delete(req.runId)
    }
  })()
}

function stopRun(runId: unknown): void {
  if (typeof runId !== 'string') return
  const run = runs.get(runId)
  if (!run) return
  run.abort.abort()
  // the agent loses access at once, not when its process finally exits
  revokeRun(runId)
  closeRun(runId)
  for (const c of run.children) killTree(c)
}

export function registerAiChat(): void {
  handleIpc(CH.aiChatProviders, async (refresh: unknown) => (await providers(refresh === true)).map((p) => p.info))
  handleIpc(CH.aiChatRun, (req: unknown) => startRun(req))
  handleIpc(CH.aiChatStop, (runId: unknown) => stopRun(runId))
  onIpc(CH.aiChatToolResult, (callId: unknown, result: unknown) => onToolResult(callId, result))
  handleIpc(CH.aiChatList, (p: unknown) => listChats(typeof p === 'string' ? p : null))
  handleIpc(CH.aiChatLoad, (p: unknown, id: unknown) => loadChat(typeof p === 'string' ? p : null, id))
  handleIpc(CH.aiChatSave, (p: unknown, chat: unknown) => saveChat(typeof p === 'string' ? p : null, chat))
  handleIpc(CH.aiChatDelete, (p: unknown, id: unknown) => deleteChat(typeof p === 'string' ? p : null, id))
  handleIpc(CH.aiChatGetSettings, (p: unknown) => getChatSettings(typeof p === 'string' ? p : null))
  handleIpc(CH.aiChatSetSettings, (p: unknown, s: unknown) => setChatSettings(typeof p === 'string' ? p : null, s))
  handleIpc(CH.aiChatMove, (from: unknown, to: unknown) => moveChats(typeof from === 'string' ? from : null, typeof to === 'string' ? to : null))
  handleIpc(CH.aiChatLogin, async (id: unknown) => {
    const prov = (await providers(false)).find((p) => p.info.id === id)
    if (!prov?.bin || !prov.info.canLogin) throw new Error('Вход для этого провайдера недоступен')
    const pid = prov.info.id
    startLogin(
      pid,
      prov.bin,
      (ev) => sendToRenderer(CH.evAiChatLogin, pid, ev),
      () => {
        detected = null // re-detect: sign-in state changed
      },
    )
  })
  handleIpc(CH.aiChatLoginInput, (text: unknown) => {
    if (typeof text === 'string') loginInput(text)
  })
  handleIpc(CH.aiChatLoginCancel, () => cancelLogin())
  // warm up detection so the panel opens instantly
  void providers(false)
}

/** App quit: stop every agent and its children, close the MCP server. */
export function shutdownAiChat(): void {
  for (const id of [...runs.keys()]) stopRun(id)
  cancelLogin()
  closeMcpServer()
}
