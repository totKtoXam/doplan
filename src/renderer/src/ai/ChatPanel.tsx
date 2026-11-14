/**
 * The «ИИ» tab of the right dock: chat with an agent that edits the open plan through doc tools.
 */
import {
  Ban,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  History,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  SendHorizontal,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react'
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { AiMessage, AiPart, AiProviderId } from '@shared/aiChat'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { cn, Select, Toggle } from '@/ui/kit'
import {
  addImageFiles,
  aiStore,
  addUnderlayImage,
  answerApproval,
  applyDraft,
  discardDraft,
  newChat,
  openChat,
  QUICK_ACTIONS,
  refreshProviders,
  removeChat,
  removeChip,
  removeImage,
  send,
  stop,
  updateSettings,
  useAi,
} from './store'

const EFFORT_LABEL: Record<string, string> = { '': 'Обычное', low: 'Низкое', medium: 'Среднее', high: 'Высокое', xhigh: 'Очень высокое', max: 'Максимум' }

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function Usage({ u }: { u?: AiMessage['usage'] }) {
  if (!u || (!u.inputTokens && !u.outputTokens && !u.costUsd)) return null
  return (
    <div className="mt-1 text-[10px] text-faint">
      {u.inputTokens ? `↑${fmtTok(u.inputTokens)} ` : ''}
      {u.outputTokens ? `↓${fmtTok(u.outputTokens)} ` : ''}
      {u.costUsd ? `· $${u.costUsd.toFixed(u.costUsd < 0.1 ? 4 : 2)}` : ''}
    </div>
  )
}

/** minimal inline markdown: `code`, **bold**; blocks keep line breaks */
function RichText({ text }: { text: string }) {
  const nodes = useMemo(() => {
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
          <strong key={k++}>{s.slice(2, -2)}</strong>
        ),
      )
      last = m.index + s.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }, [text])
  return <div className="text-xs leading-relaxed break-words whitespace-pre-wrap select-text">{nodes}</div>
}

function StatusIcon({ status }: { status: Extract<AiPart, { type: 'tool' }>['status'] }) {
  switch (status) {
    case 'running':
      return <LoaderCircle size={12} className="dp-spin text-accent" />
    case 'pending':
      return <CircleAlert size={12} className="text-warning" />
    case 'done':
      return <Check size={12} className="text-[#3fb950]" />
    case 'proposed':
      return <Sparkles size={12} className="text-accent" />
    case 'rejected':
      return <Ban size={12} className="text-muted" />
    case 'error':
      return <X size={12} className="text-[#ff8589]" />
  }
}

function ToolCard({ part, live }: { part: Extract<AiPart, { type: 'tool' }>; live: boolean }) {
  const [open, setOpen] = useState(false)
  const doc = part.origin === 'doc'
  const pending = part.status === 'pending' && live
  const statusText = { running: 'выполняется', pending: 'ждёт подтверждения', done: '', error: 'ошибка', rejected: 'отклонено', proposed: 'в черновике' }[part.status]
  return (
    <div className={cn('my-1 rounded-md border text-[11px]', pending ? 'border-warning/60 bg-warning/5' : 'border-border bg-[color-mix(in_srgb,var(--text)_4%,transparent)]')}>
      <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1 text-left" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />}
        {doc ? <Sparkles size={12} className="text-accent" /> : <Wrench size={12} className="text-muted" />}
        <span className="min-w-0 flex-1 truncate font-medium">{part.title}</span>
        {statusText && <span className="text-[10px] text-muted">{statusText}</span>}
        <StatusIcon status={part.status} />
      </button>
      {part.changes && part.changes.length > 0 && (
        <ul className="px-2 pb-1 text-[11px] text-text">
          {part.changes.map((c, i) => (
            <li key={i} className="truncate" title={c}>
              • {c}
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <div className="flex items-center gap-1.5 px-2 pb-1.5">
          <span className="min-w-0 flex-1 truncate text-muted" title={part.result}>
            {part.result}
          </span>
          <button type="button" className="rounded bg-accent px-2 py-0.5 text-white hover:brightness-110" onClick={() => answerApproval(part.id, true)}>
            Применить
          </button>
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:border-accent" onClick={() => answerApproval(part.id, false)}>
            Отклонить
          </button>
        </div>
      )}
      {part.image && <img src={part.image} alt="" className="mx-2 mb-1.5 max-h-40 rounded border border-border" />}
      {open && (
        <div className="border-t border-border px-2 py-1 font-mono text-[10px] break-words whitespace-pre-wrap text-muted select-text">
          {part.args !== undefined && <div className="mb-1">{JSON.stringify(part.args)}</div>}
          {part.result && !pending && <div className="max-h-48 overflow-auto text-text">{part.result}</div>}
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 text-[11px] text-muted">
      <button type="button" className="flex items-center gap-1 hover:text-text" onClick={() => setOpen((o) => !o)}>
        <Brain size={12} /> Размышления {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
      {open && <div className="mt-1 border-l border-border pl-2 whitespace-pre-wrap select-text">{text}</div>}
    </div>
  )
}

function Notice({ level, text }: { level: 'info' | 'warning' | 'error'; text: string }) {
  const Icon = level === 'error' ? CircleAlert : level === 'warning' ? TriangleAlert : Info
  return (
    <div className={cn('my-1 flex items-start gap-1.5 rounded px-2 py-1 text-[11px]', level === 'error' ? 'bg-[#e5484d1f] text-[#ff8589]' : level === 'warning' ? 'bg-warning/10 text-warning' : 'text-muted')}>
      <Icon size={12} className="mt-0.5 shrink-0" />
      <span className="break-words whitespace-pre-wrap select-text">{text}</span>
    </div>
  )
}

function Message({ m, live }: { m: AiMessage; live: boolean }) {
  if (m.role === 'user') {
    const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <div className="ml-6 rounded-lg bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-2.5 py-1.5">
        {m.chips && (
          <div className="mb-1 flex flex-wrap gap-1">
            {m.chips.map((c) => (
              <span key={c.id} className="rounded bg-[color-mix(in_srgb,var(--text)_10%,transparent)] px-1.5 text-[10px] text-muted" title={c.summary}>
                {c.label}
              </span>
            ))}
          </div>
        )}
        {m.images && (
          <div className="mb-1 flex flex-wrap gap-1">
            {m.images.filter(Boolean).map((src, i) => (
              <img key={i} src={src} alt="" className="h-12 rounded border border-border" />
            ))}
          </div>
        )}
        <RichText text={text} />
      </div>
    )
  }
  return (
    <div className="mr-2">
      {m.parts.map((p, i) => {
        switch (p.type) {
          case 'text':
            return <RichText key={i} text={p.text} />
          case 'thinking':
            return <Thinking key={i} text={p.text} />
          case 'tool':
            return <ToolCard key={i} part={p} live={live} />
          case 'notice':
            return <Notice key={i} level={p.level} text={p.text} />
        }
      })}
      {live && !m.parts.length && <LoaderCircle size={14} className="dp-spin my-1 text-accent" />}
      <Usage u={m.usage} />
    </div>
  )
}

function HistoryList() {
  const chats = useAi((s) => s.chats)
  const cur = useAi((s) => s.chat.id)
  return (
    <div className="flex-1 overflow-y-auto p-2">
      <div className="mb-1 px-1 text-[11px] font-medium text-muted">Чаты этого проекта</div>
      {!chats.length && <div className="px-1 text-xs text-faint">Пока нет сохранённых чатов</div>}
      {chats.map((c) => (
        <div key={c.id} className={cn('group flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]', c.id === cur && 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]')}>
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => void openChat(c.id)} title={c.title}>
            {c.title || 'Без названия'}
            <span className="ml-1 text-[10px] text-faint">{new Date(c.updatedAt).toLocaleString()}</span>
          </button>
          <button type="button" className="hidden text-muted group-hover:block hover:text-[#ff8589]" title="Удалить чат" onClick={() => void removeChat(c.id)}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

// the kit Select treats '' as "nothing chosen"; '' here means "provider default"
const DEFAULT_OPT = '_default'
const toOpt = (v: string | undefined) => v || DEFAULT_OPT
const fromOpt = (v: string) => (v === DEFAULT_OPT ? '' : v)

function SettingsBar() {
  const providers = useAi((s) => s.providers)
  const settings = useAi((s) => s.settings)
  const running = useAi((s) => !!s.running)
  const [more, setMore] = useState(false)
  const prov = providers.find((p) => p.id === settings.provider)
  const provOptions = providers.map((p) => ({ value: p.id, label: p.available ? p.label : `${p.label} — недоступен` }))
  return (
    <div className="border-b border-border px-2 py-1.5">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Select<AiProviderId> aria-label="Провайдер" value={settings.provider} options={provOptions} onChange={(v) => updateSettings({ provider: v })} disabled={running} />
        </div>
        {prov && prov.models.length > 1 && (
          <div className="w-[104px] shrink-0">
            <Select
              aria-label="Модель"
              value={toOpt(settings.models[settings.provider])}
              options={prov.models.map((m) => ({ value: toOpt(m.id), label: m.label }))}
              onChange={(v) => updateSettings({ models: { [settings.provider]: fromOpt(v) } })}
              disabled={running}
            />
          </div>
        )}
        <button type="button" title="Параметры агента" className={cn('rounded p-1 text-muted hover:text-text', more && 'text-accent')} onClick={() => setMore((m) => !m)}>
          <SlidersHorizontal size={14} />
        </button>
      </div>
      {prov && !prov.available && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-warning">
          <TriangleAlert size={12} /> <span className="flex-1">{prov.reason}</span>
          <button type="button" title="Проверить снова" className="text-muted hover:text-text" onClick={() => void refreshProviders(true)}>
            <RefreshCw size={12} />
          </button>
        </div>
      )}
      {more && (
        <div className="mt-1.5 flex flex-col gap-1.5 text-xs">
          {prov && prov.efforts.length > 0 && (
            <label className="flex items-center gap-2">
              <span className="w-24 text-muted">Глубина</span>
              <Select
                aria-label="Глубина размышлений"
                className="flex-1"
                value={toOpt(settings.effort)}
                options={['', ...prov.efforts].map((e) => ({ value: toOpt(e), label: EFFORT_LABEL[e] ?? e }))}
                onChange={(v) => updateSettings({ effort: fromOpt(v) as typeof settings.effort })}
              />
            </label>
          )}
          <Toggle size="sm" checked={settings.permission === 'ask'} onChange={(v) => updateSettings({ permission: v ? 'ask' : 'auto' })} label="Подтверждать каждое изменение" />
          <Toggle size="sm" checked={settings.planMode} onChange={(v) => updateSettings({ planMode: v })} label="Режим плана (сначала предложить)" />
          {settings.provider === 'claude' && (
            <Toggle size="sm" checked={settings.ultracode} onChange={(v) => updateSettings({ ultracode: v })} label="Ультракод (мультиагентный режим)" />
          )}
          {prov?.version && <div className="text-[10px] text-faint">{prov.version}</div>}
        </div>
      )}
    </div>
  )
}

function DraftBar() {
  const count = useAi((s) => s.draftCount)
  const changes = useAi((s) => s.draftChanges)
  const running = useAi((s) => !!s.running)
  const [msg, setMsg] = useState('')
  if (!count) return msg ? <div className="border-t border-border px-2 py-1 text-[11px] text-muted">{msg}</div> : null
  return (
    <div className="border-t border-border bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-2 py-1.5 text-xs">
      <div className="mb-1 flex items-center gap-1 font-medium">
        <Sparkles size={12} className="text-accent" /> Предложено изменений: {count}
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
          className="rounded bg-accent px-2 py-0.5 text-white hover:brightness-110 disabled:opacity-50"
          onClick={() => {
            const r = applyDraft()
            setMsg(!r ? '' : r.ok ? (r.stale ? 'Применено (план менялся во время работы агента — проверьте результат).' : 'Изменения применены. Отменить — Ctrl+Z.') : 'Не удалось применить: документ сильно изменился.')
          }}
        >
          Применить
        </button>
        <button type="button" disabled={running} className="rounded border border-border px-2 py-0.5 hover:border-accent disabled:opacity-50" onClick={() => discardDraft()}>
          Отменить
        </button>
      </div>
    </div>
  )
}

function Composer() {
  const chips = useAi((s) => s.chips)
  const images = useAi((s) => s.images)
  const running = useAi((s) => !!s.running)
  const focusTick = useAi((s) => s.focusTick)
  const prov = useAi((s) => s.providers.find((p) => p.id === s.settings.provider))
  const hasUnderlay = useDoc((s) => Object.keys(s.doc.underlays).length > 0)
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusTick) ta.current?.focus()
  }, [focusTick])

  const slash = text.startsWith('/') && !text.includes('\n') ? QUICK_ACTIONS.filter((q) => q.cmd.startsWith(text.trim().toLowerCase()) || text.trim() === '/') : []

  const submit = () => {
    if (running) return
    const v = text
    if (!v.trim() && !images.length) return
    setText('')
    void send(v)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (slash.length === 1 && text.trim() !== slash[0].cmd) setText(slash[0].cmd + ' ')
      else submit()
    }
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
    <div className="relative border-t border-border p-2">
      {slash.length > 0 && (
        <div className="absolute inset-x-2 bottom-full mb-1 rounded-md border border-border-strong bg-panel py-1 shadow-pop">
          {slash.map((q) => (
            <button key={q.cmd} type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)]" onClick={() => setText(q.cmd + ' ')}>
              <span className="font-mono text-accent">{q.cmd}</span>
              <span className="text-muted">{q.label}</span>
            </button>
          ))}
        </div>
      )}
      {(chips.length > 0 || images.length > 0) && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c.id} className="flex max-w-full items-center gap-1 rounded bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] py-0.5 pr-1 pl-1.5 text-[11px]" title={c.summary}>
              <span className="truncate">{c.label}</span>
              <button type="button" aria-label="Убрать" className="text-muted hover:text-text" onClick={() => removeChip(c.id)}>
                <X size={11} />
              </button>
            </span>
          ))}
          {images.map((im, i) => (
            <span key={i} className="relative">
              <img src={im.url} alt="" className="h-10 rounded border border-border" />
              <button type="button" aria-label="Убрать" className="absolute -top-1 -right-1 rounded-full bg-panel text-muted hover:text-text" onClick={() => removeImage(i)}>
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
        rows={3}
        placeholder="Что изменить в плане? «/» — быстрые команды, Ctrl+L — добавить выделенное"
        className="w-full resize-none rounded-md border border-border bg-[color-mix(in_srgb,var(--text)_5%,transparent)] px-2 py-1.5 text-xs outline-none focus:border-accent"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
      />
      <div className="mt-1 flex items-center gap-1">
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
        <button type="button" title="Приложить изображение" disabled={prov ? !prov.images : false} className="rounded p-1 text-muted hover:text-text disabled:opacity-40" onClick={() => file.current?.click()}>
          <Paperclip size={14} />
        </button>
        {hasUnderlay && (
          <button type="button" title="Приложить подложку плана" className="rounded p-1 text-muted hover:text-text" onClick={() => void addUnderlayImage()}>
            <ImageIcon size={14} />
          </button>
        )}
        <div className="flex-1" />
        {running ? (
          <button type="button" className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:border-[#e5484d]" onClick={() => stop()}>
            <Square size={11} /> Стоп
          </button>
        ) : (
          <button type="button" className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-xs text-white hover:brightness-110 disabled:opacity-50" disabled={!text.trim() && !images.length} onClick={submit}>
            <SendHorizontal size={12} /> Отправить
          </button>
        )}
      </div>
    </div>
  )
}

export function ChatPanel({ className }: { className?: string }) {
  const chat = useAi((s) => s.chat)
  const running = useAi((s) => s.running)
  const status = useAi((s) => s.status)
  const showHistory = useAi((s) => s.showHistory)
  const lang = useUi((s) => s.lang)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.messages])

  const totals = chat.totals
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} lang={lang}>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={chat.title}>
          {chat.title || 'Новый чат'}
        </span>
        <button type="button" title="История чатов" className={cn('rounded p-1 text-muted hover:text-text', showHistory && 'text-accent')} onClick={() => aiToggleHistory()}>
          <History size={14} />
        </button>
        <button type="button" title="Новый чат" className="rounded p-1 text-muted hover:text-text" onClick={() => newChat()}>
          <MessageSquarePlus size={14} />
        </button>
      </div>
      <SettingsBar />
      {showHistory ? (
        <HistoryList />
      ) : (
        <div
          ref={scroller}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-2"
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {!chat.messages.length && (
            <div className="mt-6 px-3 text-center text-xs text-muted">
              <Sparkles size={20} className="mx-auto mb-2 text-accent" />
              Опишите, что изменить: «добавь стену от n_… до n_…», «поставь холодильник на кухне». Изменения появляются сразу и отменяются Ctrl+Z.
              <div className="mt-3 flex flex-wrap justify-center gap-1">
                {QUICK_ACTIONS.map((q) => (
                  <button key={q.cmd} type="button" className="rounded border border-border px-2 py-0.5 text-[11px] hover:border-accent" onClick={() => void send(q.cmd)}>
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chat.messages.map((m) => (
            <Message key={m.id} m={m} live={!!running && running.msgId === m.id} />
          ))}
        </div>
      )}
      {status && <div className="truncate border-t border-border px-2 py-0.5 text-[10px] text-muted">{status}</div>}
      <DraftBar />
      <Composer />
      {totals && (totals.inputTokens > 0 || totals.costUsd > 0) && (
        <div className="px-2 pb-1 text-right text-[10px] text-faint">
          Всего: ↑{fmtTok(totals.inputTokens)} ↓{fmtTok(totals.outputTokens)}
          {totals.costUsd > 0 ? ` · $${totals.costUsd.toFixed(2)}` : ''}
        </div>
      )}
    </div>
  )
}

function aiToggleHistory(): void {
  aiStore.setState({ showHistory: !aiStore.getState().showHistory })
}
