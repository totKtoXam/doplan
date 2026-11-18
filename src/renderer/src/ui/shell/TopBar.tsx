import clsx from 'clsx'
import type { ReactNode } from 'react'
import {
  Bot,
  History,
  Box,
  Camera,
  ChevronDown,
  ClipboardList,
  Cloud,
  Columns2,
  FilePlus,
  FolderOpen,
  House,
  Image,
  ImagePlus,
  Info,
  Moon,
  Package,
  Paintbrush,
  Redo2,
  RefreshCw,
  Save,
  ScanLine,
  Settings,
  Aperture,
  Square,
  Sun,
  Undo2,
} from 'lucide-react'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { dialogStore } from '@/store/dialogs'
import { useDoc } from '@/store/document'
import { uiStore, useUi } from '@/store/ui'
import { checkForUpdatesManually } from '@/store/updates'
import { openGithubDialog } from '@/store/github'
import { GithubButton } from '@/ui/github/GithubButton'
import type { ViewMode } from '@/contracts'
import { AppLogo } from './AppLogo'
import { DropdownMenu, IconBtn, type MenuEntry, Segmented, Sep, TextBtn, Tip } from './primitives'

function Logo() {
  return (
    <div className="flex shrink-0 items-center gap-1.5 pr-1 pl-1">
      <AppLogo size={20} />
      <span className="text-[13px] font-semibold tracking-tight">doplan</span>
    </div>
  )
}

function MenuTrigger({ label, open, toggle }: { label: string; open: boolean; toggle(): void }) {
  return (
    <button
      type="button"
      onClick={toggle}
      className={clsx(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors',
        open ? 'bg-active text-text' : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      {label}
      <ChevronDown size={12} />
    </button>
  )
}

export function TopBar() {
  const t = useT()
  const canUndo = useDoc((s) => s.canUndo)
  const canRedo = useDoc((s) => s.canRedo)
  const undoLabel = useDoc((s) => s.undoLabel)
  const redoLabel = useDoc((s) => s.redoLabel)
  const dirty = useDoc((s) => s.dirty)
  const name = useDoc((s) => s.doc.meta.name)
  const filePath = useDoc((s) => s.filePath)
  const mode = useUi((s) => s.mode)
  const theme = useUi((s) => s.theme)
  const recent = useUi((s) => s.appSettings?.recent ?? [])

  const fileMenu = (): MenuEntry[] => [
    { label: t('Новый проект'), icon: FilePlus, kbd: 'Ctrl+N', onSelect: () => void actions.newProject() },
    { label: t('Пример квартиры'), icon: House, onSelect: () => void actions.newSampleProject() },
    { label: t('Открыть…'), icon: FolderOpen, kbd: 'Ctrl+O', onSelect: () => void actions.openProject() },
    { label: t('Открыть папку проекта…'), onSelect: () => void actions.openProjectFolder() },
    {
      type: 'submenu',
      label: t('Недавние'),
      disabled: recent.length === 0,
      items: recent.slice(0, 12).map((r) => ({ label: r.name || r.path, onSelect: () => void actions.openProject(r.path) })),
    },
    { type: 'separator' },
    { label: t('Сохранить'), icon: Save, kbd: 'Ctrl+S', onSelect: () => void actions.saveProject(false) },
    { label: t('Сохранить как…'), kbd: 'Ctrl+Shift+S', onSelect: () => void actions.saveProject(true) },
    { label: t('История версий…'), icon: History, kbd: 'Ctrl+Shift+H', onSelect: () => void actions.openHistory() },
    { label: t('Инструкции для ИИ…'), icon: Bot, onSelect: () => void actions.openInstructions() },
    { label: t('GitHub…'), icon: Cloud, onSelect: openGithubDialog },
    { type: 'separator' },
    { type: 'header', label: t('Импорт') },
    { label: t('План из PlanSpec (JSON)…'), onSelect: () => void actions.importPlanSpec() },
    { label: t('Подложка (изображение)…'), icon: ImagePlus, onSelect: () => void actions.importUnderlay() },
    { label: t('3D-модель…'), icon: Package, onSelect: () => actions.importModelFiles() },
    { label: t('План по фото…'), icon: ScanLine, onSelect: () => actions.planFromPhoto() },
    { type: 'separator' },
    { label: t('Материалы…'), icon: Paintbrush, onSelect: () => dialogStore.getState().open('materialEditor') },
    { label: t('Настройки…'), icon: Settings, onSelect: () => dialogStore.getState().open('settings') },
    { label: t('Проверить обновления…'), icon: RefreshCw, onSelect: () => void checkForUpdatesManually() },
    { label: t('О программе doplan'), icon: Info, onSelect: () => dialogStore.getState().open('about') },
  ]

  const exportMenu = (): MenuEntry[] => [
    { type: 'header', label: t('План (активный этаж)') },
    { label: 'PNG', icon: Image, onSelect: () => void actions.exportPlan('png') },
    { label: 'SVG', onSelect: () => void actions.exportPlan('svg') },
    { label: 'PDF', onSelect: () => void actions.exportPlan('pdf') },
    { label: 'DXF (AutoCAD)', onSelect: () => void actions.exportPlan('dxf') },
    { type: 'separator' },
    { type: 'header', label: '3D' },
    { label: t('Модель GLB'), icon: Box, onSelect: () => void actions.exportGlb() },
    { label: t('Снимок 3D-вида'), icon: Camera, onSelect: () => void actions.snapshot3d() },
    { label: t('Рендер…'), icon: Aperture, onSelect: () => dialogStore.getState().open('render') },
    { type: 'separator' },
    { label: t('Смета материалов…'), icon: ClipboardList, onSelect: () => dialogStore.getState().open('bom') },
    { type: 'separator' },
    { type: 'header', label: t('Проект') },
    { label: t('Файл .doplan (один файл)…'), onSelect: () => void actions.exportDoplan() },
  ]

  const viewOptions: { value: ViewMode; label: ReactNode; title: string; kbd: string }[] = [
    { value: '2d', label: <><Square size={12} /> 2D</>, title: t('План'), kbd: '1' },
    { value: '3d', label: <><Box size={12} /> 3D</>, title: t('3D-вид'), kbd: '2' },
    { value: 'split', label: <><Columns2 size={12} /> {t('2D+3D')}</>, title: t('Разделённый вид'), kbd: '3' },
  ]

  const fileName = filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : null

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-panel px-1.5 [-webkit-app-region:drag]">
      <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
        <Logo />
        <DropdownMenu items={fileMenu} trigger={({ open, toggle }) => <MenuTrigger label={t('Файл')} open={open} toggle={toggle} />} />
        <DropdownMenu items={exportMenu} trigger={({ open, toggle }) => <MenuTrigger label={t('Экспорт')} open={open} toggle={toggle} />} />
        <Sep />
        <IconBtn icon={Save} label={t('Сохранить')} kbd="Ctrl+S" onClick={() => void actions.saveProject(false)} />
        <IconBtn
          icon={Undo2}
          label={undoLabel ? t('Отменить: {action}', { action: t(undoLabel) }) : t('Отменить')}
          kbd="Ctrl+Z"
          disabled={!canUndo}
          onClick={() => actions.undo()}
        />
        <IconBtn
          icon={Redo2}
          label={redoLabel ? t('Повторить: {action}', { action: t(redoLabel) }) : t('Повторить')}
          kbd="Ctrl+Y"
          disabled={!canRedo}
          onClick={() => actions.redo()}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
        <Tip label={fileName ?? t('Проект не сохранён')}>
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className="truncate font-medium">{name}</span>
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-label={t('Есть несохранённые изменения')} />}
          </div>
        </Tip>
      </div>

      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        <GithubButton />
        <Segmented value={mode} options={viewOptions} onChange={(m) => uiStore.getState().setMode(m)} />
        <Sep />
        <TextBtn variant="ghost" onClick={() => actions.planFromPhoto()} title={t('Распознать план по фото или скану')}>
          <ScanLine size={14} />
          <span className="hidden xl:inline">{t('План по фото')}</span>
        </TextBtn>
        <TextBtn variant="ghost" onClick={() => dialogStore.getState().open('bom')} title={t('Смета материалов')}>
          <ClipboardList size={14} />
          <span className="hidden xl:inline">{t('Смета')}</span>
        </TextBtn>
        <TextBtn variant="primary" onClick={() => dialogStore.getState().open('render')}>
          <Aperture size={14} />
          {t('Рендер')}
        </TextBtn>
        <Sep />
        <IconBtn
          icon={theme === 'dark' ? Sun : Moon}
          label={theme === 'dark' ? t('Светлая тема') : t('Тёмная тема')}
          onClick={() => uiStore.getState().setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
        <IconBtn icon={Settings} label={t('Настройки')} onClick={() => dialogStore.getState().open('settings')} />
      </div>
    </header>
  )
}
