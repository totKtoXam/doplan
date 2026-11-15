import clsx from 'clsx'
import { Check, Info, TriangleExclamationPoint, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@/i18n'
import { dismissToast, type ModalRequest, useNotify } from '@/store/notify'
import { TextBtn } from './primitives'
import { UpdateNotice } from './UpdateNotice'

function Modal({ req }: { req: ModalRequest }) {
  const t = useT()
  const [value, setValue] = useState(req.input?.value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const primary = req.buttons.find((b) => b.variant === 'primary') ?? req.buttons[req.buttons.length - 1]
  const cancel = req.buttons.find((b) => b.id === 'cancel')

  useEffect(() => {
    if (req.input) {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      primaryRef.current?.focus()
    }
  }, [req.input])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        req.resolve({ button: cancel?.id ?? 'cancel', value })
      } else if (e.key === 'Enter' && req.input) {
        e.preventDefault()
        e.stopPropagation()
        req.resolve({ button: primary?.id ?? 'ok', value })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, value, cancel, primary])

  return (
    // above the kit Dialog layer (z-1000): a question asked while a dialog is open (unsaved AGENTS.md on window close) must be visible
    <div className="fixed inset-0 z-[1050] flex items-center justify-center bg-black/45 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <div role="dialog" aria-modal="true" aria-label={req.title} className="dp-fade-in w-full max-w-[460px] rounded-xl border border-border-strong bg-panel shadow-pop">
        <div className="px-5 pt-4 pb-2 text-sm font-semibold">{req.title}</div>
        {req.message && <div className="px-5 pb-2 text-xs leading-relaxed whitespace-pre-line text-muted">{req.message}</div>}
        {req.details && req.details.length > 0 && (
          <div className="mx-5 mb-2 max-h-56 overflow-auto rounded-md border border-border bg-input p-2 font-mono text-[11px] leading-relaxed text-text select-text">
            {req.details.map((d, i) => (
              <div key={i} className="break-words">
                • {d}
              </div>
            ))}
          </div>
        )}
        {req.input && (
          <div className="px-5 pb-2">
            <input
              ref={inputRef}
              value={value}
              placeholder={req.input.placeholder}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-input px-2.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
        )}
        <div className="flex justify-end gap-2 px-5 pt-2 pb-4">
          {req.buttons.map((b) => (
            <TextBtn
              key={b.id}
              ref={b === primary ? primaryRef : undefined}
              variant={b.variant === 'primary' ? 'primary' : b.variant === 'danger' ? 'danger' : 'default'}
              onClick={() => req.resolve({ button: b.id, value })}
            >
              {t(b.label)}
            </TextBtn>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Overlays() {
  const toasts = useNotify((s) => s.toasts)
  const modals = useNotify((s) => s.modals)
  const top = modals[0]
  return createPortal(
    <>
      <div className="pointer-events-none fixed right-3 bottom-9 z-[960] flex w-[340px] flex-col items-end gap-2">
        <UpdateNotice />
        {toasts.map((tst) => (
          <div
            key={tst.id}
            className={clsx(
              'dp-fade-in pointer-events-auto flex max-w-full items-start gap-2 rounded-lg border bg-panel px-3 py-2 text-xs shadow-pop',
              tst.kind === 'error' ? 'border-danger/60' : tst.kind === 'warning' ? 'border-warning/60' : tst.kind === 'success' ? 'border-success/50' : 'border-border-strong',
            )}
          >
            <span className="mt-px shrink-0">
              {tst.kind === 'success' ? (
                <Check size={14} className="text-success" />
              ) : tst.kind === 'info' ? (
                <Info size={14} className="text-accent" />
              ) : (
                <TriangleExclamationPoint size={14} className={tst.kind === 'error' ? 'text-danger' : 'text-warning'} />
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
              <span className="break-words">{tst.text}</span>
              {tst.action && (
                <button
                  type="button"
                  className="-ml-1.5 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
                  onClick={() => {
                    tst.action?.run()
                    dismissToast(tst.id)
                  }}
                >
                  {tst.action.label}
                </button>
              )}
            </span>
            <button type="button" className="shrink-0 text-muted hover:text-text" onClick={() => dismissToast(tst.id)} aria-label="close">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      {top && <Modal key={top.id} req={top} />}
    </>,
    document.body,
  )
}
