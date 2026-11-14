import { useState } from 'react'
import { BrickWall, Lightbulb, Palette, Sofa } from 'lucide-react'
import { useT } from '@/i18n'
import { cn, ScrollArea, TabPanel, Tabs } from '@/ui/kit'
import { ConstructionTab } from './left/ConstructionTab'
import { FurnitureTab } from './left/FurnitureTab'
import { MaterialsTab } from './left/MaterialsTab'
import { LightsTab } from './left/LightsTab'

type LeftTab = 'build' | 'furniture' | 'materials' | 'lights'

const TAB_KEY = 'doplan.leftTab'

function readTab(): LeftTab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    if (v === 'build' || v === 'furniture' || v === 'materials' || v === 'lights') return v
  } catch {
    /* ignore */
  }
  return 'build'
}

/** left dock: construction tools, furniture catalogue, materials, lights */
export function LeftPanel({ className }: { className?: string }) {
  const t = useT()
  const [tab, setTabState] = useState<LeftTab>(readTab)
  const setTab = (v: LeftTab) => {
    setTabState(v)
    try {
      localStorage.setItem(TAB_KEY, v)
    } catch {
      /* ignore */
    }
  }
  const idBase = 'leftpanel'
  return (
    <aside className={cn('flex h-full min-h-0 w-full flex-col bg-[var(--panel)] text-[var(--text)]', className)} aria-label={t('Каталог')}>
      <Tabs<LeftTab>
        idBase={idBase}
        value={tab}
        onChange={setTab}
        aria-label={t('Разделы каталога')}
        items={[
          { id: 'build', label: t('Конструкции'), icon: <BrickWall />, title: t('Стены, помещения, двери и окна') },
          { id: 'furniture', label: t('Мебель'), icon: <Sofa /> },
          { id: 'materials', label: t('Материалы'), icon: <Palette /> },
          { id: 'lights', label: t('Свет'), icon: <Lightbulb /> },
        ]}
      />
      <ScrollArea className="flex-1">
        <TabPanel idBase={idBase} id={tab}>
          {tab === 'build' && <ConstructionTab />}
          {tab === 'furniture' && <FurnitureTab />}
          {tab === 'materials' && <MaterialsTab />}
          {tab === 'lights' && <LightsTab />}
        </TabPanel>
      </ScrollArea>
    </aside>
  )
}
