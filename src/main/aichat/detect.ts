/**
 * Finding agent CLIs on PATH (Windows: .exe/.cmd shims included) and spawning them without a shell.
 * npm `.cmd` shims are resolved to their JS entry and run with Electron-as-Node, so arguments
 * (system prompt, JSON) never pass through cmd.exe quoting.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

export interface ResolvedBin {
  /** what was found on PATH */
  path: string
  /** what to execute */
  command: string
  /** arguments that precede the user's (the JS entry for shims) */
  prefix: string[]
  /** run with ELECTRON_RUN_AS_NODE=1 */
  asNode: boolean
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** npm / pnpm cmd shim → JS entry ("%dp0%\node_modules\…\cli.js") */
export function shimEntry(cmdPath: string, content: string): string | null {
  const m = /"%~?dp0%?\\([^"%]+?\.(?:c|m)?js)"/i.exec(content)
  if (!m) return null
  const p = join(dirname(cmdPath), m[1])
  return existsSync(p) ? p : null
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): ResolvedBin | null {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean)
  const win = process.platform === 'win32'
  const exts = win ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const d of dirs) {
    // relative entries ('.', 'bin') would resolve against the app's current folder
    if (!isAbsolute(d)) continue
    for (const ext of exts) {
      const p = join(d, name + ext)
      if (!isFile(p)) continue
      if (win && ext === '') continue // extensionless sh scripts next to npm shims
      if (win && (ext === '.cmd' || ext === '.bat')) {
        let content = ''
        try {
          content = readFileSync(p, 'utf8')
        } catch {
          continue
        }
        const entry = shimEntry(p, content)
        if (!entry) continue
        return { path: p, command: process.execPath, prefix: [entry], asNode: true }
      }
      return { path: p, command: p, prefix: [], asNode: false }
    }
  }
  return null
}

export function spawnBin(bin: ResolvedBin, args: string[], opts: SpawnOptions & { env?: NodeJS.ProcessEnv }): ChildProcess {
  const env = { ...(opts.env ?? process.env) }
  if (bin.asNode) env['ELECTRON_RUN_AS_NODE'] = '1'
  else delete env['ELECTRON_RUN_AS_NODE']
  return spawn(bin.command, [...bin.prefix, ...args], { ...opts, env, shell: false, windowsHide: true })
}

export function binVersion(bin: ResolvedBin): Promise<string | undefined> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (bin.asNode) env['ELECTRON_RUN_AS_NODE'] = '1'
    execFile(bin.command, [...bin.prefix, '--version'], { env, timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined)
      resolve(String(stdout).trim().split(/\r?\n/)[0]?.slice(0, 80) || undefined)
    })
  })
}

/** Runs a short CLI command (status checks) and collects its output; never rejects. */
export function binOutput(bin: ResolvedBin, args: string[], timeout = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (bin.asNode) env['ELECTRON_RUN_AS_NODE'] = '1'
    else delete env['ELECTRON_RUN_AS_NODE']
    execFile(bin.command, [...bin.prefix, ...args], { env, timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** Kills a child and everything it started. */
export function killTree(child: ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      child.kill()
    }
  } else {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 2000).unref()
  }
}
