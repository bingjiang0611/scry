import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Dispatcher } from 'undici'
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
  handleOpenCodePermission,
  handleOpenCodeQuestion,
  openCodePermissionRules,
  openCodeRunControlCatalog
} from './opencode'
import {
  createOpenCodeFetch,
  isolatedOpenCodeChildEnv,
  OPEN_CODE_LONG_REQUEST_TIMEOUTS,
  OpenCodeServerManager,
  openCodeMcpConfig,
  openCodeServerAuthorization,
  sanitizeOpenCodeAuth,
  sanitizeOpenCodeServerLog
} from './opencode-server'

describe('OpenCode provider adapter', () => {
  it('forwards only local api/oauth credentials and drops wellknown remote configuration auth', () => {
    expect(sanitizeOpenCodeAuth({
      anthropic: { type: 'api', key: 'api-key' },
      openai: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 },
      'https://remote.example': { type: 'wellknown', key: 'remote', token: 'token' },
      malformed: { key: 'missing-type' }
    })).toEqual({
      anthropic: { type: 'api', key: 'api-key' },
      openai: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 }
    })
  })

  it('isolates every inherited OpenCode and XDG control path while preserving ordinary provider credentials', () => {
    const env = isolatedOpenCodeChildEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'provider-key',
      OPENCODE_API_KEY: 'zen-key',
      OPENCODE_DB: '/outside/opencode.db',
      OPENCODE_WORKSPACE_ID: 'outside-workspace',
      OPENCODE_PLUGIN_META_FILE: '/outside/plugins.json',
      XDG_DATA_HOME: '/outside/data',
      XDG_DATA_DIRS: '/outside/data-dirs'
    }, '/isolated', '/isolated/safe-config.json', '/isolated/config', '{"openai":{"type":"oauth"}}', 'random-password')

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'provider-key',
      OPENCODE_API_KEY: 'zen-key',
      XDG_DATA_HOME: '/isolated/data',
      XDG_DATA_DIRS: '/isolated/data-dirs',
      XDG_RUNTIME_DIR: '/isolated/runtime',
      OPENCODE_DB: '/isolated/data/opencode.db',
      OPENCODE_CONFIG: '/isolated/safe-config.json',
      OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth"}}',
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: 'random-password'
    })
    expect(env).not.toHaveProperty('OPENCODE_WORKSPACE_ID')
    expect(env).not.toHaveProperty('OPENCODE_PLUGIN_META_FILE')
    expect(openCodeServerAuthorization('random-password')).toBe(
      `Basic ${Buffer.from('opencode:random-password').toString('base64')}`
    )
  })

  it('disables Undici header/body timeouts only for synchronous long-running session requests', async () => {
    const dispatcher = {} as Dispatcher
    const fetchImpl = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof globalThis.fetch
    const openCodeFetch = createOpenCodeFetch(dispatcher, fetchImpl)

    await openCodeFetch(new Request('http://127.0.0.1:12345/session/ses-1/command', { method: 'POST' }))
    expect(fetchImpl).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.objectContaining({ dispatcher })
    )

    await openCodeFetch(new Request('http://127.0.0.1:12345/session/ses-1/message', { method: 'POST' }))
    expect(fetchImpl).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.objectContaining({ dispatcher })
    )

    await openCodeFetch(new Request('http://127.0.0.1:12345/session', { method: 'GET' }))
    expect(fetchImpl).toHaveBeenLastCalledWith(expect.any(Request), undefined)
    expect(OPEN_CODE_LONG_REQUEST_TIMEOUTS).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
  })

  it('redacts credentials from bounded OpenCode server diagnostics', () => {
    const log = sanitizeOpenCodeServerLog([
      'Authorization: Basic dXNlcjpzZWNyZXQ=',
      'token=plain-token',
      'api_key: "provider-secret"',
      'OPENAI_API_KEY=sk-openai-secret',
      'ANTHROPIC_API_KEY=sk-ant-secret',
      'OPENCODE_SERVER_PASSWORD=server-secret',
      'GITHUB_TOKEN=github-secret',
      '"COOKIE": "session-secret"',
      'fatal: headers timeout'
    ].join('\n'))

    expect(log).toContain('fatal: headers timeout')
    expect(log).not.toContain('dXNlcjpzZWNyZXQ=')
    expect(log).not.toContain('plain-token')
    expect(log).not.toContain('provider-secret')
    expect(log).not.toContain('sk-openai-secret')
    expect(log).not.toContain('sk-ant-secret')
    expect(log).not.toContain('server-secret')
    expect(log).not.toContain('github-secret')
    expect(log).not.toContain('session-secret')
  })

  it('exposes native server capabilities without claiming account billing support', async () => {
    await expect(createOpenCodeAdapter().describe()).resolves.toMatchObject({
      id: 'opencode',
      runtimeProvider: 'opencode_server',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
    })
  })

  it('keeps MCP disabled until authorization and converts only approved configs into isolated OpenCode format', () => {
    expect(openCodeMcpConfig()).toEqual({})
    expect(openCodeMcpConfig({
      cwd: '/repo', fingerprint: 'sha256:test', env: { PATH: '/bin' },
      targets: [
        { targetId: 'local', name: 'local', enabled: true, config: { command: '/bin/echo', args: ['ok'], env: { SAFE: '1' } } },
        { targetId: 'off', name: 'off', enabled: false, config: { command: '/bin/off' } },
        { targetId: 'remote', name: 'remote', enabled: true, config: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'configured' } } }
      ]
    })).toEqual({
      local: { type: 'local', command: ['/bin/echo', 'ok'], environment: { PATH: '/bin', SAFE: '1' }, enabled: true },
      remote: { type: 'remote', url: 'https://mcp.example.test', headers: { Authorization: 'configured' }, enabled: true }
    })
  })

  it('lists OpenCode config without starting a server and reads native status only after authorization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-opencode-mcp-test-'))
    const configDir = join(home, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
      mcp: { tracker: { type: 'local', command: ['/bin/echo', 'configured'] } }
    }))
    const client = {
      mcp: { status: vi.fn(async () => ({ data: { tracker: { status: 'connected' } } })) }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo', mcpFingerprint: 'sha256:test', url: 'http://127.0.0.1:12345', pid: 41, client
    })
    const adapter = createOpenCodeAdapter(home)
    try {
      await expect(adapter.mcp!.snapshot({ providerId: 'opencode', cwd: '/repo' })).resolves.toMatchObject({
        state: 'degraded', data: { configured: [expect.objectContaining({ name: 'tracker' })], runtime: null }
      })
      expect(ensure).not.toHaveBeenCalled()
      const execution = {
        cwd: '/repo', fingerprint: 'sha256:test', env: { PATH: '/bin' },
        targets: [{ targetId: 'tracker', name: 'tracker', enabled: true, config: { command: '/bin/echo', args: ['approved'] } }]
      }
      await expect(adapter.mcp!.snapshot({ providerId: 'opencode', cwd: '/repo' }, true, execution)).resolves.toMatchObject({
        state: 'ready', data: { runtime: [{ name: 'tracker', status: 'connected' }] }
      })
      expect(ensure).toHaveBeenCalledWith('/repo', execution)
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
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

  it('bridges native question.v2 choices and replies with ordered answer arrays', async () => {
    const reply = vi.fn().mockResolvedValue({ data: true })
    const request = {
      runId: 'run-question',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: () => {},
      requestUserInput: vi.fn(async (question) => ({
        runId: question.runId,
        questionId: question.questionId,
        behavior: 'answered' as const,
        answers: {
          [question.questions[0].question]: '全量',
          [question.questions[1].question]: 'MCP, Skill'
        }
      }))
    } satisfies ProviderRunRequest
    const client = { v2: { session: { question: { reply, reject: vi.fn() } } } } as unknown as OpencodeClient

    await expect(handleOpenCodeQuestion(request, client, {
      type: 'question.v2.asked',
      properties: {
        id: 'question-1',
        sessionID: 'session-1',
        tool: { callID: 'call-question' },
        questions: [
          {
            header: '范围', question: '选择范围？', multiple: false,
            options: [{ label: '全量', description: '全部' }, { label: '增量', description: '变化' }]
          },
          {
            header: '能力', question: '选择能力？', multiple: true,
            options: [{ label: 'MCP', description: 'MCP' }, { label: 'Skill', description: 'Skill' }]
          }
        ]
      }
    }, 'session-1')).resolves.toBe(true)

    expect(request.requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: 'call-question',
        questionKind: 'clarification',
        source: 'opencode:question.v2.asked'
      }),
      expect.any(AbortSignal)
    )
    expect(reply).toHaveBeenCalledWith({
      sessionID: 'session-1',
      requestID: 'question-1',
      questionV2Reply: { answers: [['全量'], ['MCP', 'Skill']] }
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

  it('normalizes the native OpenCode Skill identity', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-2',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const part = {
      type: 'tool',
      callID: 'skill-1',
      tool: 'skill',
      state: { status: 'completed', input: { name: 'scry-e2e-audit' }, output: 'loaded' }
    }
    emitOpenCodeEvent(request, { type: 'message.part.updated', properties: { sessionID: 'session-2', part } }, 'session-2')

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', stage: 'skill:scry-e2e-audit', tool: 'Skill', name: 'scry-e2e-audit', toolUseId: 'skill-1' })
    ]))
  })

  it('records one completed OpenCode compaction and ignores duplicate delivery', () => {
    const events: TraceEvent[] = []
    const request = {
      runId: 'run-compact',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event: TraceEvent) => events.push(event)
    } satisfies ProviderRunRequest
    const compacted = {
      id: 'event-compact',
      type: 'session.next.compaction.ended',
      properties: {
        timestamp: Date.parse('2026-08-07T00:00:00.000Z'),
        sessionID: 'session-compact',
        messageID: 'message-compact',
        reason: 'manual',
        text: 'summary',
        recent: ''
      }
    }

    emitOpenCodeEvent(request, compacted, 'session-compact')
    emitOpenCodeEvent(request, compacted, 'session-compact')

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'harness',
        stage: 'context_compaction',
        ts: '2026-08-07T00:00:00.000Z',
        compaction: { trigger: 'manual', providerEventId: 'message-compact' }
      })
    ])
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

  it('returns the native message id/timing and aborts the SSE subscription after a successful slash command', async () => {
    const emitted: TraceEvent[] = []
    let subscriptionSignal: AbortSignal | undefined
    let retryDelaySettled = false
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-1' } })),
        command: vi.fn(async () => ({
          data: {
            info: {
              id: 'message-1',
              time: { created: 1_000, completed: 4_000 },
              tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              providerID: 'anthropic',
              modelID: 'model-1',
              finish: 'length'
            },
            parts: []
          }
        })),
        abort: vi.fn(async () => ({ data: true }))
      },
      event: {
        subscribe: vi.fn(async (_parameters, options) => {
          subscriptionSignal = options?.signal
          const retrySleep = (options as unknown as {
            sseSleepFn?: (delayMs: number) => Promise<void>
          })?.sseSleepFn
          if (!retrySleep) throw new Error('missing abort-aware SSE sleep')
          const retryDelay = retrySleep(30_000).then(() => {
            retryDelaySettled = true
          })
          return { stream: (async function * () { await retryDelay })() }
        })
      }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo',
      mcpFingerprint: 'none',
      url: 'http://127.0.0.1:12345',
      pid: 42,
      client
    })
    const adapter = createOpenCodeAdapter()

    try {
      const handle = adapter.run({
        runId: 'run-success',
        prompt: '/rate-workflow 1',
        cwd: '/repo',
        attachments: [],
        permissionMode: 'full_access',
        emit: (event) => emitted.push(event)
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'session-1',
        providerTurnId: 'message-1',
        stopped: false
      })
      expect(handle.getProviderTurnId?.()).toBe('message-1')
      expect(subscriptionSignal?.aborted).toBe(true)
      expect(retryDelaySettled).toBe(true)
      expect(emitted.at(-1)).toMatchObject({
        kind: 'harness',
        stage: 'result',
        messageId: 'message-1',
        durationMs: 3_000,
        isError: false,
        providerStopReason: 'length',
        terminationReason: 'output_token_limit'
      })
      expect(emitted.at(-1)?.ts).toBe('1970-01-01T00:00:04.000Z')
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
    }
  })

  it('preserves the local transport cause and degrades provider health instead of reporting a generic network error', async () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-timeout' } })),
        command: vi.fn(async () => ({
          error: new TypeError('fetch failed', { cause }),
          request: new Request('http://127.0.0.1:12345/session/session-timeout/command', { method: 'POST' }),
          response: undefined
        })),
        abort: vi.fn(async () => ({ data: true }))
      },
      event: {
        subscribe: vi.fn(async () => ({ stream: (async function * () {})() }))
      }
    } as unknown as OpencodeClient
    const ensure = vi.spyOn(OpenCodeServerManager.prototype, 'ensure').mockResolvedValue({
      cwd: '/repo',
      mcpFingerprint: 'none',
      url: 'http://127.0.0.1:12345',
      pid: 43,
      client
    })
    const adapter = createOpenCodeAdapter()

    try {
      const handle = adapter.run({
        runId: 'run-timeout',
        prompt: '/rate-workflow 1',
        cwd: '/repo',
        attachments: [],
        permissionMode: 'full_access',
        emit: () => {}
      })

      await expect(handle.promise).rejects.toMatchObject({
        name: 'AgentRuntimeError',
        message: expect.stringContaining('UND_ERR_HEADERS_TIMEOUT'),
        brief: expect.objectContaining({
          provider: 'opencode_server',
          stage: 'protocol',
          commandSummary: 'session.command',
          transportCode: 'UND_ERR_HEADERS_TIMEOUT',
          requestMethod: 'POST',
          requestPath: '/session/{sessionId}/command'
        })
      })
      await expect(handle.promise).rejects.toHaveProperty(
        'cause.cause.cause.code',
        'UND_ERR_HEADERS_TIMEOUT'
      )
      expect(client.session.abort).toHaveBeenCalledWith({
        sessionID: 'session-timeout',
        directory: '/repo'
      })
      await expect(adapter.describe()).resolves.toMatchObject({
        health: {
          state: 'degraded',
          lastError: expect.stringContaining('UND_ERR_HEADERS_TIMEOUT')
        }
      })
    } finally {
      adapter.dispose?.()
      ensure.mockRestore()
    }
  })

})
