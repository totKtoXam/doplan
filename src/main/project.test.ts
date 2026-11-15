import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'doplan-project-'))
vi.mock('electron', () => ({ app: { getPath: () => root, getVersion: () => '0.0.0' }, dialog: {} }))
vi.mock('./access', () => ({ assertReadable: async (p: string) => resolve(p), grantPath: () => {} }))
vi.mock('./settings', () => ({ addRecent: async () => {} }))
vi.mock('./window', () => ({ getMainWindow: () => null }))

const { writeDocId } = await import('./project')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const archive = (id: string) =>
  zipSync({
    'manifest.json': strToU8('{"format":"doplan","formatVersion":1}'),
    'doc.json': strToU8(JSON.stringify({ meta: { id, name: 'Flat' }, walls: { w1: {} } })),
    'assets/abc.png': new Uint8Array([1, 2, 3]),
  })

describe('writeDocId', () => {
  it('changes only the id inside the archive, and only while the file still carries the old one', async () => {
    const file = join(root, 'flat - Copy.doplan')
    await writeFile(file, archive('orig-id-1'))
    expect(await writeDocId(file, 'other-id', 'copy-id-1')).toBe(false)
    expect(await writeDocId(file, 'orig-id-1', 'copy-id-1')).toBe(true)
    const files = unzipSync(new Uint8Array(await readFile(file)))
    expect(JSON.parse(strFromU8(files['doc.json']))).toEqual({ meta: { id: 'copy-id-1', name: 'Flat' }, walls: { w1: {} } })
    expect(strFromU8(files['manifest.json'])).toBe('{"format":"doplan","formatVersion":1}')
    expect([...files['assets/abc.png']]).toEqual([1, 2, 3])
  })

  it('leaves files that are not doplan archives alone', async () => {
    const json = join(root, 'plan.doplan')
    await writeFile(json, JSON.stringify({ meta: { id: 'orig-id-2' } }))
    expect(await writeDocId(json, 'orig-id-2', 'copy-id-2')).toBe(false)
    expect(JSON.parse(await readFile(json, 'utf8')).meta.id).toBe('orig-id-2')
    expect(await writeDocId(join(root, 'missing.doplan'), 'a', 'b').catch(() => false)).toBe(false)
  })
})
