/**
 * Project-folder format helpers shared by main and renderer. Pure TS (no Node/DOM imports).
 *
 * Folder layout:
 *   <Name>/plan.json      the document, pretty-printed with a stable key order (readable git diffs)
 *   <Name>/manifest.json  format info + asset list
 *   <Name>/assets/        embedded files (underlays, imported models), content-addressed names
 *   <Name>/AGENTS.md      instructions for AI agents (edited by the user in the app)
 *   <Name>/CLAUDE.md      `@AGENTS.md` (Claude Code import)
 *   <Name>/.gitignore, .gitattributes
 */

export const PLAN_FILE = 'plan.json'
export const MANIFEST_FILE = 'manifest.json'
export const AGENTS_FILE = 'AGENTS.md'
export const CLAUDE_FILE = 'CLAUDE.md'
export const ASSETS_DIR = 'assets'
export const FOLDER_FORMAT_VERSION = 1

/** keys printed first (in this order) in every object; the rest follow alphabetically */
const PRIORITY_KEYS = ['version', 'meta', 'id', 'kind', 'type', 'name', 'levelId']
const PRIORITY = new Map(PRIORITY_KEYS.map((k, i) => [k, i]))

function compareKeys(a: string, b: string): number {
  const pa = PRIORITY.get(a)
  const pb = PRIORITY.get(b)
  if (pa !== undefined || pb !== undefined) {
    if (pa === undefined) return 1
    if (pb === undefined) return -1
    return pa - pb
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/** JSON-compatible view of a value: drops undefined/functions like JSON.stringify, honours toJSON */
function toPlain(v: unknown, inArray: boolean): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    v = (v as { toJSON(): unknown }).toJSON()
  }
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return inArray ? null : undefined
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'bigint') throw new TypeError('BigInt не поддерживается в plan.json')
  return v
}

const INLINE_WIDTH = 100

/** single-line rendering, or null if the value is too big / too deep to be printed on one line */
function inline(v: unknown, depth: number): string | null {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (depth > 2) return null
  let out: string
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (const x of v) {
      const s = inline(toPlain(x, true), depth + 1)
      if (s === null) return null
      parts.push(s)
    }
    out = `[${parts.join(', ')}]`
  } else {
    const parts: string[] = []
    for (const k of Object.keys(v).sort(compareKeys)) {
      const x = toPlain((v as Record<string, unknown>)[k], false)
      if (x === undefined) continue
      const s = inline(x, depth + 1)
      if (s === null) return null
      parts.push(`${JSON.stringify(k)}: ${s}`)
    }
    out = parts.length ? `{ ${parts.join(', ')} }` : '{}'
  }
  return out.length <= INLINE_WIDTH ? out : null
}

function write(v: unknown, indent: string, step: string): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  const one = inline(v, 0)
  if (one !== null && (Array.isArray(v) ? !v.some((x) => x !== null && typeof x === 'object' && Object.keys(x).length > 3) : true)) {
    // small containers stay on one line ({ "x": 1, "y": 2 }); big ones are expanded
    if (one.length + indent.length <= INLINE_WIDTH) return one
  }
  const inner = indent + step
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return `[\n${v.map((x) => inner + write(toPlain(x, true), inner, step)).join(',\n')}\n${indent}]`
  }
  const keys = Object.keys(v).sort(compareKeys)
  const lines: string[] = []
  for (const k of keys) {
    const x = toPlain((v as Record<string, unknown>)[k], false)
    if (x === undefined) continue
    lines.push(`${inner}${JSON.stringify(k)}: ${write(x, inner, step)}`)
  }
  if (!lines.length) return '{}'
  return `{\n${lines.join(',\n')}\n${indent}}`
}

/**
 * Deterministic pretty JSON: object keys in a stable order (priority keys first, then alphabetical),
 * small objects/arrays on one line, two-space indent, trailing newline. `JSON.parse` of the result
 * equals `JSON.parse(JSON.stringify(value))`.
 */
export function stableStringify(value: unknown): string {
  const v = toPlain(value, false)
  if (v === undefined) throw new TypeError('Пустой документ')
  return `${write(v, '', '  ')}\n`
}

// ───────────── commit messages ─────────────

/**
 * Builds a commit subject from the undo labels recorded since the previous commit:
 * ["Стена", "Дверь", "Стена", "Дверь"] → "Стена ×2, Дверь ×2". Labels keep the order of their first
 * appearance; the result is capped at `maxLength` characters with "и ещё N".
 */
export function buildCommitMessage(labels: readonly string[], opts?: { maxLength?: number; empty?: string }): string {
  const maxLength = Math.max(20, opts?.maxLength ?? 72)
  const counts = new Map<string, number>()
  for (const raw of labels) {
    const l = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!l) continue
    counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  if (!counts.size) return opts?.empty ?? 'Сохранение'
  const parts = [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l))
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out}, ${parts[i]}` : parts[i]
    const rest = parts.length - i - 1
    const tail = rest > 0 ? `, и ещё ${rest}` : ''
    if (next.length + tail.length > maxLength) {
      const left = parts.length - i
      if (!out) return `${parts[i].slice(0, maxLength - 1)}…`
      return `${out}, и ещё ${left}`
    }
    out = next
  }
  return out
}

// ───────────── tags ─────────────

/** git ref-safe tag name from a user-entered label ("Согласовано с заказчиком" → "Согласовано-с-заказчиком") */
export function tagNameFrom(label: string): string {
  let s = String(label ?? '')
    .normalize('NFC')
    .trim()
    // characters git refuses in ref names (control, space, ~ ^ : ? * [ \, DEL) plus ] for symmetry
    .replace(/[\u0000- \u007f~^:?*[\]\\]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '-')
    .replace(/\/+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (s.endsWith('.lock')) s = s.slice(0, -5)
  if (s === '@') s = ''
  return s.slice(0, 100)
}

// ───────────── scaffold files ─────────────

export const CLAUDE_MD = '@AGENTS.md\n'

export const GITIGNORE = `# doplan: временные файлы
*.tmp-*
*.tmp
~$*
Thumbs.db
desktop.ini
.DS_Store
# локальные настройки ИИ-агентов
.claude/settings.local.json
`

export const GITATTRIBUTES = `*.json text eol=lf
*.md text eol=lf
assets/** binary
`

/** marker separating the generated part of AGENTS.md from the part the user fills in */
export const AGENTS_USER_SECTION = '## Пожелания и правила проекта'

export function agentsTemplate(projectName: string): string {
  const name = String(projectName ?? '').trim() || 'Проект'
  return `# ${name} — инструкции для ИИ-агента

Это папка проекта **doplan** — планировка квартиры или дома и дизайн интерьера.
Проект открыт в приложении doplan; агент (Claude Code, Codex и другие) работает в этой папке.

## Файлы проекта

- \`plan.json\` — весь документ: этажи, узлы, стены, проёмы, помещения, предметы, светильники,
  размеры, надписи, подложки, материалы и настройки рендера. Ключи упорядочены стабильно,
  форматирование постоянное — удобно читать и сравнивать в git.
- \`manifest.json\` — служебная информация о формате и список вложенных файлов. Не редактировать.
- \`assets/\` — вложенные файлы (подложки, импортированные модели). Имена — SHA-256 содержимого;
  в \`plan.json\` они упоминаются как \`doplan-asset://project/<имя файла>\`.
- \`AGENTS.md\` — этот файл. \`CLAUDE.md\` подключает его для Claude Code.
- История версий ведётся в git: каждое сохранение в doplan (Ctrl+S) — отдельный коммит.

## Единицы и оси

- Все длины — в **миллиметрах** (целые или с десятыми). Площади считаются в м².
- План: ось X вправо, ось Y вниз (как на экране), начало координат произвольное.
- Углы поворота — в градусах, по часовой стрелке на плане (ось Y направлена вниз), 0° = +X.
- Высоты и отметки — в мм от пола своего этажа.
- Толщина стен обычно 80–120 мм (перегородки), 200–400 мм (несущие и наружные); высота этажа 2500–3000 мм.

## Встроенный чат doplan и внешние агенты

- **Встроенный чат doplan** (доступны инструменты MCP-сервера \`doplan\`: get_plan, add_wall,
  place_item, render_snapshot…) меняет план только через эти инструменты. Правки сразу видны
  в приложении и отменяются Ctrl+Z. \`plan.json\` на диске — последнее сохранённое состояние,
  его и \`assets/\` встроенный чат напрямую не правит.
- **Внешний агент** (Claude Code, Codex в терминале без сервера \`doplan\`) работает с файлами
  по правилам ниже. Править \`plan.json\` можно, когда в doplan нет несохранённых изменений.

## Что внешнему агенту можно делать

- Читать \`plan.json\` и отвечать на вопросы о планировке (площади, размеры, состав помещений).
- Менять \`plan.json\`: двигать стены и проёмы, добавлять и расставлять мебель, менять материалы
  отделки, названия и типы помещений. Сохранять корректный JSON и существующие \`id\`;
  новые \`id\` — в формате \`<префикс>_<10 символов>\` (\`w_\` стена, \`n_\` узел, \`o_\` проём,
  \`r_\` помещение, \`i_\` предмет, \`l_\` светильник).
- Делать коммиты в git с понятным сообщением на русском.

## Чего делать нельзя

- Удалять или переписывать историю git (\`reset --hard\`, \`rebase\`, \`push --force\`, удаление тегов).
- Менять или удалять файлы в \`assets/\` и \`manifest.json\`.
- Менять \`meta.app\` и \`version\` в \`plan.json\`.
- Если приложение doplan открыто с несохранёнными изменениями, правки в \`plan.json\` на диске
  будут конфликтовать с ними: doplan предупредит об этом при сохранении.

${AGENTS_USER_SECTION}

<!-- Опишите здесь задачу и свои пожелания: состав семьи, стиль интерьера, бюджет,
     что нельзя трогать (несущие стены, мокрые зоны), какие помещения важнее. -->
`
}
