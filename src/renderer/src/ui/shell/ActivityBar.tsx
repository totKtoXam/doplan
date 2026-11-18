/**
 * The activity bar at the left edge: labelled section buttons (Строить, Мебель, …, Объекты). A click
 * shows the section in the left panel; a click on the section already shown hides or shows the panel.
 */
import type { LucideIcon } from 'lucide-react'
import { BrickWall, Lightbulb, ListTree, Palette, Plug, Sofa, SwatchBook } from 'lucide-react'
import { useT } from '@/i18n'
import { layoutStore, useLayout, type LeftSection } from '@/store/layout'
import { uiStore, useUi } from '@/store/ui'
import { cn } from '@/ui/kit'
import { Tip } from './primitives'

export interface SectionDef {
  id: LeftSection
  icon: LucideIcon
  /** short label under the icon (i18n key) */
  label: string
  /** header of the left panel (i18n key) */
  heading: string
  /** tooltip (i18n key) */
  title: string
}

export const SECTIONS: SectionDef[] = [
  { id: 'build', icon: BrickWall, label: 'Строить', heading: 'Строительство', title: 'Стены, помещения, двери и окна' },
  { id: 'furniture', icon: Sofa, label: 'Мебель', heading: 'Мебель', title: 'Мебель и предметы' },
  { id: 'materials', icon: Palette, label: 'Материалы', heading: 'Материалы', title: 'Материалы пола, стен и потолка' },
  { id: 'style', icon: SwatchBook, label: 'Стиль', heading: 'Стили интерьера', title: 'Стили интерьера' },
  { id: 'lights', icon: Lightbulb, label: 'Свет', heading: 'Свет', title: 'Светильники и освещение' },
  { id: 'electric', icon: Plug, label: 'Электрика', heading: 'Электрика', title: 'Розетки, выключатели, слаботочка' },
]

/** the layers tree, pinned to the bottom of the bar */
export const OBJECTS_SECTION: SectionDef = { id: 'objects', icon: ListTree, label: 'Объекты', heading: 'Объекты', title: 'Все объекты этажа: видимость, блокировка, слои' }

export function sectionDef(id: LeftSection): SectionDef {
  return SECTIONS.find((s) => s.id === id) ?? OBJECTS_SECTION
}

function pick(id: LeftSection): void {
  const open = uiStore.getState().leftPanelOpen
  if (open && layoutStore.getState().section === id) uiStore.setState({ leftPanelOpen: false })
  else layoutStore.getState().setSection(id)
}

function SectionBtn({ def, active }: { def: SectionDef; active: boolean }) {
  const t = useT()
  const Icon = def.icon
  return (
    <Tip label={t(def.title)} side="right">
      <button
        type="button"
        aria-pressed={active}
        aria-label={t(def.label)}
        onClick={() => pick(def.id)}
        className={cn(
          'relative flex w-full flex-col items-center gap-0.5 rounded-md px-0.5 py-1.5 text-[10px] leading-tight outline-none',
          'focus-visible:ring-1 focus-visible:ring-accent',
          active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-text',
        )}
      >
        {active && <span className="absolute top-1.5 bottom-1.5 -left-1 w-0.5 rounded bg-accent" />}
        <Icon size={18} strokeWidth={1.75} />
        <span className="w-full truncate text-center">{t(def.label)}</span>
      </button>
    </Tip>
  )
}

export function ActivityBar() {
  const t = useT()
  const section = useLayout((s) => s.section)
  const open = useUi((s) => s.leftPanelOpen)
  return (
    <nav className="flex w-[72px] shrink-0 flex-col gap-0.5 border-r border-border bg-panel px-1 py-1.5" aria-label={t('Разделы')}>
      {SECTIONS.map((d) => (
        <SectionBtn key={d.id} def={d} active={open && section === d.id} />
      ))}
      <div className="flex-1" />
      <div className="mx-2 mb-0.5 h-px bg-border" />
      <SectionBtn def={OBJECTS_SECTION} active={open && section === 'objects'} />
    </nav>
  )
}
