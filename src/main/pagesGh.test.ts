import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GhResult } from './github'
import { isNoAccess, PagesGhError } from './pagesError'

const gh = vi.hoisted(() => ({ next: [] as GhResult[], args: [] as string[][] }))

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./settings', () => ({ msg: (ru: string) => ru }))
vi.mock('./github', () => ({
  runGh: async (args: string[]) => {
    gh.args.push(args)
    return gh.next.shift() ?? { code: 0, stdout: '', stderr: '' }
  },
  accountPlan: async () => null,
  createRepo: async () => ({ owner: 'me', repo: 'x' }),
  setRepoVisibility: async () => undefined,
}))

const { disablePages, ghError, repoState } = await import('./pagesGh')
const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr })
const ref = { owner: 'me', repo: 'flat' }

beforeEach(() => {
  gh.next = []
  gh.args = []
})

describe('pagesGh errors', () => {
  it('gives every refusal its kind and status, whatever the wording of the message', () => {
    const forbidden = ghError(fail('gh: Must have admin rights to Repository. (HTTP 403)'), 'Не удалось выключить GitHub Pages')
    expect(forbidden).toBeInstanceOf(PagesGhError)
    expect(forbidden).toMatchObject({ kind: 'forbidden', status: 403 })
    expect(forbidden.message).not.toMatch(/403/)
    expect(isNoAccess(forbidden)).toBe(true)
    expect(ghError(fail('HTTP 401: Bad credentials'), 'x')).toMatchObject({ kind: 'auth', status: 401 })
    expect(ghError(fail('gh: Not Found (HTTP 404)'), 'x')).toMatchObject({ kind: 'notFound', status: 404 })
    expect(ghError(fail('error connecting to api.github.com: could not resolve host'), 'x')).toMatchObject({ kind: 'network' })
    const other = ghError(fail('gh: Validation Failed (HTTP 422)'), 'x')
    expect(other).toMatchObject({ kind: 'unknown', status: 422 })
    expect(isNoAccess(other)).toBe(false)
  })

  it('tells a refused git push from other git failures by its raw output', () => {
    expect(isNoAccess(Object.assign(new Error('push failed'), { stderr: 'remote: Permission to me/flat.git denied to you.' }))).toBe(true)
    expect(isNoAccess(Object.assign(new Error('push failed'), { stderr: 'fatal: unable to access: The requested URL returned error: 403' }))).toBe(true)
    expect(isNoAccess(Object.assign(new Error('push failed'), { stderr: 'deletion of the current branch prohibited' }))).toBe(false)
    // a translated message that merely mentions permissions is not a refusal
    expect(isNoAccess(new Error('нет прав (permission denied)'))).toBe(false)
  })

  it('disablePages: no admin rights come back typed; off already is not a failure', async () => {
    gh.next = [fail('gh: Must have admin rights to Repository. (HTTP 403)')]
    await expect(disablePages(ref)).rejects.toMatchObject({ kind: 'forbidden' })
    gh.next = [fail('gh: Not Found (HTTP 404)')]
    await expect(disablePages(ref)).resolves.toBe(false)
  })

  it('repoState reads the default branch', async () => {
    gh.next = [{ code: 0, stdout: 'false true gh-pages\n', stderr: '' }]
    await expect(repoState(ref)).resolves.toEqual({ exists: true, isPrivate: false, canPush: true, defaultBranch: 'gh-pages' })
    gh.next = [{ code: 0, stdout: 'true false \n', stderr: '' }]
    await expect(repoState(ref)).resolves.toEqual({ exists: true, isPrivate: true, canPush: false })
  })
})
