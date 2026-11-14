/** Small HTML overlays owned by the editor: inline text prompt and the right-click context menu. */
import type { ContextMenuItem } from './context'

export interface PromptOptions {
  /** CSS px relative to the editor root */
  x: number
  y: number
  value?: string
  placeholder?: string
  /** identifies what is being edited (e.g. `label:<id>`) so layers can hide the original */
  key?: string
  width?: number
  /** small caption shown above the field */
  title?: string
  onCommit(text: string): void
  onCancel?(): void
}

const PANEL_CSS =
  'position:absolute;z-index:30;background:var(--panel,#23262d);color:var(--text,#e8ebf0);' +
  'border:1px solid var(--border,#3a3f4a);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);' +
  'font:13px/1.3 Inter,"Segoe UI",system-ui,sans-serif;'

export class HtmlOverlay {
  /** key of the entity being edited inline, if any */
  editingKey: string | null = null
  private promptEl: HTMLDivElement | null = null
  private promptOpts: PromptOptions | null = null
  private menuEl: HTMLDivElement | null = null
  private menuCleanup: (() => void) | null = null

  constructor(
    private root: HTMLElement,
    private onChange: () => void,
  ) {}

  get promptOpen(): boolean {
    return !!this.promptEl
  }

  get menuOpen(): boolean {
    return !!this.menuEl
  }

  prompt(opts: PromptOptions): void {
    this.closePrompt(false)
    this.closeMenu()
    const box = document.createElement('div')
    box.style.cssText = `${PANEL_CSS}padding:6px;display:flex;flex-direction:column;gap:4px;`
    if (opts.title) {
      const cap = document.createElement('div')
      cap.textContent = opts.title
      cap.style.cssText = 'font-size:11px;color:var(--muted,#9aa3b2);padding:0 2px;white-space:nowrap;'
      box.appendChild(cap)
    }
    const input = document.createElement('input')
    input.type = 'text'
    input.value = opts.value ?? ''
    input.placeholder = opts.placeholder ?? ''
    input.spellcheck = false
    input.style.cssText =
      `width:${opts.width ?? 180}px;background:var(--bg,#1b1d22);color:inherit;border:1px solid var(--accent,#4c9dff);` +
      'border-radius:5px;padding:5px 7px;font:inherit;outline:none;'
    box.appendChild(input)
    this.root.appendChild(box)

    const rw = this.root.clientWidth
    const rh = this.root.clientHeight
    const bw = box.offsetWidth
    const bh = box.offsetHeight
    box.style.left = `${Math.max(4, Math.min(rw - bw - 4, opts.x - bw / 2))}px`
    box.style.top = `${Math.max(4, Math.min(rh - bh - 4, opts.y - bh / 2))}px`

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter') {
        ev.preventDefault()
        this.closePrompt(true)
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        this.closePrompt(false)
      }
    })
    input.addEventListener('keyup', (ev) => ev.stopPropagation())
    input.addEventListener('blur', () => {
      // clicking elsewhere confirms a non-empty value
      if (this.promptEl === box) this.closePrompt(true)
    })
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    box.addEventListener('wheel', (ev) => ev.stopPropagation())

    this.promptEl = box
    this.promptOpts = opts
    this.editingKey = opts.key ?? null
    this.onChange()
    // focus after the current pointer event finished, otherwise the canvas steals it back
    setTimeout(() => {
      if (this.promptEl === box) {
        input.focus()
        input.select()
      }
    }, 0)
  }

  closePrompt(commit: boolean): void {
    const box = this.promptEl
    const opts = this.promptOpts
    if (!box || !opts) return
    this.promptEl = null
    this.promptOpts = null
    this.editingKey = null
    const value = (box.querySelector('input') as HTMLInputElement | null)?.value ?? ''
    box.remove()
    if (commit && value.trim() !== '') opts.onCommit(value.trim())
    else opts.onCancel?.()
    this.onChange()
  }

  showMenu(x: number, y: number, items: ContextMenuItem[]): void {
    this.closeMenu()
    if (!items.length) return
    const menu = document.createElement('div')
    menu.style.cssText = `${PANEL_CSS}padding:4px;min-width:190px;user-select:none;`
    for (const it of items) {
      if (it.separator) {
        const sep = document.createElement('div')
        sep.style.cssText = 'height:1px;margin:4px 6px;background:var(--border,#3a3f4a);'
        menu.appendChild(sep)
        continue
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.textContent = it.label
      row.disabled = !!it.disabled
      row.style.cssText =
        'display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:5px;' +
        `padding:6px 10px;font:inherit;cursor:${it.disabled ? 'default' : 'pointer'};` +
        `color:${it.disabled ? 'var(--muted,#9aa3b2)' : it.danger ? '#ff6b6b' : 'inherit'};opacity:${it.disabled ? 0.55 : 1};`
      if (!it.disabled) {
        row.addEventListener('pointerenter', () => {
          row.style.background = 'color-mix(in srgb, var(--accent,#4c9dff) 22%, transparent)'
        })
        row.addEventListener('pointerleave', () => {
          row.style.background = 'transparent'
        })
        row.addEventListener('click', () => {
          this.closeMenu()
          it.run?.()
        })
      }
      menu.appendChild(row)
    }
    this.root.appendChild(menu)
    const rw = this.root.clientWidth
    const rh = this.root.clientHeight
    menu.style.left = `${Math.max(4, Math.min(rw - menu.offsetWidth - 4, x))}px`
    menu.style.top = `${Math.max(4, Math.min(rh - menu.offsetHeight - 4, y))}px`
    menu.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    menu.addEventListener('contextmenu', (ev) => ev.preventDefault())

    const onDown = (ev: Event): void => {
      if (ev.target instanceof Node && menu.contains(ev.target)) return
      this.closeMenu()
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        this.closeMenu()
      }
    }
    const onBlur = (): void => this.closeMenu()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('wheel', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    this.menuCleanup = () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('wheel', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
    this.menuEl = menu
  }

  closeMenu(): void {
    this.menuCleanup?.()
    this.menuCleanup = null
    this.menuEl?.remove()
    this.menuEl = null
  }

  destroy(): void {
    this.closeMenu()
    const box = this.promptEl
    this.promptEl = null
    this.promptOpts = null
    this.editingKey = null
    box?.remove()
  }
}
