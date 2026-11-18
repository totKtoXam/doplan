/**
 * The «ИИ» tab of the right dock: chat with an agent that edits the open plan through doc tools.
 * Layout follows Claude Desktop: plain assistant text with collapsed tool activity, a rounded
 * composer, and a footer with the mode / model / context popovers.
 */
import {
  ArrowUp,
  Ban,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Image as ImageIcon,
  Info,
  KeyRound,
  LoaderCircle,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AiChatMeta, AiChatSettings, AiMessage, AiPart, AiProviderInfo } from '@shared/aiChat'
import { useDoc } from '@/store/document'
import { uiStore, useUi } from '@/store/ui'
import { activateTool } from '@/ui/shell/tools'
import { cn, Popover } from '@/ui/kit'
import {
  addImageFiles,
  addUnderlayImage,
  answerApproval,
  answerQuestion,
  applyDraft,
  cancelLogin,
  consumeInsert,
  discardDraft,
  dismissLogin,
  editableText,
  editAndResend,
  hasAnswer,
  newChat,
  openChat,
  pickAnswer,
  QUICK_ACTIONS,
  quickCmd,
  refreshProviders,
  removeChat,
  removeChip,
  removeImage,
  removeQuote,
  replaceImage,
  send,
  sendLoginCode,
  setAnswerOther,
  startLogin,
  stop,
  updateSettings,
  useAi,
} from './store'
import { pluralKey, tAi } from './i18n'
import { ImageMarkup } from './ImageMarkup'
import { MarkButton } from './MarkButton'
import { parseMarkdown } from './markdown'
import { QuoteButton } from './QuoteButton'
import { t } from '@/i18n'

type ToolPart = Extract<AiPart, { type: 'tool' }>
type QuestionPart = Extract<AiPart, { type: 'question' }>
type Effort = AiChatSettings['effort']

const EFFORT_LABEL: Record<string, string> = { '': 'Обычный', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимальный' }
const EFFORT_HINT: Record<string, string> = {
  '': 'Как настроено у провайдера',
  low: 'Быстрые ответы на простые задачи',
  medium: 'Баланс скорости и качества',
  high: 'Глубже продумывает изменения',
  xhigh: 'Для сложных перепланировок',
  max: 'Максимум размышлений, дольше и дороже',
}

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const fmtUsd = (v: number) => `$${v.toFixed(v < 0.1 ? 4 : 2)}`

/** «Выполнено {n} действие / действия / действий», each form a dictionary key */
function plural(n: number, one: string, few: string, many: string): string {
  return t(pluralKey(n, one, few, many), { n })
}

const rowBtn = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent'

/** popover keyboard shortcuts: digits pick the n-th option */
function useDigitKeys(open: boolean, count: number, pick: (i: number) => void): void {
  const pickRef = useRef(pick)
  pickRef.current = pick
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, count)) {
        e.preventDefault()
        e.stopPropagation()
        pickRef.current(n - 1)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, count])
}

// ───────────── message parts ─────────────

/** inline markdown: `code`, **bold** */
function inlineMd(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const s = m[0]
    out.push(
      s.startsWith('`') ? (
        <code key={k++} className="rounded bg-[color-mix(in_srgb,var(--text)_10%,transparent)] px-1 font-mono text-[11px]">
          {s.slice(1, -1)}
        </code>
      ) : (
        <strong key={k++} className="font-semibold">
          {s.slice(2, -2)}
        </strong>
      ),
    )
    last = m.index + s.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const
/** the table is as wide as its content (w-max): short columns hug it, long text wraps at this width */
const CELL = 'max-w-[15rem] [overflow-wrap:break-word]'

/**
 * Message markdown: text keeps its line breaks, GFM tables and fenced code get their own boxes. Wide
 * tables and code scroll sideways inside the message; long words and links wrap — nothing runs past
 * the panel edge.
 */
function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div data-ai-text className={cn('min-w-0 text-[12.5px] leading-relaxed [overflow-wrap:anywhere] select-text', className)}>
      {blocks.map((b, i) =>
        b.type === 'text' ? (
          <div key={i} className="my-1 whitespace-pre-wrap first:mt-0 last:mb-0">
            {inlineMd(b.text)}
          </div>
        ) : b.type === 'heading' ? (
          <div key={i} className={cn('mt-2 mb-1 font-semibold first:mt-0', b.level <= 2 ? 'text-[13.5px]' : 'text-[12.5px]')}>
            {inlineMd(b.text)}
          </div>
        ) : b.type === 'code' ? (
          <pre
            key={i}
            className="my-1.5 max-w-full overflow-x-auto rounded-md border border-border bg-[color-mix(in_srgb,var(--text)_5%,transparent)] px-2 py-1.5 font-mono text-[11px] leading-snug [overflow-wrap:normal] whitespace-pre first:mt-0 last:mb-0"
          >
            {b.text}
          </pre>
        ) : (
          <div key={i} data-md-table className="my-1.5 max-w-full overflow-x-auto rounded-md border border-border first:mt-0 last:mb-0">
            <table className="w-max border-collapse text-[11.5px] leading-snug">
              <thead>
                <tr className="bg-panel-2">
                  {b.head.map((c, k) => (
                    <th key={k} className={cn('border-b border-border px-2 py-1 align-bottom font-semibold', ALIGN[b.align[k] ?? 'left'])}>
                      <div className={CELL}>{inlineMd(c)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-border last:border-b-0">
                    {r.map((c, k) => (
                      <td key={k} className={cn('px-2 py-0.5 align-top', ALIGN[b.align[k] ?? 'left'])}>
                        <div className={CELL}>{inlineMd(c)}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolPart['status'] }) {
  switch (status) {
    case 'running':
      return <LoaderCircle size={12} className="dp-spin text-accent" />
    case 'pending':
      return <CircleAlert size={12} className="text-warning" />
    case 'done':
      return <Check size={12} className="text-success" />
    case 'proposed':
      return <Sparkles size={12} className="text-accent" />
    case 'rejected':
      return <Ban size={12} className="text-muted" />
    case 'error':
      return <X size={12} className="text-danger" />
  }
}

/** one tool call inside an expanded activity group */
function ToolRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false)
  const statusText = t({ running: 'выполняется', pending: 'ждёт подтверждения', done: '', error: 'ошибка', rejected: 'отклонено', proposed: 'в черновике' }[part.status])
  const hasDetails = part.args !== undefined || !!part.result
  return (
    <div className="text-[11px]">
      <button type="button" className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover" onClick={() => hasDetails && setOpen((o) => !o)}>
        {part.origin === 'doc' ? <Sparkles size={12} className="shrink-0 text-accent" /> : <Wrench size={12} className="shrink-0 text-muted" />}
        <span className="min-w-0 flex-1 truncate">{t(part.title)}</span>
        {statusText && <span className="text-[10px] text-muted">{statusText}</span>}
        <StatusIcon status={part.status} />
      </button>
      {open && (
        <div className="mx-1 mb-1 rounded border border-border bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-2 py-1 font-mono text-[10px] break-words whitespace-pre-wrap text-muted select-text">
          {part.args !== undefined && <div className="mb-1">{JSON.stringify(part.args)}</div>}
          {part.result && <div className="max-h-48 overflow-auto text-text">{part.result}</div>}
        </div>
      )}
    </div>
  )
}

/** a change waiting for the user's approval (permission: ask) */
function ApprovalCard({ part }: { part: ToolPart }) {
  return (
    <div className="my-1.5 rounded-lg border border-warning/50 bg-warning/5 px-2.5 py-2 text-[11px]">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <CircleAlert size={12} className="text-warning" /> {t(part.title)}
      </div>
      {part.changes?.length ? (
        <ul className="mb-1.5 text-text">
          {part.changes.map((c, i) => (
            <li key={i} className="truncate" title={c}>
              • {c}
            </li>
          ))}
        </ul>
      ) : (
        part.result && <div className="mb-1.5 text-muted">{part.result}</div>
      )}
      <div className="flex gap-1.5">
        <button type="button" className="rounded-md bg-accent px-2.5 py-0.5 text-accent-fg hover:bg-accent-hover" onClick={() => answerApproval(part.id, true)}>
          {t('Применить')}
        </button>
        <button type="button" className="rounded-md border border-border px-2.5 py-0.5 hover:bg-hover" onClick={() => answerApproval(part.id, false)}>
          {t('Отклонить')}
        </button>
      </div>
    </div>
  )
}

/**
 * The agent's open questions (ask_user), pinned above the input box until answered. Text typed in the
 * box and sent is the answer too (with what is picked here).
 */
function QuestionCard() {
  const asking = useAi((s) => s.asking)
  const attached = useAi((s) => s.chips.length > 0 || s.images.length > 0 || s.quotes.length > 0)
  if (!asking) return null
  const ready = hasAnswer(asking, '', attached)
  return (
    <div data-ai-question className="mx-2 mb-1.5 rounded-xl border border-accent/50 bg-[color-mix(in_srgb,var(--accent)_6%,var(--panel))] px-2.5 py-2 text-[11.5px] shadow-sm">
      <div className="mb-1.5 flex items-center gap-1.5 font-medium">
        <CircleHelp size={13} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1">{t('Агент спрашивает')}</span>
        <button type="button" aria-label={t('Пропустить')} title={t('Не отвечать')} className="text-muted hover:text-text" onClick={() => answerQuestion(null)}>
          <X size={12} />
        </button>
      </div>
      <div className="flex max-h-[45vh] flex-col gap-2.5 overflow-y-auto pr-0.5">
        {asking.questions.map((q, qi) => {
          const d = asking.draft[qi]
          return (
            <div key={qi}>
              <div className="mb-1 leading-snug">
                {q.header && <span className="mr-1.5 rounded bg-panel-3 px-1.5 py-px text-[10px] text-muted">{q.header}</span>}
                <span className="text-text">{q.question}</span>
                {q.multiSelect && <span className="ml-1 text-[10px] text-faint">{t('(можно несколько)')}</span>}
              </div>
              <div className="flex flex-col gap-1">
                {q.options.map((o) => {
                  const on = d.picked.includes(o.label)
                  return (
                    <button
                      key={o.label}
                      type="button"
                      aria-pressed={on}
                      className={cn(
                        'flex items-start gap-1.5 rounded-lg border px-2 py-1 text-left',
                        on ? 'border-accent bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]' : 'border-border hover:bg-hover',
                      )}
                      onClick={() => pickAnswer(qi, o.label)}
                    >
                      <span
                        className={cn(
                          'mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center border',
                          q.multiSelect ? 'rounded-sm' : 'rounded-full',
                          on ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong',
                        )}
                      >
                        {on && <Check size={9} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block">{o.label}</span>
                        {o.description && <span className="block text-[10.5px] leading-snug text-muted">{o.description}</span>}
                      </span>
                    </button>
                  )
                })}
                <input
                  value={d.other ?? ''}
                  placeholder={t('Другое — своими словами')}
                  className="rounded-lg border border-border bg-input px-2 py-1 outline-none placeholder:text-faint focus:border-accent"
                  onChange={(e) => setAnswerOther(qi, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && ready) {
                      e.preventDefault()
                      answerQuestion()
                    }
                    e.stopPropagation()
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!ready}
          className="rounded-md bg-accent px-2.5 py-0.5 text-accent-fg hover:bg-accent-hover disabled:bg-panel-3 disabled:text-faint"
          onClick={() => answerQuestion()}
        >
          {t('Ответить')}
        </button>
        <button type="button" className="rounded-md border border-border px-2.5 py-0.5 hover:bg-hover" onClick={() => answerQuestion(null)}>
          {t('Пропустить')}
        </button>
        <span className="min-w-0 flex-1 truncate text-right text-[10px] text-faint">{t('или ответьте в поле ниже')}</span>
      </div>
    </div>
  )
}

/** the questions in the message stream: what was asked and what the user answered */
function QuestionRecord({ part }: { part: QuestionPart }) {
  // a question still open in a stored chat (the app was closed meanwhile) was never answered
  const open = useAi((s) => s.asking?.callId === part.id)
  const status = part.status === 'pending' && !open ? 'cancelled' : part.status
  return (
    <div className="my-1.5 rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[11px]">
      <div className="mb-0.5 flex items-center gap-1.5 text-muted">
        <CircleHelp size={12} className={cn('shrink-0', status === 'pending' && 'text-accent')} />
        <span className="min-w-0 flex-1">{t('Вопросы агента')}</span>
        <span className="text-[10px] text-faint">{t({ pending: 'ждёт ответа', answered: 'отвечено', cancelled: 'без ответа' }[status])}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {part.questions.map((q, i) => {
          const a = part.answers?.[i]
          const ans = [...(a?.picked ?? []), ...(a?.other ? [a.other] : [])].join('; ')
          return (
            <li key={i} className="leading-snug">
              <span className="text-muted">{q.header || q.question}</span>
              {ans && <span className="text-text"> — {ans}</span>}
            </li>
          )
        })}
      </ul>
      {part.quotes?.map((q, i) => <QuoteBlock key={i} text={q} className="mt-1" />)}
      {part.note && <div className="mt-0.5 leading-snug text-text">«{part.note}»</div>}
    </div>
  )
}

type Activity = { type: 'tool'; part: ToolPart } | { type: 'thinking'; text: string }

/** consecutive tool calls / thinking collapsed into «Выполнено N действий ›» */
function ActivityGroup({ items, live }: { items: Activity[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = items.filter((a): a is Extract<Activity, { type: 'tool' }> => a.type === 'tool').map((a) => a.part)
  const running = live && tools.find((t) => t.status === 'running')
  const pending = live ? tools.filter((t) => t.status === 'pending') : []
  const errors = tools.filter((t) => t.status === 'error').length
  const changes = tools.flatMap((t) => (t.status === 'done' || t.status === 'proposed' ? t.changes ?? [] : []))
  const images = tools.map((t) => t.image).filter((s): s is string => !!s)
  const onlyThinking = !tools.length

  let label: string
  if (running) label = t(running.title)
  else if (onlyThinking) label = t('Размышления')
  else if (tools.length === 1) label = t(tools[0].title)
  else label = plural(tools.length, 'Выполнено {n} действие', 'Выполнено {n} действия', 'Выполнено {n} действий')

  return (
    <div className="my-1">
      <button type="button" className="group flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-[11.5px] text-muted hover:text-text" onClick={() => setOpen((o) => !o)}>
        {running ? <LoaderCircle size={12} className="dp-spin shrink-0 text-accent" /> : onlyThinking ? <Brain size={12} className="shrink-0" /> : null}
        <span className={cn('truncate', running && 'animate-pulse')}>{label}</span>
        {errors > 0 && !running && <span className="text-danger">· {errors === 1 ? t('ошибка') : t('ошибок: {n}', { n: errors })}</span>}
        {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
      </button>
      {open && (
        <div className="mt-0.5 ml-1 border-l border-border pl-2">
          {items.map((a, i) =>
            a.type === 'tool' ? (
              <ToolRow key={i} part={a.part} />
            ) : (
              <div key={i} className="my-0.5 px-1 text-[11px] whitespace-pre-wrap text-muted select-text">
                {a.text}
              </div>
            ),
          )}
        </div>
      )}
      {!open && changes.length > 0 && (
        <ul className="mt-0.5 ml-1 border-l-2 border-accent/40 pl-2 text-[11px] text-text">
          {changes.slice(0, 8).map((c, i) => (
            <li key={i} className="truncate" title={c}>
              {c}
            </li>
          ))}
          {changes.length > 8 && <li className="text-muted">{t('… ещё {n}', { n: changes.length - 8 })}</li>}
        </ul>
      )}
      {images.map((src, i) => (
        <img key={i} src={src} alt="" className="mt-1 max-h-44 rounded-lg border border-border" />
      ))}
      {pending.map((p) => (
        <ApprovalCard key={p.id} part={p} />
      ))}
    </div>
  )
}

function Notice({ part }: { part: Extract<AiPart, { type: 'notice' }> }) {
  const { level, text, login } = part
  const Icon = level === 'error' ? CircleAlert : level === 'warning' ? TriangleAlert : Info
  return (
    <div
      className={cn(
        'my-1 flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]',
        level === 'error' ? 'bg-danger/10 text-danger' : level === 'warning' ? 'bg-warning/10 text-warning' : 'text-muted',
      )}
    >
      <Icon size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap select-text">{tAi(text)}</span>
      {login && (
        <button type="button" className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-accent-fg hover:bg-accent-hover" onClick={() => void startLogin(login)}>
          {t('Войти')}
        </button>
      )}
    </div>
  )
}

/** passages the user quoted: above the text of their message, and in the input box before sending */
function QuoteBlock({ text, className, children }: { text: string; className?: string; children?: ReactNode }) {
  return (
    <div data-ai-quote className={cn('flex min-w-0 items-start gap-1 border-l-2 border-[color-mix(in_srgb,var(--accent)_55%,transparent)] pl-2', className)}>
      <div className="line-clamp-3 min-w-0 flex-1 text-[11.5px] leading-snug whitespace-pre-wrap text-muted [overflow-wrap:anywhere] select-text" title={text}>
        {text}
      </div>
      {children}
    </div>
  )
}

function UserMessage({ m }: { m: AiMessage }) {
  const running = useAi((s) => !!s.running)
  const images = m.images?.filter(Boolean) ?? []
  const text = editableText(m)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(240, el.scrollHeight)}px`
  }, [value, editing])

  // a turn started elsewhere: the edit closes (nothing is lost, the message is as it was)
  useEffect(() => {
    if (running && !busy) setEditing(false)
  }, [running, busy])

  const canSend = !!value.trim() || images.length > 0 || !!m.quotes?.length
  const submit = async () => {
    if (!canSend || busy) return
    setBusy(true)
    try {
      // started: a new message replaces this one (this component goes); not started: the edit stays open
      if (!(await editAndResend(m.id, value))) setBusy(false)
    } catch {
      setBusy(false)
    }
  }

  const extras = (
    <>
      {m.quotes?.map((q, i) => <QuoteBlock key={i} text={q} className="mb-1" />)}
      {m.chips && (
        <div className="mb-1 flex flex-wrap gap-1">
          {m.chips.map((c) => (
            <span key={c.id} className="rounded bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-1.5 text-[10px]" title={c.summary}>
              {t(c.label)}
            </span>
          ))}
        </div>
      )}
    </>
  )

  return (
    <div data-ai-user-msg className="group/msg flex flex-col items-end gap-1">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {images.map((src, i) => (
            <img key={i} src={src} alt="" className="h-14 rounded-lg border border-border" />
          ))}
        </div>
      )}
      {editing ? (
        <div data-ai-edit className="w-full rounded-2xl border border-border-strong bg-input px-3 pt-2 pb-1.5 focus-within:border-[color-mix(in_srgb,var(--accent)_60%,var(--border-strong))]">
          {extras}
          <textarea
            ref={ta}
            autoFocus
            value={value}
            rows={1}
            disabled={busy}
            className="block max-h-[240px] w-full resize-none bg-transparent text-[12.5px] leading-relaxed outline-none"
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              }
              e.stopPropagation() // editor shortcuts must not fire while typing
            }}
          />
          <div className="mt-1 flex items-center gap-1.5">
            <span className="min-w-0 flex-1 text-[10px] text-faint">{t('Ответы после этого сообщения будут заменены')}</span>
            <button type="button" className="rounded-md px-2 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-text" onClick={() => setEditing(false)}>
              {t('Отмена')}
            </button>
            <button
              type="button"
              className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-fg hover:bg-accent-hover disabled:bg-panel-3 disabled:text-faint"
              disabled={!canSend || busy}
              onClick={() => void submit()}
            >
              {t('Отправить')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex max-w-full items-start justify-end gap-1">
          {!running && (
            <button
              type="button"
              data-ai-edit-btn
              aria-label={t('Изменить сообщение')}
              title={t('Изменить и отправить заново')}
              className="mt-1 shrink-0 rounded-md p-1 text-faint opacity-0 group-hover/msg:opacity-100 hover:bg-hover hover:text-text focus-visible:opacity-100"
              onClick={() => {
                setValue(text)
                setEditing(true)
              }}
            >
              <Pencil size={12} />
            </button>
          )}
          <div className="max-w-[88%] min-w-0 rounded-2xl bg-panel-3 px-3 py-1.5">
            {extras}
            {text && <RichText text={text} />}
          </div>
        </div>
      )}
    </div>
  )
}

function Message({ m, live }: { m: AiMessage; live: boolean }) {
  if (m.role === 'user') return <UserMessage m={m} />

  // group consecutive tool / thinking parts
  const blocks: ({ kind: 'part'; part: AiPart } | { kind: 'group'; items: Activity[] })[] = []
  for (const p of m.parts) {
    if (p.type === 'tool' || p.type === 'thinking') {
      const item: Activity = p.type === 'tool' ? { type: 'tool', part: p } : { type: 'thinking', text: p.text }
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'group') last.items.push(item)
      else blocks.push({ kind: 'group', items: [item] })
    } else blocks.push({ kind: 'part', part: p })
  }
  const lastIsText = m.parts[m.parts.length - 1]?.type === 'text'
  return (
    <div className="pr-1">
      {blocks.map((b, i) =>
        b.kind === 'group' ? (
          <ActivityGroup key={i} items={b.items} live={live} />
        ) : b.part.type === 'text' ? (
          <RichText key={i} text={b.part.text} className="my-1" />
        ) : b.part.type === 'notice' ? (
          <Notice key={i} part={b.part} />
        ) : b.part.type === 'question' ? (
          <QuestionRecord key={i} part={b.part} />
        ) : null,
      )}
      {live && !lastIsText && !m.parts.some((p) => (p.type === 'tool' && p.status === 'running') || (p.type === 'question' && p.status === 'pending')) && (
        <div className="my-1 flex items-center gap-1.5 text-[11.5px] text-muted">
          <LoaderCircle size={12} className="dp-spin text-accent" /> <span className="animate-pulse">{t('Думаю…')}</span>
        </div>
      )}
    </div>
  )
}

// ───────────── header: chat title + history ─────────────

function ChatRow({ c, active, legacy, onPick }: { c: AiChatMeta; active: boolean; legacy: boolean; onPick(): void }) {
  return (
    <div className={cn('group flex items-center gap-1 rounded-md hover:bg-hover', active && 'bg-active')}>
      <button
        type="button"
        className="min-w-0 flex-1 px-2 py-1.5 text-left"
        title={c.title}
        onClick={() => {
          onPick()
          void openChat(c.id, legacy)
        }}
      >
        <div className="truncate">{c.title || t('Без названия')}</div>
        <div className="text-[10px] text-faint">{new Date(c.updatedAt).toLocaleString()}</div>
      </button>
      <button type="button" title={t('Удалить чат')} aria-label={t('Удалить чат')} className="mr-1 hidden rounded p-1 text-muted group-hover:block hover:text-danger" onClick={() => void removeChat(c.id, legacy)}>
        <Trash2 size={12} />
      </button>
    </div>
  )
}

function ChatHeader() {
  const title = useAi((s) => s.chat.title)
  const chats = useAi((s) => s.chats)
  const legacyChats = useAi((s) => s.legacyChats)
  const cur = useAi((s) => s.chat.id)
  const curLegacy = useAi((s) => s.legacy)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
      <button
        ref={anchor}
        type="button"
        className={cn('flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-medium hover:bg-hover', open && 'bg-hover')}
        onClick={() => setOpen((o) => !o)}
        title={t('Чаты этого проекта')}
      >
        <span className="truncate">{title || t('Новый чат')}</span>
        <ChevronDown size={12} className="shrink-0 text-muted" />
      </button>
      <button type="button" title={t('Новый чат')} aria-label={t('Новый чат')} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-text" onClick={() => newChat()}>
        <SquarePen size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={280} aria-label={t('Чаты')}>
        <div className="p-1">
          <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted">{t('Чаты этого проекта')}</div>
          {!chats.length && <div className="px-2 pb-2 text-faint">{t('Пока нет сохранённых чатов')}</div>}
          {chats.map((c) => (
            <ChatRow key={c.id} c={c} active={!curLegacy && c.id === cur} legacy={false} onPick={() => setOpen(false)} />
          ))}
          {legacyChats.length > 0 && (
            <>
              <div className="mt-1 border-t border-border px-2 pt-2 pb-1.5 text-[11px] text-muted" title={t('Чаты несохранённых проектов из версий до 0.6. Они общие для всех проектов и удаляются только вручную.')}>
                {t('Ранние чаты (общие)')}
              </div>
              {legacyChats.map((c) => (
                <ChatRow key={c.id} c={c} active={curLegacy && c.id === cur} legacy onPick={() => setOpen(false)} />
              ))}
            </>
          )}
        </div>
      </Popover>
    </div>
  )
}

// ───────────── sign-in ─────────────

/** shown when the selected CLI is not signed in, and while an in-app sign-in runs */
function LoginCard({ prov }: { prov: AiProviderInfo | undefined }) {
  const login = useAi((s) => s.login)
  const loginLabel = useAi((s) => s.providers.find((p) => p.id === s.login?.provider)?.label ?? 'CLI')
  const [code, setCode] = useState('')
  const done = login?.phase === 'done'
  useEffect(() => {
    if (!done) return
    const t = setTimeout(dismissLogin, 5000)
    return () => clearTimeout(t)
  }, [done])

  const needs = prov?.available && prov.canLogin && prov.auth === 'required'
  if (!login && !needs) return null
  const label = login ? loginLabel : prov?.label

  if (!login) {
    return (
      <div className="mx-2 mb-1.5 flex items-center gap-2 rounded-xl border border-border bg-panel-2 px-3 py-2 text-[11.5px]">
        <KeyRound size={14} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{label}</span>
          {t(': нужен вход в аккаунт')}
        </span>
        <button type="button" className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-accent-fg hover:bg-accent-hover" onClick={() => prov && void startLogin(prov.id)}>
          {t('Войти')}
        </button>
      </div>
    )
  }

  // the sign-in link is shown above; keep the rest of the CLI's chatter short
  const tail = login.output
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/https?:\/\//.test(l))
    .slice(-2)
    // the app's own lines (terminal fallback) in the UI language; the CLI's stay as printed
    .map((l) => tAi(l.trim()))
    .join('\n')
  return (
    <div className="mx-2 mb-1.5 rounded-xl border border-border bg-panel-2 px-3 py-2 text-[11.5px]">
      <div className="flex items-center gap-2">
        {login.phase === 'running' ? (
          <LoaderCircle size={14} className="dp-spin shrink-0 text-accent" />
        ) : login.phase === 'done' ? (
          <Check size={14} className="shrink-0 text-success" />
        ) : (
          <CircleAlert size={14} className="shrink-0 text-danger" />
        )}
        <span className="min-w-0 flex-1 font-medium">
          {t(login.phase === 'running' ? 'Вход в {name}…' : login.phase === 'done' ? '{name}: вход выполнен' : '{name}: вход не удался', { name: label ?? '' })}
        </span>
        {login.phase === 'running' ? (
          <button type="button" className="shrink-0 rounded-md px-2 py-0.5 text-muted hover:bg-hover hover:text-text" onClick={() => cancelLogin()}>
            {t('Отмена')}
          </button>
        ) : (
          <button type="button" aria-label={t('Закрыть')} className="shrink-0 rounded p-0.5 text-muted hover:text-text" onClick={() => dismissLogin()}>
            <X size={13} />
          </button>
        )}
      </div>
      {login.phase === 'running' && (
        <>
          <div className="mt-1 text-muted">{t('Браузер откроет страницу входа. Подтвердите доступ; если страница покажет код — вставьте его сюда.')}</div>
          {login.url && (
            <a href={login.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-accent hover:underline">
              <ExternalLink size={11} /> {t('Открыть страницу входа')}
            </a>
          )}
          <form
            className="mt-1.5 flex gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              sendLoginCode(code)
              setCode('')
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={t('Код со страницы входа')}
              className="min-w-0 flex-1 rounded-md border border-border bg-input px-2 py-1 text-[11px] outline-none focus:border-accent"
            />
            <button type="submit" disabled={!code.trim()} className="rounded-md border border-border px-2 py-1 hover:bg-hover disabled:opacity-40">
              {t('Отправить')}
            </button>
          </form>
        </>
      )}
      {login.phase === 'error' && (
        <div className="mt-1 flex items-start gap-2">
          <span className="min-w-0 flex-1 font-mono text-[10px] break-words whitespace-pre-wrap text-muted select-text">{tAi(login.error)}</span>
          <button type="button" className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-accent-fg hover:bg-accent-hover" onClick={() => void startLogin(login.provider)}>
            {t('Повторить')}
          </button>
        </div>
      )}
      {login.phase === 'running' && tail && <div className="mt-1.5 max-h-14 overflow-hidden font-mono text-[10px] break-all whitespace-pre-wrap text-faint">{tail}</div>}
    </div>
  )
}

// ───────────── footer popovers ─────────────

interface ModeDef {
  key: 'auto' | 'ask' | 'plan'
  label: string
  hint: string
  patch: Partial<AiChatSettings>
}
const MODES: ModeDef[] = [
  { key: 'auto', label: 'Авто', hint: 'Агент сразу меняет план, отмена — Ctrl+Z', patch: { permission: 'auto', planMode: false } },
  { key: 'ask', label: 'Вручную', hint: 'Подтверждать каждое изменение плана', patch: { permission: 'ask', planMode: false } },
  { key: 'plan', label: 'План', hint: 'Сначала черновик изменений, применяете вы', patch: { planMode: true } },
]
const modeOf = (s: AiChatSettings): ModeDef['key'] => (s.planMode ? 'plan' : s.permission === 'ask' ? 'ask' : 'auto')

function ModeButton() {
  const settings = useAi((s) => s.settings)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const cur = modeOf(settings)
  const pick = (i: number) => {
    updateSettings(MODES[i].patch)
    setOpen(false)
  }
  useDigitKeys(open, MODES.length, pick)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cn('flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-text', open && 'bg-hover text-text', cur === 'plan' && 'text-accent')}
        onClick={() => setOpen((o) => !o)}
        title={t('Режим')}
      >
        {t(MODES.find((m) => m.key === cur)?.label ?? '')}
        <ChevronDown size={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={270} aria-label={t('Режим')}>
        <div className="p-1">
          <div className="px-2 pt-1 pb-1 text-[11px] text-muted">{t('Режим')}</div>
          {MODES.map((m, i) => (
            <button key={m.key} type="button" className={rowBtn} onClick={() => pick(i)}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t(m.label)}</span>
                <span className="block text-[10.5px] text-muted">{t(m.hint)}</span>
              </span>
              {m.key === cur && <Check size={13} className="shrink-0 text-accent" />}
              <span className="w-3 shrink-0 text-right text-[10px] text-faint">{i + 1}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

/** a row that opens a side flyout (hover or click) */
function FlyoutRow({ label, value, open, setOpen, children, width = 240 }: { label: string; value?: string; open: boolean; setOpen(v: boolean): void; children: ReactNode; width?: number }) {
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchor} type="button" className={cn(rowBtn, open && 'bg-hover')} onClick={() => setOpen(!open)} onMouseEnter={() => setOpen(true)}>
        <span className="flex-1">{label}</span>
        {value && <span className="max-w-[110px] truncate text-muted">{value}</span>}
        <ChevronRight size={12} className="shrink-0 text-muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor as RefObject<HTMLElement | null>} placement="left-start" width={width}>
        <div className="p-1">{children}</div>
      </Popover>
    </>
  )
}

function ProviderList({ onPicked }: { onPicked(): void }) {
  const providers = useAi((s) => s.providers)
  const current = useAi((s) => s.settings.provider)
  const running = useAi((s) => !!s.running)
  return (
    <>
      {providers.map((p) => (
        <div key={p.id} className="flex items-center gap-1">
          <button
            type="button"
            disabled={!p.available || running}
            className={rowBtn}
            onClick={() => {
              updateSettings({ provider: p.id })
              onPicked()
            }}
            title={p.available ? p.version : tAi(p.reason)}
          >
            <span className="min-w-0 flex-1">
              <span className="block">{p.label}</span>
              <span className={cn('block truncate text-[10.5px]', p.auth === 'required' ? 'text-warning' : 'text-muted')}>
                {!p.available ? tAi(p.reason) || t('недоступен') : p.auth === 'required' ? t('нужен вход') : p.account ?? p.version ?? ''}
              </span>
            </span>
            {p.id === current && <Check size={13} className="shrink-0 text-accent" />}
          </button>
          {p.available && p.canLogin && (
            <button type="button" className="mr-1 shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-hover hover:text-text" onClick={() => void startLogin(p.id)}>
              {p.auth === 'required' ? t('Войти') : t('Перевойти')}
            </button>
          )}
        </div>
      ))}
      <div className="my-1 border-t border-border" />
      <button type="button" className={rowBtn} onClick={() => void refreshProviders(true)}>
        <RefreshCw size={12} className="text-muted" /> {t('Проверить снова')}
      </button>
    </>
  )
}

function modelLabel(prov: AiProviderInfo | undefined, id: string | undefined): string {
  if (!prov) return '—'
  if (!id) return prov.label
  // chats saved with the CLI's aliases ('opus') still show the versioned name
  const label = (prov.models.find((m) => m.id === id) ?? prov.models.find((m) => m.id && m.id.includes(`-${id}-`)))?.label
  return label ? tAi(label) : id
}

function ModelButton() {
  const settings = useAi((s) => s.settings)
  const prov = useAi((s) => s.providers.find((p) => p.id === s.settings.provider))
  const running = useAi((s) => !!s.running)
  const [open, setOpen] = useState(false)
  const [fly, setFly] = useState<'effort' | 'provider' | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const models = prov?.models ?? []
  const modelId = settings.models[settings.provider] ?? ''
  const close = () => {
    setOpen(false)
    setFly(null)
  }
  const pick = (i: number) => {
    if (running) return
    updateSettings({ models: { [settings.provider]: models[i].id } })
    close()
  }
  useDigitKeys(open && !fly, models.length, pick)
  const effort = prov?.efforts.length ? settings.effort : ''
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cn('flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-text', open && 'bg-hover text-text')}
        onClick={() => (open ? close() : setOpen(true))}
        title={t('Модель и провайдер')}
      >
        {prov?.auth === 'required' && <KeyRound size={11} className="shrink-0 text-warning" />}
        <span className="truncate">{modelLabel(prov, modelId)}</span>
        {effort && <span className="shrink-0 text-faint">{t(EFFORT_LABEL[effort])}</span>}
        {settings.ultracode && settings.provider === 'claude' && <Zap size={11} className="shrink-0 text-accent" />}
        <ChevronDown size={11} className="shrink-0" />
      </button>
      <Popover open={open} onClose={close} anchorRef={anchor} width={250} placement="bottom-end" aria-label={t('Модель')}>
        <div className="p-1">
          <div className="px-2 pt-1 pb-1 text-[11px] text-muted">{prov?.label ?? t('Модель')}</div>
          {models.map((m, i) => (
            <button key={m.id || '_'} type="button" disabled={running} className={rowBtn} onClick={() => pick(i)} onMouseEnter={() => setFly(null)}>
              <span className="flex-1">{tAi(m.label)}</span>
              {(m.id === modelId || (!!modelId && !!m.id && m.id.includes(`-${modelId}-`))) && <Check size={13} className="shrink-0 text-accent" />}
              {i < 9 && <span className="w-3 shrink-0 text-right text-[10px] text-faint">{i + 1}</span>}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          {prov && prov.efforts.length > 0 && (
            <FlyoutRow label={t('Уровень усилий')} value={t(EFFORT_LABEL[settings.effort] ?? '')} open={fly === 'effort'} setOpen={(v) => setFly(v ? 'effort' : null)} width={250}>
              <div className="px-2 pt-1 pb-1 text-[11px] text-muted">{t('Уровень усилий')}</div>
              {(['', ...prov.efforts] as Effort[]).map((e) => (
                <button
                  key={e || '_'}
                  type="button"
                  className={rowBtn}
                  onClick={() => {
                    updateSettings({ effort: e })
                    close()
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block">{EFFORT_LABEL[e] ? t(EFFORT_LABEL[e]) : e}</span>
                    <span className="block text-[10.5px] text-muted">{EFFORT_HINT[e] ? t(EFFORT_HINT[e]) : ''}</span>
                  </span>
                  {e === settings.effort && <Check size={13} className="shrink-0 text-accent" />}
                </button>
              ))}
            </FlyoutRow>
          )}
          <FlyoutRow label={t('Провайдер')} value={prov?.label} open={fly === 'provider'} setOpen={(v) => setFly(v ? 'provider' : null)} width={270}>
            <ProviderList onPicked={close} />
          </FlyoutRow>
          {settings.provider === 'claude' && (
            <button type="button" className={rowBtn} onClick={() => updateSettings({ ultracode: !settings.ultracode })} onMouseEnter={() => setFly(null)}>
              <Zap size={12} className={settings.ultracode ? 'text-accent' : 'text-muted'} />
              <span className="min-w-0 flex-1">
                <span className="block">{t('Ультракод')}</span>
                <span className="block text-[10.5px] text-muted">{t('Мультиагентный режим для больших задач')}</span>
              </span>
              {settings.ultracode && <Check size={13} className="shrink-0 text-accent" />}
            </button>
          )}
        </div>
      </Popover>
    </>
  )
}

/** token usage ring: last request's context and the chat totals */
function ContextButton() {
  const chat = useAi((s) => s.chat)
  const prov = useAi((s) => s.providers.find((p) => p.id === s.settings.provider))
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const last = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.usage?.inputTokens)
  const ctx = last?.usage?.inputTokens ?? 0
  const totals = chat.totals
  // context windows differ per model and are not reported by the CLIs: the ring only marks that
  // the chat has context, exact numbers are in the popover
  const r = 6
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={t('Использование контекста')}
        title={t('Использование контекста')}
        className={cn('flex items-center gap-1 rounded-md px-1 py-1 text-[10.5px] text-faint hover:bg-hover hover:text-text', open && 'bg-hover')}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2" />
          {ctx > 0 && <circle cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray={`${2 * Math.PI * r * 0.25} 100`} strokeLinecap="round" />}
        </svg>
        {ctx > 0 && fmtTok(ctx)}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={240} placement="bottom-end" aria-label={t('Контекст')}>
        <div className="space-y-1.5 p-3 text-[11.5px]">
          <div className="font-medium">{t('Контекст')}</div>
          <Row k={t('Последний запрос')} v={ctx ? t('{n} токенов', { n: fmtTok(ctx) }) : '—'} />
          <div className="border-t border-border pt-1.5 font-medium">{t('Этот чат')}</div>
          <Row k={t('Входящие')} v={totals ? fmtTok(totals.inputTokens) : '—'} />
          <Row k={t('Ответы')} v={totals ? fmtTok(totals.outputTokens) : '—'} />
          {prov?.reportsCost && <Row k={t('Стоимость')} v={totals?.costUsd ? fmtUsd(totals.costUsd) : '—'} />}
          <div className="pt-1 text-[10.5px] text-faint">{t('Сообщений: {n}. Новый чат начинает контекст заново.', { n: chat.messages.length })}</div>
        </div>
      </Popover>
    </>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  )
}

// ───────────── draft (plan mode) ─────────────

function DraftBar() {
  const count = useAi((s) => s.draftCount)
  const changes = useAi((s) => s.draftChanges)
  const running = useAi((s) => !!s.running)
  const [msg, setMsg] = useState('')
  if (!count) return msg ? <div className="mx-2 mb-1.5 px-1 text-[11px] text-muted">{msg}</div> : null
  return (
    <div className="mx-2 mb-1.5 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Sparkles size={12} className="text-accent" /> {plural(count, 'Черновик: {n} изменение', 'Черновик: {n} изменения', 'Черновик: {n} изменений')}
      </div>
      <ul className="mb-1.5 max-h-24 overflow-y-auto text-[11px] text-muted">
        {changes.slice(-12).map((c, i) => (
          <li key={i} className="truncate">
            • {c}
          </li>
        ))}
      </ul>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={running}
          className="rounded-md bg-accent px-2.5 py-0.5 text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          onClick={() => {
            const r = applyDraft()
            setMsg(!r ? '' : t(r.ok ? (r.stale ? 'Применено (план менялся во время работы агента — проверьте результат).' : 'Изменения применены. Отменить — Ctrl+Z.') : 'Не удалось применить: документ сильно изменился.'))
          }}
        >
          {t('Применить')}
        </button>
        <button type="button" disabled={running} className="rounded-md border border-border px-2.5 py-0.5 hover:bg-hover disabled:opacity-50" onClick={() => discardDraft()}>
          {t('Отклонить')}
        </button>
      </div>
    </div>
  )
}

// ───────────── composer ─────────────

function PlusMenu({ onQuick }: { onQuick(cmd: string): void }) {
  const prov = useAi((s) => s.providers.find((p) => p.id === s.settings.provider))
  const hasUnderlay = useDoc((s) => Object.keys(s.doc.underlays).length > 0)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const canImg = prov ? prov.images : true
  return (
    <>
      <input
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void addImageFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <button
        ref={anchor}
        type="button"
        aria-label={t('Добавить')}
        title={t('Добавить')}
        className={cn('rounded-lg p-1 text-muted hover:bg-hover hover:text-text', open && 'bg-hover text-text')}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={16} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={250} aria-label={t('Добавить')}>
        <div className="p-1">
          <button
            type="button"
            disabled={!canImg}
            className={rowBtn}
            onClick={() => {
              setOpen(false)
              file.current?.click()
            }}
          >
            <Paperclip size={13} className="text-muted" /> {t('Приложить изображение')}
          </button>
          <button
            type="button"
            disabled={!canImg || !hasUnderlay}
            className={rowBtn}
            onClick={() => {
              setOpen(false)
              void addUnderlayImage()
            }}
          >
            <ImageIcon size={13} className="text-muted" /> {t('Приложить подложку плана')}
          </button>
          <div className="my-1 border-t border-border" />
          <div className="px-2 pt-0.5 pb-1 text-[11px] text-muted">{t('Быстрые команды')}</div>
          {QUICK_ACTIONS.map((q) => (
            <button
              key={q.cmd}
              type="button"
              className={rowBtn}
              onClick={() => {
                setOpen(false)
                onQuick(quickCmd(q))
              }}
            >
              <span className="flex-1">{t(q.label)}</span>
              <span className="font-mono text-[10px] text-faint">{quickCmd(q)}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

function Composer() {
  const chips = useAi((s) => s.chips)
  const images = useAi((s) => s.images)
  const quotes = useAi((s) => s.quotes)
  const running = useAi((s) => !!s.running)
  const asking = useAi((s) => (s.running ? s.asking : null))
  const focusTick = useAi((s) => s.focusTick)
  const [text, setText] = useState('')
  const [marking, setMarking] = useState<number | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (focusTick) ta.current?.focus()
  }, [focusTick])

  // a note from the mini field next to a mark on a chat picture: append it (and send right away if asked)
  const insert = useAi((s) => s.composeInsert)
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    if (!insert) return
    consumeInsert()
    const cur = textRef.current.replace(/\s+$/, '')
    const next = cur ? `${cur}\n${insert.text}` : insert.text
    if (insert.send && !running) {
      setText('')
      void send(next)
    } else setText(next)
  }, [insert, running])

  // auto-grow up to ~10 lines
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(200, el.scrollHeight)}px`
  }, [text])

  const slash = text.startsWith('/') && !text.includes('\n') ? QUICK_ACTIONS.filter((q) => text.trim() === '/' || [quickCmd(q), q.cmd].some((c) => c.toLowerCase().startsWith(text.trim().toLowerCase()))) : []
  // a question is open: what is sent answers it (the text, the options picked on the card)
  const answering = !!asking
  const canSend = answering ? hasAnswer(asking, text, chips.length > 0 || images.length > 0 || quotes.length > 0) : !running && (!!text.trim() || images.length > 0 || quotes.length > 0)

  const submit = () => {
    if (!canSend) return
    const v = text
    setText('')
    void send(v)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (slash.length === 1 && text.trim() !== slash[0].cmd) setText(slash[0].cmd + ' ')
      else submit()
    }
    // the keyboard comes back here after each plan mark: Esc still ends marking
    if (e.key === 'Escape' && !slash.length && uiStore.getState().tool === 'pencil') activateTool('select', t)
    e.stopPropagation() // editor shortcuts must not fire while typing
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      e.preventDefault()
      void addImageFiles(files)
    }
  }

  return (
    <div className="relative mx-2">
      {marking !== null && images[marking] && (
        <ImageMarkup
          image={images[marking]}
          onClose={() => {
            setMarking(null)
            ta.current?.focus()
          }}
          onChange={(img) => replaceImage(marking, img)}
        />
      )}
      {slash.length > 0 && (
        <div className="absolute inset-x-0 bottom-full mb-1 rounded-xl border border-border-strong bg-panel p-1 shadow-pop">
          {slash.map((q) => (
            <button key={q.cmd} type="button" className={rowBtn} onClick={() => setText(quickCmd(q) + ' ')}>
              <span className="font-mono text-accent">{quickCmd(q)}</span>
              <span className="text-muted">{t(q.label)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="rounded-2xl border border-border-strong bg-input shadow-sm focus-within:border-[color-mix(in_srgb,var(--accent)_60%,var(--border-strong))]">
        {quotes.length > 0 && (
          <div className="flex flex-col gap-1.5 px-2.5 pt-2.5">
            {quotes.map((q) => (
              <QuoteBlock key={q.id} text={q.text}>
                <button type="button" aria-label={t('Убрать')} className="shrink-0 text-muted hover:text-text" onClick={() => removeQuote(q.id)}>
                  <X size={11} />
                </button>
              </QuoteBlock>
            ))}
          </div>
        )}
        {(chips.length > 0 || images.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
            {images.map((im, i) => (
              <span key={i} className="group relative">
                <button type="button" title={t('Нарисовать пометки на картинке')} className="block" onClick={() => setMarking(i)}>
                  <img src={im.url} alt="" className="h-12 w-12 rounded-lg border border-border object-cover" />
                  <span
                    className={cn(
                      'absolute right-0.5 bottom-0.5 rounded bg-panel/90 p-0.5',
                      im.markup?.shapes.length ? 'text-danger' : 'hidden text-muted group-hover:block',
                    )}
                  >
                    <Pencil size={10} />
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t('Убрать')}
                  className="absolute -top-1.5 -right-1.5 hidden rounded-full border border-border bg-panel p-0.5 text-muted group-hover:block hover:text-text"
                  onClick={() => removeImage(i)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {chips.map((c) => (
              <span key={c.id} className="flex h-6 max-w-full items-center gap-1 self-end rounded-md border border-border bg-panel-2 pr-1 pl-1.5 text-[11px]" title={c.summary}>
                <span className="truncate">{t(c.label)}</span>
                <button type="button" aria-label={t('Убрать')} className="text-muted hover:text-text" onClick={() => removeChip(c.id)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          data-ai-input
          value={text}
          rows={1}
          placeholder={answering ? t('Ответ своими словами…') : t('Что изменить в плане?')}
          className="block max-h-[200px] min-h-[38px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[12.5px] leading-relaxed outline-none placeholder:text-faint"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <PlusMenu onQuick={(cmd) => setText(cmd + ' ')} />
          <MarkButton />
          <span className="min-w-0 flex-1 truncate px-1 text-[10px] text-faint">{t('«/» — команды, Ctrl+L — выделенное')}</span>
          {running && !(answering && canSend) ? (
            <button type="button" aria-label={t('Стоп')} title={t('Остановить')} className="flex h-7 w-7 items-center justify-center rounded-lg bg-text text-panel hover:opacity-85" onClick={() => stop()}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={answering ? t('Ответить') : t('Отправить')}
              title={answering ? t('Ответить (Enter)') : t('Отправить (Enter)')}
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-panel-3 disabled:text-faint"
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ───────────── panel ─────────────

function EmptyState() {
  return (
    <div className="mt-10 px-4 text-center">
      <Sparkles size={22} className="mx-auto mb-2 text-accent" />
      <div className="mb-1 text-[13px] font-medium">{t('Чем помочь с планом?')}</div>
      <div className="text-[11.5px] text-muted">{t('«добавь стену от n_… до n_…», «поставь холодильник на кухне». Правки видны сразу и отменяются Ctrl+Z.')}</div>
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        {QUICK_ACTIONS.map((q) => (
          <button key={q.cmd} type="button" className="rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-hover" onClick={() => void send(quickCmd(q))}>
            {t(q.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ChatPanel({ className }: { className?: string }) {
  const chat = useAi((s) => s.chat)
  const running = useAi((s) => s.running)
  const status = useAi((s) => s.status)
  const prov = useAi((s) => s.providers.find((p) => p.id === s.settings.provider))
  const lang = useUi((s) => s.lang)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.messages])

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} lang={lang}>
      <ChatHeader />
      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {!chat.messages.length && <EmptyState />}
        {chat.messages.map((m) => (
          <Message key={m.id} m={m} live={!!running && running.msgId === m.id} />
        ))}
      </div>
      <QuoteButton root={scroller} />
      {prov && !prov.available && (
        <div className="mx-2 mb-1.5 flex items-center gap-1.5 rounded-xl border border-border bg-panel-2 px-3 py-1.5 text-[11px] text-warning">
          <TriangleAlert size={12} className="shrink-0" /> <span className="min-w-0 flex-1">{tAi(prov.reason)}</span>
          <button type="button" title={t('Проверить снова')} className="text-muted hover:text-text" onClick={() => void refreshProviders(true)}>
            <RefreshCw size={12} />
          </button>
        </div>
      )}
      {running && status && <div className="mx-3 mb-1 truncate text-[10.5px] text-faint">{tAi(status)}</div>}
      <LoginCard prov={prov} />
      <DraftBar />
      <QuestionCard />
      <Composer />
      <div className="flex items-center gap-0.5 px-2 pt-0.5 pb-1.5">
        <ModeButton />
        <div className="flex-1" />
        <ModelButton />
        <ContextButton />
      </div>
    </div>
  )
}
