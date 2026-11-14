import { useMemo, useRef } from 'react'
import { moveNode } from '@core'
import type { Doc, Id } from '@core/types'
import { nodeRays, nodeRoomProbe, planNodeAngle, primarySector, sectorsOf } from '@/editor2d/angles'
import { useT } from '@/i18n'
import { useDoc } from '@/store/document'
import { NumberInput, Row } from '@/ui/kit'
import { tx } from '../common/catalog'
import { Hint } from './shared'

/**
 * Editable angle between the two walls of a corner node. Changing it turns the wall whose far end
 * has fewer connections around the node (its length is kept) — one undo step per edit / scrub.
 * The measured side (ordered wall pair) is pinned while the node keeps the same two walls, so a
 * value past 180° does not flip the field over to the other sector.
 */
export function NodeAngleField({ id }: { id: Id }) {
  const t = useT()
  const nodes = useDoc((s) => s.doc.nodes)
  const walls = useDoc((s) => s.doc.walls)
  const levelId = useDoc((s) => s.doc.nodes[id]?.levelId)
  const derived = useDoc((s) => (levelId ? s.derived[levelId] : undefined))
  const pin = useRef<{ key: string; from: string; to: string } | null>(null)

  const sector = useMemo(() => {
    const doc = { nodes, walls } as Doc
    const rays = nodeRays(doc, id)
    if (rays.length !== 2) return null
    const key = `${id}|${rays
      .map((r) => r.id)
      .sort()
      .join('|')}`
    if (pin.current?.key !== key) {
      const first = primarySector(rays, nodeRoomProbe(doc, derived?.rooms ?? [], id))
      pin.current = first ? { key, from: first.from.id, to: first.to.id } : null
    }
    const p = pin.current
    return p ? (sectorsOf(rays).find((s) => s.from.id === p.from && s.to.id === p.to) ?? null) : null
  }, [nodes, walls, derived, id])

  if (!sector) return null
  const ref = { from: sector.from, to: sector.to }
  return (
    <>
      <Row label={t('Угол')}>
        <NumberInput
          kind="angle"
          value={Math.round(sector.deg * 10) / 10}
          min={1}
          max={359}
          decimals={1}
          onChange={(v, g) =>
            tx(
              'Угол стены',
              (d) => {
                const plan = planNodeAngle(d, id, ref, v)
                if (plan) moveNode(d, plan.movingNodeId, plan.to.x, plan.to.y)
              },
              `node.${id}.angle.${g}`,
            )
          }
        />
      </Row>
      <Hint>{t('Поворачивается стена, у дальнего конца которой меньше соединений; её длина сохраняется')}</Hint>
    </>
  )
}
