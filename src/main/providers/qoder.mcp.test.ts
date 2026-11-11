import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter
} from './qoder'

const { sdk } = t

describe('Qoder provider adapter · MCP', () => {
  beforeEach(() => resetQoderTestState(t))

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
})
