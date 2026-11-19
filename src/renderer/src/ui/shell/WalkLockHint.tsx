import { type RefObject, useEffect, useState } from 'react'
import { addTranslations, useT } from '@/i18n'
import { useUi } from '@/store/ui'
import { useWalkPrefs } from '@/store/walkPrefs'

addTranslations('en', {
  'Кликните, чтобы управлять мышью · M — свободный курсор · Esc — выйти': 'Click to control with the mouse · M keeps the cursor free · Esc to exit',
  'Esc — освободить мышь · M — свободный курсор': 'Esc to release the mouse · M keeps the cursor free',
  'Тяните мышью, чтобы осмотреться · WASD — идти · M — захват курсора': 'Drag to look around · WASD to walk · M captures the mouse',
  'Клик — поставить точку · PgUp/PgDn — высота · [ ] — тип · +/− — посты': 'Click to place a point · PgUp/PgDn height · [ ] type · +/− posts',
})

function lockedInside(host: HTMLElement | null): boolean {
  const el = document.pointerLockElement
  return !!el && !!host && host.contains(el)
}

const finePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches

const BOX = 'pointer-events-none absolute left-1/2 max-w-[90%] -translate-x-1/2 rounded-lg border border-border bg-panel/90 px-3 py-1.5 text-center text-xs text-text shadow-pop backdrop-blur'

/**
 * Walk mode hint over a 3D viewport. Mouse captured (Pointer Lock, see view3d/controls): a centre
 * crosshair and a small Esc reminder. Not captured: «click to capture», or — when the user keeps the
 * cursor free (store/walkPrefs, key M) — how to look around. With the «Электроточка» tool: its keys.
 * Only on devices with a mouse; touch screens look around by dragging.
 */
export function WalkLockHint({ host, active }: { host: RefObject<HTMLElement | null>; active: boolean }) {
  const t = useT()
  const [locked, setLocked] = useState(false)
  const [fine, setFine] = useState(finePointer)
  const capture = useWalkPrefs((s) => s.captureMouse)
  const electric = useUi((s) => s.tool === 'electric')

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
  const keys = electric ? <div className="mt-0.5 text-[11px] text-muted">{t('Клик — поставить точку · PgUp/PgDn — высота · [ ] — тип · +/− — посты')}</div> : null
  if (locked) {
    return (
      <>
        <div
          className={
            electric
              ? 'pointer-events-none absolute top-1/2 left-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]'
              : 'pointer-events-none absolute top-1/2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]'
          }
        />
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-black/45 px-2 py-0.5 text-center text-[11px] text-white/85">
          {t('Esc — освободить мышь · M — свободный курсор')}
          {electric && <div>{t('Клик — поставить точку · PgUp/PgDn — высота · [ ] — тип · +/− — посты')}</div>}
        </div>
      </>
    )
  }
  return (
    <div className={`${BOX} bottom-12`} role="status">
      {capture ? t('Кликните, чтобы управлять мышью · M — свободный курсор · Esc — выйти') : t('Тяните мышью, чтобы осмотреться · WASD — идти · M — захват курсора')}
      {keys}
    </div>
  )
}
