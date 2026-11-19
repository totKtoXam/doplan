import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from './github'
import { isNoAccess, PagesGhError } from './pagesError'

const api = vi.hoisted(() => ({ next: [] as ApiResponse[], calls: [] as string[] }))

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./settings', () => ({ msg: (ru: string) => ru }))
vi.mock('./github', () => ({
  githubApi: async (method: string, path: string) => {
    api.calls.push(`${method} ${path}`)
    return api.next.shift() ?? { status: 200, json: {}, text: '' }
  },
  apiError: (r: ApiResponse) => new Error(`HTTP ${r.status}`),
  accountPlan: async () => null,
  createRepo: async () => ({ owner: 'me', repo: 'x' }),
  setRepoVisibility: async () => undefined,
}))

const { disablePages, pagesError, repoState } = await import('./pagesGh')
const res = (status: number, message?: string): ApiResponse => ({ status, json: message ? { message } : null, text: message ?? '' })
const ref = { owner: 'me', repo: 'flat' }

beforeEach(() => {
  api.next = []
  api.calls = []
})

describe('pagesGh errors', () => {
  it('gives every refusal its kind and status, whatever the wording of the message', () => {
    const forbidden = pagesError(res(403, 'Must have admin rights to Repository.'), 'Не удалось выключить GitHub Pages')
    expect(forbidden).toBeInstanceOf(PagesGhError)
    expect(forbidden).toMatchObject({ kind: 'forbidden', status: 403 })
    expect(forbidden.message).not.toMatch(/403/)
    expect(isNoAccess(forbidden)).toBe(true)
    expect(pagesError(res(404, 'Not Found'), 'x')).toMatchObject({ kind: 'notFound', status: 404 })
    const other = pagesError(res(422, 'Validation Failed'), 'x')
    expect(other).toMatchObject({ kind: 'unknown', status: 422 })
    expect(isNoAccess(other)).toBe(false)
  })

  it('a rate limit or a token without the permission is not "no access" (the record stays)', () => {
    for (const r of [res(403, 'API rate limit exceeded for user ID 1.'), res(403, 'You have exceeded a secondary rate limit.'), res(429, 'Too Many Requests')]) {
      const e = pagesError(r, 'x')
      expect(e.kind).toBe('limited')
      expect(isNoAccess(e)).toBe(false)
    }
    const token = pagesError(res(403, 'Resource not accessible by personal access token'), 'x')
    expect(token.kind).toBe('token')
    expect(isNoAccess(token)).toBe(false)
  })

  it('tells a refused git push from other git failures by its raw output', () => {
    expect(isNoAccess(Object.assign(new Error('push failed'), { stderr: 'remote: Permission to me/flat.git denied to you.' }))).toBe(true)
    expect(isNoAccess(Object.assign(new Error('push failed'), { stderr: 'fatal: unable to access: The requested URL returned error: 403' }))).toBe(true)
    expect(isNoAccess(Object.assign(new Error('push failed'), { stderr: 'deletion of the current branch prohibited' }))).toBe(false)
    // a translated message that merely mentions permissions is not a refusal
    expect(isNoAccess(new Error('нет прав (permission denied)'))).toBe(false)
  })

  it('disablePages: no admin rights come back typed; off already is not a failure', async () => {
    api.next = [res(403, 'Must have admin rights to Repository.')]
    await expect(disablePages(ref)).rejects.toMatchObject({ kind: 'forbidden' })
    api.next = [res(404, 'Not Found')]
    await expect(disablePages(ref)).resolves.toBe(false)
  })

  it('repoState reads push and admin rights and the default branch', async () => {
    api.next = [{ status: 200, json: { private: false, default_branch: 'gh-pages', permissions: { push: true, admin: false } }, text: '' }]
    await expect(repoState(ref)).resolves.toEqual({ exists: true, isPrivate: false, canPush: true, managesPages: false, defaultBranch: 'gh-pages' })
    api.next = [{ status: 200, json: { private: true, permissions: { admin: true } }, text: '' }]
    await expect(repoState(ref)).resolves.toEqual({ exists: true, isPrivate: true, canPush: true, managesPages: true })
    // maintain access may turn Pages off as well
    api.next = [{ status: 200, json: { private: false, permissions: { push: true, maintain: true } }, text: '' }]
    await expect(repoState(ref)).resolves.toMatchObject({ canPush: true, managesPages: true })
    api.next = [res(404)]
    await expect(repoState(ref)).resolves.toEqual({ exists: false, isPrivate: false })
  })
})
