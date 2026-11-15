/** Open flags of the application dialogs (rendered by App, implemented in ui/panels). */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

export type DialogKey = 'bom' | 'importModel' | 'materialEditor' | 'settings' | 'photoPlan' | 'render' | 'about'

export interface DialogState {
  bom: boolean
  importModel: boolean
  materialEditor: boolean
  settings: boolean
  photoPlan: boolean
  render: boolean
  about: boolean
  /** model files dropped onto the window, waiting for the import dialog to pick them up */
  pendingModelFiles: { name: string; data: ArrayBuffer }[] | null
  /** image dropped onto the window for photo → plan */
  pendingPhoto: { name: string; data: ArrayBuffer; mime: string } | null
  open(key: DialogKey): void
  close(key: DialogKey): void
  toggle(key: DialogKey): void
  set(patch: Partial<Omit<DialogState, 'open' | 'close' | 'toggle' | 'set'>>): void
}

export const dialogStore = createStore<DialogState>()((set, get) => ({
  bom: false,
  importModel: false,
  materialEditor: false,
  settings: false,
  photoPlan: false,
  render: false,
  about: false,
  pendingModelFiles: null,
  pendingPhoto: null,
  open(key) {
    set({ [key]: true } as Partial<DialogState>)
  },
  close(key) {
    const patch: Partial<DialogState> = { [key]: false }
    if (key === 'importModel') patch.pendingModelFiles = null
    if (key === 'photoPlan') patch.pendingPhoto = null
    set(patch)
  },
  toggle(key) {
    set({ [key]: !get()[key] } as Partial<DialogState>)
  },
  set(patch) {
    set(patch)
  },
}))

export function useDialogs<T>(selector: (s: DialogState) => T): T {
  return useStore(dialogStore, selector)
}
