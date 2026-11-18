import { describe, expect, it, vi } from 'vitest'

// the store applies the theme to <html>; under node give it a minimal one so uiStore follows the kind
const html = { style: { setProperty: () => {}, colorScheme: '' }, dataset: {} as Record<string, string> }
vi.stubGlobal('document', { documentElement: html })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
vi.mock('@/store/api', () => {
  const fallback = (o: Record<string, unknown> = {}): unknown => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  return { api: fallback({ platform: 'win32', aiChat: fallback({ onEvent: () => () => {} }), settings: fallback(), project: fallback() }) }
})

const { uiStore } = await import('@/store/ui')
const { themeStore } = await import('./store')
const { themeFromFile } = await import('./themes')
const { DEFAULT_DARK_ID } = await import('./builtin')

const installFile = (text: string) => {
  const t = themeFromFile(text, 'Foo.json', themeStore.getState().all())
  themeStore.getState().install([t])
  themeStore.getState().select(t.id)
  return t
}

describe('theme store', () => {
  it('a theme reinstalled with another kind leaves the sun/moon toggle working', () => {
    installFile('{"name":"Foo","type":"dark","colors":{"editor.background":"#101010"}}')
    expect(themeStore.getState().preferred.dark).toBe('custom-foo')
    installFile('{"name":"Foo","type":"light","colors":{"editor.background":"#fafafa"}}')
    const s = themeStore.getState()
    expect(s.preferred).toEqual({ dark: DEFAULT_DARK_ID, light: 'custom-foo' })
    expect(uiStore.getState().theme).toBe('light')

    // the toggle: to dark and back
    uiStore.getState().setTheme('dark')
    expect(themeStore.getState().resolved.kind).toBe('dark')
    expect(uiStore.getState().theme).toBe('dark')
    expect(html.dataset.theme).toBe('dark')
    uiStore.getState().setTheme('light')
    expect(themeStore.getState().activeId).toBe('custom-foo')
  })

  it('reinstalling the theme in use with another kind, without selecting it, switches the kind', () => {
    installFile('{"name":"Bar","type":"light","colors":{"editor.background":"#fafafa"}}')
    const t = themeFromFile('{"name":"Bar","type":"dark","colors":{"editor.background":"#101010"}}', 'Bar.json')
    themeStore.getState().install([t])
    const s = themeStore.getState()
    expect(s.resolved.kind).toBe('dark')
    expect(s.preferred.dark).toBe('custom-bar')
    expect(s.preferred.light).not.toBe('custom-bar')
    expect(uiStore.getState().theme).toBe('dark')
  })
})
