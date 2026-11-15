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
  'Запуск…': 'Starting…',
  'Провайдер недоступен': 'Provider unavailable',
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
  Карандаш: 'Pencil',
  'Обведите место на плане и добавьте пометку в чат ИИ (Ctrl+L)': 'Circle a spot on the plan and add the mark to the AI chat (Ctrl+L)',
  'Обведите место на плане: пометка получит номер, его можно упомянуть в чате — «в ① ширина 180 см».':
    'Circle a spot on the plan: the mark gets a number you can mention in the chat, e.g. “in ① width 180 cm”.',
  зона: 'zone',
  линия: 'line',
  внесено: 'applied',
  'Удалить пометку': 'Delete mark',
  'Все в чат': 'All to chat',
  'Очистить пометки': 'Clear marks',
  'Карандаш: обведите место на плане · щелчок — выбрать пометку, Delete — удалить, Ctrl+L — в чат':
    'Pencil: circle a spot on the plan · click selects a mark, Delete removes it, Ctrl+L adds it to the chat',
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
