/**
 * AI chat entry points used by the shell: the chat shown in the «ИИ» section of the left panel,
 * the always-mounted host (chat setup, Ctrl+L), the «Добавить в чат» button and the 3D right-click menu.
 */
import { type RefObject, useCallback, useEffect, useState } from 'react'
import { t } from '@/i18n'
import { useUi } from '@/store/ui'
import { cn } from '@/ui/kit'
import { ContextMenu } from '@/ui/shell/primitives'
import { ChatPanel } from './ChatPanel'
import './i18n'
import { addSelectionToChat, focusChat, initAi } from './store'

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

/**
 * Mounted once for the whole window (the chat itself comes and goes with the left panel): connects
 * the chat to main and the open document, and listens for Ctrl+L.
 */
export function AiHost() {
  useEffect(() => initAi(), [])
  useChatShortcut()
  return null
}

/**
 * The chat in the «ИИ» section of the left panel. `hidden`: another section is shown — the chat stays
 * mounted and laid out underneath (a typed message, the scroll position and popovers' anchors survive,
 * the feed keeps following a running answer), but it cannot be seen, focused or clicked.
 */
export function ChatSection({ hidden = false }: { hidden?: boolean }) {
  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', hidden && 'invisible absolute inset-0')}
      aria-hidden={hidden || undefined}
      inert={hidden}
      data-ai-dock
    >
      <ChatPanel />
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
          ? { label: t('Добавить в чат'), kbd: 'Ctrl+L', onSelect: () => addSelectionToChat() }
          : { label: t('Открыть ИИ-чат'), kbd: 'Ctrl+L', onSelect: () => focusChat() },
      ]}
    />
  )
}
