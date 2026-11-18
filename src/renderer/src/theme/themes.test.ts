import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from './builtin'
import { contrast, parseColor } from './color'
import { gridKey } from '@/editor2d/layers/grid'
import { parseJsonc, resolveTheme, themeFromFile, themeKind, themeToFile, UI_TOKENS, type ThemeSource } from './themes'

describe('colour themes', () => {
  it('has at least ten VS Code themes besides its own, with unique ids', () => {
    expect(BUILTIN_THEMES.filter((t) => t.id.startsWith('vscode-')).length).toBeGreaterThanOrEqual(10)
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(BUILTIN_THEMES.length)
    expect(BUILTIN_THEMES.find((t) => t.id === DEFAULT_DARK_ID)?.type).toBe('dark')
    expect(BUILTIN_THEMES.find((t) => t.id === DEFAULT_LIGHT_ID)?.type).toBe('light')
  })

  it('every built-in theme resolves to every token, with readable text and a visible accent', () => {
    for (const t of BUILTIN_THEMES) {
      const r = resolveTheme(t, BUILTIN_THEMES)
      for (const k of UI_TOKENS) expect(r.ui[k], `${t.id} ${k}`).toBeTruthy()
      for (const k of UI_TOKENS) if (!['accent-soft', 'hover', 'active', 'shadow'].includes(k)) expect(parseColor(r.ui[k]), `${t.id} ${k}`).toBeDefined()
      expect(contrast(r.ui.text, r.ui.panel), t.id).toBeGreaterThanOrEqual(4.5)
      expect(contrast(r.ui.muted, r.ui.panel), t.id).toBeGreaterThanOrEqual(3)
      expect(contrast(r.ui.accent, r.ui.panel), t.id).toBeGreaterThanOrEqual(1.8)
      expect(contrast(r.ui['accent-fg'], r.ui.accent), t.id).toBeGreaterThanOrEqual(3)
      expect(r.plan.bg).toBe(t.plan === 'classic' ? r.plan.bg : Number.parseInt(r.ui.viewport.slice(1), 16))
      // the plan of a built-in theme is drawn as a plan of the theme's own kind
      expect(contrast(r.ui.viewport, '#000000') > contrast(r.ui.viewport, '#ffffff') ? 'light' : 'dark', t.id).toBe(t.type)
    }
  })

  it('reads a VS Code theme file with comments and trailing commas', () => {
    const text = `// a theme
    {
      "name": "My Theme",
      "type": "light",
      /* workbench */
      "colors": {
        "editor.background": "#fafafa",
        "sideBar.background": "#f0f0f0", // the panels
        "foreground": "#333333",
        "button.background": "#c2185b",
        "button.foreground": "#ffffff",
        "not.a.colour": "bold",
      },
      "tokenColors": [],
    }`
    const t = themeFromFile(text, 'my-theme-color-theme.json')
    expect(t).toMatchObject({ id: 'custom-my-theme', name: 'My Theme', type: 'light' })
    expect(t.colors['not.a.colour']).toBeUndefined()
    const r = resolveTheme(t)
    expect(r.kind).toBe('light')
    expect(r.ui.panel).toBe('#f0f0f0')
    expect(r.ui.viewport).toBe('#fafafa')
    expect(r.ui.accent).toBe('#c2185b')
    expect(r.ui['accent-fg']).toBe('#ffffff')
  })

  it('guesses the kind from the background and names the theme after the file', () => {
    const t = themeFromFile('{"colors":{"editor.background":"#101010"}}', 'night_owl.json')
    expect(t.name).toBe('night_owl')
    expect(t.type).toBeUndefined()
    expect(themeKind(t)).toBe('dark')
    expect(themeKind(themeFromFile('{"colors":{"editor.background":"#fdfdfd"}}'))).toBe('light')
  })

  it('explains files that are not themes', () => {
    expect(() => themeFromFile('not json')).toThrow(/не JSON/)
    expect(() => themeFromFile('{"contributes":{"themes":[]}}')).toThrow(/package\.json/)
    expect(() => themeFromFile('{"include":"./base.json"}')).toThrow(/include/)
    expect(() => themeFromFile('{"tokenColors":[]}')).toThrow(/colors/)
  })

  it('an overlay changes only what it lists and keeps the rest of the theme it extends', () => {
    const overlay = themeFromFile('{"name":"Nord, red accent","type":"dark","extends":"Nord","colors":{"doplan.accent":"#bf616a"}}')
    const all = [...BUILTIN_THEMES, overlay]
    const nord = resolveTheme(BUILTIN_THEMES.find((t) => t.name === 'Nord')!, all)
    const r = resolveTheme(overlay, all)
    expect(r.ui.accent).toBe('#bf616a')
    expect(r.ui.panel).toBe(nord.ui.panel)
    expect(r.ui.text).toBe(nord.ui.text)
  })

  it('a saved theme installs back as the same theme', () => {
    const src = BUILTIN_THEMES.find((t) => t.id === 'vscode-dracula')!
    const back = themeFromFile(themeToFile(src))
    expect(resolveTheme(back).ui).toEqual(resolveTheme(src).ui)
  })

  it('plan colours can be set directly', () => {
    const t = themeFromFile('{"type":"dark","colors":{"editor.background":"#202020","doplan.plan.wall":"#ff0000"}}')
    expect(resolveTheme(t).plan.wall).toBe(0xff0000)
  })

  it('an overlay without "type" takes the kind of the theme it extends', () => {
    const all = (...t: ThemeSource[]) => [...BUILTIN_THEMES, ...t]
    const light = themeFromFile('{"name":"My Light","extends":"Light Modern","colors":{"button.background":"#cc0000"}}')
    const r = resolveTheme(light, all(light))
    expect(r.kind).toBe('light')
    expect(r.ui.accent).toBe('#cc0000')
    // by id too; its own panel colour decides; an unknown parent: dark
    const byId = themeFromFile('{"extends":"vscode-dracula","colors":{}}')
    expect(themeKind(byId, all(byId))).toBe('dark')
    const ownPanel = themeFromFile('{"extends":"Dracula","colors":{"sideBar.background":"#fafafa"}}')
    expect(themeKind(ownPanel, all(ownPanel))).toBe('light')
    expect(themeKind(themeFromFile('{"extends":"Nope","colors":{}}'), BUILTIN_THEMES)).toBe('dark')
  })

  it('a plan background alone does not change the kind of an overlay: the panels come from the parent', () => {
    const white = themeFromFile('{"name":"Dark White Plan","extends":"Dark Modern","colors":{"editor.background":"#ffffff"}}')
    const r = resolveTheme(white, [...BUILTIN_THEMES, white])
    expect(r.kind).toBe('dark')
    expect(r.ui.viewport).toBe('#ffffff')
    const black = themeFromFile('{"extends":"Light Modern","colors":{"editor.background":"#1e1e1e"}}')
    expect(resolveTheme(black, [...BUILTIN_THEMES, black]).kind).toBe('light')
  })

  it('the kind of an overlay follows its parent: reinstalled with another kind, or installed after it', () => {
    const child = themeFromFile('{"name":"Child","extends":"Base","colors":{"button.background":"#cc0000"}}')
    const darkBase = themeFromFile('{"name":"Base","type":"dark","colors":{"sideBar.background":"#202020"}}')
    const lightBase = themeFromFile('{"name":"Base","type":"light","colors":{"sideBar.background":"#fafafa","editor.background":"#ffffff"}}')
    expect(resolveTheme(child, [...BUILTIN_THEMES, darkBase, child]).kind).toBe('dark')
    const r = resolveTheme(child, [...BUILTIN_THEMES, lightBase, child])
    expect(r.kind).toBe('light')
    expect(r.ui.hover).toBe(resolveTheme(lightBase, [...BUILTIN_THEMES, lightBase]).ui.hover)
    // the child alone (parent not installed yet) is dark; once the parent comes, it is light
    expect(themeKind(child, BUILTIN_THEMES)).toBe('dark')
    expect(themeKind(child, [lightBase])).toBe('light')
    // a saved overlay keeps no frozen kind
    expect(JSON.parse(themeToFile(child)).type).toBeUndefined()
    // circular overlays end
    const x = themeFromFile('{"name":"X","extends":"Y","colors":{}}')
    const y = themeFromFile('{"name":"Y","extends":"X","colors":{}}')
    expect(themeKind(x, [x, y])).toBe('dark')
  })

  it('the plan is readable on a viewport of the other kind', () => {
    const t = themeFromFile('{"type":"dark","colors":{"sideBar.background":"#1e1e1e","editor.background":"#ffffff","foreground":"#cccccc"}}')
    const r = resolveTheme(t)
    expect(r.ui.viewport).toBe('#ffffff')
    const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
    expect(contrast(hex(r.plan.text), '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hex(r.plan.wall), '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(contrast(hex(r.plan.dim), '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(contrast(hex(r.plan.textMuted), '#ffffff')).toBeGreaterThanOrEqual(3)
    // the interface itself keeps the theme's text on its dark panels
    expect(r.ui.text).toBe('#cccccc')
  })

  it('every surface the text is written on keeps it readable', () => {
    const cases = [
      '{"type":"dark","colors":{"sideBar.background":"#1e1e1e","input.background":"#f0f0f0"}}',
      '{"type":"light","colors":{"sideBar.background":"#f3f3f3","activityBar.background":"#2c2c2c","foreground":"#333333"}}',
      '{"type":"dark","colors":{"sideBar.background":"#1e1e1e","activityBar.background":"#f0f0f0","foreground":"#cccccc"}}',
      '{"type":"light","colors":{"sideBar.background":"#f3f3f3","titleBar.activeBackground":"#3c3c3c"}}',
      '{"type":"dark","colors":{"sideBar.background":"#1e1e1e","doplan.panel-2":"#eeeeee","doplan.panel-3":"#dddddd"}}',
    ]
    const surfaces = ['bg', 'panel', 'panel-2', 'panel-3', 'input'] as const
    for (const c of cases) {
      const r = resolveTheme(themeFromFile(c))
      for (const k of surfaces) expect(contrast(r.ui.text, r.ui[k]), `${c} ${k}`).toBeGreaterThanOrEqual(4.5)
    }
    // the same for every built-in theme
    for (const t of BUILTIN_THEMES) {
      const r = resolveTheme(t, BUILTIN_THEMES)
      for (const k of surfaces) expect(contrast(r.ui.text, r.ui[k]), `${t.id} ${k}`).toBeGreaterThanOrEqual(4.5)
    }
    const ok = resolveTheme(themeFromFile('{"type":"dark","colors":{"sideBar.background":"#1e1e1e","input.background":"#3c3c3c"}}'))
    expect(ok.ui.input).toBe('#3c3c3c')
  })

  it('the grid is redrawn when a theme changes its lines but keeps the background', () => {
    const base = BUILTIN_THEMES.find((t) => t.name === 'Dark Modern')!
    const amber = themeFromFile('{"name":"Amber","type":"dark","extends":"Dark Modern","colors":{"foreground":"#ffb000"}}')
    const a = resolveTheme(base, BUILTIN_THEMES).plan
    const b = resolveTheme(amber, [...BUILTIN_THEMES, amber]).plan
    expect(b.bg).toBe(a.bg)
    const cam = { version: 1, width: 800, height: 600 }
    expect(gridKey(cam, 100, b)).not.toBe(gridKey(cam, 100, a))
    expect(gridKey(cam, 100, a)).toBe(gridKey(cam, 100, { ...a }))
  })

  it('trailing commas go, commas inside strings stay', () => {
    expect(parseJsonc('{"name":"a, }","colors":{"x":"#fff",},}')).toEqual({ name: 'a, }', colors: { x: '#fff' } })
    expect(parseJsonc('{"name":"Night, ]", // c\n "l": [1, 2, /* x */ ], }')).toEqual({ name: 'Night, ]', l: [1, 2] })
    // an escaped quote does not end the string
    expect(parseJsonc('{"s":"a \\", , }"}')).toEqual({ s: 'a ", , }' })
    expect(themeFromFile('{"name":"a, }","colors":{"editor.background":"#fff"}}').name).toBe('a, }')
  })
})
