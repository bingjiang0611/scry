import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  close: vi.fn(),
  spawn: vi.fn(),
  getSessionMessages: vi.fn(),
  forkSession: vi.fn(),
  runtimeCliEnv: vi.fn((_base?: Record<string, string>, _options: { managedRecorder?: boolean } = {}) => ({}))
}))

vi.mock('node:child_process', () => ({ spawn: sdk.spawn }))

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({ type: 'qodercli' }),
  query: sdk.query,
  getSessionMessages: sdk.getSessionMessages,
  forkSession: sdk.forkSession
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
  parseQoderSubagentTerminals,
  qoderHookFallbackOnly,
  qoderProviderTurnIdFromLog,
  resolveQoderSdkExecutable
} from './qoder'

describe('Qoder provider adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.getSessionMessages.mockReset().mockResolvedValue([])
    sdk.forkSession.mockReset()
  })

  it('resolves the qodercli symlink to its JavaScript bundle for the SDK launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-qoder-cli-'))
    try {
      const script = join(root, 'qodercli.js')
      const bin = join(root, 'qodercli')
      await writeFile(script, '#!/usr/bin/env node\n')
      await symlink(script, bin)
      expect(resolveQoderSdkExecutable(bin)).toBe(await realpath(script))
      expect(resolveQoderSdkExecutable(join(root, 'missing'))).toBe(join(root, 'missing'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forks Qoder immediately before the edited native prompt', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'assistant', uuid: 'assistant-previous' },
      { type: 'user', uuid: 'prompt-last' },
      { type: 'assistant', uuid: 'assistant-last' }
    ])
    sdk.forkSession.mockResolvedValue({ sessionId: 'session-forked' })

    await expect(createQoderAdapter().forkLastTurn!.fork({
      sourceSessionId: 'session-source',
      originalPrompt: 'old prompt',
      replaceRunId: 'run-last',
      replaceProviderTurnId: 'qoder-turn-last',
      replaceForkTurnId: 'prompt-last',
      previousProviderTurnId: 'qoder-turn-previous',
      previousForkTurnId: 'prompt-previous',
      cwd: '/repo'
    })).resolves.toEqual({ externalSessionId: 'session-forked' })
    expect(sdk.forkSession).toHaveBeenCalledWith('session-source', {
      dir: '/repo',
      upToMessageId: 'assistant-previous',
      title: 'Edited branch'
    })
  })

  it.each(['EPERM', 'EACCES'])('explains %s without retrying a potentially dispatched fork', async (code) => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'user-1', message: { content: 'prompt' } },
      { type: 'assistant', uuid: 'assistant-1', message: { content: 'answer' } }
    ])
    sdk.forkSession.mockRejectedValue(Object.assign(new Error('operation not permitted'), { code, path: '/qoder/session.jsonl' }))
    await expect(createQoderAdapter().forkSession!.fork({
      providerId: 'qoder', sourceSessionId: 'session-source', sourceRunId: 'run-1', sourceProviderTurnId: 'turn-1',
      sourceForkTurnId: 'user-1', cwd: '/repo'
    })).rejects.toThrow(`Qoder 会话文件访问被系统拒绝（${code}）`)
    expect(sdk.forkSession).toHaveBeenCalledTimes(1)
  })

  it('forks a legacy Qoder promptId through its exact UUID and all tool responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-qoder-fork-'))
    const previous = process.env.QODER_CONFIG_DIR
    const sessionId = '11111111-1111-4111-8111-111111111111'
    try {
      process.env.QODER_CONFIG_DIR = root
      const dir = join(root, 'projects', 'project')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${sessionId}.jsonl`), JSON.stringify({
        type: 'user', uuid: 'user-uuid', promptId: 'legacy-prompt-id', sessionId, cwd: '/repo'
      }) + '\n')
      sdk.getSessionMessages.mockResolvedValue([
        { type: 'user', uuid: 'user-uuid', message: { content: 'same prompt' } },
        { type: 'assistant', uuid: 'tool-call' },
        { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result' }] } },
        { type: 'assistant', uuid: 'final-response' },
        { type: 'user', uuid: 'next-user', message: { content: 'same prompt' } }
      ])
      sdk.forkSession.mockResolvedValue({ sessionId: 'new-session' })
      const request = {
        providerId: 'qoder' as const, sourceSessionId: sessionId, sourceRunId: 'run-old',
        sourceProviderTurnId: 'legacy-prompt-id', sourceForkTurnId: 'legacy-prompt-id', cwd: '/repo'
      }
      await expect(createQoderAdapter().forkSession!.fork(request))
        .resolves.toEqual({ externalSessionId: 'new-session' })
      expect(sdk.forkSession).toHaveBeenCalledWith(sessionId, {
        dir: '/repo', upToMessageId: 'final-response', title: 'Scry branch'
      })
      sdk.forkSession.mockClear()
      sdk.getSessionMessages.mockResolvedValue([{ type: 'user', uuid: 'different-user' }])
      await expect(createQoderAdapter().forkSession!.fork(request)).rejects.toThrow('不在原生活动分支')
      expect(sdk.forkSession).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.QODER_CONFIG_DIR
      else process.env.QODER_CONFIG_DIR = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forks Qoder after the selected completed turn', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'prompt-1' },
      { type: 'assistant', uuid: 'assistant-1' },
      { type: 'user', uuid: 'prompt-2' },
      { type: 'assistant', uuid: 'assistant-2' }
    ])
    sdk.forkSession.mockResolvedValue({ sessionId: 'session-branched' })

    await expect(createQoderAdapter().forkSession!.fork({
      providerId: 'qoder',
      sourceSessionId: 'session-source',
      sourceRunId: 'run-1',
      sourceProviderTurnId: 'qoder-turn-1',
      sourceForkTurnId: 'prompt-1',
      cwd: '/repo'
    })).resolves.toEqual({ externalSessionId: 'session-branched' })
    expect(sdk.forkSession).toHaveBeenCalledWith('session-source', {
      dir: '/repo',
      upToMessageId: 'assistant-1',
      title: 'Scry branch'
    })
  })

  it('用 transcript user content 回退定位旧 archive 中没有 forkTurnId 的 Qoder prompt', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'prompt-previous', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', uuid: 'assistant-previous', message: { role: 'assistant', content: [] } },
      { type: 'user', uuid: 'native-prompt-last', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }] } },
      { type: 'assistant', uuid: 'assistant-last', message: { role: 'assistant', content: [] } }
    ])
    sdk.forkSession.mockResolvedValue({ sessionId: 'session-forked' })

    await expect(createQoderAdapter().forkLastTurn!.fork({
      sourceSessionId: 'session-source',
      originalPrompt: 'old prompt',
      replaceRunId: 'run-last',
      replaceProviderTurnId: 'legacy-prompt-id',
      replaceForkTurnId: 'legacy-prompt-id',
      previousProviderTurnId: 'previous-prompt-id',
      previousForkTurnId: 'previous-prompt-id',
      cwd: '/repo'
    })).resolves.toEqual({ externalSessionId: 'session-forked' })
    expect(sdk.forkSession).toHaveBeenCalledWith('session-source', {
      dir: '/repo',
      upToMessageId: 'assistant-previous',
      title: 'Edited branch'
    })
  })

  it('reports the SDK Skill catalog as read-only rather than unsupported', async () => {
    await expect(createQoderAdapter().describe()).resolves.toMatchObject({
      id: 'qoder',
      label: 'Qoder',
      transport: 'Qoder Agent SDK',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
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

  it('discovers project-only .mcp.json and reflects deletion without stale Qoder results', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-qoder-project-mcp-test-'))
    const cwd = join(home, 'repo')
    const projectConfig = join(cwd, '.mcp.json')
    await mkdir(join(home, '.qoder'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(join(home, '.qoder', 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    await writeFile(projectConfig, JSON.stringify({
      mcpServers: {
        arthas: { type: 'http', url: 'https://mcp.example.test/arthas' },
        trace: { type: 'sse', url: 'https://mcp.example.test/trace' }
      }
    }))
    try {
      const adapter = createQoderAdapter(home)
      await expect(adapter.mcp!.snapshot({ providerId: 'qoder', cwd })).resolves.toMatchObject({
        state: 'degraded',
        data: {
          configured: [
            expect.objectContaining({ name: 'arthas', scope: 'project', transport: 'http' }),
            expect.objectContaining({ name: 'trace', scope: 'project', transport: 'http' })
          ]
        }
      })

      await rm(projectConfig)
      await expect(adapter.mcp!.snapshot({ providerId: 'qoder', cwd })).resolves.toMatchObject({
        state: 'degraded',
        data: { configured: [], runtime: null }
      })
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

  it('enables .agents compatibility skills and reads the modern initialization catalog', async () => {
    const initialization = {
      skills: [{
        name: 'kami',
        description: 'Typeset polished documents',
        source: 'project',
        path: '/repo/.agents/skills/kami/SKILL.md'
      }]
    }
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue(initialization),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          count: 1,
          items: [{ name: 'kami', source: 'project', percentageOfContext: 0 }]
        }
      }),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'kanban', description: 'Show kanban items', argumentHint: '' },
        { name: 'kami', description: 'Typeset polished documents', argumentHint: '' }
      ]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    await expect(adapter.skills!.list(context)).resolves.toMatchObject({
      state: 'ready',
      data: [{
        name: 'kami',
        dir: '/repo/.agents/skills/kami/SKILL.md',
        scope: 'project',
        description: 'Typeset polished documents',
        enabled: true
      }]
    })
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      state: 'ready',
      data: expect.arrayContaining([expect.objectContaining({ name: 'kami', source: 'skill' })])
    })
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        settings: { skills: { loadFromAgentsDirectory: true } }
      })
    }))
    await adapter.dispose?.()
  })

  it('keeps conflicting legacy and modern totals degraded instead of hiding missing Skills', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        skills: [{ name: 'one', description: 'One Skill', source: 'project' }]
      }),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          totalSkills: 0,
          includedSkills: 1,
          count: 3,
          items: [{ name: 'one', source: 'project' }]
        }
      }),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'one', description: 'One Skill', argumentHint: '' }
      ]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    await expect(adapter.skills!.list(context)).resolves.toMatchObject({
      state: 'degraded',
      reason: expect.stringContaining('1/3'),
      data: [expect.objectContaining({ name: 'one', dir: '', scope: 'project' })]
    })
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      state: 'degraded',
      reason: expect.stringContaining('1/3'),
      data: [expect.objectContaining({ name: 'one', source: 'skill' })]
    })
    await adapter.dispose?.()
  })

  it('invalidates same-cwd control and catalog caches for a new session', async () => {
    const control = (name: string) => ({
      initializationResult: vi.fn().mockResolvedValue({
        skills: [{ name, description: `${name} description`, source: 'project' }]
      }),
      getContextUsage: vi.fn().mockResolvedValue({ skills: { count: 1, items: [{ name, source: 'project' }] } }),
      supportedCommands: vi.fn().mockResolvedValue([{ name, description: `${name} description`, argumentHint: '' }]),
      close: sdk.close
    })
    sdk.query.mockReturnValueOnce(control('old-skill')).mockReturnValueOnce(control('new-skill'))
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    await expect(adapter.commands!.list(context)).resolves.toMatchObject({ data: [expect.objectContaining({ name: 'old-skill' })] })
    await adapter.invalidateContext?.(context)
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({ data: [expect.objectContaining({ name: 'new-skill' })] })

    expect(sdk.query).toHaveBeenCalledTimes(2)
    expect(sdk.close).toHaveBeenCalled()
    await adapter.dispose?.()
  })

  it('does not let an in-flight pre-invalidation catalog read refill Qoder caches', async () => {
    let resolveOldUsage: (usage: unknown) => void = () => {}
    const oldUsage = new Promise((resolve) => { resolveOldUsage = resolve })
    const control = (name: string, usage: Promise<unknown>) => ({
      initializationResult: vi.fn().mockResolvedValue({
        skills: [{ name, description: `${name} description`, source: 'project' }]
      }),
      getContextUsage: vi.fn().mockReturnValue(usage),
      supportedCommands: vi.fn().mockResolvedValue([{ name, description: `${name} description`, argumentHint: '' }]),
      close: sdk.close
    })
    sdk.query
      .mockReturnValueOnce(control('stale-skill', oldUsage))
      .mockReturnValueOnce(control('fresh-skill', Promise.resolve({
        skills: { count: 1, items: [{ name: 'fresh-skill', source: 'project' }] }
      })))
    const adapter = createQoderAdapter()
    const context = { providerId: 'qoder' as const, cwd: '/repo' }

    const staleRead = adapter.commands!.list(context)
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
    await adapter.invalidateContext?.(context)
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'fresh-skill' })]
    })
    resolveOldUsage({ skills: { count: 1, items: [{ name: 'stale-skill', source: 'project' }] } })
    await expect(staleRead).resolves.toMatchObject({ data: [expect.objectContaining({ name: 'stale-skill' })] })
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'fresh-skill' })]
    })
    expect(sdk.query).toHaveBeenCalledTimes(2)
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
    expect(sdk.runtimeCliEnv).toHaveBeenCalledWith(undefined, { providerId: 'qoder' })
    expect(sdk.query.mock.calls[0][0].options.env).toMatchObject({
      QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
    })
  })

  it('uses Qoder control context usage instead of the zero SDK model window', async () => {
    const getContextUsage = vi.fn().mockResolvedValue({
      totalTokens: 103_176,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 10.3176,
      model: 'ultimate'
    })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 31_803, output_tokens: 301 },
          modelUsage: {
            ultimate: { inputTokens: 103_176, outputTokens: 301, contextWindow: 0 }
          }
        }
      },
      getContextUsage,
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    await createQoderAdapter().run({
      runId: 'run-context', prompt: 'work', attachments: [], emit: (event) => events.push(event)
    }).promise

    expect(getContextUsage).toHaveBeenCalledOnce()
    expect(events.find((event) => event.kind === 'harness')).toMatchObject({
      contextTokens: 103_176,
      contextModel: 'ultimate',
      contextUsageSource: 'qoder_control',
      contextUsageQuality: 'exact',
      modelUsage: [expect.objectContaining({ model: 'ultimate', contextWindow: 1_000_000 })],
      runtimeMetadata: expect.objectContaining({
        contextUsagePercentage: 10.3176,
        rawContextWindow: 1_000_000
      })
    })
  })

  it('uses Qoder input_tokens without double-counting cache when control context is unavailable', async () => {
    const getContextUsage = vi.fn().mockRejectedValue(new Error('control unavailable'))
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 103_176,
            cache_read_input_tokens: 103_046,
            output_tokens: 301
          },
          modelUsage: {
            ultimate: {
              inputTokens: 103_176,
              cacheReadInputTokens: 103_046,
              outputTokens: 301,
              contextWindow: 0
            }
          }
        }
      },
      getContextUsage,
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    await createQoderAdapter().run({
      runId: 'run-context-fallback', prompt: 'work', attachments: [], emit: (event) => events.push(event)
    }).promise

    expect(getContextUsage).toHaveBeenCalledOnce()
    expect(events.find((event) => event.kind === 'harness')).toMatchObject({
      contextTokens: 103_176,
      contextModel: 'ultimate',
      contextProvider: 'qoder',
      contextUsageSource: 'qoder_sdk_usage',
      contextUsageQuality: 'exact',
      modelUsage: [expect.objectContaining({ model: 'ultimate', contextWindow: 0 })]
    })
  })

  it('enriches archived Qoder context from native usage ratio as inferred window evidence', async () => {
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
      message: {
        model: 'ultimate',
        usage: { input_tokens: 103_176, cache_read_input_tokens: 103_046, context_usage_ratio: 0.103176 }
      }
    }])
    const adapter = createQoderAdapter()
    const turns = await adapter.sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [{
        userText: 'work',
        items: [{
          id: 'result-1', runId: 'run-history', ts: '2026-09-03T03:00:12.000Z',
          kind: 'harness', stage: 'result', contextTokens: 31_803,
          modelUsage: [{ model: 'ultimate', contextWindow: 0 }]
        }]
      }]
    )

    expect(turns[0].items[0]).toMatchObject({
      contextTokens: 103_176,
      contextModel: 'ultimate',
      contextUsageSource: 'qoder_native_transcript',
      contextUsageQuality: 'inferred',
      modelUsage: [{ model: 'ultimate', contextWindow: 1_000_000 }],
      runtimeMetadata: expect.objectContaining({
        contextUsagePercentage: 10.3176
      })
    })
  })

  it('pairs adjacent archived turns with disjoint native usage intervals', async () => {
    sdk.getSessionMessages.mockResolvedValue([
      {
        type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
        message: { model: 'ultimate', usage: { input_tokens: 100_000, context_usage_ratio: 0.1 } }
      },
      {
        type: 'assistant', timestamp: '2026-09-03T03:00:20.000Z',
        message: { model: 'ultimate', usage: { input_tokens: 200_000, context_usage_ratio: 0.2 } }
      }
    ])
    const result = (id: string, ts: string): TraceEvent => ({
      id, runId: id, ts, kind: 'harness', stage: 'result', modelUsage: [{ model: 'ultimate', contextWindow: 0 }]
    })

    const turns = await createQoderAdapter().sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [
        { userText: 'one', items: [result('one', '2026-09-03T03:00:12.000Z')] },
        { userText: 'two', items: [result('two', '2026-09-03T03:00:22.000Z')] }
      ]
    )

    expect(turns.map((turn) => turn.items[0].contextTokens)).toEqual([100_000, 200_000])
  })

  it('keeps complete archived context and does not attach evidence to a different model', async () => {
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
      message: { model: 'ultimate', usage: { input_tokens: 100_000, context_usage_ratio: 0.1 } }
    }])
    const adapter = createQoderAdapter()
    const turns = await adapter.sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [{
        userText: 'work',
        items: [
          {
            id: 'exact', runId: 'run-history', ts: '2026-09-03T03:00:11.000Z', kind: 'harness', stage: 'result',
            contextTokens: 50_000, contextUsageQuality: 'exact', modelUsage: [{ model: 'performance', contextWindow: 200_000 }]
          },
          {
            id: 'mismatch', runId: 'run-history', ts: '2026-09-03T03:00:12.000Z', kind: 'harness', stage: 'result',
            modelUsage: [{ model: 'performance', contextWindow: 0 }]
          }
        ]
      }]
    )

    expect(turns[0].items[0]).toMatchObject({
      contextTokens: 50_000,
      contextUsageQuality: 'exact',
      modelUsage: [{ model: 'performance', contextWindow: 200_000 }]
    })
    expect(turns[0].items[1]).toMatchObject({
      contextTokens: 100_000,
      modelUsage: [
        { model: 'performance', contextWindow: 0 },
        { model: 'ultimate', contextWindow: 1_000_000 }
      ]
    })
  })

  it('does not attach model-less Qoder context evidence to the first row of a multi-model result', async () => {
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'assistant', timestamp: '2026-09-03T03:00:10.000Z',
      message: { usage: { input_tokens: 100_000, context_usage_ratio: 0.1 } }
    }])
    const turns = await createQoderAdapter().sessionEvidence!.enrich(
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-1' },
      [{
        userText: 'work',
        items: [{
          id: 'multi', runId: 'run-history', ts: '2026-09-03T03:00:12.000Z',
          kind: 'harness', stage: 'result',
          modelUsage: [{ model: 'performance' }, { model: 'ultimate' }]
        }]
      }]
    )

    expect(turns[0].items[0]).toMatchObject({
      contextTokens: 100_000,
      contextModel: undefined,
      contextUsageQuality: 'inferred',
      modelUsage: [{ model: 'performance' }, { model: 'ultimate' }]
    })
  })

  it('keeps the Qoder input stream open until background Agents settle and the root responds again', async () => {
    let inputReleasedBeforeTerminal = false
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        yield {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use', id: 'agent-1', name: 'local_agent',
              input: { description: 'inspect', run_in_background: true }
            }]
          }
        }
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'launched' }] },
          tool_use_result: { status: 'async_launched', taskId: 'task-1' }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1' }
        yield { type: 'result', subtype: 'success', result: 'waiting' }
        const inputDone = input.next().then(() => { inputReleasedBeforeTerminal = true })
        await Promise.resolve()
        expect(inputReleasedBeforeTerminal).toBe(false)
        yield { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'done' }
        yield { type: 'result', subtype: 'success', result: 'all done' }
        await inputDone
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const events: TraceEvent[] = []

    const result = await createQoderAdapter().run({
      runId: 'run-background-agent',
      prompt: 'delegate',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(result.status).toBe('completed')
    expect(inputReleasedBeforeTerminal).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'agent', tool: 'Agent', toolUseId: 'agent-1'
    }))
    expect(events.filter((event) => event.tool === 'Agent' && event.stage === 'tool_result' && event.runtimeMetadata?.agentStatus === 'completed')).toHaveLength(1)
  })

  it.each(['text', 'task_updated'] as const)('releases Qoder stdin after a %s terminal and ignores late Agent progress', async (wire) => {
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { run_in_background: true } }] }
        }
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'launched' }] },
          tool_use_result: { status: 'async_launched', agentId: 'explore-1' }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1' }
        // Qoder 1.1.41 sends completion as a synthetic user message, then flushes
        // queued progress/task_updated messages just before the root result.
        yield wire === 'text'
          ? {
              type: 'user', isSynthetic: true, parent_tool_use_id: null,
              message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>agent-1</tool-use-id>\n<output-file>/tmp/not-read.output</output-file>\n<status>completed</status>\n<summary>Agent "inspect" finished</summary>\n<result>Read-only findings</result>\n</task-notification>' }] }
            }
          : { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } }
        yield { type: 'system', subtype: 'task_progress', task_id: 'task-1', tool_use_id: 'agent-1' }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } }
        yield { type: 'result', subtype: 'success', result: 'all done' }
        // Model a live CLI: receiving result is not enough to end the iterator.
        expect(await input.next()).toMatchObject({ done: true })
        yield { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-qoder-wire', prompt: 'delegate', attachments: [], emit: (event) => events.push(event)
    }).promise

    expect(result.status).toBe('completed')
    const terminals = events.filter((event) => event.tool === 'Agent' && event.runtimeMetadata?.agentStatus === 'completed')
    expect(terminals).toHaveLength(1)
    expect(terminals[0].runtimeMetadata?.source).toBe(wire === 'text' ? 'qoder_task_notification_text' : 'qoder_task_updated')
    expect(events.slice(events.indexOf(terminals[0]) + 1).some((event) => event.stage === 'agent_activity')).toBe(false)
  })

  it('does not release stdin while another Qoder Agent is unresolved or before the next root result', async () => {
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        let released = false
        const done = input.next().then(() => { released = true })
        for (const id of ['one', 'two']) {
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id, input: { run_in_background: true } }] } }
          yield { type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: id }
        }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-one', patch: { status: 'completed' } }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-two', patch: { status: 'future_status' } }
        yield { type: 'system', subtype: 'task_updated', task_id: 'unrelated', patch: { status: 'completed' } }
        yield { type: 'result', subtype: 'success', result: 'waiting for two' }
        await Promise.resolve()
        expect(released).toBe(false)
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-two', patch: { status: 'completed' } }
        await Promise.resolve()
        expect(released).toBe(false)
        yield { type: 'result', subtype: 'success', result: 'all done' }
        await done
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    await expect(createQoderAdapter().run({ runId: 'two-agents', prompt: 'delegate', attachments: [], emit: () => {} }).promise)
      .resolves.toMatchObject({ status: 'completed' })
  })

  it('closes every tracked background Agent as stopped when Scry interrupts before notifications arrive', async () => {
    let rootSeen!: () => void
    const root = new Promise<void>((resolve) => { rootSeen = resolve })
    sdk.query.mockImplementation(({ options }) => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'agent-stop', name: 'Agent', input: { run_in_background: true } }] }
        }
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'agent-stop', content: 'launched' }] },
          tool_use_result: { status: 'async_launched', taskId: 'task-stop' }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-stop', tool_use_id: 'agent-stop' }
        yield { type: 'result', subtype: 'success', result: 'waiting' }
        rootSeen()
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const events: TraceEvent[] = []
    const handle = createQoderAdapter().run({
      runId: 'run-interrupted-agent',
      prompt: 'delegate',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await root
    // qoderPid 是本轮 spawn 的 CLI 进程树：硬杀仅限本 run。
    expect(handle.forceKillScope).toBe('run_scoped')
    handle.interrupt()
    await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
    expect(events.filter((event) => event.tool === 'Agent' && event.stage === 'tool_result')).toContainEqual(expect.objectContaining({
      toolUseId: 'agent-stop',
      isError: false,
      runtimeMetadata: expect.objectContaining({ source: 'qoder_host_interruption', agentStatus: 'stopped' })
    }))
  })

  it('fails the run instead of leaving unknown when Qoder transport ends with an active local Agent', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'agent-lost', name: 'Agent', input: { run_in_background: true } }] }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-lost', tool_use_id: 'agent-lost' }
        yield { type: 'result', subtype: 'success', result: 'waiting' }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    const result = await createQoderAdapter().run({
      runId: 'run-lost-agent', prompt: 'delegate', attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(result.status).toBe('failed')
    expect(events).toContainEqual(expect.objectContaining({
      tool: 'Agent', stage: 'tool_result', toolUseId: 'agent-lost', isError: true,
      runtimeMetadata: expect.objectContaining({ source: 'qoder_transport_ended', agentStatus: 'failed' })
    }))
  })

  it('managed Qoder 返回 native promptId、fork message id 与失败状态，并只在显式启用时注入 managed 环境', async () => {
    sdk.runtimeCliEnv.mockImplementation((_base?: Record<string, string>, options: { managedRecorder?: boolean } = {}) =>
      options?.managedRecorder ? {
        SCRY_RECORDER_MANAGED: '1',
        SCRY_MANAGED_RUN_ID: 'stale-run',
        SCRY_MANAGED_PROMPT_HASH: 'b'.repeat(64)
      } : {}
    )
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'user',
      uuid: 'qoder-user-message',
      session_id: 'qoder-session',
      message: { role: 'user', content: 'work' },
      parent_tool_use_id: null,
      parent_agent_id: null
    }])
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
      managedRecorderIdentity: {
        runId: 'run-managed',
        promptHash: 'a'.repeat(64)
      },
      emit: vi.fn()
    })

    await expect(handle.promise).resolves.toMatchObject({
      externalSessionId: 'qoder-session',
      providerTurnId: 'qoder-turn',
      forkTurnId: 'qoder-user-message',
      status: 'failed'
    })
    expect(handle.getProviderTurnId?.()).toBe('qoder-turn')
    expect(handle.getForkTurnId?.()).toBe('qoder-user-message')
    expect(sdk.query.mock.calls[0][0].options.env).toMatchObject({
      SCRY_RECORDER_MANAGED: '1',
      SCRY_MANAGED_RUN_ID: 'run-managed',
      SCRY_MANAGED_PROMPT_HASH: 'a'.repeat(64)
    })
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

  it('把真实 Qoder 批量取消日志回写为四个 Agent stopped 终态', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'scry-qoder-agent-cancel-test-'))
    const runLogDir = join(configDir, 'logs', 'runs', 'run-p127')
    await mkdir(runLogDir, { recursive: true })
    await writeFile(join(runLogDir, 'qodercli.log'), [
      ...['a', 'b', 'c', 'd'].map((id, index) =>
        `2026-09-01T18:21:08.0${44 + index}+08:00 ERROR debug.message [SubagentRun] error agentId=agent-${id} taskId=task-${id} sessionId=qoder-session parentToolUseId=agent-${id} Error [AbortError]: Operation cancelled by user`
      ),
      '2026-09-01T18:21:08.360+08:00 WARN  process.exiting exit_code=143 reason="signal_term" message="SIGTERM received"'
    ].join('\n'))
    const previousConfigDir = process.env.QODER_CONFIG_DIR
    process.env.QODER_CONFIG_DIR = configDir
    try {
      const child = Object.assign(new EventEmitter(), { pid: 127, kill: vi.fn() })
      sdk.spawn.mockReturnValue(child)
      sdk.query.mockImplementation(({ options }) => {
        options.spawnQoderCLIProcess({
          command: '/bin/qodercli', args: [], cwd: '/repo', env: {}, signal: new AbortController().signal
        })
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'assistant', session_id: 'qoder-session',
              message: {
                content: ['a', 'b', 'c', 'd'].map((id) => ({
                  type: 'tool_use', id: `agent-${id}`, name: 'Agent', input: { run_in_background: true }
                }))
              }
            }
            for (const id of ['a', 'b', 'c', 'd']) {
              yield { type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: `agent-${id}` }
            }
            // A real SDK terminal for one child must win over the duplicate log line.
            yield { type: 'system', subtype: 'task_notification', task_id: 'task-a', status: 'stopped', summary: 'stopped' }
            yield { type: 'result', subtype: 'success', session_id: 'qoder-session', result: 'waiting' }
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })
      const events: TraceEvent[] = []

      const result = await createQoderAdapter().run({
        runId: 'run-four-cancelled-agents', prompt: 'delegate four', cwd: '/repo', attachments: [],
        emit: (event) => events.push(event)
      }).promise

      expect(result.status).toBe('failed')
      const terminals = events.filter((event) => event.tool === 'Agent' && event.stage === 'tool_result')
      expect(terminals).toHaveLength(4)
      expect(terminals.map((event) => [event.toolUseId, event.runtimeMetadata?.agentStatus])).toEqual([
        ['agent-a', 'stopped'], ['agent-b', 'stopped'], ['agent-c', 'stopped'], ['agent-d', 'stopped']
      ])
      expect(terminals.map((event) => event.runtimeMetadata?.source)).toEqual([
        'provider_task_notification', 'qoder_cli_log', 'qoder_cli_log', 'qoder_cli_log'
      ])
      expect(terminals.every((event) => event.isError === false)).toBe(true)
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
      let capturedPrompt: AsyncIterable<Record<string, unknown>> | undefined
      sdk.query.mockImplementation(({ prompt }) => {
        capturedPrompt = prompt
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
      const promptIterator = capturedPrompt![Symbol.asyncIterator]()
      await expect(promptIterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'user', message: { content: [{ type: 'text', text: expanded }] } }
      })
      await expect(promptIterator.next()).resolves.toMatchObject({ done: true })
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

  it('按 duration 对齐并发同名 Hook，不把乱序完成状态归给错误脚本', () => {
    const log = [
      '2026-07-11T11:24:25.363+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="project" hook_index=1 display_text="slow-project-hook"',
      '2026-07-11T11:24:25.500+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="user" hook_index=2 display_text="fast-user-hook"',
      '2026-07-11T11:24:26.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=true duration_ms=500 exit_code=0',
      '2026-07-11T11:24:27.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=false duration_ms=1637 exit_code=1'
    ].join('\n')

    const responses = parseQoderHookLog('run-1', log, 's1').filter((event) => event.stage === 'hook_response')

    expect(responses).toEqual([
      expect.objectContaining({ hookCommand: 'fast-user-hook', hookOutcome: 'success' }),
      expect.objectContaining({ hookCommand: 'slow-project-hook', hookOutcome: 'error', isError: true })
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

  it('recovers cancelled and failed Qoder subagent terminals from the process log', () => {
    const log = [
      '2026-09-01T18:21:08.044+08:00 ERROR debug.message [SubagentRun] error agentId=agent-a taskId=task-a sessionId=s1 parentToolUseId=agent-call-a Error [AbortError]: Operation cancelled by user',
      '2026-09-01T18:21:08.045+08:00 ERROR debug.message [SubagentRun] error agentId=agent-b taskId=task-b sessionId=s1 parentToolUseId=agent-call-b Error: writer failed',
      '2026-09-01T18:21:08.046+08:00 ERROR debug.message [SubagentRun] error agentId=agent-c taskId=task-c sessionId=other parentToolUseId=agent-call-c Error [AbortError]: Operation cancelled by user'
    ].join('\n')

    expect(parseQoderSubagentTerminals('run-1', log, 's1')).toEqual([
      expect.objectContaining({
        tool: 'Agent', toolUseId: 'agent-call-a', isError: false,
        runtimeMetadata: expect.objectContaining({ agentStatus: 'stopped', taskId: 'task-a', qoderAgentId: 'agent-a' })
      }),
      expect.objectContaining({
        tool: 'Agent', toolUseId: 'agent-call-b', isError: true,
        runtimeMetadata: expect.objectContaining({ agentStatus: 'failed', taskId: 'task-b', qoderAgentId: 'agent-b' })
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
