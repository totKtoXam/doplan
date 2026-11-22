import { describe, expect, it } from 'vitest'
import { addRectRoom, builtinCatalog, createEmptyDoc, derivePlan, DOC_VERSION_V5, syncRooms } from '@core'
import type { Catalog } from '@core/types'
import { parseToolArgs, toolJsonSchema } from '@shared/aiTools'
import { docStore } from '@/store/document'
import './i18n'
import { describeCall, executeTool, isMutating, type ToolHost } from './tools'

const catalog: Catalog = builtinCatalog()
const st = () => docStore.getState()
const host: ToolHost = {
  doc: () => st().doc,
  derived: (lv) => derivePlan(st().doc, lv),
  activeLevelId: () => st().doc.levelOrder[0],
  selection: () => [],
  catalog: () => catalog,
  mutate: (label, fn) => st().transact(label, fn),
  snapshot: async () => ({ mime: 'image/png', data: '' }),
}

function load() {
  const doc = createEmptyDoc('Квартира')
  const lv = doc.levelOrder[0]
  addRectRoom(doc, lv, 0, 0, 4000, 3000, {})
  syncRooms(doc)
  st().load(doc, null)
}

describe('technical project AI tools', () => {
  it('are registered with schemas; only the build tool changes the document', () => {
    expect(parseToolArgs('get_tech_project', {}).ok).toBe(true)
    expect(parseToolArgs('build_tech_project', { sheets: ['title', 'nope'] }).ok).toBe(false)
    expect(parseToolArgs('build_tech_project', { stage: 'Р', scales: { measure: 50, floors: null } }).ok).toBe(true)
    expect((toolJsonSchema('build_tech_project') as { properties: Record<string, unknown> }).properties.sheets).toBeTruthy()
    expect(isMutating('build_tech_project')).toBe(true)
    expect(isMutating('get_tech_project')).toBe(false)
  })

  it('reads the album and sets it up: sheets in order, stage, survey fix (format 5), one undo step', async () => {
    load()
    const read = await executeTool(host, 'get_tech_project', {})
    expect(read.result.ok).toBe(true)
    expect(read.result.text).toContain('Обмер не зафиксирован')
    expect(read.result.text).toContain('Штамп без личных данных')

    const res = await executeTool(host, 'build_tech_project', { sheets: ['title', 'measure', 'finishes'], stage: 'ЭП', code: 'ДП-1', fixSurvey: true })
    expect(res.result.ok).toBe(true)
    const text = res.result.text
    expect(text).toMatch(/1\. Титульный лист/)
    expect(text).toMatch(/2\. Обмерный план/)
    expect(text).toMatch(/3\. Ведомость отделки помещений/)
    expect(text).toContain('шифр ДП-1')
    expect(text).toContain('Обмер зафиксирован')
    expect(st().doc.techProject?.baseline).toBeTruthy()
    expect(st().doc.version).toBe(DOC_VERSION_V5)
    expect(describeCall('build_tech_project', { fixSurvey: true })).toContain('обмер')

    st().undo()
    expect(st().doc.techProject).toBeUndefined()
  })

  it('refuses unknown rooms and levels', async () => {
    load()
    const r = await executeTool(host, 'build_tech_project', { elevationRooms: ['r_none'] })
    expect(r.result.ok).toBe(false)
    expect(r.result.text).toContain('r_none')
  })
})
