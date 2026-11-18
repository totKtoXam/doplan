import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import type { Doc } from '@core/types'

// Startup: the welcome screen instead of the sample; skipped when the app was launched to open a file;
// closed by whatever document gets loaded (an opened project, the sample, a restored crash copy).

const fake = vi.hoisted(() => {
  const state = { launchFile: false, launchFails: false, thumbs: [] as [string, string | null][] }
  const fallback = (o: Record<string, unknown>) => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  const api = {
    platform: 'win32',
    recent: {
      launch: async () => {
        if (state.launchFails) throw new Error('no main')
        const file = state.launchFile
        state.launchFile = false // main answers true only once
        return { file }
      },
      setThumb: async (path: string, svg: string | null) => void state.thumbs.push([path, svg]),
      list: async () => [],
      remove: async () => {},
    },
  }
  return { state, api: new Proxy(api as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : fallback({})) }) }
})

vi.mock('@/store/api', () => ({ api: fake.api }))
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))

const { docStore } = await import('@/store/document')
const { projectStore } = await import('@/store/project')
const { welcomeStore, showWelcome, hideWelcome, welcomeBlocksMenu, welcomeBlocksKey, runFileOpen } = await import('@/store/welcome')
const { makeEditorInert } = await import('./inert')
const { prepareStartup } = await import('./startup')
const { planThumbSvg } = await import('./thumbnail')
const { buildSampleApartment } = await import('@/store/sample')
const { formatWhen, parentOf } = await import('./format')

const open = () => welcomeStore.getState().open

beforeEach(() => {
  hideWelcome()
  fake.state.launchFile = false
  fake.state.launchFails = false
  fake.state.thumbs.length = 0
  projectStore.setState({ viewing: null })
})

describe('startup', () => {
  it('shows the welcome screen over an empty plan, not the sample', async () => {
    expect(await prepareStartup()).toBe('welcome')
    expect(open()).toBe(true)
    expect(welcomeStore.getState().canClose).toBe(false)
    const { doc, filePath, dirty } = docStore.getState()
    expect(filePath).toBeNull()
    expect(dirty).toBe(false)
    expect(Object.keys(doc.walls)).toHaveLength(0)
  })

  it('skips it when launched to open a file (double click, command line)', async () => {
    fake.state.launchFile = true
    expect(await prepareStartup()).toBe('file')
    expect(open()).toBe(false)
    // a reload of the page afterwards is no launch any more
    expect(await prepareStartup()).toBe('welcome')
  })

  it('still shows it when main cannot tell', async () => {
    fake.state.launchFails = true
    expect(await prepareStartup()).toBe('welcome')
    expect(open()).toBe(true)
  })

  it('closes once a document is loaded: an opened project, the sample or a restored crash copy', async () => {
    await prepareStartup()
    docStore.getState().load(createEmptyDoc('Восстановленный'), null)
    expect(open()).toBe(false)
    showWelcome(true)
    docStore.getState().load(createEmptyDoc('Проект'), 'C:/p/Проект')
    expect(open()).toBe(false)
  })
})

describe('the file the app was launched to open', () => {
  it('a launch file that does not open brings the start screen instead of a blank editor', async () => {
    fake.state.launchFile = true
    expect(await prepareStartup()).toBe('file')
    expect(open()).toBe(false)
    await runFileOpen(async () => {
      throw new Error('broken .doplan')
    })
    expect(open()).toBe(true)
    expect(welcomeStore.getState().canClose).toBe(false)
  })

  it('also when it opens to nothing (a cancelled import question)', async () => {
    fake.state.launchFile = true
    await prepareStartup()
    await runFileOpen(async () => {})
    expect(open()).toBe(true)
  })

  it('stays away when the launch file opens', async () => {
    fake.state.launchFile = true
    await prepareStartup()
    await runFileOpen(async () => docStore.getState().load(createEmptyDoc('Квартира'), 'C:/p/Квартира.doplan'))
    expect(open()).toBe(false)
    // later opens sent by a second instance are not launches: a failed one keeps the editor
    await runFileOpen(async () => {
      throw new Error('broken')
    })
    expect(open()).toBe(false)
  })
})

describe('the document behind the screen', () => {
  it('a change to it (a dropped image or PlanSpec, a file from a second instance) closes the screen', async () => {
    await prepareStartup()
    expect(open()).toBe(true)
    docStore.getState().transact('underlay', (d) => void (d.meta.name = 'С подложкой'))
    expect(open()).toBe(false)
    showWelcome(true)
    docStore.getState().transact('level', (d) => void (d.meta.name = 'С этажом'))
    expect(open()).toBe(false)
  })

  it('the editor is out of reach while the screen is up, and back after', () => {
    type El = { inert: boolean; previousElementSibling: El | null }
    const topBar: El = { inert: false, previousElementSibling: null }
    const panels: El = { inert: false, previousElementSibling: topBar }
    const statusBar: El = { inert: true, previousElementSibling: panels } // inert already: left as it was
    const screen: El = { inert: false, previousElementSibling: statusBar }
    const undo = makeEditorInert(screen)
    expect([topBar.inert, panels.inert, statusBar.inert, screen.inert]).toEqual([true, true, true, false])
    undo()
    expect([topBar.inert, panels.inert, statusBar.inert]).toEqual([false, false, true])
  })
})

describe('welcome screen from the menu', () => {
  it('can go back to the project it was opened over, but not at startup', async () => {
    showWelcome(true)
    expect(welcomeStore.getState().canClose).toBe(true)
    hideWelcome()
    await prepareStartup()
    showWelcome(true) // Файл → Начальный экран while it is already shown at startup
    expect(welcomeStore.getState().canClose).toBe(false)
  })

  it('lets only the commands that make sense there through', () => {
    expect(welcomeBlocksMenu('save')).toBe(false) // closed: everything goes
    showWelcome(true)
    for (const cmd of ['new', 'open', 'openFolder', 'settings', 'about', 'welcome'] as const) expect(welcomeBlocksMenu(cmd)).toBe(false)
    for (const cmd of ['save', 'saveAs', 'undo', 'exportPng', 'view3d', 'delete'] as const) expect(welcomeBlocksMenu(cmd)).toBe(true)
    expect(welcomeBlocksKey(true, 'n')).toBe(false)
    expect(welcomeBlocksKey(true, 'o')).toBe(false)
    expect(welcomeBlocksKey(true, 's')).toBe(true)
    expect(welcomeBlocksKey(false, 'w')).toBe(true)
  })
})

describe('plan thumbnails', () => {
  it('draws the first level of a plan, none for an empty one', () => {
    const svg = planThumbSvg(buildSampleApartment('Пример') as Doc)
    expect(svg).toMatch(/^<svg[\s>]/)
    expect(svg!.length).toBeLessThan(400 * 1024)
    expect(planThumbSvg(createEmptyDoc('Пусто'))).toBeNull()
  })

  it('goes to main after a project is opened, not for an old version', async () => {
    vi.useFakeTimers()
    try {
      await prepareStartup()
      docStore.getState().load(buildSampleApartment('Квартира') as Doc, 'C:/p/Квартира')
      await vi.advanceTimersByTimeAsync(700)
      expect(fake.state.thumbs.map(([p]) => p)).toEqual(['C:/p/Квартира'])
      projectStore.setState({ viewing: { sha: 'a', short: 'a', message: 'm', date: '', author: '' } as never })
      docStore.getState().load(buildSampleApartment('Квартира') as Doc, 'C:/p/Квартира')
      await vi.advanceTimersByTimeAsync(700)
      expect(fake.state.thumbs).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is dropped when the plan has become empty', async () => {
    vi.useFakeTimers()
    try {
      await prepareStartup()
      docStore.getState().load(buildSampleApartment('Квартира') as Doc, 'C:/p/Квартира')
      await vi.advanceTimersByTimeAsync(700)
      docStore.getState().load(createEmptyDoc('Квартира'), 'C:/p/Квартира')
      await vi.advanceTimersByTimeAsync(700)
      expect(fake.state.thumbs.map(([p, svg]) => [p, svg === null ? null : 'svg'])).toEqual([
        ['C:/p/Квартира', 'svg'],
        ['C:/p/Квартира', null],
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('texts', () => {
  const t = (k: string, v?: Record<string, string | number>) => k.replace('{time}', String(v?.time))
  it('says today / yesterday, else the date', () => {
    const now = new Date(2026, 10, 18, 15, 0)
    expect(formatWhen(new Date(2026, 10, 18, 9, 5).toISOString(), 'ru', t, now)).toMatch(/^сегодня, 09:05$/)
    expect(formatWhen(new Date(2026, 10, 17, 23, 30).toISOString(), 'ru', t, now)).toMatch(/^вчера, 23:30$/)
    expect(formatWhen(new Date(2026, 2, 3).toISOString(), 'en', t, now)).toMatch(/3 Mar 2026/)
    expect(formatWhen('garbage', 'ru', t, now)).toBe('')
  })

  it('shows the folder a project lives in', () => {
    expect(parentOf('C:\\Users\\me\\Documents\\doplan\\Квартира')).toBe('C:\\Users\\me\\Documents\\doplan')
    expect(parentOf('/home/me/plan.doplan')).toBe('/home/me')
  })
})
