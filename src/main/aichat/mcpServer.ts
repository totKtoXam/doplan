/**
 * The `doplan` MCP server agents talk to (Claude Code, Codex, Gemini).
 *
 * Security: listens on 127.0.0.1 only (random port); every request needs a bearer token that is
 * issued per agent run and revoked when the run ends; browser-originated requests (Origin header)
 * and foreign Host headers are refused (DNS rebinding). It exposes the doc tools only — no shell,
 * no file access. Stateless streamable HTTP: one McpServer per POST.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AI_TOOL_DESCRIPTIONS, AI_TOOL_NAMES, AI_TOOL_SHAPES, AI_TOOL_TITLES, MUTATING_TOOLS } from '../../shared/aiTools'
import type { AiToolResult } from '../../shared/aiChat'
import { callDocTool } from './bridge'

const MAX_BODY = 10 * 1024 * 1024

let server: Server | null = null
let port = 0
/** token → runId */
const tokens = new Map<string, string>()

export interface McpEndpoint {
  url: string
  token: string
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function runForToken(header: string | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header ?? '')
  if (!m) return null
  const given = Buffer.from(m[1])
  for (const [tok, runId] of tokens) {
    const want = Buffer.from(tok)
    if (want.length === given.length && timingSafeEqual(want, given)) return runId
  }
  return null
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

export function toMcpContent(r: AiToolResult) {
  const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
    { type: 'text', text: r.text || (r.ok ? 'OK' : 'Ошибка') },
  ]
  if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mime })
  return { content, isError: !r.ok }
}

function buildServer(runId: string): McpServer {
  const mcp = new McpServer({ name: 'doplan', version: '1.0.0' }, { capabilities: { tools: {} } })
  for (const name of AI_TOOL_NAMES) {
    const mutating = MUTATING_TOOLS.has(name)
    mcp.registerTool(
      name,
      {
        title: AI_TOOL_TITLES[name],
        description: AI_TOOL_DESCRIPTIONS[name],
        inputSchema: AI_TOOL_SHAPES[name],
        annotations: { readOnlyHint: !mutating, destructiveHint: name === 'delete' || name === 'apply_planspec', openWorldHint: false },
      },
      (async (args: unknown) => toMcpContent(await callDocTool(runId, name, args))) as never,
    )
  }
  return mcp
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const remote = req.socket.remoteAddress ?? ''
  if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') return sendJson(res, 403, { error: 'forbidden' })
  const host = (req.headers.host ?? '').toLowerCase()
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendJson(res, 403, { error: 'bad host' })
  if (req.headers.origin) return sendJson(res, 403, { error: 'browser requests are not allowed' })
  const path = (req.url ?? '').split('?')[0]
  if (path !== '/mcp') return sendJson(res, 404, { error: 'not found' })
  const runId = runForToken(req.headers.authorization)
  if (!runId) return sendJson(res, 401, { error: 'unauthorized' })
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  let body: unknown
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, (e as Error).message === 'too large' ? 413 : 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
  }
  const mcp = buildServer(runId)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  try {
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (e) {
    console.error('[doplan] mcp request failed', e)
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
  }
}

async function ensureServer(): Promise<number> {
  if (server && port) return port
  const s = createServer((req, res) => {
    void onRequest(req, res)
  })
  s.requestTimeout = 0 // ask-mode tool calls may wait for the user
  s.headersTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => resolve())
  })
  server = s
  port = (s.address() as AddressInfo).port
  return port
}

/** Opens (or reuses) the server and issues a token bound to this run. */
export async function openEndpoint(runId: string): Promise<McpEndpoint> {
  const p = await ensureServer()
  const token = randomBytes(32).toString('base64url')
  tokens.set(token, runId)
  return { url: `http://127.0.0.1:${p}/mcp`, token }
}

export function revokeRun(runId: string): void {
  for (const [tok, r] of tokens) if (r === runId) tokens.delete(tok)
}

export function closeMcpServer(): void {
  tokens.clear()
  server?.close()
  server = null
  port = 0
}
