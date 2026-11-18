import { app, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { MenuCommand } from '../shared/ipc'
import type { UpdateMenuAction } from '../shared/updater'
import { CH } from './channels'
import { getMainWindow, sendToRenderer } from './window'

type Lang = 'ru' | 'en'

const L = {
  ru: {
    file: 'Файл',
    new: 'Новый проект',
    open: 'Открыть…',
    recent: 'Недавние',
    welcome: 'Начальный экран',
    save: 'Сохранить',
    saveAs: 'Сохранить как…',
    import: 'Импорт',
    importPlanSpec: 'План из PlanSpec (JSON)…',
    importUnderlay: 'Подложка (изображение плана)…',
    importModel: '3D-модель…',
    export: 'Экспорт',
    exportPng: 'Изображение PNG…',
    exportSvg: 'Векторный SVG…',
    exportPdf: 'PDF в масштабе…',
    exportDxf: 'DXF для CAD…',
    exportGlb: '3D-сцена GLB…',
    exportRender: 'Фотореалистичный рендер…',
    settings: 'Настройки…',
    quit: 'Выход',
    edit: 'Правка',
    undo: 'Отменить',
    redo: 'Повторить',
    cut: 'Вырезать',
    copy: 'Копировать',
    paste: 'Вставить',
    delete: 'Удалить',
    selectAll: 'Выделить всё',
    view: 'Вид',
    view2d: 'План 2D',
    view3d: 'Вид 3D',
    viewSplit: '2D + 3D',
    zoomFit: 'Показать всё',
    fullscreen: 'Полноэкранный режим',
    devtools: 'Инструменты разработчика',
    inspect: 'Просмотреть код элемента',
    reload: 'Перезагрузить',
    help: 'Справка',
    checkUpdates: 'Проверить обновления…',
    installUpdate: 'Перезапустить и установить обновление',
    installUpdateV: 'Перезапустить и установить обновление {v}',
    downloadPage: 'Страница загрузки новой версии…',
    downloadPageV: 'Скачать версию {v}…',
    about: 'О программе doplan',
    openFolder: 'Открыть папку проекта…',
    exportDoplan: 'Файл .doplan (один файл)…',
    history: 'История версий…',
    instructions: 'Инструкции для ИИ…',
  },
  en: {
    file: 'File',
    new: 'New project',
    open: 'Open…',
    recent: 'Recent',
    welcome: 'Start screen',
    save: 'Save',
    saveAs: 'Save as…',
    import: 'Import',
    importPlanSpec: 'Plan from PlanSpec (JSON)…',
    importUnderlay: 'Underlay (plan image)…',
    importModel: '3D model…',
    export: 'Export',
    exportPng: 'PNG image…',
    exportSvg: 'SVG vector…',
    exportPdf: 'PDF to scale…',
    exportDxf: 'DXF for CAD…',
    exportGlb: '3D scene GLB…',
    exportRender: 'Photoreal render…',
    settings: 'Settings…',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    delete: 'Delete',
    selectAll: 'Select all',
    view: 'View',
    view2d: '2D plan',
    view3d: '3D view',
    viewSplit: '2D + 3D',
    zoomFit: 'Zoom to fit',
    fullscreen: 'Full screen',
    devtools: 'Developer tools',
    inspect: 'Inspect element',
    reload: 'Reload',
    help: 'Help',
    checkUpdates: 'Check for updates…',
    installUpdate: 'Restart and install update',
    installUpdateV: 'Restart and install update {v}',
    downloadPage: 'New version download page…',
    downloadPageV: 'Download version {v}…',
    about: 'About doplan',
    openFolder: 'Open project folder…',
    exportDoplan: '.doplan file (single file)…',
    history: 'Version history…',
    instructions: 'AI instructions…',
  },
} as const

/** language of the last built menu: the text-field menu speaks it too */
let menuLang: Lang = 'ru'

/**
 * Right click in a text field (or on selected text): Cut / Copy / Paste / Select all. The native
 * menu bar that had them is hidden; the app's own context menus (plan, 3D, layers) prevent this one.
 */
export function showTextContextMenu(wc: WebContents, p: ContextMenuParams): void {
  const t = L[menuLang]
  const items: MenuItemConstructorOptions[] = []
  if (p.isEditable) {
    items.push(
      { label: t.undo, role: 'undo', enabled: p.editFlags.canUndo },
      { label: t.redo, role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { label: t.cut, role: 'cut', enabled: p.editFlags.canCut },
      { label: t.copy, role: 'copy', enabled: p.editFlags.canCopy },
      { label: t.paste, role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { label: t.selectAll, role: 'selectAll', enabled: p.editFlags.canSelectAll },
    )
  } else if (p.selectionText.trim()) {
    items.push({ label: t.copy, role: 'copy' })
  }
  if (!app.isPackaged) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: t.inspect, click: () => wc.inspectElement(p.x, p.y) })
  }
  if (items.length) Menu.buildFromTemplate(items).popup()
}

function cmd(command: MenuCommand) {
  return () => sendToRenderer(CH.evMenu, command)
}

/**
 * Builds the application menu. Editing shortcuts (undo/redo/delete/select all) are only shown as
 * hints (`registerAccelerator: false`) so text inputs keep their native behaviour; the renderer
 * handles those keys itself.
 */
export function buildMenu(
  lang: Lang,
  recent: { path: string; name: string }[],
  onOpenRecent: (path: string) => void,
  update: UpdateMenuAction,
  onDownloadPage: (version?: string) => void,
): void {
  const t = L[lang]
  menuLang = lang
  const withV = (s: string, v: string) => s.replace('{v}', v)
  // «Перезапустить и установить» goes through the renderer: it settles unsaved changes first
  const updateItem: MenuItemConstructorOptions =
    update.kind === 'install'
      ? {
          label: update.version ? withV(t.installUpdateV, update.version) : t.installUpdate,
          enabled: update.enabled,
          click: cmd('installUpdate'),
        }
      : {
          label: update.version ? withV(t.downloadPageV, update.version) : t.downloadPage,
          enabled: update.enabled,
          click: () => onDownloadPage(update.version),
        }
  const hint = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: cmd(command),
  })

  const recentItems: MenuItemConstructorOptions[] = recent.length
    ? recent.slice(0, 10).map((r) => ({ label: r.name || r.path, sublabel: r.path, click: () => onOpenRecent(r.path) }))
    : [{ label: '—', enabled: false }]

  const template: MenuItemConstructorOptions[] = [
    {
      label: t.file,
      submenu: [
        { label: t.new, accelerator: 'CmdOrCtrl+N', click: cmd('new') },
        { label: t.open, accelerator: 'CmdOrCtrl+O', click: cmd('open') },
        { label: t.openFolder, click: cmd('openFolder') },
        { label: t.recent, submenu: recentItems },
        { label: t.welcome, click: cmd('welcome') },
        { type: 'separator' },
        { label: t.save, accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: t.saveAs, accelerator: 'CmdOrCtrl+Shift+S', click: cmd('saveAs') },
        { label: t.history, accelerator: 'CmdOrCtrl+Shift+H', click: cmd('history') },
        { label: t.instructions, click: cmd('instructions') },
        { type: 'separator' },
        {
          label: t.import,
          submenu: [
            { label: t.importPlanSpec, click: cmd('importPlanSpec') },
            { label: t.importUnderlay, click: cmd('importUnderlay') },
            { label: t.importModel, click: cmd('importModel') },
          ],
        },
        {
          label: t.export,
          submenu: [
            { label: t.exportPng, click: cmd('exportPng') },
            { label: t.exportSvg, click: cmd('exportSvg') },
            { label: t.exportPdf, accelerator: 'CmdOrCtrl+P', click: cmd('exportPdf') },
            { label: t.exportDxf, click: cmd('exportDxf') },
            { type: 'separator' },
            { label: t.exportGlb, click: cmd('exportGlb') },
            { label: t.exportRender, accelerator: 'F12', click: cmd('exportRender') },
            { type: 'separator' },
            { label: t.exportDoplan, click: cmd('exportDoplan') },
          ],
        },
        { type: 'separator' },
        { label: t.settings, accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { label: t.quit, accelerator: 'Alt+F4', registerAccelerator: false, click: () => getMainWindow()?.close() ?? app.quit() },
      ],
    },
    {
      label: t.edit,
      submenu: [
        hint(t.undo, 'CmdOrCtrl+Z', 'undo'),
        hint(t.redo, 'CmdOrCtrl+Y', 'redo'),
        { type: 'separator' },
        { label: t.cut, role: 'cut' },
        { label: t.copy, role: 'copy' },
        { label: t.paste, role: 'paste' },
        hint(t.delete, 'Delete', 'delete'),
        { type: 'separator' },
        hint(t.selectAll, 'CmdOrCtrl+A', 'selectAll'),
      ],
    },
    {
      label: t.view,
      submenu: [
        { label: t.view2d, accelerator: 'CmdOrCtrl+1', click: cmd('view2d') },
        { label: t.view3d, accelerator: 'CmdOrCtrl+2', click: cmd('view3d') },
        { label: t.viewSplit, accelerator: 'CmdOrCtrl+3', click: cmd('viewSplit') },
        { type: 'separator' },
        hint(t.zoomFit, 'CmdOrCtrl+0', 'zoomFit'),
        { type: 'separator' },
        { label: t.fullscreen, role: 'togglefullscreen' },
        ...(!app.isPackaged
          ? ([
              { type: 'separator' },
              { label: t.reload, role: 'reload' },
              { label: t.devtools, role: 'toggleDevTools' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: t.help,
      submenu: [
        { label: t.checkUpdates, click: cmd('checkUpdates') },
        updateItem,
        { type: 'separator' },
        { label: t.about, click: cmd('about') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
