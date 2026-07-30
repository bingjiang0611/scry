import { describe, expect, it, vi } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { TraceEvent } from '../../shared/trace'
import type { ProviderRunRequest } from './types'

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/opencode',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import {
  createOpenCodeAdapter,
  emitOpenCodeEvent,
  emitOpenCodeHookFrame,
  handleOpenCodePermission,
  openCodePermissionRules,
  openCodeRunControlCatalog,
  setOpenCodeMcpServers
} from './opencode'
import { parseOpenCodeHookLine } from './opencode-server'

describe('OpenCode provider adapter', () => {
  it('exposes native server capabilities without claiming account billing support', async () => {
    await expect(createOpenCodeAdapter().describe()).resolves.toMatchObject({
      id: 'opencode',
      runtimeProvider: 'opencode_server',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
    })
  })

  it('maps native models and excludes the unsupported auto-review mode', () => {
    expect(openCodeRunControlCatalog([{
      id: 'claude-sonnet',
      providerID: 'anthropic',
      name: 'Claude Sonnet',
      request: { variant: 'high' },
      variants: [{ id: 'low' }, { id: 'high' }]
    }])).toEqual({
      models: [{
        model: { id: 'claude-sonnet', providerId: 'anthropic' },
        label: 'Claude Sonnet · anthropic',
        efforts: [
          { id: 'low', label: '低' },
          { id: 'high', label: '高', isDefault: true }
        ]
      }],
      permissions: expect.not.arrayContaining([expect.objectContaining({ id: 'auto_review' })])
    })
    expect(openCodePermissionRules('default')).toEqual([{ permission: '*', pattern: '*', action: 'ask' }])
    expect(openCodePermissionRules('full_access')).toEqual([{ permission: '*', pattern: '*', action: 'allow' }])
    expect(() => openCodePermissionRules('auto_review')).toThrow('不支持自动审查')
  })

  it('translates a native permission request through the inline approval channel', async () => {
    const reply = vi.fn().mockResolvedValue({ data: true })
    const request = {
      runId: 'run-permission',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: () => {},
      requestUserInput: vi.fn(async (question) => ({
        runId: question.runId,
        questionId: question.questionId,
        behavior: 'answered' as const,
        answers: { [question.questions[0].question]: '本次会话允许' }
      }))
    } satisfies ProviderRunRequest
    const client = { permission: { reply } } as unknown as OpencodeClient

    await expect(handleOpenCodePermission(request, client, {
      type: 'permission.asked',
      properties: {
        id: 'permission-1',
        sessionID: 'session-1',
        permission: 'bash',
        patterns: ['npm test']
      }
    }, 'session-1')).resolves.toBe(true)

    expect(reply).toHaveBeenCalledWith({
      requestID: 'permission-1',
      directory: '/repo',
      reply: 'always'
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

  it('保留 OpenCode shell bridge 的多 MCP 调用并识别业务失败', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-mcp-shell',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const part = {
      type: 'tool',
      callID: 'mcp-shell',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'mcporter call coop.query --args \'{}\' && mcporter call group-env.list --args \'{}\'' }
      }
    }
    emitOpenCodeEvent(
      request,
      { type: 'message.part.updated', properties: { sessionID: 'session-mcp-shell', part } },
      'session-mcp-shell'
    )
    emitOpenCodeEvent(
      request,
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-mcp-shell',
          part: {
            ...part,
            state: { ...part.state, status: 'completed', output: '{"success":false,"error":"denied"}' }
          }
        }
      },
      'session-mcp-shell'
    )
    expect(events[0]).toMatchObject({
      isMcp: true,
      mcpCalls: [
        { server: 'coop', action: 'query' },
        { server: 'group-env', action: 'list' }
      ]
    })
    expect(events[1]).toMatchObject({ stage: 'tool_result', isMcp: true, isError: true })
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
