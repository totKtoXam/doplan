/**
 * Non-blocking update card in the toast column: «Доступна версия X.Y.Z» → download progress →
 * «Перезапустить и установить» / «Позже». Portable builds get a link to the release page instead.
 */
import { Download, ExternalLink, RefreshCw, TriangleExclamationPoint, X } from 'lucide-react'
import { useState } from 'react'
import { useT } from '@/i18n'
import { checkForUpdatesManually, dismissNotice, installUpdate, openReleasePage, useUpdates, visibleNotice } from '@/store/updates'
import { TextBtn } from './primitives'

export function UpdateNotice() {
  const t = useT()
  const mode = useUpdates((s) => s.state.mode)
  const s = useUpdates(visibleNotice)
  const [notesOpen, setNotesOpen] = useState(false)
  if (!s) return null

  const portable = mode === 'portable'
  const failed = s.kind === 'error'
  const version = 'version' in s ? (s.version ?? '') : ''
  const notes = s.kind === 'available' || s.kind === 'downloaded' ? s.notes : ''
  const title =
    s.kind === 'downloaded'
      ? t('Версия {v} готова к установке', { v: version })
      : failed
        ? t('Не удалось обновиться до версии {v}', { v: version })
        : t('Доступна версия {v}', { v: version })
  const percent = s.kind === 'progress' ? Math.round(s.percent) : s.kind === 'downloaded' ? 100 : 0
  const downloading = !portable && (s.kind === 'available' || s.kind === 'progress')

  return (
    <div
      role="status"
      aria-live="polite"
      className={`dp-fade-in pointer-events-auto flex w-full flex-col gap-2 rounded-lg border bg-panel px-3 py-2.5 text-xs shadow-pop ${failed ? 'border-warning/60' : 'border-accent/50'}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0">
          {failed ? <TriangleExclamationPoint size={14} className="text-warning" /> : <Download size={14} className="text-accent" />}
        </span>
        <span className="min-w-0 flex-1 font-medium break-words">{title}</span>
        <button type="button" className="shrink-0 text-muted hover:text-text" onClick={dismissNotice} aria-label={t('Скрыть')} title={t('Скрыть')}>
          <X size={13} />
        </button>
      </div>

      {portable && !failed && (
        <div className="pl-[22px] leading-relaxed text-muted">{t('Портативную версию нужно скачать заново: автообновление работает только в установленной.')}</div>
      )}

      {failed && <div className="pl-[22px] leading-relaxed break-words text-muted">{s.offline ? t('Нет связи') : s.message}</div>}

      {downloading && (
        <div className="flex flex-col gap-1 pl-[22px]">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-input">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
          <div className="text-[11px] text-muted">{s.kind === 'progress' ? t('Скачивание… {p}%', { p: percent }) : t('Скачивание…')}</div>
        </div>
      )}

      {notes && (
        <div className="pl-[22px]">
          <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => setNotesOpen((o) => !o)}>
            {t('Что нового')} {notesOpen ? '▴' : '▾'}
          </button>
          {notesOpen && (
            <div className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-input p-2 text-[11px] leading-relaxed whitespace-pre-line text-text select-text">
              {notes}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {s.kind === 'downloaded' && !portable && (
          <>
            <TextBtn onClick={dismissNotice}>{t('Позже')}</TextBtn>
            <TextBtn variant="primary" onClick={() => void installUpdate()}>
              <RefreshCw size={12} />
              {t('Перезапустить и установить')}
            </TextBtn>
          </>
        )}
        {portable && !failed && (
          <>
            <TextBtn onClick={dismissNotice}>{t('Позже')}</TextBtn>
            <TextBtn variant="primary" onClick={() => openReleasePage(version)}>
              <ExternalLink size={12} />
              {t('Открыть страницу загрузки')}
            </TextBtn>
          </>
        )}
        {downloading && <TextBtn onClick={dismissNotice}>{t('Скрыть')}</TextBtn>}
        {failed && (
          <>
            <TextBtn onClick={() => openReleasePage(version)}>
              <ExternalLink size={12} />
              {t('Открыть страницу загрузки')}
            </TextBtn>
            <TextBtn variant="primary" onClick={() => void checkForUpdatesManually()}>
              {t('Повторить')}
            </TextBtn>
          </>
        )}
      </div>
    </div>
  )
}
