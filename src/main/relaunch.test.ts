import { describe, expect, it } from 'vitest'
import { encodePowerShell, installerProcessNames, psQuote, relaunchWatcherScript } from './relaunch'

const base = {
  parentPid: 4242,
  exePath: 'C:\\Program Files\\doplan\\doplan.exe',
  version: '0.15.1',
  installerFile: 'C:\\Users\\me\\AppData\\Local\\doplan-updater\\pending\\doplan-setup-0.15.1.exe',
  logPath: 'C:\\Users\\me\\AppData\\Roaming\\doplan\\logs\\updater.log',
}

describe('relaunch watcher', () => {
  it('quotes PowerShell strings', () => {
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'")
  })

  it('treats the downloaded installer, elevate and the old uninstaller as a running install', () => {
    expect(installerProcessNames(base.installerFile)).toEqual(['doplan-setup-0.15.1', 'elevate', 'old-uninstaller', 'Uninstall doplan'])
    expect(installerProcessNames()).toEqual(['elevate', 'old-uninstaller', 'Uninstall doplan'])
  })

  it('waits for the app, then the installer, then starts the installed exe', () => {
    const s = relaunchWatcherScript(base)
    expect(s).toContain("$exe = 'C:\\Program Files\\doplan\\doplan.exe'")
    expect(s).toContain("$ver = '0.15.1'")
    expect(s).toContain('$parent = 4242')
    expect(s).toContain("'doplan-setup-0.15.1'")
    const parentWait = s.indexOf('Get-Process -Id $parent')
    const installWait = s.indexOf('InstallerBusy) -and (Updated)')
    const timeoutLaunch = s.indexOf("Launch 'timeout'")
    expect(parentWait).toBeGreaterThan(0)
    expect(installWait).toBeGreaterThan(parentWait)
    expect(timeoutLaunch).toBeGreaterThan(installWait)
    // never a second copy when the installer already started the app
    expect(s).toMatch(/function Launch\(\$why\) \{ if \(AppRunning\)/)
  })

  it('a quote in a path cannot break out of the string', () => {
    const s = relaunchWatcherScript({ ...base, exePath: "C:\\x'; Remove-Item C:\\ -Recurse; '\\doplan.exe" })
    expect(s).toContain("$exe = 'C:\\x''; Remove-Item C:\\ -Recurse; ''\\doplan.exe'")
  })

  it('rejects a bad parent pid', () => {
    expect(() => relaunchWatcherScript({ ...base, parentPid: 0 })).toThrow()
    expect(() => relaunchWatcherScript({ ...base, parentPid: Number.NaN })).toThrow()
  })

  it('encodes for -EncodedCommand as UTF-16LE base64', () => {
    expect(Buffer.from(encodePowerShell('Write-Output 1'), 'base64').toString('utf16le')).toBe('Write-Output 1')
  })
})
