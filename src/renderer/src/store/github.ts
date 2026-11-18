/**
 * Renderer side of the GitHub sync (main: githubSync.ts): the open project's state, the actions
 * behind the header button (send, get, connect, disconnect) and the conflict choice. The document is
 * saved before every action, so "send" and "get" always work on what the user sees.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { ConflictChoice, ConnectResult, GithubSyncStatus, PullResult } from '@shared/github'
import { openProject, saveProject } from '@/actions/project'
import { t } from '@/i18n'
import '@/ui/github/githubI18n'
import { api } from './api'
import { docStore } from './document'
import { alertDialog, choiceDialog, confirmDialog, toast } from './notify'
import { projectStore } from './project'

export type GithubBusy = 'push' | 'pull' | 'connect' | 'resolve' | 'disconnect' | 'check' | null

/**
 * The open project's generation: which folder, and which load of it. Every open, reload (after a pull
 * or a merge) and version view starts a new one. Each GitHub action takes it before it awaits main and
 * drops the answer, and every step after it, once the generation has changed: main works on whatever
 * project is open at the moment of the call, so a later step would act on another project.
 */
export interface Generation {
  root: string | null
  loadId: number
}

interface GithubUiState {
  status: GithubSyncStatus | null
  busy: GithubBusy
  dialog: 'connect' | 'conflict' | null
  /** files changed on both sides (conflict dialog) */
  conflicts: string[]
  /** send right after the conflict is settled (the user pressed «Отправить») */
  pushAfterResolve: boolean
  /** the project generation the conflict belongs to */
  conflictGen: Generation | null
}

export const githubStore = createStore<GithubUiState>()(() => ({
  status: null,
  busy: null,
  dialog: null,
  conflicts: [],
  pushAfterResolve: false,
  conflictGen: null,
}))

export function useGithub<T>(selector: (s: GithubUiState) => T): T {
  return useStore(githubStore, selector)
}

const set = (p: Partial<GithubUiState>) => githubStore.setState(p)

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function generation(): Generation {
  return { root: projectStore.getState().root, loadId: docStore.getState().loadId }
}

function current(gen: Generation): boolean {
  const now = generation()
  return now.root === gen.root && now.loadId === gen.loadId
}

/** an answer about a project no longer on screen: forget it, show the open one's own state */
function dropped(): void {
  void refreshGithub(false)
}

/** the open project's state; `fetch` looks at GitHub first */
export async function refreshGithub(fetch = false): Promise<void> {
  if (api.platform === 'browser') return
  const root = projectStore.getState().root
  try {
    const status = await api.github.status(fetch)
    // another project opened meanwhile: its own refresh is on the way
    if (projectStore.getState().root === root) set({ status })
  } catch {
    /* the button keeps the last state */
  }
}

/** saves the document (each save is a version) so sync works on what is on screen; false: not now */
async function ensureSaved(gen: Generation): Promise<boolean> {
  if (projectStore.getState().viewing) {
    await alertDialog(t('Открыта старая версия'), t('Вернитесь к текущей версии («К текущей»), потом синхронизируйте с GitHub.'))
    return false
  }
  if (docStore.getState().dirty && !(await saveProject(false))) return false
  // the save may have waited: the action is for the project it was started on
  return current(gen)
}

/**
 * The open project read again from its folder after GitHub changed it. The editor is locked while
 * GitHub works (GithubSyncLock), so the document is normally clean here; changed anyway, the user
 * decides: nothing is replaced without asking. Resolves with the generation after it (the same one
 * when the user kept the screen), or null when the project on screen is another one by now.
 */
async function reloadFromDisk(gen: Generation): Promise<Generation | null> {
  if (!gen.root || !current(gen)) return null
  if (docStore.getState().dirty) {
    const choice = await choiceDialog(
      t('Проект изменён во время обмена с GitHub'),
      t('Пока шёл обмен с GitHub, в проекте появились несохранённые правки. Загрузить версию, полученную с GitHub (эти правки пропадут), или оставить на экране свои?'),
      [
        { id: 'keep', label: t('Оставить мои правки') },
        { id: 'load', label: t('Загрузить с GitHub'), variant: 'danger' },
      ],
    )
    // the question waited: never read a folder over a project opened in the meantime
    if (!current(gen)) return null
    if (choice !== 'load') return gen
  }
  await openProject(gen.root, { skipConfirm: true, reload: 'disk' })
  // exactly this reload and nothing else: the next generation is ours
  return docStore.getState().loadId === gen.loadId + 1 ? generation() : null
}

async function run<T>(busy: Exclude<GithubBusy, null>, fn: () => Promise<T>): Promise<T | null> {
  if (githubStore.getState().busy) return null
  set({ busy })
  try {
    return await fn()
  } catch (err) {
    await alertDialog(t('GitHub'), errText(err))
    await refreshGithub(false)
    return null
  } finally {
    set({ busy: null })
  }
}

function showWarnings(warnings: string[]): void {
  for (const w of warnings) toast(w, 'warning', 9000)
}

/** what a pull brought: reload, a note, or the conflict choice; resolves with the generation to go on with, null: stop */
async function afterPull(res: PullResult, thenPush: boolean, gen: Generation): Promise<Generation | null> {
  if (!current(gen)) {
    dropped()
    return null
  }
  set({ status: res.status })
  if (res.result === 'conflict') {
    set({ dialog: 'conflict', conflicts: res.conflicts ?? [], pushAfterResolve: thenPush, conflictGen: gen })
    return null
  }
  if (res.result === 'updated' || res.result === 'merged') {
    const next = await reloadFromDisk(gen)
    toast(res.result === 'merged' ? t('Изменения с GitHub объединены с вашими') : t('Получены изменения с GitHub'), 'success')
    return next
  }
  return gen
}

/** sends; GitHub ahead: gets its versions first and sends once more, never in a loop */
async function pushNow(gen: Generation, retried = false): Promise<void> {
  const res = await api.github.push()
  if (!current(gen)) return dropped()
  set({ status: res.status })
  if (res.needPull) {
    if (retried) throw new Error(t('Версии на GitHub снова изменились, пока шла отправка. Попробуйте отправить ещё раз чуть позже.'))
    toast(t('На GitHub есть новые версии — сначала получаю их'), 'info')
    const busy = githubStore.getState().busy
    set({ busy: 'pull' })
    let next: Generation | null
    try {
      next = await afterPull(await api.github.pull(), true, gen)
    } finally {
      set({ busy })
    }
    if (next) await pushNow(next, true)
    return
  }
  showWarnings(res.warnings)
  toast(t('Отправлено на GitHub'), 'success')
}

export async function githubPush(): Promise<void> {
  const gen = generation()
  if (!(await ensureSaved(gen))) return
  await run('push', () => pushNow(gen))
}

export async function githubPull(): Promise<void> {
  const gen = generation()
  if (!(await ensureSaved(gen))) return
  await run('pull', async () => {
    const res = await api.github.pull()
    if (!current(gen)) return dropped()
    if (res.result === 'upToDate') {
      set({ status: res.status })
      toast(t('На GitHub нет ничего нового'), 'info')
      return
    }
    await afterPull(res, false, gen)
  })
}

export async function githubResolve(choice: ConflictChoice): Promise<void> {
  const { pushAfterResolve: thenPush, conflictGen: gen } = githubStore.getState()
  forgetConflict()
  // the conflict belongs to the project it came from: another one on screen has nothing to settle
  if (!gen || !current(gen)) return
  // what is on screen is a version too: resolve() works on the folder, and the reload below replaces the screen
  if (!(await ensureSaved(gen))) return
  await run('resolve', async () => {
    const res = await api.github.resolve(choice)
    if (!current(gen)) return dropped()
    set({ status: res.status })
    const next = await reloadFromDisk(gen)
    if (res.copyPath) {
      const copy = res.copyPath
      toast(t('Версия с GitHub сохранена отдельным проектом: {name}', { name: copy.split(/[\\/]/).pop() ?? copy }), 'success', 12000, {
        label: t('Открыть'),
        run: () => void openProject(copy),
      })
    } else toast(choice === 'theirs' ? t('Взята версия с GitHub') : t('Оставлена ваша версия'), 'success')
    if (thenPush && next) await pushNow(next)
  })
}

function forgetConflict(): void {
  set({ dialog: null, conflicts: [], pushAfterResolve: false, conflictGen: null })
}

export function githubCancelConflict(): void {
  forgetConflict()
}

async function afterConnect(res: ConnectResult, gen: Generation): Promise<void> {
  if (!current(gen)) return dropped()
  set({ status: res.status, dialog: null })
  showWarnings(res.warnings)
  const next = res.pull ? await afterPull(res.pull, true, gen) : gen
  if (!next) return
  if (res.pushed) toast(t('Проект отправлен на GitHub'), 'success')
  else await pushNow(next)
}

/** connects an existing repository; resolves with an error text to show in the dialog, or null */
export async function githubConnect(url: string): Promise<string | null> {
  return connectWith(() => api.github.connect(url))
}

export async function githubCreate(name: string, isPrivate: boolean): Promise<string | null> {
  return connectWith(() => api.github.create(name, isPrivate))
}

async function connectWith(call: () => Promise<ConnectResult>): Promise<string | null> {
  const gen = generation()
  if (!(await ensureSaved(gen))) return null
  if (githubStore.getState().busy) return null
  set({ busy: 'connect' })
  try {
    await afterConnect(await call(), gen)
    return null
  } catch (err) {
    return errText(err)
  } finally {
    set({ busy: null })
  }
}

export async function githubDisconnect(): Promise<void> {
  const gen = generation()
  const st = githubStore.getState().status
  const name = st?.remote?.owner ? `${st.remote.owner}/${st.remote.repo}` : (st?.remote?.url ?? '')
  const ok = await confirmDialog(
    t('Отключить от GitHub?'),
    t('Проект перестанет синхронизироваться с репозиторием {name}. Сам репозиторий на GitHub и все версии на этом компьютере останутся; подключить снова можно в любой момент.', { name }),
    { ok: t('Отключить'), cancel: t('Отмена') },
  )
  // the question was about the project open when it was asked
  if (!ok || !current(gen)) return
  await run('disconnect', async () => {
    const status = await api.github.disconnect()
    if (!current(gen)) return dropped()
    set({ status })
    toast(t('Проект отключён от GitHub'), 'info')
  })
}

export async function githubCheckNow(): Promise<void> {
  await run('check', () => refreshGithub(true))
}

export function openGithubDialog(): void {
  set({ dialog: 'connect' })
}

export function closeGithubDialog(): void {
  set({ dialog: null })
}

let started = false
/**
 * Keeps the state current: on every project open, after each saved version, and a look at GitHub
 * every 5 minutes while the window is visible. A new project generation closes the GitHub dialogs:
 * they were about the project that was open.
 */
export function startGithubWatch(): void {
  if (started || api.platform === 'browser') return
  started = true
  let lastRoot: string | null | undefined
  let lastRev = -1
  projectStore.subscribe((s) => {
    if (s.root !== lastRoot) {
      lastRoot = s.root
      forgetConflict()
      set({ status: null })
      void refreshGithub(true)
    } else if (s.historyRev !== lastRev) {
      void refreshGithub(false)
    }
    lastRev = s.historyRev
  })
  docStore.subscribe((s, prev) => {
    if (s.loadId !== prev.loadId) forgetConflict()
    // a save (dirty → clean) may have added a version
    if (prev.dirty && !s.dirty) void refreshGithub(false)
  })
  lastRoot = projectStore.getState().root
  lastRev = projectStore.getState().historyRev
  void refreshGithub(true)
  window.setInterval(
    () => {
      const st = githubStore.getState().status
      if (document.visibilityState === 'visible' && st && st.state !== 'disconnected' && st.state !== 'unavailable' && !githubStore.getState().busy) void refreshGithub(true)
    },
    5 * 60_000,
  )
}
