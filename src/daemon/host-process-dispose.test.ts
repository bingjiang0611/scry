import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'

const appServer = vi.hoisted(() => ({
  request: vi.fn(),
  shutdown: vi.fn()
}))

vi.mock('../main/providers/codex-app-server', () => ({
  CodexAppServerResponseError: class extends Error {},
  CodexAppServerClient: class {
    request = appServer.request
    requestRunning = appServer.request
    start = async () => {}
    onNotification = () => () => {}
    onRequest = () => () => {}
    failureForCurrentGeneration = () => new Promise<Error>(() => {})
    shutdown = appServer.shutdown
    pid = 456
    close() {}
  }
}))

vi.mock('../main/claude-locate', async () => {
  const actual = await vi.importActual<typeof import('../main/claude-locate')>('../main/claude-locate')
  return {
    ...actual,
    resolveRuntimeCliBin: (name: Parameters<typeof actual.resolveRuntimeCliBin>[0]) =>
      name === 'codex' ? '/bin/codex' : actual.resolveRuntimeCliBin(name),
    runtimeCliEnv: () => ({ PATH: '/usr/bin:/bin' })
  }
})

import { createRecentFoldersStore } from '../main/app-store'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

describe('daemon graceful dispose cleans up pooled provider private env directories', () => {
  it('calls providerRegistry.dispose() on host.dispose() and deletes pooled Codex private MCP env dir', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const privateRoot = join(root, 'private-tmp')
    const workspace = join(root, 'ws-codex-mcp')
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
    mkdirSync(join(workspace, '.codex'), { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // Project stdio MCP server with an env secret triggers writePrivateMcpEnvFiles() on pooled Codex client
    writeFileSync(
      join(canonicalWs, '.codex', 'config.toml'),
      [
        '[mcp_servers.local_secret]',
        'command = "/bin/echo"',
        'args = ["ok"]',
        '[mcp_servers.local_secret.env]',
        'W6_DAEMON_SECRET = "dispose-must-delete-me"'
      ].join('\n') + '\n'
    )

    appServer.request.mockReset().mockResolvedValue({ data: [] })
    appServer.shutdown.mockReset().mockResolvedValue(undefined)

    const savedTmpdir = process.env.TMPDIR
    const savedRelay = process.env.SCRY_REMOTE_RELAY_ENABLED
    const savedSmoke = process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    process.env.TMPDIR = privateRoot
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
    delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER

    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })

      const device = await enrollLocal(host.service)
      const snapshot = await call(
        host.channel.socketPath,
        host.service.caCertificatePEM,
        device.certPEM,
        device.keyPEM,
        {
          op: 'mcp',
          method: 'mcpSnapshot',
          args: [{ context: { providerId: 'codex', cwd: canonicalWs }, refresh: true }]
        }
      )
      expect(snapshot.error).toBeUndefined()

      // Pooled Codex client created a private env directory under TMPDIR
      const createdDirs = readdirSync(privateRoot).filter((name) => name.startsWith('scry-mcp-config-'))
      expect(createdDirs.length).toBeGreaterThanOrEqual(1)
      const privateDirPaths = createdDirs.map((name) => join(privateRoot, name))

      // Graceful daemon exit MUST dispose providerRegistry -> shutdown pooled client & remove private env dirs
      await host.dispose()
      host = undefined

      expect(appServer.shutdown).toHaveBeenCalled()
      for (const dirPath of privateDirPaths) {
        expect(existsSync(dirPath)).toBe(false)
      }
      expect(readdirSync(privateRoot).filter((name) => name.startsWith('scry-mcp-config-'))).toEqual([])
    } finally {
      if (host) await host.dispose()
      if (savedTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmpdir
      if (savedRelay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
      else process.env.SCRY_REMOTE_RELAY_ENABLED = savedRelay
      if (savedSmoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
      else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = savedSmoke
    }
  })

  it('closes orchestrationShadow before providerRegistry.dispose() and bounds a hanging provider shutdown', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-hanging-provider')
    mkdirSync(join(workspace, '.codex'), { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)
    writeFileSync(
      join(canonicalWs, '.codex', 'config.toml'),
      '[mcp_servers.hang_test]\ncommand = "/bin/echo"\nargs = ["ok"]\n'
    )

    appServer.request.mockReset().mockResolvedValue({ data: [] })
    // Simulate a wedged provider process whose shutdown never resolves
    appServer.shutdown.mockReset().mockReturnValue(new Promise<void>(() => {}))

    const savedRelay = process.env.SCRY_REMOTE_RELAY_ENABLED
    const savedSmoke = process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    const savedOrch = process.env.SCRY_ORCHESTRATION
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
    delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    process.env.SCRY_ORCHESTRATION = 'shadow'

    const logs: string[] = []
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        providerDisposeTimeoutMs: 60,
        createOutputStore: () => new MemoryOutputStore(),
        log: (line) => logs.push(line)
      })

      const device = await enrollLocal(host.service)
      await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'mcp',
        method: 'mcpSnapshot',
        args: [{ context: { providerId: 'codex', cwd: canonicalWs }, refresh: true }]
      })

      const started = performance.now()
      await host.dispose()
      const elapsedMs = performance.now() - started
      host = undefined

      expect(elapsedMs).toBeLessThan(2_000)
      expect(logs.some((line) => line.includes('daemon.provider-dispose-timeout'))).toBe(true)
      // Shadow DB EXCLUSIVE lock MUST already be released even though provider shutdown timed out
      const reopened = EventSink.open({ userDataDir })
      reopened.close()
    } finally {
      if (host) await host.dispose()
      if (savedRelay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
      else process.env.SCRY_REMOTE_RELAY_ENABLED = savedRelay
      if (savedSmoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
      else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = savedSmoke
      if (savedOrch === undefined) delete process.env.SCRY_ORCHESTRATION
      else process.env.SCRY_ORCHESTRATION = savedOrch
    }
  })
})
