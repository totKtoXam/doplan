import { RefreshCw, TriangleExclamationPoint } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createEditor2D } from '@/editor2d'
import { useT } from '@/i18n'
import { setHandle } from '@/store/handles'
import type { Editor2DHandle } from '@/contracts'
import { TextBtn } from './primitives'
import { SelectionBar } from './SelectionBar'
import { MeasureChecklist, SurveyPanel } from '@/ui/panels/SurveyPanel'
import { MarksPanel } from '@/ui/panels/MarksPanel' // ai-chat

/** Mounts the PixiJS plan editor into a div and keeps it sized. */
export function Viewport2D({ hidden }: { hidden?: boolean }) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    let handle: Editor2DHandle | null = null
    let ro: ResizeObserver | null = null
    setError(null)
    setLoading(true)
    createEditor2D(el)
      .then((h: Editor2DHandle) => {
        if (disposed) {
          h.destroy()
          return
        }
        handle = h
        setHandle('editor2d', h)
        setLoading(false)
        ro = new ResizeObserver((entries) => {
          const r = entries[0]?.contentRect
          if (r && r.width > 0 && r.height > 0) h.resize()
        })
        ro.observe(el)
        requestAnimationFrame(() => {
          if (!disposed) h.zoomToFit()
        })
      })
      .catch((err: unknown) => {
        if (disposed) return
        console.error('[doplan] 2D editor failed to start', err)
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      disposed = true
      ro?.disconnect()
      if (handle) {
        setHandle('editor2d', null)
        try {
          handle.destroy()
        } catch (err) {
          console.warn('[doplan] editor destroy failed', err)
        }
      }
    }
  }, [attempt])

  return (
    <div className={hidden ? 'hidden' : 'relative min-h-0 min-w-0 flex-1 overflow-hidden bg-viewport'} data-viewport="2d">
      <div ref={host} className="absolute inset-0" />
      {!loading && !error && (
        <>
          <SurveyPanel />
          <MarksPanel />
          <MeasureChecklist />
          <SelectionBar />
        </>
      )}
      {loading && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted">{t('Загрузка редактора…')}</div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <TriangleExclamationPoint size={28} className="text-warning" />
          <div className="text-sm font-medium">{t('Не удалось запустить 2D-редактор')}</div>
          <div className="max-w-md font-mono text-[11px] text-muted">{error}</div>
          <TextBtn onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw size={13} />
            {t('Повторить')}
          </TextBtn>
        </div>
      )}
    </div>
  )
}
