/**
 * The picture a published plan shows at once, while its 3D is still loading: the 3D view from the
 * camera the viewer starts at (the default overview), taken in the editor when publishing.
 */
import type { Engine3DHandle } from '@/contracts'
import { docStore } from '@/store/document'
import { handles, waitForEngine3D } from '@/store/handles'
import { uiStore } from '@/store/ui'
import { status3dStore } from '@/view3d/status'
import { browserCodec } from './browserCodec'

/** where the viewer looks for it */
export const PREVIEW_PATH = 'assets/preview.webp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(ok: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!ok() && Date.now() < end) await sleep(100)
}

/** the camera stops moving (the default view is placed with a short animation) */
async function settled(engine: Engine3DHandle, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  let last = ''
  let still = 0
  while (Date.now() < end && still < 3) {
    await sleep(80)
    const c = JSON.stringify(engine.getCamera())
    still = c === last ? still + 1 : 0
    last = c
  }
}

/**
 * The overview as WebP (≈1600 px wide), or null when there is no 3D here: the first level from the
 * default camera, as the viewer opens. Opens the 3D view for the moment when only the plan is shown,
 * and puts the level, the camera, its mode and the view back afterwards.
 */
export async function capturePreview(): Promise<Uint8Array | null> {
  const ui = uiStore.getState()
  const prevMode = ui.mode
  let engine = handles.engine3d
  if (!engine) {
    ui.setMode('split')
    engine = await waitForEngine3D(20000)
  }
  if (!engine) {
    if (uiStore.getState().mode !== prevMode) uiStore.getState().setMode(prevMode)
    return null
  }
  const prevCam = engine.getCamera()
  const prevCamMode = uiStore.getState().cameraMode
  // no selection outline on the picture
  const prevSelection = uiStore.getState().selection
  if (prevSelection.length) uiStore.getState().clearSelection()
  const prevLevel = uiStore.getState().activeLevelId
  const firstLevel = docStore.getState().doc.levelOrder[0]
  try {
    if (firstLevel && firstLevel !== prevLevel) {
      uiStore.getState().set({ activeLevelId: firstLevel })
      // the scene follows on its next frame; its models are counted from then
      await sleep(250)
    }
    // the models first: a picture of empty rooms would be worse than none
    await until(() => status3dStore.getState().modelsPending === 0, 30000)
    if (prevCamMode !== 'orbit') engine.setCameraMode('orbit')
    engine.resetCamera()
    await settled(engine, 3000)
    const blob = await engine.renderStill({ width: 1600, height: 1000, mode: 'realtime', format: 'png' })
    const fitted = await browserCodec.fit(new Uint8Array(await blob.arrayBuffer()), 'image/png', 1600, 'color')
    return fitted?.data ?? null
  } catch (err) {
    console.warn('[doplan] publish: no preview', err)
    return null
  } finally {
    if (uiStore.getState().activeLevelId !== prevLevel) uiStore.getState().set({ activeLevelId: prevLevel })
    if (prevCamMode !== 'orbit') engine.setCameraMode(prevCamMode)
    engine.setCamera(prevCam)
    if (prevSelection.length) uiStore.getState().select(prevSelection)
    if (prevMode !== uiStore.getState().mode) uiStore.getState().setMode(prevMode)
  }
}
