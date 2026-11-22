/**
 * AI chat state: providers, per-project settings and chats, the running turn, context chips,
 * attachments, ask-mode approvals and the plan-mode draft. Doc tool calls from main are executed
 * here (tools.ts) against the live document or the draft.
 */
import { produce } from 'immer'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { derivePlan, describeMark, markBadge, markTargets } from '@core'
import type { EntityRef, Id } from '@core/types'
import type { AiChatMeta, AiChatRecord, AiChatSettings, AiChip, AiImage, AiLoginEvent, AiMessage, AiPart, AiProviderId, AiProviderInfo, AiQuestion, AiQuestionAnswer, AiRunEvent, AiToolCall } from '@shared/aiChat'
import { DEFAULT_AI_SETTINGS, quoteMarkdown } from '@shared/aiChat'
import { AI_TOOL_TITLES, formatAnswers, isAiToolName, parseToolArgs } from '@shared/aiTools'
import { ensureAiFolderTrust } from '@/actions/project'
import { isAnyTranslation, t } from '@/i18n'
import { api } from '@/store/api'
import { docStore } from '@/store/document'
import { getMark, marksStore, removeSentMarks, setMarkNumberFloor } from '@/store/marks'
import { addProjectHook } from '@/store/projectHooks'
import { uiStore } from '@/store/ui'
import { chatTranscript } from './history'
import { DraftHost, type DraftMark, liveHost } from './hosts'
import { markSnapshot } from './markSnapshot'
import type { MarkupShape } from './markup'
import { chipFor, entityLevel, lookupFor } from './summary'
import { describeCall, executeTool, hostNames, isMutating, previewCall } from './tools'

export type DockTab = 'props' | 'ai'

/** an image waiting to be sent; `markup` keeps the clean picture and the pencil marks drawn over it (re-editable) */
export type PendingImage = AiImage & { url: string; markup?: { base: string; shapes: MarkupShape[] } }

/** a passage of the conversation the user picked to quote in the next message */
export interface ChatQuote {
  id: string
  text: string
}

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
  /** chats of unsaved projects from before 0.6: one bucket shared by all projects, never deleted silently */
  legacyChats: AiChatMeta[]
  chat: AiChatRecord
  /** the open chat is one of legacyChats (it is saved there and runs in their agent folder) */
  legacy: boolean
  /** `marks`: plan marks that went to the agent this turn (the message, an answer); let go when it ends well */
  running: { runId: string; msgId: string; marks?: Id[] } | null
  /** the agent's open ask_user call (the card above the input box); `draft`: what the user picked so far */
  asking: { callId: string; runId: string; questions: AiQuestion[]; draft: AiQuestionAnswer[] } | null
  status: string
  chips: AiChip[]
  images: PendingImage[]
  quotes: ChatQuote[]
  /** plan mode: number of proposed edits waiting for «Применить» */
  draftCount: number
  draftChanges: string[]
  dockTab: DockTab
  /** bumped to focus the input (Ctrl+L) */
  focusTick: number
  showHistory: boolean
  login: LoginState | null
  /** text the composer should take in (a pencil-mark note); `send` = send right away */
  composeInsert: { text: string; send: boolean; tick: number } | null
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
  legacyChats: [],
  chat: emptyChat(DEFAULT_AI_SETTINGS.provider),
  legacy: false,
  running: null,
  asking: null,
  status: '',
  chips: [],
  images: [],
  quotes: [],
  draftCount: 0,
  draftChanges: [],
  dockTab: readTab(),
  focusTick: 0,
  showHistory: false,
  login: null,
  composeInsert: null,
}))

export function useAi<T>(selector: (s: AiState) => T): T {
  return useStore(aiStore, selector)
}

const get = () => aiStore.getState()
const set = (p: Partial<AiState>) => aiStore.setState(p)

// ───────────── module state (not rendered) ─────────────

let draft: DraftHost | null = null
/**
 * user message id → the plan-mode draft as that turn found it, so that editing the message takes back only
 * what the dropped turns proposed. Kept for the turns of the current draft only.
 */
const turnDrafts = new Map<string, { host: DraftHost | null; mark?: DraftMark; changes: number }>()
const approvals = new Map<string, (yes: boolean) => void>()
/** open ask_user calls: resolved with the answer, or null (declined / the turn ended) */
const questions = new Map<string, (a: AskResult) => void>()
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

/** where the open chat is stored: the project's chats, or the shared pre-0.6 bucket (null) */
function chatRef(): string | null {
  return get().legacy ? null : get().projectPath
}

/**
 * Every access to the chat storage that can race a save (saves, the late events of a stopped turn,
 * moves, loads), one after the other: a read-modify-write never reads a record from before a save
 * that was issued earlier.
 */
let writeQueue: Promise<unknown> = Promise.resolve()
function queueWrite<T>(job: () => Promise<T>): Promise<T> {
  const p = writeQueue.then(job)
  writeQueue = p.catch(() => {})
  return p
}

/** both chat lists, as stored now */
async function refreshLists(): Promise<void> {
  const p = get().projectPath
  const [chats, legacyChats] = await Promise.all([
    p ? api.aiChat.listChats(p).catch(() => get().chats) : Promise.resolve([] as AiChatMeta[]),
    api.aiChat.listChats(null).catch(() => get().legacyChats),
  ])
  if (get().projectPath === p) set({ chats, legacyChats })
}

/** saves the chat as it is now (taken synchronously: the caller may switch chats right after) */
async function persist(): Promise<void> {
  const { chat } = get()
  const ref = chatRef()
  if (!chat.messages.length) return
  try {
    await queueWrite(() => api.aiChat.saveChat(ref, chat))
    await refreshLists()
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
  // main stopped waiting (nobody answered within the hour): the card goes, the agent has its result
  api.aiChat.onToolCancel(({ callId }) => {
    // still in line behind the open card: it is never shown
    queuedAsks.delete(callId)
    questions.get(callId)?.(null)
    approvals.get(callId)?.(false)
  })
  api.aiChat.onLogin(onLoginEvent)
  let lastLoad: number | undefined
  /** the open document has never been written to a file: its chats go when it does */
  let unsavedDoc = false
  const sync = () => {
    const { filePath, loadId, reload } = docStore.getState()
    // a save keeps the document (the 'saved' hook moves its chats when its reference changes)
    if (loadId === lastLoad) return
    const first = lastLoad === undefined
    lastLoad = loadId
    // the same project loaded again (an old version viewed or left, plan.json reloaded after the agent
    // changed it): the chat stays open. A plan-mode draft was made against the plan that is gone, so it
    // ends, and with it the turn that made it (it would go on proposing changes to proposals that are
    // gone); a turn would also go on editing an old version. A live turn goes on after a plain reload
    if (!first && reload && (docRef() === get().projectPath || claimFailed)) {
      leaveChat(reload === 'version' || hasDraft())
      // a copy read again keeps its own id (actions/project keepId), which its file still lacks
      const c = copyClaim
      const s = docStore.getState()
      if (c && s.filePath === c.path && s.doc.meta.id === c.to && !s.dirty) s.setDirty(true)
      return
    }
    const gone = !first && unsavedDoc ? get().projectPath : null
    unsavedDoc = filePath === null
    looseRef = ''
    void setProject(gone)
  }
  docStore.subscribe(sync)
  sync()
  addProjectHook({
    // every save waits for the claim of the opened file, so it writes the copy's own id
    beforeSave: claimSettled,
    saved: async (saveAs) => {
      await claimSettled()
      const c = copyClaim
      const s = docStore.getState()
      if (!saveAs && c && s.doc.meta.id === c.from) {
        // a save that did not wait wrote the old id: the copy keeps its new one (changed until saved)
        s.setDocId(c.to)
        set({ projectPath: `id:${c.to}` })
      } else copyClaim = null
      // the claim failed: whether this file is a copy is unknown, so the save leaves the chats of its
      // id alone (a Save As is a new project of its own and takes the chats made meanwhile)
      if (claimFailed && !saveAs) return
      claimFailed = false
      // the first save of a new document takes its chats along, even through Save As
      const wasUnsaved = unsavedDoc
      unsavedDoc = false
      await moveProject(docRef(), saveAs && !wasUnsaved, docStore.getState().filePath)
    },
    closing: async () => {
      const ref = get().projectPath
      if (unsavedDoc && !get().legacy) dropCurrent()
      else {
        const wasRunning = !!get().running
        if (wasRunning) stop(false)
        if (discardDraft() || wasRunning) await persist()
      }
      // closed without saving: nothing can open the document's chats again (the shared ones stay)
      if (unsavedDoc && ref) await queueWrite(() => api.aiChat.dropChats(ref)).catch(() => {})
      await writeQueue
    },
  })
}

/** an older document without an id of its own and without a file: one bucket per load */
let looseRef = ''

/**
 * The open document's chat reference: its id (renames and crash recovery keep it), or, for files from
 * before 0.6 without one, the file path (until the next save gives it an id).
 */
function docRef(): string {
  const { doc, filePath } = docStore.getState()
  if (doc.meta.id) return `id:${doc.meta.id}`
  if (filePath) return filePath
  if (!looseRef) looseRef = `unsaved:${uid()}`
  return looseRef
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
  if (l) set({ login: { ...l, output: `${l.output}\n${t('› код отправлен')}\n` } })
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

/** a move of the chats in progress: a new turn waits for it (it would start in the wrong place) */
let moving: Promise<void> | null = null
/** the claim of the file just opened, until its answer is applied: the 'saved' hook waits for it */
let claiming: Promise<void> | null = null
/** the opened file at `path` turned out to be a copy: its id `from` became `to` (until it is saved with it) */
let copyClaim: { path: string; from: string; to: string } | null = null
/** the claim of the open file failed: its chats are a scratch bucket, the id's own chats are left alone */
let claimFailed = false
/** per chat reference: how many times its chats lost their agent sessions (a claim of a moved document).
 * A stopped turn's session, written later, is dropped when this changed after the turn was stopped */
const sessionDrops = new Map<string, number>()
const dropsOf = (ref: string | null) => (ref ? (sessionDrops.get(ref) ?? 0) : 0)
/** one per document opened: a chat loaded for the document before is not this one's, even with the same id */
let projectGen = 0

/** resolves once no claim of an opened file is pending (its answer applied) */
async function claimSettled(): Promise<void> {
  while (claiming) await claiming
}

/**
 * The open document was saved: its chats follow when its reference changed (moved; copied without
 * agent sessions on Save As), and the folder learns it belongs to a saved project. Nothing is
 * interrupted: the chat, a running turn and the draft go on.
 */
async function moveProject(to: string, copy: boolean, path: string | null): Promise<void> {
  const from = get().projectPath
  set({ projectPath: to })
  const job = queueWrite(() => (from ? api.aiChat.moveChats(from, to, copy, path) : Promise.resolve({ sessionsKept: true }))).catch((e) => {
    console.error('[doplan] moving chats failed', e)
    return { sessionsKept: false }
  })
  const wait = job.then(() => {})
  moving = wait
  const { sessionsKept } = await job
  if (moving === wait) moving = null
  // agent sessions resume only in the folder and project they were made in: the open chat drops them
  // too (Save As: the copy starts its own; a target with a folder of its own), and so does a running turn
  // a move keeps the sessions that remember their folder (main checks it on every run); a copy keeps none
  if (!sessionsKept) {
    const r = get().running
    if (!get().legacy) {
      patchChat((c) => {
        if (copy) {
          delete c.resume
          delete c.resumeCwd
          return
        }
        for (const p of Object.keys(c.resume ?? {}) as AiProviderId[]) if (!c.resumeCwd?.[p]) delete c.resume![p]
      })
      // the running turn's session comes with its folder: only a copy must not continue it
      if (r && copy) voidSessions.add(r.runId)
    }
    if (copy) for (const s of stoppedRuns.values()) if (s.ref === from) s.noSession = true
  }
  if (!copy) for (const s of stoppedRuns.values()) if (s.ref === from) s.ref = to
  if (get().projectPath !== to) return
  // the current chat (also when a save of it raced the move) and the list of the new place
  if (get().chat.messages.length && !get().legacy) await persist()
  else await refreshLists()
}

/** the plan-mode draft holds proposals (an empty DraftHost left by a plan-mode turn is no draft) */
function hasDraft(): boolean {
  return (!!draft && !draft.empty) || get().draftCount > 0 || get().draftChanges.length > 0
}

/** leaving the current chat: a running turn stops (unless `stopTurn` is false), the plan-mode draft is
 * dropped, and the conversation is saved as it stands */
function leaveChat(stopTurn = true): void {
  const wasRunning = stopTurn && !!get().running
  if (wasRunning) stop(false)
  const dropped = discardDraft()
  if (wasRunning || dropped) void persist()
}

/** the current chat goes with its (unsaved, abandoned) document: nothing is saved */
function dropCurrent(): void {
  if (get().running) stop(false)
  discardDraft()
  stoppedRuns.clear()
}

/**
 * Another document is open. `gone`: the reference of the unsaved document it replaced, whose chats
 * nothing can reach any more.
 */
async function setProject(gone: string | null): Promise<void> {
  projectGen++
  // a shared pre-0.6 chat is never dropped with a document: it is saved where it lives
  if (gone && !get().legacy) dropCurrent()
  else leaveChat()
  let ref = docRef()
  copyClaim = null
  claimFailed = false
  // switched at once: whatever is saved from now on lands in the new project
  set({ projectPath: ref, legacy: false, chats: [], chat: emptyChat(get().settings.provider), chips: [], images: [], quotes: [], status: '' })
  if (gone && gone !== ref) void queueWrite(() => api.aiChat.dropChats(gone)).catch(() => {})
  const { filePath } = docStore.getState()
  if (filePath && ref.startsWith('id:')) {
    // a copy of another file (the same id inside) gets an id and chats of its own
    const opened = ref
    // the document this claim is for: another file opened meanwhile can carry the same id (the original
    // of the copy being claimed), and must not get the copy's id
    const job = queueWrite(async () => {
      const c = await api.aiChat.claimDocument(opened, filePath)
      // the chats it keeps lost their agent sessions (moved outside the app): a stopped turn of this id
      // that reports its session late must not write it back. Done in the queue, before any later write
      if (c.sessionsDropped) {
        // also a turn whose 'done' already came: its session write may be queued behind this claim
        sessionDrops.set(opened, dropsOf(opened) + 1)
        for (const s of stoppedRuns.values()) if (s.ref === opened) s.noSession = true
        if (chatRef() === opened) {
          const r = get().running
          if (r) voidSessions.add(r.runId)
          // the open chat (loaded from disk before the drop) forgets them too
          patchChat((ch) => {
            delete ch.resume
            delete ch.resumeCwd
          })
        }
      }
      return c.ref
    }).catch((e) => {
      console.error('[doplan] claiming the document failed', e)
      return null
    })
    const wait = job.then(() => {})
    moving = wait
    let applied!: () => void
    const claim = new Promise<void>((r) => (applied = r))
    claiming = claim
    try {
      const claimed = await job
      if (moving === wait) moving = null
      const s = docStore.getState()
      // still this file with this id: not after another file was opened (the original of a copy can
      // carry the same id), nor after a Save As gave it an id of its own. A reload keeps the answer
      if (get().projectPath !== opened || s.filePath !== filePath || `id:${s.doc.meta.id}` !== opened) return
      if (claimed === null) {
        // unknown whether this file is a copy: no chats of the id are shown or touched, the next open
        // tries again
        claimFailed = true
        ref = `unsaved:${uid()}`
        set({ projectPath: ref, status: t('Не удалось открыть чаты проекта: показан пустой чат') })
      } else if (claimed !== opened && claimed.startsWith('id:')) {
        copyClaim = { path: filePath, from: opened.slice(3), to: claimed.slice(3) }
        s.setDocId(claimed.slice(3))
        ref = claimed
        set({ projectPath: ref })
      }
    } finally {
      if (claiming === claim) claiming = null
      applied()
    }
  }
  const rev = settingsRev
  const [loaded, chats, legacyChats] = await Promise.all([
    api.aiChat.getSettings(ref).catch(() => ({ ...DEFAULT_AI_SETTINGS })),
    api.aiChat.listChats(ref).catch(() => [] as AiChatMeta[]),
    api.aiChat.listChats(null).catch(() => [] as AiChatMeta[]),
  ])
  if (get().projectPath !== ref) return
  const settings = rev === settingsRev ? loaded : get().settings
  const chat = get().chat.messages.length || get().running ? get().chat : emptyChat(settings.provider)
  set({ settings, chats, legacyChats, chat })
  if (settings !== loaded) void api.aiChat.setSettings(ref, settings).catch(() => {})
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
  // leaving plan mode keeps a proposal until the user applies or discards it; an empty one goes
  if (patch.planMode === false && draft?.empty) draft = null
  settingsRev++
  set({ settings })
  void api.aiChat.setSettings(get().projectPath, settings).catch(() => {})
}

// ───────────── chats ─────────────

export function newChat(): void {
  leaveChat()
  set({ chat: emptyChat(get().settings.provider), legacy: false, status: '', showHistory: false })
}

/** `legacy`: one of the shared chats from before 0.6 */
export async function openChat(id: string, legacy = false): Promise<void> {
  if (get().chat.id === id && get().legacy === legacy) {
    set({ showHistory: false })
    return
  }
  leaveChat()
  const path = get().projectPath
  const gen = projectGen
  // after the save of the chat just left
  const rec = await queueWrite(() => api.aiChat.loadChat(legacy ? null : path, id))
  // another document opened meanwhile (also one with the same id: the record, and its agent sessions,
  // may be of the document before)
  if (!rec || get().projectPath !== path || projectGen !== gen || get().running) return
  set({ chat: rec, legacy, showHistory: false, status: '' })
}

export async function removeChat(id: string, legacy = false): Promise<void> {
  if (get().chat.id === id && get().legacy === legacy) {
    // no save of the chat being deleted, nor of what its stopped turn still reports
    const r = get().running
    if (r) {
      stop(false)
      stoppedRuns.delete(r.runId)
    }
    discardDraft()
    set({ chat: emptyChat(get().settings.provider), legacy: false, status: '', showHistory: false })
  }
  const ref = legacy ? null : get().projectPath
  await queueWrite(() => api.aiChat.deleteChat(ref, id))
  await refreshLists()
}

// ───────────── context ─────────────

export function addRefsToChat(refs: EntityRef[]): void {
  const { doc, derived } = docStore.getState()
  const lk = lookupFor(doc, uiStore.getState().catalog)
  const chips = [...get().chips]
  for (const r of refs) {
    if (chips.some((c) => c.id === r.id)) continue
    const lv = entityLevel(doc, r)
    chips.push(chipFor(doc, lv ? derived[lv] : undefined, r, lk, uiStore.getState().lang))
  }
  set({ chips })
  focusChat()
}

export function addSelectionToChat(): void {
  // a selected pencil mark goes first while drawing marks (or when nothing else is selected)
  const mk = marksStore.getState().selected
  const ui = uiStore.getState()
  if (mk && getMark(mk) && (ui.tool === 'pencil' || !ui.selection.length)) {
    void addMarkToChat(mk)
    return
  }
  addRefsToChat(ui.selection)
}

/** «Пометка ①» chip: what the mark touches, plus a cropped snapshot of that area */
export async function addMarkToChat(id: Id, focus = true): Promise<void> {
  const { doc, derived } = docStore.getState()
  const m = doc.annotations?.[id]
  if (!m) return
  const plan = derived[m.levelId] ?? derivePlan(doc, m.levelId)
  const chip: AiChip = { kind: 'annotation', id: m.id, label: t('Пометка {n}', { n: markBadge(m.n) }), summary: describeMark(doc, m, markTargets(doc, plan, m)) }
  set({ chips: [...get().chips.filter((c) => c.id !== id), chip] })
  markSnaps.set(m.id, `пометка-${m.n}`)
  if (focus) focusChat()
  else showChat()
  if (currentProvider()?.images === false) return
  try {
    const img = markSnapshot(doc, plan, m, uiStore.getState().catalog)
    if (img) set({ images: [...get().images.filter((x) => x.name !== img.name), img].slice(-8) })
  } catch (e) {
    console.error('[doplan] mark snapshot failed', e)
  }
}

/** opens the AI tab without taking the keyboard */
export function showChat(): void {
  setDockTab('ai')
  if (!uiStore.getState().rightPanelOpen) uiStore.setState({ rightPanelOpen: true })
}

export function focusChat(): void {
  showChat()
  set({ focusTick: get().focusTick + 1 })
}

/** puts a line into the chat input (and optionally sends it) — the mini field next to a mark on a chat picture.
 *  Adding without sending leaves the keyboard where it is, so the next mark can be drawn right away. */
export function insertIntoComposer(text: string, send: boolean): void {
  if (send) focusChat()
  else showChat()
  set({ composeInsert: { text, send, tick: (get().composeInsert?.tick ?? 0) + 1 } })
}

export function consumeInsert(): void {
  if (get().composeInsert) set({ composeInsert: null })
}

/** highest badge number drawn on the pictures waiting to be sent */
export function maxImageMarkNumber(extra: MarkupShape[] = []): number {
  let max = 0
  for (const im of get().images) for (const s of im.markup?.shapes ?? []) max = Math.max(max, s.n ?? 0)
  for (const s of extra) max = Math.max(max, s.n ?? 0)
  return max
}

/** next free number for a mark on a picture: after the plan marks and every other picture */
export function nextImageMarkNumber(current: MarkupShape[]): number {
  const plan = Object.values(docStore.getState().doc.annotations ?? {}).reduce((m, a) => Math.max(m, a.n), 0)
  return Math.max(plan, maxImageMarkNumber(current)) + 1
}

setMarkNumberFloor(() => maxImageMarkNumber())

export function removeChip(id: string): void {
  set({ chips: get().chips.filter((c) => c.id !== id) })
}

/** mark id → the name of the snapshot that went into the box with its chip */
const markSnaps = new Map<Id, string>()

/** takes plan marks out of the message: their chips and the snapshots that came with them (unless drawn on) */
export function removeMarksFromChat(ids: readonly Id[]): void {
  const names = new Set(ids.map((id) => markSnaps.get(id)))
  const chips = get().chips.filter((c) => !(c.kind === 'annotation' && ids.includes(c.id)))
  const images = get().images.filter((im) => !names.has(im.name) || !!im.markup?.shapes.length)
  if (chips.length !== get().chips.length || images.length !== get().images.length) set({ chips, images })
}

const markIds = (chips: readonly AiChip[]): Id[] => chips.filter((c) => c.kind === 'annotation').map((c) => c.id)

/** sent marks leave the plan in one undoable step; a plan-mode draft waiting for «Применить» is not made stale by it */
function letGoOfSentMarks(ids: Id[]): void {
  const before = docStore.getState().revision
  if (!removeSentMarks(ids).length) return
  if (draft && draft.baseRevision === before) draft.baseRevision = docStore.getState().revision
}

// a mark deleted from the plan (Delete, «Очистить пометки», undoing it) leaves the message too
docStore.subscribe((s, prev) => {
  if (s.doc.annotations === prev.doc.annotations) return
  const gone = markIds(get().chips).filter((id) => !s.doc.annotations?.[id])
  if (gone.length) removeMarksFromChat(gone)
})

const MAX_QUOTE = 4000

/** quotes a passage of the conversation in the next message (the text selected in the chat) */
export function addQuote(text: string): void {
  const q = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_QUOTE)
  if (!q || get().quotes.some((x) => x.text === q)) return focusChat()
  set({ quotes: [...get().quotes, { id: uid(), text: q }].slice(-10) })
  focusChat()
}

export function removeQuote(id: string): void {
  set({ quotes: get().quotes.filter((q) => q.id !== id) })
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
  const im = await underlayAttachment()
  if (!im) return false
  set({ images: [...get().images, im].slice(0, 8) })
  return true
}

async function underlayAttachment(): Promise<PendingImage | null> {
  const { doc } = docStore.getState()
  const lv = uiStore.getState().activeLevelId
  const u = Object.values(doc.underlays).find((x) => x.levelId === lv) ?? Object.values(doc.underlays)[0]
  return u ? toAttachment(u.src, 'подложка') : null
}

/** puts the image back after drawing pencil marks on it */
export function replaceImage(i: number, img: PendingImage): void {
  const images = get().images
  if (!images[i]) return
  set({ images: images.map((x, j) => (j === i ? img : x)) })
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

/** the command as the user sees it in the current language */
export const quickCmd = (q: { cmd: string }): string => t(q.cmd)

/** true when `text` starts with the command (in Russian or in the UI language) */
export function quickMatch(q: { cmd: string }, text: string): string | null {
  const s = text.trim().toLowerCase()
  for (const c of [quickCmd(q), q.cmd]) if (s.startsWith(c.toLowerCase())) return c
  return null
}

function expandQuick(text: string): { text: string; needsImage: boolean } {
  const s = text.trim()
  for (const q of QUICK_ACTIONS) {
    const c = quickMatch(q, s)
    if (c) {
      const extra = s.slice(c.length).trim()
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

/** a trust question is open (send() awaits it): a second send waits for nothing */
let askingTrust = false

/**
 * The pictures of the latest messages at full size: a message edited later is sent again with them
 * (after a restart, with the thumbnails the chat keeps).
 */
const sentImages = new Map<string, PendingImage[]>()
const KEEP_SENT_IMAGES = 20

function rememberImages(msgId: string, images: PendingImage[]): void {
  if (!images.length) return
  sentImages.set(msgId, images)
  while (sentImages.size > KEEP_SENT_IMAGES) sentImages.delete(sentImages.keys().next().value!)
}

/** a picture kept in the chat (a data URL) as an attachment */
function fromThumb(url: string): PendingImage {
  const mime = (/^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(url)?.[1] ?? 'image/jpeg') as AiImage['mime']
  return { mime, data: url.slice(url.indexOf(',') + 1), name: 'изображение', url }
}

/** what goes with the text of a message */
interface TurnInput {
  chips: AiChip[]
  images: PendingImage[]
  quotes: string[]
}

export async function send(raw: string): Promise<void> {
  // a question is open: the text typed is the answer (with what is picked on the card)
  if (get().asking && get().running) {
    answerQuestion(raw)
    return
  }
  await runTurn(raw, null)
}

/** the text of a user message to edit: a picture sent alone has a placeholder (in the language of then) — the edit starts empty */
export function editableText(m: AiMessage): string {
  const raw = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  return m.images?.length && isAnyTranslation(raw, '(изображение)') ? '' : raw
}

/**
 * Sends an earlier message of the user again, changed. The chat goes on from there: the messages after
 * it are dropped, and so are the agent sessions and the API history (they remember the old conversation);
 * the agent starts anew and gets the chat so far as text. The message keeps its chips, quotes and
 * pictures. Nothing happens while a turn runs. True when the turn started.
 */
export function editAndResend(msgId: string, raw: string): Promise<boolean> {
  return runTurn(raw, msgId)
}

/** the open chat still has this message of the user */
const hasUserMsg = (id: string) => get().chat.messages.some((m) => m.id === id && m.role === 'user')

async function runTurn(raw: string, editId: string | null): Promise<boolean> {
  if (get().running || askingTrust) return false
  // a turn starts where the chats are, not halfway through moving them
  if (moving) await moving
  if (currentProvider()?.id !== 'api' && currentProvider()?.available) {
    // an agent CLI in a project folder the user has not trusted yet: ask once (see actions/project.ts)
    askingTrust = true
    try {
      if (!(await ensureAiFolderTrust())) {
        // the composer was cleared on Enter: a cancelled question gives the message back (an edit stays open)
        if (!editId) insertIntoComposer(raw, false)
        return false
      }
    } finally {
      askingTrust = false
    }
  }
  const st = get()
  if (st.running) return false
  let input: TurnInput
  if (editId) {
    const m = st.chat.messages.find((x) => x.id === editId && x.role === 'user')
    if (!m) return false
    input = { chips: m.chips ?? [], quotes: m.quotes ?? [], images: sentImages.get(editId) ?? (m.images ?? []).filter(Boolean).map(fromThumb) }
  } else input = { chips: st.chips, images: st.images, quotes: st.quotes.map((q) => q.text) }
  const { text, needsImage } = expandQuick(raw)
  if (!text.trim() && !input.images.length && !input.quotes.length) return false
  const prov = currentProvider()
  if (!prov?.available) {
    set({ status: prov?.reason ?? t('Провайдер недоступен') })
    return false
  }
  if (needsImage && !input.images.length) {
    const u = await underlayAttachment().catch(() => null)
    if (!u) {
      set({ status: t('Приложите фото плана (скрепка или Ctrl+V) или добавьте подложку') })
      return false
    }
    input = { ...input, images: [u] }
  }
  const runId = uid()
  const userMsg: AiMessage = {
    id: uid(),
    role: 'user',
    createdAt: now(),
    parts: [{ type: 'text', text: raw.trim() || (input.quotes.length ? '' : t('(изображение)')) }],
    chips: input.chips.length ? input.chips : undefined,
    images: input.images.length ? await Promise.all(input.images.map((im) => thumb(im.url))) : undefined,
    quotes: input.quotes.length ? input.quotes : undefined,
  }
  // the pictures were being made: a turn may have started meanwhile, or the chat changed
  if (get().running || (editId && !hasUserMsg(editId))) return false
  const asst: AiMessage = { id: uid(), role: 'assistant', createdAt: now(), parts: [] }
  const settings = get().settings
  if (editId) {
    // what the dropped turns proposed in plan mode goes with them; earlier proposals stay
    cutDraft(editId)
    const chatId = get().chat.id
    // what a stopped turn of the old conversation still reports must not bring its session back
    for (const s of stoppedRuns.values()) if (s.chatId === chatId) s.cut = true
    patchChat((c) => {
      const i = c.messages.findIndex((m) => m.id === editId)
      c.messages.splice(i)
      delete c.resume
      delete c.resumeCwd
      delete c.apiHistory
      if (i === 0) c.title = ''
    })
  }
  // the chat so far, for an agent that starts without its own memory of it (main decides)
  const before = get().chat.messages
  const history = before.length ? chatTranscript(before) : undefined
  // an empty draft left by an earlier turn was taken from the plan as it was then
  if (settings.planMode && (!draft || draft.empty)) draft = new DraftHost()
  // a turn of an older draft (or none) is told apart by its record being gone
  for (const [id, r] of turnDrafts) if (r.host !== draft) turnDrafts.delete(id)
  turnDrafts.set(userMsg.id, { host: draft, mark: draft?.mark(), changes: get().draftChanges.length })
  partIndex = new Map()
  patchChat((c) => {
    c.messages.push(userMsg, asst)
    if (!c.title) c.title = (raw.trim() || input.quotes[0] || t('Изображение')).replace(/\s+/g, ' ').slice(0, 60)
    c.provider = settings.provider
    c.updatedAt = now()
  })
  rememberImages(userMsg.id, input.images)
  // an edit leaves the input box as it is
  const marks = markIds(input.chips)
  set({ running: { runId, msgId: asst.id, ...(marks.length ? { marks } : {}) }, ...(editId ? {} : { chips: [], images: [], quotes: [] }), status: t('Запуск…'), showHistory: false })
  const chat = get().chat
  try {
    await api.aiChat.run({
      runId,
      chatId: chat.id,
      // a shared pre-0.6 chat runs in its own agent folder, where its sessions are
      projectPath: chatRef(),
      projectRoot: null,
      settings,
      text: quoteMarkdown(input.quotes) + text,
      images: input.images.map(({ mime, data, name }) => ({ mime, data, name })),
      chips: input.chips,
      resumeId: chat.resume?.[settings.provider],
      resumeCwd: chat.resumeCwd?.[settings.provider],
      apiHistory: settings.provider === 'api' ? chat.apiHistory : undefined,
      history,
    })
  } catch (e) {
    onRunEvent(runId, { type: 'done', ok: false, error: (e as Error).message })
  }
  return true
}

/**
 * Stops the turn at once: main kills the agent and revokes its access, and here the run is closed
 * right away, so a tool call already on its way is refused instead of landing in whatever document
 * is open by then. `save` = store the chat now. What main still reports for the stopped turn (its
 * usage, the API history, the agent session) is kept: see stoppedRuns.
 */
export function stop(save = true): void {
  const r = get().running
  if (!r) return
  const ref = chatRef()
  stoppedRuns.set(r.runId, { chatId: get().chat.id, msgId: r.msgId, ref, noSession: voidSessions.has(r.runId), stoppedIn: ref, drops: dropsOf(ref) })
  void api.aiChat.stop(r.runId)
  finishTurn({ type: 'done', ok: false, stopped: true }, save)
}

/**
 * Turns stopped here that main is still winding down: their last usage, API history (the request and
 * the edits the model already made) and agent session id still belong to the chat record.
 */
const stoppedRuns = new Map<string, StoppedRun>()
interface StoppedRun {
  chatId: string
  msgId: string
  /** where the chat lives now (a Save As that moved the chats moves it too) */
  ref: string | null
  noSession?: boolean
  /** an earlier message of its chat was edited since: its session and API history are of the old conversation */
  cut?: boolean
  /** the reference it was stopped in, and how many session drops that reference had then */
  stoppedIn: string | null
  drops: number
}
/** the turn's agent session no longer belongs to its chat */
const sessionGone = (s: StoppedRun) => !!s.noSession || dropsOf(s.stoppedIn) !== s.drops
/** turns whose agent session no longer belongs to the chat (it was copied / moved away from its folder) */
const voidSessions = new Set<string>()

/** the events of a turn that change the chat record itself (not what is shown while it runs) */
function recordEvent(c: AiChatRecord, msgId: string, ev: AiRunEvent): void {
  if (ev.type === 'session') {
    c.resume = { ...(c.resume ?? {}), [c.provider]: ev.id }
    if (ev.cwd) c.resumeCwd = { ...(c.resumeCwd ?? {}), [c.provider]: ev.cwd }
  }
  else if (ev.type === 'apiHistory') c.apiHistory = ev.messages
  else if (ev.type === 'usage') {
    const m = c.messages.find((x) => x.id === msgId)
    if (m) {
      m.usage = {
        inputTokens: (m.usage?.inputTokens ?? 0) + (ev.inputTokens ?? 0),
        outputTokens: (m.usage?.outputTokens ?? 0) + (ev.outputTokens ?? 0),
        costUsd: ev.costUsd !== undefined ? (m.usage?.costUsd ?? 0) + ev.costUsd : m.usage?.costUsd,
      }
    }
    const tt = c.totals ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    c.totals = { inputTokens: tt.inputTokens + (ev.inputTokens ?? 0), outputTokens: tt.outputTokens + (ev.outputTokens ?? 0), costUsd: tt.costUsd + (ev.costUsd ?? 0) }
  }
}

function onStoppedRunEvent(runId: string, ev: AiRunEvent): void {
  const s = stoppedRuns.get(runId)
  if (!s) return
  if (ev.type === 'done') {
    stoppedRuns.delete(runId)
    voidSessions.delete(runId)
    return
  }
  if (ev.type !== 'session' && ev.type !== 'apiHistory' && ev.type !== 'usage') return
  if (ev.type === 'session' && sessionGone(s)) return
  if (s.cut && ev.type !== 'usage') return
  if (get().chat.id === s.chatId && chatRef() === s.ref) {
    patchChat((c) => recordEvent(c, s.msgId, ev))
    void persist()
    return
  }
  // the user moved on to another chat: update the saved record, after the save that leaving it issued
  void queueWrite(async () => {
    // a claim queued before this write may have ended the id's sessions meanwhile
    if (ev.type === 'session' && sessionGone(s)) return
    const rec = await api.aiChat.loadChat(s.ref, s.chatId)
    if (rec) await api.aiChat.saveChat(s.ref, produce(rec, (c) => recordEvent(c, s.msgId, ev)))
  }).catch((e) => console.error('[doplan] saving a stopped turn failed', e))
}

function finishTurn(ev: Extract<AiRunEvent, { type: 'done' }>, save: boolean): void {
  for (const [, res] of approvals) res(false)
  approvals.clear()
  for (const [, res] of questions) res(null)
  questions.clear()
  patchRunMsg((m) => {
    for (const p of m.parts) {
      if (p.type === 'tool' && (p.status === 'running' || p.status === 'pending')) p.status = ev.ok ? 'done' : 'error'
      if (p.type === 'question' && p.status === 'pending') p.status = 'cancelled'
    }
    if (ev.stopped) pushPart(m, null, { type: 'notice', level: 'info', text: t('Остановлено') })
    else if (!ev.ok && ev.error) {
      m.error = ev.error
      // CLIs often print the same failure as the assistant's text: show it once, as an error
      const last = m.parts.at(-1)
      if (last?.type === 'text' && last.text.trim() === ev.error.trim()) m.parts.pop()
      pushPart(m, null, { type: 'notice', level: 'error', text: ev.error, ...(ev.authRequired ? { login: get().settings.provider } : {}) })
    }
    if (!m.parts.length) pushPart(m, null, { type: 'notice', level: 'warning', text: t('Пустой ответ') })
  })
  patchChat((c) => {
    c.updatedAt = now()
  })
  const sent = get().running?.marks
  set({ running: null, asking: null, status: '' })
  // a plan-mode turn that proposed nothing leaves no draft
  if (draft?.empty) draft = null
  // the marks are in the chat now: the plan lets them go (kept when the turn failed or was stopped, to send again)
  if (sent?.length && ev.ok && !ev.stopped) letGoOfSentMarks(sent)
  if (ev.authRequired) void refreshProviders(false)
  if (save) void persist()
}

function onRunEvent(runId: string, ev: AiRunEvent): void {
  const r = get().running
  if (!r || r.runId !== runId) {
    onStoppedRunEvent(runId, ev)
    return
  }
  switch (ev.type) {
    case 'status':
      set({ status: ev.text })
      return
    case 'session':
      if (voidSessions.has(runId)) return
      patchChat((c) => recordEvent(c, r.msgId, ev))
      return
    case 'apiHistory':
    case 'usage':
      patchChat((c) => recordEvent(c, r.msgId, ev))
      return
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
    case 'notice':
      patchRunMsg((m) => pushPart(m, null, { type: 'notice', level: ev.level, text: ev.text }))
      return
    case 'done':
      voidSessions.delete(runId)
      finishTurn(ev, true)
      return
  }
}

async function onToolCall(call: AiToolCall): Promise<void> {
  const r = get().running
  if (!r || r.runId !== call.runId) {
    api.aiChat.toolResult(call.callId, { ok: false, text: 'Запуск не активен' })
    return
  }
  if (call.tool === 'ask_user') return askUser(call)
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
      result: ask ? describeCall(call.tool, call.args, hostNames(liveHost())) : undefined,
    }),
  )
  const setPart = (fn: (p: Extract<AiPart, { type: 'tool' }>) => void) =>
    patchRunMsg((m) => {
      const i = partIndex.get(call.callId)
      const p = i !== undefined ? m.parts[i] : undefined
      if (p && p.type === 'tool') fn(p)
    })

  if (ask) {
    // tools that can show their effect beforehand (apply_measurement: before → after)
    const pv = previewCall(liveHost(), call.tool, call.args)
    if (pv && !pv.ok) {
      setPart((p) => {
        p.status = 'error'
        p.result = pv.error
      })
      api.aiChat.toolResult(call.callId, { ok: false, text: pv.error })
      return
    }
    if (pv?.ok)
      setPart((p) => {
        p.changes = pv.changes
      })
    const yes = await new Promise<boolean>((res) => approvals.set(call.callId, res))
    approvals.delete(call.callId)
    if (get().running?.runId !== call.runId) {
      api.aiChat.toolResult(call.callId, { ok: false, text: 'Запуск остановлен' })
      return
    }
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
  if (plan && mutating && out.result.ok && draft) set({ draftCount: draft.count, draftChanges: [...get().draftChanges, ...(out.changes ?? [describeCall(call.tool, call.args, hostNames(host))])] })
  api.aiChat.toolResult(call.callId, out.result)
  // keep stored chats small: snapshot images are re-encoded as thumbnails
  if (img) {
    const t = await thumb(img)
    setPart((p) => {
      p.image = t || undefined
    })
  }
}

/** ask_user: the card above the input box waits for the user; the answer goes back as the tool result */
async function askUser(call: AiToolCall): Promise<void> {
  const parsed = parseToolArgs('ask_user', call.args)
  if (!parsed.ok) {
    api.aiChat.toolResult(call.callId, { ok: false, text: parsed.error })
    return
  }
  const qs: AiQuestion[] = parsed.args.questions
  // one card at a time: a call that comes while another is open waits for it
  let release!: () => void
  const prev = askQueue
  askQueue = new Promise<void>((r) => (release = r))
  queuedAsks.add(call.callId)
  try {
    await prev
    // main gave up on it while it waited (it already has its result)
    if (!queuedAsks.delete(call.callId)) return
    if (get().running?.runId !== call.runId) {
      api.aiChat.toolResult(call.callId, { ok: false, text: 'Запуск остановлен' })
      return
    }
    await showQuestion(call, qs)
  } finally {
    queuedAsks.delete(call.callId)
    release()
  }
}

/** ask_user calls in line behind the open card (Claude Code may run two calls of one message at once) */
let askQueue: Promise<void> = Promise.resolve()
const queuedAsks = new Set<string>()

type AskResult = { answers: AiQuestionAnswer[]; note?: string; quotes?: string[]; chips?: AiChip[]; image?: PendingImage } | null

async function showQuestion(call: AiToolCall, qs: AiQuestion[]): Promise<void> {
  const setPart = (fn: (p: Extract<AiPart, { type: 'question' }>) => void) =>
    patchRunMsg((m) => {
      const i = partIndex.get(call.callId)
      const p = i !== undefined ? m.parts[i] : undefined
      if (p && p.type === 'question') fn(p)
    })
  patchRunMsg((m) => pushPart(m, call.callId, { type: 'question', id: call.callId, questions: qs, status: 'pending' }))
  set({ asking: { callId: call.callId, runId: call.runId, questions: qs, draft: qs.map(() => ({ picked: [] })) }, status: '' })
  void persist()
  const res = await new Promise<AskResult>((r) => questions.set(call.callId, r))
  questions.delete(call.callId)
  if (get().asking?.callId === call.callId) set({ asking: null })
  // the turn ended meanwhile (Stop, another chat or project): the answer belongs to no turn now
  if (get().running?.runId !== call.runId) {
    api.aiChat.toolResult(call.callId, { ok: false, text: 'Запуск остановлен' })
    return
  }
  if (!res) {
    setPart((p) => {
      p.status = 'cancelled'
    })
    api.aiChat.toolResult(call.callId, {
      ok: false,
      text: 'Пользователь не стал отвечать на вопросы. Не выдумывай ответы: сделай то, что можно без них, и перечисли, что осталось уточнить.',
    })
  } else {
    setPart((p) => {
      p.status = 'answered'
      p.answers = res.answers
      if (res.note) p.note = res.note
      if (res.quotes?.length) p.quotes = res.quotes
    })
    // what was attached in the chat box goes with the answer: the chips as context, the picture as the result's image
    const ctx = res.chips?.length ? `\n\nПользователь приложил к ответу:\n${res.chips.map((c) => `- ${c.kind} ${c.id}: ${c.summary}`.slice(0, 6000)).join('\n')}` : ''
    const pic = res.image ? '\n\nК ответу приложено изображение (ниже).' : ''
    const quoted = res.quotes?.length ? `\n\nПользователь процитировал из переписки:\n${quoteMarkdown(res.quotes).trimEnd()}` : ''
    api.aiChat.toolResult(call.callId, {
      ok: true,
      text: formatAnswers(qs, res.answers, res.note) + quoted + ctx + pic,
      ...(res.image ? { image: { mime: res.image.mime === 'image/png' ? 'image/png' : 'image/jpeg', data: res.image.data } } : {}),
    })
  }
  void persist()
}

/** a click on an option of the open question card (multi-select toggles; otherwise one choice, a second click clears it) */
export function pickAnswer(qi: number, label: string): void {
  const a = get().asking
  if (!a?.questions[qi]) return
  const multi = !!a.questions[qi].multiSelect
  set({
    asking: produce(a, (d) => {
      const cur = d.draft[qi]
      if (multi) cur.picked = cur.picked.includes(label) ? cur.picked.filter((x) => x !== label) : [...cur.picked, label]
      else cur.picked = cur.picked[0] === label ? [] : [label]
    }),
  })
}

/** the «Другое» field of one question */
export function setAnswerOther(qi: number, text: string): void {
  const a = get().asking
  if (!a?.draft[qi]) return
  set({
    asking: produce(a, (d) => {
      d.draft[qi].other = text
    }),
  })
}

/** sends what the card holds; `note`: the text typed in the chat box; null = the user declined to answer */
export function answerQuestion(note?: string | null): void {
  const a = get().asking
  const res = a && questions.get(a.callId)
  if (!a || !res) return
  if (note === null) return res(null)
  // quotes, chips and a picture in the chat box are part of the answer (a tool result carries one picture:
  // the others stay in the box for the next message, and the user is told so)
  const { chips, images, quotes, running } = get()
  const image = images.find((im) => im.mime === 'image/jpeg' || im.mime === 'image/png')
  const marks = [...new Set([...(running?.marks ?? []), ...markIds(chips)])]
  set({
    ...(running && marks.length ? { running: { ...running, marks } } : {}),
    chips: [],
    quotes: [],
    images: image ? images.filter((im) => im !== image) : images,
    status: images.length > (image ? 1 : 0) ? t('К ответу приложено одно изображение, остальные остались в поле ввода') : get().status,
  })
  res({
    answers: a.draft.map((d) => ({ picked: d.picked, ...(d.other?.trim() ? { other: d.other.trim() } : {}) })),
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(quotes.length ? { quotes: quotes.map((q) => q.text) } : {}),
    ...(chips.length ? { chips } : {}),
    ...(image ? { image } : {}),
  })
}

/** something to send: an option picked, a «Другое» text, a note, or quotes / chips / a picture in the chat box */
export function hasAnswer(a: AiState['asking'], note = '', attached = false): boolean {
  return attached || !!note.trim() || !!a?.draft.some((d) => d.picked.length || d.other?.trim())
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

/**
 * Editing user message `msgId` drops the turns from it on: the draft goes back to where that turn found it.
 * A draft that turn did not find (it started then or later) goes entirely; its proposed parts are all in the
 * dropped messages, so there is nothing to mark. Nothing changes when the dropped turns proposed nothing.
 */
function cutDraft(msgId: string): void {
  const rec = turnDrafts.get(msgId)
  if (draft && rec?.host === draft && rec.mark) {
    draft.rollback(rec.mark)
    set({ draftCount: draft.count, draftChanges: get().draftChanges.slice(0, rec.changes) })
    if (draft.empty) draft = null
  } else if (draft || get().draftCount || get().draftChanges.length) {
    draft = null
    set({ draftCount: 0, draftChanges: [] })
  }
}

/** drops the plan-mode proposal; true when there was one (the chat changed) */
export function discardDraft(): boolean {
  draft = null
  if (!get().draftCount && !get().draftChanges.length) return false
  patchChat((c) => {
    for (const m of c.messages) for (const p of m.parts) if (p.type === 'tool' && p.status === 'proposed') p.status = 'rejected'
  })
  set({ draftCount: 0, draftChanges: [] })
  return true
}
