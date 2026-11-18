/**
 * Project-folder UI: "create project folder" dialog (new / save as folder), version history,
 * AGENTS.md editor, the banner shown while an old version is open, and the inspector section.
 */
import { Bot, FolderOpen, FolderPlus, History, RotateCcw, Tag, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo, ProjectVersion } from '@shared/ipc'
import { tagNameFrom } from '@shared/projectFormat'
import {
  leaveVersion,
  openHistory,
  openInstructions,
  pendingCommitMessage,
  restoreVersion,
  viewVersion,
  createProjectFolder,
  offerResetGitConfig,
  offerTrustFolder,
  unsafeGitNotice,
} from '@/actions/project'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import { useDoc } from '@/store/document'
import { toast } from '@/store/notify'
import { finishCreateDialog, openCreateDialog, projectStore, useProject } from '@/store/project'
import { useUi } from '@/store/ui'
import { Button, Dialog, Input, Row, Section, Spinner } from '@/ui/kit'
import { errorText } from './common/catalog'
import { GithubFolderRow } from '@/ui/github/GithubFolderRow'

/** parent folder chosen earlier in this session (main grants access only to folders picked in its dialog) */
let lastParent: string | null = null

function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') ? '\\' : '/'
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim()
  return `${parent.replace(/[\\/]+$/, '')}${sep}${clean}`
}

// ───────────── create (new project / save as folder) ─────────────

function CreateProjectDialog({ mode }: { mode: 'new' | 'saveAs' }) {
  const t = useT()
  const docName = useDoc((s) => s.doc.meta.name)
  const [name, setName] = useState(mode === 'new' ? t('Новый проект') : docName)
  const [parent, setParent] = useState<string | null>(lastParent)
  const [fallback, setFallback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.project
      .defaultLocation()
      .then(setFallback)
      .catch(() => {})
  }, [])

  const location = parent || fallback
  const close = () => {
    if (!busy) finishCreateDialog(false)
  }

  const browse = async () => {
    try {
      const p = await api.project.pickLocation(location || undefined)
      if (p) {
        setParent(p)
        lastParent = p
      }
    } catch (err) {
      setError(errorText(err))
    }
  }

  // a ref, not the state: two Enter presses in one frame must not start two creates
  const running = useRef(false)
  const submit = async () => {
    if (running.current || !name.trim() || !location) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      const err = await createProjectFolder(mode, name, parent)
      if (err) setError(err)
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      modalLock={busy}
      title={mode === 'new' ? t('Новый проект') : t('Сохранить как папку проекта')}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {t('Отмена')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!name.trim() || !location}>
            {mode === 'new' ? t('Создать') : t('Сохранить')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Row label={t('Название')}>
          <Input
            value={name}
            autoFocus
            onChange={setName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </Row>
        <Row label={t('Где')}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px]" title={location}>
              {location || '…'}
            </span>
            <Button size="sm" icon={<FolderOpen size={12} />} onClick={() => void browse()}>
              {t('Обзор…')}
            </Button>
          </div>
        </Row>
        {location && name.trim() && (
          <div className="text-[11px] text-[var(--muted)]">
            {t('Будет создана папка')} <span className="font-mono text-[var(--text)] select-text">{joinPath(location, name.trim())}</span>
          </div>
        )}
        <div className="rounded-md border border-[var(--border)] p-2 text-[11px] leading-relaxed text-[var(--muted)]">
          {t('В папке: plan.json (план), assets/ (подложки и модели), AGENTS.md (инструкции для ИИ). Каждое сохранение (Ctrl+S) записывается как версия в git.')}
        </div>
        {error && <div className="text-[11px] text-[#ff8589]">{error}</div>}
      </div>
    </Dialog>
  )
}

// ───────────── history ─────────────

function formatDate(iso: string, lang: 'ru' | 'en'): string {
  return new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function HistoryDialog() {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const rev = useProject((s) => s.historyRev)
  const viewing = useProject((s) => s.viewing)
  const dirty = useDoc((s) => s.dirty)
  const [list, setList] = useState<ProjectVersion[] | null>(null)
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [error, setError] = useState('')
  const [tagging, setTagging] = useState<string | null>(null)
  const [tagLabel, setTagLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => projectStore.setState({ dialog: null })

  useEffect(() => {
    let alive = true
    setError('')
    Promise.all([api.project.info(), api.project.history()])
      .then(([i, h]) => {
        if (!alive) return
        setInfo(i)
        setList(h)
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [rev])

  const pending = useMemo(() => (dirty ? pendingCommitMessage() : ''), [dirty])

  const doTag = async (v: ProjectVersion) => {
    const label = tagLabel.trim()
    if (!label) return
    setBusy(true)
    try {
      await api.project.tagVersion(v.sha, label)
      toast(t('Версия отмечена: {name}', { name: label }), 'success')
      setTagging(null)
      setTagLabel('')
      projectStore.setState((s) => ({ historyRev: s.historyRev + 1 }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  // actions that may show a shell modal (unsaved changes, restore confirmation) close the dialog first
  const run = (fn: () => Promise<unknown>) => {
    close()
    void fn()
  }

  const head = list?.[0]?.sha
  return (
    <Dialog open onClose={close} title={t('История версий')} width="max-w-2xl">
      {info && !info.gitAvailable ? (
        <div className="flex flex-col gap-2 text-[12px] leading-relaxed">
          <div>{t('Git не найден. История версий хранится в git — установите его и перезапустите doplan.')}</div>
          <a className="text-[var(--accent)] hover:underline" href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">
            https://git-scm.com/downloads
          </a>
        </div>
      ) : info && info.gitFile ? (
        <div className="flex flex-col gap-2 text-[12px] leading-relaxed">
          <div>
            {t('В папке .git — это файл: папка входит в другой репозиторий (подмодуль или git worktree). doplan не ведёт историю версий в такой папке; сохранение пишет только файлы. Историей управляйте в своём git-клиенте.')}
          </div>
        </div>
      ) : info && info.repo && !info.trusted ? (
        <div className="flex flex-col gap-2 text-[12px] leading-relaxed">
          {error && <div className="text-[11px] text-[#ff8589]">{error}</div>}
          <div>
            {t('Репозиторий git пришёл вместе с папкой, его создал не doplan. Пока вы не доверяете папке, doplan не запускает в ней git и история версий выключена.')}
          </div>
          <div>
            <Button variant="primary" 
              onClick={() =>
                run(async () => {
                  if (await offerTrustFolder('git')) projectStore.setState({ dialog: 'history' })
                })
              }
            >
              {t('Доверять этой папке…')}
            </Button>
          </div>
        </div>
      ) : info && !info.repo && !info.trusted ? (
        <div className="flex flex-col gap-2 text-[12px] leading-relaxed">
          {error && <div className="text-[11px] text-[#ff8589]">{error}</div>}
          <div>
            {t('Эту папку создал не doplan (или её заменили либо переместили). Пока вы не доверяете папке, doplan не создаёт в ней репозиторий git: история версий выключена, сохранение пишет только файлы.')}
          </div>
          <div>
            <Button
              variant="primary"
              onClick={() =>
                run(async () => {
                  if (await offerTrustFolder('folder')) projectStore.setState({ dialog: 'history' })
                })
              }
            >
              {t('Доверять этой папке…')}
            </Button>
          </div>
        </div>
      ) : info && info.unsafeGit ? (
        <div className="flex flex-col gap-2 text-[12px] leading-relaxed">
          {error && <div className="text-[11px] text-[#ff8589]">{error}</div>}
          <div>{unsafeGitNotice(info.unsafeGit).text}</div>
          {info.unsafeGit.resettable && (
            <>
              <div className="text-[var(--muted)]">
                {t('Сброс оставит в .git/config только простые параметры (имя автора, адрес удалённого репозитория, ветки); прежний файл сохранится как .git/config.doplan-backup.')}
              </div>
              <div>
                <Button
                  variant="primary"
                  onClick={() =>
                    run(async () => {
                      if (await offerResetGitConfig(false)) projectStore.setState({ dialog: 'history' })
                    })
                  }
                >
                  {t('Сбросить настройки git')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {error && <div className="text-[11px] text-[#ff8589]">{error}</div>}
          {dirty && !viewing && (
            <div className="rounded-md border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[11px] text-[var(--muted)]">
              {t('Несохранённые изменения: «{msg}» — сохраните (Ctrl+S), чтобы записать версию.', { msg: pending })}
            </div>
          )}
          {!list ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : list.length === 0 ? (
            <div className="p-4 text-center text-[var(--muted)]">{t('Версий пока нет. Сохраните проект (Ctrl+S).')}</div>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
              {list.map((v) => {
                const isViewing = viewing?.sha === v.sha
                return (
                  <li key={v.sha} className={isViewing ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-2.5 py-2' : 'px-2.5 py-2'}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12px] break-words text-[var(--text)]">{v.message}</span>
                          {v.sha === head && <span className="rounded bg-[var(--accent)] px-1 text-[10px] text-white">{t('текущая')}</span>}
                          {isViewing && <span className="rounded border border-[var(--accent)] px-1 text-[10px]">{t('открыта')}</span>}
                          {v.tags.map((tg) => (
                            <span key={tg.name} className="inline-flex items-center gap-0.5 rounded border border-[var(--border)] px-1 text-[10px]" title={tg.name}>
                              <Tag size={9} />
                              {tg.message}
                            </span>
                          ))}
                        </div>
                        <div className="mt-0.5 text-[10px] text-[var(--muted)]">
                          {formatDate(v.date, lang)} · <span className="font-mono">{v.short}</span> · {v.author}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button size="sm" variant="ghost" icon={<Tag size={11} />} onClick={() => setTagging(tagging === v.sha ? null : v.sha)}>
                          {t('Отметить')}
                        </Button>
                        {v.sha !== head && !isViewing && (
                          <Button size="sm" icon={<History size={11} />} onClick={() => run(() => viewVersion(v))}>
                            {t('Открыть')}
                          </Button>
                        )}
                        {v.sha !== head && (
                          <Button size="sm" icon={<RotateCcw size={11} />} onClick={() => run(() => restoreVersion(v))} title={t('Сделать эту версию текущей (новой версией)')}>
                            {t('Восстановить')}
                          </Button>
                        )}
                      </div>
                    </div>
                    {tagging === v.sha && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <Input
                          value={tagLabel}
                          autoFocus
                          placeholder={t('Например: Согласовано с заказчиком')}
                          onChange={setTagLabel}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void doTag(v)
                          }}
                        />
                        <Button size="sm" variant="primary" loading={busy} disabled={!tagNameFrom(tagLabel)} onClick={() => void doTag(v)}>
                          {t('Отметить')}
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <div className="text-[10px] text-[var(--muted)]">
            {t('«Открыть» загружает версию для просмотра; Ctrl+S в ней восстанавливает её новой версией. История никогда не переписывается.')}
          </div>
        </div>
      )}
    </Dialog>
  )
}

// ───────────── AGENTS.md ─────────────

function InstructionsDialog() {
  const t = useT()
  const root = useProject((s) => s.root)
  const [text, setText] = useState<string | null>(null)
  const [orig, setOrig] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** a close was requested with unsaved edits: the footer asks what to do with them */
  const [asking, setAsking] = useState(false)
  const close = () => projectStore.setState({ dialog: null })
  const changed = text !== null && text !== orig
  const requestClose = () => {
    if (busy) return
    if (changed) setAsking(true)
    else close()
  }

  // the folder whose AGENTS.md this editor holds; another project opened meanwhile closes the editor
  const [openedRoot] = useState(root)
  useEffect(() => {
    if (root !== openedRoot) close()
  }, [root, openedRoot])

  useEffect(() => {
    let alive = true
    api.project
      .instructions()
      .then((v) => {
        if (!alive) return
        setText(v ?? '')
        setOrig(v ?? '')
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [])

  // unsaved edits are visible to the window-close and open-project paths (actions/project.ts)
  useEffect(() => {
    projectStore.setState({ instructionsDraft: changed && openedRoot ? { root: openedRoot, text: text ?? '' } : null })
  }, [changed, text, openedRoot])
  useEffect(() => () => projectStore.setState({ instructionsDraft: null }), [])

  const save = async () => {
    if (text === null) return
    setBusy(true)
    setError('')
    try {
      const commit = await api.project.setInstructions(text)
      setOrig(text)
      if (commit) projectStore.setState((s) => ({ historyRev: s.historyRev + 1 }))
      toast(t('Инструкции сохранены'), 'success')
      close()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={requestClose}
      modalLock={busy}
      title={t('Инструкции для ИИ (AGENTS.md)')}
      width="max-w-3xl"
      footer={
        asking ? (
          <>
            <span className="mr-auto text-[12px]">{t('Сохранить изменения в AGENTS.md?')}</span>
            <Button onClick={() => setAsking(false)}>{t('Отмена')}</Button>
            <Button variant="danger" onClick={close}>
              {t('Не сохранять')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              autoFocus
              onClick={() => {
                setAsking(false)
                void save()
              }}
            >
              {t('Сохранить')}
            </Button>
          </>
        ) : (
          <>
            {error && <span className="mr-auto text-[11px] text-[#ff8589]">{error}</span>}
            <Button onClick={() => root && void api.files.reveal(`${root}${root.includes('\\') ? '\\' : '/'}AGENTS.md`)}>{t('Показать файл')}</Button>
            <Button onClick={requestClose}>{t('Отмена')}</Button>
            <Button variant="primary" loading={busy} disabled={!changed} onClick={() => void save()}>
              {t('Сохранить')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2">
        <div className="text-[11px] leading-relaxed text-[var(--muted)]">
          {t('ИИ-агенты (Claude Code, Codex и другие) читают этот файл, когда работают в папке проекта. Опишите задачу и правила в разделе «Пожелания и правила проекта».')}
        </div>
        {text === null ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          <textarea
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                void save()
              }
            }}
            className="h-[60vh] w-full resize-none rounded-md border border-[var(--border)] bg-[var(--input,transparent)] p-2.5 font-mono text-[12px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        )}
      </div>
    </Dialog>
  )
}

// ───────────── viewing banner ─────────────

function VersionBanner() {
  const t = useT()
  const lang = useUi((s) => s.lang)
  const v = useProject((s) => s.viewing)
  if (!v) return null
  return (
    <div className="pointer-events-none fixed top-[88px] left-1/2 z-[900] -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-[var(--accent)] bg-[var(--panel)] px-3 py-1.5 text-[11px] shadow-2xl">
        <History size={13} className="text-[var(--accent)]" />
        <span>
          {t('Версия от {date}', { date: formatDate(v.date, lang) })}: <span className="text-[var(--muted)]">{v.message}</span>
        </span>
        <Button size="sm" variant="primary" icon={<RotateCcw size={11} />} onClick={() => void restoreVersion(v)}>
          {t('Восстановить')}
        </Button>
        <Button size="sm" icon={<Undo2 size={11} />} onClick={() => void leaveVersion()}>
          {t('К текущей')}
        </Button>
      </div>
    </div>
  )
}

/** all project-folder dialogs + the old-version banner (rendered once by App) */
export function ProjectFolderDialogs() {
  const dialog = useProject((s) => s.dialog)
  return (
    <>
      {(dialog === 'new' || dialog === 'saveAs') && <CreateProjectDialog key={dialog} mode={dialog} />}
      {dialog === 'history' && <HistoryDialog />}
      {dialog === 'instructions' && <InstructionsDialog />}
      <VersionBanner />
    </>
  )
}

// ───────────── project inspector section ─────────────

export function ProjectFolderSection() {
  const t = useT()
  const root = useProject((s) => s.root)
  const git = useProject((s) => s.git)
  const untrustedGit = useProject((s) => s.untrustedGit)
  const gitFile = useProject((s) => s.gitFile)
  const unsafeGit = useProject((s) => s.unsafeGit)
  const filePath = useDoc((s) => s.filePath)
  if (api.platform === 'browser') return null
  return (
    <Section title={t('Папка проекта')} id="insp.proj.folder">
      {root ? (
        <div className="flex flex-col gap-1.5">
          <div className="truncate font-mono text-[11px] text-[var(--muted)] select-text" title={root}>
            {root}
          </div>
          {untrustedGit ? (
            <div className="text-[11px] text-[var(--muted)]">{t('История версий выключена: папке не доверяют')}</div>
          ) : gitFile ? (
            <div className="text-[11px] text-[var(--muted)]">{t('Папка входит в другой репозиторий git — история версий doplan выключена')}</div>
          ) : unsafeGit ? (
            <div className="text-[11px] text-[var(--muted)]">
              {unsafeGit.layout?.length ? t('История версий выключена: репозиторий с неподдерживаемыми ссылками или файлами') : t('История версий выключена: небезопасные настройки git в папке')}
            </div>
          ) : (
            !git && <div className="text-[11px] text-[var(--muted)]">{t('Git не найден — история версий недоступна')}</div>
          )}
          <div className="flex flex-wrap gap-1">
            <Button size="sm" icon={<History size={11} />} onClick={() => void openHistory()}>
              {t('История версий')}
            </Button>
            <Button size="sm" icon={<Bot size={11} />} onClick={() => void openInstructions()}>
              {t('Инструкции для ИИ')}
            </Button>
            <Button size="sm" icon={<FolderOpen size={11} />} onClick={() => void api.files.reveal(root)}>
              {t('Показать')}
            </Button>
          </div>
          <GithubFolderRow />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] text-[var(--muted)]">
            {filePath ? t('Проект открыт из файла {name}', { name: filePath.split(/[\\/]/).pop() ?? filePath }) : t('Проект не сохранён')}
          </div>
          <Button size="sm" icon={<FolderPlus size={11} />} onClick={() => void openCreateDialog('saveAs')}>
            {t('Сохранить как папку проекта…')}
          </Button>
        </div>
      )}
    </Section>
  )
}
