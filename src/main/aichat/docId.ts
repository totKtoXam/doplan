/**
 * The id a project on disk carries (Doc.meta.id), read without opening it in the app: a .doplan
 * archive (doc.json inside), a plain .json document, or a project folder (its plan.json). Only reads.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { PLAN_FILE } from '../../shared/projectFormat'

const MAX_BYTES = 2 * 1024 * 1024 * 1024

function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6)
}

/** null: the project has no id; throws when it cannot be read or is not a project */
export async function readDocId(path: string): Promise<string | null> {
  const file = (await stat(path)).isDirectory() ? join(path, PLAN_FILE) : path
  if ((await stat(file)).size > MAX_BYTES) throw new Error('too large')
  let bytes: Uint8Array | undefined = new Uint8Array(await readFile(file))
  if (isZip(bytes)) {
    const files = unzipSync(bytes, { filter: (f) => f.name === 'doc.json' || f.name === 'scene.json' })
    bytes = files['doc.json'] ?? files['scene.json']
    if (!bytes) throw new Error('no doc.json')
  }
  let text = strFromU8(bytes)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const id = (JSON.parse(text) as { meta?: { id?: unknown } } | null)?.meta?.id
  return typeof id === 'string' && id ? id : null
}
