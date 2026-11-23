import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID, webcrypto } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { parseSelfReport } from '../main/background-service-status'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function withOrchOnEnv() {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.argv.push('--remote-debugging-port=0')
  return () => {
    process.argv.length = saved.argvLen
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
  }
}

describe('authoritative status parsing and fencing', () => {
  it('1.3a: parseSelfReport ignores null or non-object orchestration field without dropping the entire self-report', () => {
    const base = {
      version: '1.0.0',
      pid: 12345,
      startedAt: 1_700_000_000_000,
      devices: { state: 'remote-disabled' as const },
      activeRuns: 0
    }
    expect(parseSelfReport({ ...base, orchestration: null })).toEqual(base)
    expect(parseSelfReport({ ...base, orchestration: 'on' })).toEqual(base)
    expect(parseSelfReport({ ...base, orchestration: 42 })).toEqual(base)
    expect(parseSelfReport({ ...base, orchestration: ['on'] })).toEqual(base)
  })

  it('1.3b: daemon status truthfully reflects fenced (writeIndeterminate) orchestration engine', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-w16-fenced')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = withOrchOnEnv()
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let tripCommit = false
    try {
      host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory: daemonDir,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined,
        orchestrationBeforeCommitHook: () => {
          if (tripCommit) throw new Error('SQLITE_IOERR simulated fence')
        }
      })
      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM

      const healthy = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'localBackgroundService',
        method: 'status',
        args: []
      })
      expect(healthy.result.orchestration).toEqual({
        mode: 'on',
        writeIndeterminate: false
      })

      tripCommit = true
      await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'trip fence' })
      })
      expect(host.orchestrationAuthority!.sink.isWriteIndeterminate()).toBe(true)

      const fenced = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'localBackgroundService',
        method: 'status',
        args: []
      })
      expect(fenced.result.orchestration).toMatchObject({
        mode: 'on',
        writeIndeterminate: true
      })
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)
})
