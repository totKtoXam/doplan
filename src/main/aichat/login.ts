/**
 * Signing the agent CLIs in from the app: `claude auth login` / `codex login` run with piped stdio,
 * their sign-in link is shown in the chat (the CLI also opens the browser itself) and a pasted code
 * is forwarded to the CLI's stdin. Sign-in state comes from `claude auth status` / `codex login status`.
 */
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { AiLoginEvent, AiProviderId } from '../../shared/aiChat'
import { binOutput, killTree, spawnBin, type ResolvedBin } from './detect'

export interface AuthState {
  auth: 'ok' | 'required' | 'unknown'
  account?: string
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const strip = (s: string) => s.replace(ANSI, '')

/** Credential failures as the CLIs print them (stream result text, stderr). */
export function isAuthError(text: string | undefined): boolean {
  if (!text) return false
  return /failed to authenticate|oauth (session|token)|not logged in|please (run )?\/?login|log ?in again|invalid api key|authentication_error|401 unauthorized|token (has )?expired|refresh token|codex login/i.test(text)
}

const SUB_LABEL: Record<string, string> = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise' }

export async function authStatus(id: AiProviderId, bin: ResolvedBin): Promise<AuthState> {
  if (id === 'claude') {
    const r = await binOutput(bin, ['auth', 'status', '--json'], 20000)
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; email?: unknown }
      if (j.loggedIn === true) {
        const sub = typeof j.subscriptionType === 'string' ? SUB_LABEL[j.subscriptionType] ?? j.subscriptionType : undefined
        const method = typeof j.authMethod === 'string' && j.authMethod !== 'none' ? j.authMethod : undefined
        return { auth: 'ok', account: sub ?? method }
      }
      if (j.loggedIn === false) return { auth: 'required' }
    } catch {
      // older CLI without `auth status`
    }
    return { auth: 'unknown' }
  }
  if (id === 'codex') {
    const r = await binOutput(bin, ['login', 'status'], 20000)
    const out = strip(`${r.stdout}\n${r.stderr}`)
    const m = /logged in using ([^\r\n]+)/i.exec(out)
    if (m) return { auth: 'ok', account: m[1].trim() }
    if (/not logged in/i.test(out)) return { auth: 'required' }
    return { auth: 'unknown' }
  }
  return { auth: 'unknown' }
}

/** Sign-in pages the app may open itself (the CLIs print other URLs too). */
function isLoginUrl(u: string): boolean {
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && /(^|\.)(claude\.com|claude\.ai|anthropic\.com|openai\.com|chatgpt\.com)$/i.test(url.hostname)
  } catch {
    return false
  }
}

let current: { provider: AiProviderId; child: ChildProcess; manual: boolean } | null = null

export function cancelLogin(): void {
  if (current) killTree(current.child)
  current = null
}

export function loginInput(text: string): void {
  const c = current
  if (!c?.child.stdin || c.child.stdin.destroyed) return
  c.child.stdin.write(`${text.trim().slice(0, 4000)}\n`)
}

/**
 * Starts the CLI's sign-in. `emit` streams progress; `onFinished` runs after the CLI exits (the
 * caller refreshes provider detection).
 */
export function startLogin(provider: AiProviderId, bin: ResolvedBin, emit: (ev: AiLoginEvent) => void, onFinished: () => void): void {
  cancelLogin()
  const args = provider === 'claude' ? ['auth', 'login'] : provider === 'codex' ? ['login'] : null
  if (!args) {
    emit({ type: 'done', ok: false, error: 'Этот провайдер не входит через приложение' })
    return
  }
  let child: ChildProcess
  try {
    child = spawnBin(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    emit({ type: 'done', ok: false, error: (e as Error).message })
    return
  }
  const me = { provider, child, manual: false }
  current = me
  let out = ''
  let sentUrl = false
  const onData = (d: Buffer | string) => {
    const text = strip(String(d))
    out = (out + text).slice(-8000)
    emit({ type: 'output', text })
    if (!sentUrl) {
      const m = /https:\/\/[^\s"'<>]+/.exec(out)
      if (m && isLoginUrl(m[0])) {
        sentUrl = true
        emit({ type: 'url', url: m[0] })
      }
    }
    // the CLI insists on a real terminal: finish the sign-in in a console window
    if (/not a terminal|raw mode is not supported|isTTY/i.test(text) && !me.manual) {
      me.manual = true
      const opened = openInTerminal(bin, args)
      emit({
        type: 'output',
        text: opened ? `\n${LOGIN_TEXT.opened}\n` : `\n${LOGIN_TEXT.runYourself} ${provider} ${args.join(' ')}\n`,
      })
      // either way the piped CLI cannot finish: wait for the sign-in made in the terminal
      void pollUntilSignedIn(provider, bin, me, emit, onFinished)
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', (e) => emit({ type: 'output', text: `\n${e.message}\n` }))
  child.on('close', async (code) => {
    if (me.manual) return
    if (current === me) current = null
    const st = await authStatus(provider, bin)
    const ok = st.auth === 'ok' || (st.auth === 'unknown' && code === 0)
    const tail = out.trim().split(/\r?\n/).slice(-4).join('\n')
    emit({ type: 'done', ok, error: ok ? undefined : tail || `Вход не завершён (код ${code})` })
    onFinished()
  })
}

const LOGIN_TEXT = {
  opened: 'Открыто окно терминала — завершите вход там.',
  runYourself: 'Этой CLI нужен настоящий терминал. Выполните в терминале:',
}

/**
 * The console command line for a sign-in window: `/s /c "start "title" cmd /k ""bin" "arg" sub""`.
 * Passed verbatim (Node would re-quote it with backslashes, which cmd.exe does not understand).
 * The outer cmd strips the first and last quote; in what is left the `""` before each path opens and
 * closes a quote, so the outer cmd sees the paths unquoted and their metacharacters (`R&D`) get a `^`.
 * The inner `cmd /k` strips the pair around the command and sees the paths quoted.
 * null when a part cannot be passed safely (`"`, `%`, `!`, line breaks): the user runs it by hand.
 */
export function terminalCommandLine(command: string, prefix: string[], args: string[]): string | null {
  const paths = [command, ...prefix]
  if (paths.some((s) => !s || /["%!\r\n]/.test(s))) return null
  if (args.some((a) => !/^[\w.:=/-]+$/.test(a))) return null
  const q = (s: string) => `"${s.replace(/[&|<>^()]/g, '^$&')}"`
  const cmd = [...paths.map(q), ...args].join(' ')
  return `/d /s /c "start "doplan" cmd /k "${cmd}""`
}

/** Opens a console window running the CLI sign-in; false where the app cannot open one. */
function openInTerminal(bin: ResolvedBin, args: string[]): boolean {
  if (process.platform !== 'win32') return false
  const line = terminalCommandLine(bin.command, bin.prefix, args)
  if (!line) return false
  const env = { ...process.env }
  if (bin.asNode) env['ELECTRON_RUN_AS_NODE'] = '1'
  try {
    // arguments are app-controlled (binary path + fixed subcommands)
    spawn('cmd.exe', [line], {
      env,
      windowsHide: false,
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
    }).unref()
    return true
  } catch {
    return false
  }
}

async function pollUntilSignedIn(
  provider: AiProviderId,
  bin: ResolvedBin,
  me: { child: ChildProcess },
  emit: (ev: AiLoginEvent) => void,
  onFinished: () => void,
): Promise<void> {
  killTree(me.child)
  const until = Date.now() + 10 * 60_000
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000))
    if (current?.child !== me.child) return // cancelled or restarted
    const st = await authStatus(provider, bin)
    if (st.auth === 'ok') {
      current = null
      emit({ type: 'done', ok: true })
      onFinished()
      return
    }
  }
  if (current?.child === me.child) current = null
  emit({ type: 'done', ok: false, error: 'Время ожидания входа истекло' })
}
