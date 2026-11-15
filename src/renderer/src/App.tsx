import { FileDown, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, TriangleExclamationPoint } from 'lucide-react'
import { Component, type ComponentType, type ErrorInfo, type ReactNode, useEffect, useState } from 'react'
import { builtinCatalog, mergeCatalog } from '@core'
import { actions } from '@/actions'
import { t, useT } from '@/i18n'
import { api } from '@/store/api'
import { dialogStore, type DialogKey, useDialogs } from '@/store/dialogs'
import { buildSampleApartment } from '@/store/sample'
import { usePanelSize } from '@/store/layout'
import { uiStore, useUi } from '@/store/ui'
import { ResizablePanel } from '@/ui/kit/Sash'
import {
  AboutDialog,
  BomDialog,
  ImportModelDialog,
  LeftPanel,
  MaterialEditorDialog,
  PhotoPlanDialog,
  RenderPanel,
  SettingsDialog,
} from '@/ui/panels'
import { RightDock } from '@/ai' // ai-chat: «Свойства | ИИ» tabs
import { LevelTabs } from '@/ui/shell/LevelTabs'
import { ProjectFolderDialogs } from '@/ui/panels/ProjectFolderDialogs'
import { AppLogo } from '@/ui/shell/AppLogo'
import { Overlays } from '@/ui/shell/Overlays'
import { IconBtn } from '@/ui/shell/primitives'
import { StatusBar } from '@/ui/shell/StatusBar'
import { ToolOptionsBar } from '@/ui/shell/ToolOptionsBar'
import { ToolRail } from '@/ui/shell/ToolRail'
import { TopBar } from '@/ui/shell/TopBar'
import { useAppEvents } from '@/ui/shell/useAppEvents'
import { Workspace } from '@/ui/shell/Workspace'

// ───────────── error boundary (a crashing panel must not take the whole app down) ─────────────

class Boundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[doplan] ${this.props.name} crashed`, error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full min-h-[80px] flex-col items-center justify-center gap-2 p-3 text-center text-[11px] text-muted">
        <TriangleExclamationPoint size={18} className="text-warning" />
        <div>{t('Ошибка в модуле «{name}»', { name: this.props.name })}</div>
        <div className="max-w-full font-mono break-words text-faint">{this.state.error.message}</div>
        <button type="button" className="text-accent hover:underline" onClick={() => this.setState({ error: null })}>
          {t('Повторить')}
        </button>
      </div>
    )
  }
}

// ───────────── boot ─────────────

async function boot(): Promise<void> {
  // settings first: language and theme must be right before anything is shown
  try {
    const s = await api.settings.get()
    uiStore.setState({ lang: s.lang, theme: s.theme, backendPref: s.backend, appSettings: s })
  } catch (err) {
    console.warn('[doplan] settings unavailable', err)
  }
  // starter document: a furnished sample apartment
  try {
    actions.loadDocument(buildSampleApartment(t('Пример квартиры')), null)
  } catch (err) {
    console.error('[doplan] sample apartment failed, starting empty', err)
  }
  // catalog: builtin colour materials + procedural assets merged with the bundled pack and user library
  try {
    const loaded = await api.catalog.load()
    uiStore.getState().setCatalog(mergeCatalog(builtinCatalog(), loaded))
  } catch (err) {
    console.warn('[doplan] catalog.load failed, using builtin catalog only', err)
  }
  uiStore.setState({ booted: true })
}

const RenderDialog = RenderPanel as unknown as ComponentType<{ open: boolean; onClose(): void }>

const DIALOGS: [DialogKey, ComponentType<{ open: boolean; onClose(): void }>][] = [
  ['bom', BomDialog],
  ['importModel', ImportModelDialog],
  ['materialEditor', MaterialEditorDialog],
  ['settings', SettingsDialog],
  ['photoPlan', PhotoPlanDialog],
  ['render', RenderDialog],
  ['about', AboutDialog],
]

function Dialogs() {
  const flags = useDialogs((s) => s)
  return (
    <>
      {DIALOGS.map(([key, Dlg]) =>
        flags[key] ? (
          <Boundary key={key} name={key}>
            <Dlg open onClose={() => dialogStore.getState().close(key)} />
          </Boundary>
        ) : null,
      )}
    </>
  )
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-3 text-muted">
        <AppLogo size={44} />
        <div className="text-sm font-semibold text-text">doplan</div>
        <div className="h-1 w-32 overflow-hidden rounded bg-panel-3">
          <div className="dp-indeterminate h-full w-1/3 rounded bg-accent" />
        </div>
      </div>
    </div>
  )
}

export function App() {
  const tr = useT()
  const booted = useUi((s) => s.booted)
  const leftOpen = useUi((s) => s.leftPanelOpen)
  const rightOpen = useUi((s) => s.rightPanelOpen)
  const leftSize = usePanelSize('left')
  const rightSize = usePanelSize('right')
  const [recoveryChecked, setRecoveryChecked] = useState(false)
  const { dragOver } = useAppEvents(booted)

  useEffect(() => {
    void boot()
  }, [])

  // crash recovery is offered once the shell is visible (the prompt is a shell modal)
  useEffect(() => {
    if (!booted || recoveryChecked) return
    setRecoveryChecked(true)
    void actions.offerRecovery()
  }, [booted, recoveryChecked])

  if (!booted) return <Splash />

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <ToolRail />
        <ResizablePanel
          side="left"
          id="dp-left-panel"
          label={tr('Ширина каталога')}
          className="border-r border-border"
          open={leftOpen}
          onOpenChange={(v) => uiStore.setState({ leftPanelOpen: v })}
          {...leftSize}
        >
          <Boundary name={tr('Каталог')}>
            <LeftPanel />
          </Boundary>
        </ResizablePanel>
        {/* the viewports fill the rest; a narrow window shrinks the side panels before them */}
        <main data-panel-fill className="flex min-w-[240px] flex-1 basis-0 flex-col">
          <div className="flex shrink-0 items-stretch border-b border-border bg-panel">
            <div className="flex items-center border-r border-border px-0.5">
              <IconBtn
                icon={leftOpen ? PanelLeftClose : PanelLeftOpen}
                size="sm"
                label={leftOpen ? tr('Скрыть каталог') : tr('Показать каталог')}
                onClick={() => uiStore.setState({ leftPanelOpen: !leftOpen })}
              />
            </div>
            <div className="min-w-0 flex-1 [&>div]:border-b-0">
              <ToolOptionsBar />
            </div>
            <div className="flex items-center border-l border-border px-0.5">
              <IconBtn
                icon={rightOpen ? PanelRightClose : PanelRightOpen}
                size="sm"
                label={rightOpen ? tr('Скрыть свойства') : tr('Показать свойства')}
                onClick={() => uiStore.setState({ rightPanelOpen: !rightOpen })}
              />
            </div>
          </div>
          <Workspace />
          <LevelTabs />
        </main>
        <ResizablePanel
          side="right"
          id="dp-right-panel"
          label={tr('Ширина панели свойств')}
          // chat images and wide content never spill past the panel edge, whatever the width
          className="border-l border-border [&_img]:max-w-full"
          open={rightOpen}
          onOpenChange={(v) => uiStore.setState({ rightPanelOpen: v })}
          {...rightSize}
        >
          <Boundary name={tr('Свойства')}>
            <RightDock />
          </Boundary>
        </ResizablePanel>
      </div>
      <StatusBar />
      <Dialogs />
      <ProjectFolderDialogs />
      <Overlays />
      {dragOver && (
        <div className="dp-drop-overlay pointer-events-none fixed inset-2 z-[940] flex items-center justify-center rounded-xl">
          <div className="flex flex-col items-center gap-2 rounded-xl bg-panel px-6 py-4 text-center shadow-pop">
            <FileDown size={26} className="text-accent" />
            <div className="text-sm font-medium">{tr('Отпустите файл')}</div>
            <div className="text-[11px] text-muted">{tr('Проект .doplan, PlanSpec .json, изображение или 3D-модель')}</div>
          </div>
        </div>
      )}
    </div>
  )
}
