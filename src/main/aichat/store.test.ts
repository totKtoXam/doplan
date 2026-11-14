import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'doplan-chats-'))
vi.mock('electron', () => ({ app: { getPath: () => root } }))

const { agentWorkDir, getChatSettings, listChats, moveChats, projectKey, saveChat, setChatSettings } = await import('./store')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const chat = (id: string, title: string) => ({ id, title, provider: 'claude', createdAt: '', updatedAt: title, messages: [{ id: 'm', role: 'user', createdAt: '', parts: [] }] })

describe('chat storage follows the project', () => {
  it('every unsaved document has its own chats, settings are shared between them', async () => {
    expect(projectKey('unsaved:abcd1234')).toBe('unsaved-abcd1234')
    expect(projectKey('unsaved:../x')).not.toContain('..')
    await saveChat('unsaved:doc-one-1', chat('chat-a1', 'a'))
    expect((await listChats('unsaved:doc-one-1')).map((c) => c.id)).toEqual(['chat-a1'])
    expect(await listChats('unsaved:doc-two-2')).toEqual([])
    await setChatSettings('unsaved:doc-one-1', { provider: 'codex' })
    expect((await getChatSettings('unsaved:doc-two-2')).provider).toBe('codex')
  })

  it('first save moves the chats and keeps the agent folder; Save As copies', async () => {
    const work = await agentWorkDir('unsaved:doc-one-1')
    const a = join(root, 'flat.doplan')
    await moveChats('unsaved:doc-one-1', a)
    expect((await listChats(a)).map((c) => c.id)).toEqual(['chat-a1'])
    expect(await listChats('unsaved:doc-one-1')).toEqual([])
    expect((await getChatSettings(a)).provider).toBe('codex')
    // the stored Claude Code session lives in the old folder: the saved project keeps using it
    expect(await agentWorkDir(a)).toBe(work)

    const b = join(root, 'flat copy.doplan')
    await saveChat(b, chat('chat-b1', 'old b'))
    await moveChats(a, b)
    expect((await listChats(a)).map((c) => c.id)).toEqual(['chat-a1'])
    expect((await listChats(b)).map((c) => c.id).sort()).toEqual(['chat-a1', 'chat-b1'])
  })

  it('a chat already at the target is not overwritten', async () => {
    const c = join(root, 'c.doplan')
    await saveChat('unsaved:doc-three-3', chat('chat-same', 'older'))
    await saveChat(c, chat('chat-same', 'newer'))
    await moveChats('unsaved:doc-three-3', c)
    expect(JSON.parse(await readFile(join(root, 'ai-chats', projectKey(c), 'chat-same.json'), 'utf8')).title).toBe('newer')
  })

  it('a forged agent folder pointer outside the app folder is ignored', async () => {
    const d = join(root, 'd.doplan')
    const dir = join(root, 'ai-chats', projectKey(d))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workdir.json'), JSON.stringify({ dir: tmpdir() }))
    expect(await agentWorkDir(d)).toBe(join(root, 'ai-work', projectKey(d)))
  })
})
