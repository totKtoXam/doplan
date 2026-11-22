// The AI chat lives in the «ИИ» section of the left panel: its own width, every entry point opens
// that section, and a chat left open in the old right-dock tab opens there after the update.
import { afterEach, describe, expect, it, vi } from 'vitest'

function fakeStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

/** fresh layout + ui stores over the given saved values */
async function boot(init: Record<string, string>) {
  vi.resetModules()
  const storage = fakeStorage(init)
  vi.stubGlobal('localStorage', storage)
  const layout = await import('./layout')
  const { uiStore } = await import('./ui')
  return { ...layout, uiStore, storage }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const saved = (o: object) => JSON.stringify(o)

describe('the «ИИ» section of the left panel', () => {
  it('keeps a width of its own, wider than a catalogue', async () => {
    const { layoutStore, leftPanelFor, PANELS } = await boot({ 'doplan.layout': saved({ sizes: { left: 280, chat: 520 } }) })
    expect(leftPanelFor('ai')).toBe('chat')
    expect(leftPanelFor('build')).toBe('left')
    expect(leftPanelFor('objects')).toBe('left')
    expect(PANELS.chat.minSize).toBeGreaterThan(PANELS.left.minSize)
    expect(layoutStore.getState().sizes).toMatchObject({ left: 280, chat: 520 })
    layoutStore.getState().setSize('chat', 10)
    expect(layoutStore.getState().sizes.chat).toBe(PANELS.chat.minSize)
    expect(layoutStore.getState().sizes.left).toBe(280)
  })

  it('a layout without a chat width gets the default one', async () => {
    const { layoutStore, PANELS } = await boot({ 'doplan.layout': saved({ sizes: { left: 280 } }) })
    expect(layoutStore.getState().sizes.chat).toBe(PANELS.chat.defaultSize)
  })

  it('is remembered as the open section', async () => {
    const { layoutStore } = await boot({ 'doplan.layout': saved({ section: 'ai', leftOpen: true }) })
    expect(layoutStore.getState().section).toBe('ai')
  })
})

describe('a layout saved with the chat in the right dock', () => {
  it('dockTab «ai»: the chat opens in the left panel, the old key is forgotten', async () => {
    const { layoutStore, uiStore, storage } = await boot({
      'doplan.layout': saved({ section: 'furniture', leftOpen: false, rightOpen: true }),
      'doplan.ai.dockTab': 'ai',
    })
    expect(layoutStore.getState().section).toBe('ai')
    expect(uiStore.getState().leftPanelOpen).toBe(true)
    expect(uiStore.getState().rightPanelOpen).toBe(true)
    expect(storage.getItem('doplan.ai.dockTab')).toBeNull()
  })

  it('dockTab «ai» behind a closed right panel: nothing changes', async () => {
    const { layoutStore, uiStore, storage } = await boot({
      'doplan.layout': saved({ section: 'furniture', leftOpen: false, rightOpen: false }),
      'doplan.ai.dockTab': 'ai',
    })
    expect(layoutStore.getState().section).toBe('furniture')
    expect(uiStore.getState().leftPanelOpen).toBe(false)
    expect(storage.getItem('doplan.ai.dockTab')).toBeNull()
  })

  it('dockTab «props»: the left section stays as it was', async () => {
    const { layoutStore, uiStore, storage } = await boot({
      'doplan.layout': saved({ section: 'lights', leftOpen: true, rightOpen: true }),
      'doplan.ai.dockTab': 'props',
    })
    expect(layoutStore.getState().section).toBe('lights')
    expect(uiStore.getState().leftPanelOpen).toBe(true)
    expect(storage.getItem('doplan.ai.dockTab')).toBeNull()
  })

  it('an unknown section falls back to «Строить»', async () => {
    const { layoutStore } = await boot({ 'doplan.layout': saved({ section: 'chat' }) })
    expect(layoutStore.getState().section).toBe('build')
  })
})

describe('entry points of the chat', () => {
  it('showChat / focusChat / addQuote open the «ИИ» section and a hidden left panel, the right panel stays', async () => {
    const { layoutStore, uiStore } = await boot({ 'doplan.layout': saved({ section: 'furniture', leftOpen: false, rightOpen: false }) })
    const ai = await import('@/ai/store')
    ai.showChat()
    expect(layoutStore.getState().section).toBe('ai')
    expect(uiStore.getState().leftPanelOpen).toBe(true)
    expect(uiStore.getState().rightPanelOpen).toBe(false)

    layoutStore.getState().setSection('build')
    uiStore.setState({ leftPanelOpen: false })
    const tick = ai.aiStore.getState().focusTick
    ai.focusChat()
    expect(layoutStore.getState().section).toBe('ai')
    expect(uiStore.getState().leftPanelOpen).toBe(true)
    expect(ai.aiStore.getState().focusTick).toBe(tick + 1)

    layoutStore.getState().setSection('objects')
    ai.addQuote('несущая стена')
    expect(layoutStore.getState().section).toBe('ai')
    expect(ai.aiStore.getState().quotes.map((q) => q.text)).toEqual(['несущая стена'])

    layoutStore.getState().setSection('materials')
    ai.addSelectionToChat()
    expect(layoutStore.getState().section).toBe('ai')
  })
})
