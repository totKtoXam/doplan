/**
 * Application commands shared by the top bar, menus, keyboard shortcuts and panels.
 */
import { dialogStore } from '@/store/dialogs'
import { uiStore } from '@/store/ui'
import type { ViewMode } from '@/contracts'
import { copySelection, cutSelection, deleteSelection, duplicateSelection, groupRotate, hasClipboard, paste, redo, selectAll, undo, zoomFit } from './edit'
import { ensureEngine, exportGlb, exportPlan, renderStill, snapshot3d } from './export'
import { addUnderlayFromData, handleDroppedFiles, importModelFiles, importPlanSpec, importUnderlay, planFromPhoto } from './import'
import { addLevel, deleteLevel, moveLevel, renameLevel, toggleLevelVisible } from './levels'
import { createVariant, cycleVariant, deleteVariant, moveVariant, renameVariant, selectStray, switchVariant } from './variants'
import { autosaveNow, confirmDiscard, handleCloseRequest, loadDocument, newProject, newSampleProject, offerRecovery, openProject, saveProject } from './project'
import { exportDoplan, openHistory, openInstructions, openProjectFolder } from './project'

export const actions = {
  // project
  newProject,
  newSampleProject,
  openProject,
  saveProject,
  confirmDiscard,
  loadDocument,
  autosaveNow,
  handleCloseRequest,
  offerRecovery,
  // project folders + git versions
  openProjectFolder,
  exportDoplan,
  openHistory,
  openInstructions,
  // export
  exportPlan,
  exportGlb,
  renderStill,
  snapshot3d,
  ensureEngine,
  // import
  importPlanSpec,
  importUnderlay,
  addUnderlayFromData,
  importModelFiles,
  planFromPhoto,
  handleDroppedFiles,
  // edit
  undo,
  redo,
  deleteSelection,
  duplicateSelection,
  groupRotate,
  selectAll,
  copySelection,
  cutSelection,
  paste,
  hasClipboard,
  zoomFit,
  // levels
  addLevel,
  renameLevel,
  deleteLevel,
  moveLevel,
  toggleLevelVisible,
  // furnishing variants
  createVariant,
  switchVariant,
  cycleVariant,
  renameVariant,
  moveVariant,
  deleteVariant,
  selectStray,
  openVariantCompare() {
    dialogStore.getState().open('variants')
  },
  // view
  setMode(mode: ViewMode) {
    uiStore.getState().setMode(mode)
  },
  openRenderDialog() {
    dialogStore.getState().open('render')
  },
  openSettings() {
    dialogStore.getState().open('settings')
  },
  openBom() {
    dialogStore.getState().open('bom')
  },
  openMaterialEditor() {
    dialogStore.getState().open('materialEditor')
  },
}

export type Actions = typeof actions
