import { useMemo } from 'react'
import type { Doc, EntityRef } from '@core/types'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { useT } from '@/i18n'
import { cn, ScrollArea } from '@/ui/kit'
import { WallInspector } from './inspector/WallInspector'
import { OpeningInspector } from './inspector/OpeningInspector'
import { RoomInspector } from './inspector/RoomInspector'
import { ItemInspector } from './inspector/ItemInspector'
import { LightInspector } from './inspector/LightInspector'
import { ElectricInspector } from './inspector/ElectricInspector'
import { MultiInspector } from './inspector/MultiInspector'
import { ProjectInspector } from './inspector/ProjectInspector'
import { DimensionInspector, LabelInspector, NodeInspector, UnderlayInspector } from './inspector/MiscInspectors'

function exists(doc: Doc, r: EntityRef): boolean {
  switch (r.kind) {
    case 'node':
      return !!doc.nodes[r.id]
    case 'wall':
      return !!doc.walls[r.id]
    case 'opening':
      return !!doc.openings[r.id]
    case 'room':
      return !!doc.rooms[r.id]
    case 'item':
      return !!doc.items[r.id]
    case 'light':
      return !!doc.lights[r.id]
    case 'electric':
      return !!doc.electrical?.[r.id]
    case 'dimension':
      return !!doc.dimensions[r.id]
    case 'label':
      return !!doc.labels[r.id]
    case 'underlay':
      return !!doc.underlays[r.id]
  }
}

/** context-sensitive inspector driven by uiStore.selection */
export function RightPanel({ className }: { className?: string }) {
  const t = useT()
  const selection = useUi((s) => s.selection)
  const doc = useDoc((s) => s.doc)
  const refs = useMemo(() => selection.filter((r) => exists(doc, r)), [selection, doc])
  const key = refs.length === 1 ? `${refs[0].kind}:${refs[0].id}` : refs.length > 1 ? 'multi' : 'project'

  let body
  if (refs.length === 0) body = <ProjectInspector />
  else if (refs.length > 1) body = <MultiInspector refs={refs} />
  else {
    const r = refs[0]
    switch (r.kind) {
      case 'wall':
        body = <WallInspector id={r.id} />
        break
      case 'opening':
        body = <OpeningInspector id={r.id} />
        break
      case 'room':
        body = <RoomInspector id={r.id} />
        break
      case 'item':
        body = <ItemInspector id={r.id} />
        break
      case 'light':
        body = <LightInspector id={r.id} />
        break
      case 'electric':
        body = <ElectricInspector id={r.id} />
        break
      case 'node':
        body = <NodeInspector id={r.id} />
        break
      case 'dimension':
        body = <DimensionInspector id={r.id} />
        break
      case 'label':
        body = <LabelInspector id={r.id} />
        break
      case 'underlay':
        body = <UnderlayInspector id={r.id} />
        break
    }
  }

  return (
    <aside className={cn('flex h-full min-h-0 w-full flex-col bg-[var(--panel)] text-xs text-[var(--text)]', className)} aria-label={t('Свойства')}>
      <ScrollArea className="min-h-0 flex-1">
        <div key={key}>{body}</div>
      </ScrollArea>
    </aside>
  )
}
