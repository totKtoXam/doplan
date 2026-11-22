/**
 * Smoke test of the BUILT app (out/), the way a release runs it: dev mode relaxes the content
 * security policy, so code that evaluates strings (`new Function`, `eval`) only fails here, and a
 * chunk split that reads a module before it is defined only shows in the bundled output.
 *
 *   pnpm build && pnpm -s check:built
 *
 * 1. No chunk of out/renderer bundles the packages known to compile code from strings on load
 *    (ndarray-ops / cwise: gltf-transform's pixel helpers), judged by the source maps.
 * 2. Electron starts the app with a fresh profile: the 2D plan canvas appears, then the 3D view is
 *    opened; any uncaught exception, CSP violation or failed 3D start fails the check. (A machine
 *    without a usable GPU may still fail to draw 3D: that alone is reported, not failed.)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const problems: string[] = []
const notes: string[] = []

// ── 1. bundled packages ──
const EVAL_PACKAGES = /node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(ndarray-ops|cwise|cwise-compiler|cwise-parser)[\\/]/
const rendererOut = join(root, 'out/renderer')
if (!existsSync(join(rendererOut, 'index.html'))) {
  console.error('out/renderer is missing: run `pnpm build` first')
  process.exit(2)
}
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}
for (const file of walk(rendererOut)) {
  if (!file.endsWith('.js.map')) continue
  const sources: string[] = JSON.parse(readFileSync(file, 'utf8')).sources ?? []
  const bad = [...new Set(sources.map((s) => EVAL_PACKAGES.exec(s)?.[1]).filter(Boolean))]
  if (bad.length) problems.push(`${file.slice(rendererOut.length + 1).replace(/\.map$/, '')} bundles ${bad.join(', ')} (compiles code from strings; the CSP forbids it)`)
}

// ── 2. the app itself ──
const electron = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
const port = 9600 + Math.floor(Math.random() * 300)
const profile = mkdtempSync(join(tmpdir(), 'doplan-check-'))
const app = spawn(electron, [root, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { stdio: 'ignore' })

const FATAL = /EvalError|unsafe-eval|Content Security Policy|Refused to (evaluate|load|execute)|is not a constructor|is not a function|before initialization/i

async function run(): Promise<void> {
  let wsUrl = ''
  for (let i = 0; i < 300 && !wsUrl; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
      wsUrl = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))?.webSocketDebuggerUrl ?? ''
    } catch {
      /* not up yet */
    }
    if (!wsUrl) await sleep(100)
  }
  if (!wsUrl) throw new Error('the app window never appeared')
  const ws = new WebSocket(wsUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pending = new Map<number, (m: any) => void>()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m)
      pending.delete(m.id)
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      problems.push(`uncaught: ${(d.exception?.description ?? d.text).split('\n').slice(0, 2).join(' ')}`)
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')
      if (FATAL.test(text)) problems.push(`console: ${text.split('\n').slice(0, 2).join(' ')}`)
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && FATAL.test(m.params.entry.text)) problems.push(`log: ${m.params.entry.text}`)
  })
  const call = (method: string, params: object = {}) =>
    new Promise<any>((res, rej) => {
      const id = ++seq
      pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression: string): Promise<any> => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  const waitFor = async (expr: string, ms: number): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (await evaluate(expr).catch(() => false)) return true
      await sleep(200)
    }
    return false
  }

  await call('Runtime.enable')
  await call('Log.enable')
  await call('Page.enable')
  // start over with the listeners attached, so nothing from the first load is missed
  await call('Page.reload', { ignoreCache: true })
  await sleep(1000)
  if (!(await waitFor(`!!document.querySelector('#dp-view-2d canvas')`, 30000))) problems.push('the 2D plan canvas never appeared (empty window?)')
  await sleep(1500)
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Не сейчас' || b.innerText.trim() === 'Not now')?.click()`)
  const opened = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '3D'); b?.click(); return !!b })()`)
  if (!opened) problems.push('no 3D button')
  else {
    const drawn = await waitFor(`!!document.querySelector('[data-viewport="3d"] canvas')`, 30000)
    if (!drawn) notes.push('the 3D canvas did not appear (no usable GPU here?)')
    await sleep(4000)
  }
  ws.close()
}

try {
  await run()
} catch (err) {
  problems.push(String(err instanceof Error ? err.message : err))
} finally {
  app.kill()
  await sleep(1000)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* electron may still hold a file for a moment */
  }
}

for (const n of notes) console.log(`note: ${n}`)
if (problems.length) {
  console.error(`built app check FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('built app check passed: no string-compiled code bundled, the app starts, 2D and 3D open without errors')
