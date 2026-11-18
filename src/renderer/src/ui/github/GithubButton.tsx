/**
 * The GitHub button in the header: a cloud showing the project's state (synced, versions to send,
 * new versions on GitHub) and a menu with the actions. Not connected yet: it opens the connect
 * dialog. It also hosts the GitHub dialogs.
 */
import clsx from 'clsx'
import { useEffect } from 'react'
import { CloudDownload, CloudUpload, ExternalLink, LoaderCircle, RefreshCw, Settings2, Unplug } from 'lucide-react'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import {
  githubCheckNow,
  githubDisconnect,
  githubPull,
  githubPush,
  openGithubDialog,
  startGithubWatch,
  useGithub,
} from '@/store/github'
import { DropdownMenu, type MenuEntry, Sep, Tip } from '@/ui/shell/primitives'
import { GithubDialogs } from './GithubDialogs'
import { githubStateView, toneClass } from './githubState'

function busyText(busy: string, t: ReturnType<typeof useT>): string {
  switch (busy) {
    case 'push':
      return t('Отправляю на GitHub…')
    case 'pull':
      return t('Получаю изменения с GitHub…')
    case 'connect':
      return t('Подключаю GitHub…')
    case 'resolve':
      return t('Объединяю версии…')
    case 'disconnect':
      return t('Отключаю…')
    default:
      return t('Проверяю GitHub…')
  }
}

export function GithubButton() {
  const t = useT()
  const status = useGithub((s) => s.status)
  const busy = useGithub((s) => s.busy)

  useEffect(() => startGithubWatch(), [])

  if (api.platform === 'browser') return null

  const view = githubStateView(status, t)
  const Icon = busy ? LoaderCircle : view.icon
  const tip = busy ? busyText(busy, t) : view.text

  const button = (open: boolean, onClick: () => void) => (
    // a real box for the menu to anchor to (Tip itself is display: contents)
    <span className="inline-flex">
    <Tip label={tip}>
      <button
        type="button"
        aria-label={`GitHub: ${tip}`}
        onClick={onClick}
        className={clsx(
          'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
          open ? 'bg-active text-text' : 'text-muted hover:bg-hover hover:text-text',
        )}
      >
        <Icon size={15} strokeWidth={1.75} className={clsx(busy ? 'animate-spin' : view.connected && toneClass[view.tone])} />
        <span className="hidden lg:inline">GitHub</span>
        {view.badge && !busy && <span className="font-mono text-[10px] text-warning">{view.badge}</span>}
      </button>
    </Tip>
    </span>
  )

  if (!view.connected) return (
    <>
      {button(false, openGithubDialog)}
      <GithubDialogs />
      <Sep />
    </>
  )

  // a non-GitHub address can be a long path: its last part is enough for a menu header
  const repo = status?.remote?.owner ? `${status.remote.owner}/${status.remote.repo}` : (status?.remote?.url.split(/[\\/:]/).filter(Boolean).pop() ?? '')
  const menu = (): MenuEntry[] => [
    { type: 'header', label: repo },
    { label: t('Отправить на GitHub'), icon: CloudUpload, disabled: !!busy, onSelect: () => void githubPush() },
    { label: t('Получить изменения'), icon: CloudDownload, disabled: !!busy, onSelect: () => void githubPull() },
    { label: t('Проверить сейчас'), icon: RefreshCw, disabled: !!busy, onSelect: () => void githubCheckNow() },
    { type: 'separator' },
    ...(status?.remote?.webUrl ? [{ label: t('Открыть на GitHub'), icon: ExternalLink, onSelect: () => void api.github.openPage('repo') }] : []),
    { label: t('GitHub…'), icon: Settings2, onSelect: openGithubDialog },
    { label: t('Отключить от GitHub…'), icon: Unplug, danger: true, disabled: !!busy, onSelect: () => void githubDisconnect() },
  ]

  return (
    <>
      <DropdownMenu align="right" items={menu} trigger={({ open, toggle }) => button(open, toggle)} />
      <GithubDialogs />
      <Sep />
    </>
  )
}
