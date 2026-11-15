import { newProjectId, parseDoc } from '@core'
import type { Doc } from '@core/types'
import { t } from '@/i18n'
import { api } from '@/store/api'
import { docStore } from '@/store/document'
import { handles } from '@/store/handles'
import { alertDialog, choiceDialog, toast } from '@/store/notify'
import { runProjectHooks } from '@/store/projectHooks'
import { buildSampleApartment } from '@/store/sample'
import { uiStore } from '@/store/ui'
import { currentDoc, errorText } from './util'

/** Load a document into the store and reset the per-document UI state. */
export function loadDocument(doc: Doc, filePath: string | null): void {
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
  requestAnimationFrame(() => handles.editor2d?.zoomToFit())
}

/**
 * Asks what to do with unsaved changes. Resolves true when it is OK to continue
 * (saved or discarded), false when the user cancelled.
 */
export async function confirmDiscard(): Promise<boolean> {
  if (!docStore.getState().dirty) return true
  const choice = await choiceDialog(t('Несохранённые изменения'), t('Сохранить изменения в проекте «{name}»?', { name: currentDoc().meta.name }), [
    { id: 'cancel', label: t('Отмена') },
    { id: 'discard', label: t('Не сохранять'), variant: 'danger' },
    { id: 'save', label: t('Сохранить'), variant: 'primary' },
  ])
  if (choice === 'save') return saveProject(false)
  return choice === 'discard'
}

export async function newProject(): Promise<void> {
  if (!(await confirmDiscard())) return
  try {
    await api.project.reset()
  } catch (err) {
    console.warn('[doplan] project.reset failed', err)
  }
  docStore.getState().newDoc(t('Новый проект'))
  loadDocument(docStore.getState().doc, null)
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

export async function openProject(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return
  let res: Awaited<ReturnType<typeof api.project.open>>
  try {
    res = await api.project.open(path)
  } catch (err) {
    await alertDialog(t('Не удалось открыть проект'), errorText(err))
    return
  }
  if (!res) return
  try {
    const doc = parseDoc(res.doc)
    loadDocument(doc, res.path)
    toast(t('Проект открыт'), 'success')
  } catch (err) {
    await alertDialog(t('Файл проекта повреждён или имеет неверный формат'), errorText(err))
  }
}

/** Resolves true when the document was written. */
export async function saveProject(saveAs = false): Promise<boolean> {
  const { doc, filePath } = docStore.getState()
  const target = saveAs ? null : filePath
  // Save As makes a new project (its own chats); an older file without an id gets one now
  const id = saveAs || !doc.meta.id ? newProjectId() : doc.meta.id
  try {
    const res = await api.project.save(id === doc.meta.id ? doc : { ...doc, meta: { ...doc.meta, id } }, target)
    if (!res) return false
    docStore.getState().markSaved(res.path, id)
    // awaited: a save from the close dialog is followed by the window closing
    await runProjectHooks('saved', saveAs)
    void api.project.clearRecovery().catch(() => {})
    void api.settings
      .get()
      .then((s) => uiStore.setState({ appSettings: s }))
      .catch(() => {})
    toast(t('Проект сохранён'), 'success')
    return true
  } catch (err) {
    await alertDialog(t('Не удалось сохранить проект'), errorText(err))
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
    return false
  }
  loadDocument(doc, snap.path)
  docStore.getState().setDirty(true)
  toast(t('Проект восстановлен'), 'success')
  return true
}
