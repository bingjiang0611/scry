import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID, webcrypto } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { parseSelfReport } from '../main/background-service-status'
import { SessionLedger, type LedgerEvent, type LedgerSnapshot, type LedgerStore } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { LegacyMirrorWorker } from '../host-runtime/orchestration/legacy-mirror'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function withOrchOnEnv() {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    orch: process.env.SCRY_ORCHESTRATION,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.env.SCRY_ORCHESTRATION = 'on'
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
  }
}

describe('W16 Part 1: P4-2 non-blocking follow-ups (deferred overflow rebuild, async H1 seq peek, status hardening)', () => {
  it('1.1: mirror queue overflow > 2,048 does NOT invoke createSnapshot synchronously during emit; rebuilds lazily on drain', async () => {
    const root = tempDir()
    const sink = EventSink.open({ userDataDir: root, fullfsync: false, checkpointIntervalMs: 0 })
    let snapshotCalls = 0
    let compactCalls = 0
    const fakeStore: LedgerStore = {
      assertAvailable: () => undefined,
      loadAll: () => [],
      append: () => undefined,
      compact: (_snap: LedgerSnapshot) => {
        compactCalls += 1
      }
    }
    const mirror = new LegacyMirrorWorker({
      sink,
      ledgerStore: fakeStore,
      createSnapshot: () => {
        snapshotCalls += 1
        return { version: 1, lastSeq: 3000, runs: [], retainedEvents: [] }
      },
      idleDelayMs: 120,
      maxPendingEvents: 2_048
    })
    try {
      const runId = SessionLedger.newRunId()
      for (let seq = 1; seq <= 3_000; seq += 1) {
        const ev: LedgerEvent = { seq, at: Date.now(), runId, kind: 'run_progress', detail: String(seq) }
        mirror.enqueue(ev)
      }
      // Critical assertion: ZERO synchronous DB snapshot queries during the 3,000-event emit burst!
      expect(snapshotCalls).toBe(0)
      expect(mirror.hasPendingCompact()).toBe(true)

      await mirror.flush()
      expect(snapshotCalls).toBe(1)
      expect(compactCalls).toBe(1)
      expect(mirror.pendingCount()).toBe(0)
    } finally {
      await mirror.close()
      sink.close()
    }
  })

  it('1.2: on startup reads H1 lastSeq without main-thread sync loadRecovery on off->on and preserves max(R, H1 lastSeq) on on_active=1', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-w16-h1seq')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // Case: orchestration_on_active='1', R=1024, while H1 snapshot + tail advanced to 3200 during fail-open off.
    const sink = EventSink.open({ userDataDir, fullfsync: false, checkpointIntervalMs: 0 })
    sink.setMeta('orchestration_on_active', '1')
    sink.setMeta('h1_seq_reserved_until', '1024')
    sink.close()

    const fsStore = new SessionLedgerFileStore(ledgerDir)
    fsStore.compact({ version: 1, lastSeq: 2500, runs: [], retainedEvents: [] })
    const runId = SessionLedger.newRunId()
    fsStore.append({ seq: 2501, at: Date.now(), runId, kind: 'intent_recorded', intentId: SessionLedger.newIntentId(), detail: '{}' })
    fsStore.append({ seq: 3200, at: Date.now(), runId, kind: 'run_cancelled' })
    fsStore.close()

    const restore = withOrchOnEnv()
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory: daemonDir,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM
      const sub = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'must start at 3201' })
      })
      expect(sub.seq).toBe(3201)
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

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
        writeIndeterminate: false,
        h1FallbackUnavailable: false
      })

      // Trip the storage fence via a commit failure.
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
        writeIndeterminate: true,
        h1FallbackUnavailable: true
      })
      expect(fenced.result.orchestration.h1FallbackReason).toContain('orchestration_write_indeterminate')
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)
})
