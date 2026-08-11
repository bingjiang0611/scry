import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  close: vi.fn(),
  spawn: vi.fn(),
  runtimeCliEnv: vi.fn((_base?: Record<string, string>, _options: { managedRecorder?: boolean } = {}) => ({}))
}))

vi.mock('node:child_process', () => ({ spawn: sdk.spawn }))

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({ type: 'qodercli' }),
  query: sdk.query
}))

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/qodercli',
  runtimeCliEnv: sdk.runtimeCliEnv,
  shellEnv: () => ({})
}))

import {
  createQoderAdapter,
  expandQoderProjectCommand,
  parseQoderBackgroundTaskFailures,
  parseQoderHookLog,
  qoderHookFallbackOnly,
  qoderProviderTurnIdFromLog
} from './qoder'

describe('Qoder provider adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports the SDK Skill catalog as read-only rather than unsupported', async () => {
    await expect(createQoderAdapter().describe()).resolves.toMatchObject({
      id: 'qoder',
      label: 'Qoder',
      transport: 'Qoder Agent SDK',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'read' }
    })
  })

  it('lists Qoder MCP without starting a process, then injects only the authorized snapshot on refresh', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-qoder-mcp-test-'))
    const configDir = join(home, '.qoder')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'mcp.json'), JSON.stringify({
      mcpServers: { tracker: { command: '/bin/echo', args: ['configured'] } }
    }))
    try {
      const adapter = createQoderAdapter(home)
      await expect(adapter.mcp!.snapshot({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
        mode: 'read',
        state: 'degraded',
        data: { configured: [expect.objectContaining({ name: 'tracker' })], runtime: null }
      })
      expect(sdk.query).not.toHaveBeenCalled()

      const mcpServerStatus = vi.fn().mockResolvedValue([{
        name: 'tracker', status: 'connected', scope: 'qoder',
        config: { command: '/bin/echo', args: ['approved'] }, tools: [{ name: 'ping' }]
      }])
      sdk.query.mockReturnValue({
        initializationResult: vi.fn().mockResolvedValue({}),
        mcpServerStatus,
        close: sdk.close
      })
      await expect(adapter.mcp!.snapshot(
        { providerId: 'qoder', cwd: '/repo' },
        true,
        {
          cwd: '/repo', fingerprint: 'sha256:test', env: { PATH: '/bin' },
          targets: [{ targetId: 'target', name: 'tracker', enabled: true, config: { command: '/bin/echo', args: ['approved'] } }]
        }
      )).resolves.toMatchObject({
        state: 'ready',
        data: {
          configured: [expect.objectContaining({ targetId: expect.any(String), name: 'tracker' })],
          runtime: [expect.objectContaining({ name: 'tracker', status: 'connected', tools: 1 })]
        }
      })
      expect(sdk.query.mock.calls[0][0].options).toMatchObject({
        strictMcpConfig: true,
        mcpServers: { tracker: { command: '/bin/echo', args: ['approved'], env: { PATH: '/bin' } } }
      })
      expect(mcpServerStatus).toHaveBeenCalledOnce()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('redacts credentials from native MCP refresh failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-qoder-mcp-error-test-'))
    await mkdir(join(home, '.qoder'), { recursive: true })
    await writeFile(join(home, '.qoder', 'mcp.json'), JSON.stringify({
      mcpServers: { remote: { type: 'http', url: 'https://mcp.example.test' } }
    }))
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockRejectedValue(new Error('accessToken=secret-access')),
      close: sdk.close
    })
    try {
      const result = await createQoderAdapter(home).mcp!.snapshot(
        { providerId: 'qoder', cwd: '/repo' },
        true,
        {
          cwd: '/repo', fingerprint: 'sha256:test', env: {},
          targets: [{ targetId: 'remote', name: 'remote', enabled: true, config: { url: 'https://mcp.example.test' } }]
        }
      )

      expect(result.reason).toContain('[redacted]')
      expect(result.reason).not.toContain('secret-access')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('advertises native OAuth only for enabled remote Qoder MCP targets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-qoder-auth-operations-test-'))
    const configDir = join(home, '.qoder')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        remote: { type: 'http', url: 'https://remote.example/mcp' },
        local: { command: '/bin/echo' },
        disabled: { type: 'http', url: 'https://disabled.example/mcp', enabled: false }
      }
    }))
    try {
      const result = await createQoderAdapter(home).mcp!.snapshot({ providerId: 'qoder', cwd: '/repo' })
      const remote = result.data?.configured.find((item) => item.name === 'remote')
      expect(result.data?.operations?.authenticate).toEqual([remote?.targetId])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not advertise or start OAuth when enabled Qoder scopes contain the same native server name', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-qoder-auth-duplicate-'))
    const cwd = join(home, 'repo')
    await mkdir(join(home, '.qoder'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(join(home, '.qoder', 'mcp.json'), JSON.stringify({
      mcpServers: { tracker: { type: 'http', url: 'https://user.example/mcp' } }
    }))
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { tracker: { type: 'http', url: 'https://project.example/mcp' } }
    }))
    try {
      const adapter = createQoderAdapter(home)
      const snapshot = await adapter.mcp!.snapshot({ providerId: 'qoder', cwd })
      expect(snapshot.data?.configured.filter((item) => item.name === 'tracker')).toHaveLength(2)
      expect(snapshot.data?.operations?.authenticate).toEqual([])
      await expect(adapter.mcp!.reauthenticate!(
        { providerId: 'qoder', cwd },
        'user-tracker',
        {
          cwd, fingerprint: 'sha256:duplicate', env: {},
          targets: [
            { targetId: 'user-tracker', name: 'tracker', enabled: true, config: { url: 'https://user.example/mcp' } },
            { targetId: 'project-tracker', name: 'tracker', enabled: true, config: { url: 'https://project.example/mcp' } }
          ]
        },
        { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
      )).resolves.toMatchObject({
        data: { ok: false, status: 'failed', error: expect.stringContaining('多个同名') }
      })
      expect(sdk.query).not.toHaveBeenCalled()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('silently reauthenticates the exact authorized Qoder MCP target before any prompt', async () => {
    const mcpAuthenticate = vi.fn().mockResolvedValue({ requiresUserAction: false })
    const mcpServerStatus = vi.fn().mockResolvedValue([{ name: 'tracker', status: 'connected' }])
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      mcpAuthenticate,
      mcpServerStatus,
      close: sdk.close
    })
    const closeLoopback = vi.fn()
    const waitForCallback = vi.fn()
    const openExternal = vi.fn()
    const execution = {
      cwd: '/repo', fingerprint: 'sha256:test', env: { PATH: '/bin' },
      targets: [
        { targetId: 'other-id', name: 'other', enabled: true, config: { url: 'https://other.example/mcp' } },
        { targetId: 'tracker-id', name: 'tracker', enabled: true, config: { url: 'https://tracker.example/mcp' } }
      ]
    }

    await expect(createQoderAdapter().mcp!.reauthenticate!(
      { providerId: 'qoder', cwd: '/repo' },
      'tracker-id',
      execution,
      {
        openExternal,
        prepareLoopbackCallback: vi.fn().mockResolvedValue({
          redirectUri: 'http://127.0.0.1:3210/oauth/callback',
          waitForCallback,
          close: closeLoopback
        })
      }
    )).resolves.toMatchObject({ state: 'ready', data: { ok: true, status: 'authenticated' } })

    expect(mcpAuthenticate).toHaveBeenCalledWith('tracker', 'http://127.0.0.1:3210/oauth/callback')
    expect(openExternal).not.toHaveBeenCalled()
    expect(waitForCallback).not.toHaveBeenCalled()
    expect(closeLoopback).toHaveBeenCalledOnce()
    expect(sdk.query.mock.calls[0][0].options).toMatchObject({
      strictMcpConfig: true,
      persistSession: false
    })
    expect(sdk.query.mock.calls[0][0].options.mcpServers).toEqual({
      tracker: { url: 'https://tracker.example/mcp' }
    })
  })

  it('completes interactive Qoder OAuth through the loopback callback before reporting success', async () => {
    const mcpAuthenticate = vi.fn().mockResolvedValue({
      requiresUserAction: true,
      authUrl: 'https://identity.example/authorize?state=opaque'
    })
    const mcpSubmitOAuthCallbackUrl = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      mcpAuthenticate,
      mcpSubmitOAuthCallbackUrl,
      mcpServerStatus: vi.fn().mockResolvedValue([{ name: 'tracker', status: 'connected' }]),
      close: sdk.close
    })
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const waitForCallback = vi.fn().mockResolvedValue('http://127.0.0.1:3210/oauth/callback?code=secret&state=opaque')
    const closeLoopback = vi.fn()

    await expect(createQoderAdapter().mcp!.reauthenticate!(
      { providerId: 'qoder', cwd: '/repo' },
      'tracker-id',
      {
        cwd: '/repo', fingerprint: 'sha256:test', env: {},
        targets: [{ targetId: 'tracker-id', name: 'tracker', enabled: true, config: { url: 'https://tracker.example/mcp' } }]
      },
      {
        openExternal,
        prepareLoopbackCallback: vi.fn().mockResolvedValue({
          redirectUri: 'http://127.0.0.1:3210/oauth/callback',
          waitForCallback,
          close: closeLoopback
        })
      }
    )).resolves.toMatchObject({ state: 'ready', data: { ok: true, status: 'authenticated' } })

    expect(openExternal).toHaveBeenCalledWith('https://identity.example/authorize?state=opaque')
    expect(mcpSubmitOAuthCallbackUrl).toHaveBeenCalledWith(
      'tracker',
      'http://127.0.0.1:3210/oauth/callback?code=secret&state=opaque'
    )
    expect(openExternal.mock.invocationCallOrder[0]).toBeLessThan(waitForCallback.mock.invocationCallOrder[0])
    expect(waitForCallback.mock.invocationCallOrder[0]).toBeLessThan(mcpSubmitOAuthCallbackUrl.mock.invocationCallOrder[0])
    expect(closeLoopback).toHaveBeenCalledOnce()
  })

  it('times out the complete Qoder authentication flow and closes its query', async () => {
    const mcpAuthenticate = vi.fn(() => new Promise(() => {}))
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      mcpAuthenticate,
      close: sdk.close
    })
    const closeLoopback = vi.fn()
    vi.useFakeTimers()
    try {
      const result = createQoderAdapter().mcp!.reauthenticate!(
        { providerId: 'qoder', cwd: '/repo' },
        'tracker-id',
        {
          cwd: '/repo', fingerprint: 'sha256:test', env: {},
          targets: [{ targetId: 'tracker-id', name: 'tracker', enabled: true, config: { url: 'https://tracker.example/mcp' } }]
        },
        {
          openExternal: vi.fn(),
          prepareLoopbackCallback: vi.fn().mockResolvedValue({
            redirectUri: 'http://127.0.0.1:3210/oauth/callback',
            waitForCallback: vi.fn(),
            close: closeLoopback
          })
        }
      )
      await vi.advanceTimersByTimeAsync(120_000)
      await expect(result).resolves.toMatchObject({
        data: { ok: false, status: 'failed', error: expect.stringContaining('超时') }
      })
      expect(closeLoopback).toHaveBeenCalledOnce()
      expect(sdk.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start Qoder when the requested MCP target is absent from the authorized snapshot', async () => {
    await expect(createQoderAdapter().mcp!.reauthenticate!(
      { providerId: 'qoder', cwd: '/repo' },
      'missing-id',
      { cwd: '/repo', fingerprint: 'sha256:test', env: {}, targets: [] },
      {
        openExternal: vi.fn(),
        prepareLoopbackCallback: vi.fn().mockResolvedValue({
          redirectUri: 'http://127.0.0.1:3210/oauth/callback',
          waitForCallback: vi.fn(),
          close: vi.fn()
        })
      }
    )).resolves.toMatchObject({
      state: 'ready',
      data: { ok: false, status: 'failed', error: expect.stringContaining('不存在该目标') }
    })
    expect(sdk.query).not.toHaveBeenCalled()
  })

  it('reads discovered Skill metadata and normalizes non-user/project sources to unknown', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          totalSkills: 3,
          includedSkills: 3,
          skillFrontmatter: [
            { name: 'scry-e2e-audit', source: 'project', tokens: 0 },
            { name: 'browser-use', source: 'user', tokens: 0 },
            { name: 'local-helper', source: 'local', tokens: 0 }
          ]
        }
      }),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'scry-e2e-audit', description: 'Repository audit', argumentHint: '' },
        { name: 'browser-use', description: 'Browser control', argumentHint: '' },
        { name: 'local-helper', description: 'Local helper', argumentHint: '' }
      ]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const result = await adapter.skills!.list({ providerId: 'qoder', cwd: '/repo' })
    expect(result).toMatchObject({
      mode: 'read',
      state: 'ready',
      data: [
        { name: 'scry-e2e-audit', scope: 'project', description: 'Repository audit', enabled: true },
        { name: 'browser-use', scope: 'user', description: 'Browser control', enabled: true },
        { name: 'local-helper', scope: 'unknown', description: 'Local helper', enabled: true }
      ]
    })
    await adapter.dispose?.()
  })

  it('classifies only catalog-backed Skill commands and leaves other command sources unknown', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'help', description: 'Help', argumentHint: '' },
        { name: 'scry-e2e-audit', description: 'Repository audit', argumentHint: '<path>' },
        { name: 'project-command', description: 'Project command', argumentHint: '' }
      ]),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          totalSkills: 1,
          includedSkills: 1,
          skillFrontmatter: [{ name: 'scry-e2e-audit', source: 'project', tokens: 0 }]
        }
      }),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      getUsageInfo: vi.fn().mockResolvedValue(null),
      accountInfo: vi.fn().mockResolvedValue({ userId: 'user-1' }),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const result = await adapter.commands!.list({ providerId: 'qoder', cwd: '/repo' })
    expect(result).toMatchObject({
      state: 'ready',
      data: [
        { name: 'help', source: undefined },
        { name: 'scry-e2e-audit', argumentHint: '<path>', source: 'skill' },
        { name: 'project-command', source: undefined }
      ]
    })
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }) }))
    expect(sdk.close).not.toHaveBeenCalled()
    await adapter.dispose?.()
    expect(sdk.close).toHaveBeenCalledOnce()
  })

  it('keeps commands readable but their sources unknown when the Skill catalog fails', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([{ name: 'help', description: 'Help', argumentHint: '' }]),
      getContextUsage: vi.fn().mockRejectedValue(new Error('catalog unavailable')),
      close: sdk.close
    })
    const adapter = createQoderAdapter()

    await expect(adapter.commands!.list({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      state: 'degraded',
      reason: expect.stringContaining('catalog unavailable'),
      data: [{ name: 'help', source: undefined }]
    })
    await adapter.dispose?.()
  })

  it('preserves native account quota without exposing control-session credits as chat usage', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getUsageInfo: vi.fn().mockResolvedValue({
        userType: 'Pro',
        userQuota: { total: 100, used: 25, remaining: 75, unit: 'credits' },
        session: { total_credits: 1.25, model_usage: { performance: { credits: 1.25 } } }
      }),
      accountInfo: vi.fn().mockResolvedValue({ email: 'user@example.test', subscriptionType: 'Pro' }),
      close: sdk.close
    })
    const adapter = createQoderAdapter()

    const result = await adapter.account!.read({ providerId: 'qoder', cwd: '/repo' })
    expect(result).toMatchObject({
      mode: 'read',
      state: 'ready',
      data: {
        accountLabel: 'user@example.test',
        plan: 'Pro',
        usage: {
          userQuota: { total: 100, used: 25, remaining: 75, unit: 'credits' }
        }
      }
    })
    expect(result.data?.usage).not.toHaveProperty('session')
    await adapter.dispose?.()
  })

  it('keeps an empty native account response unknown instead of reporting ready', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getUsageInfo: vi.fn().mockResolvedValue(null),
      accountInfo: vi.fn().mockResolvedValue({}),
      close: sdk.close
    })
    const adapter = createQoderAdapter()

    await expect(adapter.account!.read({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      mode: 'read',
      state: 'unknown',
      data: null,
      reason: expect.stringContaining('未返回账号或用量证据')
    })
    await adapter.dispose?.()
  })

  it('ignores blank account fields and falls back to trimmed native evidence', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getUsageInfo: vi.fn().mockResolvedValue({ userType: '  Team  ' }),
      accountInfo: vi.fn().mockResolvedValue({ email: '  ', name: '  Ada  ', userId: 'ignored' }),
      close: sdk.close
    })
    const adapter = createQoderAdapter()

    await expect(adapter.account!.read({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      state: 'ready',
      data: {
        accountLabel: 'Ada',
        plan: 'Team'
      }
    })
    await adapter.dispose?.()
  })

  it('reads model efforts from the native Qoder catalog', async () => {
    const getAvailableModels = vi.fn().mockResolvedValue([])
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        models: [{
          value: 'performance',
          displayName: 'Performance',
          description: 'fast',
          isDefault: true,
          isEnabled: true,
          efforts: ['low', 'high'],
          defaultEffort: 'high'
        }]
      }),
      getAvailableModels,
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    await expect(adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      state: 'ready',
      data: {
        models: [{
          model: { id: 'performance' },
          efforts: [{ id: 'low' }, { id: 'high', isDefault: true }]
        }]
      }
    })
    expect(getAvailableModels).not.toHaveBeenCalled()
    await adapter.dispose?.()
  })

  it('falls back to the live CLI catalog when initialization has no models', async () => {
    const getAvailableModels = vi.fn().mockResolvedValue([])
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({ models: [] }),
      getAvailableModels,
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    await adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })
    expect(getAvailableModels).toHaveBeenCalledWith({ fetchStrategy: 'live' })
    await adapter.dispose?.()
  })

  it('bounds a control session that never initializes and retries with a fresh session', async () => {
    vi.useFakeTimers()
    try {
      sdk.query.mockReturnValueOnce({
        initializationResult: vi.fn().mockReturnValue(new Promise(() => {})),
        close: sdk.close
      })
      const adapter = createQoderAdapter()
      const pending = adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })
      await vi.advanceTimersByTimeAsync(20_000)

      await expect(pending).resolves.toMatchObject({
        state: 'degraded',
        data: { models: [] },
        reason: expect.stringContaining('未完成初始化')
      })
      expect(sdk.close).toHaveBeenCalled()

      sdk.query.mockReturnValueOnce({
        initializationResult: vi.fn().mockResolvedValue({
          models: [{ value: 'ultimate', displayName: 'Ultimate', isEnabled: true, efforts: [] }]
        }),
        close: sdk.close
      })
      const retry = adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })
      await vi.advanceTimersByTimeAsync(0)

      await expect(retry).resolves.toMatchObject({
        state: 'ready',
        data: { models: [{ model: { id: 'ultimate' } }] }
      })
      expect(sdk.query).toHaveBeenCalledTimes(2)
      await adapter.dispose?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deduplicates streamed text and treats impossible all-zero usage as unknown', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } } }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }
        yield { type: 'result', subtype: 'success', result: 'OK', usage: { input_tokens: 0, output_tokens: 0 } }
      },
      close,
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-1',
      prompt: 'only OK',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise
    expect(result.stopped).toBe(false)
    expect(events.filter((event) => event.kind === 'model').map((event) => event.text)).toEqual(['O', 'K'])
    expect(events.find((event) => event.kind === 'harness')).toMatchObject({
      stage: 'result',
      tokensIn: undefined,
      tokensOut: undefined,
      costUsd: undefined,
      runtimeMetadata: expect.objectContaining({ reportedZeroUsage: true })
    })
    expect(sdk.runtimeCliEnv).toHaveBeenCalledWith(undefined, {})
    expect(sdk.query.mock.calls[0][0].options.env).toMatchObject({
      QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
    })
  })

  it('managed Qoder 返回 native promptId 与失败状态，并只在显式启用时注入 managed 环境', async () => {
    sdk.runtimeCliEnv.mockImplementation((_base?: Record<string, string>, options: { managedRecorder?: boolean } = {}) =>
      options?.managedRecorder ? { SCRY_RECORDER_MANAGED: '1' } : {}
    )
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          session_id: 'qoder-session',
          promptId: 'qoder-turn',
          message: { content: [{ type: 'text', text: 'failed' }] }
        }
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'qoder-session',
          promptId: 'qoder-turn',
          duration_ms: 10,
          duration_api_ms: 8,
          errors: ['failed']
        }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })

    const handle = createQoderAdapter().run({
      runId: 'run-managed',
      prompt: 'work',
      cwd: '/repo',
      attachments: [],
      managedRecorder: true,
      emit: vi.fn()
    })

    await expect(handle.promise).resolves.toMatchObject({
      externalSessionId: 'qoder-session',
      providerTurnId: 'qoder-turn',
      status: 'failed'
    })
    expect(handle.getProviderTurnId?.()).toBe('qoder-turn')
    expect(sdk.query.mock.calls[0][0].options.env).toMatchObject({ SCRY_RECORDER_MANAGED: '1' })
  })

  it('通过 Qoder control API 执行 /plugins reload，不把它发送给模型', async () => {
    const reloadPlugins = vi.fn().mockResolvedValue({
      commands: Array.from({ length: 11 }, (_, index) => ({ name: `command-${index}` })),
      agents: [],
      plugins: [{ name: 'test-plugin', path: '/plugin' }],
      mcpServers: [],
      error_count: 0
    })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'qoder-session', mcp_servers: [] }
      },
      reloadPlugins,
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    const result = await createQoderAdapter().run({
      runId: 'run-plugin-reload',
      prompt: '/plugins reload',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(reloadPlugins).toHaveBeenCalledOnce()
    expect(sdk.query.mock.calls[0][0].prompt).not.toBe('/plugins reload')
    expect(result).toMatchObject({ externalSessionId: 'qoder-session', status: 'completed' })
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'model',
      stage: 'text',
      text: '插件已重载：1 个插件，11 条命令',
      runtimeMetadata: expect.objectContaining({ source: 'qoder_sdk_control' })
    }))
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness',
      stage: 'result',
      isError: false
    }))
  })

  it('把 Qoder 日志中的后台 shell 失败回写为本轮失败', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'scry-qoder-background-test-'))
    const runLogDir = join(configDir, 'logs', 'runs', 'run-p126')
    await mkdir(runLogDir, { recursive: true })
    await writeFile(join(runLogDir, 'qodercli.log'), [
      '2026-08-05T18:31:57.544+08:00 INFO  [session=qoder-session] tool.shell.backgrounded pid=35509 command="make build-local"',
      '2026-08-05T18:42:08.004+08:00 WARN  [session=qoder-session turn=qoder-turn tool=tool-1] tool.shell.finished pid=35509 exit_code=143 signal=15 aborted=true output_length=0'
    ].join('\n'))
    const previousConfigDir = process.env.QODER_CONFIG_DIR
    process.env.QODER_CONFIG_DIR = configDir
    try {
      const child = Object.assign(new EventEmitter(), { pid: 126, kill: vi.fn() })
      sdk.spawn.mockReturnValue(child)
      sdk.query.mockImplementation(({ options }) => {
        options.spawnQoderCLIProcess({
          command: '/bin/qodercli',
          args: [],
          cwd: '/repo',
          env: {},
          signal: new AbortController().signal
        })
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'qoder-session', mcp_servers: [] }
            yield { type: 'result', subtype: 'success', session_id: 'qoder-session', result: 'backgrounded' }
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })
      const events: TraceEvent[] = []

      const result = await createQoderAdapter().run({
        runId: 'run-background-failure',
        prompt: 'work',
        cwd: '/repo',
        attachments: [],
        emit: (event) => events.push(event)
      }).promise

      expect(result.status).toBe('failed')
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'tool',
        stage: 'tool_result',
        toolUseId: 'tool-1',
        isError: true,
        runtimeMetadata: expect.objectContaining({ backgroundTask: true, exitCode: 143 })
      }))
    } finally {
      if (previousConfigDir == null) delete process.env.QODER_CONFIG_DIR
      else process.env.QODER_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('在送入 SDK 前展开项目 Qoder command，避免 slash command 零 turn 退出', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'scry-qoder-command-test-'))
    const commandsDir = join(cwd, '.qoder', 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'rate-native-rate-workflow.md'), [
      '---',
      'description: validate rate workflow',
      '---',
      '# rate-workflow',
      '',
      'Read the canonical skill before acting.'
    ].join('\n'))
    try {
      const expanded = [
        '# rate-workflow',
        '',
        'Read the canonical skill before acting.',
        '',
        'ARGUMENTS: 85008418'
      ].join('\n')
      await expect(
        expandQoderProjectCommand('/rate-native-rate-workflow 85008418', cwd)
      ).resolves.toBe(expanded)
      sdk.query.mockImplementation(({ prompt }) => {
        expect(prompt).toBe(expanded)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'result', subtype: 'success', result: 'done' }
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })

      await createQoderAdapter().run({
        runId: 'run-project-command',
        prompt: '/rate-native-rate-workflow 85008418',
        cwd,
        attachments: [],
        emit: vi.fn()
      }).promise
      expect(sdk.query).toHaveBeenCalledOnce()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('展开 Qoder command 的位置参数，未命中项目 command 时保持原 prompt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'scry-qoder-command-args-test-'))
    const commandsDir = join(cwd, '.qoder', 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'inspect.md'), 'Inspect $0 then $ARGUMENTS[1]. All: $ARGUMENTS')
    try {
      await expect(expandQoderProjectCommand('/inspect "hello world" tail', cwd))
        .resolves.toBe('Inspect hello world then tail. All: "hello world" tail')
      await expect(expandQoderProjectCommand('/missing value', cwd))
        .resolves.toBe('/missing value')
      await expect(expandQoderProjectCommand('/../inspect secret', cwd))
        .resolves.toBe('/../inspect secret')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('bridges AskUserQuestion answers through the Qoder SDK permission callback', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close,
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { '选择流程？': '全量' }
    }))

    const run = createQoderAdapter().run({
      runId: 'run-question',
      prompt: 'ask',
      attachments: [],
      emit: vi.fn(),
      permissionMode: 'full_access',
      requestUserInput
    })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool as (
      tool: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID: string }
    ) => Promise<Record<string, unknown>>
    const input = {
      questions: [
        {
          question: '选择流程？',
          header: '流程',
          multiSelect: false,
          options: [
            { label: '全量', description: '完整执行' },
            { label: '快速', description: '缩短流程' }
          ]
        }
      ]
    }

    await expect(
      canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'tool-1' })
    ).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { '选择流程？': '全量' } },
      decisionClassification: 'user_temporary'
    })
    await expect(
      canUseTool('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
    ).resolves.toEqual({ behavior: 'allow' })
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-question', questionId: 'tool-1' }),
      expect.any(AbortSignal)
    )
    await run.promise
  })

  it('only offers and returns Qoder safe exact addRules session suggestions', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const requests: Array<{ questions: Array<{ question: string; options: Array<{ label: string; description: string }> }> }> = []
    const requestUserInput = vi.fn(async (request) => {
      requests.push(request)
      return {
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'answered' as const,
        answers: { [request.questions[0].question]: '本次会话允许' }
      }
    })
    const run = createQoderAdapter().run({
      runId: 'run-permission-scope',
      prompt: 'work',
      attachments: [],
      emit: vi.fn(),
      requestUserInput
    })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    const sessionSuggestion = {
      type: 'addRules' as const,
      rules: [
        { toolName: 'mcp__tracker__read', ruleContent: 'resource:1' },
        { toolName: 'mcp__tracker__read', ruleContent: 'resource:2' }
      ],
      behavior: 'allow' as const,
      destination: 'session' as const
    }
    const persistentSuggestion = {
      ...sessionSuggestion,
      destination: 'userSettings' as const
    }
    const exactRule = [{ toolName: 'mcp__tracker__read', ruleContent: 'resource:1' }]
    const unsafeSessionSuggestions = [
      { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
      { type: 'addDirectories' as const, directories: ['/tmp'], destination: 'session' as const },
      { type: 'removeDirectories' as const, directories: ['/tmp'], destination: 'session' as const },
      { type: 'replaceRules' as const, rules: exactRule, behavior: 'allow' as const, destination: 'session' as const },
      { type: 'removeRules' as const, rules: exactRule, behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'mcp__tracker__read' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: ' ', ruleContent: 'resource:1' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'mcp__tracker__read', ruleContent: ' ' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: '*', ruleContent: '*' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [...exactRule, { toolName: 'Read' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: exactRule, behavior: 'deny' as const, destination: 'session' as const }
    ]

    await expect(canUseTool(
      'mcp__tracker__read',
      { id: '1' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-session',
        suggestions: [persistentSuggestion, ...unsafeSessionSuggestions, sessionSuggestion]
      }
    )).resolves.toEqual({
      behavior: 'allow',
      updatedPermissions: [sessionSuggestion],
      decisionClassification: 'user_permanent'
    })
    await expect(canUseTool(
      'mcp__tracker__read',
      { id: '2' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-unsafe',
        suggestions: [persistentSuggestion, ...unsafeSessionSuggestions]
      }
    )).resolves.toEqual({ behavior: 'allow', decisionClassification: 'user_temporary' })

    expect(requests[0].questions[0].options).toContainEqual(expect.objectContaining({
      label: '本次会话允许',
      description: expect.stringContaining('mcp__tracker__read → resource:1')
    }))
    expect(requests[0].questions[0].options).toContainEqual(expect.objectContaining({
      label: '本次会话允许',
      description: expect.stringContaining('mcp__tracker__read → resource:2')
    }))
    expect(requests[1].questions[0].options.map((option) => option.label)).toEqual(['允许一次', '拒绝'])
    await run.promise
  })

  it('passes Qoder model effort through model policy and uses auto review', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    await createQoderAdapter().run({
      runId: 'run-controls',
      prompt: 'work',
      attachments: [],
      model: { id: 'performance' },
      effort: 'high',
      permissionMode: 'auto_review',
      emit: vi.fn()
    }).promise
    const options = sdk.query.mock.calls[0][0].options
    expect(options.permissionMode).toBe('auto')
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(options.resolveModel()).toEqual({
      model: 'performance',
      parameters: { reasoningEffort: 'high' }
    })
  })

  it('returns a non-interrupting Qoder denial when the user cancels a question', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const run = createQoderAdapter().run({
      runId: 'run-question-cancel',
      prompt: 'ask',
      attachments: [],
      emit: vi.fn(),
      requestUserInput: async (request) => ({
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'cancelled'
      })
    })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool

    await expect(
      canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: '继续？',
              header: '确认',
              multiSelect: false,
              options: [
                { label: '继续', description: '继续执行' },
                { label: '停止', description: '不再执行' }
              ]
            }
          ]
        },
        { signal: new AbortController().signal, toolUseID: 'tool-1' }
      )
    ).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: false,
      decisionClassification: 'user_reject'
    })
    await run.promise
  })

  it('rejects a run when the Qoder child exits but the SDK stream never settles', async () => {
    vi.useFakeTimers()
    try {
      const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() })
      sdk.spawn.mockReturnValue(child)
      const close = vi.fn().mockResolvedValue(undefined)
      sdk.query.mockImplementation(({ options }) => {
        options.spawnQoderCLIProcess({
          command: '/bin/qodercli',
          args: [],
          cwd: '/repo',
          env: {},
          signal: new AbortController().signal
        })
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {})
          },
          close,
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })

      const run = createQoderAdapter().run({
        runId: 'run-exit',
        prompt: 'work',
        cwd: '/repo',
        attachments: [],
        emit: vi.fn()
      })
      const rejected = expect(run.promise).rejects.toThrow('Qoder CLI 已退出，但 SDK 事件流未结束')
      child.emit('exit', 143, null)
      await vi.advanceTimersByTimeAsync(1000)

      await rejected
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a structured Qoder failure when the CLI exits with code 1 afterwards', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 124, kill: vi.fn() })
    sdk.spawn.mockReturnValue(child)
    const close = vi.fn().mockRejectedValue(new Error('Qoder CLI process exited with code 1'))
    sdk.query.mockImplementation(({ options }) => {
      options.spawnQoderCLIProcess({
        command: '/bin/qodercli',
        args: [],
        cwd: '/repo',
        env: {},
        signal: new AbortController().signal
      })
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['Unknown slash command: /rate-workflow']
          }
          child.emit('exit', 1, null)
          throw new Error('Qoder CLI process exited with code 1')
        },
        close,
        interrupt: vi.fn().mockResolvedValue(undefined)
      }
    })

    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-provider-failure',
      prompt: '/rate-workflow',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(result.stopped).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness',
      stage: 'result',
      text: 'Unknown slash command: /rate-workflow',
      isError: true
    }))
  })

  it('SDK 流抛错时仍从 root log 绑定 managed native turn ID', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'scry-qoder-log-test-'))
    const runLogDir = join(configDir, 'logs', 'runs', 'run-p125')
    await mkdir(runLogDir, { recursive: true })
    await writeFile(join(runLogDir, 'qodercli.log'), [
      '2026-07-31T16:28:19.807+08:00 INFO  [session=qoder-session turn=native-prompt] input.prompt.received text_preview="work" query_source="sdk"',
      '2026-07-31T16:28:38.706+08:00 INFO  [session=qoder-session turn=native-prompt] turn.started is_subagent=false'
    ].join('\n'))
    const previousConfigDir = process.env.QODER_CONFIG_DIR
    const previousLogHooks = process.env.SCRY_QODER_LOG_HOOKS
    process.env.QODER_CONFIG_DIR = configDir
    process.env.SCRY_QODER_LOG_HOOKS = '0'
    try {
      const child = Object.assign(new EventEmitter(), { pid: 125, kill: vi.fn() })
      sdk.spawn.mockReturnValue(child)
      sdk.query.mockImplementation(({ options }) => {
        options.spawnQoderCLIProcess({
          command: '/bin/qodercli',
          args: [],
          cwd: '/repo',
          env: {},
          signal: new AbortController().signal
        })
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'qoder-session', mcp_servers: [] }
            throw new Error('stream aborted')
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })

      const handle = createQoderAdapter().run({
        runId: 'run-interrupted',
        prompt: 'work',
        cwd: '/repo',
        attachments: [],
        managedRecorder: true,
        emit: vi.fn()
      })

      await expect(handle.promise).rejects.toThrow('stream aborted')
      expect(handle.getProviderTurnId?.()).toBe('native-prompt')
    } finally {
      if (previousConfigDir == null) delete process.env.QODER_CONFIG_DIR
      else process.env.QODER_CONFIG_DIR = previousConfigDir
      if (previousLogHooks == null) delete process.env.SCRY_QODER_LOG_HOOKS
      else process.env.SCRY_QODER_LOG_HOOKS = previousLogHooks
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('promotes the Qoder SDK hook name to its runtime command', async () => {
    const command = '"${QODER_PLUGIN_ROOT}/bin/qodersec-launch.cmd" ensure-deps --hook-event SessionStart'
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'hook-1',
          hook_name: command,
          hook_event: 'SessionStart',
          outcome: 'error',
          exit_code: 1,
          stdout: '',
          stderr: 'dependency failed',
          output: 'dependency failed'
        }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    await createQoderAdapter().run({
      runId: 'run-hook-command',
      prompt: 'work',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'hook',
      stage: 'hook_response',
      hookName: command,
      hookCommand: command,
      hookOutcome: 'error',
      runtimeMetadata: expect.objectContaining({ source: 'qoder_sdk' })
    }))
  })

  it('parses every same-name Qoder hook script from the current process log', () => {
    const log = [
      '2026-07-11T11:24:25.363+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="project" hook_index=1 display_text="project-hook"',
      '2026-07-11T11:24:25.364+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="user" hook_index=2 display_text="user-hook"',
      '2026-07-11T11:24:26.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=true duration_ms=637 exit_code=0',
      '2026-07-11T11:24:27.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=false duration_ms=1636 exit_code=1'
    ].join('\n')

    const events = parseQoderHookLog('run-1', log, 's1')

    expect(events).toHaveLength(4)
    expect(events.filter((event) => event.stage === 'hook_response')).toEqual([
      expect.objectContaining({ hookCommand: 'project-hook', hookOutcome: 'success', hookExitCode: 0 }),
      expect.objectContaining({ hookCommand: 'user-hook', hookOutcome: 'error', hookExitCode: 1, isError: true })
    ])
  })

  it('marks only failed background shell tasks from the Qoder process log', () => {
    const log = [
      '2026-08-05T18:31:57.544+08:00 INFO  [session=s1] tool.shell.backgrounded pid=35509 command="make build-local"',
      '2026-08-05T18:42:08.004+08:00 WARN  [session=s1 turn=t1 tool=tool-1] tool.shell.finished pid=35509 exit_code=143 signal=15 aborted=true output_length=0',
      '2026-08-05T18:42:09.000+08:00 INFO  [session=s1] tool.shell.backgrounded pid=35510 command="echo ok"',
      '2026-08-05T18:42:10.000+08:00 INFO  [session=s1 turn=t1 tool=tool-2] tool.shell.finished pid=35510 exit_code=0 aborted=false output_length=3'
    ].join('\n')

    expect(parseQoderBackgroundTaskFailures('run-1', log, 's1')).toEqual([
      expect.objectContaining({
        kind: 'tool',
        stage: 'tool_result',
        tool: 'Bash',
        toolUseId: 'tool-1',
        output: '后台 Bash 任务异常结束（exit 143 · signal 15）',
        isError: true,
        runtimeMetadata: expect.objectContaining({ backgroundTask: true, exitCode: 143, signal: '15' })
      })
    ])
  })

  it('从 Qoder root prompt 日志取 native turn identity，不把 hook 的 session turn 当成 promptId', () => {
    const log = [
      '2026-07-31T16:28:19.831+08:00 INFO  [session=s1 turn=s1] hook.started hook_name="UserPromptSubmit" hook_event_name="UserPromptSubmit" source="project"',
      '2026-07-31T16:28:19.807+08:00 INFO  [session=s1 turn=prompt-1] input.prompt.received text_preview="work" query_source="sdk"',
      '2026-07-31T16:28:38.705+08:00 INFO  [session=s1 turn=prompt-1] input.prompt.submitted is_subagent=false',
      '2026-07-31T16:28:38.706+08:00 INFO  [session=s1 turn=prompt-1] turn.started is_subagent=false',
      '2026-07-31T16:28:40.000+08:00 INFO  [session=s1 turn=child] turn.started is_subagent=true'
    ].join('\n')

    expect(qoderProviderTurnIdFromLog(log, 's1')).toBe('prompt-1')
  })

  it('Qoder 日志出现多个 SDK root prompt 时不猜 turn identity', () => {
    const log = [
      '2026-07-31T16:28:19.807+08:00 INFO  [session=s1 turn=prompt-1] input.prompt.received query_source="sdk"',
      '2026-07-31T16:29:19.807+08:00 INFO  [session=s1 turn=prompt-2] input.prompt.received query_source="sdk"'
    ].join('\n')

    expect(qoderProviderTurnIdFromLog(log, 's1')).toBeUndefined()
  })

  it('deduplicates SDK and log hooks by command while preserving repeated log-only hooks', () => {
    const sdk = (command: string): TraceEvent => ({
      id: command, runId: 'run-1', ts: '2026-07-11T00:00:00.000Z', kind: 'hook', stage: 'hook_started',
      hookName: command, hookEvent: 'SessionStart', hookOutcome: 'started', runtimeMetadata: { source: 'qoder_sdk' }
    })
    const fallback = (id: string, command: string): TraceEvent => ({
      id, runId: 'run-1', ts: '2026-07-11T00:00:00.000Z', kind: 'hook', stage: 'hook_started',
      hookName: 'SessionStart:startup', hookEvent: 'SessionStart', hookCommand: command, hookOutcome: 'started',
      runtimeMetadata: { source: 'qoder_cli_log' }
    })

    expect(qoderHookFallbackOnly([sdk('same-hook')], [fallback('a', 'same-hook'), fallback('b', 'same-hook')]))
      .toEqual([expect.objectContaining({ id: 'b' })])
  })
})
