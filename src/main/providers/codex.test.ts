import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'

const appServer = vi.hoisted(() => ({
  request: vi.fn(),
  start: vi.fn(),
  onNotification: vi.fn(),
  options: [] as Array<Record<string, unknown>>
}))

vi.mock('./codex-app-server', () => ({
  CodexAppServerClient: class {
    request = appServer.request
    start = appServer.start
    onNotification = appServer.onNotification
    pid = 123
    constructor(options: Record<string, unknown>) {
      appServer.options.push(options)
    }
    close() {}
  }
}))

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/codex',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import { createCodexAdapter } from './codex'

describe('Codex provider adapter', () => {
  beforeEach(() => {
    appServer.request.mockReset()
    appServer.start.mockReset().mockResolvedValue(undefined)
    appServer.onNotification.mockReset()
    appServer.options.length = 0
  })

  it('declares only app-server capabilities that it can prove', async () => {
    await expect(createCodexAdapter().describe()).resolves.toMatchObject({
      id: 'codex',
      runtimeProvider: 'codex_cli',
      transport: 'app-server',
      capabilities: { skills: 'manage', mcp: 'read', commands: 'read', account: 'read' }
    })
  })

  it('marks MCP status degraded until a cwd-bound thread exists', async () => {
    appServer.request.mockResolvedValue({ data: [] })

    const result = await createCodexAdapter().mcp!.snapshot({ providerId: 'codex', cwd: '/repo' })

    expect(result).toMatchObject({
      state: 'degraded',
      reason: expect.stringContaining('thread')
    })
  })

  it('starts the app-server inside the Provider context cwd', async () => {
    appServer.request.mockResolvedValue({ data: [{ cwd: '/isolated-copy', skills: [] }] })

    await createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/isolated-copy' })

    expect(appServer.options).toContainEqual(expect.objectContaining({ cwd: '/isolated-copy' }))
  })

  it('uses full host access without approvals for new and resumed Codex threads', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method, params) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-new' } }
      if (method === 'thread/resume') return { thread: { id: (params as { threadId: string }).threadId } }
      if (method === 'turn/start') return { turn: { id: `turn-${(params as { threadId: string }).threadId}` } }
      throw new Error(`unexpected request: ${method}`)
    })
    const adapter = createCodexAdapter()

    const newRun = adapter.run({
      runId: 'run-new',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: () => {}
    })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('turn/completed', {
      threadId: 'thread-new',
      turnId: 'turn-thread-new',
      turn: { status: 'completed' }
    })
    await newRun.promise

    expect(appServer.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/repo',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })

    const resumedRun = adapter.run({
      runId: 'run-resumed',
      prompt: 'continue',
      cwd: '/repo',
      resume: 'thread-existing',
      attachments: [],
      emit: () => {}
    })
    await vi.waitFor(() => {
      expect(appServer.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread-existing' })
      )
    })
    notify?.('turn/completed', {
      threadId: 'thread-existing',
      turnId: 'turn-thread-existing',
      turn: { status: 'completed' }
    })
    await resumedRun.promise

    expect(appServer.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-existing',
      cwd: '/repo',
      excludeTurns: true,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })
  })

  it('reads Codex Hook trust metadata before a run', async () => {
    appServer.request.mockResolvedValue({
      data: [{
        cwd: '/isolated-copy',
        hooks: [{
          key: 'project-hook',
          eventName: 'preToolUse',
          source: 'project',
          sourcePath: '/isolated-copy/.codex/hooks.json',
          enabled: true,
          currentHash: 'sha256:current',
          trustStatus: 'untrusted'
        }],
        warnings: ['warning'],
        errors: []
      }]
    })

    await expect(
      createCodexAdapter().hookTrust!.inspect({ providerId: 'codex', cwd: '/isolated-copy' })
    ).resolves.toEqual({
      cwd: '/isolated-copy',
      hooks: [{
        key: 'project-hook',
        eventName: 'preToolUse',
        source: 'project',
        sourcePath: '/isolated-copy/.codex/hooks.json',
        enabled: true,
        currentHash: 'sha256:current',
        trustStatus: 'untrusted'
      }],
      warnings: ['warning'],
      errors: []
    })
    expect(appServer.request).toHaveBeenCalledWith('hooks/list', { cwds: ['/isolated-copy'] })
  })

  it('exposes enabled Codex Skills as slash-command aliases', async () => {
    appServer.request.mockResolvedValue({
      data: [{
        cwd: '/isolated-copy',
        skills: [
          { name: 'rate-workflow', path: '/skill/rate-workflow/SKILL.md', description: 'Run the workflow', enabled: true },
          { name: 'disabled-skill', path: '/skill/disabled/SKILL.md', enabled: false }
        ]
      }]
    })

    await expect(
      createCodexAdapter().commands!.list({ providerId: 'codex', cwd: '/isolated-copy' })
    ).resolves.toMatchObject({
      state: 'ready',
      mode: 'read',
      data: [{
        name: 'rate-workflow',
        description: 'Run the workflow',
        source: 'skill'
      }]
    })
  })

  it('reads the Codex account without forcing a token refresh', async () => {
    appServer.request.mockImplementation(async (method, params) => {
      if (method === 'account/read') {
        expect(params).toEqual({ refreshToken: false })
        return { account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' } }
      }
      if (method === 'account/rateLimits/read') return { rateLimits: { planType: 'pro' } }
      if (method === 'account/usage/read') return { usage: {} }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(createCodexAdapter().account!.read({ providerId: 'codex', cwd: '/isolated-copy' })).resolves.toMatchObject({
      state: 'ready', data: { accountLabel: 'user@example.com', plan: 'pro', usage: { authMode: 'chatgpt' } }
    })
  })

  it('writes Codex Skill state and returns the updated native catalog on reread', async () => {
    let enabled = true
    appServer.request.mockImplementation(async (method, params) => {
      if (method === 'skills/list') {
        return { data: [{ cwd: '/isolated-copy', skills: [{ name: 'scry-e2e-audit', path: '/skill', enabled }] }] }
      }
      if (method === 'skills/config/write') {
        enabled = (params as { enabled: boolean }).enabled
        return {}
      }
      throw new Error(`unexpected request: ${method}`)
    })
    const adapter = createCodexAdapter()
    const context = { providerId: 'codex' as const, cwd: '/isolated-copy' }

    await expect(adapter.skills!.list(context)).resolves.toMatchObject({ data: [{ name: 'scry-e2e-audit', enabled: true }] })
    await expect(adapter.skills!.setEnabled!(context, 'scry-e2e-audit', false)).resolves.toMatchObject({ state: 'ready', data: true })
    await expect(adapter.skills!.list(context)).resolves.toMatchObject({ data: [{ name: 'scry-e2e-audit', enabled: false }] })
    await expect(adapter.skills!.setEnabled!(context, 'scry-e2e-audit', true)).resolves.toMatchObject({ state: 'ready', data: true })
    await expect(adapter.skills!.list(context)).resolves.toMatchObject({ data: [{ name: 'scry-e2e-audit', enabled: true }] })
  })

  it('only bypasses Codex hook trust when explicitly enabled for vetted automation', async () => {
    const previous = process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
    process.env.SCRY_CODEX_BYPASS_HOOK_TRUST = '1'
    try {
      appServer.request.mockResolvedValue({ data: [{ cwd: '/isolated-copy', skills: [] }] })

      await createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/isolated-copy' })

      expect(appServer.options).toContainEqual(
        expect.objectContaining({ args: ['--dangerously-bypass-hook-trust', 'app-server'] })
      )
    } finally {
      if (previous === undefined) delete process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
      else process.env.SCRY_CODEX_BYPASS_HOOK_TRUST = previous
    }
  })

  it('keeps Codex hook trust enabled by default', async () => {
    const previous = process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
    delete process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
    try {
      appServer.request.mockResolvedValue({ data: [{ cwd: '/isolated-copy', skills: [] }] })

      await createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/isolated-copy' })

      expect(appServer.options).toContainEqual(expect.objectContaining({ cwd: '/isolated-copy', args: undefined }))
    } finally {
      if (previous === undefined) delete process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
      else process.env.SCRY_CODEX_BYPASS_HOOK_TRUST = previous
    }
  })

  it('starts only the approved run with Hook trust bypassed', async () => {
    const previous = process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
    delete process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
    try {
      appServer.onNotification.mockReturnValue(() => {})
      appServer.request.mockImplementation(async (method) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } }
        if (method === 'thread/start') return { thread: { id: 'thread-approved' } }
        throw new Error(`unexpected request: ${method}`)
      })
      const handle = createCodexAdapter().run({
        runId: 'run-approved',
        prompt: 'inspect',
        cwd: '/isolated-copy',
        attachments: [],
        bypassHookTrust: true,
        emit: () => {}
      })
      handle.interrupt()

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'thread-approved',
        stopped: true
      })
      expect(appServer.options).toContainEqual(
        expect.objectContaining({
          cwd: '/isolated-copy',
          args: ['--dangerously-bypass-hook-trust', 'app-server']
        })
      )
    } finally {
      if (previous === undefined) delete process.env.SCRY_CODEX_BYPASS_HOOK_TRUST
      else process.env.SCRY_CODEX_BYPASS_HOOK_TRUST = previous
    }
  })

  it('ignores other-thread notifications and an early stop does not start a turn', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    let resolveThread: (value: unknown) => void = () => {}
    const threadStarted = new Promise((resolve) => {
      resolveThread = resolve
    })
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return threadStarted
      if (method === 'turn/start') throw new Error('turn/start must not run after early stop')
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-target',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(notify).toBeTypeOf('function'))
    notify?.('item/started', {
      threadId: 'thread-other',
      turnId: 'turn-other',
      item: { id: 'other', type: 'commandExecution', command: 'pwd' }
    })
    handle.interrupt()
    resolveThread({ thread: { id: 'thread-target' } })

    await expect(handle.promise).resolves.toMatchObject({ externalSessionId: 'thread-target', stopped: true })
    expect(events).toEqual([])
    expect(appServer.request).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('uses the authoritative native completion when interrupt races with turn/completed', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-race' } }
      if (method === 'turn/start') return { turn: { id: 'turn-race' } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({
      runId: 'run-race',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: () => {}
    })

    await vi.waitFor(() => {
      expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything())
    })
    handle.interrupt()
    notify?.('turn/completed', {
      threadId: 'thread-race',
      turnId: 'turn-race',
      turn: { id: 'turn-race', status: 'completed' }
    })

    await expect(handle.promise).resolves.toMatchObject({
      externalSessionId: 'thread-race',
      providerTurnId: 'turn-race',
      stopped: true,
      status: 'completed'
    })
  })

  it('sends an explicit $skill mention as native Codex skill input and records it', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'apiKey' } }
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-test', modelProvider: 'openai', serviceTier: 'default' }
      if (method === 'skills/list') {
        return {
          data: [
            {
              cwd: '/isolated-copy',
              skills: [{ name: 'scry-e2e-audit', path: '/isolated-copy/.agents/skills/scry-e2e-audit/SKILL.md', enabled: true }]
            }
          ]
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []

    const handle = createCodexAdapter().run({
      runId: 'run-1',
      prompt: '$scry-e2e-audit 检查仓库约束',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => {
      expect(appServer.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          input: [
            { type: 'skill', name: 'scry-e2e-audit', path: '/isolated-copy/.agents/skills/scry-e2e-audit/SKILL.md' },
            { type: 'text', text: '检查仓库约束', text_elements: [] }
          ]
        })
      )
    })
    notify?.('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', delta: '正在检查'
    })
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1',
      tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 2, totalTokens: 14 } }
    })
    notify?.('turn/completed', { threadId: 'thread-1', turnId: 'turn-1', turn: { status: 'completed' } })
    await handle.promise

    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'skill', stage: 'skill:scry-e2e-audit', tool: 'Skill', name: 'scry-e2e-audit' })
    )
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'model', stage: 'text_delta', text: '正在检查' })
    )
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness', stage: 'result', billingProvider: 'openai', accountLabel: 'OpenAI API key',
      modelUsage: [expect.objectContaining({ model: 'gpt-test', inputTokens: 10, billingProvider: 'openai' })],
      runtimeMetadata: expect.objectContaining({ authMode: 'apiKey', model: 'gpt-test', serviceTier: 'default' })
    }))
  })

  it('records each Codex raw response as an observed model call bounded by prior activity', async () => {
    let notify: ((
      method: string,
      params: unknown,
      envelope?: { emittedAtMs?: number }
    ) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } }
      if (method === 'thread/start') return { thread: { id: 'thread-timing' }, model: 'gpt-test' }
      if (method === 'turn/start') return { turn: { id: 'turn-timing' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-timing',
      prompt: 'inspect',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('turn/started', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      turn: { id: 'turn-timing', startedAt: 100, status: 'inProgress' }
    }, { emittedAtMs: 100_500 })
    notify?.('item/agentMessage/delta', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      itemId: 'agent-message-1',
      delta: 'working'
    }, { emittedAtMs: 101_500 })
    notify?.('rawResponse/completed', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      responseId: 'response-1',
      usage: { inputTokens: 10, outputTokens: 2 }
    }, { emittedAtMs: 102_000 })
    notify?.('rawResponse/completed', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      responseId: 'response-1',
      usage: { inputTokens: 10, outputTokens: 2 }
    }, { emittedAtMs: 102_050 })
    notify?.('item/started', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      item: { id: 'tool-1', type: 'commandExecution', command: 'pwd' }
    }, { emittedAtMs: 102_100 })
    notify?.('item/completed', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      item: {
        id: 'tool-1',
        type: 'commandExecution',
        command: 'pwd',
        status: 'completed',
        durationMs: 1_900
      },
      completedAtMs: 104_000
    }, { emittedAtMs: 104_500 })
    notify?.('rawResponse/completed', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      responseId: 'response-2',
      usage: { inputTokens: 12, outputTokens: 3 }
    }, { emittedAtMs: 107_000 })
    notify?.('item/completed', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      item: { id: 'agent-message-2', type: 'agentMessage', text: 'done' }
    }, { emittedAtMs: 107_100 })
    notify?.('turn/completed', {
      threadId: 'thread-timing',
      turnId: 'turn-timing',
      turn: { id: 'turn-timing', status: 'completed', durationMs: 8_000 }
    }, { emittedAtMs: 108_000 })
    await handle.promise

    const delta = events.find((event) => event.kind === 'model' && event.stage === 'text_delta')
    expect(delta).toMatchObject({ runtimeMetadata: { codexItemId: 'agent-message-1' } })
    expect(delta).not.toHaveProperty('messageId')
    expect(events.filter((event) => event.kind === 'model' && event.stage === 'response_completed')).toEqual([
      expect.objectContaining({
        messageId: 'response-1',
        ts: '1970-01-01T00:01:42.000Z',
        durationMs: 2_000,
        runtimeMetadata: expect.objectContaining({
          timingSource: 'observed',
          timingBoundary: 'turn_or_activity_end'
        })
      }),
      expect.objectContaining({
        messageId: 'response-2',
        ts: '1970-01-01T00:01:47.000Z',
        durationMs: 3_000,
        runtimeMetadata: expect.objectContaining({
          timingSource: 'observed',
          timingBoundary: 'turn_or_activity_end'
        })
      })
    ])
  })

  it('falls back to completed agent messages when raw response notifications are unavailable', async () => {
    let notify: ((
      method: string,
      params: unknown,
      envelope?: { emittedAtMs?: number }
    ) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } }
      if (method === 'thread/start') return { thread: { id: 'thread-item-timing' }, model: 'gpt-test' }
      if (method === 'turn/start') return { turn: { id: 'turn-item-timing' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-item-timing',
      prompt: 'reply',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('turn/started', {
      threadId: 'thread-item-timing',
      turnId: 'turn-item-timing',
      turn: { id: 'turn-item-timing', startedAt: 100, status: 'inProgress' }
    }, { emittedAtMs: 100_500 })
    notify?.('item/completed', {
      threadId: 'thread-item-timing',
      turnId: 'turn-item-timing',
      item: { id: 'agent-message-item', type: 'agentMessage', text: 'OK' }
    }, { emittedAtMs: 103_000 })
    notify?.('turn/completed', {
      threadId: 'thread-item-timing',
      turnId: 'turn-item-timing',
      turn: { id: 'turn-item-timing', status: 'completed', durationMs: 4_000 }
    }, { emittedAtMs: 104_000 })
    await handle.promise

    expect(events.filter((event) => event.kind === 'model' && event.stage === 'response_completed')).toEqual([
      expect.objectContaining({
        messageId: 'agent-message-item',
        ts: '1970-01-01T00:01:43.000Z',
        durationMs: 3_000,
        runtimeMetadata: expect.objectContaining({
          timingSource: 'observed',
          timingBoundary: 'turn_or_activity_end',
          timingEvent: 'agent_message_item'
        })
      })
    ])
  })

  it('translates a slash Skill alias into native Codex skill input', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-slash' } }
      if (method === 'skills/list') {
        return {
          data: [{
            cwd: '/isolated-copy',
            skills: [{ name: 'rate-workflow', path: '/skill/rate-workflow/SKILL.md', enabled: true }]
          }]
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-slash' } }
      throw new Error(`unexpected request: ${method}`)
    })

    const handle = createCodexAdapter().run({
      runId: 'run-slash',
      prompt: '/rate-workflow 84441907',
      cwd: '/isolated-copy',
      attachments: [],
      emit: () => {}
    })

    await vi.waitFor(() => {
      expect(appServer.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          input: [
            { type: 'skill', name: 'rate-workflow', path: '/skill/rate-workflow/SKILL.md' },
            { type: 'text', text: '84441907', text_elements: [] }
          ]
        })
      )
    })
    notify?.('turn/completed', {
      threadId: 'thread-slash', turnId: 'turn-slash', turn: { status: 'completed' }
    })
    await handle.promise
  })

  it('does not guess Codex subscription billing when account detection fails', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') throw new Error('account temporarily unavailable')
      if (method === 'thread/start') return { thread: { id: 'thread-unknown-account' }, model: 'gpt-test', modelProvider: 'openai' }
      if (method === 'turn/start') return { turn: { id: 'turn-unknown-account' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-unknown-account',
      prompt: 'inspect',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-unknown-account', turnId: 'turn-unknown-account',
      tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 2, totalTokens: 14 } }
    })
    notify?.('turn/completed', {
      threadId: 'thread-unknown-account', turnId: 'turn-unknown-account', turn: { status: 'completed' }
    })
    await handle.promise

    const result = events.find((event) => event.kind === 'harness' && event.stage === 'result')
    expect(result?.billingProvider).toBeUndefined()
    expect(result?.accountLabel).toBeUndefined()
    expect(result?.modelUsage?.[0]).toMatchObject({ model: 'gpt-test', inputTokens: 10 })
    expect(result?.modelUsage?.[0].billingProvider).toBeUndefined()
    expect(result?.runtimeMetadata).toMatchObject({ authMode: undefined, modelProvider: 'openai' })
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness',
      stage: 'runtime:telemetry_degraded',
      runtimeMetadata: expect.objectContaining({ capability: 'billing_identity' })
    }))
  })

  it('derives turn usage from session cumulative totals without adding cache twice', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } }
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-usage' }, model: 'gpt-test', modelProvider: 'openai' }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-usage' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-usage',
      prompt: 'continue',
      cwd: '/isolated-copy',
      resume: 'thread-usage',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-usage',
      turnId: 'turn-usage',
      tokenUsage: {
        total: {
          inputTokens: 1100,
          cachedInputTokens: 660,
          cacheWriteInputTokens: 0,
          outputTokens: 110,
          reasoningOutputTokens: 11,
          totalTokens: 1210
        },
        last: {
          inputTokens: 100,
          cachedInputTokens: 60,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 1,
          totalTokens: 110
        },
        modelContextWindow: 200_000
      }
    })
    const finalUsage = {
      total: {
        inputTokens: 1400,
        cachedInputTokens: 850,
        cacheWriteInputTokens: 0,
        outputTokens: 160,
        reasoningOutputTokens: 16,
        totalTokens: 1560
      },
      last: {
        inputTokens: 200,
        cachedInputTokens: 125,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 3,
        totalTokens: 230
      },
      modelContextWindow: 200_000
    }
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-usage', turnId: 'turn-usage', tokenUsage: finalUsage
    })
    // Codex can repeat token_count notifications; unchanged cumulative totals must not inflate this turn.
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-usage', turnId: 'turn-usage', tokenUsage: finalUsage
    })
    notify?.('turn/completed', {
      threadId: 'thread-usage',
      turn: { id: 'turn-usage', status: 'completed', error: null }
    })
    await handle.promise

    expect(events.find((event) => event.kind === 'harness' && event.stage === 'result')).toMatchObject({
      tokensIn: 400,
      tokensOut: 60,
      cacheReadTokens: 250,
      reasoningTokens: 6,
      contextTokens: 200,
      modelUsage: [{
        model: 'gpt-test',
        inputTokens: 400,
        outputTokens: 60,
        cacheReadTokens: 250,
        reasoningTokens: 6,
        contextWindow: 200_000
      }]
    })
  })

  it('records plan updates, collaboration calls, and child-agent tools with stable agent identity', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-root' } }
      if (method === 'turn/start') return { turn: { id: 'turn-root' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-collab',
      prompt: 'delegate',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('turn/plan/updated', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      explanation: 'parallelize',
      plan: [{ step: 'inspect', status: 'inProgress' }]
    })
    notify?.('item/started', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      item: {
        id: 'spawn-1',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'thread-root',
        receiverThreadIds: ['thread-child'],
        prompt: 'inspect provider',
        model: 'gpt-test',
        reasoningEffort: 'high',
        agentsStates: {}
      }
    })
    notify?.('item/started', {
      threadId: 'thread-child',
      turnId: 'turn-child',
      item: {
        id: 'child-command',
        type: 'commandExecution',
        command: 'pwd',
        cwd: '/isolated-copy',
        status: 'inProgress'
      }
    })
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-child',
      turnId: 'turn-child',
      tokenUsage: {
        total: { inputTokens: 9_999, outputTokens: 999, totalTokens: 10_998 },
        last: { inputTokens: 9_999, outputTokens: 999, totalTokens: 10_998 }
      }
    })
    notify?.('turn/completed', {
      threadId: 'thread-child',
      turn: { id: 'turn-child', status: 'completed', error: null }
    })
    const childPrematurelyFinishedRoot = await Promise.race([
      handle.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10))
    ])
    expect(childPrematurelyFinishedRoot).toBe(false)
    notify?.('item/started', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      item: {
        id: 'wait-1',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'inProgress',
        senderThreadId: 'thread-root',
        receiverThreadIds: ['thread-child'],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { 'thread-child': { status: 'running', message: null } }
      }
    })
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      tokenUsage: {
        total: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
      }
    })
    notify?.('turn/completed', {
      threadId: 'thread-root',
      turn: { id: 'turn-root', status: 'completed', error: null }
    })
    await handle.promise

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'harness',
        stage: 'plan_snapshot',
        input: expect.objectContaining({ explanation: 'parallelize' })
      }),
      expect.objectContaining({
        kind: 'agent',
        tool: 'Agent',
        toolUseId: 'spawn-1',
        name: 'inspect provider',
        input: expect.objectContaining({
          senderThreadId: 'thread-root',
          receiverThreadIds: ['thread-child'],
          prompt: 'inspect provider'
        })
      }),
      expect.objectContaining({
        kind: 'tool',
        tool: 'Bash',
        toolUseId: 'child-command',
        agentId: 'thread-child',
        parentToolUseId: 'spawn-1'
      }),
      expect.objectContaining({
        kind: 'tool',
        tool: 'collaboration:wait',
        toolUseId: 'wait-1',
        input: expect.objectContaining({ receiverThreadIds: ['thread-child'] })
      })
    ]))
    expect(events.find((event) => event.kind === 'harness' && event.stage === 'result')).toMatchObject({
      tokensIn: 10,
      tokensOut: 2
    })
  })

  it('records one update_plan call when app-server also emits a plan ThreadItem snapshot', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-plan' } }
      if (method === 'turn/start') return { turn: { id: 'turn-plan' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-plan',
      prompt: 'plan',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('turn/plan/updated', {
      threadId: 'thread-plan',
      turnId: 'turn-plan',
      explanation: 'inspect then verify',
      plan: [
        { step: 'inspect', status: 'inProgress' },
        { step: 'verify', status: 'pending' }
      ]
    })
    const item = { id: 'plan-1', type: 'plan', text: '1. inspect\n2. verify' }
    notify?.('item/started', {
      threadId: 'thread-plan',
      turnId: 'turn-plan',
      item
    })
    notify?.('item/completed', {
      threadId: 'thread-plan',
      turnId: 'turn-plan',
      item
    })
    notify?.('turn/completed', {
      threadId: 'thread-plan',
      turn: { id: 'turn-plan', status: 'completed', error: null }
    })
    await handle.promise

    expect(events.filter((event) => event.stage === 'tool:update_plan')).toEqual([
      expect.objectContaining({
        kind: 'tool',
        tool: 'update_plan',
        toolUseId: 'plan:turn-plan:1',
        input: expect.objectContaining({ explanation: 'inspect then verify' })
      })
    ])
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool',
      stage: 'tool_result',
      tool: 'update_plan',
      toolUseId: 'plan:turn-plan:1'
    }))
  })

  it('classifies mcporter calls as MCP while keeping mcporter list as a management command', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-mcp' } }
      if (method === 'turn/start') return { turn: { id: 'turn-mcp' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-mcp',
      prompt: 'inspect MCP',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('item/started', {
      threadId: 'thread-mcp',
      turnId: 'turn-mcp',
      item: {
        id: 'mcp-call',
        type: 'commandExecution',
        command: '/bin/zsh -lc \\"mcporter call coop.query_workitem_detail --args \'{\\\\"id\\\\":\\\\"1\\\\"}\' && mcporter call group-env.list --args \'{}\'\\"',
        cwd: '/isolated-copy'
      }
    })
    notify?.('item/completed', {
      threadId: 'thread-mcp',
      turnId: 'turn-mcp',
      item: {
        id: 'mcp-call',
        type: 'commandExecution',
        command: 'mcporter call coop.query_workitem_detail && mcporter call group-env.list',
        cwd: '/isolated-copy',
        aggregatedOutput: '{"success":false,"error":"invalid payload"}',
        status: 'completed'
      }
    })
    notify?.('item/started', {
      threadId: 'thread-mcp',
      turnId: 'turn-mcp',
      item: {
        id: 'mcp-list',
        type: 'commandExecution',
        command: 'mcporter list',
        cwd: '/isolated-copy'
      }
    })
    notify?.('turn/completed', {
      threadId: 'thread-mcp',
      turn: { id: 'turn-mcp', status: 'completed', error: null }
    })
    await handle.promise

    expect(events.find((event) => event.toolUseId === 'mcp-call')).toMatchObject({
      tool: 'Bash',
      isMcp: true,
      mcpServer: 'coop',
      mcpAction: 'query_workitem_detail',
      mcpTool: 'mcporter:coop.query_workitem_detail',
      mcpCalls: [
        { server: 'coop', action: 'query_workitem_detail', tool: 'mcporter:coop.query_workitem_detail' },
        { server: 'group-env', action: 'list', tool: 'mcporter:group-env.list' }
      ]
    })
    expect(events.find((event) => event.toolUseId === 'mcp-call' && event.stage === 'tool_result')).toMatchObject({
      isError: true,
      output: '{"success":false,"error":"invalid payload"}'
    })
    expect(events.find((event) => event.toolUseId === 'mcp-list')).toMatchObject({
      tool: 'Bash',
      runtimeMetadata: { mcpManagementAction: 'list' }
    })
    expect(events.find((event) => event.toolUseId === 'mcp-list')?.isMcp).not.toBe(true)
  })

  it('keeps a failed Codex turn as an error result with the upstream failure detail', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-failed' } }
      if (method === 'turn/start') return { turn: { id: 'turn-failed' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-failed',
      prompt: 'inspect',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('error', {
      threadId: 'thread-failed',
      turnId: 'turn-failed',
      willRetry: false,
      error: {
        message: 'stream disconnected before completion',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: 'connection reset'
      }
    })
    notify?.('turn/completed', {
      threadId: 'thread-failed',
      turn: {
        id: 'turn-failed',
        status: 'failed',
        error: {
          message: 'stream disconnected before completion',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: 'connection reset'
        }
      }
    })
    await expect(handle.promise).resolves.toMatchObject({
      externalSessionId: 'thread-failed',
      providerTurnId: 'turn-failed',
      status: 'failed'
    })

    expect(events.find((event) => event.kind === 'harness' && event.stage === 'result')).toMatchObject({
      isError: true,
      text: 'stream disconnected before completion',
      output: 'stream disconnected before completion',
      runtimeMetadata: expect.objectContaining({
        turnStatus: 'failed',
        turnError: expect.objectContaining({ message: 'stream disconnected before completion' })
      })
    })
  })

  it('records an implicit Skill invocation when Codex reads its SKILL.md', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } }
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-1',
      prompt: '检查可用 Skill',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    notify?.('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'exec-1',
        type: 'commandExecution',
        command: "sed -n '1,200p' .agents/skills/scry-e2e-audit/SKILL.md",
        cwd: '/isolated-copy'
      }
    })
    notify?.('turn/completed', { threadId: 'thread-1', turnId: 'turn-1', turn: { status: 'completed' } })
    await handle.promise

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'skill',
        stage: 'skill:scry-e2e-audit',
        tool: 'Skill',
        name: 'scry-e2e-audit',
        input: expect.objectContaining({ source: 'skill_path_in_command' })
      })
    )
  })

  it('maps native Codex hook lifecycle notifications into Scry hook events', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } }
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-1',
      prompt: '触发 hook',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    const hookRun = {
      id: 'hook-1',
      eventName: 'preToolUse',
      handlerType: 'command',
      status: 'running',
      statusMessage: 'Checking tool',
      source: 'project',
      sourcePath: '/Users/baobingjiang/IdeaProjects/rate-native/.codex/hooks.json',
      scope: 'turn',
      durationMs: null,
      entries: []
    }
    notify?.('hook/started', { threadId: 'thread-1', turnId: 'turn-1', run: hookRun })
    notify?.('hook/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      run: { ...hookRun, status: 'completed', durationMs: 12, entries: [{ kind: 'context', text: 'ok' }] }
    })
    notify?.('turn/completed', { threadId: 'thread-1', turnId: 'turn-1', turn: { status: 'completed' } })
    await handle.promise

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'hook',
          stage: 'hook_started',
          hookId: 'hook-1',
          hookEvent: 'PreToolUse',
          hookOutcome: 'started'
        }),
        expect.objectContaining({
          kind: 'hook',
          stage: 'hook_response',
          hookId: 'hook-1',
          hookEvent: 'PreToolUse',
          hookOutcome: 'success',
          durationMs: 12,
          isError: false,
          input: expect.objectContaining({
            sourcePath: '/isolated-copy/.codex/hooks.json',
            originalSourcePath: '/Users/baobingjiang/IdeaProjects/rate-native/.codex/hooks.json'
          })
        })
      ])
    )
  })
})
