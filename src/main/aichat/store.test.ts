import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'doplan-chats-'))
vi.mock('electron', () => ({ app: { getPath: () => root } }))

const { agentWorkDir, dropChats, getChatSettings, listChats, loadChat, moveChats, projectKey, saveChat, setChatSettings } = await import('./store')

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
    await moveChats('id:proj-aaaa', 'id:proj-bbbb', true, join(root, 'b.doplan'))
    expect(await ids('id:proj-aaaa')).toEqual(['chat-s'])
    expect(await ids('id:proj-bbbb')).toEqual(['chat-s'])
    expect((await loadChat('id:proj-aaaa', 'chat-s'))?.resume).toEqual({ claude: 'S-1' })
    expect((await loadChat('id:proj-bbbb', 'chat-s'))?.resume).toBeUndefined()
  })

  it('an older file moves to its id on save and keeps resuming in its agent folder', async () => {
    const a = join(root, 'flat.doplan')
    await saveChat(a, chat('chat-p', 'p', { claude: 'P-1' }))
    const work = await agentWorkDir(a)
    await moveChats(a, 'id:flat-id-1', false, a)
    expect(await ids(a)).toEqual([])
    expect(await ids('id:flat-id-1')).toEqual(['chat-p'])
    expect(await agentWorkDir('id:flat-id-1')).toBe(work)
    expect((await loadChat('id:flat-id-1', 'chat-p'))?.resume).toEqual({ claude: 'P-1' })
  })

  it('moved chats drop their sessions when the target has an agent folder of its own', async () => {
    await saveChat('id:own-src-1', chat('chat-o', 'o', { claude: 'O-1' }))
    await agentWorkDir('id:own-src-1')
    await agentWorkDir('id:own-dst-1')
    await moveChats('id:own-src-1', 'id:own-dst-1', false, null)
    expect((await loadChat('id:own-dst-1', 'chat-o'))?.resume).toBeUndefined()
  })

  it('a chat already at the target is not overwritten', async () => {
    await saveChat('id:same-src', chat('chat-same', 'older'))
    await saveChat('id:same-dst', chat('chat-same', 'newer'))
    await moveChats('id:same-src', 'id:same-dst', false, null)
    expect(JSON.parse(await readFile(join(root, 'ai-chats', projectKey('id:same-dst'), 'chat-same.json'), 'utf8')).title).toBe('newer')
  })

  it('chats of 0.5 unsaved projects go to the next unsaved document; the shared settings stay', async () => {
    await saveChat(null, chat('chat-old', 'old'))
    await moveChats(null, 'id:new-doc-1', false, null)
    expect(await ids('id:new-doc-1')).toEqual(['chat-old'])
    expect(await ids(null)).toEqual([])
    expect((await getChatSettings('id:another-doc')).provider).toBe('gemini')
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
