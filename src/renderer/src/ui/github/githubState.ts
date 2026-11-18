/** How a project's GitHub state is shown: icon, short label and a sentence (header button, dialog, inspector). */
import { Cloud, CloudAlert, CloudCheck, CloudDownload, CloudOff, CloudUpload, type LucideIcon } from 'lucide-react'
import type { GithubSyncStatus } from '@shared/github'
import type { t as tFn } from '@/i18n'

export interface GithubStateView {
  icon: LucideIcon
  /** counters next to the icon, e.g. «↑2 ↓1» */
  badge: string
  /** one sentence for the tooltip and the dialog */
  text: string
  tone: 'muted' | 'ok' | 'warn' | 'error'
  connected: boolean
}

export function githubStateView(st: GithubSyncStatus | null, t: typeof tFn): GithubStateView {
  if (!st) return { icon: Cloud, badge: '', text: t('Проверяю GitHub…'), tone: 'muted', connected: false }
  const connected = !!st.remote
  const repo = st.remote?.owner ? `${st.remote.owner}/${st.remote.repo}` : (st.remote?.url ?? '')
  const up = st.ahead ? `↑${st.ahead}` : ''
  const down = st.behind ? `↓${st.behind}` : ''
  const badge = [up, down].filter(Boolean).join(' ')
  let v: GithubStateView
  switch (st.state) {
    case 'unavailable':
      return { icon: CloudOff, badge: '', text: st.reason ?? t('Синхронизация с GitHub недоступна'), tone: 'muted', connected: false }
    case 'disconnected':
      return { icon: Cloud, badge: '', text: t('Проект не подключён к GitHub'), tone: 'muted', connected: false }
    case 'notPushed':
      v = { icon: CloudUpload, badge: '', text: t('Подключено к {repo}, но проект ещё не отправлен', { repo }), tone: 'warn', connected }
      break
    case 'synced':
      v = { icon: CloudCheck, badge: '', text: t('Синхронизировано с {repo}', { repo }), tone: 'ok', connected }
      break
    case 'ahead':
      v = { icon: CloudUpload, badge, text: t('Есть неотправленные версии ({n}) — нажмите «Отправить на GitHub»', { n: st.ahead }), tone: 'warn', connected }
      break
    case 'behind':
      v = { icon: CloudDownload, badge, text: t('На GitHub есть новые версии ({n}) — нажмите «Получить изменения»', { n: st.behind }), tone: 'warn', connected }
      break
    case 'diverged':
      v = {
        icon: CloudAlert,
        badge,
        text: t('Новые версии есть и здесь ({a}), и на GitHub ({b}): получите изменения, затем отправьте свои', { a: st.ahead, b: st.behind }),
        tone: 'warn',
        connected,
      }
      break
  }
  if (st.error) return { ...v, icon: CloudAlert, text: `${t('Не удалось проверить GitHub:')} ${st.error}`, tone: 'error' }
  return v
}

/** tailwind text colour of a tone */
export const toneClass: Record<GithubStateView['tone'], string> = {
  muted: 'text-muted',
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-danger',
}
