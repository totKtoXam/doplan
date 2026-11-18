import { useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { setWalkStick } from '@/view3d/walkInput'

const RADIUS = 44

const coarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/**
 * On-screen stick for walk mode on touch screens: push it to walk (forward / back / sideways), drag
 * the scene elsewhere to look around. Hidden on devices with a mouse (keyboard + Pointer Lock there).
 */
export function WalkStick() {
  const t = useT()
  const base = useRef<HTMLDivElement>(null)
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const active = useRef<number | null>(null)
  const [show] = useState(coarse)

  useEffect(
    () => () => {
      setWalkStick(0, 0)
    },
    [],
  )

  if (!show) return null

  const move = (clientX: number, clientY: number) => {
    const r = base.current?.getBoundingClientRect()
    if (!r) return
    let dx = clientX - (r.left + r.width / 2)
    let dy = clientY - (r.top + r.height / 2)
    const len = Math.hypot(dx, dy)
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS
      dy = (dy / len) * RADIUS
    }
    setKnob({ x: dx, y: dy })
    setWalkStick(-dy / RADIUS, dx / RADIUS)
  }
  const release = () => {
    active.current = null
    setKnob({ x: 0, y: 0 })
    setWalkStick(0, 0)
  }

  return (
    <>
      <div
        ref={base}
        className="absolute bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-5 h-28 w-28 touch-none rounded-full border border-white/25 bg-black/25 backdrop-blur-sm"
        onPointerDown={(e) => {
          active.current = e.pointerId
          e.currentTarget.setPointerCapture(e.pointerId)
          move(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          if (active.current === e.pointerId) move(e.clientX, e.clientY)
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 h-12 w-12 rounded-full bg-white/70 shadow"
          style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
        />
      </div>
      <div className="pointer-events-none absolute right-3 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] rounded-md bg-black/40 px-2 py-0.5 text-[11px] text-white/85">
        {t('Перетаскивайте, чтобы осмотреться')}
      </div>
    </>
  )
}
