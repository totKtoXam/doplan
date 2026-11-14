/** English strings of the accuracy features (provenance legend, «Обмер», area report, furniture sizes). */
import { addTranslations } from '@/i18n'

addTranslations('en', {
  // legend / plan labels
  'Откуда размеры': 'Where dimensions come from',
  'замерено рулеткой (±2 мм)': 'tape-measured (±2 mm)',
  'с плана (±10 мм)': 'from the plan (±10 mm)',
  'выведено из площади (±20 мм)': 'derived from an area (±20 mm)',
  'оценка по фото (±50 мм)': 'estimated from the photo (±50 mm)',
  'нарисовано, точность неизвестна': 'drawn, accuracy unknown',
  'стену сдвинули после записи': 'wall moved after it was recorded',
  'замерено полностью': 'fully measured',
  'размер стены не замерен: проверьте рулеткой (±1 см)': 'wall dimension not measured: check with a tape (±1 cm)',
  'с плана': 'from plan',
  вычислен: 'derived',
  '≈ по фото': '≈ from photo',
  замерен: 'measured',
  нарисован: 'drawn',
  // toolbar / settings
  'W×D': 'W×D',
  'Размеры мебели': 'Furniture sizes',
  'Легенда: откуда размеры': 'Legend: where dimensions come from',
  'Чек-лист обмера': 'Measuring checklist',
  'Показ размеров мебели': 'Show furniture sizes',
  // survey tool
  Обмер: 'Survey',
  'Щёлкните размер комнаты и введите длину, замеренную рулеткой': 'Click a room dimension and type the length measured with a tape',
  'Обмер: щёлкните размер (внутреннюю сторону стены) и введите длину по рулетке · или щёлкните две точки на противоположных стенах':
    'Survey: click a dimension (inner wall face) and type the tape length · or click two points on opposite walls',
  'Обмер: второй точкой укажите противоположную стену': 'Survey: pick the opposite wall with the second point',
  'Не нашёл подходящий размер между этими точками: щёлкните точнее по двум противоположным стенам':
    'No matching dimension between these points: click closer to two opposite walls',
  Сейчас: 'Now',
  'стену сдвинули': 'wall moved',
  'Длина по рулетке (в свету), мм': 'Tape length (clear), mm',
  'Какой конец сдвинуть': 'Which end moves',
  левый: 'left',
  правый: 'right',
  верхний: 'top',
  нижний: 'bottom',
  'Точность ±': 'Accuracy ±',
  Сдвиг: 'Shift',
  узлов: 'nodes',
  'Изменятся замеренные размеры': 'Measured dimensions will change',
  'Изменились ранее замеренные размеры': 'Previously measured dimensions changed',
  'Рулетка показала столько же, сколько на плане': 'The tape shows the same as the plan',
  Совпадает: 'Matches',
  'Tab — сменить конец · Esc — отмена': 'Tab — switch end · Esc — cancel',
  Замерено: 'Measured',
  'Не удалось применить обмер': 'Could not apply the measurement',
  'Не замерено': 'Not measured',
  'Все размеры замерены': 'All dimensions are measured',
  // area report
  'Площадь на плане': 'Area on the plan',
  'Расчёт по стенам': 'Computed from walls',
  'Подписано на плане': 'Printed on the plan',
  Расхождение: 'Difference',
  'Погрешность размеров': 'Dimension uncertainty',
  'Размеры этой комнаты взяты с плана, но подписанная площадь с ними не сходится сильнее, чем позволяет их точность. Ошибка в самом плане (или площадь посчитана до отделки) — проверьте стены рулеткой.':
    "This room's dimensions come from the plan, but the printed area disagrees with them by more than their accuracy allows. The plan itself is inconsistent (or the area was taken before finishing) — check the walls with a tape.",
  'Расхождение больше погрешности размеров: какие-то размеры неточны. Замерьте стены рулеткой («Обмер»).':
    'The difference exceeds the dimension uncertainty: some dimensions are off. Measure the walls with a tape (Survey).',
  'Расхождение в пределах точности размеров. Чтобы его убрать, замерьте стены рулеткой.':
    'The difference is within the dimension accuracy. Measure the walls with a tape to remove it.',
  'Общая площадь на плане': 'Total area on the plan',
  'Жилая площадь на плане': 'Living area on the plan',
  'сумма подписанных комнат': 'sum of printed rooms',
  'подписи плана противоречат друг другу': 'the plan labels contradict each other',
  'Замерено размеров': 'Dimensions measured',
})
