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

// a loaded document closes the screen. Edits of the document behind it do not by themselves: an AI agent
// or a sync may still be writing while the user picks a project. Only the user's own file actions over the
// screen (runFileDrop, runFileOpen) close it when they changed the document: the user must see the result.
docStore.subscribe((s, prev) => {
  if (s.loadId !== prev.loadId) hideWelcome()
})

async function runUserFileAction(run: () => Promise<unknown>, launch: boolean): Promise<void> {
  const before = docStore.getState()
  try {
    await run()
  } catch (err) {
    console.error('[doplan] file action failed', err)
  } finally {
    const after = docStore.getState()
    if (after.revision !== before.revision) hideWelcome()
    else if (launch && after.loadId === before.loadId) showWelcome(false)
  }
}

/** files dropped on the window (an image as underlay, a PlanSpec as a level, a 3D model …) */
export function runFileDrop(drop: () => Promise<unknown>): Promise<void> {
  return runUserFileAction(drop, false)
}

// ───────────── the file the app was launched to open ─────────────

let launchPending = false

/** the app was launched to open a file: the screen is skipped, unless that open comes to nothing */
export function expectLaunchOpen(): void {
  launchPending = true
}

/**
 * Runs the open of a file sent by main (double click, a second instance). When it is the launch file and
 * nothing got loaded or changed (unreadable file, failed import, cancelled question), the start screen is
 * shown instead of a blank untitled editor.
 */
export function runFileOpen(open: () => Promise<unknown>): Promise<void> {
  const launch = launchPending
  launchPending = false
  return runUserFileAction(open, launch)
}

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
