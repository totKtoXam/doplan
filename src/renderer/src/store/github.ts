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
import { alertDialog, confirmDialog, toast } from './notify'
import { projectStore } from './project'

export type GithubBusy = 'push' | 'pull' | 'connect' | 'resolve' | 'disconnect' | 'check' | null

interface GithubUiState {
  status: GithubSyncStatus | null
  busy: GithubBusy
  dialog: 'connect' | 'conflict' | null
  /** files changed on both sides (conflict dialog) */
  conflicts: string[]
  /** send right after the conflict is settled (the user pressed «Отправить») */
  pushAfterResolve: boolean
}

export const githubStore = createStore<GithubUiState>()(() => ({
  status: null,
  busy: null,
  dialog: null,
  conflicts: [],
  pushAfterResolve: false,
}))

export function useGithub<T>(selector: (s: GithubUiState) => T): T {
  return useStore(githubStore, selector)
}

const set = (p: Partial<GithubUiState>) => githubStore.setState(p)

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

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
async function ensureSaved(): Promise<boolean> {
  if (projectStore.getState().viewing) {
    await alertDialog(t('Открыта старая версия'), t('Вернитесь к текущей версии («К текущей»), потом синхронизируйте с GitHub.'))
    return false
  }
  if (!docStore.getState().dirty) return true
  return saveProject(false)
}

/** the open project read again from its folder after GitHub changed it */
async function reloadFromDisk(): Promise<void> {
  const root = projectStore.getState().root
  if (root) await openProject(root, { skipConfirm: true, reload: 'disk' })
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

/** what a pull brought: reload, a note, or the conflict choice */
async function afterPull(res: PullResult, thenPush: boolean): Promise<boolean> {
  set({ status: res.status })
  if (res.result === 'conflict') {
    set({ dialog: 'conflict', conflicts: res.conflicts ?? [], pushAfterResolve: thenPush })
    return false
  }
  if (res.result === 'updated' || res.result === 'merged') {
    await reloadFromDisk()
    toast(res.result === 'merged' ? t('Изменения с GitHub объединены с вашими') : t('Получены изменения с GitHub'), 'success')
  }
  return true
}

async function pushNow(): Promise<void> {
  const res = await api.github.push()
  set({ status: res.status })
  if (res.needPull) {
    toast(t('На GitHub есть новые версии — сначала получаю их'), 'info')
    const pr = await api.github.pull()
    if (!(await afterPull(pr, true))) return
    return pushNow()
  }
  showWarnings(res.warnings)
  toast(t('Отправлено на GitHub'), 'success')
}

export async function githubPush(): Promise<void> {
  if (!(await ensureSaved())) return
  await run('push', pushNow)
}

export async function githubPull(): Promise<void> {
  if (!(await ensureSaved())) return
  await run('pull', async () => {
    const res = await api.github.pull()
    if (res.result === 'upToDate') {
      set({ status: res.status })
      toast(t('На GitHub нет ничего нового'), 'info')
      return
    }
    await afterPull(res, false)
  })
}

export async function githubResolve(choice: ConflictChoice): Promise<void> {
  const thenPush = githubStore.getState().pushAfterResolve
  set({ dialog: null, conflicts: [], pushAfterResolve: false })
  await run('resolve', async () => {
    const res = await api.github.resolve(choice)
    set({ status: res.status })
    await reloadFromDisk()
    if (res.copyPath) {
      const copy = res.copyPath
      toast(t('Версия с GitHub сохранена отдельным проектом: {name}', { name: copy.split(/[\\/]/).pop() ?? copy }), 'success', 12000, {
        label: t('Открыть'),
        run: () => void openProject(copy),
      })
    } else toast(choice === 'theirs' ? t('Взята версия с GitHub') : t('Оставлена ваша версия'), 'success')
    if (thenPush) await pushNow()
  })
}

export function githubCancelConflict(): void {
  set({ dialog: null, conflicts: [], pushAfterResolve: false })
}

async function afterConnect(res: ConnectResult): Promise<void> {
  set({ status: res.status, dialog: null })
  showWarnings(res.warnings)
  if (res.pull && !(await afterPull(res.pull, true))) return
  if (res.pushed) toast(t('Проект отправлен на GitHub'), 'success')
  else if (res.pull?.result !== 'conflict') await pushNow()
}

/** connects an existing repository; resolves with an error text to show in the dialog, or null */
export async function githubConnect(url: string): Promise<string | null> {
  if (!(await ensureSaved())) return null
  if (githubStore.getState().busy) return null
  set({ busy: 'connect' })
  try {
    await afterConnect(await api.github.connect(url))
    return null
  } catch (err) {
    return errText(err)
  } finally {
    set({ busy: null })
  }
}

export async function githubCreate(name: string, isPrivate: boolean): Promise<string | null> {
  if (!(await ensureSaved())) return null
  if (githubStore.getState().busy) return null
  set({ busy: 'connect' })
  try {
    await afterConnect(await api.github.create(name, isPrivate))
    return null
  } catch (err) {
    return errText(err)
  } finally {
    set({ busy: null })
  }
}

export async function githubDisconnect(): Promise<void> {
  const st = githubStore.getState().status
  const name = st?.remote?.owner ? `${st.remote.owner}/${st.remote.repo}` : (st?.remote?.url ?? '')
  const ok = await confirmDialog(
    t('Отключить от GitHub?'),
    t('Проект перестанет синхронизироваться с репозиторием {name}. Сам репозиторий на GitHub и все версии на этом компьютере останутся; подключить снова можно в любой момент.', { name }),
    { ok: t('Отключить'), cancel: t('Отмена') },
  )
  if (!ok) return
  await run('disconnect', async () => {
    set({ status: await api.github.disconnect() })
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
 * every 5 minutes while the window is visible.
 */
export function startGithubWatch(): void {
  if (started || api.platform === 'browser') return
  started = true
  let lastRoot: string | null | undefined
  let lastRev = -1
  projectStore.subscribe((s) => {
    if (s.root !== lastRoot) {
      lastRoot = s.root
      set({ status: null })
      void refreshGithub(true)
    } else if (s.historyRev !== lastRev) {
      void refreshGithub(false)
    }
    lastRev = s.historyRev
  })
  docStore.subscribe((s, prev) => {
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
