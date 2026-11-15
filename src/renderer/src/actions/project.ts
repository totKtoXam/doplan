import { createEmptyDoc, newProjectId, parseDoc } from '@core'
import type { Doc } from '@core/types'
import type { ProjectInfo, ProjectVersion, UnsafeGitConfig } from '@shared/ipc'
import { buildCommitMessage } from '@shared/projectFormat'
import type { DocReload } from '@/contracts'
import { t } from '@/i18n'
import { api } from '@/store/api'
import { docStore, historyPosition, undoLabelsSince } from '@/store/document'
import { handles } from '@/store/handles'
import { alertDialog, choiceDialog, confirmDialog, promptDialog, toast } from '@/store/notify'
import { createDialogForks, finishCreateDialog, openCreateDialog, type ProjectKind, projectStore } from '@/store/project'
import { runProjectHooks } from '@/store/projectHooks'
import { buildSampleApartment } from '@/store/sample'
import { uiStore } from '@/store/ui'
import { currentDoc, errorText } from './util'

function kindOfPath(path: string | null): ProjectKind | null {
  if (!path) return null
  if (/\.doplan$/i.test(path)) return 'zip'
  if (/\.json$/i.test(path)) return 'json'
  return 'folder'
}

/** Load a document into the store and reset the per-document UI state. */
export function loadDocument(
  doc: Doc,
  filePath: string | null,
  project?: { kind?: ProjectKind | null; git?: boolean; untrustedGit?: boolean; gitFile?: boolean; unsafeGit?: UnsafeGitConfig | null; reload?: DocReload },
): void {
  docStore.getState().load(doc, filePath, project?.reload ?? null)
  const d = docStore.getState().doc
  uiStore.getState().set({
    activeLevelId: d.levelOrder[0] ?? '',
    selection: [],
    hover: null,
    tool: 'select',
    placingAssetId: null,
    wallThickness: d.settings.wallThickness,
    wallHeight: d.settings.wallHeight,
  })
  const kind = filePath ? (project?.kind ?? kindOfPath(filePath)) : null
  const root = kind === 'folder' ? filePath : null
  projectStore.setState({
    root,
    kind,
    git: root ? !!project?.git : false,
    untrustedGit: root ? !!project?.untrustedGit : false,
    gitFile: root ? !!project?.gitFile : false,
    unsafeGit: root ? (project?.unsafeGit ?? null) : null,
    commitMarker: historyPosition(),
    viewing: null,
  })
  // a document that does not come from a folder detaches the folder in main (AI chat cwd, instructions)
  if (!root) void api.project.attach(null).catch(() => {})
  requestAnimationFrame(() => handles.editor2d?.zoomToFit())
}

/**
 * Unsaved edits in the AGENTS.md editor: asks whether to save them before the window closes or another
 * project opens. Resolves true when it is OK to continue (saved or discarded; the editor is closed).
 */
export async function confirmInstructionsDiscard(): Promise<boolean> {
  const draft = projectStore.getState().instructionsDraft
  if (!draft) return true
  const choice = await choiceDialog(t('Несохранённые инструкции'), t('Сохранить изменения в AGENTS.md?'), [
    { id: 'cancel', label: t('Отмена') },
    { id: 'discard', label: t('Не сохранять'), variant: 'danger' },
    { id: 'save', label: t('Сохранить'), variant: 'primary' },
  ])
  if (choice !== 'save' && choice !== 'discard') return false
  if (choice === 'save') {
    if (projectStore.getState().root !== draft.root) return false // the project changed meanwhile: keep the editor
    try {
      const commit = await api.project.setInstructions(draft.text)
      if (commit) projectStore.setState((s) => ({ historyRev: s.historyRev + 1 }))
      toast(t('Инструкции сохранены'), 'success')
    } catch (err) {
      await alertDialog(t('Не удалось сохранить инструкции'), errorText(err))
      return false
    }
  }
  projectStore.setState({ dialog: null, instructionsDraft: null })
  return true
}

/**
 * Asks what to do with unsaved changes (the plan and the AGENTS.md editor). Resolves true when it is
 * OK to continue (saved or discarded), false when the user cancelled.
 */
export async function confirmDiscard(): Promise<boolean> {
  if (!(await confirmInstructionsDiscard())) return false
  if (!docStore.getState().dirty) return true
  const choice = await choiceDialog(t('Несохранённые изменения'), t('Сохранить изменения в проекте «{name}»?', { name: currentDoc().meta.name }), [
    { id: 'cancel', label: t('Отмена') },
    { id: 'discard', label: t('Не сохранять'), variant: 'danger' },
    { id: 'save', label: t('Сохранить'), variant: 'primary' },
  ])
  if (choice === 'save') return saveProject(false)
  return choice === 'discard'
}

/** "Новый проект": asks for a name and a location, creates the folder (git init + first commit). */
export async function newProject(): Promise<void> {
  if (!(await confirmDiscard())) return
  if (api.platform === 'browser') {
    // no project folders in the web build: start an empty unsaved document as before
    try {
      await api.project.reset()
    } catch (err) {
      console.warn('[doplan] project.reset failed', err)
    }
    loadDocument(createEmptyDoc(t('Новый проект')), null)
    return
  }
  await openCreateDialog('new')
}

export async function newSampleProject(): Promise<void> {
  if (!(await confirmDiscard())) return
  try {
    await api.project.reset()
  } catch (err) {
    console.warn('[doplan] project.reset failed', err)
  }
  loadDocument(buildSampleApartment(t('Пример квартиры')), null)
}

/**
 * The id a document is written with: Save As of a saved file makes a new project (its own chats); the
 * first save of a new document keeps its id whichever command does it; an older file without one gets one now.
 */
function saveId(doc: Doc, filePath: string | null, saveAs: boolean): string {
  return (saveAs && filePath) || !doc.meta.id ? newProjectId() : doc.meta.id
}

function withId(doc: Doc, id: string): Doc {
  return id === doc.meta.id ? doc : { ...doc, meta: { ...doc.meta, id } }
}

function refreshRecent(): void {
  void api.settings
    .get()
    .then((s) => uiStore.setState({ appSettings: s }))
    .catch(() => {})
}

/**
 * Called by the create dialog. `mode: 'new'` creates an empty project, `'saveAs'` writes the current
 * document into a new folder (keeping its undo history). Resolves with an error text or null.
 */
export async function createProjectFolder(mode: 'new' | 'saveAs', name: string, parent: string | null): Promise<string | null> {
  const clean = name.trim()
  if (!clean) return t('Введите название проекта')
  try {
    if (mode === 'new') {
      const doc = createEmptyDoc(clean)
      const res = await api.project.create(doc, clean, parent)
      loadDocument(doc, res.path, { kind: 'folder', git: res.git })
      void api.project.clearRecovery().catch(() => {})
    } else {
      const store = docStore.getState()
      if (store.doc.meta.name !== clean) store.transact(t('Название проекта'), (d) => void (d.meta.name = clean))
      const doc = docStore.getState().doc
      const fork = createDialogForks()
      const id = saveId(doc, docStore.getState().filePath, fork)
      const res = await api.project.create(withId(doc, id), clean, parent)
      docStore.getState().markSaved(res.path, id)
      projectStore.setState({ root: res.path, kind: 'folder', git: !!res.git, untrustedGit: false, gitFile: false, unsafeGit: null, commitMarker: historyPosition(), viewing: null })
      void api.project.clearRecovery().catch(() => {})
      // the chats follow the document (a Save As copy gets its own); awaited like any save
      await runProjectHooks('saved', fork)
    }
    refreshRecent()
    projectStore.setState((s) => ({ historyRev: s.historyRev + 1 }))
    finishCreateDialog(true)
    const { git } = projectStore.getState()
    toast(git ? t('Папка проекта создана, история версий включена') : t('Папка проекта создана. Git не найден — история версий недоступна'), git ? 'success' : 'warning', 5000)
    return null
  } catch (err) {
    return errorText(err)
  }
}

async function afterOpen(res: Awaited<ReturnType<typeof api.project.open>>, reload: DocReload = null): Promise<void> {
  if (!res) return
  let doc: Doc
  try {
    doc = parseDoc(res.doc)
  } catch (err) {
    await alertDialog(t('Файл проекта повреждён или имеет неверный формат'), errorText(err))
    return
  }
  // the same project read again keeps the id it has in memory, like viewVersion: an opened copy got its
  // own id that plan.json does not hold until the next save
  if (reload) doc = keepId(doc)
  // main switches the project root and assets only now, after the document was validated
  try {
    await api.project.attach(res.path)
  } catch (err) {
    await alertDialog(t('Не удалось открыть проект'), errorText(err))
    return
  }
  loadDocument(doc, res.path, { kind: res.kind ?? kindOfPath(res.path), git: res.git, untrustedGit: res.untrustedGit || res.untrustedFolder, gitFile: res.gitFile, unsafeGit: res.unsafeGit, reload })
  refreshRecent()
  toast(t('Проект открыт'), 'success')
  if (res.untrustedGit) await offerTrustFolder('git')
  // a trusted folder whose git config has unknown keys: reset it or work without versions (asked once per session)
  else if (res.unsafeGit && !reload) await offerResetGitConfig()
  if (res.kind === 'zip' && api.platform !== 'browser') {
    const choice = await choiceDialog(
      t('Проект в одном файле .doplan'),
      t('Сохранить его как папку проекта? В папке ведётся история версий (git) и лежат инструкции для ИИ (AGENTS.md). Файл .doplan останется без изменений.'),
      [
        { id: 'later', label: t('Не сейчас') },
        { id: 'folder', label: t('Сохранить как папку проекта'), variant: 'primary' },
      ],
    )
    if (choice === 'folder') await openCreateDialog('saveAs')
  }
}

/** folders (lower-cased) the user chose not to trust in this session: the AI chat does not ask again */
const notTrusted = new Set<string>()

/**
 * Asks whether the user trusts the open project folder.
 * 'git': the opened folder already had a .git that doplan did not create — its config and hooks are
 * not trusted, so doplan runs no git commands there until the user says the folder is theirs.
 * 'folder': a folder without a repository that doplan did not create — doplan creates no repository
 * there (git would look into whatever the folder brought) until the user trusts it.
 * 'ai': before the first AI agent run in a folder doplan did not create here (or that was replaced or
 * moved): an untrusted folder is not the agent's working directory.
 */
export async function offerTrustFolder(reason: 'git' | 'folder' | 'ai'): Promise<boolean> {
  const root = projectStore.getState().root
  if (!root) return false
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  const choice = await choiceDialog(
    reason === 'git' ? t('В папке уже есть репозиторий git') : t('Доверять папке проекта?'),
    reason === 'git'
      ? t('Эту папку создал не doplan, и в её настройках git могут быть чужие команды. Пока вы не доверяете папке, doplan не запускает в ней git: история версий выключена, сохранение пишет только файлы, а ИИ-агент работает в отдельной папке. Доверяйте, только если папка ваша или получена из надёжного источника.')
      : reason === 'folder'
        ? t('Папку «{name}» создал не doplan (или её заменили либо переместили). Пока вы не доверяете папке, doplan не создаёт в ней репозиторий git: история версий выключена, сохранение пишет только файлы, а ИИ-агент работает в отдельной папке. Доверяйте, только если папка ваша или получена из надёжного источника.', { name })
        : t('Папку «{name}» doplan не создавал на этом компьютере (или её заменили либо переместили). В доверенной папке ИИ-агент работает прямо в ней: следует её AGENTS.md как вашим инструкциям, читает её настройки агента (.claude, .codex, .gemini) и запускает в ней git. Иначе агент работает в отдельной папке и видит AGENTS.md только как заметки автора. Доверяйте, только если папка ваша или получена из надёжного источника.', { name }),
    reason !== 'ai'
      ? [
          { id: 'no', label: t('Не доверять') },
          { id: 'yes', label: t('Доверять этой папке'), variant: 'primary' },
        ]
      : [
          { id: 'cancel', label: t('Отмена') },
          { id: 'no', label: t('Работать вне папки') },
          { id: 'yes', label: t('Доверять этой папке'), variant: 'primary' },
        ],
  )
  if (choice === 'no') notTrusted.add(root.toLowerCase())
  if (choice !== 'yes') return false
  try {
    const ok = await api.project.trustFolder()
    if (!ok) return false
    notTrusted.delete(root.toLowerCase())
    applyGitInfo(await api.project.info())
    if (projectStore.getState().unsafeGit) await offerResetGitConfig()
    return true
  } catch (err) {
    await alertDialog(t('Не удалось доверить папку'), errorText(err))
    return false
  }
}

/** the git state of the open folder as main sees it now */
function applyGitInfo(info: ProjectInfo): void {
  projectStore.setState((s) => ({
    git: info.gitAvailable && info.trusted && !info.gitFile && !info.unsafeGit,
    untrustedGit: !info.trusted,
    unsafeGit: info.unsafeGit,
    historyRev: s.historyRev + 1,
  }))
}

const shortList = (l: string[]) => l.slice(0, 8).join(', ') + (l.length > 8 ? ', …' : '')

/**
 * What the user is told about a repository doplan runs no git in: unsupported links or files in .git
 * (no reset helps, nothing to edit in .git/config), or config keys outside the allowlist.
 */
export function unsafeGitNotice(u: UnsafeGitConfig): { title: string; text: string } {
  if (u.layout?.length) {
    return {
      title: t('Репозиторий не поддерживается'),
      text: t('В папке репозитория (.git) есть ссылки или файлы, которые doplan не поддерживает: {paths}. doplan не запускает в ней git: история версий выключена, сохранение пишет только файлы. Сброс настроек git этого не исправит; историей такой папки управляйте в своём git-клиенте.', { paths: shortList(u.layout) }),
    }
  }
  return {
    title: t('Небезопасные настройки git'),
    text: t('В настройках git этой папки есть параметры, через которые git или его дополнения могут запускать программы: {keys}. Пока они там, doplan не запускает в папке git: история версий выключена, сохранение пишет только файлы.', { keys: shortList(u.keys) }),
  }
}

/** folders (lower-cased) whose user chose to work without versions in this session */
const withoutVersions = new Set<string>()

/**
 * The open (trusted) folder's git config has keys outside doplan's allowlist: git could run programs
 * named there, so doplan runs no git at all. The user resets the config to the allowed keys (a backup
 * stays in .git) or works without versions. `ask`: false when the user already chose to reset (the
 * history dialog's button), true to ask first; a folder whose user chose to work without versions is
 * not asked again in this session.
 */
export async function offerResetGitConfig(ask = true): Promise<boolean> {
  const { root, unsafeGit } = projectStore.getState()
  if (!root || !unsafeGit) return false
  if (ask) {
    if (withoutVersions.has(root.toLowerCase())) return false
    const notice = unsafeGitNotice(unsafeGit)
    if (!unsafeGit.resettable) {
      await alertDialog(notice.title, notice.text)
      withoutVersions.add(root.toLowerCase())
      return false
    }
    const text = notice.text
    const choice = await choiceDialog(
      notice.title,
      `${text} ${t('Сброс оставит в .git/config только простые параметры (имя автора, адрес удалённого репозитория, ветки); прежний файл сохранится как .git/config.doplan-backup.')}`,
      [
        { id: 'no', label: t('Работать без версий') },
        { id: 'reset', label: t('Сбросить настройки git'), variant: 'primary' },
      ],
    )
    if (choice !== 'reset') {
      withoutVersions.add(root.toLowerCase())
      return false
    }
  }
  try {
    const backup = await api.project.resetGitConfig()
    withoutVersions.delete(root.toLowerCase())
    applyGitInfo(await api.project.info())
    toast(t('Настройки git сброшены, прежние сохранены в {file}', { file: backup.split(/[\\/]/).slice(-2).join('/') }), 'success')
    return true
  } catch (err) {
    await alertDialog(t('Не удалось сбросить настройки git'), errorText(err))
    return false
  }
}

/**
 * Before an AI agent run: in an open project folder the user has not trusted yet, asks once per
 * session. Resolves false when the user cancelled the run.
 */
export async function ensureAiFolderTrust(): Promise<boolean> {
  const root = projectStore.getState().root
  if (!root || api.platform === 'browser' || notTrusted.has(root.toLowerCase())) return true
  let info: Awaited<ReturnType<typeof api.project.info>>
  try {
    info = await api.project.info()
  } catch {
    return true // main decides the working directory itself: an unknown state only means no question
  }
  if (!info.root || info.folderTrusted) return true
  // «Работать вне папки» adds the folder to notTrusted: the run goes on in the separate work folder
  return (await offerTrustFolder('ai')) || notTrusted.has(root.toLowerCase())
}

/**
 * Opens a project folder, its plan.json or a .doplan / .json file (dialog when `path` is omitted).
 * `reload`: the open project read again from its folder (see DocState.reload).
 */
export async function openProject(path?: string, opts?: { skipConfirm?: boolean; reload?: DocReload }): Promise<void> {
  if (!opts?.skipConfirm && !(await confirmDiscard())) return
  try {
    await afterOpen(await api.project.open(path), opts?.reload ?? null)
  } catch (err) {
    await alertDialog(t('Не удалось открыть проект'), errorText(err))
  }
}

export async function openProjectFolder(): Promise<void> {
  if (!(await confirmDiscard())) return
  try {
    await afterOpen(await api.project.openFolder())
  } catch (err) {
    await alertDialog(t('Не удалось открыть проект'), errorText(err))
  }
}

function versionDate(v: ProjectVersion): string {
  return new Date(v.date).toLocaleString(uiStore.getState().lang === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** commit subject for the next save: the undo labels since the last commit */
export function pendingCommitMessage(): string {
  const labels = undoLabelsSince(projectStore.getState().commitMarker).map((l) => t(l))
  return buildCommitMessage(labels, { empty: t('Сохранение') })
}

/** Resolves true when the document was written. */
export async function saveProject(saveAs = false, opts?: { message?: string; overwrite?: boolean }): Promise<boolean> {
  const { doc, filePath } = docStore.getState()
  const ps = projectStore.getState()
  const folder = ps.kind === 'folder' && !!filePath
  if (saveAs || !filePath || (!folder && ps.kind !== 'zip' && api.platform !== 'browser')) {
    if (api.platform === 'browser') return saveFileLegacy(null)
    // only Save As of a saved file is a new project; Ctrl+S on a .json turns that file into a folder
    return openCreateDialog('saveAs', saveAs && !!filePath)
  }
  if (!folder) return saveFileLegacy(filePath)

  let message = opts?.message
  if (!message && ps.viewing) {
    const v = ps.viewing
    const ok = await confirmDialog(
      t('Восстановить эту версию?'),
      t('Версия от {date} («{msg}») станет текущей. Будет создана новая версия, история не изменится.', { date: versionDate(v), msg: v.message }),
      { ok: t('Восстановить') },
    )
    if (!ok) return false
    message = t('Восстановлена версия от {date}: {msg}', { date: versionDate(v), msg: v.message })
  }
  message ??= pendingCommitMessage()

  try {
    const id = saveId(doc, filePath, false)
    const res = await api.project.save(withId(doc, id), filePath, { message, overwrite: opts?.overwrite })
    if (!res) return false
    if (res.externalChange) {
      const choice = await choiceDialog(
        t('plan.json изменён вне doplan'),
        t('Файл плана в папке проекта изменился после открытия (например, его отредактировал ИИ-агент). Перезаписать его вашей версией или загрузить версию с диска?'),
        [
          { id: 'cancel', label: t('Отмена') },
          { id: 'reload', label: t('Загрузить с диска'), variant: 'danger' },
          { id: 'overwrite', label: t('Перезаписать'), variant: 'primary' },
        ],
      )
      if (choice === 'overwrite') return saveProject(false, { message, overwrite: true })
      if (choice === 'reload') await openProject(filePath, { skipConfirm: true, reload: ps.viewing ? 'version' : 'disk' })
      return false
    }
    docStore.getState().markSaved(res.path, id)
    projectStore.setState((s) => ({ commitMarker: historyPosition(), viewing: null, historyRev: s.historyRev + 1 }))
    await runProjectHooks('saved', false)
    void api.project.clearRecovery().catch(() => {})
    refreshRecent()
    if (res.commitError) toast(t('Сохранено, но версия не записана: {err}', { err: res.commitError }), 'warning', 7000)
    else if (res.commit) toast(t('Сохранено · версия «{msg}»', { msg: message }), 'success')
    else toast(t('Проект сохранён'), 'success')
    return true
  } catch (err) {
    await alertDialog(t('Не удалось сохранить проект'), errorText(err))
    return false
  }
}

/** single-file save (.doplan opened earlier, or the browser fallback) */
async function saveFileLegacy(target: string | null): Promise<boolean> {
  const { doc, filePath } = docStore.getState()
  const saveAs = target === null
  const id = saveId(doc, filePath, saveAs)
  try {
    const res = await api.project.save(withId(doc, id), target)
    if (!res) return false
    docStore.getState().markSaved(res.path, id)
    projectStore.setState({ root: null, kind: kindOfPath(res.path), git: false, untrustedGit: false, gitFile: false, unsafeGit: null, commitMarker: historyPosition(), viewing: null })
    // awaited: a save from the close dialog is followed by the window closing
    await runProjectHooks('saved', saveAs)
    void api.project.clearRecovery().catch(() => {})
    refreshRecent()
    toast(t('Проект сохранён'), 'success')
    return true
  } catch (err) {
    await alertDialog(t('Не удалось сохранить проект'), errorText(err))
    return false
  }
}

/** Экспорт → .doplan: a single-file copy for sharing; the open project is unchanged. */
export async function exportDoplan(): Promise<void> {
  try {
    const path = await api.project.exportZip(currentDoc())
    if (path) toast(t('Сохранён файл {name}', { name: path.split(/[\\/]/).pop() ?? path }), 'success')
  } catch (err) {
    await alertDialog(t('Не удалось экспортировать проект'), errorText(err))
  }
}

// ───────────── versions ─────────────

/** opens the history dialog, or offers to turn the document into a project folder first */
export async function openHistory(): Promise<void> {
  if (!(await ensureFolder(t('История версий ведётся для папки проекта.')))) return
  projectStore.setState({ dialog: 'history' })
}

export async function openInstructions(): Promise<void> {
  if (!(await ensureFolder(t('Инструкции для ИИ хранятся в папке проекта (AGENTS.md).')))) return
  projectStore.setState({ dialog: 'instructions' })
}

async function ensureFolder(why: string): Promise<boolean> {
  if (projectStore.getState().root) return true
  if (api.platform === 'browser') {
    await alertDialog(t('Недоступно в браузере'), t('Папки проектов доступны только в настольном приложении.'))
    return false
  }
  const ok = await confirmDialog(t('Проект не сохранён в папку'), `${why} ${t('Сохранить проект как папку?')}`, { ok: t('Сохранить как папку') })
  if (!ok) return false
  return openCreateDialog('saveAs')
}

/** loads an old version into the editor (Ctrl+S then restores it as a new commit) */
export async function viewVersion(v: ProjectVersion): Promise<boolean> {
  const root = projectStore.getState().root
  if (!root) return false
  if (!(await confirmDiscard())) return false
  let doc: Doc
  try {
    doc = parseDoc(await api.project.versionDoc(v.sha))
  } catch (err) {
    await alertDialog(t('Не удалось открыть версию'), errorText(err))
    return false
  }
  // an old version is the same project: it keeps the project's id (and so its AI chats), even one
  // written before documents had an id
  doc = keepId(doc)
  const { git, untrustedGit, gitFile, unsafeGit } = projectStore.getState()
  loadDocument(doc, root, { kind: 'folder', git, untrustedGit, gitFile, unsafeGit, reload: 'version' })
  projectStore.setState({ viewing: v, dialog: null })
  toast(t('Открыта версия от {date}', { date: versionDate(v) }), 'info')
  return true
}

/** restores an old version as a new commit (history is never rewritten) */
export async function restoreVersion(v: ProjectVersion): Promise<void> {
  const cur = projectStore.getState().viewing
  if (cur?.sha !== v.sha && !(await viewVersion(v))) return
  await saveProject(false)
}

/** leaves the viewed old version and reloads the current plan.json */
export async function leaveVersion(): Promise<void> {
  const root = projectStore.getState().root
  if (!root) return
  if (docStore.getState().dirty) {
    const ok = await confirmDialog(t('Вернуться к текущей версии?'), t('Изменения в просматриваемой версии будут потеряны.'), { ok: t('Вернуться'), danger: true })
    if (!ok) return
  }
  await openProject(root, { skipConfirm: true, reload: 'version' })
}

/** the open project's id on a document read again from it */
function keepId(doc: Doc): Doc {
  const id = docStore.getState().doc.meta.id
  return id && doc.meta.id !== id ? { ...doc, meta: { ...doc.meta, id } } : doc
}

export async function tagVersion(v: ProjectVersion): Promise<boolean> {
  const label = await promptDialog(t('Отметить версию'), '', t('Например: Согласовано с заказчиком'))
  if (label === null || !label.trim()) return false
  try {
    await api.project.tagVersion(v.sha, label.trim())
    projectStore.setState((s) => ({ historyRev: s.historyRev + 1 }))
    toast(t('Версия отмечена: {name}', { name: label.trim() }), 'success')
    return true
  } catch (err) {
    await alertDialog(t('Не удалось отметить версию'), errorText(err))
    return false
  }
}

let lastAutosavedRevision = -1

/** Writes a crash-recovery snapshot if the document changed since the last one. */
export async function autosaveNow(): Promise<void> {
  const { doc, filePath, dirty, revision } = docStore.getState()
  if (!dirty || revision === lastAutosavedRevision) return
  lastAutosavedRevision = revision
  try {
    await api.project.autosave(doc, filePath)
  } catch (err) {
    console.warn('[doplan] autosave failed', err)
  }
}

/** Main asked to close the window. */
export async function handleCloseRequest(): Promise<void> {
  if (!(await confirmInstructionsDiscard())) return
  if (docStore.getState().dirty) {
    const ok = await confirmDiscard()
    if (!ok) return
  }
  await runProjectHooks('closing')
  try {
    await api.project.clearRecovery()
  } catch {
    /* ignore */
  }
  api.window.confirmClose()
}

/** Offers to restore a snapshot left by a crashed session. Resolves true if one was restored. */
export async function offerRecovery(): Promise<boolean> {
  let snap: Awaited<ReturnType<typeof api.project.recover>> = null
  try {
    snap = await api.project.recover()
  } catch {
    return false
  }
  if (!snap) return false
  let doc: Doc
  try {
    doc = parseDoc(snap.doc)
  } catch {
    await api.project.clearRecovery().catch(() => {})
    return false
  }
  const choice = await choiceDialog(
    t('Восстановление проекта'),
    t('Найдена несохранённая копия проекта «{name}» от {date}. Восстановить её?', {
      name: doc.meta.name,
      date: new Date(doc.meta.modifiedAt).toLocaleString(uiStore.getState().lang === 'en' ? 'en-GB' : 'ru-RU'),
    }),
    [
      { id: 'discard', label: t('Удалить копию'), variant: 'danger' },
      { id: 'restore', label: t('Восстановить'), variant: 'primary' },
    ],
  )
  if (choice !== 'restore') {
    await api.project.clearRecovery().catch(() => {})
    // the copy of a never-saved document was its only way back to its chats (a saved one keeps them)
    if (!snap.path && doc.meta.id) await api.aiChat.dropChats(`id:${doc.meta.id}`).catch(() => {})
    return false
  }
  let isFolder = false
  if (snap.path && kindOfPath(snap.path) === 'folder') {
    isFolder = await api.project.attach(snap.path).catch(() => false)
  }
  let git = false
  let untrustedGit = false
  let gitFile = false
  let unsafeGit: UnsafeGitConfig | null = null
  if (isFolder) {
    const info = await api.project.info().catch(() => null)
    git = !!info && info.gitAvailable && info.trusted && !info.gitFile && !info.unsafeGit
    untrustedGit = !!info && !info.trusted
    gitFile = !!info?.gitFile
    unsafeGit = info?.unsafeGit ?? null
  }
  loadDocument(doc, isFolder || kindOfPath(snap.path) !== 'folder' ? snap.path : null, { kind: isFolder ? 'folder' : undefined, git, untrustedGit, gitFile, unsafeGit })
  docStore.getState().setDirty(true)
  toast(t('Проект восстановлен'), 'success')
  return true
}
