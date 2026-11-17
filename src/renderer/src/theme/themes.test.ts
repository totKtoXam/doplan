import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from './builtin'
import { contrast, parseColor } from './color'
import { resolveTheme, themeFromFile, themeToFile, UI_TOKENS } from './themes'

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
    expect(t.type).toBe('dark')
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
})
