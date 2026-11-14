/**
 * English translations of the 2D editor's own strings (hints, history labels, context menu).
 * The editor calls `t('Русский текст')`; keys that the shell dictionary already knows are not repeated.
 */
import { addTranslations } from '@/i18n'

const EN: Record<string, string> = {
  // ── context menu ──
  'Выделить всё': 'Select all',
  'Показать скрытые предметы': 'Show hidden items',
  'Отразить (петли с другой стороны)': 'Flip (hinges on the other side)',
  'Открывать в другую сторону': 'Swing to the other side',
  'Разделить стену здесь': 'Split wall here',
  'Выделить стены комнаты': 'Select room walls',
  'Переименовать…': 'Rename…',
  'Название комнаты': 'Room name',
  'Изменить текст…': 'Edit text…',
  Выключить: 'Turn off',
  Включить: 'Turn on',
  Текст: 'Text',

  // ── history labels ──
  'Отражение проёма': 'Flip opening',
  'Разделение стены': 'Split wall',
  'Переименование комнаты': 'Rename room',
  Отражение: 'Mirror',
  Дублирование: 'Duplicate',
  Удаление: 'Delete',
  'Добавление предмета': 'Add item',
  'Калибровка подложки': 'Calibrate underlay',
  'Отделка пола': 'Floor finish',
  'Отделка стен комнаты': 'Room wall finish',
  'Отделка стены': 'Wall finish',
  'Перемещение узла': 'Move node',
  Перемещение: 'Move',
  'Перемещение стены': 'Move wall',
  'Перемещение проёма': 'Move opening',
  'Размер проёма': 'Opening size',
  'Изменение размера': 'Resize',
  Сдвиг: 'Nudge',

  // ── tool hints ──
  'Щелчок — выбрать · Shift — добавить · перетаскивание — переместить или выделить рамкой':
    'Click — select · Shift — add · drag — move or box-select',
  'Перетаскивайте план · колесо — масштаб': 'Drag the plan · wheel — zoom',
  'Стена: щёлкните первую точку': 'Wall: click the first point',
  'Следующая точка · цифры и Enter — точная длина · Shift — шаг 45° · Alt — без привязки · Esc или двойной щелчок — закончить':
    'Next point · digits + Enter — exact length · Shift — 45° steps · Alt — no snapping · Esc or double-click — finish',
  'Комната: протяните прямоугольник или щёлкните два угла': 'Room: drag a rectangle or click two corners',
  'Укажите противоположный угол комнаты · введите размер, например 4200x3600, и Enter · Esc — отмена':
    'Pick the opposite corner · or type a size like 4200x3600 and press Enter · Esc — cancel',
  внутри: 'inside',
  'Дверь: наведите на стену и щёлкните · сторона курсора задаёт направление открывания · Alt — без привязки':
    'Door: hover a wall and click · the cursor side sets the swing · Alt — no snapping',
  'Окно: наведите на стену и щёлкните · Alt — без привязки': 'Window: hover a wall and click · Alt — no snapping',
  'Щёлкните, чтобы поставить · R — повернуть на 90° · Shift — не поворачивать к стене · Alt — без привязки · Esc — закончить':
    'Click to place · R — rotate 90° · Shift — keep rotation at walls · Alt — no snapping · Esc — finish',
  'Светильник: щёлкните, чтобы поставить · Esc — закончить': 'Light: click to place · Esc — finish',
  'Размер: щёлкните первую точку': 'Dimension: click the first point',
  'Щёлкните вторую точку': 'Click the second point',
  'Отведите размерную линию и щёлкните · Esc — отмена': 'Move the dimension line out and click · Esc — cancel',
  'Надпись: щёлкните место на плане и введите текст': 'Label: click on the plan and type the text',
  'Рулетка: щёлкните две точки · Shift — шаг 45° · Alt — без привязки': 'Measure: click two points · Shift — 45° steps · Alt — no snapping',
  Расстояние: 'Distance',
  'Калибровка: сначала импортируйте подложку (план-картинку)': 'Calibration: import an underlay (plan image) first',
  'Калибровка: щёлкните первую точку известного отрезка на подложке': 'Calibration: click the first point of a known segment on the underlay',
  'Щёлкните вторую точку отрезка и введите его реальную длину': 'Click the second point and type the real length',
  'Реальная длина отрезка': 'Real segment length',
  'Калибровка: под отрезком нет подложки': 'Calibration: there is no underlay under the segment',
  'Разделить стену: щёлкните точку на стене · Alt — без привязки': 'Split wall: click a point on a wall · Alt — no snapping',
  'Ластик: щёлкните объект или проведите по объектам с нажатой кнопкой': 'Eraser: click an object or drag across objects',
  'Заливка: щёлкните пол комнаты или сторону стены · Shift — все стены комнаты':
    'Paint: click a room floor or a wall side · Shift — all walls of the room',
  'Выберите материал в каталоге, затем щёлкните пол или стену': 'Pick a material in the catalogue, then click a floor or a wall',
  'Пипетка: щёлкните пол или сторону стены, чтобы взять отделку': 'Eyedropper: click a floor or a wall side to pick its finish',
}

let registered = false

export function registerEditorTranslations(): void {
  if (registered) return
  registered = true
  addTranslations('en', EN)
}
