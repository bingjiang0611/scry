import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const runner = vi.hoisted(() => ({ captureInit: vi.fn(), runAgent: vi.fn() }))
const mcp = vi.hoisted(() => ({ listMcp: vi.fn(), testMcpConfig: vi.fn() }))
const sdk = vi.hoisted(() => ({ query: vi.fn() }))
const locate = vi.hoisted(() => ({ runtimeCliEnv: vi.fn() }))
const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  execFile: childProcess.execFile
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))
vi.mock('../agent-runner', () => ({ captureInit: runner.captureInit, getClaudeVersion: () => 'test', runAgent: runner.runAgent }))
vi.mock('../claude-locate', () => ({
  resolveClaudeBin: () => '/bin/claude',
  runtimeCliEnv: locate.runtimeCliEnv
}))
vi.mock('../mcp-config', async () => {
  const actual = await vi.importActual<typeof import('../mcp-config')>('../mcp-config')
  return {
    ...actual,
    findMcpConfigByTargetId: () => ({ config: { command: '/bin/mcp' } }),
    listMcp: mcp.listMcp,
    testMcpConfig: mcp.testMcpConfig,
    toggleMcp: vi.fn()
  }
})
vi.mock('../skill-config', () => ({
  computeEnabledSkills: () => ['scry-e2e-audit'],
  listSkills: () => [{ name: 'scry-e2e-audit', dir: 'scry-e2e-audit', scope: 'project', description: 'Safe audit', enabled: true }],
  setSkillEnabled: vi.fn()
}))

import { claudeMcpLoginArgs, createClaudeAdapter, runClaudeMcpLogin } from './claude'

describe('claudeMcpLoginArgs', () => {
  beforeEach(() => {
    childProcess.execFile.mockReset()
  })

  it('loads only the temporary config before terminating options for an untrusted MCP server name', () => {
    expect(claudeMcpLoginArgs('--help', '/tmp/auth.json')).toEqual([
      '--mcp-config', '/tmp/auth.json', '--strict-mcp-config', 'mcp', 'login', '--', '--help'
    ])
  })

  it('rejects control characters in an MCP server name', () => {
    expect(() => claudeMcpLoginArgs('remote\nname', '/tmp/auth.json')).toThrow('无效字符')
  })

  it('writes one exact target to a private temporary config and always removes it', async () => {
    let observedPath = ''
    let observedConfig: unknown
    let observedMode = 0
    let observedDirectoryMode = 0
    childProcess.execFile.mockImplementation((
      _executable: unknown,
      cliArgs: string[],
      options: { shell?: boolean },
      callback: (error: Error | null) => void
    ) => {
      observedPath = cliArgs[1]
      observedConfig = JSON.parse(readFileSync(observedPath, 'utf8'))
      observedMode = statSync(observedPath).mode & 0o777
      observedDirectoryMode = statSync(dirname(observedPath)).mode & 0o777
      expect(options.shell).toBe(false)
      callback(null)
      return {} as never
    })

    await expect(runClaudeMcpLogin(
      '/bin/claude',
      'remote',
      { type: 'http', url: 'https://exact.example.test/mcp', headers: { Authorization: 'Bearer config-secret' } },
      '/repo',
      { PATH: '/runtime/bin' }
    )).resolves.toEqual({ ok: true, status: 'authenticated' })

    expect(observedConfig).toEqual({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://exact.example.test/mcp',
          headers: { Authorization: 'Bearer config-secret' }
        }
      }
    })
    expect(observedMode).toBe(0o600)
    expect(observedDirectoryMode).toBe(0o700)
    expect(childProcess.execFile).toHaveBeenCalledWith(
      '/bin/claude',
      ['--mcp-config', observedPath, '--strict-mcp-config', 'mcp', 'login', '--', 'remote'],
      expect.objectContaining({ cwd: '/repo', env: { PATH: '/runtime/bin' }, shell: false }),
      expect.any(Function)
    )
    expect(existsSync(observedPath)).toBe(false)
  })

  it('removes the private temporary config after a redacted CLI failure', async () => {
    let observedPath = ''
    childProcess.execFile.mockImplementation((
      _executable: unknown,
      cliArgs: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      observedPath = cliArgs[1]
      callback(new Error('Authorization: Bearer cli-secret'))
      return {} as never
    })

    const result = await runClaudeMcpLogin(
      '/bin/claude',
      'remote',
      { type: 'http', url: 'https://exact.example.test/mcp' },
      '/repo',
      { PATH: '/runtime/bin' }
    )

    expect(result).toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('[redacted]') })
    expect(result.error).not.toContain('cli-secret')
    expect(existsSync(observedPath)).toBe(false)
  })
})

describe('Claude provider adapter', () => {
  beforeEach(() => {
    runner.captureInit.mockReset()
    runner.runAgent.mockReset()
    mcp.listMcp.mockReset().mockReturnValue([
      { targetId: 'target-scry-e2e', name: 'scry-e2e', scope: '.mcp.json', transport: 'stdio', detail: '/bin/mcp', enabled: true }
    ])
    mcp.testMcpConfig.mockReset()
    sdk.query.mockReset()
    locate.runtimeCliEnv.mockReset().mockImplementation((_base, options) => ({
      PATH: '/runtime/bin',
      ANTHROPIC_API_KEY: 'provider-auth',
      UNAPPROVED_SECRET: 'runtime-secret',
      HTTPS_PROXY: 'http://provider-user:provider-secret@proxy.example.test',
      SSL_CERT_FILE: '/runtime/provider-ca.pem',
      ...(options?.managedRecorder ? {
        SCRY_RECORDER_MANAGED: '1',
        SCRY_RECORDER_REQUIRED_VERSION: 'test'
      } : {})
    }))
    delete process.env.SCRY_CLAUDE_SETTING_SOURCES
  })

  it('keeps Claude capabilities explicit', async () => {
    await expect(createClaudeAdapter('/tmp/scry-home').describe()).resolves.toMatchObject({
      id: 'claude',
      runtimeProvider: 'claude_sdk',
      capabilities: { skills: 'manage', mcp: 'manage', commands: 'read', account: 'none' }
    })
  })

  it('lists native slash commands through the existing control transport without a model prompt', async () => {
    sdk.query.mockReturnValue({
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'usage', description: 'Show usage', argumentHint: '' },
        { name: 'scry-e2e-audit', description: 'Safe audit', argumentHint: '<path>' }
      ]),
      close: vi.fn()
    })
    const result = await createClaudeAdapter('/tmp/scry-home').commands!.list({ providerId: 'claude', cwd: '/repo' })
    expect(result).toMatchObject({
      state: 'ready',
      data: [
        { name: 'usage', source: 'builtin' },
        { name: 'scry-e2e-audit', argumentHint: '<path>', source: 'skill' }
      ]
    })
    expect(runner.captureInit).not.toHaveBeenCalled()
  })

  it('keeps the declared read mode when the native command catalog is temporarily unavailable', async () => {
    sdk.query.mockReturnValue({
      supportedModels: vi.fn().mockRejectedValue(new Error('control process stopped')),
      supportedCommands: vi.fn().mockResolvedValue([]),
      close: vi.fn()
    })
    const result = await createClaudeAdapter('/tmp/scry-home').commands!.list({ providerId: 'claude', cwd: '/repo' })

    expect(result).toMatchObject({
      mode: 'read',
      state: 'unknown',
      data: null,
      reason: 'control process stopped'
    })
  })

  it('refreshes MCP status through the native SDK without a model prompt', async () => {
    const close = vi.fn()
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      mcpServerStatus: vi.fn().mockResolvedValue([{
        name: 'scry-e2e',
        status: 'connected',
        tools: [{ name: 'one' }, { name: 'two' }, { name: 'three' }]
      }]),
      close
    })
    const result = await createClaudeAdapter('/tmp/scry-home').mcp!.snapshot(
      { providerId: 'claude', cwd: '/repo' },
      true,
      {
        cwd: '/repo',
        fingerprint: 'sha256:snapshot',
        env: {},
        targets: [{ targetId: 'target-scry-e2e', name: 'scry-e2e', enabled: true, config: { command: '/bin/mcp' } }]
      }
    )
    expect(result).toMatchObject({
      state: 'ready',
      data: { runtime: [{ name: 'scry-e2e', status: 'connected', tools: 3 }] }
    })
    expect(mcp.testMcpConfig).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect(runner.captureInit).not.toHaveBeenCalled()
  })

  it('redacts credentials from native MCP refresh failures', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockRejectedValue(new Error('Authorization: Bearer refresh-secret')),
      close: vi.fn()
    })

    const result = await createClaudeAdapter('/tmp/scry-home').mcp!.snapshot(
      { providerId: 'claude', cwd: '/repo' },
      true,
      {
        cwd: '/repo', fingerprint: 'sha256:snapshot', env: {},
        targets: [{ targetId: 'target-scry-e2e', name: 'scry-e2e', enabled: true, config: { command: '/bin/mcp' } }]
      }
    )

    expect(result.reason).toContain('[redacted]')
    expect(result.reason).not.toContain('refresh-secret')
  })

  it('logs in the exact remote MCP and verifies the native status before reporting success', async () => {
    mcp.listMcp.mockReturnValue([
      { targetId: 'remote-target', name: 'remote', scope: '.mcp.json', transport: 'http', detail: 'https://mcp.example.test', enabled: true }
    ])
    const close = vi.fn()
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      mcpServerStatus: vi.fn().mockResolvedValue([{ name: 'remote', status: 'connected', tools: [] }]),
      close
    })
    const login = vi.fn().mockResolvedValue({ ok: true, status: 'authenticated' as const })
    const adapter = createClaudeAdapter('/tmp/scry-home', login)
    const execution = {
      cwd: '/repo',
      fingerprint: 'sha256:remote',
      env: {},
      targets: [{
        targetId: 'remote-target',
        name: 'remote',
        enabled: true,
        config: { type: 'http', url: 'https://mcp.example.test' }
      }]
    }

    await expect(adapter.mcp!.snapshot({ providerId: 'claude', cwd: '/repo' })).resolves.toMatchObject({
      data: { operations: { authenticate: ['remote-target'] } }
    })
    await expect(adapter.mcp!.reauthenticate?.(
      { providerId: 'claude', cwd: '/repo' },
      'remote-target',
      execution,
      { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
    )).resolves.toMatchObject({
      state: 'ready',
      data: { ok: true, status: 'authenticated' }
    })
    expect(login).toHaveBeenCalledWith(
      '/bin/claude',
      'remote',
      { type: 'http', url: 'https://mcp.example.test' },
      '/repo',
      expect.objectContaining({ CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1' })
    )
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        cwd: '/repo',
        strictMcpConfig: true,
        mcpServers: { remote: { type: 'http', url: 'https://mcp.example.test' } }
      })
    }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports completed Claude authentication separately when native verification times out', async () => {
    mcp.listMcp.mockReturnValue([
      { targetId: 'remote-target', name: 'remote', scope: '.mcp.json', transport: 'http', detail: 'https://mcp.example.test', enabled: true }
    ])
    const close = vi.fn()
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      mcpServerStatus: vi.fn(() => new Promise(() => {})),
      close
    })
    const adapter = createClaudeAdapter(
      '/tmp/scry-home',
      vi.fn().mockResolvedValue({ ok: true, status: 'authenticated' as const })
    )
    vi.useFakeTimers()
    try {
      const result = adapter.mcp!.reauthenticate!(
        { providerId: 'claude', cwd: '/repo' },
        'remote-target',
        {
          cwd: '/repo', fingerprint: 'sha256:remote', env: {},
          targets: [{
            targetId: 'remote-target', name: 'remote', enabled: true,
            config: { type: 'http', url: 'https://mcp.example.test' }
          }]
        },
        { openExternal: vi.fn(), prepareLoopbackCallback: vi.fn() }
      )
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(result).resolves.toMatchObject({
        data: {
          ok: false,
          status: 'authenticated-unverified',
          error: expect.stringContaining('状态校验超时')
        }
      })
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards an explicit setting-source allowlist without changing the default', async () => {
    process.env.SCRY_CLAUDE_SETTING_SOURCES = 'project,local'
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({}),
      interrupt: vi.fn(),
      getSessionId: vi.fn()
    })

    createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-1',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      model: { id: 'claude-test' },
      effort: 'high',
      permissionMode: 'default',
      emit: vi.fn()
    })

    expect(runner.runAgent).toHaveBeenCalledWith(
      'probe',
      'run-1',
      expect.any(Function),
      expect.objectContaining({
        settingSources: ['project', 'local'],
        env: {
          PATH: '/runtime/bin',
          ANTHROPIC_API_KEY: 'provider-auth',
          UNAPPROVED_SECRET: 'runtime-secret',
          HTTPS_PROXY: 'http://provider-user:provider-secret@proxy.example.test',
          SSL_CERT_FILE: '/runtime/provider-ca.pem',
          CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
        },
        model: 'claude-test',
        effort: 'high',
        permissionMode: 'default'
      })
    )
  })

  it('enables the managed recorder environment and forwards the root Provider turn id', async () => {
    const getProviderTurnId = vi.fn(() => 'root-prompt-id')
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({ sessionId: 'session-1', providerTurnId: 'root-prompt-id' }),
      interrupt: vi.fn(),
      getSessionId: vi.fn(() => 'session-1'),
      getProviderTurnId
    })

    const handle = createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-managed',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      managedRecorder: true,
      emit: vi.fn()
    })

    await expect(handle.promise).resolves.toMatchObject({
      externalSessionId: 'session-1',
      providerTurnId: 'root-prompt-id'
    })
    expect(handle.getProviderTurnId?.()).toBe('root-prompt-id')
    expect(locate.runtimeCliEnv).toHaveBeenCalledWith(undefined, { managedRecorder: true })
    expect(runner.runAgent).toHaveBeenCalledWith(
      'probe',
      'run-managed',
      expect.any(Function),
      expect.objectContaining({
        captureProviderTurnId: true,
        env: expect.objectContaining({ SCRY_RECORDER_MANAGED: '1' })
      })
    )
  })

  it('forwards the Claude runner terminal status to the shared Provider lifecycle', async () => {
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({ sessionId: 'session-failed', status: 'failed' }),
      interrupt: vi.fn(),
      getSessionId: vi.fn(() => 'session-failed')
    })

    await expect(createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-failed',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      emit: vi.fn()
    }).promise).resolves.toMatchObject({ externalSessionId: 'session-failed', status: 'failed' })
  })

  it('runs authorized MCP servers with the exact approved inherited environment', () => {
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({}),
      interrupt: vi.fn(),
      getSessionId: vi.fn()
    })

    createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-env',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      emit: vi.fn(),
      mcpExecution: {
        cwd: '/repo',
        fingerprint: 'sha256:remote',
        env: {
          PATH: '/approved/bin',
          HTTPS_PROXY: 'http://proxy.example.test',
          LANG: 'approved',
          CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
        },
        targets: [
          {
            targetId: 'target',
            name: 'tracker',
            enabled: true,
            config: { command: '/bin/tracker', env: { LANG: 'configured' } }
          },
          {
            targetId: 'http-target',
            name: 'remote',
            enabled: true,
            config: { type: 'http', url: 'https://mcp.example.test' }
          }
        ]
      }
    })

    expect(runner.runAgent).toHaveBeenCalledWith(
      'probe',
      'run-env',
      expect.any(Function),
      expect.objectContaining({
        env: {
          ANTHROPIC_API_KEY: 'provider-auth',
          UNAPPROVED_SECRET: 'runtime-secret',
          PATH: '/approved/bin',
          HTTPS_PROXY: 'http://proxy.example.test',
          LANG: 'approved',
          CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
        },
        mcpServers: {
          tracker: {
            command: '/bin/tracker',
            env: {
              PATH: '/approved/bin',
              HTTPS_PROXY: 'http://proxy.example.test',
              LANG: 'configured',
              CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
            }
          },
          remote: { type: 'http', url: 'https://mcp.example.test' }
        }
      })
    )
    expect(runner.runAgent.mock.calls.at(-1)?.[3].mcpServers.tracker.env).not.toHaveProperty('UNAPPROVED_SECRET')
    expect(runner.runAgent.mock.calls.at(-1)?.[3].mcpServers.remote).not.toHaveProperty('env')
  })

  it('keeps provider proxy and CA for stdio-only MCP while the child receives only the approved snapshot', () => {
    runner.runAgent.mockReturnValue({
      promise: Promise.resolve({}),
      interrupt: vi.fn(),
      getSessionId: vi.fn()
    })
    createClaudeAdapter('/tmp/scry-home').run({
      runId: 'run-stdio',
      prompt: 'probe',
      cwd: '/repo',
      attachments: [],
      emit: vi.fn(),
      mcpExecution: {
        cwd: '/repo',
        fingerprint: 'sha256:stdio',
        env: { PATH: '/approved/bin', TERM: 'approved-term', CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1' },
        targets: [{ targetId: 'stdio', name: 'stdio', enabled: true, config: { command: '/bin/stdio' } }]
      }
    })
    const options = runner.runAgent.mock.calls.at(-1)?.[3]
    expect(options.env).toMatchObject({
      HTTPS_PROXY: 'http://provider-user:provider-secret@proxy.example.test',
      SSL_CERT_FILE: '/runtime/provider-ca.pem',
      ANTHROPIC_API_KEY: 'provider-auth'
    })
    expect(options.mcpServers.stdio.env).toEqual({
      PATH: '/approved/bin',
      TERM: 'approved-term',
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
    })
    expect(options.mcpServers.stdio.env).not.toHaveProperty('HTTPS_PROXY')
    expect(options.mcpServers.stdio.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('reads model and effort options from the native control catalog', async () => {
    sdk.query.mockReturnValue({
      supportedModels: vi.fn().mockResolvedValue([{
        value: 'claude-test',
        displayName: 'Claude Test',
        description: 'test model',
        supportedEffortLevels: ['low', 'high']
      }]),
      supportedCommands: vi.fn().mockResolvedValue([]),
      close: vi.fn()
    })
    const result = await createClaudeAdapter('/tmp/scry-home').runControls!.read({
      providerId: 'claude',
      cwd: '/repo'
    })
    expect(result).toMatchObject({
      state: 'ready',
      data: {
        models: [{
          model: { id: 'claude-test' },
          label: 'Claude Test',
          efforts: [{ id: 'low' }, { id: 'high' }]
        }],
        permissions: [
          { id: 'default' },
          { id: 'auto_review' },
          { id: 'full_access' }
        ]
      }
    })
  })
})
