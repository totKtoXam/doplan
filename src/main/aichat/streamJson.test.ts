import { describe, expect, it } from 'vitest'
import { ClaudeStreamParser, CodexJsonParser, isDocTool } from './streamJson'

const j = (o: unknown) => JSON.stringify(o) + '\n'

describe('isDocTool', () => {
  it('recognises doplan MCP tool names from every provider', () => {
    expect(isDocTool('mcp__doplan__add_wall')).toBe(true)
    expect(isDocTool('doplan.get_plan')).toBe(true)
    expect(isDocTool('Read')).toBe(false)
    expect(isDocTool('mcp__other__x')).toBe(false)
  })
})

describe('ClaudeStreamParser', () => {
  it('emits session, streamed deltas, hides doc tools and reports the result', () => {
    const p = new ClaudeStreamParser()
    const ev = [
      ...p.push(j({ type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [{ name: 'doplan', status: 'connected' }] })),
      ...p.push(j({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })),
      ...p.push(j({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })),
      // chunk split in the middle of a line
      ...p.push(j({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'При' } } }).slice(0, 20)),
    ]
    ev.push(...p.push(j({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'При' } } }).slice(20)))
    ev.push(
      ...p.push(
        j({
          type: 'assistant',
          message: {
            id: 'm1',
            content: [
              { type: 'text', text: 'При' },
              { type: 'tool_use', id: 't1', name: 'mcp__doplan__add_wall', input: {} },
              { type: 'tool_use', id: 't2', name: 'WebSearch', input: { q: 'x' } },
            ],
          },
        }),
      ),
    )
    ev.push(...p.push(j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ok' }] }] } })))
    ev.push(...p.push(j({ type: 'assistant', parent_tool_use_id: 't2', message: { id: 'sub', content: [{ type: 'text', text: 'sub' }] } })))
    ev.push(...p.push(j({ type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0.12, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } })))
    ev.push(...p.end())

    expect(ev[0]).toEqual({ type: 'session', id: 's1' })
    const texts = ev.filter((e) => e.type === 'text')
    expect(texts).toEqual([{ type: 'text', partId: 'm1:0', delta: 'При' }]) // whole text not duplicated
    const tools = ev.filter((e) => e.type === 'tool')
    expect(tools.map((t) => t.type === 'tool' && [t.name, t.status])).toEqual([
      ['WebSearch', 'running'],
      ['WebSearch', 'done'],
    ])
    expect(ev.some((e) => e.type === 'text' && e.delta === 'sub')).toBe(false)
    expect(ev.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 90, costUsd: 0.12 })
    expect(p.result).toEqual({ ok: true, error: undefined, sessionId: 's1', costUsd: 0.12 })
  })

  it('uses whole assistant text when nothing was streamed, and flags a missing MCP server', () => {
    const p = new ClaudeStreamParser()
    const ev = p.push(
      j({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'doplan', status: 'failed' }] }) +
        j({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Готово' }] } }) +
        'not json\n' +
        j({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }),
    )
    expect(ev.some((e) => e.type === 'notice' && e.level === 'error')).toBe(true)
    expect(ev.filter((e) => e.type === 'text').map((e) => e.type === 'text' && e.delta)).toEqual(['Готово'])
    expect(p.result?.ok).toBe(false)
    expect(p.result?.error).toBe('boom')
  })
})

describe('CodexJsonParser', () => {
  it('maps thread, incremental messages, tools and usage', () => {
    const p = new CodexJsonParser()
    const ev = p.push(
      j({ type: 'thread.started', thread_id: 'th1' }) +
        j({ type: 'item.updated', item: { id: 'i1', type: 'agent_message', text: 'Доба' } }) +
        j({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Добавил' } }) +
        j({ type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'doplan', tool: 'add_wall', status: 'completed' } }) +
        j({ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'ls', exit_code: 1, aggregated_output: 'x' } }) +
        j({ type: 'error', message: 'Reconnecting… 1/5' }) +
        j({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 2 } }),
    )
    expect(ev[0]).toEqual({ type: 'session', id: 'th1' })
    expect(ev.filter((e) => e.type === 'text').map((e) => e.type === 'text' && e.delta)).toEqual(['Доба', 'вил'])
    const tools = ev.filter((e) => e.type === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'shell', status: 'error', output: 'x' })
    expect(ev.find((e) => e.type === 'notice')).toMatchObject({ level: 'info' })
    expect(ev.at(-1)).toEqual({ type: 'usage', inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 })
    expect(p.result).toEqual({ ok: true })
  })

  it('reports turn failure with the message', () => {
    const p = new CodexJsonParser()
    p.push(j({ type: 'turn.failed', error: { message: 'quota' } }))
    expect(p.result).toEqual({ ok: false, error: 'quota' })
  })
})
