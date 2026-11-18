/** One line in the inspector's «Папка проекта» section: the project's GitHub state and a button to the GitHub dialog. */
import clsx from 'clsx'
import { useT } from '@/i18n'
import { openGithubDialog, useGithub } from '@/store/github'
import { Button } from '@/ui/kit'
import { githubStateView, toneClass } from './githubState'

export function GithubFolderRow() {
  const t = useT()
  const status = useGithub((s) => s.status)
  if (!status || status.state === 'unavailable') return null
  const view = githubStateView(status, t)
  const Icon = view.icon
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
      <Icon size={12} className={clsx('shrink-0', view.connected && toneClass[view.tone])} />
      <span className="min-w-0 flex-1 truncate" title={view.text}>
        {view.connected ? view.text : t('GitHub не подключён')}
      </span>
      <Button size="sm" onClick={openGithubDialog}>
        {view.connected ? t('GitHub…') : t('Подключить…')}
      </Button>
    </div>
  )
}
