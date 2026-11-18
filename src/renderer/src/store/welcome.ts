/**
 * Welcome screen state: shown at startup (unless the app was launched to open a file) and from
 * Файл → Начальный экран. Any document loaded into the editor (opened, created, the sample, a restored
 * crash copy) closes it.
 */
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { MenuCommand } from '@shared/ipc'
import { docStore } from './document'

export interface WelcomeState {
  open: boolean
  /** opened over a project the user can go back to (from the menu); at startup there is none */
  canClose: boolean
}

export const welcomeStore = createStore<WelcomeState>()(() => ({ open: false, canClose: false }))

export function useWelcome<T>(selector: (s: WelcomeState) => T): T {
  return useStore(welcomeStore, selector)
}

/** `canClose`: there is a project behind it to go back to (already open at startup: still none) */
export function showWelcome(canClose: boolean): void {
  welcomeStore.setState((s) => ({ open: true, canClose: s.open ? s.canClose : canClose }))
}

export function hideWelcome(): void {
  if (welcomeStore.getState().open) welcomeStore.setState({ open: false, canClose: false })
}

docStore.subscribe((s, prev) => {
  if (s.loadId !== prev.loadId) hideWelcome()
})

/** menu commands that still make sense on the welcome screen; the rest would act on the hidden editor */
const WELCOME_MENU = new Set<MenuCommand>(['new', 'open', 'openFolder', 'settings', 'about', 'checkUpdates', 'installUpdate', 'welcome'])

export function welcomeBlocksMenu(cmd: MenuCommand): boolean {
  return welcomeStore.getState().open && !WELCOME_MENU.has(cmd)
}

/**
 * keyboard shortcuts on the welcome screen: only Ctrl+N and Ctrl+O. `ctrl`: Ctrl/Cmd without Alt and
 * Shift; `key`: the layout-independent key (shortcutKey)
 */
export function welcomeBlocksKey(ctrl: boolean, key: string): boolean {
  if (!welcomeStore.getState().open) return false
  return !(ctrl && (key === 'n' || key === 'o'))
}
