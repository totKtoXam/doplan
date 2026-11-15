import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
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
const claim = async (p: string) => claimDocument(`id:${await fileId(p)}`, p)
const open = async (p: string) => (await claim(p)).ref
const claimRef = async (ref: string, p: string) => (await claimDocument(ref, p)).ref

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

  it('a copy of a file (the original still there with the id) gets chats and an id of its own; the file is not touched', async () => {
    const orig = join(root, 'flat-orig.doplan')
    const copy = join(root, 'flat-v2.doplan')
    await docFile(orig, 'copied-id-1')
    expect(await open(orig)).toBe('id:copied-id-1')
    await saveChat('id:copied-id-1', chat('chat-c', 'c', { codex: 'T-1' }))
    await cp(orig, copy)
    const before = await stat(copy)
    const mine = await open(copy)
    expect(mine).toMatch(/^id:[A-Za-z0-9_-]{16}$/)
    // nothing is written into the file on open: the id reaches it with the user's next save
    expect(await fileId(copy)).toBe('copied-id-1')
    expect((await stat(copy)).mtimeMs).toBe(before.mtimeMs)
    expect(await ids(mine)).toEqual(['chat-c'])
    expect((await loadChat(mine, 'chat-c'))?.resume).toBeUndefined()
    expect((await loadChat('id:copied-id-1', 'chat-c'))?.resume).toEqual({ codex: 'T-1' })
    expect(await open(orig)).toBe('id:copied-id-1')
  })

  it('a copy never saved with its id gets a fresh copy of the chats on each open; the earlier ones stay', async () => {
    const orig = join(root, 'ro.doplan')
    const copy = join(root, 'ro-export.json')
    await docFile(orig, 'ro-id-1')
    await open(orig)
    await saveChat('id:ro-id-1', chat('chat-ro', 'ro', { claude: 'R-1' }))
    await cp(orig, copy)
    const first = await open(copy)
    await saveChat(first, chat('chat-first', 'first'))
    const second = await open(copy)
    expect(second).not.toBe(first)
    expect(await ids(second)).toEqual(['chat-ro'])
    expect(await ids(first)).toEqual(['chat-first', 'chat-ro'])
    expect(await open(orig)).toBe('id:ro-id-1')
    expect((await loadChat('id:ro-id-1', 'chat-ro'))?.resume).toEqual({ claude: 'R-1' })
  })

  it('a copy saved with its id is a document of its own: renaming it keeps its chats (without agent sessions)', async () => {
    const orig = join(root, 'quick.doplan')
    const copy = join(root, 'quick - Copy.doplan')
    await docFile(orig, 'quick-id-1')
    await open(orig)
    await cp(orig, copy)
    const mine = await open(copy)
    await saveChat(mine, chat('chat-mine', 'mine', { claude: 'M-1' }))
    await save(copy, mine.slice(3))
    expect(await open(copy)).toBe(mine)
    await rename(copy, join(root, 'quick-v2.doplan'))
    expect(await open(join(root, 'quick-v2.doplan'))).toBe(mine)
    expect(await ids(mine)).toEqual(['chat-mine'])
    expect((await loadChat(mine, 'chat-mine'))?.resume).toBeUndefined()
    expect(await open(orig)).toBe('id:quick-id-1')
  })

  it('a new copy at the old path of a saved and renamed copy is not that copy', async () => {
    const orig = join(root, 'den.doplan')
    const copy = join(root, 'den - Copy.doplan')
    await docFile(orig, 'den-id-1')
    await saveChat('id:den-id-1', chat('chat-orig', 'o'))
    await open(orig)
    await cp(orig, copy)
    const y = await open(copy)
    await save(copy, y.slice(3))
    await saveChat(y, chat('chat-v2', 'v2', { claude: 'V2-1' }))
    await rename(copy, join(root, 'den v2.doplan'))
    expect(await open(join(root, 'den v2.doplan'))).toBe(y)
    // Explorer gives the next copy of the original the same default name
    await cp(orig, copy)
    const z = await open(copy)
    expect(z).not.toBe(y)
    expect(z).not.toBe('id:den-id-1')
    expect(await ids(z)).toEqual(['chat-orig'])
    expect(await open(join(root, 'den v2.doplan'))).toBe(y)
    expect(await ids(y)).toEqual(['chat-orig', 'chat-v2'])
  })

  it('a renamed or moved original keeps its id and chats, also when another project took its old path; its agent sessions end', async () => {
    const orig = join(root, 'home.doplan')
    await docFile(orig, 'home-id-1')
    await open(orig)
    await saveChat('id:home-id-1', chat('chat-h', 'h', { claude: 'H-1' }))
    expect(await open(orig)).toBe('id:home-id-1')
    expect((await loadChat('id:home-id-1', 'chat-h'))?.resume).toEqual({ claude: 'H-1' })
    await rename(orig, join(root, 'home-moved.doplan'))
    // a different project now lives at the old path
    await docFile(orig, 'other-id-1')
    expect(await open(join(root, 'home-moved.doplan'))).toBe('id:home-id-1')
    expect(await ids('id:home-id-1')).toEqual(['chat-h'])
    expect((await loadChat('id:home-id-1', 'chat-h'))?.resume).toBeUndefined()
    expect(await open(orig)).toBe('id:other-id-1')
    expect(await open(join(root, 'home-moved.doplan'))).toBe('id:home-id-1')
  })

  it('the original moved onto the path of a deleted copy keeps its own id and chats', async () => {
    const orig = join(root, 'p1.doplan')
    const copy = join(root, 'p2.doplan')
    await docFile(orig, 'pp-id-1')
    await open(orig)
    await saveChat('id:pp-id-1', chat('chat-p1', 'p', { claude: 'P1-1' }))
    await cp(orig, copy)
    const theCopy = await open(copy)
    await rm(copy)
    await rename(orig, copy)
    expect(await open(copy)).toBe('id:pp-id-1')
    expect(theCopy).not.toBe('id:pp-id-1')
    expect(await ids('id:pp-id-1')).toEqual(['chat-p1'])
    expect((await loadChat('id:pp-id-1', 'chat-p1'))?.resume).toBeUndefined()
  })

  it("a copy opened before the renamed original takes the id, but never the original's agent sessions", async () => {
    const orig = join(root, 'race.doplan')
    const copy = join(root, 'race - Copy.doplan')
    await docFile(orig, 'race-id-1')
    await open(orig)
    await saveChat('id:race-id-1', chat('chat-race', 'r', { claude: 'RACE-1', codex: 'RACE-2' }))
    await cp(orig, copy)
    await rename(orig, join(root, 'race-renamed.doplan'))
    expect(await open(copy)).toBe('id:race-id-1')
    expect(await ids('id:race-id-1')).toEqual(['chat-race'])
    const rec = await loadChat('id:race-id-1', 'chat-race')
    expect(rec?.resume).toBeUndefined()
    expect(rec?.resumeCwd).toBeUndefined()
    // the renamed original is now the copy: chats copied, no sessions either
    const other = await open(join(root, 'race-renamed.doplan'))
    expect(other).not.toBe('id:race-id-1')
    expect((await loadChat(other, 'chat-race'))?.resume).toBeUndefined()
  })

  it('a project opened from its own path keeps its agent sessions', async () => {
    const orig = join(root, 'stay.doplan')
    await docFile(orig, 'stay-id-1')
    await open(orig)
    await saveChat('id:stay-id-1', chat('chat-stay', 's', { claude: 'S-1' }))
    expect(await claim(orig)).toEqual({ ref: 'id:stay-id-1', sessionsDropped: false })
    expect((await loadChat('id:stay-id-1', 'chat-stay'))?.resume).toEqual({ claude: 'S-1' })
  })

  it('the claim says when the chats it keeps lost their sessions (moved), and only then', async () => {
    const orig = join(root, 'flag.doplan')
    await docFile(orig, 'flag-id-1')
    expect(await claim(orig)).toEqual({ ref: 'id:flag-id-1', sessionsDropped: true })
    expect(await claim(orig)).toEqual({ ref: 'id:flag-id-1', sessionsDropped: false })
    const copy = join(root, 'flag - Copy.doplan')
    await cp(orig, copy)
    const theCopy = await claim(copy)
    expect(theCopy.ref).not.toBe('id:flag-id-1')
    // the original's chats keep theirs: its stopped turns may still report a session
    expect(theCopy.sessionsDropped).toBe(false)
    await rename(orig, join(root, 'flag-moved.doplan'))
    expect(await claim(join(root, 'flag-moved.doplan'))).toEqual({ ref: 'id:flag-id-1', sessionsDropped: true })
  })

  it('reads the id of a .doplan archive and of a project folder; a project it cannot read counts as still there', async () => {
    const zipped = join(root, 'zipped.doplan')
    await writeFile(zipped, zipSync({ 'doc.json': strToU8(JSON.stringify({ meta: { id: 'zip-id-1' } })) }))
    expect(await claimRef('id:zip-id-1', zipped)).toBe('id:zip-id-1')
    await docFile(join(root, 'zipped-copy.json'), 'zip-id-1')
    expect(await open(join(root, 'zipped-copy.json'))).not.toBe('id:zip-id-1')
    // saved with another id: the archive is no longer this document, the next one to open takes the id
    await writeFile(zipped, zipSync({ 'doc.json': strToU8(JSON.stringify({ meta: { id: 'zip-id-2' } })) }))
    expect(await open(join(root, 'zipped-copy.json'))).toBe('id:zip-id-1')

    const folder = join(root, 'Flat project')
    await mkdir(folder, { recursive: true })
    await docFile(join(folder, 'plan.json'), 'folder-id-1')
    expect(await claimRef('id:folder-id-1', folder)).toBe('id:folder-id-1')
    await docFile(join(root, 'folder-export.json'), 'folder-id-1')
    expect(await open(join(root, 'folder-export.json'))).not.toBe('id:folder-id-1')

    const broken = join(root, 'broken.doplan')
    await docFile(broken, 'broken-id-1')
    await open(broken)
    await writeFile(broken, 'not a project')
    await docFile(join(root, 'broken-copy.json'), 'broken-id-1')
    expect(await open(join(root, 'broken-copy.json'))).not.toBe('id:broken-id-1')
  })

  it('one file reached through a junction is not a copy of itself', async () => {
    const real = join(root, 'real-dir')
    await mkdir(real, { recursive: true })
    const file = join(real, 'same.doplan')
    await docFile(file, 'same-id-1')
    await open(file)
    const viaJunction = join(root, 'junction-dir')
    await symlink(real, viaJunction, 'junction')
    expect(await open(join(viaJunction, 'same.doplan'))).toBe('id:same-id-1')
  })

  it('copies.json left by 0.10 and 0.11 is ignored', async () => {
    const orig = join(root, 'legacy-orig.doplan')
    const copy = join(root, 'legacy-copy.doplan')
    await docFile(orig, 'legacy-id-1')
    await open(orig)
    await docFile(copy, 'legacy-id-1')
    await saveChat('id:legacyCopy01', chat('chat-legacy', 'legacy', { claude: 'L-1' }))
    await writeFile(join(root, 'ai-chats', 'copies.json'), JSON.stringify({ [`legacy-id-1|${copy.toLowerCase()}`]: 'legacyCopy01' }))
    const mine = await open(copy)
    expect(mine).not.toBe('id:legacyCopy01')
    expect(mine).not.toBe('id:legacy-id-1')
    expect(await ids('id:legacyCopy01')).toEqual(['chat-legacy'])
  })

  it('a renamed or moved file (the old path is gone) keeps its chats', async () => {
    const before = join(root, 'room-old.doplan')
    const after = join(root, 'room-new.doplan')
    await saveChat('id:renamed-id-1', chat('chat-r', 'r'))
    expect(await claimRef('id:renamed-id-1', before)).toBe('id:renamed-id-1')
    expect(await claimRef('id:renamed-id-1', after)).toBe('id:renamed-id-1')
    // now the new path is the file: opening it from the old one again (that file does not exist) also keeps them
    expect(await claimRef('id:renamed-id-1', after)).toBe('id:renamed-id-1')
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
