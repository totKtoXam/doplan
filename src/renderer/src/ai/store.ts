/**
 * AI chat state: providers, per-project settings and chats, the running turn, context chips,
 * attachments, ask-mode approvals and the plan-mode draft. Doc tool calls from main are executed
 * here (tools.ts) against the live document or the draft.
 */
import { produce } from 'immer'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { EntityRef } from '@core/types'
import type { AiChatMeta, AiChatRecord, AiChatSettings, AiChip, AiImage, AiLoginEvent, AiMessage, AiPart, AiProviderId, AiProviderInfo, AiRunEvent, AiToolCall } from '@shared/aiChat'
import { DEFAULT_AI_SETTINGS } from '@shared/aiChat'
import { AI_TOOL_TITLES, isAiToolName } from '@shared/aiTools'
import { api } from '@/store/api'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'
import { DraftHost, liveHost } from './hosts'
import { chipFor, entityLevel, lookupFor } from './summary'
import { describeCall, executeTool, isMutating } from './tools'

export type DockTab = 'props' | 'ai'

export type PendingImage = AiImage & { url: string }

/** in-app CLI sign-in in progress (or just finished) */
export interface LoginState {
  provider: AiProviderId
  phase: 'running' | 'done' | 'error'
  url?: string
  output: string
  error?: string
}

export interface AiState {
  providers: AiProviderInfo[]
  providersLoaded: boolean
  settings: AiChatSettings
  projectPath: string | null
  chats: AiChatMeta[]
  chat: AiChatRecord
  running: { runId: string; msgId: string } | null
  status: string
  chips: AiChip[]
  images: PendingImage[]
  /** plan mode: number of proposed edits waiting for «Применить» */
  draftCount: number
  draftChanges: string[]
  dockTab: DockTab
  /** bumped to focus the input (Ctrl+L) */
  focusTick: number
  showHistory: boolean
  login: LoginState | null
}

const TAB_KEY = 'doplan.ai.dockTab'

function readTab(): DockTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'ai' ? 'ai' : 'props'
  } catch {
    return 'props'
  }
}

const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()

function emptyChat(provider: AiChatSettings['provider']): AiChatRecord {
  const t = now()
  return { id: uid(), title: '', provider, createdAt: t, updatedAt: t, messages: [], totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
}

export const aiStore = createStore<AiState>()(() => ({
  providers: [],
  providersLoaded: false,
  settings: { ...DEFAULT_AI_SETTINGS },
  projectPath: null,
  chats: [],
  chat: emptyChat(DEFAULT_AI_SETTINGS.provider),
  running: null,
  status: '',
  chips: [],
  images: [],
  draftCount: 0,
  draftChanges: [],
  dockTab: readTab(),
  focusTick: 0,
  showHistory: false,
  login: null,
}))

export function useAi<T>(selector: (s: AiState) => T): T {
  return useStore(aiStore, selector)
}

const get = () => aiStore.getState()
const set = (p: Partial<AiState>) => aiStore.setState(p)

// ───────────── module state (not rendered) ─────────────

let draft: DraftHost | null = null
const approvals = new Map<string, (yes: boolean) => void>()
/** provider part id → index in the assistant message parts (current run) */
let partIndex = new Map<string, number>()

function patchChat(fn: (c: AiChatRecord) => void): void {
  set({ chat: produce(get().chat, fn) })
}

function patchRunMsg(fn: (m: AiMessage) => void): void {
  const r = get().running
  if (!r) return
  patchChat((c) => {
    const m = c.messages.find((x) => x.id === r.msgId)
    if (m) fn(m)
  })
}

function pushPart(m: AiMessage, key: string | null, part: AiPart): void {
  m.parts.push(part)
  if (key) partIndex.set(key, m.parts.length - 1)
}

async function persist(): Promise<void> {
  const { chat, projectPath } = get()
  if (!chat.messages.length) return
  try {
    await api.aiChat.saveChat(projectPath, chat)
    const chats = await api.aiChat.listChats(projectPath)
    set({ chats })
  } catch (e) {
    console.error('[doplan] chat save failed', e)
  }
}

// ───────────── setup ─────────────

let inited = false

export function initAi(): void {
  if (inited) return
  inited = true
  void refreshProviders(false)
  api.aiChat.onEvent(onRunEvent)
  api.aiChat.onToolCall((call) => void onToolCall(call))
  api.aiChat.onLogin(onLoginEvent)
  let lastPath: string | null | undefined
  const sync = () => {
    const p = docStore.getState().filePath
    if (p === lastPath) return
    lastPath = p
    void setProject(p)
  }
  docStore.subscribe(sync)
  sync()
}

// ───────────── CLI sign-in ─────────────

export async function startLogin(provider: AiProviderId): Promise<void> {
  set({ login: { provider, phase: 'running', output: '' } })
  try {
    await api.aiChat.login(provider)
  } catch (e) {
    set({ login: { provider, phase: 'error', output: '', error: (e as Error).message } })
  }
}

export function sendLoginCode(code: string): void {
  if (!code.trim()) return
  void api.aiChat.loginInput(code)
  const l = get().login
  if (l) set({ login: { ...l, output: `${l.output}\n› код отправлен\n` } })
}

export function cancelLogin(): void {
  void api.aiChat.loginCancel()
  set({ login: null })
}

export function dismissLogin(): void {
  set({ login: null })
}

function onLoginEvent(provider: AiProviderId, ev: AiLoginEvent): void {
  const l = get().login
  const cur: LoginState = l && l.provider === provider ? l : { provider, phase: 'running', output: '' }
  if (ev.type === 'output') set({ login: { ...cur, output: (cur.output + ev.text).slice(-4000) } })
  else if (ev.type === 'url') set({ login: { ...cur, url: ev.url } })
  else {
    set({ login: { ...cur, phase: ev.ok ? 'done' : 'error', error: ev.error } })
    void refreshProviders(true)
  }
}

export async function refreshProviders(refresh: boolean): Promise<void> {
  try {
    const providers = await api.aiChat.providers(refresh)
    set({ providers, providersLoaded: true })
  } catch (e) {
    console.error('[doplan] providers failed', e)
    set({ providersLoaded: true })
  }
}

/** bumped by updateSettings: a project load that finishes later must not undo the user's choice */
let settingsRev = 0

async function setProject(path: string | null): Promise<void> {
  if (get().running) stop()
  discardDraft()
  const rev = settingsRev
  const [loaded, chats] = await Promise.all([
    api.aiChat.getSettings(path).catch(() => ({ ...DEFAULT_AI_SETTINGS })),
    api.aiChat.listChats(path).catch(() => [] as AiChatMeta[]),
  ])
  const settings = rev === settingsRev ? loaded : get().settings
  set({ projectPath: path, settings, chats, chat: emptyChat(settings.provider), chips: [], images: [], status: '' })
  if (settings !== loaded) void api.aiChat.setSettings(path, settings).catch(() => {})
}

export function setDockTab(tab: DockTab): void {
  set({ dockTab: tab })
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    /* ignore */
  }
}

export function updateSettings(patch: Partial<AiChatSettings>): void {
  const settings = { ...get().settings, ...patch, models: { ...get().settings.models, ...(patch.models ?? {}) } }
  if (patch.planMode === false && draft && !draft.empty) {
    // leaving plan mode keeps the proposal until the user applies or discards it
  }
  settingsRev++
  set({ settings })
  void api.aiChat.setSettings(get().projectPath, settings).catch(() => {})
}

// ───────────── chats ─────────────

export function newChat(): void {
  if (get().running) stop()
  discardDraft()
  set({ chat: emptyChat(get().settings.provider), status: '', showHistory: false })
}

export async function openChat(id: string): Promise<void> {
  if (get().running) stop()
  const rec = await api.aiChat.loadChat(get().projectPath, id)
  if (!rec) return
  discardDraft()
  set({ chat: rec, showHistory: false, status: '' })
}

export async function removeChat(id: string): Promise<void> {
  await api.aiChat.deleteChat(get().projectPath, id)
  if (get().chat.id === id) newChat()
  set({ chats: await api.aiChat.listChats(get().projectPath) })
}

// ───────────── context ─────────────

export function addRefsToChat(refs: EntityRef[]): void {
  const { doc, derived } = docStore.getState()
  const lk = lookupFor(doc, uiStore.getState().catalog)
  const chips = [...get().chips]
  for (const r of refs) {
    if (chips.some((c) => c.id === r.id)) continue
    const lv = entityLevel(doc, r)
    chips.push(chipFor(doc, lv ? derived[lv] : undefined, r, lk))
  }
  set({ chips })
  focusChat()
}

export function addSelectionToChat(): void {
  addRefsToChat(uiStore.getState().selection)
}

export function focusChat(): void {
  setDockTab('ai')
  if (!uiStore.getState().rightPanelOpen) uiStore.setState({ rightPanelOpen: true })
  set({ focusTick: get().focusTick + 1 })
}

export function removeChip(id: string): void {
  set({ chips: get().chips.filter((c) => c.id !== id) })
}

const MAX_SIDE = 1568

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Не удалось открыть изображение'))
    img.src = src
  })
}

async function toAttachment(src: string, name: string): Promise<PendingImage> {
  const img = await loadImage(src)
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * k))
  const h = Math.max(1, Math.round(img.naturalHeight * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')!
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, w, h)
  c.drawImage(img, 0, 0, w, h)
  const url = canvas.toDataURL('image/jpeg', 0.9)
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), name, url }
}

export async function addImageFiles(files: File[]): Promise<void> {
  const out: PendingImage[] = []
  for (const f of files.slice(0, 8)) {
    if (!f.type.startsWith('image/')) continue
    const url = URL.createObjectURL(f)
    try {
      out.push(await toAttachment(url, f.name))
    } catch (e) {
      console.error(e)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  set({ images: [...get().images, ...out].slice(0, 8) })
}

/** attaches the active level's underlay (traced plan photo) */
export async function addUnderlayImage(): Promise<boolean> {
  const { doc } = docStore.getState()
  const lv = uiStore.getState().activeLevelId
  const u = Object.values(doc.underlays).find((x) => x.levelId === lv) ?? Object.values(doc.underlays)[0]
  if (!u) return false
  set({ images: [...get().images, await toAttachment(u.src, 'подложка')].slice(0, 8) })
  return true
}

export function removeImage(i: number): void {
  set({ images: get().images.filter((_, j) => j !== i) })
}

async function thumb(url: string): Promise<string> {
  try {
    const img = await loadImage(url)
    const k = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * k)
    canvas.height = Math.round(img.naturalHeight * k)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return ''
  }
}

// ───────────── quick actions ─────────────

export const QUICK_ACTIONS: { cmd: string; label: string; prompt: string; needsImage?: boolean }[] = [
  {
    cmd: '/план по фото',
    label: 'План по фото',
    needsImage: true,
    prompt:
      'Построй план по приложенному изображению. Вызови get_planspec_schema, внимательно распознай стены, проёмы, комнаты и размеры, затем примени результат через apply_planspec (mode=replace, если план пустой, иначе newLevel). После этого сверь площади через get_plan и кратко перечисли, что получилось и в чём ты не уверен.',
  },
  {
    cmd: '/расставь мебель',
    label: 'Расставь мебель',
    prompt:
      'Расставь мебель по назначению комнат (если в контексте есть выбранные комнаты — только в них). Найди предметы через list_catalog, ставь вдоль стен по координатам из get_plan, фасадом в комнату, оставляй проходы не меньше 700 мм и не перекрывай двери и окна. В конце проверь результат через render_snapshot (2d) и поправь пересечения.',
  },
  {
    cmd: '/проверь площади',
    label: 'Проверь площади',
    prompt:
      'Проверь площади: вызови get_plan, сравни площади комнат с подписанными (если есть), найди комнаты без названия или типа, слишком маленькие или подозрительные контуры и незамкнутые стены. Ничего не меняй — дай короткий отчёт с таблицей комнат и общей площадью.',
  },
]

function expandQuick(text: string): { text: string; needsImage: boolean } {
  const t = text.trim()
  for (const q of QUICK_ACTIONS) {
    if (t.toLowerCase().startsWith(q.cmd)) {
      const extra = t.slice(q.cmd.length).trim()
      return { text: extra ? `${q.prompt}\n\nДополнительно: ${extra}` : q.prompt, needsImage: !!q.needsImage }
    }
  }
  return { text, needsImage: false }
}

// ───────────── run ─────────────

export function currentProvider(): AiProviderInfo | undefined {
  const s = get()
  return s.providers.find((p) => p.id === s.settings.provider)
}

export async function send(raw: string): Promise<void> {
  const st = get()
  if (st.running) return
  const { text, needsImage } = expandQuick(raw)
  if (!text.trim() && !st.images.length) return
  const prov = currentProvider()
  if (!prov?.available) {
    set({ status: prov?.reason ?? 'Провайдер недоступен' })
    return
  }
  if (needsImage && !st.images.length) {
    if (!(await addUnderlayImage().catch(() => false))) {
      set({ status: 'Приложите фото плана (скрепка или Ctrl+V) или добавьте подложку' })
      return
    }
  }
  const images = get().images
  const chips = st.chips
  const runId = uid()
  const userMsg: AiMessage = {
    id: uid(),
    role: 'user',
    createdAt: now(),
    parts: [{ type: 'text', text: raw.trim() || '(изображение)' }],
    chips: chips.length ? chips : undefined,
    images: images.length ? await Promise.all(images.map((im) => thumb(im.url))) : undefined,
  }
  const asst: AiMessage = { id: uid(), role: 'assistant', createdAt: now(), parts: [] }
  const settings = st.settings
  if (settings.planMode && !draft) draft = new DraftHost()
  partIndex = new Map()
  patchChat((c) => {
    c.messages.push(userMsg, asst)
    if (!c.title) c.title = (raw.trim() || 'Изображение').slice(0, 60)
    c.provider = settings.provider
    c.updatedAt = now()
  })
  set({ running: { runId, msgId: asst.id }, chips: [], images: [], status: 'Запуск…', showHistory: false })
  const chat = get().chat
  try {
    await api.aiChat.run({
      runId,
      chatId: chat.id,
      projectPath: st.projectPath,
      projectRoot: null,
      settings,
      text,
      images: images.map(({ mime, data, name }) => ({ mime, data, name })),
      chips,
      resumeId: chat.resume?.[settings.provider],
      apiHistory: settings.provider === 'api' ? chat.apiHistory : undefined,
    })
  } catch (e) {
    onRunEvent(runId, { type: 'done', ok: false, error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
  }
}

export function stop(): void {
  const r = get().running
  if (!r) return
  for (const [, res] of approvals) res(false)
  approvals.clear()
  void api.aiChat.stop(r.runId)
}

function onRunEvent(runId: string, ev: AiRunEvent): void {
  const r = get().running
  if (!r || r.runId !== runId) return
  switch (ev.type) {
    case 'status':
      set({ status: ev.text })
      return
    case 'session': {
      const prov = get().settings.provider
      patchChat((c) => {
        c.resume = { ...(c.resume ?? {}), [prov]: ev.id }
      })
      return
    }
    case 'text':
    case 'thinking':
      if (get().status) set({ status: '' })
      patchRunMsg((m) => {
        const i = partIndex.get(ev.partId)
        const p = i !== undefined ? m.parts[i] : undefined
        if (p && (p.type === 'text' || p.type === 'thinking')) p.text += ev.delta
        else pushPart(m, ev.partId, { type: ev.type, text: ev.delta })
      })
      return
    case 'tool':
      patchRunMsg((m) => {
        const i = partIndex.get(ev.partId)
        const p = i !== undefined ? m.parts[i] : undefined
        if (p && p.type === 'tool') {
          p.status = ev.status
          if (ev.output) p.result = ev.output.slice(0, 2000)
        } else {
          pushPart(m, ev.partId, { type: 'tool', id: ev.partId, name: ev.name, title: ev.name, origin: 'ext', args: ev.input, status: ev.status, result: ev.output?.slice(0, 2000) })
        }
      })
      return
    case 'usage':
      patchRunMsg((m) => {
        m.usage = {
          inputTokens: (m.usage?.inputTokens ?? 0) + (ev.inputTokens ?? 0),
          outputTokens: (m.usage?.outputTokens ?? 0) + (ev.outputTokens ?? 0),
          costUsd: ev.costUsd !== undefined ? (m.usage?.costUsd ?? 0) + ev.costUsd : m.usage?.costUsd,
        }
      })
      patchChat((c) => {
        const t = c.totals ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
        c.totals = { inputTokens: t.inputTokens + (ev.inputTokens ?? 0), outputTokens: t.outputTokens + (ev.outputTokens ?? 0), costUsd: t.costUsd + (ev.costUsd ?? 0) }
      })
      return
    case 'notice':
      patchRunMsg((m) => pushPart(m, null, { type: 'notice', level: ev.level, text: ev.text }))
      return
    case 'apiHistory':
      patchChat((c) => {
        c.apiHistory = ev.messages
      })
      return
    case 'done':
      for (const [, res] of approvals) res(false)
      approvals.clear()
      patchRunMsg((m) => {
        for (const p of m.parts) if (p.type === 'tool' && (p.status === 'running' || p.status === 'pending')) p.status = ev.ok ? 'done' : 'error'
        if (ev.stopped) pushPart(m, null, { type: 'notice', level: 'info', text: 'Остановлено' })
        else if (!ev.ok && ev.error) {
          m.error = ev.error
          // CLIs often print the same failure as the assistant's text: show it once, as an error
          const last = m.parts.at(-1)
          if (last?.type === 'text' && last.text.trim() === ev.error.trim()) m.parts.pop()
          pushPart(m, null, { type: 'notice', level: 'error', text: ev.error, ...(ev.authRequired ? { login: get().settings.provider } : {}) })
        }
        if (!m.parts.length) pushPart(m, null, { type: 'notice', level: 'warning', text: 'Пустой ответ' })
      })
      patchChat((c) => {
        c.updatedAt = now()
      })
      set({ running: null, status: '' })
      if (ev.authRequired) void refreshProviders(false)
      void persist()
      return
  }
}

async function onToolCall(call: AiToolCall): Promise<void> {
  const r = get().running
  if (!r || r.runId !== call.runId) {
    api.aiChat.toolResult(call.callId, { ok: false, text: 'Запуск не активен' })
    return
  }
  const { settings } = get()
  const mutating = isMutating(call.tool)
  const ask = mutating && settings.permission === 'ask' && !settings.planMode
  const title = isAiToolName(call.tool) ? AI_TOOL_TITLES[call.tool] : call.tool
  patchRunMsg((m) =>
    pushPart(m, call.callId, {
      type: 'tool',
      id: call.callId,
      name: call.tool,
      title,
      origin: 'doc',
      args: call.args,
      status: ask ? 'pending' : 'running',
      result: ask ? describeCall(call.tool, call.args) : undefined,
    }),
  )
  const setPart = (fn: (p: Extract<AiPart, { type: 'tool' }>) => void) =>
    patchRunMsg((m) => {
      const i = partIndex.get(call.callId)
      const p = i !== undefined ? m.parts[i] : undefined
      if (p && p.type === 'tool') fn(p)
    })

  if (ask) {
    const yes = await new Promise<boolean>((res) => approvals.set(call.callId, res))
    approvals.delete(call.callId)
    if (!yes) {
      setPart((p) => {
        p.status = 'rejected'
      })
      api.aiChat.toolResult(call.callId, { ok: false, text: 'Пользователь отклонил это изменение. Не повторяй его; спроси, что сделать иначе.' })
      return
    }
    setPart((p) => {
      p.status = 'running'
    })
  }

  const plan = settings.planMode
  if (plan && !draft) draft = new DraftHost()
  const host = plan && draft ? draft : liveHost()
  const out = await executeTool(host, call.tool, call.args)
  const img = out.result.image ? `data:${out.result.image.mime};base64,${out.result.image.data}` : undefined
  setPart((p) => {
    p.status = !out.result.ok ? 'error' : plan && mutating ? 'proposed' : 'done'
    p.result = out.result.text.slice(0, 1500)
    if (out.changes) p.changes = out.changes
    if (img) p.image = img
  })
  if (plan && mutating && out.result.ok && draft) set({ draftCount: draft.count, draftChanges: [...get().draftChanges, ...(out.changes ?? [describeCall(call.tool, call.args)])] })
  api.aiChat.toolResult(call.callId, out.result)
  // keep stored chats small: snapshot images are re-encoded as thumbnails
  if (img) {
    const t = await thumb(img)
    setPart((p) => {
      p.image = t || undefined
    })
  }
}

export function answerApproval(callId: string, yes: boolean): void {
  approvals.get(callId)?.(yes)
}

export function applyDraft(): { ok: boolean; stale: boolean } | null {
  if (!draft || draft.empty) return null
  const res = draft.apply()
  if (res.ok) {
    patchChat((c) => {
      for (const m of c.messages) for (const p of m.parts) if (p.type === 'tool' && p.status === 'proposed') p.status = 'done'
    })
    draft = null
    set({ draftCount: 0, draftChanges: [] })
    void persist()
  }
  return res
}

export function discardDraft(): void {
  draft = null
  if (get().draftCount || get().draftChanges.length) {
    patchChat((c) => {
      for (const m of c.messages) for (const p of m.parts) if (p.type === 'tool' && p.status === 'proposed') p.status = 'rejected'
    })
    set({ draftCount: 0, draftChanges: [] })
  }
}
