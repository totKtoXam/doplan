import { ArrowLeft, FilePlus, FileQuestion, FolderOpen, FolderTree, House, Settings, X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from 'react'
import type { RecentEntry } from '@shared/recent'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import { dialogStore } from '@/store/dialogs'
import { uiStore, useUi } from '@/store/ui'
import { hideWelcome, useWelcome } from '@/store/welcome'
import { Button, cn, focusRing, IconButton, ScrollArea, Spinner } from '@/ui/kit'
import { AppLogo } from '@/ui/shell/AppLogo'
import { formatWhen, parentOf, svgDataUrl } from './format'
import './welcomeI18n'

// Colours come only from the theme (styles.css / theme/store.ts tokens), so the screen follows
// every built-in and installed light or dark theme.

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
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        focusRing,
        primary
          ? 'border-transparent bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]'
          : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--hover)]',
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md',
          primary ? 'bg-[color-mix(in_srgb,var(--accent-fg)_16%,transparent)]' : 'bg-[var(--accent-soft)] text-[var(--accent)]',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && (
          <span className={cn('block truncate text-[11px]', primary ? 'text-[color-mix(in_srgb,var(--accent-fg)_80%,transparent)]' : 'text-[var(--muted)]')}>
            {hint}
          </span>
        )}
      </span>
    </button>
  )
}

/** the plan picture is a luminance mask: its lines are painted in the theme's text colour */
function PlanPicture({ svg }: { svg: string }) {
  const url = `url("${svgDataUrl(svg)}")`
  const mask: CSSProperties = {
    maskImage: url,
    maskMode: 'luminance',
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskImage: url,
    WebkitMaskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
  }
  return <div aria-hidden className="absolute inset-2 bg-[var(--text)] opacity-85" style={mask} />
}

function RecentCard({ entry, busy, onOpen, onRemove }: { entry: RecentEntry; busy: boolean; onOpen(): void; onRemove(): void }) {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const missing = !entry.exists
  const where = entry.kind === 'web' ? t('Копия в этом браузере') : parentOf(entry.path)
  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg border bg-[var(--panel)] transition-colors',
        missing ? 'border-dashed border-[var(--border)]' : 'border-[var(--border)] hover:border-[var(--accent)] focus-within:border-[var(--accent)]',
      )}
    >
      <button
        type="button"
        disabled={missing || busy}
        onClick={onOpen}
        title={missing ? t('Файл или папка проекта не найдены: {path}', { path: entry.path }) : entry.path}
        className="flex flex-1 flex-col text-left outline-none disabled:cursor-default"
      >
        <div
          className={cn(
            'relative flex aspect-[16/10] items-center justify-center border-b border-[var(--border)]',
            missing ? 'bg-[var(--panel-2)]' : 'bg-[var(--viewport)]',
          )}
        >
          {entry.thumb && !missing ? (
            <PlanPicture svg={entry.thumb} />
          ) : missing ? (
            <FileQuestion size={28} className="text-[var(--faint)]" />
          ) : (
            <AppLogo size={28} className="opacity-25 grayscale" />
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_55%,transparent)]">
              <Spinner className="size-5 text-[var(--accent)]" />
            </div>
          )}
        </div>
        <div className="min-w-0 px-3 py-2">
          <div className={cn('truncate text-[13px] font-medium', missing ? 'text-[var(--muted)]' : 'text-[var(--text)]')}>{entry.name || entry.path}</div>
          {/* long paths keep their end (the folder the project is in) visible */}
          <div className="truncate text-left text-[11px] text-[var(--muted)] [direction:rtl]">
            <bdi>{where}</bdi>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--faint)]">
            {missing ? <span className="text-[var(--warning)]">{t('Не найден')}</span> : <span>{formatWhen(entry.modifiedAt, lang, t)}</span>}
            {entry.kind === 'zip' && !missing && <span className="rounded bg-[var(--panel-3)] px-1 text-[10px] text-[var(--muted)]">.doplan</span>}
          </div>
        </div>
      </button>
      {missing ? (
        <div className="px-2 pb-2">
          <Button size="sm" variant="ghost" onClick={onRemove} className="text-[var(--accent)]!">
            {t('Убрать из списка')}
          </Button>
        </div>
      ) : (
        <IconButton
          size="sm"
          variant="default"
          icon={<X size={13} />}
          label={t('Убрать из списка')}
          onClick={onRemove}
          className="absolute top-1.5 right-1.5 bg-[var(--panel)] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        />
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
    <div className="dp-welcome fixed inset-0 z-[850] flex bg-[var(--bg)] text-[var(--text)]" role="region" aria-label={t('Начальный экран')}>
      {/* left: brand and the first steps */}
      <aside className="flex w-[300px] shrink-0 flex-col gap-6 border-r border-[var(--border)] bg-[var(--panel)] px-6 py-8">
        <div className="flex items-center gap-3">
          <AppLogo size={48} />
          <div>
            <div className="text-xl font-semibold tracking-tight">doplan</div>
            <div className="text-[11px] leading-snug text-[var(--muted)]">{t('Планировки, 3D и дизайн интерьера')}</div>
          </div>
        </div>
        <nav className="flex flex-col gap-2">
          <ActionButton primary icon={<FilePlus size={17} />} label={t('Новый проект')} hint={isWeb ? undefined : t('Папка с историей версий')} onClick={() => void actions.newProject()} />
          <ActionButton icon={<FolderOpen size={17} />} label={t('Открыть…')} hint={isWeb ? t('Файл .json с планом') : t('Файл .doplan или plan.json')} onClick={() => void actions.openProject()} />
          {!isWeb && <ActionButton icon={<FolderTree size={17} />} label={t('Открыть папку проекта…')} onClick={() => void actions.openProjectFolder()} />}
          <ActionButton icon={<House size={17} />} label={t('Открыть пример')} hint={t('Готовая квартира с мебелью')} onClick={() => void actions.newSampleProject()} />
        </nav>
        <div className="mt-auto flex flex-col gap-1">
          {canClose && (
            <Button variant="ghost" onClick={hideWelcome} icon={<ArrowLeft size={14} />} className="justify-start text-[var(--muted)]! hover:text-[var(--text)]!">
              {t('Вернуться к проекту')}
              <kbd className="ml-auto font-sans text-[10px] text-[var(--faint)]">Esc</kbd>
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => dialogStore.getState().open('settings')}
            icon={<Settings size={14} />}
            className="justify-start text-[var(--muted)]! hover:text-[var(--text)]!"
          >
            {t('Настройки…')}
          </Button>
          <div className="px-2.5 pt-2 text-[10px] text-[var(--faint)]">doplan {api.version}</div>
        </div>
      </aside>

      {/* right: recent projects */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-end justify-between gap-4 px-8 pt-8 pb-4">
          <div>
            <h1 className="text-base font-semibold">{t('Недавние проекты')}</h1>
            <p className="text-[12px] text-[var(--muted)]">
              {isWeb ? t('Проекты, открытые или сохранённые в этом браузере') : t('Проекты, которые вы открывали или сохраняли')}
            </p>
          </div>
          {missingCount > 1 && (
            <Button size="sm" variant="ghost" onClick={() => void clearMissing()} className="text-[var(--accent)]!">
              {t('Убрать ненайденные ({n})', { n: missingCount })}
            </Button>
          )}
        </header>
        <ScrollArea className="flex-1 px-8 pb-8">
          {entries === null ? (
            <div className="flex h-40 items-center justify-center text-[var(--muted)]">
              <Spinner className="size-5" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border)] text-center">
              <FolderOpen size={28} className="text-[var(--faint)]" />
              <div className="text-[13px] font-medium">{t('Недавних проектов пока нет')}</div>
              <div className="max-w-sm text-[12px] text-[var(--muted)]">{t('Создайте новый проект, откройте свой или посмотрите пример — проекты появятся здесь.')}</div>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {entries.map((e) => (
                <RecentCard key={e.path} entry={e} busy={busy === e.path} onOpen={() => void openEntry(e)} onRemove={() => void removeEntry(e)} />
              ))}
            </div>
          )}
        </ScrollArea>
      </main>
    </div>
  )
}
