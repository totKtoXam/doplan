import { useState } from 'react'
import { Paintbrush, Pencil, Pipette, Plus } from 'lucide-react'
import type { Id } from '@core/types'
import { uiStore, useUi } from '@/store/ui'
import { useT } from '@/i18n'
import { Button, IconButton } from '@/ui/kit'
import { MaterialBrowser, MaterialSwatch } from '../common/MaterialPicker'
import { displayName, lookupMaterial, useLang, useMaterialMap } from '../common/catalog'
import { applyMaterialToRefs } from '../common/edits'
import { MATERIAL_CATEGORY_RU } from '../common/labels'
import { MaterialEditorDialog } from '../MaterialEditorDialog'

/** start the paint tool with a material (keeps its default laying pattern) */
export function startPainting(materialId: Id) {
  const m = lookupMaterial(materialId)
  uiStore.getState().set({ tool: 'paint', paintFinish: { materialId, ...(m?.pattern ? { pattern: { ...m.pattern } } : {}) } })
}

export function MaterialsTab() {
  const t = useT()
  const lang = useLang()
  const map = useMaterialMap()
  const tool = useUi((s) => s.tool)
  const paint = useUi((s) => s.paintFinish)
  const selection = useUi((s) => s.selection)
  const [current, setCurrent] = useState<Id | undefined>(paint?.materialId)
  const [editor, setEditor] = useState<{ open: boolean; id?: Id }>({ open: false })
  const [flash, setFlash] = useState('')

  const cur = current ? map.get(current) : undefined
  const applicable = selection.filter((r) => ['wall', 'room', 'opening', 'item'].includes(r.kind))

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-1.5">
        <MaterialSwatch material={cur} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs">{cur ? displayName(cur, lang) : t('Материал не выбран')}</div>
          <div className="truncate text-[10px] text-[var(--muted)]">
            {cur ? t(MATERIAL_CATEGORY_RU[cur.category]) : t('Щёлкните образец, затем поверхность')}
          </div>
        </div>
        <IconButton
          icon={<Pipette />}
          label={t('Пипетка: взять материал с поверхности')}
          active={tool === 'eyedropper'}
          onClick={() => uiStore.getState().setTool('eyedropper')}
        />
        <IconButton
          icon={<Paintbrush />}
          label={t('Кисть: красить поверхности')}
          active={tool === 'paint'}
          disabled={!current}
          onClick={() => current && startPainting(current)}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="primary"
          disabled={!current || applicable.length === 0}
          onClick={() => {
            if (!current) return
            const n = applyMaterialToRefs(current, applicable)
            setFlash(n > 0 ? `${t('Применено')}: ${n}` : t('Нечего применять'))
            window.setTimeout(() => setFlash(''), 1800)
          }}
          title={t('Стены — обе стороны; помещение — пол, потолок или стены по типу материала; мебель — все слоты')}
        >
          {t('Применить к выделенному')}
          {applicable.length > 0 && ` (${applicable.length})`}
        </Button>
        <Button size="sm" icon={<Plus className="size-3" />} onClick={() => setEditor({ open: true })}>
          {t('Свой материал')}
        </Button>
        {cur?.custom && (
          <Button size="sm" icon={<Pencil className="size-3" />} onClick={() => setEditor({ open: true, id: cur.id })}>
            {t('Изменить')}
          </Button>
        )}
        {flash && <span className="self-center text-[10px] text-[var(--accent)]">{flash}</span>}
      </div>
      <MaterialBrowser
        value={current}
        columns={4}
        fill
        initialFilter="all"
        onPick={(id) => {
          setCurrent(id)
          if (id) startPainting(id)
        }}
      />
      <MaterialEditorDialog
        open={editor.open}
        materialId={editor.id}
        onClose={() => setEditor({ open: false })}
        onSaved={(id) => {
          setCurrent(id)
          startPainting(id)
        }}
      />
    </div>
  )
}
