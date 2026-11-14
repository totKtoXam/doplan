/**
 * State of the open project as a folder: where it lives, whether it is versioned with git, the
 * history position of the last commit (for commit messages) and an old version being viewed.
 * Also holds the open flags of the project dialogs (new / save as folder, history, instructions).
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { ProjectVersion } from '@shared/ipc'

export type ProjectKind = 'folder' | 'zip' | 'json'

export type ProjectDialog = 'new' | 'saveAs' | 'history' | 'instructions' | null

export interface ProjectState {
  /** project folder (null: unsaved document or a .doplan / .json file) */
  root: string | null
  kind: ProjectKind | null
  /** the folder is a git repository doplan may use */
  git: boolean
  /** the folder came with a .git that the user has not trusted yet (doplan runs no git there) */
  untrustedGit: boolean
  /** document history position of the last commit; labels after it make the next commit message */
  commitMarker: number
  /** an old version loaded from history (Ctrl+S restores it as a new commit) */
  viewing: ProjectVersion | null
  dialog: ProjectDialog
  /** bumped when the history changed (new commit / tag) */
  historyRev: number
}

export const projectStore = createStore<ProjectState>()(() => ({
  root: null,
  kind: null,
  git: false,
  untrustedGit: false,
  commitMarker: 0,
  viewing: null,
  dialog: null,
  historyRev: 0,
}))

export function useProject<T>(selector: (s: ProjectState) => T): T {
  return useStore(projectStore, selector)
}

// ── awaitable "create project folder" dialog (Ctrl+S on an unsaved document waits for it) ──

let pendingCreate: ((saved: boolean) => void) | null = null

export function openCreateDialog(mode: 'new' | 'saveAs'): Promise<boolean> {
  pendingCreate?.(false)
  return new Promise((resolve) => {
    pendingCreate = resolve
    projectStore.setState({ dialog: mode })
  })
}

export function finishCreateDialog(saved: boolean): void {
  const r = pendingCreate
  pendingCreate = null
  projectStore.setState({ dialog: null })
  r?.(saved)
}
