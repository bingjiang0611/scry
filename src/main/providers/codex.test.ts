import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TraceEvent } from '../../shared/trace'
import multiAgentWire from './test-fixtures/codex-multi-agent-wire-slice.json'

const appServer = vi.hoisted(() => ({
  request: vi.fn(),
  start: vi.fn(),
  onNotification: vi.fn(),
  onRequest: vi.fn(),
  failureForCurrentGeneration: vi.fn(),
  shutdown: vi.fn(),
  options: [] as Array<Record<string, unknown>>
}))
const runtime = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }))

vi.mock('./codex-app-server', () => ({
  CodexAppServerResponseError: class extends Error {
    readonly code: number | undefined
    readonly data: unknown
    readonly method: string
    constructor(method: string, error: { code?: number; message?: string; data?: unknown }) {
      super(error.message)
      this.code = error.code
      this.data = error.data
      this.method = method
    }
  },
  CodexAppServerClient: class {
    request = appServer.request
    requestRunning = appServer.request
    start = appServer.start
    onNotification = appServer.onNotification
    onRequest = appServer.onRequest
    failureForCurrentGeneration = appServer.failureForCurrentGeneration
    shutdown = appServer.shutdown
    pid = 123
    constructor(options: Record<string, unknown>) {
      appServer.options.push(options)
    }
    close() {}
  }
}))

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/codex',
  runtimeCliEnv: () => ({ ...runtime.env }),
  shellEnv: () => ({})
}))

import { CodexAppServerResponseError } from './codex-app-server'
import { codexMcpConfigArgs, createCodexAdapter } from './codex'

describe('Codex provider adapter', () => {
  beforeEach(() => {
    appServer.request.mockReset()
    appServer.start.mockReset().mockResolvedValue(undefined)
    appServer.onNotification.mockReset()
    appServer.onRequest.mockReset().mockReturnValue(() => {})
    appServer.failureForCurrentGeneration.mockReset().mockReturnValue(new Promise(() => {}))
    appServer.shutdown.mockReset().mockResolvedValue(undefined)
    appServer.options.length = 0
    runtime.env = {}
  })

  it('declares only app-server capabilities that it can prove', async () => {
    await expect(createCodexAdapter().describe()).resolves.toMatchObject({
      id: 'codex',
      runtimeProvider: 'codex_cli',
      transport: 'app-server',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'none' }
    })
  })

  it('forks a thread through the previous native turn before rerunning an edited prompt', async () => {
    appServer.request.mockImplementation(async (method: string) => {
      if (method === 'thread/fork') return { thread: { id: 'thread-forked' } }
      throw new Error(`unexpected ${method}`)
    })
    const adapter = createCodexAdapter()

    await expect(adapter.forkLastTurn!.fork({
      sourceSessionId: 'thread-source',
      originalPrompt: 'old prompt',
      replaceRunId: 'run-last',
      replaceProviderTurnId: 'turn-last',
      replaceForkTurnId: 'turn-last',
      previousProviderTurnId: 'turn-previous',
      previousForkTurnId: 'turn-previous',
      cwd: '/repo',
      permissionMode: 'full_access'
    })).resolves.toEqual({ externalSessionId: 'thread-forked' })
    expect(appServer.request).toHaveBeenCalledWith('thread/fork', expect.objectContaining({
      threadId: 'thread-source',
      lastTurnId: 'turn-previous',
      cwd: '/repo',
      excludeTurns: true
    }))
  })

  it('forks a new session at the selected native turn boundary', async () => {
    appServer.request.mockImplementation(async (method: string) => {
      if (method === 'thread/fork') return { thread: { id: 'thread-branched' } }
      throw new Error(`unexpected ${method}`)
    })
    const adapter = createCodexAdapter()

    await expect(adapter.forkSession!.fork({
      providerId: 'codex',
      sourceSessionId: 'thread-source',
      sourceRunId: 'run-selected',
      sourceProviderTurnId: 'turn-selected',
      sourceForkTurnId: 'turn-selected',
      cwd: '/repo',
      model: { id: 'gpt-5.3-codex' },
      permissionMode: 'full_access'
    })).resolves.toEqual({ externalSessionId: 'thread-branched' })
    expect(appServer.request).toHaveBeenCalledWith('thread/fork', expect.objectContaining({
      threadId: 'thread-source',
      lastTurnId: 'turn-selected',
      cwd: '/repo',
      excludeTurns: true,
      model: 'gpt-5.3-codex'
    }))
  })

  it('does not call Codex thread/fork when the managed identity fence rejects', async () => {
    const adapter = createCodexAdapter()
    await expect(adapter.forkSession!.fork({ providerId: 'codex', cwd: '/repo', sourceSessionId: 'thread-source',
      sourceRunId: 'run-source', sourceProviderTurnId: 'turn-source', sourceForkTurnId: 'turn-source',
      beforeFork: async () => { throw new Error('managed identity changed') }
    })).rejects.toThrow('managed identity changed')
    expect(appServer.request).not.toHaveBeenCalled()
  })

  it('clears implicit MCP and serializes only approved Codex configs', () => {
    expect(codexMcpConfigArgs()).toEqual(['-c', 'mcp_servers={}'])
    expect(codexMcpConfigArgs({
      cwd: '/repo', fingerprint: 'sha256:test', env: { PATH: '/bin' },
      targets: [
        { targetId: 'stdio', name: 'stdio target', enabled: true, config: { command: '/bin/echo', args: ['ok'], env: { SAFE: '1' } } },
        { targetId: 'off', name: 'off', enabled: false, config: { command: '/bin/off' } },
        { targetId: 'remote', name: 'remote', enabled: true, config: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'configured' } } }
      ]
    })).toEqual([
      '-c',
      'mcp_servers={"stdio target"={"command"="/bin/echo","args"=["ok"],"env"={"PATH"="/bin","SAFE"="1"},"enabled"=true},"remote"={"url"="https://mcp.example.test","http_headers"={"Authorization"="configured"},"enabled"=true}}'
    ])
  })

  it('lists Codex MCP without app-server, then reads native status from the authorized client', async () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-codex-mcp-test-'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.tracker]\ncommand = "/bin/echo"\nargs = ["configured"]\n' +
      '[mcp_servers.remote]\nurl = "https://mcp.example.test"\n'
    )
    const adapter = createCodexAdapter(undefined, home)
    try {
      await expect(adapter.mcp!.snapshot({ providerId: 'codex', cwd: '/repo' })).resolves.toMatchObject({
        state: 'degraded', data: {
          configured: expect.arrayContaining([expect.objectContaining({ name: 'tracker' })]),
          runtime: null
        }
      })
      const configured = await adapter.mcp!.snapshot({ providerId: 'codex', cwd: '/repo' })
      expect(configured.data?.operations?.authenticate).toEqual([
        configured.data?.configured.find((item) => item.name === 'remote')?.targetId
      ])
      expect(appServer.request).not.toHaveBeenCalled()
      appServer.request.mockResolvedValue({
        data: [{ name: 'tracker', authStatus: 'unsupported', serverInfo: { name: 'fixture', version: '1' }, tools: { ping: {} } }]
      })
      const execution = {
        cwd: '/repo', fingerprint: 'sha256:approved', env: { PATH: '/bin' },
        targets: [{ targetId: 'tracker', name: 'tracker', enabled: true, config: { command: '/bin/echo', args: ['approved'] } }]
      }
      await expect(adapter.mcp!.snapshot({ providerId: 'codex', cwd: '/repo' }, true, execution)).resolves.toMatchObject({
        state: 'ready', data: { runtime: [{ name: 'tracker', status: 'connected', tools: 1 }] }
      })
      expect(appServer.request).toHaveBeenCalledWith('mcpServerStatus/list', { threadId: null, detail: 'full' })
      expect(appServer.options.at(-1)?.args).toEqual(expect.arrayContaining([
        '-c',
        'mcp_servers={"tracker"={"command"="/bin/echo","args"=["approved"],"env"={"PATH"="/bin"},"enabled"=true}}'
      ]))
    } finally {
      await adapter.dispose?.()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('only advertises browser OAuth for remote targets without configured credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-codex-mcp-operations-test-'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), [
      '[mcp_servers.oauth]',
      'url = "https://oauth.example.test/mcp"',
      '[mcp_servers.static]',
      'url = "https://static.example.test/mcp"',
      'http_headers = { Authorization = "configured" }',
      '[mcp_servers.env]',
      'url = "https://env.example.test/mcp"',
      'env_http_headers = { Authorization = "MCP_TOKEN" }',
      '[mcp_servers.bearer]',
      'url = "https://bearer.example.test/mcp"',
      'bearer_token_env_var = "MCP_TOKEN"'
    ].join('\n'))
    const adapter = createCodexAdapter(undefined, home)
    try {
      const snapshot = await adapter.mcp!.snapshot({ providerId: 'codex', cwd: '/repo' })
      const byName = new Map(snapshot.data?.configured.map((item) => [item.name, item.targetId]))
      expect(snapshot.data?.operations?.authenticate).toEqual([byName.get('oauth')])
    } finally {
      await adapter.dispose?.()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('redacts credentials from native MCP refresh failures', async () => {
    const home = mkdtempSync(join(tmpdir(), 'scry-codex-mcp-error-test-'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.remote]\nurl = "https://mcp.example.test"\n')
    const adapter = createCodexAdapter(undefined, home)
    appServer.request.mockRejectedValue(new Error('callback?code=secret-code&state=secret-state'))
    try {
      const result = await adapter.mcp!.snapshot(
        { providerId: 'codex', cwd: '/repo' },
        true,
        {
          cwd: '/repo', fingerprint: 'sha256:approved', env: {},
          targets: [{ targetId: 'remote', name: 'remote', enabled: true, config: { url: 'https://mcp.example.test' } }]
        }
      )

      expect(result.reason).toContain('[redacted]')
      expect(result.reason).not.toContain('secret-code')
      expect(result.reason).not.toContain('secret-state')
    } finally {
      await adapter.dispose?.()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reauthenticates the exact authorized MCP through Codex app-server OAuth', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    let statusRequests = 0
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => { notify = undefined }
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'mcpServer/oauth/login') {
        return { authorizationUrl: 'https://auth.example.test/authorize?state=secret' }
      }
      if (method === 'mcpServerStatus/list') {
        statusRequests += 1
        return {
          data: [{
            name: 'native tracker',
            authStatus: 'oAuth',
            ...(statusRequests > 1 ? { serverInfo: { name: 'fixture', version: '1' } } : {}),
            tools: { ping: {} }
          }]
        }
      }
      return {}
    })
    const execution = {
      cwd: '/repo',
      fingerprint: 'sha256:approved',
      env: { PATH: '/bin' },
      targets: [
        {
          targetId: 'stable-target-id',
          name: 'native tracker',
          enabled: true,
          config: { type: 'http', url: 'https://mcp.example.test' }
        },
        {
          targetId: 'unrelated-target-id',
          name: 'unrelated',
          enabled: true,
          config: { type: 'http', url: 'https://unrelated.example.test' }
        }
      ]
    }
    const openExternal = vi.fn(async () => {
      notify?.('mcpServer/oauthLogin/completed', {
        name: 'other server', threadId: null, success: true
      })
      notify?.('mcpServer/oauthLogin/completed', {
        name: 'native tracker', threadId: null, success: true
      })
    })

    await expect(createCodexAdapter().mcp!.reauthenticate!(
      { providerId: 'codex', cwd: '/repo' },
      'stable-target-id',
      execution,
      { openExternal, prepareLoopbackCallback: vi.fn() }
    )).resolves.toMatchObject({
      state: 'ready', mode: 'read', data: { ok: true, status: 'authenticated' }
    })

    expect(appServer.request).toHaveBeenNthCalledWith(1, 'mcpServer/oauth/login', {
      name: 'native tracker', threadId: null, timeoutSecs: 120
    })
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.test/authorize?state=secret')
    expect(appServer.request).toHaveBeenNthCalledWith(2, 'config/mcpServer/reload', undefined)
    expect(appServer.request).toHaveBeenNthCalledWith(3, 'mcpServerStatus/list', {
      threadId: null, detail: 'toolsAndAuthOnly'
    })
    expect(appServer.request).toHaveBeenNthCalledWith(4, 'mcpServerStatus/list', {
      threadId: null, detail: 'toolsAndAuthOnly'
    })
    const authArgs = (appServer.options.at(-1)?.args as string[]).join('\n')
    expect(authArgs).toContain('native tracker')
    expect(authArgs).not.toContain('unrelated')
    expect(appServer.shutdown).toHaveBeenCalledOnce()
  })

  it('stops and detaches the dedicated app-server when Codex OAuth times out', async () => {
    vi.useFakeTimers()
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => { notify = undefined }
    })
    appServer.request.mockImplementation(async (method) => method === 'mcpServer/oauth/login'
      ? { authorizationUrl: 'https://auth.example.test/authorize' }
      : {})
    const adapter = createCodexAdapter()
    try {
      const result = adapter.mcp!.reauthenticate!(
        { providerId: 'codex', cwd: '/repo' },
        'remote',
        {
          cwd: '/repo', fingerprint: 'sha256:timeout', env: {},
          targets: [{ targetId: 'remote', name: 'remote', enabled: true, config: { type: 'http', url: 'https://mcp.example.test' } }]
        },
        { openExternal: vi.fn().mockResolvedValue(undefined), prepareLoopbackCallback: vi.fn() }
      )

      await vi.advanceTimersByTimeAsync(120_000)
      await expect(result).resolves.toMatchObject({
        state: 'ready', data: { ok: false, status: 'failed', error: expect.stringContaining('超时') }
      })
      expect(appServer.shutdown).toHaveBeenCalledOnce()
      expect(notify).toBeUndefined()
    } finally {
      await adapter.dispose?.()
      vi.useRealTimers()
    }
  })

  it('rejects Codex OAuth before launching a browser when the target is not the authorized remote MCP', async () => {
    const adapter = createCodexAdapter()
    const openExternal = vi.fn()
    const execution = {
      cwd: '/repo',
      fingerprint: 'sha256:approved',
      env: {},
      targets: [{ targetId: 'stdio', name: 'stdio', enabled: true, config: { command: '/bin/echo' } }]
    }

    await expect(adapter.mcp!.reauthenticate!(
      { providerId: 'codex', cwd: '/repo' },
      'stdio',
      execution,
      { openExternal, prepareLoopbackCallback: vi.fn() }
    )).resolves.toMatchObject({
      state: 'ready', data: { ok: false, status: 'failed', error: expect.stringContaining('stdio') }
    })
    expect(openExternal).not.toHaveBeenCalled()
    expect(appServer.request).not.toHaveBeenCalled()
  })

  it('fails closed instead of exposing static HTTP headers in the Codex OAuth child argv', async () => {
    const openExternal = vi.fn()
    await expect(createCodexAdapter().mcp!.reauthenticate!(
      { providerId: 'codex', cwd: '/repo' },
      'remote',
      {
        cwd: '/repo', fingerprint: 'sha256:headers', env: {},
        targets: [{
          targetId: 'remote', name: 'remote', enabled: true,
          config: {
            type: 'http', url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer must-not-enter-argv' }
          }
        }]
      },
      { openExternal, prepareLoopbackCallback: vi.fn() }
    )).resolves.toMatchObject({
      state: 'ready',
      data: { ok: false, status: 'failed', error: expect.stringContaining('静态 http_headers') }
    })
    expect(openExternal).not.toHaveBeenCalled()
    expect(appServer.start).not.toHaveBeenCalled()
    expect(appServer.request).not.toHaveBeenCalled()
  })

  it('fails closed before an MCP can resolve Provider credential env during Codex OAuth', async () => {
    const openExternal = vi.fn()
    await expect(createCodexAdapter().mcp!.reauthenticate!(
      { providerId: 'codex', cwd: '/repo' },
      'remote',
      {
        cwd: '/repo', fingerprint: 'sha256:env-header', env: {},
        targets: [{
          targetId: 'remote', name: 'remote', enabled: true,
          config: {
            type: 'http', url: 'https://evil.example.test/mcp',
            env_http_headers: { Authorization: 'OPENAI_API_KEY' },
            bearer_token_env_var: 'OPENAI_API_KEY'
          }
        }]
      },
      { openExternal, prepareLoopbackCallback: vi.fn() }
    )).resolves.toMatchObject({
      state: 'ready',
      data: { ok: false, status: 'failed', error: expect.stringContaining('凭据环境变量') }
    })
    expect(openExternal).not.toHaveBeenCalled()
    expect(appServer.start).not.toHaveBeenCalled()
    expect(appServer.request).not.toHaveBeenCalled()
  })

  it('starts the app-server inside the Provider context cwd', async () => {
    appServer.request.mockResolvedValue({ data: [{ cwd: '/isolated-copy', skills: [] }] })

    await createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/isolated-copy' })

    expect(appServer.options).toContainEqual(expect.objectContaining({
      cwd: '/isolated-copy',
      args: expect.arrayContaining(['-c', 'default_permissions=":workspace"'])
    }))
  })

  it('uses CODEX_HOME discovered from the login-shell environment as isolated native state source', async () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-shell-home-'))
    writeFileSync(join(source, 'auth.json'), '{}')
    runtime.env = { CODEX_HOME: source }
    appServer.request.mockResolvedValue({ data: [] })
    try {
      await createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/repo' })
      const childEnv = appServer.options.at(-1)?.env as NodeJS.ProcessEnv
      expect(childEnv.CODEX_HOME).not.toBe(source)
      expect(readlinkSync(join(childEnv.CODEX_HOME!, 'auth.json'))).toBe(realpathSync(join(source, 'auth.json')))
      rmSync(childEnv.CODEX_HOME!, { recursive: true, force: true })
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  })

  it('lets the launcher pin the source home without leaking the control variable to app-server', async () => {
    const explicit = mkdtempSync(join(tmpdir(), 'scry-codex-explicit-home-'))
    const shell = mkdtempSync(join(tmpdir(), 'scry-codex-shell-home-'))
    const previous = process.env.SCRY_CODEX_SOURCE_HOME
    writeFileSync(join(explicit, 'auth.json'), '{}')
    writeFileSync(join(shell, 'auth.json'), '{}')
    process.env.SCRY_CODEX_SOURCE_HOME = explicit
    runtime.env = { CODEX_HOME: shell, SCRY_CODEX_SOURCE_HOME: '/must-not-leak' }
    appServer.request.mockResolvedValue({ data: [] })
    try {
      await createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/repo' })
      const childEnv = appServer.options.at(-1)?.env as NodeJS.ProcessEnv
      expect(readlinkSync(join(childEnv.CODEX_HOME!, 'auth.json'))).toBe(realpathSync(join(explicit, 'auth.json')))
      expect(childEnv.SCRY_CODEX_SOURCE_HOME).toBeUndefined()
      rmSync(childEnv.CODEX_HOME!, { recursive: true, force: true })
    } finally {
      if (previous === undefined) delete process.env.SCRY_CODEX_SOURCE_HOME
      else process.env.SCRY_CODEX_SOURCE_HOME = previous
      rmSync(explicit, { recursive: true, force: true })
      rmSync(shell, { recursive: true, force: true })
    }
  })

  it('previews a persistent Codex namespace without materializing it, then reuses it for the first transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-codex-identity-'))
    const home = join(root, 'home')
    const source = join(home, '.codex')
    const stable = join(root, 'runtime', 'isolated')
    const executable = join(root, 'codex')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'auth.json'), '{}')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    const previousExecutable = process.env.SCRY_CODEX_PATH
    process.env.SCRY_CODEX_PATH = executable
    runtime.env = { HOME: home }
    const adapter = createCodexAdapter(stable, home)
    const context = { providerId: 'codex' as const, cwd: '/repo' }
    try {
      const key = await adapter.continuationKey!(context)
      expect(existsSync(stable)).toBe(false)
      appServer.request.mockResolvedValue({ data: [] })
      await adapter.skills!.list(context)
      expect(existsSync(stable)).toBe(true)
      expect(await adapter.continuationKey!(context)).toBe(key)
      expect(appServer.options.at(-1)?.env).toMatchObject({ CODEX_HOME: stable })
    } finally {
      await adapter.dispose?.()
      if (previousExecutable === undefined) delete process.env.SCRY_CODEX_PATH
      else process.env.SCRY_CODEX_PATH = previousExecutable
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a changed frozen Codex identity before starting a transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-codex-identity-'))
    const home = join(root, 'home')
    const source = join(home, '.codex')
    const stable = join(root, 'runtime', 'isolated')
    const executable = join(root, 'codex')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'auth.json'), '{}')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    const previousExecutable = process.env.SCRY_CODEX_PATH
    process.env.SCRY_CODEX_PATH = executable
    runtime.env = { HOME: home }
    const adapter = createCodexAdapter(stable, home)
    const context = { providerId: 'codex' as const, cwd: '/repo' }
    try {
      const key = await adapter.continuationKey!(context)
      writeFileSync(join(source, 'auth.json'), '{"changed":true}')
      const handle = adapter.run({ runId: 'identity-mismatch', prompt: 'test', cwd: '/repo', attachments: [], expectedContinuationKey: key, emit: () => {} })
      await expect(handle.promise).rejects.toThrow(/接续身份已变化/)
      expect(appServer.start).not.toHaveBeenCalled()
    } finally {
      await adapter.dispose?.()
      if (previousExecutable === undefined) delete process.env.SCRY_CODEX_PATH
      else process.env.SCRY_CODEX_PATH = previousExecutable
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a provided isolated home across adapter disposal and recreation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-codex-stable-'))
    const source = join(root, 'native')
    const stable = join(root, 'isolated')
    mkdirSync(source)
    writeFileSync(join(source, 'auth.json'), '{}')
    runtime.env = { CODEX_HOME: source }
    appServer.request.mockResolvedValue({ data: [] })
    try {
      const first = createCodexAdapter(stable)
      await first.skills!.list({ providerId: 'codex', cwd: '/repo' })
      expect((appServer.options.at(-1)?.env as NodeJS.ProcessEnv).CODEX_HOME).toBe(stable)
      writeFileSync(join(stable, 'state_5.sqlite'), 'state')
      await first.dispose?.()

      const second = createCodexAdapter(stable)
      await second.skills!.list({ providerId: 'codex', cwd: '/repo' })
      expect((appServer.options.at(-1)?.env as NodeJS.ProcessEnv).CODEX_HOME).toBe(stable)
      expect(existsSync(join(stable, 'state_5.sqlite'))).toBe(true)
      await second.dispose?.()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
      permissionMode: 'full_access',
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
      permissionMode: 'full_access',
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

  it('passes selected model, effort and auto-review access to native requests', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-controls' } }
      if (method === 'turn/start') return { turn: { id: 'turn-controls' } }
      throw new Error(`unexpected request: ${method}`)
    })

    const run = createCodexAdapter().run({
      runId: 'run-controls',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      model: { id: 'gpt-5.3-codex' },
      effort: 'high',
      permissionMode: 'auto_review',
      emit: () => {}
    })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))

    expect(appServer.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/repo',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
      model: 'gpt-5.3-codex'
    })
    expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'thread-controls',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      model: 'gpt-5.3-codex',
      effort: 'high'
    }))

    notify?.('turn/completed', {
      threadId: 'thread-controls',
      turnId: 'turn-controls',
      turn: { status: 'completed' }
    })
    await run.promise
  })

  it('reads the native model catalog and translates default approval decisions', async () => {
    appServer.request.mockImplementation(async (method) => {
      if (method === 'model/list') {
        return {
          data: [{
            model: 'gpt-5.3-codex',
            displayName: 'GPT-5.3 Codex',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'high', description: 'Deep' }
            ]
          }]
        }
      }
      throw new Error(`unexpected request: ${method}`)
    })
    const adapter = createCodexAdapter()
    await expect(adapter.runControls!.read({ providerId: 'codex', cwd: '/repo' })).resolves.toMatchObject({
      state: 'ready',
      data: {
        models: [{
          model: { id: 'gpt-5.3-codex' },
          label: 'GPT-5.3 Codex',
          efforts: [
            { id: 'medium', isDefault: true },
            { id: 'high' }
          ]
        }]
      }
    })

    let notify: ((method: string, params: unknown) => void) | undefined
    let approve: ((method: string, params: unknown) => Promise<unknown>) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.onRequest.mockImplementation((listener) => {
      approve = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-approval' } }
      if (method === 'turn/start') return { turn: { id: 'turn-approval' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const run = adapter.run({
      runId: 'run-approval',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      permissionMode: 'default',
      emit: () => {},
      requestUserInput: async (question) => ({
        runId: question.runId,
        questionId: question.questionId,
        behavior: 'answered',
        answers: { [question.questions[0].question]: '允许一次' }
      })
    })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    await expect(approve?.('item/commandExecution/requestApproval', {
      threadId: 'thread-approval',
      itemId: 'item-1',
      command: 'npm test',
      availableDecisions: ['accept', 'acceptForSession']
    })).resolves.toEqual({ decision: 'accept' })

    notify?.('turn/completed', {
      threadId: 'thread-approval',
      turnId: 'turn-approval',
      turn: { status: 'completed' }
    })
    await run.promise
  })

  it('bridges native requestUserInput questions and returns answers by Codex question id', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    let requestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.onRequest.mockImplementation((listener) => {
      requestHandler = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-question' } }
      if (method === 'turn/start') return { turn: { id: 'turn-question' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const requestUserInput = vi.fn(async (question) => ({
      runId: question.runId,
      questionId: question.questionId,
      behavior: 'answered' as const,
      answers: { [question.questions[0].question]: '全量' }
    }))
    const run = createCodexAdapter().run({
      runId: 'run-question',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      permissionMode: 'full_access',
      emit: () => {},
      requestUserInput
    })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))

    await expect(requestHandler?.('item/tool/requestUserInput', {
      threadId: 'thread-question',
      turnId: 'turn-question',
      itemId: 'item-question',
      autoResolutionMs: null,
      questions: [{
        id: 'scope',
        header: '范围',
        question: '选择验证范围？',
        isOther: true,
        isSecret: false,
        options: [
          { label: '全量', description: '验证全部路径' },
          { label: '增量', description: '只验证改动路径' }
        ]
      }]
    })).resolves.toEqual({ answers: { scope: { answers: ['全量'] } } })
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: 'codex:item/tool/requestUserInput:item-question',
        questionKind: 'clarification',
        source: 'codex:item/tool/requestUserInput'
      }),
      expect.any(AbortSignal)
    )

    notify?.('turn/completed', {
      threadId: 'thread-question',
      turnId: 'turn-question',
      turn: { status: 'completed' }
    })
    await run.promise
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
    expect(appServer.options).toContainEqual(expect.objectContaining({
      cwd: '/isolated-copy',
      args: expect.arrayContaining(['-c', 'projects={"/isolated-copy"={trust_level="trusted"}}'])
    }))
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

  it('hides nested support Skills from the Codex catalog', async () => {
    appServer.request.mockResolvedValue({
      data: [{
        cwd: '/isolated-copy',
        skills: [
          { name: 'markdown-to-html', path: '/Users/test/.codex/skills/markdown-to-html/SKILL.md', enabled: true },
          { name: 'email-marketing', path: '/Users/test/.codex/skills/markdown-to-html/templates/email-marketing/SKILL.md', enabled: true }
        ]
      }]
    })

    await expect(
      createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/isolated-copy' })
    ).resolves.toMatchObject({ data: [{ name: 'markdown-to-html' }] })
  })

  it('reads the Codex Skill catalog without claiming write access', async () => {
    appServer.request.mockImplementation(async (method) => {
      if (method === 'skills/list') {
        return { data: [{ cwd: '/isolated-copy', skills: [{ name: 'scry-e2e-audit', path: '/skill', enabled: true }] }] }
      }
      throw new Error(`unexpected request: ${method}`)
    })
    const adapter = createCodexAdapter()
    const context = { providerId: 'codex' as const, cwd: '/isolated-copy' }

    await expect(adapter.skills!.list(context)).resolves.toMatchObject({ mode: 'read', data: [{ name: 'scry-e2e-audit', enabled: true }] })
    expect(appServer.request).toHaveBeenLastCalledWith('skills/list', { cwds: ['/isolated-copy'], forceReload: false })
  })

  it('forces a same-cwd Skill reload after starting a new session', async () => {
    appServer.request.mockImplementation(async (method) => {
      if (method === 'skills/list') {
        return { data: [{ cwd: '/isolated-copy', skills: [{ name: 'fresh-skill', path: '/isolated-copy/.agents/skills/fresh-skill/SKILL.md', enabled: true }] }] }
      }
      throw new Error(`unexpected request: ${method}`)
    })
    const adapter = createCodexAdapter()
    const context = { providerId: 'codex' as const, cwd: '/isolated-copy' }

    await adapter.invalidateContext?.(context)
    await expect(adapter.commands!.list(context)).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'fresh-skill', source: 'skill' })]
    })

    expect(appServer.request).toHaveBeenLastCalledWith('skills/list', {
      cwds: ['/isolated-copy'],
      forceReload: true
    })
  })

  it('preserves a newer forced Skill reload when an older forced request finishes late', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    const first = new Promise((resolve) => { resolveFirst = resolve })
    appServer.request
      .mockImplementationOnce(async (method) => {
        if (method !== 'skills/list') throw new Error(`unexpected request: ${method}`)
        return first
      })
      .mockImplementationOnce(async (method) => {
        if (method !== 'skills/list') throw new Error(`unexpected request: ${method}`)
        return { data: [{ cwd: '/isolated-copy', skills: [] }] }
      })
    const adapter = createCodexAdapter()
    const context = { providerId: 'codex' as const, cwd: '/isolated-copy' }

    await adapter.invalidateContext?.(context)
    const olderReload = adapter.skills!.list(context)
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledTimes(1))
    await adapter.invalidateContext?.(context)
    resolveFirst({ data: [{ cwd: '/isolated-copy', skills: [] }] })
    await olderReload
    await adapter.skills!.list(context)

    expect(appServer.request).toHaveBeenNthCalledWith(2, 'skills/list', {
      cwds: ['/isolated-copy'],
      forceReload: true
    })
  })

  it('keeps unapproved Codex hooks out of the app-server process', async () => {
    appServer.request.mockResolvedValue({ data: [{ cwd: '/isolated-copy', skills: [] }] })

    await createCodexAdapter().skills!.list({ providerId: 'codex', cwd: '/isolated-copy' })

    expect(appServer.options).toContainEqual(expect.objectContaining({
      cwd: '/isolated-copy',
      args: expect.arrayContaining([
        '-c',
        'projects={"/isolated-copy"={trust_level="trusted"}}',
        'app-server',
        '--strict-config',
        'apps',
        'plugins',
        'external_migration'
      ])
    }))
    expect(appServer.options[0].args).not.toContain('--dangerously-bypass-hook-trust')
    expect(appServer.options[0].args).not.toContain(
      'hooks={state={"project-hook"={trusted_hash="sha256:current"}}}'
    )
  })

  it('injects only the approved Hook key/hash into the approved run', async () => {
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
      codexHookTrust: [
        { key: 'z-stop', currentHash: 'sha256:z' },
        { key: 'a-start', currentHash: 'sha256:a' }
      ],
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
        args: expect.arrayContaining([
          '-c',
          'projects={"/isolated-copy"={trust_level="trusted"}}',
          '-c',
          'hooks={state={"a-start"={trusted_hash="sha256:a"},"z-stop"={trusted_hash="sha256:z"}}}',
          'app-server',
          '--strict-config',
          'apps',
          'plugins',
          'external_migration'
        ])
      })
    )
    expect(appServer.options[0].args).not.toContain('--dangerously-bypass-hook-trust')
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

    // app-server client 按 cwd 复用，硬杀会断掉同一 client 上的其他并发 run。
    expect(handle.forceKillScope).toBe('shared_transport')
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

  it('keeps the run owned when stop arrives before a delayed turn/start acknowledgement', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    let acknowledge!: (value: unknown) => void
    const started = new Promise((resolve) => { acknowledge = resolve })
    const unsubscribe = vi.fn()
    appServer.onNotification.mockImplementation((listener) => { notify = listener; return unsubscribe })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-delayed' } }
      if (method === 'turn/start') return started
      if (method === 'turn/interrupt') return {}
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({
      runId: 'run-delayed', prompt: 'inspect', cwd: '/repo', attachments: [], emit: () => {}
    })
    const settled = vi.fn()
    void handle.promise.then(settled)
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    handle.interrupt()
    acknowledge({ turn: { id: 'turn-delayed' } })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-delayed', turnId: 'turn-delayed'
    }))
    expect(settled).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    notify?.('turn/completed', {
      threadId: 'thread-delayed', turn: { id: 'turn-delayed', status: 'interrupted' }
    })
    await expect(handle.promise).resolves.toMatchObject({ status: 'interrupted', providerTurnId: 'turn-delayed' })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('interrupts the owned client without reopening a changed runtime source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-codex-stop-identity-'))
    const source = join(root, 'source')
    const changedSource = join(root, 'changed-source')
    mkdirSync(source)
    mkdirSync(changedSource)
    const previousSource = process.env.SCRY_CODEX_SOURCE_HOME
    process.env.SCRY_CODEX_SOURCE_HOME = source
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => { notify = listener; return () => {} })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'owned-thread' } }
      if (method === 'turn/start') return { turn: { id: 'owned-turn' } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unexpected request: ${method}`)
    })
    const adapter = createCodexAdapter(join(root, 'private'), root)
    const handle = adapter.run({ runId: 'stop-owned-client', prompt: 'inspect', cwd: root, attachments: [], emit: () => {} })
    try {
      await vi.waitFor(() => expect(handle.getProviderTurnId?.()).toBe('owned-turn'))
      const clients = appServer.options.length
      process.env.SCRY_CODEX_SOURCE_HOME = changedSource
      handle.interrupt()
      await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'owned-thread', turnId: 'owned-turn' }))
      expect(appServer.options).toHaveLength(clients)
    } finally {
      if (previousSource === undefined) delete process.env.SCRY_CODEX_SOURCE_HOME
      else process.env.SCRY_CODEX_SOURCE_HOME = previousSource
      notify?.('turn/completed', { threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'interrupted' } })
      try { await handle.promise } finally {
        await adapter.dispose?.()
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it.each(['native interrupt rejected', 'turn/interrupt timed out'])('retains native ownership after %s', async (message) => {
    let notify: ((method: string, params: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    const emit = vi.fn()
    appServer.onNotification.mockImplementation((listener) => { notify = listener; return unsubscribe })
    appServer.onRequest.mockReturnValue(() => {})
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-interrupt-failure' } }
      if (method === 'turn/start') return { turn: { id: 'turn-interrupt-failure' } }
      if (method === 'turn/interrupt') throw new Error(message)
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({
      runId: 'run-interrupt-failure', prompt: 'inspect', cwd: '/repo', attachments: [], emit
    })
    const settled = vi.fn()
    void handle.promise.then(settled)
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    handle.interrupt()
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'runtime:error', text: expect.stringContaining(message)
    })))
    expect(settled).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    notify?.('turn/completed', {
      threadId: 'thread-interrupt-failure', turn: { id: 'turn-interrupt-failure', status: 'completed' }
    })
    await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
    expect(unsubscribe).toHaveBeenCalledOnce()
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

  it('records a completed contextCompaction item exactly once', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-compact' } }
      if (method === 'turn/start') return { turn: { id: 'turn-compact' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-compact',
      prompt: 'continue',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    const params = {
      threadId: 'thread-compact',
      turnId: 'turn-compact',
      item: { id: 'compact-item-1', type: 'contextCompaction' }
    }
    notify?.('item/started', params)
    notify?.('item/completed', params)
    notify?.('turn/completed', {
      threadId: 'thread-compact',
      turnId: 'turn-compact',
      turn: { id: 'turn-compact', status: 'completed' }
    })
    await handle.promise

    expect(events.filter((event) => event.stage === 'context_compaction')).toEqual([
      expect.objectContaining({
        kind: 'harness',
        compaction: { providerEventId: 'compact-item-1' }
      })
    ])
  })

  it('preserves a native output-limit completion as an incomplete result', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-length' } }
      if (method === 'turn/start') return { turn: { id: 'turn-length' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-length',
      prompt: 'write a long answer',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => {
      expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything())
    })
    notify?.('turn/completed', {
      threadId: 'thread-length',
      turnId: 'turn-length',
      turn: { id: 'turn-length', status: 'completed', finish_reason: 'length' }
    })

    await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
    expect(events.at(-1)).toMatchObject({
      kind: 'harness',
      stage: 'result',
      isError: false,
      providerStopReason: 'length',
      terminationReason: 'output_token_limit'
    })
  })

  it('rejects an active turn when its app-server generation dies before completion', async () => {
    let resolveFailure: (error: Error) => void = () => {}
    appServer.failureForCurrentGeneration.mockReturnValue(new Promise((resolve) => {
      resolveFailure = resolve
    }))
    appServer.onNotification.mockReturnValue(() => {})
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-lost' } }
      if (method === 'turn/start') return { turn: { id: 'turn-lost' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({
      runId: 'run-lost',
      prompt: 'inspect',
      cwd: '/repo',
      attachments: [],
      emit: () => {}
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    resolveFailure(new Error('Codex app-server request timed out: test/hang'))

    await expect(handle.promise).rejects.toThrow('test/hang')
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

  it('times each root model request from its start to its last generation signal, not to the usage update', async () => {
    let notify: ((method: string, params: unknown, envelope?: { emittedAtMs?: number }) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } }
      if (method === 'thread/start') return { thread: { id: 'thread-calls' }, model: 'gpt-test' }
      if (method === 'turn/start') return { turn: { id: 'turn-calls' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-calls', prompt: 'inspect', cwd: '/isolated-copy', attachments: [], emit: (event) => events.push(event)
    })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    const ids = { threadId: 'thread-calls', turnId: 'turn-calls' }
    const usage = (input: number, output: number) => ({ ...ids, tokenUsage: {
      total: { inputTokens: input, outputTokens: output, totalTokens: input + output }, last: { inputTokens: 10, outputTokens: output, totalTokens: 10 + output }
    } })
    // Order taken from a real Codex 0.160 turn: a request's usage update arrives only after the tools
    // it called have finished, so tool time must not be counted and its tool completion must not start
    // the next request.
    notify?.('turn/started', { ...ids, turn: { id: 'turn-calls', startedAt: 99, status: 'inProgress' } }, { emittedAtMs: 100_000 })
    // A hook before any output still delays the first request.
    // Codex timestamps here are whole seconds (startedAt 99, completedAt 100); receipt times are exact.
    notify?.('hook/completed', { ...ids, run: { id: 'h0', eventName: 'userPromptSubmit', status: 'completed', completedAt: 100 } }, { emittedAtMs: 100_300 })
    // The first output item (reasoning) marks the first token; later deltas do not move it.
    notify?.('item/started', { ...ids, item: { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] } }, { emittedAtMs: 101_500 })
    notify?.('item/agentMessage/delta', { ...ids, itemId: 'message-0', delta: 'x' }, { emittedAtMs: 102_000 })
    // PreToolUse runs once the model has finished the tool call: generation ends here.
    notify?.('hook/started', { ...ids, run: { id: 'h1', eventName: 'preToolUse', status: 'running' } }, { emittedAtMs: 103_300 })
    notify?.('hook/completed', { ...ids, run: { id: 'h1', eventName: 'preToolUse', status: 'completed', completedAt: 103.4 } }, { emittedAtMs: 103_400 })
    notify?.('item/started', { ...ids, item: { id: 'tool-1', type: 'commandExecution', command: 'sleep 5', status: 'inProgress' } }, { emittedAtMs: 103_500 })
    notify?.('item/completed', { ...ids, item: { id: 'tool-1', type: 'commandExecution', command: 'sleep 5', status: 'completed' }, completedAtMs: 108_500 }, { emittedAtMs: 108_500 })
    notify?.('thread/tokenUsage/updated', usage(10, 30), { emittedAtMs: 108_600 })
    // A repeated snapshot is not another response.
    notify?.('thread/tokenUsage/updated', usage(10, 30), { emittedAtMs: 108_650 })
    // Second request: no hook, the tool item start itself ends generation; it is never a first token.
    notify?.('item/agentMessage/delta', { ...ids, itemId: 'message-1', delta: 'd' }, { emittedAtMs: 109_400 })
    notify?.('item/started', { ...ids, item: { id: 'tool-2', type: 'commandExecution', command: 'ls', status: 'inProgress' } }, { emittedAtMs: 110_600 })
    notify?.('item/completed', { ...ids, item: { id: 'tool-2', type: 'commandExecution', command: 'ls', status: 'completed' }, completedAtMs: 115_000 }, { emittedAtMs: 115_000 })
    notify?.('thread/tokenUsage/updated', { threadId: 'child-thread', turnId: 'child', tokenUsage: { last: { outputTokens: 999 } } }, { emittedAtMs: 115_050 })
    notify?.('thread/tokenUsage/updated', { ...usage(20, 70), tokenUsage: { ...usage(20, 70).tokenUsage, last: { inputTokens: 10, outputTokens: 40, totalTokens: 50 } } }, { emittedAtMs: 115_100 })
    // Final answer: agentMessage completion is the last output; the usage update comes later.
    notify?.('item/started', { ...ids, item: { id: 'message-2', type: 'agentMessage', text: '' } }, { emittedAtMs: 116_000 })
    notify?.('item/completed', { ...ids, item: { id: 'message-2', type: 'agentMessage', text: 'done' } }, { emittedAtMs: 117_100 })
    notify?.('thread/tokenUsage/updated', { ...usage(30, 90), tokenUsage: { ...usage(30, 90).tokenUsage, last: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } }, { emittedAtMs: 117_400 })
    // A request with no observable output signal is bounded by its usage update and has no first token.
    notify?.('thread/tokenUsage/updated', { ...usage(40, 100), tokenUsage: { ...usage(40, 100).tokenUsage, last: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } }, { emittedAtMs: 118_400 })
    notify?.('turn/completed', { ...ids, turn: { id: 'turn-calls', status: 'completed' } }, { emittedAtMs: 118_500 })
    await handle.promise

    expect(events.filter((event) => event.stage === 'runtime:llm_call').map((event) => event.llmCall)).toEqual([
      { outputTokens: 30, durationMs: 3_000, firstTokenMs: 1_200, model: 'gpt-test' },
      { outputTokens: 40, durationMs: 2_000, firstTokenMs: 800, model: 'gpt-test' },
      { outputTokens: 20, durationMs: 2_000, firstTokenMs: 900, model: 'gpt-test' },
      { outputTokens: 10, durationMs: 1_000, model: 'gpt-test' }
    ])
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
          cacheWriteInputTokens: 20,
          outputTokens: 110,
          reasoningOutputTokens: 11,
          totalTokens: 1210
        },
        last: {
          inputTokens: 100,
          cachedInputTokens: 60,
          cacheWriteInputTokens: 2,
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
        cacheWriteInputTokens: 30,
        outputTokens: 160,
        reasoningOutputTokens: 16,
        totalTokens: 1560
      },
      last: {
        inputTokens: 200,
        cachedInputTokens: 125,
        cacheWriteInputTokens: 3,
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
      cacheCreationTokens: 12,
      reasoningTokens: 6,
      contextTokens: 200,
      contextModel: 'gpt-test',
      contextProvider: 'openai',
      contextUsageSource: 'codex_app_server_last_usage',
      contextUsageQuality: 'exact',
      modelUsage: [{
        model: 'gpt-test',
        inputTokens: 400,
        outputTokens: 60,
        cacheReadTokens: 250,
        cacheCreationTokens: 12,
        reasoningTokens: 6,
        contextWindow: 200_000
      }]
    })
  })

  it('does not charge the historical usage snapshot delivered while resuming a thread', async () => {
    const events: TraceEvent[] = []
    let notify: ((method: string, params: unknown) => void) | undefined
    const cumulative = (inputTokens: number, outputTokens: number, cachedInputTokens: number) => ({
      inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens
    })
    const previous = cumulative(14_019, 14, 11_392)
    const firstCall = cumulative(14_105, 26, 13_824)
    appServer.onNotification.mockImplementation((listener: (method: string, params: unknown) => void) => {
      notify = listener
      return () => { notify = undefined }
    })
    appServer.request.mockImplementation(async (method: string) => {
      if (method === 'thread/resume') {
        // Codex 0.160.1 publishes persisted usage before this run requests a turn.
        // It includes `last`, but that last API call belongs to the previous run.
        notify?.('thread/tokenUsage/updated', {
          threadId: 'resumed-thread', turnId: 'previous-turn',
          tokenUsage: { total: previous, last: previous, modelContextWindow: 475_000 }
        })
        return { thread: { id: 'resumed-thread' }, model: 'gpt-test', modelProvider: 'openai' }
      }
      if (method === 'turn/start') {
        // Current-turn notifications may arrive before the start acknowledgement.
        notify?.('thread/tokenUsage/updated', {
          threadId: 'resumed-thread', turnId: 'current-turn',
          tokenUsage: { total: cumulative(28_124, 40, 25_216), last: firstCall, modelContextWindow: 475_000 }
        })
        return { turn: { id: 'current-turn' } }
      }
      return {}
    })
    const adapter = createCodexAdapter()
    const handle = adapter.run({
      runId: 'run-resumed-usage', prompt: 'continue', cwd: '/isolated-copy',
      resume: 'resumed-thread', attachments: [], emit: (event) => events.push(event)
    })
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      stage: 'runtime:steer_capability', runtimeMetadata: expect.objectContaining({ turnId: 'current-turn' })
    })))
    // A delayed snapshot from the previous turn must not reset the current baseline.
    notify?.('thread/tokenUsage/updated', {
      threadId: 'resumed-thread', turnId: 'previous-turn', tokenUsage: { total: previous, last: previous }
    })
    const secondCall = {
      threadId: 'resumed-thread', turnId: 'current-turn',
      tokenUsage: { total: cumulative(28_144, 45, 25_216), last: cumulative(20, 5, 0), modelContextWindow: 475_000 }
    }
    notify?.('thread/tokenUsage/updated', secondCall)
    notify?.('thread/tokenUsage/updated', secondCall)
    notify?.('turn/completed', {
      threadId: 'resumed-thread', turn: { id: 'current-turn', status: 'completed', error: null }
    })
    await handle.promise
    const result = events.find((event) => event.kind === 'harness' && event.stage === 'result')
    expect(result).toMatchObject({ tokensIn: 14_125, tokensOut: 31, cacheReadTokens: 13_824 })
    expect(result?.modelUsage?.[0]).toMatchObject({ inputTokens: 14_125, outputTokens: 31, cacheReadTokens: 13_824 })
  })

  it('uses the first cumulative-only resume update as a baseline instead of charging session history', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } }
      if (method === 'thread/resume') return { thread: { id: 'thread-resume-baseline' }, model: 'gpt-test', modelProvider: 'openai' }
      if (method === 'turn/start') return { turn: { id: 'turn-resume-baseline' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-resume-baseline', prompt: 'continue', cwd: '/isolated-copy',
      resume: 'thread-resume-baseline', attachments: [], emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    const baseline = {
      threadId: 'thread-resume-baseline', turnId: 'turn-resume-baseline',
      tokenUsage: { total: { inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000 }, modelContextWindow: 200_000 }
    }
    notify?.('thread/tokenUsage/updated', baseline)
    notify?.('thread/tokenUsage/updated', baseline)
    notify?.('thread/tokenUsage/updated', {
      threadId: 'thread-resume-baseline', turnId: 'turn-resume-baseline',
      tokenUsage: {
        total: { inputTokens: 10_100, outputTokens: 1_020, totalTokens: 11_120 },
        last: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        modelContextWindow: 200_000
      }
    })
    notify?.('turn/completed', {
      threadId: 'thread-resume-baseline',
      turn: { id: 'turn-resume-baseline', status: 'completed', error: null }
    })
    await handle.promise

    expect(events.find((event) => event.kind === 'harness' && event.stage === 'result')).toMatchObject({
      tokensIn: 100,
      tokensOut: 20,
      contextTokens: 100,
      contextModel: 'gpt-test'
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
      turn: { id: 'turn-child', status: 'interrupted', error: null }
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
    expect(events.find((event) => event.stage === 'tool_result' && event.agentId === 'thread-child')).toMatchObject({
      tool: 'Agent',
      toolUseId: 'spawn-1',
      isError: false,
      runtimeMetadata: {
        source: 'codex_child_turn',
        agentStatus: 'interrupted',
        nativeTurnStatus: 'interrupted'
      }
    })
    expect(events.find((event) => event.kind === 'harness' && event.stage === 'result')).toMatchObject({
      tokensIn: 10,
      tokensOut: 2
    })
  })

  it('keeps root events top-level after a child interacts with root and deduplicates subagent activity', async () => {
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
      runId: 'run-child-return',
      prompt: 'delegate and resume',
      cwd: '/isolated-copy',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    const childStarted = {
      id: 'spawn-activity',
      type: 'subAgentActivity',
      kind: 'started',
      agentThreadId: 'thread-child',
      agentPath: '/root/inspect'
    }
    notify?.('item/started', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      item: childStarted
    })
    notify?.('item/completed', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      item: childStarted
    })
    notify?.('item/agentMessage/delta', {
      threadId: 'thread-child',
      turnId: 'turn-child',
      itemId: 'child-message',
      delta: 'child work'
    })
    const interactedWithRoot = {
      id: 'interact-root',
      type: 'subAgentActivity',
      kind: 'interacted',
      agentThreadId: 'thread-root',
      agentPath: '/root'
    }
    notify?.('item/started', {
      threadId: 'thread-child',
      turnId: 'turn-child',
      item: interactedWithRoot
    })
    notify?.('item/completed', {
      threadId: 'thread-child',
      turnId: 'turn-child',
      item: interactedWithRoot
    })
    notify?.('item/agentMessage/delta', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      itemId: 'root-message',
      delta: 'root resumed'
    })
    notify?.('item/started', {
      threadId: 'thread-root',
      turnId: 'turn-root',
      item: {
        id: 'root-command',
        type: 'commandExecution',
        command: 'pwd',
        cwd: '/isolated-copy',
        status: 'inProgress'
      }
    })
    notify?.('turn/completed', {
      threadId: 'thread-root',
      turn: { id: 'turn-root', status: 'completed', error: null }
    })
    await handle.promise

    expect(events.filter((event) => event.toolUseId === 'spawn-activity')).toHaveLength(1)
    expect(events.find((event) => event.text === 'child work')).toMatchObject({
      agentId: 'thread-child',
      parentToolUseId: 'spawn-activity'
    })
    expect(events.find((event) => event.toolUseId === 'interact-root')).toMatchObject({
      kind: 'harness',
      agentId: 'thread-child',
      parentToolUseId: 'spawn-activity',
      input: expect.objectContaining({ agentThreadId: 'thread-root' })
    })
    const rootResume = events.find((event) => event.text === 'root resumed')
    expect(rootResume).toBeDefined()
    expect(rootResume).not.toHaveProperty('agentId')
    expect(rootResume).not.toHaveProperty('parentToolUseId')
    const rootCommand = events.find((event) => event.toolUseId === 'root-command')
    expect(rootCommand).toMatchObject({ kind: 'tool' })
    expect(rootCommand?.agentId).toBeUndefined()
    expect(rootCommand?.parentToolUseId).toBeUndefined()
  })

  it('replays the real Codex 0.145.0 completed-only subagent registration shape', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: multiAgentWire.rootThreadId } }
      if (method === 'turn/start') return { turn: { id: multiAgentWire.rootTurnId } }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-real-child-wire',
      prompt: 'fan out',
      cwd: '/workspace/repo',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    for (const notification of multiAgentWire.notifications) notify?.(notification.method, notification.params)
    notify?.('turn/completed', {
      threadId: multiAgentWire.rootThreadId,
      turn: { id: multiAgentWire.rootTurnId, status: 'completed', error: null }
    })
    await handle.promise

    expect(multiAgentWire.capturedWith.cli).toBe('codex-cli 0.145.0')
    expect(events.filter((event) => event.toolUseId === 'call_S2JPiq0sMnJYS7kswVdvzEjB')).toEqual([
      expect.objectContaining({
        kind: 'agent',
        agentId: multiAgentWire.childThreadId,
        name: 'alpha'
      }),
      expect.objectContaining({
        kind: 'tool',
        stage: 'tool_result',
        agentId: multiAgentWire.childThreadId
      })
    ])
    expect(events.find((event) => event.toolUseId === 'call_2W1NboHClVo0VqAf1y3ZFinO')).toMatchObject({
      kind: 'harness',
      agentId: multiAgentWire.childThreadId,
      input: expect.objectContaining({ agentThreadId: multiAgentWire.rootThreadId })
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
        command: '/bin/zsh -lc \\"mcporter call workitem.query_workitem_detail --args \'{\\\\"id\\\\":\\\\"1\\\\"}\' && mcporter call env-config.list --args \'{}\'\\"',
        cwd: '/isolated-copy'
      }
    })
    notify?.('item/completed', {
      threadId: 'thread-mcp',
      turnId: 'turn-mcp',
      item: {
        id: 'mcp-call',
        type: 'commandExecution',
        command: 'mcporter call workitem.query_workitem_detail && mcporter call env-config.list',
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
      mcpServer: 'workitem',
      mcpAction: 'query_workitem_detail',
      mcpTool: 'mcporter:workitem.query_workitem_detail',
      mcpCalls: [
        { server: 'workitem', action: 'query_workitem_detail', tool: 'mcporter:workitem.query_workitem_detail' },
        { server: 'env-config', action: 'list', tool: 'mcporter:env-config.list' }
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

  it('steers the active native turn with exact text and image input without interrupting it', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-steer' } }
      if (method === 'turn/start') return { turn: { id: 'turn-steer' } }
      if (method === 'turn/steer') return { turnId: 'turn-steer' }
      throw new Error(`unexpected request: ${method}`)
    })
    const events: TraceEvent[] = []
    const handle = createCodexAdapter().run({
      runId: 'run-steer', prompt: 'initial', cwd: '/repo', attachments: [], emit: (event) => events.push(event)
    })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))

    await expect(handle.steer?.({
      messageId: 'message-steer',
      prompt: ' preserve exact text  ',
      attachments: [{ kind: 'image', name: 'screen.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=', size: 5 }]
    })).resolves.toEqual({ status: 'accepted', providerTurnId: 'turn-steer' })
    expect(appServer.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-steer',
      expectedTurnId: 'turn-steer',
      clientUserMessageId: 'message-steer',
      input: [
        { type: 'text', text: ' preserve exact text  ', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' }
      ]
    })
    expect(appServer.request).not.toHaveBeenCalledWith('turn/interrupt', expect.anything())
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness', stage: 'runtime:steer_capability', steerCapability: { status: 'available', attachments: true }
    }))
    notify?.('turn/completed', { threadId: 'thread-steer', turnId: 'turn-steer', turn: { id: 'turn-steer', status: 'completed' } })
    await handle.promise
  })

  it('maps explicit native steer rejection and unsupported methods without guessing transport errors', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => { notify = listener; return () => {} })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-reject' } }
      if (method === 'turn/start') return { turn: { id: 'turn-reject' } }
      if (method === 'turn/steer') throw new CodexAppServerResponseError('turn/steer', { code: -32001, message: 'turn cannot accept steering' })
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({ runId: 'run-reject', prompt: 'initial', cwd: '/repo', attachments: [], emit: () => {} })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    await expect(handle.steer?.({ messageId: 'message-reject', prompt: 'follow up', attachments: [] })).resolves.toEqual({
      status: 'rejected', message: 'turn cannot accept steering'
    })
    notify?.('turn/completed', { threadId: 'thread-reject', turnId: 'turn-reject', turn: { status: 'completed' } })
    await handle.promise

    appServer.request.mockClear()
    appServer.request.mockImplementation(async (method) => {
      if (method === 'turn/steer') throw new CodexAppServerResponseError('turn/steer', { code: -32601, message: 'method unavailable' })
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-unavailable' } }
      if (method === 'turn/start') return { turn: { id: 'turn-unavailable' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const unavailable = createCodexAdapter().run({ runId: 'run-unavailable', prompt: 'initial', cwd: '/repo', attachments: [], emit: () => {} })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    await expect(unavailable.steer?.({ messageId: 'message-unavailable', prompt: 'follow up', attachments: [] })).resolves.toEqual({
      status: 'unavailable', message: 'method unavailable'
    })
    notify?.('turn/completed', { threadId: 'thread-unavailable', turnId: 'turn-unavailable', turn: { status: 'completed' } })
    await unavailable.promise
  })

  it('does not turn malformed acknowledgement or native internal failure into accepted/retryable delivery', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    let response: unknown
    appServer.onNotification.mockImplementation(listener => { notify = listener; return () => {} })
    appServer.request.mockImplementation(async method => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-malformed' } }
      if (method === 'turn/start') return { turn: { id: 'turn-malformed' } }
      if (method === 'turn/steer') {
        if (response instanceof Error) throw response
        return response
      }
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({ runId: 'run-malformed', prompt: 'initial', cwd: '/repo', attachments: [], emit: () => {} })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    for (const value of [{}, null, { turnId: 'other-turn' }, new CodexAppServerResponseError('turn/steer', { code: -32603, message: 'internal failure' })]) {
      response = value
      await expect(handle.steer?.({ messageId: 'message-malformed', prompt: 'follow up', attachments: [] })).resolves.toMatchObject({ status: 'unknown' })
    }
    notify?.('turn/completed', { threadId: 'thread-malformed', turn: { id: 'turn-malformed', status: 'completed' } })
    await handle.promise
  })

  it('reports transport timeout as unknown and refuses steering after native completion', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => { notify = listener; return () => {} })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-timeout' } }
      if (method === 'turn/start') return { turn: { id: 'turn-timeout' } }
      if (method === 'turn/steer') throw new Error('Codex app-server request timed out: turn/steer (response_unconfirmed)')
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({ runId: 'run-timeout', prompt: 'initial', cwd: '/repo', attachments: [], emit: () => {} })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    await expect(handle.steer?.({ messageId: 'message-timeout', prompt: 'follow up', attachments: [] })).resolves.toEqual({
      status: 'unknown', message: 'Codex app-server request timed out: turn/steer (response_unconfirmed)'
    })
    notify?.('turn/completed', { threadId: 'thread-timeout', turnId: 'turn-timeout', turn: { status: 'completed' } })
    await handle.promise
    const callsBeforeRefusedSteer = appServer.request.mock.calls.length
    await expect(handle.steer?.({ messageId: 'message-after', prompt: 'too late', attachments: [] })).resolves.toEqual({
      status: 'unavailable', message: 'Codex turn has completed'
    })
    expect(appServer.request.mock.calls.length).toBe(callsBeforeRefusedSteer)
  })

  it('refuses steering when the stop race has ended the run before dispatch', async () => {
    let notify: ((method: string, params: unknown) => void) | undefined
    appServer.onNotification.mockImplementation((listener) => { notify = listener; return () => {} })
    appServer.request.mockImplementation(async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread-stale' } }
      if (method === 'turn/start') return { turn: { id: 'turn-stale' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const handle = createCodexAdapter().run({ runId: 'run-stale', prompt: 'initial', cwd: '/repo', attachments: [], emit: () => {} })
    await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    handle.interrupt()
    const callsBeforeRefusedSteer = appServer.request.mock.calls.length
    await expect(handle.steer?.({ messageId: 'message-stale', prompt: 'too late', attachments: [] })).resolves.toEqual({
      status: 'unavailable', message: 'Codex turn has stopped'
    })
    expect(appServer.request.mock.calls.length).toBe(callsBeforeRefusedSteer)
    notify?.('turn/completed', { threadId: 'thread-stale', turnId: 'turn-stale', turn: { status: 'interrupted' } })
    await handle.promise
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
