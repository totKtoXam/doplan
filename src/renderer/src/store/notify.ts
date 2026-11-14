/**
 * Shell-level notifications: toasts, a progress indicator and promise-based modal prompts
 * (alert / confirm / choice / prompt). Rendered by ui/shell/Overlays.tsx.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error' | 'warning'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

export interface ModalButton {
  id: string
  label: string
  variant?: 'primary' | 'danger' | 'default'
}

export interface ModalRequest {
  id: number
  title: string
  message?: string
  /** monospace details list (e.g. validation issues) */
  details?: string[]
  buttons: ModalButton[]
  /** if set, shows a text input; the input value is returned with the button id */
  input?: { value: string; placeholder?: string }
  resolve(result: { button: string; value: string }): void
}

export interface ProgressState {
  label: string
  /** 0..1 or null for indeterminate */
  value: number | null
  cancel?: () => void
}

interface NotifyState {
  toasts: Toast[]
  modals: ModalRequest[]
  progress: ProgressState | null
}

export const notifyStore = createStore<NotifyState>()(() => ({ toasts: [], modals: [], progress: null }))

export function useNotify<T>(selector: (s: NotifyState) => T): T {
  return useStore(notifyStore, selector)
}

let seq = 1

export function toast(text: string, kind: ToastKind = 'info', ms = 3500): void {
  const id = seq++
  notifyStore.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
  setTimeout(() => dismissToast(id), ms)
}

export function dismissToast(id: number): void {
  notifyStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function setProgress(p: ProgressState | null): void {
  notifyStore.setState({ progress: p })
}

function openModal(req: Omit<ModalRequest, 'id' | 'resolve'>): Promise<{ button: string; value: string }> {
  return new Promise((resolve) => {
    const id = seq++
    const entry: ModalRequest = {
      ...req,
      id,
      resolve: (r) => {
        notifyStore.setState((s) => ({ modals: s.modals.filter((m) => m.id !== id) }))
        resolve(r)
      },
    }
    notifyStore.setState((s) => ({ modals: [...s.modals, entry] }))
  })
}

export async function alertDialog(title: string, message?: string, details?: string[]): Promise<void> {
  await openModal({ title, message, details, buttons: [{ id: 'ok', label: 'OK', variant: 'primary' }] })
}

export async function confirmDialog(
  title: string,
  message?: string,
  opts?: { ok?: string; cancel?: string; danger?: boolean; details?: string[] },
): Promise<boolean> {
  const r = await openModal({
    title,
    message,
    details: opts?.details,
    buttons: [
      { id: 'cancel', label: opts?.cancel ?? 'Отмена' },
      { id: 'ok', label: opts?.ok ?? 'OK', variant: opts?.danger ? 'danger' : 'primary' },
    ],
  })
  return r.button === 'ok'
}

/** Arbitrary buttons; resolves with the clicked button id ('cancel' on Esc). */
export async function choiceDialog(title: string, message: string, buttons: ModalButton[]): Promise<string> {
  const r = await openModal({ title, message, buttons })
  return r.button
}

export async function promptDialog(title: string, value: string, placeholder?: string): Promise<string | null> {
  const r = await openModal({
    title,
    input: { value, placeholder },
    buttons: [
      { id: 'cancel', label: 'Отмена' },
      { id: 'ok', label: 'OK', variant: 'primary' },
    ],
  })
  return r.button === 'ok' ? r.value : null
}
