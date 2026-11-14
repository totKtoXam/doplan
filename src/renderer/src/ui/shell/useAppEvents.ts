/**
 * Window-level behaviour of the shell: keyboard shortcuts, native menu commands, close confirmation,
 * autosave, window title and drag & drop of files.
 */
import { useEffect, useState } from 'react'
import type { MenuCommand } from '@shared/ipc'
import { actions } from '@/actions'
import { t } from '@/i18n'
import { api, isElectron } from '@/store/api'
import { dialogStore } from '@/store/dialogs'
import { docStore } from '@/store/document'
import { notifyStore, alertDialog } from '@/store/notify'
import { uiStore } from '@/store/ui'
import type { ToolId } from '@/contracts'
import { shortcutKey } from './keys'
import { activateTool, TOOLS } from './ToolRail'

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'range', 'color'].includes(type)
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function anyDialogOpen(): boolean {
  const d = dialogStore.getState()
  return d.bom || d.importModel || d.materialEditor || d.settings || d.photoPlan || d.render || notifyStore.getState().modals.length > 0
}

const TOOL_KEYS = new Map<string, ToolId>()
for (const d of TOOLS) if (d !== 'sep' && d.key) TOOL_KEYS.set(d.key.toLowerCase(), d.id)

/** tools during which digits are typed lengths, not view switches */
const DRAWING_TOOLS: ToolId[] = ['wall', 'room', 'dimension', 'measure', 'calibrate', 'door', 'window', 'item', 'label']

function onKeyDown(e: KeyboardEvent): void {
  const ctrl = e.ctrlKey || e.metaKey
  // a focused <select> (grid step, units…) has no undo/copy of its own: let Ctrl shortcuts through
  const selectFocused = (e.target as HTMLElement | null)?.tagName === 'SELECT'
  if (e.defaultPrevented || (isEditable(e.target) && !(ctrl && selectFocused)) || anyDialogOpen()) return
  const key = shortcutKey(e)
  const ui = uiStore.getState()

  if (ctrl && !e.altKey) {
    let handled = true
    switch (key) {
      case 'z':
        if (e.shiftKey) actions.redo()
        else actions.undo()
        break
      case 'y':
        actions.redo()
        break
      case 's':
        void actions.saveProject(e.shiftKey)
        break
      case 'o':
        void actions.openProject()
        break
      case 'n':
        void actions.newProject()
        break
      case 'c':
        actions.copySelection()
        break
      case 'x':
        actions.cutSelection()
        break
      case 'v':
        actions.paste()
        break
      case 'd':
        actions.duplicateSelection()
        break
      case 'a':
        actions.selectAll()
        break
      case '0':
        actions.zoomFit()
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
    return
  }
  if (e.altKey) return

  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      if (ui.selection.length) {
        e.preventDefault()
        actions.deleteSelection()
      }
      return
    case 'Escape':
      if (ui.selection.length) ui.clearSelection()
      else if (ui.tool !== 'select') activateTool('select', t)
      return
    default:
      break
  }

  if (e.repeat) return

  if (e.shiftKey) {
    if (key === 'r' && ui.selection.length) {
      e.preventDefault()
      actions.groupRotate(90)
    }
    return
  }

  if ((key === '1' || key === '2' || key === '3') && !DRAWING_TOOLS.includes(ui.tool)) {
    ui.setMode(key === '1' ? '2d' : key === '2' ? '3d' : 'split')
    return
  }
  const tool = TOOL_KEYS.get(key)
  if (tool) {
    // in walk mode WASD drive the camera
    if (ui.mode !== '2d' && ui.cameraMode === 'walk') return
    activateTool(tool, t)
  }
}

function onMenu(cmd: MenuCommand): void {
  switch (cmd) {
    case 'new':
      void actions.newProject()
      break
    case 'open':
      void actions.openProject()
      break
    case 'save':
      void actions.saveProject(false)
      break
    case 'saveAs':
      void actions.saveProject(true)
      break
    case 'importPlanSpec':
      void actions.importPlanSpec()
      break
    case 'importUnderlay':
      void actions.importUnderlay()
      break
    case 'importModel':
      actions.importModelFiles()
      break
    case 'exportPng':
      void actions.exportPlan('png')
      break
    case 'exportSvg':
      void actions.exportPlan('svg')
      break
    case 'exportPdf':
      void actions.exportPlan('pdf')
      break
    case 'exportDxf':
      void actions.exportPlan('dxf')
      break
    case 'exportGlb':
      void actions.exportGlb()
      break
    case 'exportRender':
      dialogStore.getState().open('render')
      break
    case 'undo':
      actions.undo()
      break
    case 'redo':
      actions.redo()
      break
    case 'delete':
      actions.deleteSelection()
      break
    case 'selectAll':
      actions.selectAll()
      break
    case 'view2d':
      uiStore.getState().setMode('2d')
      break
    case 'view3d':
      uiStore.getState().setMode('3d')
      break
    case 'viewSplit':
      uiStore.getState().setMode('split')
      break
    case 'zoomFit':
      actions.zoomFit()
      break
    case 'settings':
      dialogStore.getState().open('settings')
      break
    case 'about':
      void alertDialog(
        'doplan',
        `${t('Планировки, фотореалистичное 3D и дизайн интерьера')}\n${t('Версия')} ${api.version} · ${api.platform}\n\n${t('Материалы и модели: Poly Haven, ambientCG, Kenney, Quaternius (CC0) и другие — см. лицензии в папке программы.')}`,
      )
      break
  }
}

async function onOpenFile(path: string): Promise<void> {
  if (/\.json$/i.test(path)) {
    try {
      const text = await api.files.readText(path)
      await actions.importPlanSpec(text)
    } catch (err) {
      await alertDialog(t('Не удалось открыть файл'), err instanceof Error ? err.message : String(err))
    }
  } else {
    await actions.openProject(path)
  }
}

function syncTitle(): void {
  const { doc, filePath, dirty } = docStore.getState()
  const name = filePath ? (filePath.split(/[\\/]/).pop() ?? doc.meta.name) : doc.meta.name
  try {
    api.window.setTitle(name, dirty)
  } catch {
    /* ignore */
  }
  document.title = `${dirty ? '• ' : ''}${name} — doplan`
}

/** Installs all window-level listeners. Returns whether files are being dragged over the window. */
export function useAppEvents(enabled: boolean): { dragOver: boolean } {
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const offs: (() => void)[] = []

    window.addEventListener('keydown', onKeyDown)
    offs.push(() => window.removeEventListener('keydown', onKeyDown))

    offs.push(api.window.onMenu(onMenu))
    offs.push(api.window.onCloseRequest(() => void actions.handleCloseRequest()))
    offs.push(api.window.onOpenFile((p) => void onOpenFile(p)))

    // title / dirty flag
    syncTitle()
    offs.push(
      docStore.subscribe((s, prev) => {
        if (s.dirty !== prev.dirty || s.filePath !== prev.filePath || s.doc.meta.name !== prev.doc.meta.name) syncTitle()
      }),
    )

    // autosave (crash recovery)
    let timer = 0
    const schedule = () => {
      window.clearInterval(timer)
      const sec = Math.max(5, uiStore.getState().appSettings?.autosaveSec ?? 30)
      timer = window.setInterval(() => void actions.autosaveNow(), sec * 1000)
    }
    schedule()
    offs.push(() => window.clearInterval(timer))
    offs.push(
      uiStore.subscribe((s, prev) => {
        if (s.appSettings?.autosaveSec !== prev.appSettings?.autosaveSec) schedule()
      }),
    )

    // browser fallback: warn before losing changes
    if (!isElectron) {
      const beforeUnload = (e: BeforeUnloadEvent) => {
        if (docStore.getState().dirty) {
          e.preventDefault()
          e.returnValue = ''
        }
      }
      window.addEventListener('beforeunload', beforeUnload)
      offs.push(() => window.removeEventListener('beforeunload', beforeUnload))
    }

    // drag & drop of files from the OS (in-app drags, e.g. catalog → canvas, carry no files)
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragOver(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragOver(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      void actions.handleDroppedFiles(files)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    offs.push(() => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    })

    return () => {
      for (const off of offs) off()
    }
  }, [enabled])

  return { dragOver }
}
