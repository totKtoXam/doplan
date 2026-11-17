/**
 * doplan AI chat: types shared by main (providers, MCP server, chat storage) and the renderer
 * (chat panel, tool executor). Exposed as `window.doplan.aiChat` (see ipc.ts).
 */

export type AiProviderId = 'claude' | 'codex' | 'gemini' | 'api'

export interface AiProviderInfo {
  id: AiProviderId
  label: string
  available: boolean
  /** resolved binary path (CLIs) */
  path?: string
  version?: string
  /** why it is unavailable */
  reason?: string
  /** model choices; '' = provider default */
  models: { id: string; label: string }[]
  /** effort / reasoning levels the provider understands ('' = default) */
  efforts: string[]
  /** reports $ cost */
  reportsCost: boolean
  /** supports image attachments */
  images: boolean
  /** CLI sign-in state: required = the CLI is installed but not signed in */
  auth?: 'ok' | 'required' | 'unknown'
  /** e.g. "Claude Max", "ChatGPT" */
  account?: string
  /** the provider can sign in from the app (claude / codex) */
  canLogin?: boolean
}

/** Per-project chat settings (persisted with the project's chats). */
export interface AiChatSettings {
  provider: AiProviderId
  /** model id per provider ('' = default) */
  models: Partial<Record<AiProviderId, string>>
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Claude Code: append the `ultracode` keyword (multi-agent workflows) */
  ultracode: boolean
  /** document edits: ask = approve each change, auto = apply immediately */
  permission: 'ask' | 'auto'
  /** plan mode: changes are collected on a draft and applied by the user */
  planMode: boolean
}

export const DEFAULT_AI_SETTINGS: AiChatSettings = {
  provider: 'claude',
  models: {},
  effort: '',
  ultracode: false,
  permission: 'auto',
  planMode: false,
}

export interface AiImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** base64 without data: prefix */
  data: string
  name?: string
}

/** Context chip attached from the selection ("Добавить в чат"). */
export interface AiChip {
  kind: string
  id: string
  label: string
  /** one-line summary shown on the chip and sent to the agent */
  summary: string
}

/** Request to start one agent turn. */
export interface AiRunRequest {
  runId: string
  chatId: string
  /** null for unsaved projects */
  projectPath: string | null
  /** informational only: main runs the agent in the project folder it opened itself (never a path from the renderer) */
  projectRoot?: string | null
  settings: AiChatSettings
  text: string
  images: AiImage[]
  chips: AiChip[]
  /** provider session id to resume (Claude / Codex) */
  resumeId?: string
  /** the agent folder that session was made in (AiRunEvent 'session'); main starts a new Claude session when the agent works elsewhere now */
  resumeCwd?: string
  /** Anthropic API provider: prior conversation (opaque JSON kept by the chat) */
  apiHistory?: unknown[]
  /**
   * The earlier turns of the chat as plain text (chatTranscript). Main puts it before the message when
   * the agent starts without a session of its own (none kept, a message was edited, the folder changed),
   * so the new session knows what was said.
   */
  history?: string
}

/** Normalised stream of a running turn (main → renderer). */
export type AiRunEvent =
  | { type: 'status'; text: string }
  /** `cwd`: the agent folder the session belongs to (added by main) */
  | { type: 'session'; id: string; cwd?: string }
  | { type: 'text'; partId: string; delta: string }
  | { type: 'thinking'; partId: string; delta: string }
  /** provider-side tool (not a doplan doc tool), e.g. Read / Agent / web search */
  | { type: 'tool'; partId: string; name: string; input?: unknown; status: 'running' | 'done' | 'error'; output?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  /** Anthropic API provider: updated conversation to persist */
  | { type: 'apiHistory'; messages: unknown[] }
  /** authRequired: the CLI rejected its credentials — offer «Войти» */
  | { type: 'done'; ok: boolean; stopped?: boolean; error?: string; authRequired?: boolean }

/** A doc tool call forwarded from the MCP server / API provider to the renderer. */
export interface AiToolCall {
  callId: string
  runId: string
  tool: string
  args: unknown
}

export interface AiToolResult {
  ok: boolean
  text: string
  image?: { mime: 'image/png' | 'image/jpeg'; data: string }
}

/** one question of the agent's ask_user call */
export interface AiQuestion {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** the user's answer to one question: the options picked and / or their own words */
export interface AiQuestionAnswer {
  picked: string[]
  other?: string
}

// ───────────── persisted chats ─────────────

export type AiPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool'
      id: string
      name: string
      title: string
      /** doc = doplan tool executed in the app; ext = provider tool */
      origin: 'doc' | 'ext'
      args?: unknown
      status: 'running' | 'pending' | 'done' | 'error' | 'rejected' | 'proposed'
      /** human summary of the change / result */
      result?: string
      /** what changed (doc tools) */
      changes?: string[]
      /** thumbnail data URL for render_snapshot */
      image?: string
    }
  /** the agent's questions (ask_user): `id` is the tool call's; `note`: what the user typed in the chat box */
  | {
      type: 'question'
      id: string
      questions: AiQuestion[]
      status: 'pending' | 'answered' | 'cancelled'
      answers?: AiQuestionAnswer[]
      note?: string
    }
  /** login: the CLI's sign-in expired — the notice offers «Войти» */
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string; login?: AiProviderId }

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: string
  parts: AiPart[]
  chips?: AiChip[]
  /** attached images (data URLs, thumbnails only in storage) */
  images?: string[]
  /** passages of the conversation the user quoted (they go before the text as markdown quotes) */
  quotes?: string[]
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  error?: string
}

export interface AiChatMeta {
  id: string
  title: string
  provider: AiProviderId
  createdAt: string
  updatedAt: string
}

export interface AiChatRecord extends AiChatMeta {
  /** provider resume id (Claude session id / Codex thread id), per provider */
  resume?: Partial<Record<AiProviderId, string>>
  /** the agent folder each resume id was made in (Claude Code keeps its sessions per folder) */
  resumeCwd?: Partial<Record<AiProviderId, string>>
  apiHistory?: unknown[]
  messages: AiMessage[]
  totals?: { inputTokens: number; outputTokens: number; costUsd: number }
}

/** Progress of an in-app CLI sign-in (`claude auth login` / `codex login`). */
export type AiLoginEvent =
  | { type: 'output'; text: string }
  /** sign-in page (also opened in the browser) */
  | { type: 'url'; url: string }
  | { type: 'done'; ok: boolean; error?: string }

/** what claimDocument found for an opened file */
export interface AiClaim {
  /** the reference the file's chats live under (another id: a copy of another file) */
  ref: string
  /** the chats of `ref` lost their agent sessions (the document was moved or renamed outside the app):
   * a stopped turn's late session must not be written back */
  sessionsDropped: boolean
}

export interface AiChatApi {
  providers(refresh?: boolean): Promise<AiProviderInfo[]>
  run(req: AiRunRequest): Promise<void>
  stop(runId: string): Promise<void>
  onEvent(cb: (runId: string, ev: AiRunEvent) => void): () => void
  onToolCall(cb: (call: AiToolCall) => void): () => void
  /** main gave up waiting for a call (a question nobody answered within the hour) */
  onToolCancel(cb: (call: { callId: string; runId: string }) => void): () => void
  toolResult(callId: string, result: AiToolResult): void
  listChats(projectPath: string | null): Promise<AiChatMeta[]>
  loadChat(projectPath: string | null, chatId: string): Promise<AiChatRecord | null>
  saveChat(projectPath: string | null, chat: AiChatRecord): Promise<void>
  deleteChat(projectPath: string | null, chatId: string): Promise<void>
  getSettings(projectPath: string | null): Promise<AiChatSettings>
  setSettings(projectPath: string | null, s: AiChatSettings): Promise<void>
  /**
   * The open document got a new reference (project refs: `id:<Doc.meta.id>`, or a file path / `unsaved:<id>`
   * for documents without an id): its chats follow it; `copy` (Save As) copies them without agent sessions.
   * `path`: the file it was saved to. Resolves whether agent sessions still resume at the new place.
   */
  moveChats(from: string, to: string, copy: boolean, path: string | null): Promise<{ sessionsKept: boolean }>
  /** removes the chats of an unsaved document that is gone (never those of a project that was saved) */
  dropChats(projectRef: string): Promise<void>
  /**
   * A saved document (`id:<id>`) was opened from `path`: the reference its chats live under. A copy of
   * another file that is still there gets one of its own (its chats copied without agent sessions);
   * it reaches the file with the next save.
   */
  claimDocument(ref: string, path: string): Promise<AiClaim>
  /** start signing the CLI in; progress arrives through onLogin */
  login(provider: AiProviderId): Promise<void>
  /** paste the code shown by the sign-in page (when the CLI asks for one) */
  loginInput(text: string): Promise<void>
  loginCancel(): Promise<void>
  onLogin(cb: (provider: AiProviderId, ev: AiLoginEvent) => void): () => void
}

/** quoted passages as markdown quotes, ready to go before the user's text */
export function quoteMarkdown(quotes: readonly string[]): string {
  return quotes
    .map((q) => q.replace(/\r\n?/g, '\n').trim())
    .filter(Boolean)
    .map((q) => `${q.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')}\n\n`)
    .join('')
}
