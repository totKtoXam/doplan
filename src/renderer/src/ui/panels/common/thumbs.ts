import { useEffect, useState, type RefObject } from 'react'
import { create } from 'zustand'
import type { Asset, Id } from '@core/types'
import { handles } from '@/store/handles'

/**
 * Lazily generated asset thumbnails: an asset without `thumb` is rendered by the 3D engine
 * (`renderAssetThumb`) once its tile becomes visible, cached for the session and persisted via
 * `window.doplan.catalog.saveThumb`. Requests are processed one at a time; while the 3D engine is not
 * loaded yet the queue waits and retries.
 */
interface ThumbState {
  urls: Record<Id, string>
}
export const useThumbs = create<ThumbState>(() => ({ urls: {} }))

const queue: Asset[] = []
const queued = new Set<Id>()
const failed = new Set<Id>()
let running = false
let retryTimer = 0

const THUMB_SIZE = 192

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const engine = handles.engine3d
      if (!engine) {
        window.clearTimeout(retryTimer)
        retryTimer = window.setTimeout(() => void pump(), 2000)
        return
      }
      const asset = queue.shift() as Asset
      queued.delete(asset.id)
      if (useThumbs.getState().urls[asset.id] || failed.has(asset.id)) continue
      try {
        const blob = await engine.renderAssetThumb(asset, THUMB_SIZE)
        const local = URL.createObjectURL(blob)
        useThumbs.setState({ urls: { ...useThumbs.getState().urls, [asset.id]: local } })
        try {
          await window.doplan.catalog.saveThumb('asset', asset.id, await blob.arrayBuffer())
        } catch {
          /* persisting is best effort; the session cache already has the image */
        }
      } catch {
        failed.add(asset.id)
      }
    }
  } finally {
    running = false
  }
}

export function requestAssetThumb(asset: Asset): void {
  if (asset.thumb || asset.remote || failed.has(asset.id) || queued.has(asset.id)) return
  if (useThumbs.getState().urls[asset.id]) return
  queued.add(asset.id)
  queue.push(asset)
  void pump()
}

/** thumbnail URL for an asset: its own `thumb`, else a generated one (requested when `visible`) */
export function useAssetThumb(asset: Asset, visible: boolean): string | undefined {
  const generated = useThumbs((s) => s.urls[asset.id])
  useEffect(() => {
    if (visible && !asset.thumb && !generated) requestAssetThumb(asset)
  }, [visible, asset, generated])
  return asset.thumb ?? generated
}

/** true once the element has scrolled into view (stays true) */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}
