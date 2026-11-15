import { useMemo, type ReactNode } from 'react'
import type { TilePattern, TilePatternType } from '@core/types'
import { wasteFor } from '@core'
import { useT } from '@/i18n'
import { ColorInput, NumberInput, Row, Select, Slider } from '@/ui/kit'
import { optionsOf, PATTERN_RU } from '../common/labels'
import { Pair } from './shared'

export const DEFAULT_PATTERN: TilePattern = {
  type: 'grid',
  tileW: 600,
  tileH: 600,
  grout: 2,
  groutColor: '#bdbdbd',
  rotation: 0,
}

/** sensible size presets when switching the pattern type */
const TYPE_PRESET: Partial<Record<TilePatternType, Partial<TilePattern>>> = {
  herringbone: { tileW: 600, tileH: 100, grout: 0.5 },
  chevron: { tileW: 600, tileH: 100, grout: 0.5 },
  planks: { tileW: 1380, tileH: 193, grout: 0.5 },
  hex: { tileW: 200, tileH: 200, grout: 2 },
  basket: { tileW: 200, tileH: 100, grout: 1 },
  brick: { tileW: 300, tileH: 75, grout: 2 },
  brickThird: { tileW: 600, tileH: 300, grout: 2 },
}

export interface TilePatternEditorProps {
  pattern: TilePattern | undefined
  /** base colour of the material for the preview */
  color: string
  /** `gesture` groups slider/scrub edits */
  onChange(next: TilePattern | undefined, gesture?: string): void
}

export function TilePatternEditor({ pattern, color, onChange }: TilePatternEditorProps) {
  const t = useT()
  const p = pattern ?? { ...DEFAULT_PATTERN, type: 'none' as TilePatternType }
  const set = (patch: Partial<TilePattern>, g?: string) => onChange({ ...p, ...patch }, g)
  const active = p.type !== 'none'
  return (
    <div className="flex flex-col gap-1.5">
      <Row label={t('Раскладка')}>
        <Select<TilePatternType>
          value={p.type}
          options={optionsOf(PATTERN_RU)}
          onChange={(type) => {
            if (type === 'none') return onChange(undefined)
            const base = pattern && pattern.type !== 'none' ? pattern : DEFAULT_PATTERN
            const preset = pattern?.type === type ? {} : (TYPE_PRESET[type] ?? (base.type in TYPE_PRESET ? { tileW: 600, tileH: 600, grout: 2 } : {}))
            onChange({ ...base, ...preset, type })
          }}
        />
      </Row>
      {active && (
        <>
          <PatternPreview pattern={p} color={color} />
          <Pair>
            <NumberInput kind="length" label={p.type === 'hex' ? '⌀' : t('Ш')} value={p.tileW} min={10} max={5000} round={1} onChange={(v, g) => set({ tileW: v }, g)} />
            <NumberInput kind="length" label={t('В')} value={p.tileH} min={10} max={5000} round={1} disabled={p.type === 'hex'} onChange={(v, g) => set({ tileH: v }, g)} />
          </Pair>
          <Row label={t('Шов')}>
            <NumberInput kind="length" unit="mm" value={p.grout} min={0} max={30} step={0.5} decimals={1} onChange={(v, g) => set({ grout: v }, g)} />
          </Row>
          <Row label={t('Цвет шва')}>
            <ColorInput value={p.groutColor} onChange={(v, g) => set({ groutColor: v }, g)} swatches={['#ffffff', '#d9d9d9', '#9e9e9e', '#5a5a5a', '#2a2a2a', '#c8b89a']} />
          </Row>
          <Row label={t('Поворот')}>
            <NumberInput kind="angle" value={p.rotation} min={-180} max={180} step={1} onChange={(v, g) => set({ rotation: v }, g)} />
          </Row>
          <Row label={t('Вариативность')}>
            <Slider value={p.variation ?? 0} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v, g) => set({ variation: v }, g)} />
          </Row>
          <Row label={t('Начало раскладки')} hint={t('сдвиг первой целой плитки от угла, мм')}>
            <NumberInput kind="length" label="X" value={p.offsetX ?? 0} min={-5000} max={5000} round={1} onChange={(v, g) => set({ offsetX: v }, g)} />
            <NumberInput kind="length" label="Y" value={p.offsetY ?? 0} min={-5000} max={5000} round={1} onChange={(v, g) => set({ offsetY: v }, g)} />
          </Row>
          <Row label={t('Запас на подрезку')}>
            <Slider
              value={p.waste ?? wasteFor(p.type)}
              min={0}
              max={0.4}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%${p.waste === undefined ? ` (${t('по умолч.')})` : ''}`}
              onChange={(v, g) => set({ waste: v }, g)}
            />
          </Row>
          <Row label={t('Второй цвет')}>
            <ColorInput
              value={p.altColor}
              onChange={(v, g) => set({ altColor: v }, g)}
              onClear={() => {
                const { altColor: _drop, ...rest } = p
                onChange(rest)
              }}
            />
          </Row>
        </>
      )}
    </div>
  )
}

// ───────────────────────────── live SVG preview ─────────────────────────────

function hash(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function shade(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = Number.parseInt(m[1], 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  const r = ch((n >> 16) & 255)
  const g = ch((n >> 8) & 255)
  const b = ch(n & 255)
  return `rgb(${r},${g},${b})`
}

/** to-scale SVG preview of a tile laying pattern (mm units inside the viewBox) */
export function PatternPreview({ pattern: p, color, height = 110 }: { pattern: TilePattern; color: string; height?: number }) {
  const shapes = useMemo(() => buildShapes(p, color), [p, color])
  return (
    <svg
      viewBox={`${-shapes.span / 2} ${-shapes.spanH / 2} ${shapes.span} ${shapes.spanH}`}
      className="w-full rounded-md border border-[var(--border)]"
      style={{ height }}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="preview"
    >
      <rect x={-shapes.span} y={-shapes.span} width={shapes.span * 2} height={shapes.span * 2} fill={p.groutColor} />
      <g transform={`rotate(${p.rotation + (p.type === 'diagonal' ? 45 : 0)})`}>{shapes.nodes}</g>
    </svg>
  )
}

function buildShapes(p: TilePattern, color: string): { nodes: ReactNode[]; span: number; spanH: number } {
  const w = Math.max(10, p.tileW)
  const h = Math.max(10, p.type === 'hex' ? p.tileW : p.tileH)
  const g = Math.max(0, p.grout)
  const span = Math.min(8000, Math.max(600, Math.max(w, h) * 5))
  const spanH = span * 0.62
  const R = span * 0.9 // generate over a disk that covers the rotated view
  const out: ReactNode[] = []
  const v = p.variation ?? 0
  const fill = (i: number, j: number) => {
    const base = p.altColor && (((i + j) % 2) + 2) % 2 === 1 ? p.altColor : color
    return v > 0 ? shade(base, 1 - v * 0.35 + hash(i, j) * v * 0.7) : base
  }
  const limit = 4000
  const rect = (key: string, x: number, y: number, rw: number, rh: number, f: string) => {
    if (out.length > limit) return
    if (x > R || y > R || x + rw < -R || y + rh < -R) return
    out.push(<rect key={key} x={x + g / 2} y={y + g / 2} width={Math.max(0.1, rw - g)} height={Math.max(0.1, rh - g)} fill={f} />)
  }
  const nx = Math.ceil(R / w) + 2
  const ny = Math.ceil(R / h) + 2

  switch (p.type) {
    case 'grid':
    case 'diagonal':
    case 'none':
      for (let j = -ny; j <= ny; j++) for (let i = -nx; i <= nx; i++) rect(`${i}_${j}`, i * w, j * h, w, h, fill(i, j))
      break
    case 'brick':
    case 'brickThird':
    case 'planks': {
      for (let j = -ny; j <= ny; j++) {
        const off =
          p.type === 'brick' ? ((((j % 2) + 2) % 2) * w) / 2 : p.type === 'brickThird' ? ((((j % 3) + 3) % 3) * w) / 3 : hash(j, 7) * w
        for (let i = -nx - 1; i <= nx; i++) rect(`${i}_${j}`, i * w + off, j * h, w, h, fill(i, j))
      }
      break
    }
    case 'herringbone': {
      // L × W planks; lattice vectors (W, W) and (L, −L)
      const L = Math.max(w, h)
      const W = Math.min(w, h)
      const nk = Math.ceil((2 * R) / W) + 2
      const nm = Math.ceil((2 * R) / L) + 2
      for (let m = -nm; m <= nm; m++)
        for (let k = -nk; k <= nk; k++) {
          const ox = k * W + m * L
          const oy = k * W - m * L
          rect(`h${k}_${m}`, ox, oy, L, W, fill(k, m))
          rect(`v${k}_${m}`, ox, oy + W, W, L, fill(k + 1, m))
        }
      break
    }
    case 'chevron': {
      const s = Math.SQRT1_2
      const cw = w * s
      const hh = h / s
      const ncol = Math.ceil(R / cw) + 2
      const nrow = Math.ceil(R / hh) + 3
      for (let i = -ncol; i <= ncol; i++) {
        const dir = (((i % 2) + 2) % 2) === 0 ? 1 : -1
        for (let j = -nrow; j <= nrow; j++) {
          if (out.length > limit) break
          const x = i * cw
          const y = j * hh + (dir === -1 ? cw : 0)
          const pts = [
            [x + g / 2, y + g / 2],
            [x + cw - g / 2, y + dir * cw + g / 2],
            [x + cw - g / 2, y + dir * cw + hh - g / 2],
            [x + g / 2, y + hh - g / 2],
          ]
          if (Math.abs(x) > R + cw || Math.abs(y) > R + hh) continue
          out.push(<polygon key={`c${i}_${j}`} points={pts.map((q) => q.join(',')).join(' ')} fill={fill(i, j)} />)
        }
      }
      break
    }
    case 'hex': {
      const r = w / 2
      const dx = 1.5 * r
      const dy = Math.sqrt(3) * r
      const ncol = Math.ceil(R / dx) + 2
      const nrow = Math.ceil(R / dy) + 2
      const k = Math.max(0, r - g / 2)
      for (let i = -ncol; i <= ncol; i++)
        for (let j = -nrow; j <= nrow; j++) {
          if (out.length > limit) break
          const cx = i * dx
          const cy = j * dy + ((((i % 2) + 2) % 2) * dy) / 2
          const pts: string[] = []
          for (let a = 0; a < 6; a++) {
            const ang = (Math.PI / 3) * a
            pts.push(`${cx + k * Math.cos(ang)},${cy + k * Math.sin(ang)}`)
          }
          out.push(<polygon key={`x${i}_${j}`} points={pts.join(' ')} fill={fill(i, j)} />)
        }
      break
    }
    case 'basket': {
      const S = Math.max(w, h)
      const half = S / 2
      const n = Math.ceil(R / S) + 2
      for (let i = -n; i <= n; i++)
        for (let j = -n; j <= n; j++) {
          const x = i * S
          const y = j * S
          if ((((i + j) % 2) + 2) % 2 === 0) {
            rect(`b${i}_${j}a`, x, y, S, half, fill(i * 2, j))
            rect(`b${i}_${j}b`, x, y + half, S, half, fill(i * 2 + 1, j))
          } else {
            rect(`b${i}_${j}a`, x, y, half, S, fill(i * 2, j))
            rect(`b${i}_${j}b`, x + half, y, half, S, fill(i * 2 + 1, j))
          }
        }
      break
    }
  }
  return { nodes: out, span, spanH }
}
