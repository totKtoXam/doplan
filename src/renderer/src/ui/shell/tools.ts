import type { LucideIcon } from 'lucide-react'
import {
  AppWindow,
  BrickWall,
  ClipboardCheck,
  DoorOpen,
  Hand,
  Highlighter,
  LampCeiling,
  MousePointer2,
  Paintbrush,
  Pipette,
  Plug,
  Ruler,
  RulerDimensionLine,
  Scissors,
  Square,
  Type,
} from 'lucide-react'
import { layoutStore, type LeftSection } from '@/store/layout'
import { uiStore } from '@/store/ui'
import type { ToolId } from '@/contracts'
import { MARK_HINT } from '@/store/marks'
import '@/ui/electricI18n'

export interface ToolDef {
  id: ToolId
  icon: LucideIcon
  label: string
  /** single-letter hotkey (uppercase) */
  key?: string
  /** status-bar hint shown when the tool is activated */
  hint: string
  /**
   * Where the tool is started with the mouse: `bar` — a button in the tool bar above the plan; a left
   * section — its cards there (the section is shown when the tool is activated); `chat` — the
   * «Пометить» button in the chat input row.
   */
  place: 'bar' | 'chat' | LeftSection
}

/** Tool definitions shared by the tool bar, the left sections and the keyboard shortcuts. Labels/hints are i18n keys. */
export const TOOLS: (ToolDef | 'sep')[] = [
  { id: 'select', icon: MousePointer2, label: 'Выбор', key: 'V', hint: 'Клик — выбрать, Shift — добавить к выбору, рамка — выбрать несколько', place: 'bar' },
  { id: 'pan', icon: Hand, label: 'Панорама', key: 'H', hint: 'Перетаскивайте план. Колесо — масштаб', place: 'bar' },
  'sep',
  { id: 'dimension', icon: RulerDimensionLine, label: 'Размер', hint: 'Укажите две точки размерной линии, затем её отступ', place: 'bar' },
  { id: 'measure', icon: Ruler, label: 'Рулетка', key: 'M', hint: 'Укажите две точки, чтобы измерить расстояние', place: 'bar' },
  { id: 'survey', icon: ClipboardCheck, label: 'Обмер', hint: 'Щёлкните размер комнаты и введите длину, замеренную рулеткой', place: 'bar' },
  { id: 'label', icon: Type, label: 'Надпись', key: 'T', hint: 'Кликните, чтобы добавить надпись', place: 'bar' },
  'sep',
  { id: 'paint', icon: Paintbrush, label: 'Покраска', key: 'B', hint: 'Кликните по полу, стене или предмету, чтобы применить материал', place: 'bar' },
  { id: 'eyedropper', icon: Pipette, label: 'Пипетка', key: 'I', hint: 'Кликните по поверхности, чтобы взять её материал', place: 'bar' },
  { id: 'split', icon: Scissors, label: 'Разделить стену', key: 'X', hint: 'Кликните по стене, чтобы разделить её в этой точке', place: 'bar' },
  // started from the cards of the left sections; the hotkeys switch the panel to the section
  { id: 'wall', icon: BrickWall, label: 'Стена', key: 'W', hint: 'Клик — начать стену, клик — следующая точка, двойной клик или Esc — закончить. Введите число для точной длины', place: 'build' },
  { id: 'room', icon: Square, label: 'Комната', key: 'R', hint: 'Растяните прямоугольник комнаты. Введите размеры числом', place: 'build' },
  { id: 'door', icon: DoorOpen, label: 'Дверь', key: 'D', hint: 'Кликните по стене, чтобы поставить дверь', place: 'build' },
  { id: 'window', icon: AppWindow, label: 'Окно', key: 'N', hint: 'Кликните по стене, чтобы поставить окно', place: 'build' },
  { id: 'light', icon: LampCeiling, label: 'Светильник', key: 'L', hint: 'Кликните, чтобы поставить светильник', place: 'lights' },
  { id: 'electric', icon: Plug, label: 'Электроточка', key: 'E', hint: 'Кликните у стены, чтобы поставить розетку или выключатель (тип — в разделе «Электрика»)', place: 'electric' },
  // a chat tool: the «Пометить» button in the chat input row (ai/MarkButton), P still starts it
  { id: 'pencil', icon: Highlighter, label: 'Пометить', key: 'P', hint: MARK_HINT, place: 'chat' },
]

/** tools that only work on the 2D plan (disabled in the tool bar when only 3D is shown) */
export const PLAN_ONLY_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['wall', 'room', 'dimension', 'split', 'measure', 'label', 'survey'])

export function toolDef(id: ToolId): ToolDef | undefined {
  return TOOLS.find((x): x is ToolDef => x !== 'sep' && x.id === id)
}

/** Activates a tool and shows its hint; a tool started from a left section switches the panel to it. */
export function activateTool(id: ToolId, t: (k: string) => string): void {
  const def = toolDef(id)
  uiStore.getState().setTool(id)
  uiStore.getState().set({ hint: def ? t(def.hint) : '' })
  if (def && def.place !== 'bar' && def.place !== 'chat') layoutStore.getState().setSection(def.place)
}
