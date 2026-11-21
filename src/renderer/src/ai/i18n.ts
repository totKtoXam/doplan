/**
 * English strings of the AI chat and the pencil marks, plus `tAi` for messages that come from the
 * main process (provider reasons, statuses, errors, sign-in output): those are Russian text, some
 * with names or codes inside, translated here by exact key or by pattern.
 */
import { addTranslations, t } from '@/i18n'

addTranslations('en', {
  // dock, entry points
  ИИ: 'AI',
  'Добавить в чат': 'Add to chat',
  'Добавить в чат (Ctrl+L)': 'Add to chat (Ctrl+L)',
  'Открыть ИИ-чат': 'Open AI chat',

  // header, history
  'Новый чат': 'New chat',
  'Чаты этого проекта': 'Chats of this project',
  Чаты: 'Chats',
  'Пока нет сохранённых чатов': 'No saved chats yet',
  'Ранние чаты (общие)': 'Earlier chats (shared)',
  'Чаты несохранённых проектов из версий до 0.6. Они общие для всех проектов и удаляются только вручную.':
    'Chats of unsaved projects from versions before 0.6. They are shared by all projects and are deleted only by hand.',
  'Без названия': 'Untitled',
  'Удалить чат': 'Delete chat',

  // messages, tools
  выполняется: 'running',
  'ждёт подтверждения': 'awaiting approval',
  ошибка: 'error',
  отклонено: 'rejected',
  'в черновике': 'in draft',
  Отклонить: 'Reject',
  Размышления: 'Thinking',
  'Выполнено {n} действие': 'Done {n} action',
  'Выполнено {n} действия': 'Done {n} actions',
  'Выполнено {n} действий': 'Done {n} actions',
  'ошибок: {n}': 'errors: {n}',
  '… ещё {n}': '… {n} more',
  Войти: 'Sign in',
  Перевойти: 'Sign in again',
  'Думаю…': 'Thinking…',
  Остановлено: 'Stopped',
  'Пустой ответ': 'Empty answer',
  // the agent's questions (ask_user)
  'Агент спрашивает': 'The agent asks',
  Пропустить: 'Skip',
  'Не отвечать': 'Do not answer',
  '(можно несколько)': '(you can pick several)',
  'Другое — своими словами': 'Other — in your own words',
  Ответить: 'Answer',
  'Ответить (Enter)': 'Answer (Enter)',
  'или ответьте в поле ниже': 'or answer in the box below',
  'Вопросы агента': 'Agent questions',
  'ждёт ответа': 'awaiting answer',
  отвечено: 'answered',
  'без ответа': 'not answered',
  'Ответ своими словами…': 'Your answer in your own words…',
  'К ответу приложено одно изображение, остальные остались в поле ввода': 'One image went with the answer; the others stay in the input box',
  'Запуск…': 'Starting…',
  'Провайдер недоступен': 'Provider unavailable',
  'Не удалось открыть чаты проекта: показан пустой чат': 'Could not open the project chats: an empty chat is shown',
  'Приложите фото плана (скрепка или Ctrl+V) или добавьте подложку': 'Attach a plan photo (paper clip or Ctrl+V) or add an underlay',
  '(изображение)': '(image)',
  // context chip kinds
  Узел: 'Node',
  Предмет: 'Item',
  Свет: 'Light',
  Подпись: 'Label',
  'Не удалось открыть изображение': 'Could not open the image',

  // sign-in
  ': нужен вход в аккаунт': ': sign-in required',
  'Вход в {name}…': 'Signing in to {name}…',
  '{name}: вход выполнен': '{name}: signed in',
  '{name}: вход не удался': '{name}: sign-in failed',
  'Браузер откроет страницу входа. Подтвердите доступ; если страница покажет код — вставьте его сюда.':
    'The browser opens the sign-in page. Grant access; if the page shows a code, paste it here.',
  'Открыть страницу входа': 'Open the sign-in page',
  'Код со страницы входа': 'Code from the sign-in page',
  Отправить: 'Send',
  '› код отправлен': '› code sent',

  // mode, model, provider
  'Агент сразу меняет план, отмена — Ctrl+Z': 'The agent edits the plan right away, undo with Ctrl+Z',
  'Подтверждать каждое изменение плана': 'Approve every change to the plan',
  'Сначала черновик изменений, применяете вы': 'A draft of the changes first, you apply it',
  Режим: 'Mode',
  недоступен: 'unavailable',
  'нужен вход': 'sign-in required',
  'Проверить снова': 'Check again',
  'Модель и провайдер': 'Model and provider',
  Модель: 'Model',
  'Уровень усилий': 'Effort',
  Провайдер: 'Provider',
  Ультракод: 'Ultracode',
  'Мультиагентный режим для больших задач': 'Multi-agent mode for big tasks',
  Обычный: 'Default',
  Низкий: 'Low',
  Средний: 'Medium',
  Высокий: 'High',
  'Очень высокий': 'Very high',
  Максимальный: 'Max',
  'Как настроено у провайдера': 'As set up at the provider',
  'Быстрые ответы на простые задачи': 'Quick answers for simple tasks',
  'Баланс скорости и качества': 'Balance of speed and quality',
  'Глубже продумывает изменения': 'Thinks changes through more deeply',
  'Для сложных перепланировок': 'For complex replanning',
  'Максимум размышлений, дольше и дороже': 'Most thinking, slower and pricier',

  // context
  'Использование контекста': 'Context usage',
  Контекст: 'Context',
  'Последний запрос': 'Last request',
  '{n} токенов': '{n} tokens',
  'Этот чат': 'This chat',
  Входящие: 'Input',
  Ответы: 'Output',
  Стоимость: 'Cost',
  'Сообщений: {n}. Новый чат начинает контекст заново.': 'Messages: {n}. A new chat starts the context afresh.',

  // draft
  'Черновик: {n} изменение': 'Draft: {n} change',
  'Черновик: {n} изменения': 'Draft: {n} changes',
  'Черновик: {n} изменений': 'Draft: {n} changes',
  'Применено (план менялся во время работы агента — проверьте результат).': 'Applied (the plan changed while the agent worked: check the result).',
  'Изменения применены. Отменить — Ctrl+Z.': 'Changes applied. Undo with Ctrl+Z.',
  'Не удалось применить: документ сильно изменился.': 'Could not apply: the document changed too much.',

  // composer
  'Приложить изображение': 'Attach an image',
  'Приложить подложку плана': 'Attach the plan underlay',
  'Быстрые команды': 'Quick commands',
  'План по фото': 'Plan from photo',
  'Расставь мебель': 'Arrange furniture',
  'Проверь площади': 'Check areas',
  // slash commands (the Russian ones keep working in English too)
  '/план по фото': '/plan from photo',
  '/расставь мебель': '/arrange furniture',
  '/проверь площади': '/check areas',
  'Нарисовать пометки на картинке': 'Draw marks on the image',
  Убрать: 'Remove',
  'Что изменить в плане?': 'What should change in the plan?',
  '«/» — команды, Ctrl+L — выделенное': '«/» commands, Ctrl+L selection',
  Стоп: 'Stop',
  Остановить: 'Stop',
  'Отправить (Enter)': 'Send (Enter)',
  Цитировать: 'Quote',
  'Изменить сообщение': 'Edit message',
  'Изменить и отправить заново': 'Edit and send again',
  'Ответы после этого сообщения будут заменены': 'Replies after this message will be replaced',
  'Чем помочь с планом?': 'How can I help with the plan?',
  '«добавь стену от n_… до n_…», «поставь холодильник на кухне». Правки видны сразу и отменяются Ctrl+Z.':
    '“add a wall from n_… to n_…”, “put a fridge in the kitchen”. Edits show right away and undo with Ctrl+Z.',

  // marks: mini field, picture editor, pencil
  'Что здесь сделать?': 'What to do here?',
  'Что здесь сделать? (ИИ занят — добавится в сообщение)': 'What to do here? (AI is busy: goes into the message)',
  'Добавить в сообщение, не отправляя (Ctrl+Enter)': 'Add to the message without sending (Ctrl+Enter)',
  'ИИ занят — добавится в сообщение': 'AI is busy: goes into the message',
  'Enter — отправить · Ctrl+Enter — в сообщение · Esc — закрыть': 'Enter send · Ctrl+Enter into the message · Esc close',
  'Пометки на картинке': 'Marks on the image',
  'пометка на картинке': 'mark on the image',
  Линия: 'Line',
  Рамка: 'Frame',
  Стрелка: 'Arrow',
  Лассо: 'Lasso',
  'Цвет {c}': 'Colour {c}',
  'Убрать последнюю пометку (Ctrl+Z)': 'Remove the last mark (Ctrl+Z)',
  'Стереть все пометки': 'Erase all marks',
  'Пометки {list} уже на картинке в чате — напишите, что сделать': 'Marks {list} are on the image in the chat: write what to do',
  'Обведите или укажите стрелкой, что изменить — рядом откроется поле для комментария': 'Circle or point with an arrow at what to change: a comment field opens next to it',
  'Вернуть картинку как была до открытия': 'Restore the image as it was before',
  'Отменить правки': 'Undo edits',
  'место на плане': 'a spot on the plan',
  '«{room}», стена {len} мм': '“{room}”, wall {len} mm',
  ' и ещё {n}': ' and {n} more',
  Пометить: 'Mark',
  Пометки: 'Marks',
  'Пометить место на плане (P)': 'Mark a spot on the plan (P)',
  'Закончить пометки (Esc)': 'Stop marking (Esc)',
  'Пометки рисуются на 2D-плане': 'Marks are drawn on the 2D plan',
  'Форма пометки': 'Mark shape',
  'Обведите место на плане — пометка с номером попадёт в сообщение': 'Circle a spot on the plan: a numbered mark goes into the message',
  зона: 'zone',
  линия: 'line',
  внесено: 'applied',
  'Удалить пометку': 'Delete mark',
  'Все в чат': 'All to chat',
  'Очистить пометки': 'Clear marks',
  'Показать на плане': 'Show on the plan',
  'В сообщении — убрать из него': 'In the message: click to take it out',
  'Убрать из сообщения': 'Remove from the message',
  'Убрать отправленные пометки': 'Remove sent marks',
  'Пометить: обведите место на плане — пометка попадёт в сообщение · щелчок — выбрать, Delete — удалить, Ctrl+L — в чат':
    'Mark: circle a spot on the plan and it goes into the message · click selects a mark, Delete removes it, Ctrl+L adds it to the chat',
  'Пометка {n}': 'Mark {n}',
  'Удалить пометку {n}': 'Delete mark {n}',

  // tool titles (shared/aiTools AI_TOOL_TITLES)
  'Чтение плана': 'Reading the plan',
  Выделение: 'Selection',
  'Данные объекта': 'Object data',
  'Добавить стену': 'Add wall',
  'Добавить комнату': 'Add room',
  'Переместить узел': 'Move node',
  'Изменить стену': 'Edit wall',
  'Добавить проём': 'Add opening',
  'Изменить комнату': 'Edit room',
  'Поставить предмет': 'Place item',
  'Переместить предмет': 'Move item',
  'Назначить материал': 'Assign material',
  'Построить план': 'Build plan',
  'Формат PlanSpec': 'PlanSpec format',
  'Вопрос пользователю': 'Question to you',

  // from the main process (exact)
  'По умолчанию': 'Default',
  'Не задан API-ключ (Настройки → ИИ)': 'No API key set (Settings → AI)',
  'Не задан API-ключ Anthropic (Настройки → ИИ)': 'No Anthropic API key set (Settings → AI)',
  'Неверный API-ключ Anthropic': 'Invalid Anthropic API key',
  'Превышен лимит запросов Anthropic API, попробуйте позже': 'Anthropic API rate limit reached, try again later',
  'Ответ оборвался: достигнут лимит длины': 'The answer was cut off: length limit reached',
  'Claude Code запущен…': 'Claude Code started…',
  'Codex запущен…': 'Codex started…',
  'Gemini CLI запущен…': 'Gemini CLI started…',
  'Остановлено пользователем': 'Stopped by the user',
  'Запуск остановлен пользователем': 'Run stopped by the user',
  'Запуск завершён': 'Run finished',
  'Запуск уже идёт': 'A run is already in progress',
  'Неверный запрос': 'Invalid request',
  'Вход для этого провайдера недоступен': 'Sign-in is not available for this provider',
  'Этот провайдер не входит через приложение': 'This provider does not sign in through the app',
  'Время ожидания входа истекло': 'Sign-in timed out',
  'Открыто окно терминала — завершите вход там.': 'A terminal window opened: finish signing in there.',
  'Окно редактора закрыто': 'The editor window is closed',
  'Нет ответа от редактора (время ожидания истекло)': 'No answer from the editor (timed out)',
  'Чат слишком большой для сохранения': 'The chat is too big to save',
  'Ошибка Codex': 'Codex error',

  // change lines of doc tools (ai/tools.ts): approval card, tool group, draft list
  'Стена {from} → {to}, {len} мм': 'Wall {from} → {to}, {len} mm',
  'Комната {area} м² (по осям)': 'Room {area} m² (centerlines)',
  'Узел {from} → {to}': 'Node {from} → {to}',
  'толщина {from} → {to}': 'thickness {from} → {to}',
  'высота {from} → {to}': 'height {from} → {to}',
  'тип {from} → {to}': 'type {from} → {to}',
  'длина → {to}': 'length → {to}',
  'Стена {id}: {changes}': 'Wall {id}: {changes}',
  'Удалено: {list}': 'Deleted: {list}',
  '{kind} на стене {wall}': '{kind} on wall {wall}',
  'название «{name}»': 'name “{name}”',
  'тип {type}': 'type {type}',
  'пол {m}': 'floor {m}',
  'потолок {m}': 'ceiling {m}',
  'стены {m}': 'walls {m}',
  'высота потолка {h}': 'ceiling height {h}',
  'плинтус {h}': 'skirting {h}',
  'Комната «{name}»: {changes}': 'Room “{name}”: {changes}',
  '«{name}» в {at}': '“{name}” at {at}',
  '«{name}» в {at}, {room}': '“{name}” at {at}, {room}',
  'поворот {from}° → {to}°': 'rotation {from}° → {to}°',
  'над полом {h}': 'elevation {h}',
  'размер {w}×{d}×{h}': 'size {w}×{d}×{h}',
  '«{room}», {surface}: {material}': '“{room}”, {surface}: {material}',
  'Стена {id} ({surface}): {material}': 'Wall {id} ({surface}): {material}',
  пол: 'floor',
  потолок: 'ceiling',
  стены: 'walls',
  'левая сторона': 'left side',
  'правая сторона': 'right side',
  'обе стороны': 'both sides',
  'План из PlanSpec (замена уровня)': 'Plan from PlanSpec (level replaced)',
  'План из PlanSpec (новый этаж)': 'Plan from PlanSpec (new floor)',
  '«{room}» ': '“{room}” ',
  '{room}{side} ({sideName}): {before} → {after} мм ({delta}), двигается конец {end}, узлов сдвинуто: {moved}':
    '{room}{side} ({sideName}): {before} → {after} mm ({delta}), end {end} moves, nodes moved: {moved}',
  '⚠ изменился ранее замеренный размер «{room}» {key}: {before} → {after} мм': '⚠ an earlier measured size changed: “{room}” {key}: {before} → {after} mm',
  'Расстояние {fixed} → {move}: {before} → {after} мм ({delta}), сдвигается {move}, узлов сдвинуто: {moved}':
    'Distance {fixed} → {move}: {before} → {after} mm ({delta}), {move} moves, nodes moved: {moved}',
  'Пометка {n} отмечена как внесённая': 'Mark {n} marked as applied',
  Помещение: 'Room',
  // short descriptions of a call (describeCall)
  'Стена от {from} до {to}': 'Wall from {from} to {to}',
  'Комната {w}×{h} в ({x}, {y})': 'Room {w}×{h} at ({x}, {y})',
  'Комната {w}×{h} в ({x}, {y}) «{name}»': 'Room {w}×{h} at ({x}, {y}) “{name}”',
  'Узел {id} → ({x}, {y})': 'Node {id} → ({x}, {y})',
  'Удалить {ids}': 'Delete {ids}',
  'Комната {id}: {fields}': 'Room {id}: {fields}',
  'Поставить {asset}': 'Place {asset}',
  'Поставить {asset} в ({x}, {y})': 'Place {asset} at ({x}, {y})',
  'Поставить {asset} в {room}': 'Place {asset} in {room}',
  'Предмет {id}: {fields}': 'Item {id}: {fields}',
  'Построить план ({mode})': 'Build plan ({mode})',
  'Обмер: {n}': 'Measurements: {n}',
})

/** main-process texts with a name or number inside */
const PATTERNS: [RegExp, string][] = [
  [/^(\S+) не найден в PATH$/, '$1 not found in PATH'],
  [/^(.+?) завершился с кодом (\S+?)(:\n[\s\S]*)?$/, '$1 exited with code $2$3'],
  [/^Вход не завершён \(код (.+)\)$/, 'Sign-in not finished (code $1)'],
  [/^Доступ запрещён: ([\s\S]*)$/, 'Access denied: $1'],
  [/^Нет связи с Anthropic API: ([\s\S]*)$/, 'Cannot reach the Anthropic API: $1'],
  [/^Ошибка Anthropic API \((.+?)\): ([\s\S]*)$/, 'Anthropic API error ($1): $2'],
  [/^Ответ сформировала резервная модель (.+)$/, 'The answer came from the fallback model $1'],
  [/^Модель отказалась отвечать([\s\S]*)$/, 'The model declined to answer$1'],
  [/^MCP-сервер doplan не подключился \((.+)\)$/, 'The doplan MCP server did not connect ($1)'],
  [/^Этой CLI нужен настоящий терминал\. Выполните в терминале: (.+)$/m, 'This CLI needs a real terminal. Run in a terminal: $1'],
]

/** a message produced in the main process, in the UI language (unknown text stays as is) */
export function tAi(text: string | undefined): string {
  if (!text) return ''
  const exact = t(text)
  if (exact !== text) return exact
  if (t('ИИ') === 'ИИ') return text // Russian UI
  for (const [re, en] of PATTERNS) if (re.test(text)) return text.replace(re, en)
  return text
}

/** Russian plural form picked by n (the English dictionary maps each form) */
export function pluralKey(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}
