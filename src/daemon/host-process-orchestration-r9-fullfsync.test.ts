import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { INLINE_BODY_MAX_BYTES } from '../host-runtime/orchestration/types'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitTerminal } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function saveEnv() {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    orch: process.env.SCRY_ORCHESTRATION,
    fullfsync: process.env.SCRY_ORCHESTRATION_FULLFSYNC,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.env.SCRY_ORCHESTRATION = 'on'
  delete process.env.SCRY_ORCHESTRATION_FULLFSYNC
  process.argv.push('--remote-debugging-port=0')
  return () => {
    process.argv.length = saved.argvLen
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
    if (saved.orch === undefined) delete process.env.SCRY_ORCHESTRATION
    else process.env.SCRY_ORCHESTRATION = saved.orch
    if (saved.fullfsync === undefined) delete process.env.SCRY_ORCHESTRATION_FULLFSYNC
    else process.env.SCRY_ORCHESTRATION_FULLFSYNC = saved.fullfsync
  }
}


describe('W9 Unit R9: macOS fullfsync=ON + checkpoint_fullfsync=ON + 1-commit immediate dispatch', () => {
  it('enables fullfsync=ON and checkpoint_fullfsync=ON by default in on mode, merges immediate submit+dispatch into 1 commit, and preserves trust-gate fallback', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-r9')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restoreEnv = saveEnv()
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

      const authority = host.orchestrationAuthority!
      // Maintainer decision (2026-11-20): both fullfsync and checkpoint_fullfsync ON by default in on mode.
      expect(authority.fullfsync).toBe(true)
      expect(authority.checkpointFullfsync).toBe(true)
      expect(authority.sink.handle.db.pragma('fullfsync', { simple: true })).toBe(1)
      expect(authority.sink.handle.db.pragma('checkpoint_fullfsync', { simple: true })).toBe(1)

      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM

      // 1. Happy-path immediate dispatch: must commit intent+admitted+dispatched in 1 command (1 commit pre-first-token)
      const run1 = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'single-commit immediate dispatch' })
      })
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, run1.runId)).toBe('settled')

      const events1 = authority.sink.listEvents().filter((e) => e.runId === run1.runId)
      const preDispatchEvents = events1.filter((e) =>
        e.type === 'run.intent_recorded' || e.type === 'run.admitted' || e.type === 'run.dispatched'
      )
      expect(preDispatchEvents.map((e) => e.type)).toEqual([
        'run.intent_recorded',
        'run.admitted',
        'run.dispatched'
      ])
      // All 3 pre-first-token events share the SAME commandId -> committed in 1 single SQLite transaction!
      expect(new Set(preDispatchEvents.map((e) => e.commandId)).size).toBe(1)

      // 2. Large body (>16 KiB) also commits in 1 single SQLite transaction with durable external body
      const run2 = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({
          cwd: canonicalWs,
          providerId: 'codex',
          prompt: 'large body single commit ' + 'B'.repeat(INLINE_BODY_MAX_BYTES + 1024)
        })
      })
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, run2.runId)).toBe('settled')
      const events2 = authority.sink.listEvents().filter((e) => e.runId === run2.runId)
      const pre2 = events2.filter((e) =>
        e.type === 'run.intent_recorded' || e.type === 'run.admitted' || e.type === 'run.dispatched'
      )
      expect(new Set(pre2.map((e) => e.commandId)).size).toBe(1)
      expect(authority.sink.getRun(run2.runId)?.body?.storage).toBe('external')

      // 3. Trust gate failure still fails closed and never emits run.dispatched
      writeFileSync(join(canonicalWs, '.mcp.json'), '{broken json')
      const run3 = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'claude', prompt: 'must reject trust gate' })
      })
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, run3.runId)).toBe('failed')
      const events3 = authority.sink.listEvents().filter((e) => e.runId === run3.runId)
      expect(events3.some((e) => e.type === 'run.dispatched')).toBe(false)
      expect(events3.some((e) => e.type === 'run.failed')).toBe(true)

      expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
    } finally {
      await host?.dispose()
      restoreEnv()
    }
  })
})
