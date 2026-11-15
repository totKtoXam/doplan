/**
 * «О программе doplan»: version, live update status and «Проверить обновления» /
 * «Перезапустить и установить» (installed build) or «Открыть страницу загрузки» (portable).
 */
import { Check, Download, ExternalLink, RefreshCw, TriangleExclamationPoint } from 'lucide-react'
import type { ReactNode } from 'react'
import type { UpdateState } from '@shared/updater'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import { checkForUpdatesManually, installUpdate, openReleasePage, useUpdates } from '@/store/updates'
import { Button, Dialog, Spinner } from '@/ui/kit'
import { AppLogo } from '@/ui/shell/AppLogo'
import { APP_GIT } from '@/ui/shell/appVersion'
import type { DialogPropsBase } from './BomDialog'

function Bar({ percent }: { percent: number | null }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--input)]">
      {percent === null ? (
        <div className="dp-indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full bg-[var(--accent)]" />
      ) : (
        <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
      )}
    </div>
  )
}

function Line({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

function UpdateStatusView({ st, manual }: { st: UpdateState; manual: boolean }) {
  const t = useT()
  const s = st.status
  if (st.mode === 'disabled') return <Line>{t('Обновления работают только в установленной версии программы')}</Line>
  if (s.kind === 'checking' || (manual && s.kind !== 'progress' && s.kind !== 'downloaded'))
    return <Line icon={<Spinner className="text-[var(--accent)]" />}>{t('Проверка обновлений…')}</Line>
  switch (s.kind) {
    case 'idle':
      return <Line>{t('Проверяются автоматически при запуске и раз в 6 часов')}</Line>
    case 'not-available':
      return <Line icon={<Check size={14} className="text-[var(--success)]" />}>{t('У вас последняя версия')}</Line>
    case 'available':
      return st.mode === 'portable' ? (
        <Line icon={<Download size={14} className="text-[var(--accent)]" />}>
          {t('Доступна версия {v}', { v: s.version })}
          <div className="mt-0.5 text-[var(--muted)]">{t('Портативную версию нужно скачать заново: автообновление работает только в установленной.')}</div>
        </Line>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Line icon={<Download size={14} className="text-[var(--accent)]" />}>{t('Доступна версия {v}, скачивается…', { v: s.version })}</Line>
          <Bar percent={null} />
        </div>
      )
    case 'progress':
      return (
        <div className="flex flex-col gap-1.5">
          <Line icon={<Download size={14} className="text-[var(--accent)]" />}>
            {t('Доступна версия {v}, скачивается {p}%', { v: s.version, p: Math.round(s.percent) })}
          </Line>
          <Bar percent={s.percent} />
        </div>
      )
    case 'downloaded':
      return <Line icon={<Check size={14} className="text-[var(--success)]" />}>{t('Версия {v} скачана и готова к установке', { v: s.version })}</Line>
    case 'error':
      return (
        <Line icon={<TriangleExclamationPoint size={14} className="text-[var(--warning)]" />}>
          {s.offline
            ? t('Нет связи с сервером обновлений')
            : s.version
              ? `${t('Не удалось обновиться до версии {v}', { v: s.version })}: ${s.message}`
              : t('Не удалось проверить обновления: {m}', { m: s.message })}
        </Line>
      )
  }
}

export function AboutDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const st = useUpdates((u) => u.state)
  const manual = useUpdates((u) => u.manual)
  const s = st.status
  const busy = manual || s.kind === 'checking' || s.kind === 'progress' || (s.kind === 'available' && st.mode === 'auto')
  const readyToInstall = st.mode === 'auto' && s.kind === 'downloaded'
  const portableNew = st.mode === 'portable' && s.kind === 'available' ? s.version : null

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('О программе doplan')}
      width="max-w-md"
      footer={
        <Button variant={readyToInstall || portableNew ? 'default' : 'primary'} onClick={onClose}>
          {t('Закрыть')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4 text-xs">
        <div className="flex items-center gap-3">
          <AppLogo size={40} className="shrink-0" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="text-sm font-semibold">doplan</div>
            <div className="text-[var(--muted)]">{t('Планировки, фотореалистичное 3D и дизайн интерьера')}</div>
            <div className="font-mono text-[11px] text-[var(--muted)] select-text">
              {t('Версия')} {api.version}
              {APP_GIT ? ` (${APP_GIT})` : ''} · {api.platform}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--border)] p-3">
          <div className="text-[11px] font-semibold tracking-wide text-[var(--muted)] uppercase">{t('Обновления')}</div>
          <UpdateStatusView st={st} manual={manual} />
          <div className="flex flex-wrap justify-end gap-2">
            {st.mode !== 'disabled' && (
              <Button icon={<RefreshCw size={12} />} disabled={busy} onClick={() => void checkForUpdatesManually({ inline: true })}>
                {t('Проверить обновления')}
              </Button>
            )}
            {readyToInstall && (
              <Button
                variant="primary"
                icon={<RefreshCw size={12} />}
                onClick={() => {
                  onClose()
                  void installUpdate()
                }}
              >
                {t('Перезапустить и установить')}
              </Button>
            )}
            {portableNew && (
              <Button variant="primary" icon={<ExternalLink size={12} />} onClick={() => openReleasePage(portableNew)}>
                {t('Открыть страницу загрузки')}
              </Button>
            )}
          </div>
        </div>

        <div className="leading-relaxed text-[var(--muted)]">
          {t('Материалы и модели: Poly Haven, ambientCG, Kenney, Quaternius (CC0) и другие — см. лицензии в папке программы.')}
        </div>
      </div>
    </Dialog>
  )
}
