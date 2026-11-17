/** English for the shell of the redesigned layout: activity bar, left panel header, tool bar, status bar. */
import { addTranslations } from '@/i18n'

addTranslations('en', {
  // colour themes (Settings)
  'План по фото': 'Plan from photo',
  Тёмные: 'Dark',
  Светлые: 'Light',
  'Установить тему…': 'Install theme…',
  'Сохранить в файл': 'Save to file',
  'Удалить тему': 'Remove theme',
  'Тема «{name}» установлена': 'Theme “{name}” installed',
  'Установлено тем: {n}': 'Themes installed: {n}',
  'Подходят файлы цветовых тем VS Code (.json из папки themes расширения) и темы doplan. Чтобы изменить только часть цветов, укажите в файле "extends" с именем другой темы.':
    'VS Code colour theme files (.json from the extension’s themes folder) and doplan themes work. To change only some colours, put "extends" with the name of another theme in the file.',
  'Файл не похож на тему: это не JSON': 'This file is not a theme: it is not JSON',
  'Файл не похож на тему: это не JSON-объект': 'This file is not a theme: it is not a JSON object',
  'Это package.json расширения. Выберите файл темы из его папки themes': 'This is an extension’s package.json. Pick the theme file from its themes folder',
  'В теме нет своих цветов: она подключает другой файл (include). Установите тот файл': 'The theme has no colours of its own: it includes another file. Install that file',
  'В файле нет цветов интерфейса (colors)': 'The file has no interface colours (colors)',
  // activity bar
  Разделы: 'Sections',
  Строить: 'Build',
  Строительство: 'Construction',
  'Мебель и предметы': 'Furniture and objects',
  'Материалы пола, стен и потолка': 'Floor, wall and ceiling materials',
  'Светильники и освещение': 'Light fixtures and lighting',
  'Все объекты этажа: видимость, блокировка, слои': 'All objects of the level: visibility, lock, layers',
  'Скрыть панель': 'Hide panel',
  'Щёлкайте по плану, чтобы ставить узлы; во время рисования введите число — длина сегмента. Esc — закончить. Толщина и высота — в строке инструмента над планом.':
    'Click on the plan to place nodes; while drawing, type a number for the segment length. Esc finishes. Thickness and height are in the tool bar above the plan.',
  // tool bar: «Вид» menu
  Вид: 'View',
  'Что показывать на плане, единицы': 'What the plan shows, units',
  'На плане': 'On the plan',
  'Размеры мебели (Ш×Г)': 'Furniture sizes (W×D)',
  Миллиметры: 'Millimetres',
  Сантиметры: 'Centimetres',
  Метры: 'Metres',
  // status bar: snaps
  Привязки: 'Snaps',
  'Углы 15°': 'Angles 15°',
  // floating bar above the selection
  'Действия с выделенным': 'Selection actions',
  'Добавить в чат с ИИ': 'Add to the AI chat',
  // project inspector
  'Привязки и шаг сетки — в строке состояния внизу, что показывать на плане и единицы — в меню «Вид» над планом.':
    'Snaps and the grid step are in the status bar below; what the plan shows and the units are in the «View» menu above the plan.',
})
