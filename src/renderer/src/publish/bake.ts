/**
 * Baked light for a published plan: every level's walls, floors and ceilings get a page of light
 * traced in the editor (view3d/bake), sent as WebP with a manifest (assets/bake/bake.json). The
 * viewer shows it while the plan looks as it was baked and lights the scene live otherwise.
 *
 * A level baked earlier in this session with the same lights, furniture and geometry is not traced
 * again (the engine keeps its last bake per level).
 */
import type { BakeManifest } from '@/contracts'
import { docStore } from '@/store/document'
import { handles, waitForEngine3D } from '@/store/handles'
import { uiStore } from '@/store/ui'
import { BAKE_MANIFEST, bakePagePath } from '@/view3d/bake/manifest'
import { status3dStore } from '@/view3d/status'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(ok: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!ok() && Date.now() < end) await sleep(100)
}

/** the page as WebP: smooth light keeps well at this quality, a tenth of the lossless size */
async function encodePage(rgba: Uint8ClampedArray, size: number): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(size, size)
  const g = canvas.getContext('2d')
  if (!g) return null
  g.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
  if (blob.type !== 'image/webp') return null
  return new Uint8Array(await blob.arrayBuffer())
}

export interface BakedFiles {
  manifest: BakeManifest
  files: { path: string; data: Uint8Array }[]
}

/**
 * Bakes every level (progress 0…1 over all of them); null when there is no 3D here or nothing to
 * bake. Opens the 3D view for the moment when only the plan is shown, and puts the level and the
 * view back afterwards.
 */
export async function captureBake(onProgress: (part: number) => void): Promise<BakedFiles | null> {
  const ui = uiStore.getState()
  const prevMode = ui.mode
  let engine = handles.engine3d
  if (!engine) {
    ui.setMode('split')
    engine = await waitForEngine3D(20000)
  }
  if (!engine?.bakeLighting) {
    if (uiStore.getState().mode !== prevMode) uiStore.getState().setMode(prevMode)
    return null
  }
  const prevLevel = uiStore.getState().activeLevelId
  const doc = docStore.getState().doc
  const levels = doc.levelOrder.filter((id) => doc.levels[id])
  const manifest: BakeManifest = { version: 1, levels: {} }
  const files: BakedFiles['files'] = []
  try {
    for (let i = 0; i < levels.length; i++) {
      const id = levels[i]
      if (uiStore.getState().activeLevelId !== id) {
        uiStore.getState().set({ activeLevelId: id })
        await sleep(250)
      }
      // the furniture throws the shadows: wait for its models
      await until(() => status3dStore.getState().modelsPending === 0, 30000)
      const out = await engine.bakeLighting({ onProgress: (done, total) => onProgress((i + (total ? done / total : 1)) / levels.length) })
      if (!out || out.levelId !== id) continue
      const closed = await encodePage(out.pages.closed.rgba, out.size)
      const open = await encodePage(out.pages.open.rgba, out.size)
      if (!closed || !open) continue
      const paths = { closed: bakePagePath(id, 'closed'), open: bakePagePath(id, 'open') }
      manifest.levels[id] = {
        ...out.level,
        closed: { file: paths.closed, scale: out.pages.closed.scale },
        open: { file: paths.open, scale: out.pages.open.scale },
      }
      files.push({ path: paths.closed, data: closed }, { path: paths.open, data: open })
    }
  } catch (err) {
    console.warn('[doplan] publish: no baked light', err)
    return null
  } finally {
    if (uiStore.getState().activeLevelId !== prevLevel) uiStore.getState().set({ activeLevelId: prevLevel })
    if (prevMode !== uiStore.getState().mode) uiStore.getState().setMode(prevMode)
  }
  onProgress(1)
  if (!files.length) return null
  files.push({ path: BAKE_MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest)) })
  return { manifest, files }
}
