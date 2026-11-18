import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GithubSyncStatus, PullResult, PushResult } from '@shared/github'

// The header's GitHub actions: a send GitHub keeps refusing never loops, and what the user changes
// while GitHub's versions come in is never replaced without asking.

const fake = vi.hoisted(() => {
  const status = { state: 'ahead', ahead: 1, behind: 0 } as GithubSyncStatus
  const calls = { push: 0, pull: 0, resolve: 0, open: 0, save: 0, order: [] as string[] }
  const next: { push: () => Promise<PushResult>; pull: () => Promise<PullResult> } = {
    push: async () => ({ warnings: [], status }),
    pull: async () => ({ result: 'upToDate', status }),
  }
  const dialogs = { alerts: [] as string[], choices: [] as string[], answer: 'keep' }
  const api = {
    platform: 'win32',
    github: {
      status: async () => status,
      push: () => {
        calls.push++
        calls.order.push('push')
        return next.push()
      },
      pull: () => {
        calls.pull++
        calls.order.push('pull')
        return next.pull()
      },
      resolve: async () => {
        calls.resolve++
        calls.order.push('resolve')
        return { status }
      },
    },
  }
  return { status, calls, next, dialogs, api }
})

vi.mock('@/store/api', () => ({ api: fake.api }))
vi.mock('@/store/notify', () => ({
  toast: vi.fn(),
  alertDialog: async (_title: string, message?: string) => void fake.dialogs.alerts.push(message ?? ''),
  confirmDialog: async () => true,
  choiceDialog: async (title: string) => {
    fake.dialogs.choices.push(title)
    return fake.dialogs.answer
  },
}))
vi.mock('@/actions/project', () => ({
  openProject: async () => {
    fake.calls.open++
    fake.calls.order.push('open')
  },
  saveProject: async () => {
    fake.calls.save++
    fake.calls.order.push('save')
    docStore.getState().setDirty(false)
    return true
  },
}))

const { docStore } = await import('./document')
const { projectStore } = await import('./project')
const { githubPull, githubPush, githubResolve, githubStore } = await import('./github')

beforeEach(() => {
  Object.assign(fake.calls, { push: 0, pull: 0, resolve: 0, open: 0, save: 0, order: [] })
  Object.assign(fake.dialogs, { alerts: [], choices: [], answer: 'keep' })
  fake.next.push = async () => ({ warnings: [], status: fake.status })
  fake.next.pull = async () => ({ result: 'upToDate', status: fake.status })
  projectStore.setState({ root: 'C:/p/G', viewing: null })
  docStore.getState().setDirty(false)
  githubStore.setState({ busy: null, dialog: null, pushAfterResolve: false })
})

describe('GitHub actions', () => {
  it('gets the changes and sends once more, then stops when GitHub still says no', async () => {
    fake.next.push = async () => ({ needPull: true, warnings: [], status: fake.status })
    await githubPush()
    expect(fake.calls.push).toBe(2)
    expect(fake.calls.pull).toBe(1)
    expect(fake.dialogs.alerts).toHaveLength(1)
    expect(githubStore.getState().busy).toBeNull()
  })

  it('locks the editor while GitHub versions come in, and asks before replacing edits made anyway', async () => {
    let release!: () => void
    fake.next.pull = () =>
      new Promise<PullResult>((r) => {
        release = () => r({ result: 'updated', status: fake.status })
      })
    const pulling = githubPull()
    await vi.waitFor(() => expect(fake.calls.pull).toBe(1))
    // the lock dialog shows on this state
    expect(githubStore.getState().busy).toBe('pull')
    docStore.getState().setDirty(true)
    release()
    await pulling
    expect(fake.dialogs.choices).toHaveLength(1)
    expect(fake.calls.open).toBe(0)
    expect(docStore.getState().dirty).toBe(true)

    // the user chooses GitHub's version: now the folder is read again
    fake.dialogs.answer = 'load'
    fake.next.pull = async () => ({ result: 'updated', status: fake.status })
    docStore.getState().setDirty(false)
    const again = githubPull()
    await vi.waitFor(() => expect(fake.calls.pull).toBe(2))
    docStore.getState().setDirty(true)
    await again
    expect(fake.calls.open).toBe(1)
  })

  it('reloads without a question when nothing changed meanwhile', async () => {
    fake.next.pull = async () => ({ result: 'merged', status: fake.status })
    await githubPull()
    expect(fake.dialogs.choices).toHaveLength(0)
    expect(fake.calls.open).toBe(1)
  })

  it('saves what is on screen before settling a conflict', async () => {
    docStore.getState().setDirty(true)
    await githubResolve('mine')
    expect(fake.calls.order).toEqual(['save', 'resolve', 'open'])
  })
})
