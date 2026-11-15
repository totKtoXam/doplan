import { createEmptyDoc, parseDoc } from '@core'
import type { Doc } from '@core/types'
import type { ProjectVersion } from '@shared/ipc'
import { buildCommitMessage } from '@shared/projectFormat'
import { t } from '@/i18n'
import { api } from '@/store/api'
import { docStore, historyPosition, undoLabelsSince } from '@/store/document'
import { handles } from '@/store/handles'
import { alertDialog, choiceDialog, confirmDialog, promptDialog, toast } from '@/store/notify'
import { finishCreateDialog, openCreateDialog, type ProjectKind, projectStore } from '@/store/project'
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
export function loadDocument(doc: Doc, filePath: string | null, project?: { kind?: ProjectKind | null; git?: boolean; untrustedGit?: boolean; gitFile?: boolean }): void {
  docStore.getState().load(doc, filePath)
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
      const res = await api.project.create(docStore.getState().doc, clean, parent)
      docStore.getState().markSaved(res.path)
      projectStore.setState({ root: res.path, kind: 'folder', git: !!res.git, untrustedGit: false, gitFile: false, commitMarker: historyPosition(), viewing: null })
      void api.project.clearRecovery().catch(() => {})
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

async function afterOpen(res: Awaited<ReturnType<typeof api.project.open>>): Promise<void> {
  if (!res) return
  let doc: Doc
  try {
    doc = parseDoc(res.doc)
  } catch (err) {
    await alertDialog(t('Файл проекта повреждён или имеет неверный формат'), errorText(err))
    return
  }
  // main switches the project root and assets only now, after the document was validated
  try {
    await api.project.attach(res.path)
  } catch (err) {
    await alertDialog(t('Не удалось открыть проект'), errorText(err))
    return
  }
  loadDocument(doc, res.path, { kind: res.kind ?? kindOfPath(res.path), git: res.git, untrustedGit: res.untrustedGit, gitFile: res.gitFile })
  refreshRecent()
  toast(t('Проект открыт'), 'success')
  if (res.untrustedGit) await offerTrustFolder('git')
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
 * 'ai': before the first AI agent run in a folder doplan did not create here (or that was replaced or
 * moved): an untrusted folder is not the agent's working directory.
 */
export async function offerTrustFolder(reason: 'git' | 'ai'): Promise<boolean> {
  const root = projectStore.getState().root
  if (!root) return false
  const choice = await choiceDialog(
    reason === 'git' ? t('В папке уже есть репозиторий git') : t('Доверять папке проекта?'),
    reason === 'git'
      ? t('Эту папку создал не doplan, и в её настройках git могут быть чужие команды. Пока вы не доверяете папке, doplan не запускает в ней git: история версий выключена, сохранение пишет только файлы, а ИИ-агент работает в отдельной папке. Доверяйте, только если папка ваша или получена из надёжного источника.')
      : t('Папку «{name}» doplan не создавал на этом компьютере (или её заменили либо переместили). В доверенной папке ИИ-агент работает прямо в ней: следует её AGENTS.md как вашим инструкциям, читает её настройки агента (.claude, .codex, .gemini) и запускает в ней git. Иначе агент работает в отдельной папке и видит AGENTS.md только как заметки автора. Доверяйте, только если папка ваша или получена из надёжного источника.', { name: root.split(/[\\/]/).filter(Boolean).pop() ?? root }),
    reason === 'git'
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
    const info = await api.project.info()
    projectStore.setState((s) => ({ git: info.gitAvailable && info.trusted && !info.gitFile, untrustedGit: !info.trusted, historyRev: s.historyRev + 1 }))
    return true
  } catch (err) {
    await alertDialog(t('Не удалось доверить папку'), errorText(err))
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

/** Opens a project folder, its plan.json or a .doplan / .json file (dialog when `path` is omitted). */
export async function openProject(path?: string, opts?: { skipConfirm?: boolean }): Promise<void> {
  if (!opts?.skipConfirm && !(await confirmDiscard())) return
  try {
    await afterOpen(await api.project.open(path))
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
    return openCreateDialog('saveAs')
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
    const res = await api.project.save(doc, filePath, { message, overwrite: opts?.overwrite })
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
      if (choice === 'reload') await openProject(filePath, { skipConfirm: true })
      return false
    }
    docStore.getState().markSaved(res.path)
    projectStore.setState((s) => ({ commitMarker: historyPosition(), viewing: null, historyRev: s.historyRev + 1 }))
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
  const { doc } = docStore.getState()
  try {
    const res = await api.project.save(doc, target)
    if (!res) return false
    docStore.getState().markSaved(res.path)
    projectStore.setState({ root: null, kind: kindOfPath(res.path), git: false, untrustedGit: false, gitFile: false, commitMarker: historyPosition(), viewing: null })
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
  const { git, untrustedGit, gitFile } = projectStore.getState()
  loadDocument(doc, root, { kind: 'folder', git, untrustedGit, gitFile })
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
  await openProject(root, { skipConfirm: true })
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
    return false
  }
  let isFolder = false
  if (snap.path && kindOfPath(snap.path) === 'folder') {
    isFolder = await api.project.attach(snap.path).catch(() => false)
  }
  let git = false
  let untrustedGit = false
  let gitFile = false
  if (isFolder) {
    const info = await api.project.info().catch(() => null)
    git = !!info && info.gitAvailable && info.trusted && !info.gitFile
    untrustedGit = !!info && !info.trusted
    gitFile = !!info?.gitFile
  }
  loadDocument(doc, isFolder || kindOfPath(snap.path) !== 'folder' ? snap.path : null, { kind: isFolder ? 'folder' : undefined, git, untrustedGit, gitFile })
  docStore.getState().setDirty(true)
  toast(t('Проект восстановлен'), 'success')
  return true
}
