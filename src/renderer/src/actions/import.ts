import { compilePlanSpec, newId, newProjectId, parseDoc, parsePlanSpec, validatePlanSpec } from '@core'
import type { Doc } from '@core/types'
import { t } from '@/i18n'
import { api } from '@/store/api'
import { dialogStore } from '@/store/dialogs'
import { docStore } from '@/store/document'
import { alertDialog, choiceDialog, confirmDialog, setProgress, toast } from '@/store/notify'
import { uiStore } from '@/store/ui'
import { copyLevelInto } from './levels'
import { confirmDiscard, loadDocument, openProject } from './project'
import { activeLevel, currentDoc, errorText, extOf, IMAGE_EXTS, imageSize, MODEL_AUX_EXTS, MODEL_EXTS, mimeOf } from './util'

// ───────────── PlanSpec ─────────────

interface IssueLike {
  severity?: string
  level?: string
  message?: string
  msg?: string
  path?: string | (string | number)[]
  code?: string
}

function issueSeverity(i: unknown): 'error' | 'warning' {
  const o = (i ?? {}) as IssueLike
  const s = (o.severity ?? o.level ?? '').toString().toLowerCase()
  return s === 'error' || s === 'fatal' ? 'error' : 'warning'
}

function issueText(i: unknown): string {
  if (typeof i === 'string') return i
  const o = (i ?? {}) as IssueLike
  const path = Array.isArray(o.path) ? o.path.join('.') : o.path
  const msg = o.message ?? o.msg ?? o.code ?? JSON.stringify(i)
  return path ? `${path}: ${msg}` : msg
}

/** Imports a PlanSpec (compact plan description). Without text it asks for a .json file. */
export async function importPlanSpec(jsonText?: string): Promise<boolean> {
  let text = jsonText
  if (text === undefined) {
    const picked = await api.files.pick([{ name: 'PlanSpec JSON', extensions: ['json'] }])
    if (!picked.length) return false
    try {
      text = await api.files.readText(picked[0].path)
    } catch (err) {
      await alertDialog(t('Не удалось прочитать файл'), errorText(err))
      return false
    }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    await alertDialog(t('Ошибка импорта PlanSpec'), t('Файл не является корректным JSON.'), [errorText(err)])
    return false
  }
  // a full doplan document saved as JSON
  if (looksLikeDoc(json)) return importDocJson(json)

  let spec: ReturnType<typeof parsePlanSpec>
  try {
    spec = parsePlanSpec(json)
  } catch (err) {
    await alertDialog(t('Ошибка импорта PlanSpec'), t('Описание плана не соответствует формату PlanSpec.'), [errorText(err)])
    return false
  }
  const issues = ((validatePlanSpec(spec) ?? []) as unknown[]).slice()
  const errors = issues.filter((i) => issueSeverity(i) === 'error')
  const warnings = issues.filter((i) => issueSeverity(i) === 'warning')
  if (errors.length) {
    await alertDialog(
      t('Ошибка импорта PlanSpec'),
      t('В описании плана найдены ошибки ({n}). Исправьте их и повторите импорт.', { n: errors.length }),
      [...errors, ...warnings].map(issueText),
    )
    return false
  }
  if (warnings.length) {
    const ok = await confirmDialog(t('Предупреждения PlanSpec'), t('План будет импортирован, но есть замечания ({n}).', { n: warnings.length }), {
      ok: t('Импортировать'),
      details: warnings.map(issueText),
    })
    if (!ok) return false
  }
  let compiled: Doc
  try {
    compiled = compilePlanSpec(spec)
  } catch (err) {
    await alertDialog(t('Ошибка импорта PlanSpec'), t('Не удалось построить план.'), [errorText(err)])
    return false
  }
  return placeImportedDoc(compiled)
}

function looksLikeDoc(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false
  const o = json as Record<string, unknown>
  return typeof o.levels === 'object' && typeof o.walls === 'object' && Array.isArray(o.levelOrder)
}

async function importDocJson(json: unknown): Promise<boolean> {
  try {
    // a copy of a project, not that file: its own id (and chats)
    const doc = { ...parseDoc(json) }
    doc.meta = { ...doc.meta, id: newProjectId() }
    if (!(await confirmDiscard())) return false
    loadDocument(doc, null)
    toast(t('Проект открыт'), 'success')
    return true
  } catch (err) {
    await alertDialog(t('Файл проекта повреждён или имеет неверный формат'), errorText(err))
    return false
  }
}

/** Replace the document, or append the imported plan as new level(s). */
async function placeImportedDoc(compiled: Doc): Promise<boolean> {
  const doc = currentDoc()
  const empty = Object.keys(doc.walls).length === 0 && Object.keys(doc.items).length === 0
  let mode = 'replace'
  if (!empty) {
    mode = await choiceDialog(t('Импорт плана'), t('Куда поместить импортированный план?'), [
      { id: 'cancel', label: t('Отмена') },
      { id: 'level', label: t('Новый этаж') },
      { id: 'replace', label: t('Заменить проект'), variant: 'primary' },
    ])
  }
  if (mode === 'cancel') return false
  if (mode === 'replace') {
    if (!empty && !(await confirmDiscard())) return false
    loadDocument(compiled, null)
    toast(t('План импортирован'), 'success')
    return true
  }
  let firstNew = ''
  docStore.getState().transact(t('Импорт PlanSpec'), (d) => {
    let elevation = 0
    const last = d.levels[d.levelOrder[d.levelOrder.length - 1]]
    if (last) elevation = last.elevation + last.height + 200
    for (const srcLevel of compiled.levelOrder) {
      const src = compiled.levels[srcLevel]
      const id = newId('lv')
      if (!firstNew) firstNew = id
      d.levels[id] = { ...src, id, elevation }
      elevation += src.height + 200
      d.levelOrder.push(id)
      copyLevelInto(compiled, srcLevel, d, id)
    }
  })
  if (firstNew) uiStore.getState().set({ activeLevelId: firstNew, selection: [] })
  toast(t('План импортирован'), 'success')
  return true
}

// ───────────── underlay ─────────────

export async function addUnderlayFromData(data: ArrayBuffer, name: string): Promise<void> {
  const ext = extOf(name) || 'png'
  try {
    const size = await imageSize(data, mimeOf(ext))
    const src = await api.project.addAsset(data, ext === 'jpeg' ? 'jpg' : ext)
    const levelId = activeLevel()
    const b = docStore.getState().derived[levelId]?.bounds
    const hasPlan = !!b && b.maxX - b.minX > 100
    const widthMm = b && hasPlan ? Math.max(5000, b.maxX - b.minX) : 10000
    const scale = widthMm / Math.max(1, size.w)
    const cx = b && hasPlan ? (b.minX + b.maxX) / 2 : widthMm / 2
    const cy = b && hasPlan ? (b.minY + b.maxY) / 2 : (size.h * scale) / 2
    const id = newId('u')
    docStore.getState().transact(t('Подложка'), (d) => {
      d.underlays[id] = {
        id,
        levelId,
        src,
        x: cx - (size.w * scale) / 2,
        y: cy - (size.h * scale) / 2,
        scale,
        rotation: 0,
        opacity: 0.5,
        visible: true,
        locked: false,
        widthPx: size.w,
        heightPx: size.h,
      }
    })
    const ui = uiStore.getState()
    if (ui.mode === '3d') ui.setMode('2d')
    ui.select([{ kind: 'underlay', id }])
    ui.setTool('calibrate')
    ui.set({ hint: t('Калибровка: укажите две точки с известным расстоянием и введите его длину') })
    toast(t('Подложка добавлена. Откалибруйте масштаб по двум точкам.'), 'info', 6000)
  } catch (err) {
    await alertDialog(t('Не удалось добавить подложку'), errorText(err))
  }
}

export async function importUnderlay(): Promise<void> {
  const picked = await api.files.pick([{ name: t('Изображения'), extensions: IMAGE_EXTS }])
  if (!picked.length) return
  try {
    const data = await api.files.read(picked[0].path)
    await addUnderlayFromData(data, picked[0].name)
  } catch (err) {
    await alertDialog(t('Не удалось прочитать файл'), errorText(err))
  }
}

// ───────────── models / photo ─────────────

export function importModelFiles(files?: { name: string; data: ArrayBuffer }[]): void {
  dialogStore.getState().set({ pendingModelFiles: files && files.length ? files : null })
  dialogStore.getState().open('importModel')
}

export function planFromPhoto(photo?: { name: string; data: ArrayBuffer; mime: string }): void {
  dialogStore.getState().set({ pendingPhoto: photo ?? null })
  dialogStore.getState().open('photoPlan')
}

// ───────────── drag & drop ─────────────

/** Electron exposes the real path of a dropped file only through an extension of the preload API. */
function pathOfDroppedFile(f: File): string | null {
  const filesApi = api.files as unknown as { pathForFile?: (f: File) => string }
  try {
    const p = filesApi.pathForFile?.(f)
    if (p) return p
  } catch {
    /* ignore */
  }
  const legacy = (f as unknown as { path?: string }).path
  return legacy || null
}

/** Opens a .doplan archive dropped without a path: unzips doc.json in the renderer. */
async function openDoplanBytes(f: File): Promise<void> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => e.name === 'doc.json' })
  const raw = entries['doc.json']
  if (!raw) throw new Error(t('В архиве нет doc.json'))
  const doc = parseDoc(JSON.parse(strFromU8(raw)))
  // opened without its file: a copy of the project with its own id (and chats)
  doc.meta.id = newProjectId()
  if (!(await confirmDiscard())) return
  loadDocument(doc, null)
  toast(t('Проект открыт без встроенных файлов — сохраните его заново.'), 'warning', 6000)
}

export async function handleDroppedFiles(files: File[]): Promise<void> {
  if (!files.length) return
  const byExt = (exts: string[]) => files.filter((f) => exts.includes(extOf(f.name)))
  try {
    const project = byExt(['doplan'])[0]
    if (project) {
      const p = pathOfDroppedFile(project)
      if (p) await openProject(p)
      else await openDoplanBytes(project)
      return
    }
    const json = byExt(['json'])[0]
    if (json) {
      await importPlanSpec(await json.text())
      return
    }
    const models = byExt(MODEL_EXTS)
    if (models.length) {
      setProgress({ label: t('Чтение файлов…'), value: null })
      const aux = byExt(MODEL_AUX_EXTS).filter((f) => !models.includes(f))
      const data = await Promise.all([...models, ...aux].map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })))
      setProgress(null)
      importModelFiles(data)
      return
    }
    const image = byExt(IMAGE_EXTS)[0]
    if (image) {
      const data = await image.arrayBuffer()
      const choice = await choiceDialog(t('Изображение'), t('Что сделать с изображением «{name}»?', { name: image.name }), [
        { id: 'cancel', label: t('Отмена') },
        { id: 'photo', label: t('Распознать план') },
        { id: 'underlay', label: t('Подложка для обводки'), variant: 'primary' },
      ])
      if (choice === 'underlay') await addUnderlayFromData(data, image.name)
      else if (choice === 'photo') planFromPhoto({ name: image.name, data, mime: mimeOf(extOf(image.name)) })
      return
    }
    toast(t('Неподдерживаемый тип файла'), 'warning')
  } catch (err) {
    setProgress(null)
    await alertDialog(t('Не удалось открыть файл'), errorText(err))
  }
}
