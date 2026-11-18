import { type RefObject, useEffect, useState } from 'react'
import { addTranslations, useT } from '@/i18n'

addTranslations('en', {
  'Кликните, чтобы управлять мышью · Esc — выйти': 'Click to control with the mouse · Esc to exit',
  'Esc — освободить мышь': 'Esc to release the mouse',
})

function lockedInside(host: HTMLElement | null): boolean {
  const el = document.pointerLockElement
  return !!el && !!host && host.contains(el)
}

const finePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches

/**
 * Walk mode hint over a 3D viewport: «click to capture the mouse · Esc to exit» while the mouse is free,
 * a centre dot and a small Esc reminder while it is captured (Pointer Lock, see view3d/controls).
 * Only on devices with a mouse; touch screens look around by dragging.
 */
export function WalkLockHint({ host, active }: { host: RefObject<HTMLElement | null>; active: boolean }) {
  const t = useT()
  const [locked, setLocked] = useState(false)
  const [fine, setFine] = useState(finePointer)

  useEffect(() => {
    const onChange = () => setLocked(lockedInside(host.current))
    document.addEventListener('pointerlockchange', onChange)
    const mq = typeof matchMedia === 'function' ? matchMedia('(pointer: fine)') : null
    const onMq = () => setFine(finePointer())
    mq?.addEventListener('change', onMq)
    return () => {
      document.removeEventListener('pointerlockchange', onChange)
      mq?.removeEventListener('change', onMq)
    }
  }, [host])

  if (!active || !fine) return null
  if (locked) {
    return (
      <>
        <div className="pointer-events-none absolute top-1/2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" />
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-black/45 px-2 py-0.5 text-[11px] text-white/85">
          {t('Esc — освободить мышь')}
        </div>
      </>
    )
  }
  return (
    <div
      className="pointer-events-none absolute bottom-12 left-1/2 max-w-[90%] -translate-x-1/2 rounded-lg border border-border bg-panel/90 px-3 py-1.5 text-center text-xs text-text shadow-pop backdrop-blur"
      role="status"
    >
      {t('Кликните, чтобы управлять мышью · Esc — выйти')}
    </div>
  )
}
