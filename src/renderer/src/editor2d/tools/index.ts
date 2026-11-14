import { t } from '@/i18n'
import type { ToolId } from '@/contracts'
import type { EditorCtx } from '../context'
import { createDimensionTool, createLabelTool, createLightTool, createMeasureTool } from './annotate'
import { createItemTool } from './item'
import { createCalibrateTool, createEraseTool, createSplitTool } from './modify'
import { createOpeningTool } from './opening'
import { createEyedropperTool, createPaintTool } from './paint'
import { createRoomTool } from './room'
import { createSelectTool } from './select'
import type { Tool } from './types'
import { createWallTool } from './wall'

export type { Tool } from './types'

function createPanTool(ctx: EditorCtx): Tool {
  // the actual panning is done by the input layer (left drag pans while this tool is active)
  return {
    cursor: 'grab',
    activate() {
      ctx.setHint(t('Перетаскивайте план · колесо — масштаб'))
    },
    deactivate() {
      ctx.setHint('')
    },
    cancel() {
      return false
    },
  }
}

export function createTools(ctx: EditorCtx): Record<ToolId, Tool> {
  return {
    select: createSelectTool(ctx),
    pan: createPanTool(ctx),
    wall: createWallTool(ctx),
    room: createRoomTool(ctx),
    door: createOpeningTool(ctx, 'door'),
    window: createOpeningTool(ctx, 'window'),
    item: createItemTool(ctx),
    light: createLightTool(ctx),
    dimension: createDimensionTool(ctx),
    label: createLabelTool(ctx),
    measure: createMeasureTool(ctx),
    paint: createPaintTool(ctx),
    eyedropper: createEyedropperTool(ctx),
    calibrate: createCalibrateTool(ctx),
    split: createSplitTool(ctx),
    erase: createEraseTool(ctx),
  }
}
