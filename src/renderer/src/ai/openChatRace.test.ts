// A chat opened from the history list just before another file with the same id opens: the record
// loaded is the earlier document's, with its agent sessions, and must not become the new file's chat.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '@core'
import { DEFAULT_AI_SETTINGS } from '@shared/aiChat'

const fake = vi.hoisted(() => {
  const files = new Map<string, unknown>()
  const claims = new Map<string, string>()
  const dropped = new Set<string>()
  const records = new Map<string, any>()
  const runs: any[] = []
  const gate: { load: Promise<void> | null } = { load: null }
  const fallback = (o: Record<string, unknown>) => new Proxy(o, { get: (t, k: string) => (k in t ? t[k] : async () => undefined) })
  const api = {
    platform: 'win32',
    aiChat: fallback({
      providers: async () => [{ id: DEFAULT_AI_SETTINGS.provider, available: true }],
      getSettings: async () => ({ ...DEFAULT_AI_SETTINGS }),
      listChats: async () => [],
      claimDocument: async (ref: string, path: string) => {
        const k = ref + '|' + path
        const to = claims.get(k) ?? ref
        if (to !== ref) for (const [key, rec] of [...records]) if (key.startsWith(ref + '|')) records.set(to + '|' + rec.id, { ...rec, resume: undefined })
        if (dropped.has(k)) for (const [key, rec] of [...records]) if (key.startsWith(ref + '|')) records.set(key, { ...rec, resume: undefined })
        return { ref: to, sessionsDropped: dropped.has(k) }
      },
      loadChat: async (ref: string | null, id: string) => {
        if (gate.load) await gate.load
        return structuredClone(records.get(ref + '|' + id) ?? null)
      },
      saveChat: async (ref: string | null, chat: any) => void records.set(ref + '|' + chat.id, structuredClone(chat)),
      moveChats: async () => ({ sessionsKept: true }),
      run: async (req: any) => void runs.push(req),
      onEvent: () => () => {},
      onToolCall: () => () => {},
      onLogin: () => () => {},
    }),
    settings: fallback({ get: async () => ({}) }),
    project: fallback({
      info: async () => ({ root: null }),
      open: async (path: string) => (files.has(path) ? { path, doc: files.get(path), kind: 'folder', git: true } : null),
    }),
  }
  return { api, files, claims, dropped, records, runs, gate }
})
vi.mock('@/store/api', () => ({ api: fake.api }))

const { docStore } = await import('@/store/document')
const { openProject } = await import('@/actions/project')
const { aiStore, initAi, openChat, send, refreshProviders } = await import('./store')

const settle = () => new Promise((r) => setTimeout(r, 10))
const plan = (id: string) => { const d = createEmptyDoc('P'); return JSON.parse(JSON.stringify({ ...d, meta: { ...d.meta, id } })) }
const rec = (id: string) => ({ id, title: 't', provider: DEFAULT_AI_SETTINGS.provider, createdAt: 0, updatedAt: 0, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 0 }], resume: { [DEFAULT_AI_SETTINGS.provider]: 'S-ORIG' } })

beforeAll(async () => {
  globalThis.requestAnimationFrame ??= (() => 0) as never
  initAi()
  await refreshProviders(false)
})

for (const how of ['copy', 'moved'] as const) {
  it(how + ': a chat opened just before another file with the same id opens keeps the old session', async () => {
    const A = 'C:/p/A-' + how, B = 'C:/p/B-' + how, X = 'orig' + how
    fake.files.set(A, plan(X)); fake.files.set(B, plan(X))
    if (how === 'copy') fake.claims.set('id:' + X + '|' + B, 'id:copy' + how)
    else fake.dropped.add('id:' + X + '|' + B)
    await openProject(A, { skipConfirm: true }); await settle()
    fake.records.set('id:' + X + '|chatC', rec('chatC'))
    let release!: () => void
    fake.gate.load = new Promise<void>((r) => (release = r))
    const opening = openChat('chatC')        // user clicks the chat in the history list
    await openProject(B, { skipConfirm: true }) // and opens B right after
    release(); fake.gate.load = null
    await opening; await settle()
    const s = aiStore.getState()
    await send('next'); await settle()
    expect(fake.runs.at(-1)?.resumeId).toBeUndefined()
  })
}
