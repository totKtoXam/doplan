import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ChatSection } from '@/ai'
import { useT } from '@/i18n'
import { useLayout } from '@/store/layout'
import { uiStore, useUi } from '@/store/ui'
import { cn, ScrollArea } from '@/ui/kit'
import { sectionDef } from '@/ui/shell/ActivityBar'
import { IconBtn } from '@/ui/shell/primitives'
import { ConstructionTab } from './left/ConstructionTab'
import { FurnitureTab } from './left/FurnitureTab'
import { MaterialsTab } from './left/MaterialsTab'
import { LightsTab } from './left/LightsTab'
import { ElectricTab } from './left/ElectricTab'
import { StyleTab } from './left/StyleTab'
import { LayersPanel } from './layers/LayersPanel'
import '@/ui/electricI18n'
import '@/ui/shellI18n'

/**
 * Left dock: the section picked in the activity bar — construction, furniture catalogue, materials,
 * interior styles, lights, electrical points, the AI chat or the objects (layers) tree. One section
 * at a time; the chat, once opened, stays mounted (invisible) under the other sections and while the
 * panel is hidden, so a typed message and a running answer survive.
 */
export function LeftPanel({ className }: { className?: string }) {
  const t = useT()
  const section = useLayout((s) => s.section)
  const def = sectionDef(section)
  // the panel stays mounted while closed (keepMounted) for the chat's sake only: other sections go
  const open = useUi((s) => s.leftPanelOpen)
  const isChat = section === 'ai'
  const [chatUsed, setChatUsed] = useState(isChat && open)
  useEffect(() => {
    if (isChat && open) setChatUsed(true)
  }, [isChat, open])
  return (
    <aside className={cn('flex h-full min-h-0 w-full flex-col bg-[var(--panel)] text-[var(--text)]', className)} aria-label={t(def.title)}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] pr-0.5 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold" title={t(def.title)}>
          {t(def.heading)}
        </h2>
        <IconBtn icon={X} size="sm" label={t('Скрыть панель')} onClick={() => uiStore.setState({ leftPanelOpen: false })} />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {(chatUsed || (isChat && open)) && <ChatSection hidden={!isChat} />}
        {isChat || !open ? null : section === 'objects' ? (
          <LayersPanel className="min-h-0 flex-1" />
        ) : (
          <ScrollArea className="flex-1">
            {section === 'build' && <ConstructionTab />}
            {section === 'furniture' && <FurnitureTab />}
            {section === 'materials' && <MaterialsTab />}
            {section === 'style' && <StyleTab />}
            {section === 'lights' && <LightsTab />}
            {section === 'electric' && <ElectricTab />}
          </ScrollArea>
        )}
      </div>
    </aside>
  )
}
