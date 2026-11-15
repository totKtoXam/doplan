/**
 * AI chat entry points used by the shell: the right dock with «Свойства | ИИ» tabs, the
 * «Добавить в чат» button, the 3D right-click menu and the Ctrl+L shortcut.
 */
import { type RefObject, useCallback, useEffect, useState } from 'react'
import { RightPanel } from '@/ui/panels'
import { useUi } from '@/store/ui'
import { cn } from '@/ui/kit'
import { ContextMenu } from '@/ui/shell/primitives'
import { ChatPanel } from './ChatPanel'
import { addSelectionToChat, focusChat, initAi, setDockTab, useAi } from './store'

export { addRefsToChat, addSelectionToChat, focusChat } from './store'
export { AddToChatButton } from './AddToChatButton'

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** Ctrl+L: add the selection to the chat (or just focus the chat). */
function useChatShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== 'KeyL') return
      if (isTyping(e.target) && !(e.target as HTMLElement).hasAttribute('data-ai-input')) return
      e.preventDefault()
      e.stopPropagation()
      addSelectionToChat()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

export function RightDock() {
  const tab = useAi((s) => s.dockTab)
  const running = useAi((s) => !!s.running)
  useEffect(() => initAi(), [])
  useChatShortcut()
  const tabBtn = (id: 'props' | 'ai', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={cn('relative px-3 py-1.5 text-xs', tab === id ? 'font-medium text-text' : 'text-muted hover:text-text')}
      onClick={() => setDockTab(id)}
    >
      {label}
      {id === 'ai' && running && <span className="absolute top-1.5 right-1 size-1.5 rounded-full bg-accent" />}
      {tab === id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded bg-accent" />}
    </button>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ai-dock>
      <div role="tablist" className="flex shrink-0 border-b border-border">
        {tabBtn('props', 'Свойства')}
        {tabBtn('ai', 'ИИ')}
      </div>
      {tab === 'props' ? <RightPanel /> : <ChatPanel />}
    </div>
  )
}

/** Right-click (without dragging) in the 3D view: «Добавить в чат». */
export function Ai3DMenu({ host }: { host: RefObject<HTMLElement | null> }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const hasSel = useUi((s) => s.selection.length > 0)
  const close = useCallback(() => setAt(null), [])
  useEffect(() => {
    const el = host.current
    if (!el) return
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.button === 2) down = { x: e.clientX, y: e.clientY }
    }
    const onMenu = (e: MouseEvent) => {
      const d = down
      down = null
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
      e.preventDefault()
      setAt({ x: e.clientX, y: e.clientY })
    }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('contextmenu', onMenu)
    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('contextmenu', onMenu)
    }
  }, [host])
  return (
    <ContextMenu
      at={at}
      onClose={close}
      items={[
        hasSel
          ? { label: 'Добавить в чат', kbd: 'Ctrl+L', onSelect: () => addSelectionToChat() }
          : { label: 'Открыть ИИ-чат', kbd: 'Ctrl+L', onSelect: () => focusChat() },
      ]}
    />
  )
}
