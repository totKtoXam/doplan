import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { cp, link, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'doplan-chats-'))
vi.mock('electron', () => ({ app: { getPath: () => root } }))

const { agentWorkDir, agentWorkDirPath, claimDocument, dropChats, getChatSettings, listChats, loadChat, moveChats, projectKey, saveChat, setChatSettings } = await import('./store')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const chat = (id: string, title: string, resume?: Record<string, string>) => ({
  id,
  title,
  provider: 'claude',
  createdAt: '',
  updatedAt: title,
  messages: [{ id: 'm', role: 'user', createdAt: '', parts: [] }],
  ...(resume ? { resume } : {}),
})
const ids = async (ref: string | null) => (await listChats(ref)).map((c) => c.id).sort()

// a saved project as far as claiming goes: the id inside the file
const docFile = (p: string, id: string) => writeFile(p, JSON.stringify({ meta: { id } }))
const fileId = async (p: string): Promise<string> => JSON.parse(await readFile(p, 'utf8')).meta.id
/** a save from the app: a new file put in place (as atomicWrite does), carrying `id` */
const save = async (p: string, id: string) => {
  await writeFile(`${p}.tmp`, JSON.stringify({ meta: { id }, edited: true }))
  await rename(`${p}.tmp`, p)
}
/** opening a file as the app does: the id inside it is claimed for its path */
const open = async (p: string) => claimDocument(`id:${await fileId(p)}`, p)
const copiesJson = async () =>
  JSON.parse(await readFile(join(root, 'ai-chats', 'copies.json'), 'utf8')) as Record<string, unknown>

describe('chat storage follows the project', () => {
  it('a document id names the folder (renaming the file keeps it); settings carry over to new projects', async () => {
    expect(projectKey('id:abcd1234')).toBe('p-abcd1234')
    expect(projectKey('id:../xyzzz')).not.toContain('..')
    expect(projectKey('unsaved:abcd1234')).toBe('unsaved-abcd1234')
    await saveChat('id:doc-one-1', chat('chat-a1', 'a'))
    expect(await ids('id:doc-one-1')).toEqual(['chat-a1'])
    expect(await ids('id:doc-two-2')).toEqual([])
    await setChatSettings('id:doc-one-1', { provider: 'codex' })
    expect((await getChatSettings('id:doc-two-2')).provider).toBe('codex')
    await setChatSettings('id:doc-two-2', { provider: 'gemini' })
    expect((await getChatSettings('id:doc-one-1')).provider).toBe('codex')
  })

  it('Save As copies the chats without agent sessions: the two files do not share one', async () => {
    await saveChat('id:proj-aaaa', chat('chat-s', 's', { claude: 'S-1' }))
    expect((await moveChats('id:proj-aaaa', 'id:proj-bbbb', true, join(root, 'b.doplan'))).sessionsKept).toBe(false)
    expect(await ids('id:proj-aaaa')).toEqual(['chat-s'])
    expect(await ids('id:proj-bbbb')).toEqual(['chat-s'])
    expect((await loadChat('id:proj-aaaa', 'chat-s'))?.resume).toEqual({ claude: 'S-1' })
    expect((await loadChat('id:proj-bbbb', 'chat-s'))?.resume).toBeUndefined()
  })

  it('an older file moves to its id on save and keeps resuming in its agent folder', async () => {
    const a = join(root, 'flat.doplan')
    await saveChat(a, chat('chat-p', 'p', { claude: 'P-1' }))
    const work = await agentWorkDir(a)
    expect((await moveChats(a, 'id:flat-id-1', false, a)).sessionsKept).toBe(true)
    expect(await ids(a)).toEqual([])
    expect(await ids('id:flat-id-1')).toEqual(['chat-p'])
    expect(await agentWorkDir('id:flat-id-1')).toBe(work)
    expect((await loadChat('id:flat-id-1', 'chat-p'))?.resume).toEqual({ claude: 'P-1' })
  })

  it('moved chats drop their sessions when the target has an agent folder of its own', async () => {
    await saveChat('id:own-src-1', chat('chat-o', 'o', { claude: 'O-1' }))
    await agentWorkDir('id:own-src-1')
    await agentWorkDir('id:own-dst-1')
    expect((await moveChats('id:own-src-1', 'id:own-dst-1', false, null)).sessionsKept).toBe(false)
    expect((await loadChat('id:own-dst-1', 'chat-o'))?.resume).toBeUndefined()
  })

  it('a session that remembers its folder (a trusted project folder) survives the move', async () => {
    const folderPath = join(root, 'Проект')
    await saveChat(folderPath, { ...chat('chat-f', 'f', { claude: 'F-1', codex: 'X-1' }), resumeCwd: { claude: folderPath } })
    // the agent ran in the folder: there is no ai-work folder for the old reference
    expect((await moveChats(folderPath, 'id:folder-id-1', false, folderPath)).sessionsKept).toBe(false)
    const rec = await loadChat('id:folder-id-1', 'chat-f')
    expect(rec?.resume).toEqual({ claude: 'F-1' })
    expect(rec?.resumeCwd).toEqual({ claude: folderPath })
  })

  it('the agent folder can be looked up without creating it', async () => {
    const p = await agentWorkDirPath('id:lookup-only-1')
    expect(existsSync(p)).toBe(false)
    expect(await agentWorkDir('id:lookup-only-1')).toBe(p)
    expect(existsSync(join(p, 'AGENTS.md'))).toBe(true)
  })

  it('a chat already at the target is not overwritten', async () => {
    await saveChat('id:same-src', chat('chat-same', 'older'))
    await saveChat('id:same-dst', chat('chat-same', 'newer'))
    await moveChats('id:same-src', 'id:same-dst', false, null)
    expect(JSON.parse(await readFile(join(root, 'ai-chats', projectKey('id:same-dst'), 'chat-same.json'), 'utf8')).title).toBe('newer')
  })

  it('chats of 0.5 unsaved projects stay in the shared bucket: no move takes them, no drop deletes them', async () => {
    await saveChat(null, chat('chat-old', 'old'))
    // only no reference names the shared bucket, and a move needs one at both ends
    await expect(moveChats('', 'id:new-doc-1', false, null)).rejects.toThrow()
    await expect(moveChats('id:new-doc-1', '', false, null)).rejects.toThrow()
    await dropChats('id:new-doc-1')
    await dropChats('unsaved')
    expect(await ids(null)).toEqual(['chat-old'])
    expect((await getChatSettings('id:another-doc')).provider).toBe('gemini')
  })

  it('a copy of a file (same id, other path, the original still there) gets chats and an id of its own; the file is not touched', async () => {
    const orig = join(root, 'flat-orig.doplan')
    const copy = join(root, 'flat-v2.doplan')
    await docFile(orig, 'copied-id-1')
    await saveChat('id:copied-id-1', chat('chat-c', 'c', { codex: 'T-1' }))
    expect(await open(orig)).toBe('id:copied-id-1')
    await cp(orig, copy)
    const before = await stat(copy)
    const mine = await open(copy)
    expect(mine).toMatch(/^id:[A-Za-z0-9_-]{16}$/)
    // nothing is written into the file on open: the id reaches it with the user's next save
    expect(await fileId(copy)).toBe('copied-id-1')
    expect((await stat(copy)).mtimeMs).toBe(before.mtimeMs)
    expect(await fileId(orig)).toBe('copied-id-1')
    expect(await ids(mine)).toEqual(['chat-c'])
    expect((await loadChat(mine, 'chat-c'))?.resume).toBeUndefined()
    expect((await loadChat('id:copied-id-1', 'chat-c'))?.resume).toEqual({ codex: 'T-1' })
    expect(await open(copy)).toBe(mine)
    expect(await open(orig)).toBe('id:copied-id-1')
  })

  it('a copy not saved yet keeps its id when it is renamed, when the original is renamed, or both', async () => {
    const orig = join(root, 'home.doplan')
    const copy = join(root, 'home - Copy.doplan')
    await docFile(orig, 'home-id-1')
    await saveChat('id:home-id-1', chat('chat-h', 'h', { claude: 'H-1' }))
    await open(orig)
    await cp(orig, copy)
    const mine = await open(copy)
    await saveChat(mine, chat('chat-mine', 'mine'))
    // the copy renamed in Explorer before it was saved in the app: still carries the original's id
    await rename(copy, join(root, 'home-v2.doplan'))
    expect(await open(join(root, 'home-v2.doplan'))).toBe(mine)
    // now the original too, and the copy once more: neither takes the other's id
    await rename(orig, join(root, 'home-old.doplan'))
    await rename(join(root, 'home-v2.doplan'), join(root, 'home-v3.doplan'))
    expect(await open(join(root, 'home-v3.doplan'))).toBe(mine)
    expect(await ids(mine)).toEqual(['chat-h', 'chat-mine'])
    expect(await open(join(root, 'home-old.doplan'))).toBe('id:home-id-1')
    expect(await ids('id:home-id-1')).toEqual(['chat-h'])
    expect((await loadChat('id:home-id-1', 'chat-h'))?.resume).toEqual({ claude: 'H-1' })
  })

  it('a copy that is never saved (a .json project, a read-only file) never takes over the renamed original', async () => {
    const orig = join(root, 'ro.doplan')
    const copy = join(root, 'ro-export.json')
    await docFile(orig, 'ro-id-1')
    await saveChat('id:ro-id-1', chat('chat-ro', 'ro', { claude: 'R-1' }))
    await open(orig)
    await cp(orig, copy)
    const mine = await open(copy)
    await rename(orig, join(root, 'ro-final.doplan'))
    // opened before the renamed original: it is still the copy
    expect(await open(copy)).toBe(mine)
    expect(await open(join(root, 'ro-final.doplan'))).toBe('id:ro-id-1')
    expect((await loadChat('id:ro-id-1', 'chat-ro'))?.resume).toEqual({ claude: 'R-1' })
    expect(await open(copy)).toBe(mine)
  })

  it('a copy saved before its new id was applied (Ctrl+S right after opening) is still that copy', async () => {
    const orig = join(root, 'quick.doplan')
    const copy = join(root, 'quick - Copy.doplan')
    await docFile(orig, 'quick-id-1')
    await open(orig)
    await cp(orig, copy)
    const mine = await open(copy)
    await save(copy, 'quick-id-1')
    expect(await open(copy)).toBe(mine)
    // saved with its own id: from then on it is a document of its own wherever it goes
    await save(copy, mine.slice(3))
    await rename(copy, join(root, 'quick-v2.doplan'))
    expect(await open(join(root, 'quick-v2.doplan'))).toBe(mine)
    expect(await open(orig)).toBe('id:quick-id-1')
  })

  it('the original moved onto the path of a deleted copy keeps its own id and sessions', async () => {
    const orig = join(root, 'p1.doplan')
    const copy = join(root, 'p2.doplan')
    await docFile(orig, 'pp-id-1')
    await saveChat('id:pp-id-1', chat('chat-p1', 'p', { claude: 'P1-1' }))
    await open(orig)
    await cp(orig, copy)
    const theCopy = await open(copy)
    await rm(copy)
    await rename(orig, copy)
    expect(await open(copy)).toBe('id:pp-id-1')
    expect(theCopy).not.toBe('id:pp-id-1')
    expect((await loadChat('id:pp-id-1', 'chat-p1'))?.resume).toEqual({ claude: 'P1-1' })
    // the entry of the deleted copy is gone: it cannot catch the original later
    expect(Object.keys(await copiesJson()).filter((k) => k.startsWith('pp-id-1|'))).toEqual([])
  })

  it('one file reached by two paths (a junction, a hard link) is not a copy of itself', async () => {
    const real = join(root, 'real-dir')
    await mkdir(real, { recursive: true })
    const file = join(real, 'same.doplan')
    await docFile(file, 'same-id-1')
    await open(file)
    const viaJunction = join(root, 'junction-dir')
    await symlink(real, viaJunction, 'junction')
    expect(await open(join(viaJunction, 'same.doplan'))).toBe('id:same-id-1')
    const hard = join(root, 'same-hardlink.doplan')
    await link(file, hard)
    expect(await open(hard)).toBe('id:same-id-1')
  })

  it('a copy recorded by 0.10.0 under its plain path is still found through a junction, and moves to the real path', async () => {
    const real = join(root, 'plans-real')
    await mkdir(real, { recursive: true })
    const orig = join(root, 'legacy-orig.doplan')
    await docFile(orig, 'legacy-id-1')
    await open(orig)
    const viaJunction = join(root, 'plans-z')
    await symlink(real, viaJunction, 'junction')
    const copy = join(viaJunction, 'flat.doplan')
    await docFile(copy, 'legacy-id-1')
    await saveChat('id:legacyCopy01', chat('chat-legacy', 'legacy'))
    // 0.10.0 kept a bare id under the path as opened (not resolved through the junction)
    const old = `legacy-id-1|${copy.toLowerCase()}`
    await writeFile(join(root, 'ai-chats', 'copies.json'), JSON.stringify({ ...(await copiesJson()), [old]: 'legacyCopy01' }))
    expect(await open(copy)).toBe('id:legacyCopy01')
    expect(await ids('id:legacyCopy01')).toEqual(['chat-legacy'])
    const moved = await copiesJson()
    expect(moved[old]).toBeUndefined()
    expect(moved[`legacy-id-1|${join(real, 'flat.doplan').toLowerCase()}`]).toMatchObject({ id: 'legacyCopy01' })
    expect(await open(copy)).toBe('id:legacyCopy01')
    expect(await open(orig)).toBe('id:legacy-id-1')
  })

  it('a renamed or moved file (the old path is gone) keeps its chats', async () => {
    const before = join(root, 'room-old.doplan')
    const after = join(root, 'room-new.doplan')
    await saveChat('id:renamed-id-1', chat('chat-r', 'r'))
    expect(await claimDocument('id:renamed-id-1', before)).toBe('id:renamed-id-1')
    expect(await claimDocument('id:renamed-id-1', after)).toBe('id:renamed-id-1')
    // now the new path is the file: opening it from the old one again (that file does not exist) also keeps them
    expect(await claimDocument('id:renamed-id-1', after)).toBe('id:renamed-id-1')
  })

  it('an abandoned unsaved document loses its chats, a saved project never does', async () => {
    await saveChat('id:gone-doc-1', chat('chat-g', 'g'))
    await agentWorkDir('id:gone-doc-1')
    await dropChats('id:gone-doc-1')
    expect(await ids('id:gone-doc-1')).toEqual([])
    await saveChat('id:kept-doc-1', chat('chat-k', 'k'))
    await moveChats('id:kept-doc-1', 'id:kept-doc-1', false, join(root, 'k.doplan'))
    await dropChats('id:kept-doc-1')
    expect(await ids('id:kept-doc-1')).toEqual(['chat-k'])
    // file-path projects and the shared bucket are never dropped
    await dropChats(join(root, 'flat.doplan'))
    await dropChats('unsaved')
    expect((await getChatSettings(null)).provider).toBe('gemini')
  })

  it('a forged agent folder pointer outside the app folder is ignored', async () => {
    const d = join(root, 'd.doplan')
    const dir = join(root, 'ai-chats', projectKey(d))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workdir.json'), JSON.stringify({ dir: tmpdir() }))
    expect(await agentWorkDir(d)).toBe(join(root, 'ai-work', projectKey(d)))
  })
})
