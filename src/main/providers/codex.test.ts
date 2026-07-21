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
      capabilities: { skills: 'manage', mcp: 'read', commands: 'none', account: 'read' }
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
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1',
      tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 2, totalTokens: 14 } }
    })
    notify?.('turn/completed', { threadId: 'thread-1', turnId: 'turn-1', turn: { status: 'completed' } })
    await handle.promise

    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'skill', stage: 'skill:scry-e2e-audit', tool: 'Skill', name: 'scry-e2e-audit' })
    )
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness', stage: 'result', billingProvider: 'openai', accountLabel: 'OpenAI API key',
      modelUsage: [expect.objectContaining({ model: 'gpt-test', inputTokens: 10, billingProvider: 'openai' })],
      runtimeMetadata: expect.objectContaining({ authMode: 'apiKey', model: 'gpt-test', serviceTier: 'default' })
    }))
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
      sourcePath: '/isolated-copy/.codex/hooks.json',
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
          isError: false
        })
      ])
    )
  })
})
