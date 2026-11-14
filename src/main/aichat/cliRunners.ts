/**
 * Agent CLI runs (one process per turn): Claude Code, Codex, Gemini. Each gets the doplan MCP
 * endpoint with a run-scoped token, streams JSON lines that are normalised into AiRunEvents, and is
 * killed (whole process tree) on stop or app quit.
 */
import type { ChildProcess } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiImage, AiRunEvent, AiRunRequest } from '../../shared/aiChat'
import { ensureDir } from '../fsutil'
import { killTree, spawnBin, type ResolvedBin } from './detect'
import type { McpEndpoint } from './mcpServer'
import { ClaudeStreamParser, CodexJsonParser } from './streamJson'
import { tempDir } from './store'

export interface RunCtx {
  req: AiRunRequest
  emit: (ev: AiRunEvent) => void
  signal: AbortSignal
  endpoint: McpEndpoint
  cwd: string
  systemPrompt: string
  /** user text with chips etc. already folded in */
  userText: string
  /** registers the child so app quit can kill it */
  track: (child: ChildProcess) => void
}

const TOOL_TIMEOUT_MS = String(15 * 60 * 1000)

function tail(s: string, add: string, max = 4000): string {
  const t = s + add
  return t.length > max ? t.slice(t.length - max) : t
}

function cleanStderr(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-6)
    .join('\n')
}

function exitError(name: string, out: ProcOutcome): string {
  const err = cleanStderr(out.stderr)
  return `${name} завершился с кодом ${out.code}${err ? `:\n${err}` : ''}`
}

interface ProcOutcome {
  code: number | null
  stderr: string
}

/** Spawns, pipes stdout into `onStdout`, writes stdin, waits for exit; kills on abort. */
function runProcess(ctx: RunCtx, bin: ResolvedBin, args: string[], env: NodeJS.ProcessEnv, stdin: string, onStdout: (s: string) => void): Promise<ProcOutcome> {
  return new Promise((resolve) => {
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawnBin(bin, args, { cwd: ctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, stderr: (e as Error).message })
      return
    }
    ctx.track(child)
    const onAbort = () => killTree(child)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => onStdout(d))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      stderr = tail(stderr, d)
    })
    child.on('error', (e) => {
      stderr = tail(stderr, `\n${e.message}`)
    })
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve({ code, stderr })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  })
}

// ───────────── Claude Code ─────────────

function claudeContent(text: string, images: AiImage[]): unknown[] {
  return [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })), { type: 'text', text }]
}

export async function runClaude(ctx: RunCtx, bin: ResolvedBin): Promise<void> {
  const { req, emit, endpoint } = ctx
  const dir = tempDir()
  await ensureDir(dir)
  const cfgPath = join(dir, `mcp-${req.runId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
  await writeFile(
    cfgPath,
    JSON.stringify({ mcpServers: { doplan: { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } } } }),
    { mode: 0o600 },
  )
  const s = req.settings
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    cfgPath,
    '--strict-mcp-config',
    '--append-system-prompt',
    ctx.systemPrompt,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    'mcp__doplan',
    // the plan is reachable through the doplan tools only; multi-agent tools for «Ультракод»
    '--tools',
    s.ultracode ? 'Agent,Workflow' : '',
  ]
  const model = s.models.claude
  if (model) args.push('--model', model)
  if (s.effort) args.push('--effort', s.effort)
  if (req.resumeId) args.push('--resume', req.resumeId)

  const text = s.ultracode ? `ultracode\n\n${ctx.userText}` : ctx.userText
  const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content: claudeContent(text, req.images) } }) + '\n'
  const env = { ...process.env, MCP_TOOL_TIMEOUT: TOOL_TIMEOUT_MS, MCP_TIMEOUT: '30000', CLAUDE_CODE_ENTRYPOINT: 'doplan' }

  const parser = new ClaudeStreamParser()
  emit({ type: 'status', text: 'Claude Code запущен…' })
  const out = await runProcess(ctx, bin, args, env, stdin, (d) => {
    for (const ev of parser.push(d)) emit(ev)
  })
  for (const ev of parser.end()) emit(ev)
  await rm(cfgPath, { force: true }).catch(() => {})

  if (ctx.signal.aborted) return emit({ type: 'done', ok: false, stopped: true })
  const r = parser.result
  if (r) return emit({ type: 'done', ok: r.ok, error: r.error })
  emit({ type: 'done', ok: false, error: exitError('Claude Code', out) })
}

// ───────────── Codex ─────────────

function tomlString(s: string): string {
  return JSON.stringify(s) // TOML basic strings share JSON escaping for our inputs
}

export async function runCodex(ctx: RunCtx, bin: ResolvedBin): Promise<void> {
  const { req, emit, endpoint } = ctx
  const s = req.settings
  const dir = tempDir()
  await ensureDir(dir)
  const imgFiles: string[] = []
  for (const [i, im] of req.images.entries()) {
    const ext = im.mime === 'image/png' ? 'png' : im.mime === 'image/webp' ? 'webp' : im.mime === 'image/gif' ? 'gif' : 'jpg'
    const p = join(dir, `img-${req.runId.replace(/[^A-Za-z0-9_-]/g, '')}-${i}.${ext}`)
    await writeFile(p, Buffer.from(im.data, 'base64'))
    imgFiles.push(p)
  }
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', ctx.cwd, '-s', 'read-only']
  args.push('-c', `mcp_servers.doplan.url=${tomlString(endpoint.url)}`)
  args.push('-c', 'mcp_servers.doplan.bearer_token_env_var="DOPLAN_MCP_TOKEN"')
  args.push('-c', `mcp_servers.doplan.tool_timeout_sec=${Number(TOOL_TIMEOUT_MS) / 1000}`)
  args.push('-c', 'approval_policy="never"')
  if (s.models.codex) args.push('-m', s.models.codex)
  if (s.effort) args.push('-c', `model_reasoning_effort=${tomlString(s.effort === 'max' || s.effort === 'xhigh' ? 'high' : s.effort)}`)
  for (const f of imgFiles) args.push('-i', f)
  if (req.resumeId) args.push('resume', req.resumeId)
  args.push('-')

  const prompt = req.resumeId ? ctx.userText : `<doplan-instructions>\n${ctx.systemPrompt}\n</doplan-instructions>\n\n${ctx.userText}`
  const env = { ...process.env, DOPLAN_MCP_TOKEN: endpoint.token }
  const parser = new CodexJsonParser()
  emit({ type: 'status', text: 'Codex запущен…' })
  const out = await runProcess(ctx, bin, args, env, prompt, (d) => {
    for (const ev of parser.push(d)) emit(ev)
  })
  for (const ev of parser.end()) emit(ev)
  for (const f of imgFiles) await rm(f, { force: true }).catch(() => {})

  if (ctx.signal.aborted) return emit({ type: 'done', ok: false, stopped: true })
  const r = parser.result
  if (r) return emit({ type: 'done', ok: r.ok, error: r.error })
  emit({ type: 'done', ok: false, error: exitError('Codex', out) })
}

// ───────────── Gemini (best effort: only offered when the CLI is installed) ─────────────

export async function runGemini(ctx: RunCtx, bin: ResolvedBin): Promise<void> {
  const { req, emit, endpoint } = ctx
  const dir = tempDir()
  await ensureDir(dir)
  const settingsPath = join(dir, `gemini-${req.runId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
  await writeFile(
    settingsPath,
    JSON.stringify({ mcpServers: { doplan: { httpUrl: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, timeout: Number(TOOL_TIMEOUT_MS), trust: true } } }),
    { mode: 0o600 },
  )
  const args = ['-p', `<doplan-instructions>\n${ctx.systemPrompt}\n</doplan-instructions>\n\n${ctx.userText}`, '--allowed-mcp-server-names', 'doplan']
  if (req.settings.models.gemini) args.push('-m', req.settings.models.gemini)
  const env = { ...process.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath }
  emit({ type: 'status', text: 'Gemini CLI запущен…' })
  const partId = `g${Date.now()}`
  const out = await runProcess(ctx, bin, args, env, '', (d) => emit({ type: 'text', partId, delta: d }))
  await rm(settingsPath, { force: true }).catch(() => {})
  if (ctx.signal.aborted) return emit({ type: 'done', ok: false, stopped: true })
  if (out.code === 0) return emit({ type: 'done', ok: true })
  emit({ type: 'done', ok: false, error: exitError('Gemini CLI', out) })
}
