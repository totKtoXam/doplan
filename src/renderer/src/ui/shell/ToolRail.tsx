import type { LucideIcon } from 'lucide-react'
import {
  AppWindow,
  BrickWall,
  CopyPlus,
  DoorOpen,
  Hand,
  LampCeiling,
  MousePointer2,
  Paintbrush,
  Pipette,
  RotateCw,
  Ruler,
  RulerDimensionLine,
  Scissors,
  Square,
  Trash,
  Type,
} from 'lucide-react'
import { actions } from '@/actions'
import { useT } from '@/i18n'
import { uiStore, useUi } from '@/store/ui'
import type { ToolId } from '@/contracts'
import { IconBtn } from './primitives'

export interface ToolDef {
  id: ToolId
  icon: LucideIcon
  label: string
  /** single-letter hotkey (uppercase) */
  key?: string
  /** status-bar hint shown when the tool is activated */
  hint: string
}

/** Tool definitions shared by the rail and the keyboard shortcuts. Labels/hints are i18n keys. */
export const TOOLS: (ToolDef | 'sep')[] = [
  { id: 'select', icon: MousePointer2, label: 'Выбор', key: 'V', hint: 'Клик — выбрать, Shift — добавить к выбору, рамка — выбрать несколько' },
  { id: 'pan', icon: Hand, label: 'Панорама', key: 'H', hint: 'Перетаскивайте план. Колесо — масштаб' },
  'sep',
  { id: 'wall', icon: BrickWall, label: 'Стена', key: 'W', hint: 'Клик — начать стену, клик — следующая точка, двойной клик или Esc — закончить. Введите число для точной длины' },
  { id: 'room', icon: Square, label: 'Комната', key: 'R', hint: 'Растяните прямоугольник комнаты. Введите размеры числом' },
  { id: 'door', icon: DoorOpen, label: 'Дверь', key: 'D', hint: 'Кликните по стене, чтобы поставить дверь' },
  { id: 'window', icon: AppWindow, label: 'Окно', key: 'N', hint: 'Кликните по стене, чтобы поставить окно' },
  { id: 'light', icon: LampCeiling, label: 'Светильник', key: 'L', hint: 'Кликните, чтобы поставить светильник' },
  'sep',
  { id: 'dimension', icon: RulerDimensionLine, label: 'Размер', hint: 'Укажите две точки размерной линии, затем её отступ' },
  { id: 'measure', icon: Ruler, label: 'Рулетка', key: 'M', hint: 'Укажите две точки, чтобы измерить расстояние' },
  { id: 'label', icon: Type, label: 'Надпись', key: 'T', hint: 'Кликните, чтобы добавить надпись' },
  'sep',
  { id: 'paint', icon: Paintbrush, label: 'Покраска', key: 'B', hint: 'Кликните по полу, стене или предмету, чтобы применить материал' },
  { id: 'eyedropper', icon: Pipette, label: 'Пипетка', key: 'I', hint: 'Кликните по поверхности, чтобы взять её материал' },
  { id: 'split', icon: Scissors, label: 'Разделить стену', key: 'X', hint: 'Кликните по стене, чтобы разделить её в этой точке' },
]

export function toolDef(id: ToolId): ToolDef | undefined {
  return TOOLS.find((x): x is ToolDef => x !== 'sep' && x.id === id)
}

/** Activates a tool and shows its hint. */
export function activateTool(id: ToolId, t: (k: string) => string): void {
  const def = toolDef(id)
  uiStore.getState().setTool(id)
  uiStore.getState().set({ hint: def ? t(def.hint) : '' })
}

export function ToolRail() {
  const t = useT()
  const tool = useUi((s) => s.tool)
  const hasSel = useUi((s) => s.selection.length > 0)
  const mode = useUi((s) => s.mode)

  return (
    <nav className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-border bg-panel py-1.5" aria-label={t('Инструменты')}>
      {TOOLS.map((d, i) =>
        d === 'sep' ? (
          <div key={`sep${i}`} className="my-1 h-px w-6 bg-border" />
        ) : (
          <IconBtn
            key={d.id}
            icon={d.icon}
            label={t(d.label)}
            kbd={d.key}
            tipSide="right"
            active={tool === d.id}
            disabled={mode === '3d' && (d.id === 'wall' || d.id === 'room' || d.id === 'dimension' || d.id === 'split' || d.id === 'measure' || d.id === 'label')}
            onClick={() => activateTool(d.id, t)}
          />
        ),
      )}
      <div className="flex-1" />
      <IconBtn icon={RotateCw} label={t('Повернуть на 90°')} kbd="Shift+R" tipSide="right" disabled={!hasSel} onClick={() => actions.groupRotate(90)} />
      <IconBtn icon={CopyPlus} label={t('Дублировать')} kbd="Ctrl+D" tipSide="right" disabled={!hasSel} onClick={() => actions.duplicateSelection()} />
      <IconBtn
        icon={Trash}
        label={t('Удалить')}
        kbd="Del"
        tipSide="right"
        disabled={!hasSel}
        className="hover:!text-danger"
        onClick={() => actions.deleteSelection()}
      />
    </nav>
  )
}
