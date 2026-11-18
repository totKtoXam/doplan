/**
 * Colour themes: a theme is a VS Code colour theme (`type` + `colors` with the workbench keys) that
 * may also carry doplan's own keys. Resolving it gives the CSS tokens of the interface and the
 * palette of the 2D plan; whatever a theme leaves out is derived from what it sets, so a VS Code
 * theme with a handful of colours still covers everything.
 *
 * Overlays: a theme with `"extends": "<id or name of another theme>"` starts from that theme and
 * changes only the colours it lists.
 */
import { DARK, LIGHT, type Palette } from '@/editor2d/theme'
import { contrast, flatten, mix, parseColor, readableOn, toNumber, withAlpha } from './color'

export type ThemeKind = 'dark' | 'light'

/** CSS custom properties of the interface (styles.css), without the leading `--` */
export const UI_TOKENS = [
  'bg',
  'panel',
  'panel-2',
  'panel-3',
  'border',
  'border-strong',
  'text',
  'muted',
  'faint',
  'accent',
  'accent-hover',
  'accent-soft',
  'accent-fg',
  'hover',
  'active',
  'input',
  'danger',
  'warning',
  'success',
  'shadow',
  'viewport',
  'scrollbar',
  'scrollbar-hover',
] as const
export type UiToken = (typeof UI_TOKENS)[number]
export type UiTokens = Record<UiToken, string>

/** a theme as written and stored */
export interface ThemeSource {
  id: string
  name: string
  type: ThemeKind
  /** id or name of the theme this one changes */
  extends?: string
  colors: Record<string, string>
  author?: string
  /** keep the 2D plan colours of doplan 0.14 instead of deriving them from the theme */
  plan?: 'classic'
}

export interface ResolvedTheme {
  id: string
  name: string
  kind: ThemeKind
  ui: UiTokens
  plan: Palette
}

// ───────────── reading theme files ─────────────

/** JSON with comments and trailing commas, as VS Code writes its theme files */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else {
      if (c === '}' || c === ']') {
        // a trailing comma before } or ]: comments are already gone, only white space can follow it
        let j = out.length - 1
        while (j >= 0 && /\s/.test(out[j])) j--
        if (out[j] === ',') out = out.slice(0, j) + out.slice(j + 1)
      }
      out += c
      i++
    }
  }
  return JSON.parse(out.replace(/^﻿/, ''))
}

export class ThemeFileError extends Error {}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'theme'

/** a theme by id or name (case-insensitive) */
export function findTheme(key: string, all: readonly ThemeSource[]): ThemeSource | undefined {
  const k = key.toLowerCase()
  return all.find((p) => p.id.toLowerCase() === k) ?? all.find((p) => p.name.toLowerCase() === k)
}

/**
 * A theme file (VS Code colour theme or a doplan theme, which is the same format) → a theme.
 * `fileName` names the theme when the file has no `name`; `all` are the themes an overlay may
 * extend: a file without "type" takes the kind of its parent unless it sets its own background.
 */
export function themeFromFile(text: string, fileName = 'theme.json', all: readonly ThemeSource[] = []): ThemeSource {
  let json: unknown
  try {
    json = parseJsonc(text)
  } catch {
    throw new ThemeFileError('Файл не похож на тему: это не JSON')
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ThemeFileError('Файл не похож на тему: это не JSON-объект')
  const o = json as Record<string, unknown>
  if (o.contributes && typeof o.contributes === 'object') {
    throw new ThemeFileError('Это package.json расширения. Выберите файл темы из его папки themes')
  }
  const colors: Record<string, string> = {}
  if (o.colors && typeof o.colors === 'object') {
    for (const [k, v] of Object.entries(o.colors as Record<string, unknown>)) if (typeof v === 'string' && parseColor(v)) colors[k] = v
  }
  const ext = typeof o.extends === 'string' ? o.extends : undefined
  if (!Object.keys(colors).length && !ext) {
    throw new ThemeFileError(
      typeof o.include === 'string'
        ? 'В теме нет своих цветов: она подключает другой файл (include). Установите тот файл'
        : 'В файле нет цветов интерфейса (colors)',
    )
  }
  const base = fileName.replace(/\.(json|jsonc)$/i, '').replace(/[-_]color-theme$/i, '')
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : base
  const t = typeof o.type === 'string' ? o.type.toLowerCase() : ''
  const type: ThemeKind =
    t === 'light' || t === 'hc-light' || t === 'hclight' || t === 'vs'
      ? 'light'
      : t === 'dark' || t === 'hc' || t === 'hc-black' || t === 'hcdark' || t === 'vs-dark'
        ? 'dark'
        : (() => {
            const bg = colors['doplan.panel'] ?? colors['sideBar.background'] ?? colors['editor.background']
            if (bg && parseColor(bg)) return contrast(bg, '#000000') > contrast(bg, '#ffffff') ? 'light' : 'dark'
            return (ext && findTheme(ext, all)?.type) || 'dark'
          })()
  return {
    id: `custom-${slug(name)}`,
    name,
    type,
    ...(ext ? { extends: ext } : {}),
    colors,
    ...(typeof o.author === 'string' ? { author: o.author } : {}),
  }
}

/** a theme → the text of a theme file (installable here and readable by VS Code) */
export function themeToFile(t: ThemeSource): string {
  return JSON.stringify({ name: t.name, type: t.type, ...(t.extends ? { extends: t.extends } : {}), colors: t.colors }, null, 2)
}

// ───────────── resolving ─────────────

const SHADOW = { dark: '0 8px 28px rgba(0, 0, 0, 0.45)', light: '0 8px 28px rgba(20, 30, 40, 0.18)' }
const FALLBACK = {
  dark: { panel: '#1a1d21', text: '#e3e6ea', accent: '#4c8dff', danger: '#f05252', warning: '#f0b429', success: '#3ecf8e' },
  light: { panel: '#f8f9fa', text: '#1d2126', accent: '#2f6fe4', danger: '#d93a3a', warning: '#c98a00', success: '#1f9d63' },
}

/** the theme and the ones it extends, base first; unknown or circular parents are skipped */
function chain(t: ThemeSource, all: readonly ThemeSource[]): ThemeSource[] {
  const out: ThemeSource[] = [t]
  let cur = t
  while (cur.extends && out.length < 8) {
    const parent = findTheme(cur.extends, all)
    if (!parent || out.includes(parent)) break
    out.unshift(parent)
    cur = parent
  }
  return out
}

export function resolveTheme(t: ThemeSource, all: readonly ThemeSource[] = []): ResolvedTheme {
  const layers = chain(t, all)
  const colors: Record<string, string> = {}
  for (const l of layers) Object.assign(colors, l.colors)
  const kind = t.type
  const dark = kind === 'dark'
  const fb = FALLBACK[kind]
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) if (parseColor(colors[k])) return colors[k]
    return undefined
  }

  const panel = flatten(get('doplan.panel', 'sideBar.background', 'editor.background') ?? fb.panel, fb.panel)
  const solid = (v: string | undefined) => (v ? flatten(v, panel) : undefined)
  let text = solid(get('doplan.text', 'foreground', 'sideBar.foreground', 'editor.foreground')) ?? fb.text
  if (contrast(text, panel) < 4.5) text = readableOn(panel, '#eeeeee', '#1a1a1a')

  const bg = solid(get('doplan.bg', 'activityBar.background', 'titleBar.activeBackground')) ?? mix(panel, '#000000', dark ? 0.22 : 0.05)
  const viewport = solid(get('doplan.viewport', 'editor.background')) ?? panel
  const mutedC = solid(get('doplan.muted', 'descriptionForeground'))
  const muted = mutedC && contrast(mutedC, panel) >= 3 ? mutedC : mix(text, panel, 0.38)
  const faint = solid(get('doplan.faint')) ?? mix(text, panel, 0.6)

  // the accent: the first candidate that stands out from the panels
  let accent = fb.accent
  let accentFrom = ''
  for (const k of ['doplan.accent', 'button.background', 'focusBorder', 'activityBarBadge.background', 'textLink.foreground']) {
    const v = solid(get(k))
    if (v && contrast(v, panel) >= 1.8) {
      accent = v
      accentFrom = k
      break
    }
  }
  const fromButton = accentFrom === 'button.background'
  const btnFg = fromButton ? solid(get('button.foreground')) : undefined
  const accentFg =
    solid(get('doplan.accent-fg')) ?? (btnFg && contrast(btnFg, accent) >= 3 ? btnFg : readableOn(accent, '#ffffff', mix(panel, '#000000', 0.6)))
  const accentHover =
    solid(get('doplan.accent-hover')) ?? (fromButton ? solid(get('button.hoverBackground')) : undefined) ?? mix(accent, dark ? '#ffffff' : '#000000', dark ? 0.15 : 0.12)

  const borderC = solid(get('doplan.border', 'sideBar.border', 'panel.border', 'editorGroup.border', 'contrastBorder'))
  const border = borderC && contrast(borderC, panel) >= 1.12 && contrast(borderC, panel) < 3 ? borderC : mix(panel, text, 0.12)

  const ui: UiTokens = {
    bg,
    panel,
    'panel-2': solid(get('doplan.panel-2')) ?? mix(panel, text, 0.045),
    'panel-3': solid(get('doplan.panel-3')) ?? mix(panel, text, 0.09),
    border,
    'border-strong': solid(get('doplan.border-strong')) ?? mix(panel, text, 0.2),
    text,
    muted,
    faint,
    accent,
    'accent-hover': accentHover,
    'accent-soft': get('doplan.accent-soft') ?? withAlpha(accent, dark ? 0.18 : 0.13),
    'accent-fg': accentFg,
    hover: get('doplan.hover') ?? withAlpha(text, dark ? 0.07 : 0.06),
    active: get('doplan.active') ?? withAlpha(text, dark ? 0.11 : 0.1),
    input: (() => {
      const fallback = dark ? mix(panel, '#000000', 0.18) : '#ffffff'
      const v = solid(get('doplan.input', 'input.background'))
      // the fields show the interface text: a light field in a dark theme (or the reverse) is dropped
      return v && contrast(text, v) >= 4.5 ? v : fallback
    })(),
    danger: solid(get('doplan.danger', 'errorForeground', 'editorError.foreground')) ?? fb.danger,
    warning: solid(get('doplan.warning', 'editorWarning.foreground')) ?? fb.warning,
    success: solid(get('doplan.success', 'terminal.ansiGreen', 'gitDecoration.addedResourceForeground')) ?? fb.success,
    shadow: SHADOW[kind],
    viewport,
    scrollbar: mix(panel, text, 0.22),
    'scrollbar-hover': mix(panel, text, 0.32),
  }

  const classic = layers.some((l) => l.plan === 'classic')
  return { id: t.id, name: t.name, kind, ui, plan: planPalette(kind, ui, colors, classic) }
}

/**
 * The 2D plan palette in the colours of the interface. The plan is drawn on the viewport colour
 * (editor.background), which may be light in a dark theme or the reverse: then the plan is built as a
 * plan of that other kind, and its text is made readable on the viewport.
 */
function planPalette(kind: ThemeKind, ui: UiTokens, colors: Record<string, string>, classic: boolean): Palette {
  const bg = ui.viewport
  const planKind: ThemeKind = classic ? kind : contrast(bg, '#000000') > contrast(bg, '#ffffff') ? 'light' : 'dark'
  const base = planKind === 'dark' ? DARK : LIGHT
  const p: Palette = { ...base }
  if (!classic) {
    const dark = planKind === 'dark'
    const text = contrast(ui.text, bg) >= 4.5 ? ui.text : readableOn(bg, '#eeeeee', '#1a1a1a')
    const mutedPlan = contrast(ui.muted, bg) >= 3 ? ui.muted : mix(text, bg, 0.38)
    const N = toNumber
    p.bg = N(bg)
    p.gap = dark ? N(bg) : N(mix(bg, '#ffffff', 0.7))
    p.roomDefault = dark ? N(mix(bg, text, 0.07)) : N(mix(bg, '#ffffff', 0.75))
    p.gridMinor = N(text)
    p.gridMajor = N(text)
    p.text = N(text)
    p.textMuted = N(mutedPlan)
    p.dim = N(mix(text, bg, dark ? 0.1 : 0.08))
    p.dimAuto = N(mix(text, bg, 0.45))
    p.accent = N(ui.accent)
    p.handleStroke = N(ui.accent)
    p.hover = N(mix(ui.accent, dark ? '#ffffff' : bg, 0.35))
    p.wall = N(mix(text, bg, dark ? 0.12 : 0.2))
    p.wallStroke = N(mix(text, dark ? '#ffffff' : '#000000', dark ? 0.4 : 0.35))
    p.partition = N(mix(text, bg, dark ? 0.4 : 0.5))
    p.parapet = N(mix(text, bg, dark ? 0.6 : 0.72))
    p.virtual = N(mix(text, bg, dark ? 0.4 : 0.5))
    p.opening = N(dark ? mix(text, '#ffffff', 0.25) : text)
    p.itemFill = N(mutedPlan)
    p.itemStroke = N(mix(text, bg, dark ? 0.28 : 0.25))
    p.itemSketch = N(mix(text, bg, 0.4))
    const badge = dark ? mix(bg, '#000000', 0.45) : mix(text, '#000000', 0.2)
    p.badgeBg = N(badge)
    p.badgeText = N(readableOn(badge))
    p.lightOff = N(mutedPlan)
    p.underlayFrame = N(mix(text, bg, 0.5))
    p.danger = N(ui.danger)
    p.ok = N(ui.success)
    p.warn = N(ui.warning)
  }
  // explicit plan colours: "doplan.plan.wall": "#…"
  for (const [k, v] of Object.entries(colors)) {
    if (!k.startsWith('doplan.plan.')) continue
    const key = k.slice('doplan.plan.'.length) as keyof Palette
    if (key in p && typeof p[key] === 'number' && !key.endsWith('Alpha') && key !== 'roomMix') {
      const c = parseColor(v)
      if (c) (p[key] as number) = toNumber(flatten(v, ui.viewport))
    }
  }
  return p
}
