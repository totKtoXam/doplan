import type { Doc, Id } from '@core/types'
import { docStore } from '@/store/document'
import { uiStore } from '@/store/ui'

export function currentDoc(): Doc {
  return docStore.getState().doc
}

export function activeLevel(): Id {
  const doc = currentDoc()
  const id = uiStore.getState().activeLevelId
  return doc.levels[id] ? id : (doc.levelOrder[0] ?? '')
}

/** file-system safe base name of the project */
export function projectBaseName(): string {
  const { doc, filePath } = docStore.getState()
  const fromPath = filePath ? (filePath.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '') : ''
  const raw = fromPath || doc.meta.name || 'plan'
  return raw.replace(/[<>:"/\|?*\u0000-\u001f]+/g, '_').trim() || 'plan'
}

export function levelSuffix(): string {
  const doc = currentDoc()
  if (doc.levelOrder.length < 2) return ''
  const name = doc.levels[activeLevel()]?.name ?? ''
  return name ? ` - ${name.replace(/[<>:"/\|?*]+/g, '_')}` : ''
}

export async function blobToArrayBuffer(b: Blob): Promise<ArrayBuffer> {
  return b.arrayBuffer()
}

export function extOf(name: string): string {
  const m = /\.([^.\/]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
export const MODEL_EXTS = ['glb', 'gltf', 'obj', 'fbx']
export const MODEL_AUX_EXTS = ['mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'tga']

export function mimeOf(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

/** natural pixel size of an encoded image */
export async function imageSize(data: ArrayBuffer, mime: string): Promise<{ w: number; h: number }> {
  const blob = new Blob([data], { type: mime })
  try {
    const bmp = await createImageBitmap(blob)
    const out = { w: bmp.width, h: bmp.height }
    bmp.close()
    return out
  } catch {
    const url = URL.createObjectURL(blob)
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => reject(new Error('Не удалось прочитать изображение'))
        img.src = url
      })
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}
