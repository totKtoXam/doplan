import { useEffect, useState } from 'react'
import { Box, FolderOpen, Link2, Link2Off } from 'lucide-react'
import type { Asset, AssetCategory, MountKind } from '@core/types'
import { uiStore } from '@/store/ui'
import { handles } from '@/store/handles'
import { dialogStore } from '@/store/dialogs'
import { useT } from '@/i18n'
import { Button, Dialog, IconButton, Input, NumberInput, Row, Select, Spinner, fmtNum } from '@/ui/kit'
import { ASSET_CATEGORIES, ASSET_CATEGORY_RU, MOUNT_RU, optionsOf } from './common/labels'
import { errorText, extOf, refreshCatalog, usePrefs } from './common/catalog'
import type { DialogPropsBase } from './BomDialog'

const MODEL_EXT = ['glb', 'gltf', 'obj', 'fbx']
const AUX_EXT = ['bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'ktx2']

type Size = { w: number; d: number; h: number }
type LoadedFile = { name: string; data: ArrayBuffer }

interface Converted {
  glb: ArrayBuffer
  slots: string[]
  thumbUrl: string | null
  thumbPng: ArrayBuffer | null
}

function baseName(file: string): string {
  const n = file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  return n ? n[0].toUpperCase() + n.slice(1) : 'Модель'
}

async function waitForEngine(timeoutMs: number) {
  const start = Date.now()
  while (!handles.engine3d && Date.now() - start < timeoutMs) await new Promise((r) => window.setTimeout(r, 250))
  return handles.engine3d
}

/** import wizard: pick model files → convert to GLB in the engine → preview, name, category, mount, size/unit fix → user library */
export function ImportModelDialog({ open, onClose }: DialogPropsBase) {
  const t = useT()
  const [stage, setStage] = useState<'pick' | 'converting' | 'edit' | 'saving'>('pick')
  const [error, setError] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [conv, setConv] = useState<Converted | null>(null)
  const [name, setName] = useState('')
  const [category, setCategory] = useState<AssetCategory>('decor')
  const [mount, setMount] = useState<MountKind>('floor')
  const [elevation, setElevation] = useState(0)
  const [size, setSize] = useState<Size>({ w: 1000, d: 1000, h: 1000 })
  const [lock, setLock] = useState(true)
  const [source, setSource] = useState('')
  const [licence, setLicence] = useState('')
  const [imported, setImported] = useState<Asset | null>(null)

  const reset = () => {
    if (conv?.thumbUrl) URL.revokeObjectURL(conv.thumbUrl)
    setStage('pick')
    setError('')
    setFiles([])
    setConv(null)
    setImported(null)
    setSource('')
    setLicence('')
  }
  useEffect(() => {
    if (!open) reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pick = async () => {
    setError('')
    const picked = await window.doplan.files.pick(
      [
        { name: t('3D-модели'), extensions: [...MODEL_EXT, ...AUX_EXT] },
        { name: 'glTF / GLB', extensions: ['glb', 'gltf', 'bin'] },
        { name: 'OBJ', extensions: ['obj', 'mtl'] },
        { name: 'FBX', extensions: ['fbx'] },
      ],
      true,
    )
    if (picked.length === 0) return
    if (!picked.some((f) => MODEL_EXT.includes(extOf(f.name)))) {
      setError(t('Среди выбранных файлов нет модели (GLB, glTF, OBJ, FBX).'))
      return
    }
    setStage('converting')
    try {
      const loaded = await Promise.all(picked.map(async (f) => ({ name: f.name, data: await window.doplan.files.read(f.path) })))
      await convert(loaded)
    } catch (e) {
      setError(errorText(e))
      setStage('pick')
    }
  }

  // files dropped onto the window (actions.importModelFiles) skip the picker
  useEffect(() => {
    if (!open) return
    const pending = dialogStore.getState().pendingModelFiles
    if (!pending?.length) return
    dialogStore.getState().set({ pendingModelFiles: null })
    void convert(pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const convert = async (loaded: LoadedFile[]) => {
    setError('')
    const main = loaded.find((f) => MODEL_EXT.includes(extOf(f.name)))
    if (!main) {
      setError(t('Среди выбранных файлов нет модели (GLB, glTF, OBJ, FBX).'))
      setStage('pick')
      return
    }
    setFiles(loaded.map((f) => f.name))
    setStage('converting')
    try {
      let engine = handles.engine3d
      if (!engine) {
        uiStore.getState().setMode('split')
        engine = await waitForEngine(20000)
      }
      if (!engine) throw new Error(t('3D-движок не запустился'))
      const aux = loaded.filter((f) => f !== main)
      const res = await engine.convertModel({ name: main.name, data: main.data }, aux)
      // the engine normalises to metres; accept either metres or millimetres in `size`
      const big = Math.max(res.size.w, res.size.d, res.size.h)
      const k = big > 0 && big < 50 ? 1000 : 1
      const sz = { w: Math.round(res.size.w * k), d: Math.round(res.size.d * k), h: Math.round(res.size.h * k) }
      const nm = baseName(main.name)
      let thumbUrl: string | null = null
      let thumbPng: ArrayBuffer | null = null
      const blobUrl = URL.createObjectURL(new Blob([res.glb], { type: 'model/gltf-binary' }))
      try {
        const preview: Asset = { id: `import_preview_${Date.now()}`, name: nm, category: 'decor', kind: 'model', src: blobUrl, size: sz, mount: 'floor' }
        const blob = await engine.renderAssetThumb(preview, 256)
        thumbPng = await blob.arrayBuffer()
        thumbUrl = URL.createObjectURL(blob)
      } catch {
        /* preview is optional */
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
      setConv({ glb: res.glb, slots: res.slots, thumbUrl, thumbPng })
      setName(nm)
      setSize(sz)
      setStage('edit')
    } catch (e) {
      setError(errorText(e))
      setStage('pick')
    }
  }

  const scale = (k: number) => setSize((s) => ({ w: Math.max(1, Math.round(s.w * k)), d: Math.max(1, Math.round(s.d * k)), h: Math.max(1, Math.round(s.h * k)) }))
  const setAxis = (axis: keyof Size, v: number) =>
    setSize((s) => {
      if (lock && s[axis] > 0) {
        const k = v / s[axis]
        return { w: Math.round(s.w * k), d: Math.round(s.d * k), h: Math.round(s.h * k), [axis]: v } as Size
      }
      return { ...s, [axis]: v }
    })

  const save = async () => {
    if (!conv) return
    setStage('saving')
    setError('')
    try {
      const meta: Omit<Asset, 'id' | 'src' | 'kind'> = {
        name: name.trim() || 'Model',
        nameRu: name.trim() || undefined,
        category,
        size,
        mount,
        ...(mount !== 'floor' ? { elevation } : {}),
        // slot name → default material id; '' = keep the model's own material
        ...(conv.slots.length ? { slots: Object.fromEntries(conv.slots.map((s) => [s, ''])) } : {}),
        ...(source.trim() ? { source: source.trim() } : {}),
        ...(licence.trim() ? { licence: licence.trim() } : {}),
        custom: true,
        tags: ['import'],
      }
      const asset = await window.doplan.catalog.importModel(conv.glb, meta, conv.thumbPng ?? undefined)
      await refreshCatalog()
      setImported(asset)
      setStage('edit')
    } catch (e) {
      setError(errorText(e))
      setStage('edit')
    }
  }

  const place = () => {
    if (!imported) return
    usePrefs.getState().pushRecent('asset', imported.id)
    uiStore.getState().set({ tool: 'item', placingAssetId: imported.id })
    onClose()
  }

  const footer =
    stage === 'edit' || stage === 'saving' ? (
      imported ? (
        <>
          <span className="mr-auto text-[11px] text-[var(--accent)]">{t('Модель добавлена в библиотеку')}</span>
          <Button variant="ghost" onClick={onClose}>
            {t('Готово')}
          </Button>
          <Button variant="primary" onClick={place}>
            {t('Разместить на плане')}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={reset} disabled={stage === 'saving'}>
            {t('Другой файл')}
          </Button>
          <Button variant="primary" loading={stage === 'saving'} onClick={() => void save()}>
            {t('Добавить в библиотеку')}
          </Button>
        </>
      )
    ) : (
      <Button variant="ghost" onClick={onClose}>
        {t('Отмена')}
      </Button>
    )

  return (
    <Dialog open={open} onClose={onClose} title={t('Импорт 3D-модели')} width="max-w-xl" modalLock={stage === 'converting' || stage === 'saving'} footer={footer}>
      {stage === 'pick' && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Box className="size-10 text-[var(--muted)]" />
          <p className="max-w-sm text-[var(--muted)]">
            {t('Поддерживаются GLB, glTF (с .bin и текстурами), OBJ (с .mtl и текстурами) и FBX. Выберите модель вместе со вспомогательными файлами.')}
          </p>
          <Button variant="primary" icon={<FolderOpen className="size-3.5" />} onClick={() => void pick()} data-autofocus>
            {t('Выбрать файлы…')}
          </Button>
          {error && <p className="text-[#ff8589]">{error}</p>}
        </div>
      )}
      {stage === 'converting' && (
        <div className="flex flex-col items-center gap-3 py-10">
          <Spinner className="size-6" />
          <p className="text-[var(--muted)]">
            {t('Преобразование')} {files[0] ?? ''}…
          </p>
        </div>
      )}
      {(stage === 'edit' || stage === 'saving') && conv && (
        <div className="flex gap-4">
          <div className="flex w-40 shrink-0 flex-col gap-2">
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)]">
              {conv.thumbUrl ? <img src={conv.thumbUrl} alt={name} className="size-full object-contain" /> : <Box className="size-10 text-[var(--muted)]" />}
            </div>
            <div className="text-[10px] text-[var(--muted)]">
              {files.join(', ')}
              <br />
              GLB: {fmtNum(conv.glb.byteLength / 1048576, 1)} MB
              {conv.slots.length > 0 && (
                <>
                  <br />
                  {t('Слоты материалов')}: {conv.slots.join(', ')}
                </>
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Row label={t('Название')}>
              <Input value={name} onChange={setName} onKeyDown={(e) => e.stopPropagation()} />
            </Row>
            <Row label={t('Категория')}>
              <Select<AssetCategory> value={category} onChange={setCategory} options={optionsOf(ASSET_CATEGORY_RU, ASSET_CATEGORIES)} />
            </Row>
            <Row label={t('Крепление')}>
              <Select<MountKind> value={mount} onChange={setMount} options={optionsOf(MOUNT_RU)} />
            </Row>
            {mount !== 'floor' && (
              <Row label={t('Высота установки')}>
                <NumberInput kind="length" unit="mm" value={elevation} min={0} round={1} onChange={setElevation} />
              </Row>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[var(--muted)]">{t('Размер, мм (Ш × Г × В)')}</span>
              <IconButton size="sm" icon={lock ? <Link2 /> : <Link2Off />} active={lock} label={t('Сохранять пропорции')} onClick={() => setLock(!lock)} />
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <NumberInput kind="length" unit="mm" label={t('Ш')} value={size.w} min={1} round={1} onChange={(v) => setAxis('w', v)} />
              <NumberInput kind="length" unit="mm" label={t('Г')} value={size.d} min={1} round={1} onChange={(v) => setAxis('d', v)} />
              <NumberInput kind="length" unit="mm" label={t('В')} value={size.h} min={1} round={1} onChange={(v) => setAxis('h', v)} />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-[var(--muted)]">{t('Исправить единицы')}:</span>
              {[0.001, 0.01, 10, 1000].map((k) => (
                <Button key={k} size="sm" onClick={() => scale(k)}>
                  ×{k}
                </Button>
              ))}
            </div>
            <p className="text-[10px] leading-snug text-[var(--muted)]">
              {t('Если диван получился 2 мм или 2 км — модель была в других единицах: нажмите ×1000 или ×0.001.')}
            </p>
            <Row label={t('Источник')}>
              <Input value={source} onChange={setSource} placeholder="sketchfab.com/…" onKeyDown={(e) => e.stopPropagation()} />
            </Row>
            <Row label={t('Лицензия')}>
              <Input value={licence} onChange={setLicence} placeholder="CC0 / CC-BY 4.0" onKeyDown={(e) => e.stopPropagation()} />
            </Row>
            {error && <p className="text-[#ff8589]">{error}</p>}
          </div>
        </div>
      )}
    </Dialog>
  )
}
