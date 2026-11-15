import { useState } from 'react'
import { BrickWall, Lightbulb, Palette, Plug, Sofa, SwatchBook } from 'lucide-react'
import { useT } from '@/i18n'
import { cn, ScrollArea, TabPanel, Tabs } from '@/ui/kit'
import { ConstructionTab } from './left/ConstructionTab'
import { FurnitureTab } from './left/FurnitureTab'
import { MaterialsTab } from './left/MaterialsTab'
import { LightsTab } from './left/LightsTab'
import { ElectricTab } from './left/ElectricTab'
import { StyleTab } from './left/StyleTab'
import '@/ui/electricI18n'

type LeftTab = 'build' | 'furniture' | 'materials' | 'style' | 'lights' | 'electric'

const TAB_KEY = 'doplan.leftTab'

function readTab(): LeftTab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    if (v === 'build' || v === 'furniture' || v === 'materials' || v === 'style' || v === 'lights' || v === 'electric') return v
  } catch {
    /* ignore */
  }
  return 'build'
}

/** left dock: construction tools, furniture catalogue, materials, interior styles, lights, electrical points */
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
          { id: 'style', label: t('Стиль'), icon: <SwatchBook />, title: t('Стили интерьера') },
          { id: 'lights', label: t('Свет'), icon: <Lightbulb /> },
          { id: 'electric', label: t('Электрика'), icon: <Plug />, title: t('Розетки, выключатели, слаботочка') },
        ]}
      />
      <ScrollArea className="flex-1">
        <TabPanel idBase={idBase} id={tab}>
          {tab === 'build' && <ConstructionTab />}
          {tab === 'furniture' && <FurnitureTab />}
          {tab === 'materials' && <MaterialsTab />}
          {tab === 'style' && <StyleTab />}
          {tab === 'lights' && <LightsTab />}
          {tab === 'electric' && <ElectricTab />}
        </TabPanel>
      </ScrollArea>
    </aside>
  )
}
