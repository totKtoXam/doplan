/**
 * The colour themes in Settings: built-in and installed themes as small previews of the window,
 * dark and light apart, and installing a theme file (a VS Code colour theme or a doplan theme).
 */
import { useMemo, useRef, useState } from 'react'
import { Check, Download, FileUp, Trash2 } from 'lucide-react'
import { useT } from '@/i18n'
import { Button, IconButton } from '@/ui/kit'
import { themeStore, useTheme } from '@/theme/store'
import { resolveTheme, ThemeFileError, themeFromFile, themeToFile, type ResolvedTheme, type ThemeKind, type ThemeSource } from '@/theme/themes'
import '@/ui/shellI18n'

/** a miniature of the window in the theme's colours */
function Preview({ r }: { r: ResolvedTheme }) {
  const u = r.ui
  return (
    <div className="flex h-12 overflow-hidden rounded-[3px]" style={{ background: u.bg, border: `1px solid ${u.border}` }} aria-hidden>
      <div className="flex w-4 flex-col items-center gap-1 pt-1.5" style={{ background: u.panel, borderRight: `1px solid ${u.border}` }}>
        <span className="h-1 w-2 rounded-[1px]" style={{ background: u.accent }} />
        <span className="h-1 w-2 rounded-[1px]" style={{ background: u.faint }} />
        <span className="h-1 w-2 rounded-[1px]" style={{ background: u.faint }} />
      </div>
      <div className="relative flex-1" style={{ background: u.viewport }}>
        {/* a room outline in the plan's wall colour */}
        <span className="absolute top-2 left-2.5 h-6 w-9" style={{ border: `2px solid #${r.plan.wall.toString(16).padStart(6, '0')}` }} />
        <span className="absolute top-2 left-[46px] h-6 w-5" style={{ border: `2px solid #${r.plan.wall.toString(16).padStart(6, '0')}`, borderLeft: 'none' }} />
      </div>
      <div className="flex w-9 flex-col gap-1 px-1 pt-1.5" style={{ background: u.panel, borderLeft: `1px solid ${u.border}` }}>
        <span className="h-1 w-6 rounded-[1px]" style={{ background: u.text, opacity: 0.8 }} />
        <span className="h-1 w-4 rounded-[1px]" style={{ background: u.muted }} />
        <span className="mt-auto mb-1.5 h-2 w-full rounded-[2px]" style={{ background: u.accent }} />
      </div>
    </div>
  )
}

export function ThemePicker() {
  const t = useT()
  const activeId = useTheme((s) => s.activeId)
  const custom = useTheme((s) => s.custom)
  const file = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)

  const all = useMemo(() => themeStore.getState().all(), [custom])
  const resolved = useMemo(() => new Map(all.map((s) => [s.id, resolveTheme(s, all)])), [all])
  const customIds = useMemo(() => new Set(custom.map((c) => c.id)), [custom])

  const install = async (files: FileList | null) => {
    if (!files?.length) return
    const ok: ThemeSource[] = []
    const errors: string[] = []
    for (const f of Array.from(files)) {
      try {
        ok.push(themeFromFile(await f.text(), f.name))
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof ThemeFileError ? t(e.message) : String(e)}`)
      }
    }
    if (ok.length) {
      themeStore.getState().install(ok)
      themeStore.getState().select(ok[ok.length - 1].id)
    }
    setMsg(
      errors.length
        ? { text: errors.join('\n'), error: true }
        : { text: ok.length === 1 ? t('Тема «{name}» установлена', { name: ok[0].name }) : t('Установлено тем: {n}', { n: ok.length }), error: false },
    )
  }

  const saveCopy = (s: ThemeSource) => {
    const blob = new Blob([themeToFile(s)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${s.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'theme'}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const group = (kind: ThemeKind) => (
    <div className="grid grid-cols-3 gap-1.5">
      {all
        .filter((s) => s.type === kind)
        .map((s) => {
          const r = resolved.get(s.id)!
          const on = s.id === activeId
          return (
            <div key={s.id} className="group relative">
              <button
                type="button"
                onClick={() => themeStore.getState().select(s.id)}
                aria-pressed={on}
                title={s.author ? `${s.name} — ${s.author}` : s.name}
                className={`flex w-full flex-col gap-1 rounded-md p-1 text-left ${on ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-hover'}`}
              >
                <Preview r={r} />
                <span className={`flex items-center gap-1 truncate px-0.5 text-[11px] ${on ? 'text-text' : 'text-muted'}`}>
                  {on && <Check size={11} className="shrink-0 text-accent" />}
                  <span className="truncate">{s.name}</span>
                </span>
              </button>
              <div className="absolute top-1.5 right-1.5 hidden gap-0.5 group-hover:flex">
                <IconButton size="sm" variant="default" icon={<Download />} label={t('Сохранить в файл')} onClick={() => saveCopy(s)} />
                {customIds.has(s.id) && (
                  <IconButton size="sm" variant="danger" icon={<Trash2 />} label={t('Удалить тему')} onClick={() => themeStore.getState().remove(s.id)} />
                )}
              </div>
            </div>
          )
        })}
    </div>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-muted">{t('Тёмные')}</div>
      {group('dark')}
      <div className="pt-1 text-[11px] text-muted">{t('Светлые')}</div>
      {group('light')}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" icon={<FileUp size={13} />} onClick={() => file.current?.click()}>
          {t('Установить тему…')}
        </Button>
        <input
          ref={file}
          type="file"
          accept=".json,.jsonc,application/json"
          multiple
          hidden
          onChange={(e) => {
            void install(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
      </div>
      {msg && <p className={`whitespace-pre-line text-[11px] ${msg.error ? 'text-danger' : 'text-success'}`}>{msg.text}</p>}
      <p className="text-[11px] leading-snug text-faint">
        {t(
          'Подходят файлы цветовых тем VS Code (.json из папки themes расширения) и темы doplan. Чтобы изменить только часть цветов, укажите в файле "extends" с именем другой темы.',
        )}
      </p>
    </div>
  )
}
