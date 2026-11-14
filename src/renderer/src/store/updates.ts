/**
 * Renderer side of auto-update: mirrors main's UpdateState, decides when the update notice shows,
 * runs the manual «Проверить обновления» and «Перезапустить и установить».
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { noticeFor, statusVersion, type UpdateState, type UpdateStatus } from '@shared/updater'
import { addTranslations, t } from '@/i18n'
import { confirmDiscard } from '@/actions/project'
import { api } from './api'
import { toast } from './notify'

addTranslations('en', {
  'Доступна версия {v}': 'Version {v} is available',
  'Версия {v} готова к установке': 'Version {v} is ready to install',
  'Скачивание… {p}%': 'Downloading… {p}%',
  'Скачивание…': 'Downloading…',
  'Перезапустить и установить': 'Restart and install',
  Позже: 'Later',
  Скрыть: 'Hide',
  'Что нового': "What's new",
  'Открыть страницу загрузки': 'Open download page',
  'Портативную версию нужно скачать заново: автообновление работает только в установленной.':
    'The portable version has to be downloaded again: auto-update works only in the installed one.',
  'Не удалось обновиться до версии {v}': 'Could not update to version {v}',
  Повторить: 'Retry',
  'Проверить обновления': 'Check for updates',
  'Проверить обновления…': 'Check for updates…',
  'Проверка обновлений…': 'Checking for updates…',
  'У вас последняя версия ({v})': 'You have the latest version ({v})',
  'Нет связи с сервером обновлений': 'No connection to the update server',
  'Нет связи': 'No connection',
  'Не удалось проверить обновления: {m}': 'Could not check for updates: {m}',
  'Обновления работают только в установленной версии программы': 'Updates work only in the installed version of the app',
  'Обновление установится при выходе из программы': 'The update will be installed when you quit the app',
  'Не удалось установить обновление: {m}': 'Could not install the update: {m}',
})

interface UpdatesUiState {
  state: UpdateState
  /** version whose notice the user closed with «Позже»/«Скрыть» */
  dismissed: string | null
  /** a manual check is running (menu / About) */
  manual: boolean
}

export const updatesStore = createStore<UpdatesUiState>()(() => ({
  state: { mode: 'disabled', current: api.version, status: { kind: 'idle' } },
  dismissed: null,
  manual: false,
}))

export function useUpdates<T>(selector: (s: UpdatesUiState) => T): T {
  return useStore(updatesStore, selector)
}

/** what the notice card shows, or null when it is hidden */
export function visibleNotice(ui: Pick<UpdatesUiState, 'state' | 'dismissed'>): UpdateStatus | null {
  return noticeFor(ui.state, ui.dismissed)
}

function apply(next: UpdateState): void {
  updatesStore.setState({ state: next })
}

/** subscribe to main once at boot; returns the unsubscribe */
export function initUpdates(): () => void {
  const off = api.updates.onState(apply)
  api.updates
    .get()
    .then(apply)
    .catch(() => {
      /* web fallback / IPC unavailable: keep disabled */
    })
  return off
}

export function dismissNotice(): void {
  const s = updatesStore.getState().state.status
  const v = statusVersion(s)
  updatesStore.setState({ dismissed: v })
  if (s.kind === 'downloaded' || s.kind === 'progress') toast(t('Обновление установится при выходе из программы'), 'info', 5000)
}

/** «Проверить обновления»: always answers with a toast or by (re)opening the notice */
export async function checkForUpdatesManually(): Promise<void> {
  if (updatesStore.getState().manual) return
  const { mode } = updatesStore.getState().state
  if (mode === 'disabled') {
    toast(t('Обновления работают только в установленной версии программы'), 'info', 5000)
    return
  }
  updatesStore.setState({ manual: true, dismissed: null })
  toast(t('Проверка обновлений…'), 'info', 2000)
  let next: UpdateState
  try {
    next = await api.updates.check()
  } catch (err) {
    updatesStore.setState({ manual: false })
    toast(t('Не удалось проверить обновления: {m}', { m: err instanceof Error ? err.message : String(err) }), 'error', 6000)
    return
  }
  updatesStore.setState({ manual: false, state: next })
  const s = next.status
  if (s.kind === 'not-available' || s.kind === 'idle') toast(t('У вас последняя версия ({v})', { v: next.current }), 'success', 4000)
  else if (s.kind === 'error' && !s.version) {
    if (s.offline) toast(t('Нет связи с сервером обновлений'), 'warning', 5000)
    else toast(t('Не удалось проверить обновления: {m}', { m: s.message }), 'error', 7000)
  }
  // available / progress / downloaded / failed download: the notice card is shown (dismissed was reset)
}

export async function installUpdate(): Promise<void> {
  if (!(await confirmDiscard())) return
  try {
    await api.project.clearRecovery()
  } catch {
    /* ignore */
  }
  try {
    await api.updates.install()
  } catch (err) {
    toast(t('Не удалось установить обновление: {m}', { m: err instanceof Error ? err.message : String(err) }), 'error', 7000)
  }
}

export function openReleasePage(version?: string): void {
  void api.updates.openReleasePage(version).catch(() => {})
}
