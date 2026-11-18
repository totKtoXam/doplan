/**
 * GitHub dialogs: the main one (connect by a link or create a repository through GitHub CLI, or the
 * connected project's state and actions) and the conflict choice. doplan never asks for a password
 * or a token: signing in happens on github.com (GitHub CLI's device code, or Git's own sign-in window).
 */
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { Check, CloudDownload, CloudUpload, Copy, ExternalLink, FolderPlus, Lock, Globe, LogIn, RefreshCw, Unplug } from 'lucide-react'
import { isValidRepoName, parseGithubUrl, repoNameFromProject, type GhStatus } from '@shared/github'
import { useT } from '@/i18n'
import { api } from '@/store/api'
import { useDoc } from '@/store/document'
import {
  closeGithubDialog,
  githubCancelConflict,
  githubConnect,
  githubCreate,
  githubDisconnect,
  githubPull,
  githubPush,
  githubResolve,
  refreshGithub,
  useGithub,
} from '@/store/github'
import { openCreateDialog, useProject } from '@/store/project'
import { toast } from '@/store/notify'
import { Button, Dialog, Input, Segmented, Spinner } from '@/ui/kit'
import { githubStateView, toneClass } from './githubState'

export function GithubDialogs() {
  const dialog = useGithub((s) => s.dialog)
  return (
    <>
      <GithubMainDialog open={dialog === 'connect'} />
      <GithubConflictDialog open={dialog === 'conflict'} />
      <GithubSyncLock />
    </>
  )
}

/**
 * While GitHub's versions come into the folder (get, combine), the editor waits: an edit made then
 * would be replaced by the reload that follows.
 */
function GithubSyncLock() {
  const t = useT()
  const busy = useGithub((s) => s.busy)
  const open = busy === 'pull' || busy === 'resolve'
  return (
    <Dialog open={open} onClose={() => undefined} modalLock title={t('GitHub')} width="max-w-sm">
      <div className="flex items-center gap-3 text-xs" role="status" aria-live="polite">
        <Spinner />
        <div className="flex flex-col gap-1">
          <span>{busy === 'resolve' ? t('Объединяю версии…') : t('Получаю изменения с GitHub…')}</span>
          <Note>{t('Редактирование продолжится, когда проект обновится. Если откроется окно входа в GitHub — войдите в нём.')}</Note>
        </div>
      </div>
    </Dialog>
  )
}

const Note = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={clsx('text-[11px] leading-relaxed text-[var(--muted)]', className)}>{children}</div>
)

function copy(text: string, done: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast(done, 'success', 2000),
    () => undefined,
  )
}

// ───────────── main dialog ─────────────

function GithubMainDialog({ open }: { open: boolean }) {
  const t = useT()
  const status = useGithub((s) => s.status)
  const busy = useGithub((s) => s.busy)
  const root = useProject((s) => s.root)

  useEffect(() => {
    if (open) void refreshGithub(false)
  }, [open])

  const connected = !!status?.remote
  const unavailable = !status || status.state === 'unavailable'

  return (
    <Dialog
      open={open}
      onClose={closeGithubDialog}
      title={t('GitHub')}
      width="max-w-lg"
      modalLock={busy === 'connect'}
      footer={
        <Button onClick={closeGithubDialog} disabled={busy === 'connect'}>
          {t('Закрыть')}
        </Button>
      }
    >
      {unavailable ? (
        <div className="flex flex-col gap-3 text-xs">
          <Note>{status?.reason ?? t('Проверяю GitHub…')}</Note>
          {status && !root && (
            <div>
              <Button
                variant="primary"
                icon={<FolderPlus size={12} />}
                onClick={() => {
                  closeGithubDialog()
                  void openCreateDialog('saveAs')
                }}
              >
                {t('Сохранить как папку проекта…')}
              </Button>
            </div>
          )}
        </div>
      ) : connected ? (
        <ConnectedView />
      ) : (
        <ConnectView />
      )}
    </Dialog>
  )
}

function ConnectedView() {
  const t = useT()
  const status = useGithub((s) => s.status)!
  const busy = useGithub((s) => s.busy)
  const view = githubStateView(status, t)
  const Icon = view.icon
  const repo = status.remote?.owner ? `${status.remote.owner}/${status.remote.repo}` : (status.remote?.url ?? '')
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-start gap-2.5 rounded-lg border border-[var(--border)] p-3">
        <Icon size={18} className={clsx('mt-0.5 shrink-0', toneClass[view.tone])} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="truncate font-medium select-text">{repo}</div>
          <div className="text-[var(--muted)]">{view.text}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button variant={status.ahead || status.state === 'notPushed' ? 'primary' : 'default'} icon={<CloudUpload size={12} />} disabled={!!busy} onClick={() => void githubPush()}>
          {t('Отправить на GitHub')}
        </Button>
        <Button variant={status.behind ? 'primary' : 'default'} icon={<CloudDownload size={12} />} disabled={!!busy} onClick={() => void githubPull()}>
          {t('Получить изменения')}
        </Button>
        {status.remote?.webUrl && (
          <Button icon={<ExternalLink size={12} />} onClick={() => void api.github.openPage('repo')}>
            {t('Открыть на GitHub')}
          </Button>
        )}
        <Button variant="ghost" icon={<Unplug size={12} />} disabled={!!busy} onClick={() => void githubDisconnect()}>
          {t('Отключить')}
        </Button>
      </div>
      <Note>
        {t('Отправка — только по кнопке. doplan раз в несколько минут проверяет, нет ли на GitHub новых версий, и показывает это на кнопке GitHub в шапке.')}
      </Note>
    </div>
  )
}

type Way = 'create' | 'link'

function ConnectView() {
  const t = useT()
  const [way, setWay] = useState<Way>('create')
  return (
    <div className="flex flex-col gap-3 text-xs">
      <Note>
        {t('GitHub хранит копию проекта со всеми версиями в интернете: с ней можно работать на другом компьютере или вместе с кем-то. Пароль GitHub doplan не видит и не хранит — вход выполняется на сайте github.com.')}
      </Note>
      <Segmented<Way>
        aria-label={t('Способ подключения')}
        value={way}
        onChange={setWay}
        options={[
          { value: 'create', label: t('Создать репозиторий') },
          { value: 'link', label: t('Вставить ссылку') },
        ]}
      />
      {way === 'create' ? <CreateWay /> : <LinkWay />}
    </div>
  )
}

function ErrorBox({ text }: { text: string | null }) {
  if (!text) return null
  return <div className="rounded-md border border-[color-mix(in_srgb,var(--danger,#e5484d)_40%,transparent)] p-2 text-[11px] whitespace-pre-line text-danger select-text">{text}</div>
}

function LinkWay() {
  const t = useT()
  const busy = useGithub((s) => s.busy)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ref = url.trim() ? parseGithubUrl(url) : null
  const bad = !!url.trim() && !ref
  const submit = async () => {
    if (!ref || busy) return
    setError(null)
    setError(await githubConnect(url.trim()))
  }
  return (
    <div className="flex flex-col gap-2">
      <Note>
        {t('Создайте на github.com пустой репозиторий (без README) и вставьте сюда его адрес из строки браузера. Подойдёт и ссылка git@github.com:… для SSH.')}
      </Note>
      <Input
        value={url}
        onChange={(v) => {
          setUrl(v)
          setError(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder="https://github.com/owner/repo"
        spellCheck={false}
        autoFocus
        aria-invalid={bad}
      />
      {bad ? (
        <div className="text-[11px] text-danger">{t('Это не похоже на адрес репозитория GitHub: нужно https://github.com/владелец/имя')}</div>
      ) : ref ? (
        <div className="text-[11px] text-[var(--muted)]">{t('Репозиторий: {repo}', { repo: `${ref.owner}/${ref.repo}` })}</div>
      ) : null}
      <Note>{t('При первой отправке может открыться окно входа в GitHub — войдите там, doplan пароль не увидит.')}</Note>
      <ErrorBox text={error} />
      <div className="flex justify-end">
        <Button variant="primary" icon={busy === 'connect' ? <Spinner /> : <CloudUpload size={12} />} disabled={!ref || !!busy} onClick={() => void submit()}>
          {busy === 'connect' ? t('Подключаю…') : t('Подключить и отправить')}
        </Button>
      </div>
    </div>
  )
}

function CreateWay() {
  const t = useT()
  const [gh, setGh] = useState<GhStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const check = async () => {
    setChecking(true)
    try {
      setGh(await api.github.ghStatus())
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void check()
  }, [])

  if (!gh) return <div className="flex items-center gap-2 py-2 text-[var(--muted)]"><Spinner /> {t('Ищу GitHub CLI…')}</div>
  if (!gh.installed) return <InstallGh gh={gh} checking={checking} recheck={() => void check()} />
  if (!gh.loggedIn) return <LoginGh onDone={() => void check()} />
  return <CreateRepo user={gh.user ?? ''} onSwitch={() => void check()} />
}

function Steps({ n, of, children }: { n: number; of: number; children: React.ReactNode }) {
  const t = useT()
  return (
    <div className="text-[11px] font-semibold tracking-wide text-[var(--muted)] uppercase">
      {t('Шаг {n} из {of}', { n, of })} · {children}
    </div>
  )
}

function InstallGh({ gh, checking, recheck }: { gh: GhStatus; checking: boolean; recheck(): void }) {
  const t = useT()
  const [started, setStarted] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <Steps n={1} of={3}>{t('Установка GitHub CLI')}</Steps>
      <Note>
        {t('Чтобы doplan сам создал репозиторий, нужна бесплатная программа GitHub CLI (gh) от GitHub. Установите её один раз — это займёт пару минут.')}
      </Note>
      {gh.install.canRun ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="primary"
            onClick={async () => {
              setStarted(await api.github.installGh())
            }}
          >
            {t('Установить GitHub CLI')}
          </Button>
          <Button variant="ghost" icon={<ExternalLink size={12} />} onClick={() => void api.github.openPage('install')}>
            {t('Инструкция')}
          </Button>
        </div>
      ) : (
        <>
          <Note>{t('Выполните в терминале:')}</Note>
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] select-text">{gh.install.command}</code>
            <Button size="sm" icon={<Copy size={11} />} onClick={() => copy(gh.install.command, t('Команда скопирована'))}>
              {t('Копировать')}
            </Button>
          </div>
          <div>
            <Button variant="ghost" icon={<ExternalLink size={12} />} onClick={() => void api.github.openPage('install')}>
              {t('Инструкция по установке')}
            </Button>
          </div>
        </>
      )}
      {started && <Note>{t('Открылось окно установки. Когда оно закончит работу, нажмите «Проверить снова».')}</Note>}
      <div className="flex justify-end">
        <Button icon={checking ? <Spinner /> : <RefreshCw size={12} />} disabled={checking} onClick={recheck}>
          {t('Проверить снова')}
        </Button>
      </div>
      <Note>{t('Не хотите устанавливать? Создайте репозиторий на github.com сами и выберите «Вставить ссылку».')}</Note>
    </div>
  )
}

function LoginGh({ onDone }: { onDone(): void }) {
  const t = useT()
  const [code, setCode] = useState<{ code: string; url: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const off = api.github.onLogin((ev) => {
      if (ev.type === 'code') {
        setCode({ code: ev.code, url: ev.url })
        return
      }
      setRunning(false)
      setCode(null)
      if (ev.ok) {
        toast(ev.user ? t('Вход в GitHub выполнен: {user}', { user: ev.user }) : t('Вход в GitHub выполнен'), 'success')
        onDone()
      } else setError(ev.error ?? t('Вход не выполнен'))
    })
    return () => {
      off()
      void api.github.loginCancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    setError(null)
    setCode(null)
    setRunning(true)
    try {
      await api.github.login()
    } catch (err) {
      setRunning(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Steps n={2} of={3}>{t('Вход в GitHub')}</Steps>
      <Note>{t('GitHub CLI установлен. Войдите в свой аккаунт GitHub через браузер: doplan покажет одноразовый код, его нужно ввести на странице GitHub.')}</Note>
      {code ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-[var(--border)] p-3">
          <div className="text-[11px] text-[var(--muted)]">{t('Ваш одноразовый код')}</div>
          <div className="font-mono text-2xl font-semibold tracking-[0.2em] select-all">{code.code}</div>
          <div className="flex flex-wrap justify-center gap-1.5">
            <Button size="sm" icon={<Copy size={11} />} onClick={() => copy(code.code, t('Код скопирован'))}>
              {t('Скопировать код')}
            </Button>
            <Button size="sm" variant="primary" icon={<ExternalLink size={11} />} onClick={() => void api.github.openPage('device')}>
              {t('Открыть страницу GitHub')}
            </Button>
          </div>
          <Note className="text-center">{t('Вставьте код на странице github.com/login/device и подтвердите доступ. Окно обновится само.')}</Note>
        </div>
      ) : running ? (
        <div className="flex items-center gap-2 py-1 text-[var(--muted)]"><Spinner /> {t('Получаю код…')}</div>
      ) : null}
      <ErrorBox text={error} />
      <div className="flex justify-end gap-1.5">
        {running ? (
          <Button
            onClick={() => {
              void api.github.loginCancel()
              setRunning(false)
              setCode(null)
            }}
          >
            {t('Отмена')}
          </Button>
        ) : (
          <Button variant="primary" icon={<LogIn size={12} />} onClick={() => void start()}>
            {t('Войти в GitHub')}
          </Button>
        )}
      </div>
    </div>
  )
}

function CreateRepo({ user, onSwitch }: { user: string; onSwitch(): void }) {
  const t = useT()
  const busy = useGithub((s) => s.busy)
  const projectName = useDoc((s) => s.doc.meta.name)
  const [name, setName] = useState(() => repoNameFromProject(projectName))
  const [isPrivate, setPrivate] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const valid = isValidRepoName(name.trim())
  const submit = async () => {
    if (!valid || busy) return
    setError(null)
    setError(await githubCreate(name.trim(), isPrivate))
  }
  return (
    <div className="flex flex-col gap-2">
      <Steps n={3} of={3}>{t('Новый репозиторий')}</Steps>
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
        <Check size={12} className="text-success" />
        {user ? t('Вы вошли в GitHub как {user}', { user }) : t('Вы вошли в GitHub')}
        <button type="button" className="ml-1 underline hover:text-[var(--text)]" onClick={onSwitch}>
          {t('обновить')}
        </button>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--muted)]">{t('Имя репозитория')}</span>
        <Input
          value={name}
          onChange={(v) => {
            setName(v)
            setError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          spellCheck={false}
          aria-invalid={!valid}
        />
      </label>
      {!valid && <div className="text-[11px] text-danger">{t('Только латинские буквы, цифры, точка, дефис и подчёркивание, до 100 символов; в начале не дефис')}</div>}
      <Segmented<'private' | 'public'>
        aria-label={t('Доступ')}
        value={isPrivate ? 'private' : 'public'}
        onChange={(v) => setPrivate(v === 'private')}
        options={[
          { value: 'private', label: <span className="inline-flex items-center gap-1"><Lock size={11} /> {t('Приватный')}</span> },
          { value: 'public', label: <span className="inline-flex items-center gap-1"><Globe size={11} /> {t('Публичный')}</span> },
        ]}
      />
      <Note>
        {isPrivate
          ? t('Видите только вы и те, кого вы пригласите на GitHub.')
          : t('Проект — план, модели, текстуры — сможет посмотреть и скачать любой человек в интернете.')}
      </Note>
      <ErrorBox text={error} />
      <div className="flex justify-end">
        <Button variant="primary" icon={busy === 'connect' ? <Spinner /> : <CloudUpload size={12} />} disabled={!valid || !!busy} onClick={() => void submit()}>
          {busy === 'connect' ? t('Создаю и отправляю…') : t('Создать и отправить')}
        </Button>
      </div>
    </div>
  )
}

// ───────────── conflict ─────────────

/** a file of the project in words a user knows */
function partName(path: string, t: ReturnType<typeof useT>): string {
  if (path === 'plan.json') return t('план (стены, комнаты, мебель)')
  if (path === 'manifest.json') return t('описание проекта')
  if (path === 'AGENTS.md' || path === 'CLAUDE.md') return t('инструкции для ИИ')
  const name = path.split('/').pop() ?? path
  return path.startsWith('assets/') ? t('файл ресурса {name}', { name }) : name
}

function Choice({ title, text, onClick, primary }: { title: string; text: string; onClick(): void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors hover:border-[var(--accent)]',
        primary ? 'border-[var(--accent)]' : 'border-[var(--border)]',
      )}
    >
      <span className="text-xs font-medium text-[var(--text)]">{title}</span>
      <span className="text-[11px] leading-relaxed text-[var(--muted)]">{text}</span>
    </button>
  )
}

function GithubConflictDialog({ open }: { open: boolean }) {
  const t = useT()
  const conflicts = useGithub((s) => s.conflicts)
  const parts = [...new Set(conflicts.map((c) => partName(c, t)))]
  return (
    <Dialog
      open={open}
      onClose={githubCancelConflict}
      title={t('Проект изменён и здесь, и на GitHub')}
      width="max-w-lg"
      footer={<Button onClick={githubCancelConflict}>{t('Решить позже')}</Button>}
    >
      <div className="flex flex-col gap-3 text-xs">
        <Note>
          {t('Одни и те же части проекта поменялись и на этом компьютере, и на GitHub, и объединить их само не получилось:')}
          {' '}
          <span className="text-[var(--text)]">{parts.join(', ')}</span>.
          {' '}
          {t('Выберите, какую версию оставить. Ничего не пропадёт: другая версия останется в истории версий.')}
        </Note>
        <Choice
          primary
          title={t('Оставить мою версию')}
          text={t('Проект останется как на экране; при отправке он заменит версию на GitHub.')}
          onClick={() => void githubResolve('mine')}
        />
        <Choice
          title={t('Взять версию с GitHub')}
          text={t('Проект станет как на GitHub. Ваша версия останется в истории версий — к ней можно вернуться.')}
          onClick={() => void githubResolve('theirs')}
        />
        <Choice
          title={t('Сохранить обе')}
          text={t('Здесь остаётся ваша версия, а версия с GitHub сохраняется рядом отдельной папкой проекта — сравните и перенесите нужное.')}
          onClick={() => void githubResolve('both')}
        />
      </div>
    </Dialog>
  )
}
