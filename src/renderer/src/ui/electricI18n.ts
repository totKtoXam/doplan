/** English strings of the electrical points (tool, «Электрика» tab, inspector, undo labels). */
import { addTranslations } from '@/i18n'

addTranslations('en', {
  // tool / left panel
  Электроточка: 'Electrical point',
  Электрика: 'Electrical',
  'Розетки, выключатели, слаботочка': 'Sockets, switches, low voltage',
  'Кликните у стены, чтобы поставить розетку или выключатель (тип — в разделе «Электрика»)':
    'Click near a wall to place a socket or a switch (the type is in the «Electrical» section)',
  Установка: 'Placement',
  'Постов в рамке': 'Frame posts',
  'Высота от пола': 'Height above floor',
  'По типу': 'By type',
  'На этаже': 'On this floor',
  'Электроточек пока нет': 'No electrical points yet',
  'Щёлкните у стены — точка встанет на её грань. Alt — без привязки.': 'Click near a wall: the point sticks to its face. Alt: no snapping.',
  'Щёлкните на плане, чтобы поставить.': 'Click on the plan to place it.',
  'В 3D — щелчок по стене, потолку или полу; в прогулке — по прицелу. PgUp/PgDn — высота, [ ] — тип, +/− — посты.':
    'In 3D: click a wall, the ceiling or the floor; in walk mode: aim with the crosshair. PgUp/PgDn height, [ ] type, +/− posts.',
  'щёлкните у стены — точка встанет на её грань · Alt — без привязки · Esc — закончить':
    'click near a wall: the point sticks to its face · Alt: no snapping · Esc: finish',
  'щёлкните, чтобы поставить · Esc — закончить': 'click to place · Esc: finish',
  пол: 'floor',
  потолок: 'ceiling',
  'в полу': 'in the floor',
  'на потолке': 'on the ceiling',
  // inspector
  Монтаж: 'Mounting',
  Комментарий: 'Comment',
  'например: под холодильник': 'e.g. for the fridge',
  'Рамка вертикально': 'Vertical frame',
  '← угол': '← corner',
  'угол →': 'corner →',
  'До угла слева (лицом к стене)': 'To the left corner (facing the wall)',
  'До угла справа (лицом к стене)': 'To the right corner (facing the wall)',
  'Расстояния по стене до углов комнаты': 'Distances along the wall to the room corners',
  'Расстояния по стене до её концов': 'Distances along the wall to its ends',
  'Отвязать от стены': 'Detach from the wall',
  'Привязать к ближайшей стене': 'Attach to the nearest wall',
  // undo history
  'Тип электроточки': 'Electrical point type',
  'Монтаж электроточки': 'Electrical point mounting',
  'Высота электроточки': 'Electrical point height',
  'Переместить электроточку': 'Move electrical point',
  'Поворот электроточки': 'Rotate electrical point',
  'Привязка электроточки': 'Electrical point binding',
  'Вертикальная рамка': 'Vertical frame',
  'Привязать к стене': 'Attach to wall',
  // plan
  'от пола': 'above floor',
  // AI tools (change lines, approval cards)
  'Электроточки': 'Electrical points',
  'Поставить электроточку': 'Place an electrical point',
  'Изменить электроточку': 'Change an electrical point',
  'Электроточка «{name}»{where}': 'Electrical point «{name}»{where}',
  'Электроточка {kind} на {wall}': 'Electrical point {kind} on {wall}',
  'Электроточка {kind} в {at}': 'Electrical point {kind} at {at}',
  'Электроточка {id}: {fields}': 'Electrical point {id}: {fields}',
  'тип {kind}': 'type {kind}',
  'высота {h}': 'height {h}',
  'постов {n}': '{n} posts',
  вертикально: 'vertical',
  горизонтально: 'horizontal',
  комментарий: 'comment',
  'на {wall}, offset {t}': 'on {wall}, offset {t}',
  // status bar: one / several selected
  электроточка: 'electrical point',
  электроточек: 'electrical points',
  // catalog notes (core ELECTRIC_TYPES[].note)
  '16 А': '16 A',
  '16 А, без заземления': '16 A, no ground',
  '16 А, с заземлением': '16 A, grounded',
  '16 А, с заземлением и шторками': '16 A, grounded, with shutters',
  '32 А': '32 A',
})
