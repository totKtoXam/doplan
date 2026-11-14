/** Locating and launching the doplan app for `--open`. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

export interface Launch {
  launched: boolean
  how?: string
  reason?: string
}

function installedExe(): string | null {
  const cands = [
    process.env.DOPLAN_EXE,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'doplan', 'doplan.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'doplan', 'doplan.exe'),
    join(REPO_ROOT, 'dist', 'win-unpacked', 'doplan.exe'),
    '/Applications/doplan.app/Contents/MacOS/doplan',
    '/usr/bin/doplan',
  ]
  for (const c of cands) if (c && existsSync(c)) return c
  return null
}

function devElectron(): string | null {
  if (!existsSync(join(REPO_ROOT, 'out', 'main', 'index.js'))) return null
  try {
    const req = createRequire(join(REPO_ROOT, 'package.json'))
    const exe = req('electron') as unknown
    return typeof exe === 'string' && existsSync(exe) ? exe : null
  } catch {
    return null
  }
}

/** Opens `file` in doplan (installed app, or the built dev app via electron). Never blocks. */
export function openInApp(file: string): Launch {
  const abs = resolve(file)
  const exe = installedExe()
  try {
    if (exe) {
      spawn(exe, [abs], { detached: true, stdio: 'ignore' }).unref()
      return { launched: true, how: exe }
    }
    const electron = devElectron()
    if (electron) {
      spawn(electron, [REPO_ROOT, abs], { detached: true, stdio: 'ignore', cwd: REPO_ROOT }).unref()
      return { launched: true, how: `electron ${REPO_ROOT} (built app in out/)` }
    }
  } catch (e) {
    return { launched: false, reason: e instanceof Error ? e.message : String(e) }
  }
  return {
    launched: false,
    reason: 'doplan is not installed and the app is not built (out/main/index.js missing); open the file from the app (File → Open) or set DOPLAN_EXE',
  }
}
