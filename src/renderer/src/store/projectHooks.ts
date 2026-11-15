/**
 * Work that has to finish with a project action rather than after it (the window may close right
 * after): the AI chat moves its chats when the document is saved, and drops the chats of an unsaved
 * document that is closed. Kept apart from actions/project so modules that react need not import it.
 */
export interface ProjectHook {
  /** a save is about to read the document (the AI chat lets a pending claim of a copy's id finish) */
  beforeSave?(): Promise<void> | void
  /** the document was written (`saveAs`: to a new file, as a new project) */
  saved?(saveAs: boolean): Promise<void> | void
  /** the window is about to close, unsaved changes already settled */
  closing?(): Promise<void> | void
}

const hooks: ProjectHook[] = []

export function addProjectHook(h: ProjectHook): () => void {
  hooks.push(h)
  return () => {
    const i = hooks.indexOf(h)
    if (i >= 0) hooks.splice(i, 1)
  }
}

export async function runProjectHooks<K extends keyof ProjectHook>(kind: K, ...args: Parameters<NonNullable<ProjectHook[K]>>): Promise<void> {
  await Promise.allSettled(hooks.map(async (h) => (h[kind] as ((...a: unknown[]) => unknown) | undefined)?.(...args)))
}
