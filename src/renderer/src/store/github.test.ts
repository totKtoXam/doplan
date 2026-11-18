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
  // like the real one: the folder read again is a new load of the document
  openProject: async (path: string, opts?: { reload?: 'disk' | 'version' | null }) => {
    fake.calls.open++
    fake.calls.order.push('open')
    docStore.getState().load(docStore.getState().doc, path, opts?.reload ?? null)
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
const { generation, githubPull, githubPush, githubResolve, githubStore, startGithubWatch } = await import('./github')

/** what opening a project does to the stores (actions/project afterOpen) */
function openAs(root: string, reload: 'version' | null = null): void {
  docStore.getState().load(docStore.getState().doc, root, reload)
  projectStore.setState({ root, viewing: null })
}

/** a GitHub answer held back until `release` */
function held<T>(): { promise: Promise<T>; release: (v: T) => void } {
  let release!: (v: T) => void
  const promise = new Promise<T>((r) => (release = r))
  return { promise, release }
}

const statusOf = (repo: string) =>
  ({ state: 'synced', ahead: 0, behind: 0, remote: { url: `https://github.com/me/${repo}`, owner: 'me', repo, webUrl: `https://github.com/me/${repo}` } }) as unknown as GithubSyncStatus

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
    githubStore.setState({ dialog: 'conflict', conflictGen: generation() })
    docStore.getState().setDirty(true)
    await githubResolve('mine')
    expect(fake.calls.order).toEqual(['save', 'resolve', 'open'])
  })

  it('sends again after its own reload: the reload it made is the generation it goes on with', async () => {
    githubStore.setState({ dialog: 'conflict', conflictGen: generation(), pushAfterResolve: true })
    await githubResolve('theirs')
    expect(fake.calls.order).toEqual(['resolve', 'open', 'push'])
  })
})

// REVIEW-NIGHT-3: an answer of main about a project that is no longer on screen is dropped, and so is
// every step after it (main works on whatever project is open when it is called)
describe('another project or another load while GitHub works', () => {
  it('a send of A that finishes after B was opened leaves B its own state', async () => {
    openAs('C:/p/A')
    const h = held<PushResult>()
    fake.next.push = () => h.promise
    const pushing = githubPush()
    await vi.waitFor(() => expect(fake.calls.push).toBe(1))
    openAs('C:/p/B')
    const bStatus = { state: 'disconnected' } as GithubSyncStatus
    githubStore.setState({ status: bStatus })
    h.release({ warnings: [], status: statusOf('A') })
    await pushing
    expect(githubStore.getState().status?.remote?.repo).not.toBe('A')
    expect(fake.dialogs.alerts).toEqual([])
  })

  it('a send of A that needs GitHub versions does not get and send B after B was opened', async () => {
    openAs('C:/p/A')
    const h = held<PushResult>()
    fake.next.push = () => h.promise
    const pushing = githubPush()
    await vi.waitFor(() => expect(fake.calls.push).toBe(1))
    openAs('C:/p/B')
    const before = fake.calls.order.length
    h.release({ needPull: true, warnings: [], status: statusOf('A') })
    await pushing
    expect(fake.calls.order.slice(before)).toEqual([])
    expect(githubStore.getState().busy).toBeNull()
  })

  it('an old version viewed while A was sent: no pull and reload over it', async () => {
    openAs('C:/p/A')
    const h = held<PushResult>()
    fake.next.push = () => h.promise
    const pushing = githubPush()
    await vi.waitFor(() => expect(fake.calls.push).toBe(1))
    openAs('C:/p/A', 'version')
    const before = fake.calls.order.length
    h.release({ needPull: true, warnings: [], status: statusOf('A') })
    await pushing
    expect(fake.calls.order.slice(before)).toEqual([])
  })

  it('a pull of A that brought changes does not read the folder over B', async () => {
    openAs('C:/p/A')
    const h = held<PullResult>()
    fake.next.pull = () => h.promise
    const pulling = githubPull()
    await vi.waitFor(() => expect(fake.calls.pull).toBe(1))
    openAs('C:/p/B')
    h.release({ result: 'updated', status: statusOf('A') })
    await pulling
    expect(fake.calls.open).toBe(0)
    expect(docStore.getState().filePath).toBe('C:/p/B')
  })

  it('the conflict dialog closes when another project opens or the same one is loaded again, and a late choice does nothing', async () => {
    vi.stubGlobal('window', { setInterval: () => 0 })
    startGithubWatch()
    openAs('C:/p/A')
    fake.next.pull = async () => ({ result: 'conflict', conflicts: ['plan.json'], status: statusOf('A') })
    await githubPull()
    expect(githubStore.getState().dialog).toBe('conflict')
    const stale = githubStore.getState().conflictGen
    openAs('C:/p/B')
    expect(githubStore.getState()).toMatchObject({ dialog: null, conflicts: [], conflictGen: null })

    // same folder, another load (an old version viewed): closed as well
    openAs('C:/p/A')
    await githubPull()
    expect(githubStore.getState().dialog).toBe('conflict')
    openAs('C:/p/A', 'version')
    expect(githubStore.getState().dialog).toBeNull()

    // a choice made in a dialog that stayed on screen (state from before the switch) settles nothing
    githubStore.setState({ dialog: 'conflict', conflictGen: stale })
    await githubResolve('theirs')
    expect(fake.calls.resolve).toBe(0)
    vi.unstubAllGlobals()
  })
})
