import clsx from 'clsx'
import { ArrowLeft, FilePlus, FileQuestion, FolderOpen, FolderTree, House, Settings, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { RecentEntry } from '@shared/recent'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import { dialogStore } from '@/store/dialogs'
import { uiStore, useUi } from '@/store/ui'
import { hideWelcome, useWelcome } from '@/store/welcome'
import { Spinner } from '@/ui/kit'
import { AppLogo } from '@/ui/shell/AppLogo'
import { formatWhen, parentOf, svgDataUrl } from './format'
import './welcomeI18n'

const isWeb = api.platform === 'browser'

function refreshSettings(): void {
  void api.settings
    .get()
    .then((s) => uiStore.setState({ appSettings: s }))
    .catch(() => {})
}

function ActionButton({ icon, label, hint, primary, onClick }: { icon: ReactNode; label: string; hint?: string; primary?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent',
        primary ? 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover' : 'border-border bg-panel text-text hover:border-border-strong hover:bg-hover',
      )}
    >
      <span className={clsx('flex size-8 shrink-0 items-center justify-center rounded-md', primary ? 'bg-white/15' : 'bg-panel-3 text-accent')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className={clsx('block truncate text-[11px]', primary ? 'text-accent-fg/80' : 'text-muted')}>{hint}</span>}
      </span>
    </button>
  )
}

function RecentCard({ entry, busy, onOpen, onRemove }: { entry: RecentEntry; busy: boolean; onOpen(): void; onRemove(): void }) {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const missing = !entry.exists
  const where = entry.kind === 'web' ? t('Копия в этом браузере') : parentOf(entry.path)
  return (
    <div
      className={clsx(
        'group relative flex flex-col overflow-hidden rounded-lg border bg-panel transition-colors',
        missing ? 'border-dashed border-border' : 'border-border hover:border-accent focus-within:border-accent',
      )}
    >
      <button
        type="button"
        disabled={missing || busy}
        onClick={onOpen}
        title={missing ? t('Файл или папка проекта не найдены: {path}', { path: entry.path }) : entry.path}
        className="flex flex-1 flex-col text-left outline-none disabled:cursor-default"
      >
        <div className={clsx('relative flex aspect-[16/10] items-center justify-center border-b border-border', missing ? 'bg-panel-2' : 'bg-[#f7f8fa]')}>
          {entry.thumb && !missing ? (
            <img src={svgDataUrl(entry.thumb)} alt="" draggable={false} className="absolute inset-0 size-full object-contain p-2" />
          ) : missing ? (
            <FileQuestion size={28} className="text-faint" />
          ) : (
            <AppLogo size={28} className="opacity-25 grayscale" />
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
              <Spinner className="size-5 text-accent" />
            </div>
          )}
        </div>
        <div className="min-w-0 px-3 py-2">
          <div className={clsx('truncate text-[13px] font-medium', missing ? 'text-muted' : 'text-text')}>{entry.name || entry.path}</div>
          {/* long paths keep their end (the folder the project is in) visible */}
          <div className="truncate text-left text-[11px] text-muted [direction:rtl]">
            <bdi>{where}</bdi>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
            {missing ? <span className="text-warning">{t('Не найден')}</span> : <span>{formatWhen(entry.modifiedAt, lang, t)}</span>}
            {entry.kind === 'zip' && !missing && <span className="rounded bg-panel-3 px-1 text-[10px] text-muted">.doplan</span>}
          </div>
        </div>
      </button>
      {missing ? (
        <div className="px-3 pb-2.5">
          <button type="button" onClick={onRemove} className="text-[11px] text-accent hover:underline">
            {t('Убрать из списка')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          title={t('Убрать из списка')}
          aria-label={t('Убрать из списка')}
          className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-panel/90 text-muted opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-text focus-visible:opacity-100"
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}

/** Start screen: what to do first — a new project, an existing one, the sample — and the recent projects. */
export function WelcomeScreen() {
  const t = useT()
  const open = useWelcome((s) => s.open)
  const canClose = useWelcome((s) => s.canClose)
  const [entries, setEntries] = useState<RecentEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(() => {
    api.recent
      .list()
      .then(setEntries)
      .catch((err: unknown) => {
        console.warn('[doplan] recent.list failed', err)
        setEntries([])
      })
  }, [])

  useEffect(() => {
    if (!open) return
    setEntries(null)
    reload()
  }, [open, reload])

  // Esc goes back to the project the screen was opened over
  useEffect(() => {
    if (!open || !canClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) hideWelcome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, canClose])

  if (!open) return null

  const openEntry = async (e: RecentEntry) => {
    setBusy(e.path)
    try {
      await actions.openProject(e.path)
    } finally {
      setBusy(null)
      // still here: the open failed or was cancelled — the project may have gone meanwhile
      reload()
    }
  }
  const removeEntry = async (e: RecentEntry) => {
    setEntries((list) => list?.filter((x) => x.path !== e.path) ?? null)
    try {
      await api.recent.remove(e.path)
    } finally {
      refreshSettings()
      reload()
    }
  }
  const missingCount = entries?.filter((e) => !e.exists).length ?? 0
  const clearMissing = async () => {
    for (const e of entries ?? []) if (!e.exists) await api.recent.remove(e.path).catch(() => {})
    refreshSettings()
    reload()
  }

  return (
    <div className="dp-welcome fixed inset-0 z-[850] flex bg-bg text-text" role="region" aria-label={t('Начальный экран')}>
      {/* left: brand and the first steps */}
      <aside className="flex w-[300px] shrink-0 flex-col gap-6 border-r border-border bg-panel px-6 py-8">
        <div className="flex items-center gap-3">
          <AppLogo size={48} />
          <div>
            <div className="text-xl font-semibold tracking-tight">doplan</div>
            <div className="text-[11px] leading-snug text-muted">{t('Планировки, 3D и дизайн интерьера')}</div>
          </div>
        </div>
        <nav className="flex flex-col gap-2">
          <ActionButton primary icon={<FilePlus size={17} />} label={t('Новый проект')} hint={isWeb ? undefined : t('Папка с историей версий')} onClick={() => void actions.newProject()} />
          <ActionButton icon={<FolderOpen size={17} />} label={t('Открыть…')} hint={isWeb ? t('Файл .json с планом') : t('Файл .doplan или plan.json')} onClick={() => void actions.openProject()} />
          {!isWeb && <ActionButton icon={<FolderTree size={17} />} label={t('Открыть папку проекта…')} onClick={() => void actions.openProjectFolder()} />}
          <ActionButton icon={<House size={17} />} label={t('Открыть пример')} hint={t('Готовая квартира с мебелью')} onClick={() => void actions.newSampleProject()} />
        </nav>
        <div className="mt-auto flex flex-col gap-1 text-[12px]">
          {canClose && (
            <button type="button" onClick={hideWelcome} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted hover:bg-hover hover:text-text">
              <ArrowLeft size={14} />
              {t('Вернуться к проекту')}
              <kbd className="ml-auto text-[10px] text-faint">Esc</kbd>
            </button>
          )}
          <button type="button" onClick={() => dialogStore.getState().open('settings')} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted hover:bg-hover hover:text-text">
            <Settings size={14} />
            {t('Настройки…')}
          </button>
          <div className="px-2 pt-2 text-[10px] text-faint">doplan {api.version}</div>
        </div>
      </aside>

      {/* right: recent projects */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-end justify-between gap-4 px-8 pt-8 pb-4">
          <div>
            <h1 className="text-base font-semibold">{t('Недавние проекты')}</h1>
            <p className="text-[12px] text-muted">
              {isWeb ? t('Проекты, открытые или сохранённые в этом браузере') : t('Проекты, которые вы открывали или сохраняли')}
            </p>
          </div>
          {missingCount > 1 && (
            <button type="button" onClick={() => void clearMissing()} className="text-[12px] text-accent hover:underline">
              {t('Убрать ненайденные ({n})', { n: missingCount })}
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-8 pb-8">
          {entries === null ? (
            <div className="flex h-40 items-center justify-center text-muted">
              <Spinner className="size-5" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center">
              <FolderOpen size={28} className="text-faint" />
              <div className="text-[13px] font-medium">{t('Недавних проектов пока нет')}</div>
              <div className="max-w-sm text-[12px] text-muted">{t('Создайте новый проект, откройте свой или посмотрите пример — проекты появятся здесь.')}</div>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {entries.map((e) => (
                <RecentCard key={e.path} entry={e} busy={busy === e.path} onOpen={() => void openEntry(e)} onRemove={() => void removeEntry(e)} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
