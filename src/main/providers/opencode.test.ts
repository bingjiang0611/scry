import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import type { ProviderRunRequest } from './types'

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/opencode',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import { createOpenCodeAdapter, emitOpenCodeEvent, emitOpenCodeHookFrame, setOpenCodeMcpServers } from './opencode'
import { parseOpenCodeHookLine } from './opencode-server'

describe('OpenCode provider adapter', () => {
  it('exposes native server capabilities without claiming account billing support', async () => {
    await expect(createOpenCodeAdapter().describe()).resolves.toMatchObject({
      id: 'opencode',
      runtimeProvider: 'opencode_server',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
    })
  })

  it('records current OpenCode message.part.updated tool lifecycle events', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-1',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const base = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          type: 'tool',
          callID: 'call-1',
          tool: 'read',
          state: { input: { filePath: '/repo/README.md' } }
        }
      }
    }

    emitOpenCodeEvent(request, {
      ...base,
      properties: { ...base.properties, part: { ...base.properties.part, state: { ...base.properties.part.state, status: 'running' } } }
    }, 'session-1')
    emitOpenCodeEvent(request, {
      ...base,
      properties: {
        ...base.properties,
        part: { ...base.properties.part, state: { ...base.properties.part.state, status: 'completed', output: 'ok' } }
      }
    }, 'session-1')

    expect(events).toEqual([
      expect.objectContaining({ kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'call-1', fileOp: 'read', filePath: '/repo/README.md' }),
      expect.objectContaining({ kind: 'tool', stage: 'tool_result', toolUseId: 'call-1', output: 'ok', isError: false })
    ])
  })

  it('normalizes native OpenCode Skill and MCP tool identities', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-2',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    setOpenCodeMcpServers(request, ['scry-e2e'])

    for (const part of [
      { type: 'tool', callID: 'skill-1', tool: 'skill', state: { status: 'completed', input: { name: 'scry-e2e-audit' }, output: 'loaded' } },
      { type: 'tool', callID: 'mcp-1', tool: 'scry-e2e_repo_tree', state: { status: 'completed', input: { path: '.' }, output: '{}' } }
    ]) {
      emitOpenCodeEvent(request, { type: 'message.part.updated', properties: { sessionID: 'session-2', part } }, 'session-2')
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', stage: 'skill:scry-e2e-audit', tool: 'Skill', name: 'scry-e2e-audit', toolUseId: 'skill-1' }),
      expect.objectContaining({ kind: 'tool', tool: 'mcp__scry-e2e__repo_tree', isMcp: true, mcpServer: 'scry-e2e', mcpAction: 'repo_tree', toolUseId: 'mcp-1' })
    ]))
  })

  it('maps versioned plugin frames to hook events and rejects another session', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-hooks', prompt: 'inspect', cwd: '/repo', attachments: [], emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const frame = parseOpenCodeHookLine('SCRY_OPENCODE_HOOK\t{"v":1,"type":"tool.execute.before","ts":1,"input":{"sessionID":"session-1","callID":"call-1","tool":"read"}}')!

    emitOpenCodeHookFrame(request, frame, 'other-session')
    emitOpenCodeHookFrame(request, frame, 'session-1')

    expect(events).toEqual([
      expect.objectContaining({ kind: 'hook', stage: 'hook_started', hookEvent: 'PreToolUse', toolUseId: 'call-1' }),
      expect.objectContaining({ kind: 'hook', stage: 'hook_response', hookOutcome: 'success', runtimeMetadata: { source: 'opencode_plugin', protocolVersion: 1 } })
    ])
    expect(parseOpenCodeHookLine('SCRY_OPENCODE_HOOK\t{"v":2,"type":"init","ts":1,"input":{}}')).toBeNull()
  })
})
