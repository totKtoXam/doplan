import type { ReactNode } from 'react'
import type { OpeningKind, WallKind } from '@core/types'

/** small plan-symbol pictograms for the construction cards (currentColor based) */
const W = 48
const H = 32

export function WallKindIcon({ kind }: { kind: WallKind }) {
  const y = H / 2
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-12" aria-hidden>
      {kind === 'wall' && <rect x={4} y={y - 5} width={40} height={10} fill="currentColor" opacity={0.85} />}
      {kind === 'partition' && <rect x={4} y={y - 2.5} width={40} height={5} fill="currentColor" opacity={0.7} />}
      {kind === 'parapet' && (
        <g>
          <rect x={4} y={y - 4} width={40} height={8} fill="none" stroke="currentColor" strokeWidth={1.2} />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <line key={i} x1={6 + i * 5} y1={y + 4} x2={10 + i * 5} y2={y - 4} stroke="currentColor" strokeWidth={0.8} />
          ))}
        </g>
      )}
      {kind === 'glazing' && (
        <g stroke="currentColor" strokeWidth={1}>
          <rect x={4} y={y - 3} width={40} height={6} fill="none" />
          <line x1={4} y1={y} x2={44} y2={y} stroke="#6cb6ff" strokeWidth={1.5} />
        </g>
      )}
      {kind === 'virtual' && <line x1={4} y1={y} x2={44} y2={y} stroke="currentColor" strokeWidth={1.5} strokeDasharray="4 3" />}
    </svg>
  )
}

export function OpeningKindIcon({ kind }: { kind: OpeningKind }) {
  const y = 22
  const t = 6
  const gapL = 12
  const gapR = 36
  const wall = (
    <g fill="currentColor" opacity={0.75}>
      <rect x={2} y={y - t / 2} width={gapL - 2} height={t} />
      <rect x={gapR} y={y - t / 2} width={W - gapR - 2} height={t} />
    </g>
  )
  const glass = (
    <g stroke="#6cb6ff" strokeWidth={1}>
      <line x1={gapL} y1={y - 2} x2={gapR} y2={y - 2} />
      <line x1={gapL} y1={y} x2={gapR} y2={y} />
      <line x1={gapL} y1={y + 2} x2={gapR} y2={y + 2} />
    </g>
  )
  const leaf = (x: number, len: number, dir: 1 | -1, heavy = false) => (
    <g stroke="currentColor" fill="none">
      <line x1={x} y1={y - t / 2} x2={x} y2={y - t / 2 - len} strokeWidth={heavy ? 2.4 : 1.4} />
      <path d={`M ${x} ${y - t / 2 - len} A ${len} ${len} 0 0 ${dir === 1 ? 1 : 0} ${x + dir * len} ${y - t / 2}`} strokeWidth={0.8} strokeDasharray="2 1.5" />
    </g>
  )
  let body: ReactNode = null
  switch (kind) {
    case 'door':
      body = leaf(gapL, gapR - gapL, 1)
      break
    case 'entranceDoor':
      body = leaf(gapL, gapR - gapL, 1, true)
      break
    case 'doubleDoor':
      body = (
        <>
          {leaf(gapL, (gapR - gapL) / 2, 1)}
          {leaf(gapR, (gapR - gapL) / 2, -1)}
        </>
      )
      break
    case 'slidingDoor':
      body = (
        <g stroke="currentColor" strokeWidth={1.6}>
          <line x1={gapL} y1={y - 1.5} x2={gapL + 15} y2={y - 1.5} />
          <line x1={gapR - 15} y1={y + 1.5} x2={gapR} y2={y + 1.5} />
        </g>
      )
      break
    case 'arch':
      body = <path d={`M ${gapL} ${y} Q ${(gapL + gapR) / 2} ${y - 16} ${gapR} ${y}`} stroke="currentColor" fill="none" strokeDasharray="3 2" />
      break
    case 'opening':
      body = (
        <g stroke="currentColor" strokeWidth={0.8} strokeDasharray="2 2">
          <line x1={gapL} y1={y - t / 2} x2={gapR} y2={y - t / 2} />
          <line x1={gapL} y1={y + t / 2} x2={gapR} y2={y + t / 2} />
        </g>
      )
      break
    case 'window':
      body = glass
      break
    case 'frenchWindow':
      body = (
        <>
          {glass}
          <line x1={gapL} y1={y + 5} x2={gapR} y2={y + 5} stroke="currentColor" strokeWidth={0.8} />
        </>
      )
      break
    case 'balconyDoor':
      body = (
        <>
          {glass}
          {leaf(gapL, 14, 1)}
        </>
      )
      break
    case 'balconyBlock':
      body = (
        <>
          <g stroke="#6cb6ff" strokeWidth={1}>
            <line x1={gapL + 10} y1={y - 2} x2={gapR} y2={y - 2} />
            <line x1={gapL + 10} y1={y} x2={gapR} y2={y} />
            <line x1={gapL + 10} y1={y + 2} x2={gapR} y2={y + 2} />
          </g>
          {leaf(gapL, 10, 1)}
        </>
      )
      break
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-12" aria-hidden>
      {wall}
      {body}
    </svg>
  )
}

export function RoomShapeIcon({ shape }: { shape: 'rect' | 'L' | 'dims' }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-12" aria-hidden fill="none" stroke="currentColor" strokeWidth={2.5}>
      {shape === 'rect' && <rect x={8} y={4} width={32} height={24} />}
      {shape === 'L' && <path d="M8 4 H26 V14 H40 V28 H8 Z" />}
      {shape === 'dims' && (
        <g>
          <rect x={10} y={8} width={28} height={20} />
          <g strokeWidth={0.8}>
            <line x1={10} y1={3} x2={38} y2={3} />
            <line x1={10} y1={1} x2={10} y2={5} />
            <line x1={38} y1={1} x2={38} y2={5} />
            <line x1={43} y1={8} x2={43} y2={28} />
            <line x1={41} y1={8} x2={45} y2={8} />
            <line x1={41} y1={28} x2={45} y2={28} />
          </g>
        </g>
      )}
    </svg>
  )
}
