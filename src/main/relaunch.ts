/**
 * Relaunch after an update install, independent of the NSIS installer.
 *
 * The silent NSIS update (`--updated /S --force-run`) is supposed to start the app again itself, but it does
 * not always manage to: an install in a folder that needs admin rights (C:\Program Files with the per-user
 * installer) runs elevated, and the installer's own "start the app as the user" step can quietly fail there.
 *
 * So before quitting for the install, the app leaves a small hidden PowerShell watcher behind. It waits for the
 * app to exit and the installer to finish, then starts the installed exe, unless something (the installer)
 * already did. After a timeout it starts whatever is installed, so a failed install still gives the app back.
 */
import { spawn } from 'node:child_process'
import { basename, extname } from 'node:path'

export interface RelaunchWatch {
  /** pid of the app that is quitting for the install */
  parentPid: number
  /** the installed exe to start again (process.execPath) */
  exePath: string
  /** version being installed, e.g. "0.15.1" */
  version: string
  /** downloaded installer file (its process name marks the install as busy) */
  installerFile?: string
  /** watcher log (appended) */
  logPath: string
  /** give up waiting for the install after this many seconds (default 600) */
  timeoutSec?: number
}

/** single-quoted PowerShell string literal */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** process names that mean "the install is still running" */
export function installerProcessNames(installerFile?: string): string[] {
  const names = ['elevate', 'old-uninstaller', `Uninstall doplan`]
  if (installerFile) {
    const n = basename(installerFile, extname(installerFile))
    if (n) names.unshift(n)
  }
  return [...new Set(names)]
}

/** the watcher script (PowerShell 5+, no profile) */
export function relaunchWatcherScript(w: RelaunchWatch): string {
  const pid = Math.trunc(w.parentPid)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('bad parent pid')
  const timeout = Math.max(30, Math.trunc(w.timeoutSec ?? 600))
  const names = installerProcessNames(w.installerFile).map(psQuote).join(', ')
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$exe = ${psQuote(w.exePath)}`,
    `$ver = ${psQuote(w.version)}`,
    `$log = ${psQuote(w.logPath)}`,
    `$parent = ${pid}`,
    `$busyNames = @(${names})`,
    `$dir = Split-Path -Parent $exe`,
    `function L($m) { try { Add-Content -LiteralPath $log -Value ('{0:s} [relaunch] {1}' -f (Get-Date), $m) } catch {} }`,
    `function AppRunning { @(Get-CimInstance Win32_Process -Filter "Name='$(Split-Path -Leaf $exe)'" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $exe) }).Count -gt 0 }`,
    `function InstallerBusy { @(Get-Process | Where-Object { $busyNames -contains $_.ProcessName }).Count -gt 0 }`,
    `function Updated { try { ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion) -like "$ver*" } catch { $false } }`,
    `function Launch($why) { if (AppRunning) { L "already running ($why)"; exit 0 }; Start-Process -FilePath $exe -ArgumentList '--updated' -WorkingDirectory $dir; L "started $exe ($why)"; exit 0 }`,
    `L "watching: parent=$parent target=$ver exe=$exe"`,
    // 1) the app quits (quitAndInstall → app.quit())
    `$until = (Get-Date).AddSeconds(90)`,
    `while ((Get-Process -Id $parent -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $until)) { Start-Sleep -Milliseconds 500 }`,
    // 2) the installer finishes: new exe in place and no installer process left
    `$until = (Get-Date).AddSeconds(${timeout})`,
    `while ((Get-Date) -lt $until) {`,
    `  if (AppRunning) { L 'started by the installer'; exit 0 }`,
    `  if (-not (InstallerBusy) -and (Updated)) { Start-Sleep -Seconds 3; if (-not (InstallerBusy)) { Launch 'install finished' } }`,
    `  Start-Sleep -Seconds 2`,
    `}`,
    // 3) timeout: give the user back whatever is installed
    `if (Test-Path -LiteralPath $exe) { Launch 'timeout' }`,
    `L 'timeout, exe missing'`,
  ].join('\n')
}

/** -EncodedCommand payload: base64 of UTF-16LE */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** start the watcher detached and hidden; never throws */
export function spawnRelaunchWatcher(w: RelaunchWatch, onError: (err: unknown) => void = () => {}): boolean {
  if (process.platform !== 'win32') return false
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShell(relaunchWatcherScript(w))],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.on('error', onError)
    child.unref()
    return true
  } catch (err) {
    onError(err)
    return false
  }
}
