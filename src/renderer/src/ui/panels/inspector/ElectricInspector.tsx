import { useMemo, useState } from 'react'
import {
  ELECTRIC_GROUPS,
  ELECTRIC_HEIGHT_PRESETS,
  ELECTRIC_TYPES,
  MAX_GANGS,
  alongWall,
  clampOnFace,
  detachElectric,
  electricBinding,
  electricGangs,
  electricHalfWidth,
  electricName,
  electricType,
  nearestWallFace,
  placeElectricOnWall,
} from '@core'
import type { Doc, ElectricKind, ElectricMount, ElectricPoint, Id } from '@core/types'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, Input, NumberInput, Row, Section, Segmented, Select, Toggle } from '@/ui/kit'
import { tx } from '../common/catalog'
import { ElectricIcon } from '../common/ElectricIcon'
import { Hint, InspectorHeader, Pair } from './shared'
import '@/ui/electricI18n'

const normDeg = (v: number) => ((v % 360) + 360) % 360

export function ElectricInspector({ id }: { id: Id }) {
  const t = useT()
  const lang = useUi((s) => (s.lang === 'en' ? 'en' : 'ru'))
  const p = useDoc((s) => s.doc.electrical?.[id])
  const derived = useDoc((s) => (p ? s.derived[p.levelId] : undefined))
  const doc = useDoc((s) => s.doc)
  const [comment, setComment] = useState<string | null>(null)

  const typeOptions = useMemo(
    () =>
      ELECTRIC_TYPES.map((x) => ({
        value: x.kind,
        label: lang === 'en' ? x.en : x.ru,
        group: (() => {
          const g = ELECTRIC_GROUPS.find((y) => y.id === x.group)
          return g ? (lang === 'en' ? g.en : g.ru) : undefined
        })(),
      })),
    [lang],
  )

  const binding = useMemo(() => (p ? electricBinding(doc, derived, p) : null), [doc, derived, p])
  if (!p) return null
  const ty = electricType(p.kind)
  const n = electricGangs(p)

  const set = (label: string, fn: (x: ElectricPoint, d: Doc) => void, merge?: string) =>
    tx(
      label,
      (d) => {
        const x = d.electrical?.[id]
        if (x) fn(x, d)
      },
      merge,
    )
  const m = (f: string, g: string) => `electric.${id}.${f}.${g}`

  // the binding ends as seen by someone in the room facing the wall: left and right
  let left: { len: number; set: (v: number, g?: string) => void } | null = null
  let right: { len: number; set: (v: number, g?: string) => void } | null = null
  if (binding && p.wallId) {
    const { a, b, n: nr } = binding
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    const rightDir = { x: nr.y, y: -nr.x }
    const bIsRight = u.x * rightDir.x + u.y * rightDir.y > 0
    const fromAEnd = (v: number) => (g: string) =>
      set(
        'Привязка электроточки',
        (x, d) => {
          if (!x.wallId) return
          const tt = Math.min(len, Math.max(0, v))
          const target = { x: a.x + u.x * tt, y: a.y + u.y * tt }
          const along = alongWall(d, x.wallId, target)
          const side = x.side === 'right' ? 'right' : 'left'
          // never past the room corner into the adjoining wall
          if (along !== null) placeElectricOnWall(d, id, x.wallId, side, clampOnFace(d, x.wallId, side, along, electricHalfWidth(x)))
        },
        m('bind', g),
      )
    const ea = { len: binding.fromA, set: (v: number, g = 'x') => fromAEnd(v)(g) }
    const eb = { len: binding.fromB, set: (v: number, g = 'x') => fromAEnd(len - v)(g) }
    left = bIsRight ? ea : eb
    right = bIsRight ? eb : ea
  }

  const reattach = () =>
    set('Привязать к стене', (x, d) => {
      const hit = nearestWallFace(d, x.levelId, x, 600)
      if (hit) placeElectricOnWall(d, id, hit.wallId, hit.side, clampOnFace(d, hit.wallId, hit.side, hit.t, electricHalfWidth(x)))
    })

  const setMount = (mt: ElectricMount) =>
    set('Монтаж электроточки', (x, d) => {
      x.mount = mt
      if (mt === 'floor') x.elevation = 0
      else if (mt === 'ceiling') x.elevation = d.levels[x.levelId]?.height || d.settings.wallHeight
      else {
        if (x.elevation <= 0 || x.elevation >= (d.levels[x.levelId]?.height ?? 2700)) x.elevation = electricType(x.kind).elevation || 300
        const hit = nearestWallFace(d, x.levelId, x, 600)
        if (hit) placeElectricOnWall(d, id, hit.wallId, hit.side, clampOnFace(d, hit.wallId, hit.side, hit.t, electricHalfWidth(x)))
      }
      if (mt !== 'wall') detachElectric(x)
    })

  return (
    <div>
      <InspectorHeader
        icon={<ElectricIcon kind={p.kind} gangs={p.gangs} vertical={p.vertical} mount={p.mount} className="size-4" />}
        title={electricName(p, lang)}
        subtitle={[ty.code, p.mount === 'wall' ? `h ${Math.round(p.elevation)} ${t('мм')}` : p.mount === 'floor' ? t('в полу') : t('на потолке')].filter(Boolean).join(' · ')}
      />
      <Section title={t('Электроточка')} id="insp.electric.main">
        <Row label={t('Тип')}>
          <Select<ElectricKind>
            value={p.kind}
            options={typeOptions}
            onChange={(k) =>
              set('Тип электроточки', (x) => {
                const prev = electricType(x.kind)
                const next = electricType(k)
                x.kind = k
                // the height follows the type while it is still the standard height of the old type
                if (x.mount === 'wall' && next.mount === 'wall' && Math.abs(x.elevation - prev.elevation) < 0.5) x.elevation = next.elevation
                if (!next.framed) {
                  delete x.gangs
                  delete x.vertical
                }
              })
            }
          />
        </Row>
        <Row label={t('Монтаж')}>
          <Segmented<ElectricMount>
            aria-label={t('Монтаж')}
            value={p.mount}
            options={[
              { value: 'wall', label: t('Стена') },
              { value: 'floor', label: t('Пол') },
              { value: 'ceiling', label: t('Потолок') },
            ]}
            onChange={setMount}
          />
        </Row>
        {ty.framed && (
          <>
            <Row label={t('Постов в рамке')}>
              <Segmented<string>
                aria-label={t('Постов в рамке')}
                value={String(n)}
                options={Array.from({ length: MAX_GANGS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                onChange={(v) =>
                  set('Постов в рамке', (x) => {
                    const k = Number(v)
                    if (k > 1) x.gangs = k
                    else {
                      delete x.gangs
                      delete x.vertical
                    }
                  })
                }
              />
            </Row>
            {n > 1 && (
              <Toggle
                checked={!!p.vertical}
                onChange={(v) =>
                  set('Вертикальная рамка', (x) => {
                    if (v) x.vertical = true
                    else delete x.vertical
                  })
                }
                label={t('Рамка вертикально')}
              />
            )}
          </>
        )}
        <Row label={t('Комментарий')} stacked>
          <Input
            value={comment ?? p.comment ?? ''}
            placeholder={t('например: под холодильник')}
            onChange={setComment}
            onCommit={(v) => {
              setComment(null)
              const c = v.trim()
              if (c === (p.comment ?? '')) return
              set('Комментарий', (x) => {
                if (c) x.comment = c.slice(0, 2000)
                else delete x.comment
              })
            }}
          />
        </Row>
        {ty.note && <Hint>{t(ty.note)}</Hint>}
      </Section>

      <Section title={t('Положение')} id="insp.electric.pos">
        {p.mount === 'wall' && (
          <>
            <Row label={t('Высота от пола')}>
              <NumberInput kind="length" value={p.elevation} min={0} max={10000} round={1} onChange={(v, g) => set('Высота электроточки', (x) => (x.elevation = v), m('el', g))} />
            </Row>
            <div className="flex flex-wrap gap-1">
              {ELECTRIC_HEIGHT_PRESETS.map((h) => (
                <Button
                  key={h.h}
                  size="sm"
                  active={Math.abs(p.elevation - h.h) < 0.5}
                  title={lang === 'en' ? h.en : h.ru}
                  onClick={() => set('Высота электроточки', (x) => (x.elevation = h.h))}
                >
                  {h.h}
                </Button>
              ))}
            </div>
          </>
        )}
        {p.mount === 'wall' && p.wallId && left && right && (
          <>
            <Pair>
              <NumberInput kind="length" label={t('← угол')} title={t('До угла слева (лицом к стене)')} value={left.len} min={0} round={1} onChange={(v, g) => left!.set(v, g)} />
              <NumberInput kind="length" label={t('угол →')} title={t('До угла справа (лицом к стене)')} value={right.len} min={0} round={1} onChange={(v, g) => right!.set(v, g)} />
            </Pair>
            <Hint>{binding?.room ? t('Расстояния по стене до углов комнаты') : t('Расстояния по стене до её концов')}</Hint>
          </>
        )}
        {(!p.wallId || p.mount !== 'wall') && (
          <>
            <Pair>
              <NumberInput kind="length" label="X" value={p.x} round={1} onChange={(v, g) => set('Переместить электроточку', (x) => (x.x = v), m('x', g))} />
              <NumberInput kind="length" label="Y" value={p.y} round={1} onChange={(v, g) => set('Переместить электроточку', (x) => (x.y = v), m('y', g))} />
            </Pair>
            <Row label={t('Поворот')}>
              <NumberInput kind="angle" value={p.rotation} step={1} onChange={(v, g) => set('Поворот электроточки', (x) => (x.rotation = normDeg(v)), m('rot', g))} />
            </Row>
          </>
        )}
        {p.mount === 'wall' && (
          <div className="flex gap-1">
            {p.wallId ? (
              <Button size="sm" className="flex-1" onClick={() => set('Отвязать от стены', (x) => detachElectric(x))}>
                {t('Отвязать от стены')}
              </Button>
            ) : (
              <Button size="sm" className="flex-1" onClick={reattach}>
                {t('Привязать к ближайшей стене')}
              </Button>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}
