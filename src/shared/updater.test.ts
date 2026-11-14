import { describe, expect, it } from 'vitest'
import {
  clampPercent,
  detectUpdateMode,
  errorMessage,
  errorStatus,
  isBusy,
  isNoteworthy,
  isOfflineError,
  noticeFor,
  releaseNotesText,
  releasePageUrl,
  statusVersion,
  type UpdateState,
  type UpdateStatus,
} from './updater'

const state = (status: UpdateStatus, mode: UpdateState['mode'] = 'auto'): UpdateState => ({ mode, current: '0.5.0', status })

describe('detectUpdateMode', () => {
  it('is disabled in dev runs', () => {
    expect(detectUpdateMode(false, {})).toBe('disabled')
    expect(detectUpdateMode(false, { PORTABLE_EXECUTABLE_DIR: 'C:\\x' })).toBe('disabled')
  })
  it('detects the portable exe by PORTABLE_EXECUTABLE_DIR', () => {
    expect(detectUpdateMode(true, { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' })).toBe('portable')
    expect(detectUpdateMode(true, { PORTABLE_EXECUTABLE_DIR: '' })).toBe('auto')
    expect(detectUpdateMode(true, {})).toBe('auto')
  })
})

describe('releasePageUrl', () => {
  it('points at the v-prefixed tag', () => {
    expect(releasePageUrl('0.6.0')).toBe('https://github.com/totKtoXam/doplan/releases/tag/v0.6.0')
    expect(releasePageUrl('v0.6.0')).toBe('https://github.com/totKtoXam/doplan/releases/tag/v0.6.0')
    expect(releasePageUrl()).toBe('https://github.com/totKtoXam/doplan/releases')
  })
})

describe('errors', () => {
  it('recognises offline errors', () => {
    expect(isOfflineError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isOfflineError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe(true)
    expect(isOfflineError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isOfflineError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(true)
    expect(isOfflineError(new Error('Cannot find latest.yml in the latest release artifacts'))).toBe(false)
    expect(isOfflineError(new Error('HttpError: 404'))).toBe(false)
  })
  it('keeps messages to one short line', () => {
    expect(errorMessage(new Error('HttpError: 404 \n"method: GET url: https://…"\n\nData:\n…'))).toBe('HttpError: 404')
    expect(errorMessage('x'.repeat(500))).toHaveLength(200)
    expect(errorMessage(new Error(''))).toBe('Неизвестная ошибка')
  })
  it('keeps the version of a failed download, not of a failed check', () => {
    const offline = new Error('net::ERR_CONNECTION_RESET')
    expect(errorStatus({ kind: 'checking' }, offline)).toEqual({ kind: 'error', offline: true, message: 'net::ERR_CONNECTION_RESET' })
    const prog: UpdateStatus = { kind: 'progress', version: '0.6.0', percent: 40, transferred: 4, total: 10, bytesPerSecond: 1 }
    expect(errorStatus(prog, new Error('sha512 checksum mismatch'))).toEqual({
      kind: 'error',
      offline: false,
      message: 'sha512 checksum mismatch',
      version: '0.6.0',
    })
  })
})

describe('releaseNotesText', () => {
  it('turns GitHub HTML into text', () => {
    expect(releaseNotesText('<h2>Новое</h2><ul><li>Обновления &amp; прогресс</li><li>Фикс</li></ul>')).toBe('Новое\n• Обновления & прогресс\n• Фикс')
  })
  it('joins per-version notes', () => {
    expect(
      releaseNotesText([
        { version: '0.6.0', note: '<p>a</p>' },
        { version: '0.5.1', note: null },
      ]),
    ).toBe('0.6.0\na')
    expect(releaseNotesText(null)).toBe('')
  })
})

describe('status logic', () => {
  const available: UpdateStatus = { kind: 'available', version: '0.6.0', notes: '', releaseUrl: '' }
  const downloaded: UpdateStatus = { kind: 'downloaded', version: '0.6.0', notes: '', releaseUrl: '' }

  it('busy while a check, a download or an installed-on-quit update is pending', () => {
    expect(isBusy({ kind: 'checking' })).toBe(true)
    expect(isBusy(downloaded)).toBe(true)
    expect(isBusy(available)).toBe(false)
    expect(isBusy({ kind: 'error', offline: true, message: '' })).toBe(false)
  })

  it('background check failures stay quiet', () => {
    expect(isNoteworthy({ kind: 'error', offline: true, message: 'x' })).toBe(false)
    expect(isNoteworthy({ kind: 'error', offline: false, message: '404' })).toBe(false)
    expect(isNoteworthy({ kind: 'error', offline: true, message: 'x', version: '0.6.0' })).toBe(true)
    expect(isNoteworthy({ kind: 'not-available', version: '0.5.0' })).toBe(false)
    expect(isNoteworthy(available)).toBe(true)
  })

  it('statusVersion is the release version, never the running one', () => {
    expect(statusVersion(available)).toBe('0.6.0')
    expect(statusVersion({ kind: 'not-available', version: '0.5.0' })).toBeNull()
    expect(statusVersion({ kind: 'error', offline: true, message: '' })).toBeNull()
  })

  it('notice: shown for news, hidden after «Позже» for that version and in dev', () => {
    expect(noticeFor(state(available), null)).toBe(available)
    expect(noticeFor(state(available), '0.6.0')).toBeNull()
    expect(noticeFor(state(downloaded), '0.5.9')).toBe(downloaded)
    expect(noticeFor(state(available, 'portable'), null)).toBe(available)
    expect(noticeFor(state(available, 'disabled'), null)).toBeNull()
    expect(noticeFor(state({ kind: 'checking' }), null)).toBeNull()
  })

  it('clamps progress', () => {
    expect(clampPercent(42.5)).toBe(42.5)
    expect(clampPercent(140)).toBe(100)
    expect(clampPercent(Number.NaN)).toBe(0)
    expect(clampPercent(undefined)).toBe(0)
  })
})
