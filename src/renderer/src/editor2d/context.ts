import type { DerivedPlan, Doc, EntityRef, Id, Vec2 } from '@core/types'
import type { UiState } from '@/contracts'
import type { Camera } from './view'
import type { Palette } from './theme'
import type { HitIndex } from './hit'
import type { HtmlOverlay } from './htmlOverlay'
import type { SnapResult } from './snap'

export interface PointerInfo {
  /** raw (unsnapped) plan position, mm */
  plan: Vec2
  /** CSS px relative to the canvas */
  screen: Vec2
  client: Vec2
  button: number
  shift: boolean
  alt: boolean
  ctrl: boolean
}

export interface KeyState {
  shift: boolean
  alt: boolean
  ctrl: boolean
  space: boolean
}

export interface ContextMenuItem {
  label: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  run?(): void
}

/** Shared services of one editor instance, handed to layers and tools. */
export interface EditorCtx {
  root: HTMLElement
  canvas: HTMLCanvasElement
  camera: Camera
  hit: HitIndex
  html: HtmlOverlay
  keys: KeyState
  /** last known pointer position */
  pointer: { plan: Vec2 | null; screen: Vec2 | null; inside: boolean }
  /** snap feedback drawn by the overlay; tools set it on every move */
  snapFeedback: SnapResult | null
  requestRender(): void
  palette(): Palette
  doc(): Doc
  ui(): UiState
  levelId(): Id
  derived(): DerivedPlan
  setHint(text: string): void
  setCursor(css: string): void
  /** tolerance helpers: screen px → plan mm */
  mm(px: number): number
  showContextMenu(screen: Vec2, items: ContextMenuItem[]): void
  /** entity under the 3D camera gizmo drag etc. */
  isSelected(ref: EntityRef): boolean
}

export const EMPTY_DERIVED: DerivedPlan = {
  wallGeoms: {},
  rooms: [],
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
}

export function sameRef(a: EntityRef | null | undefined, b: EntityRef | null | undefined): boolean {
  if (!a || !b) return a === b || (!a && !b)
  return a.kind === b.kind && a.id === b.id
}

export function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
