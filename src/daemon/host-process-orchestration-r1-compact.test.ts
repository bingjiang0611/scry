import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { SessionLedger, type LedgerEvent, type LedgerSnapshot, type LedgerStore } from '../main/remote/session-ledger'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { LegacyMirrorWorker } from '../host-runtime/orchestration/legacy-mirror'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

async function waitRunTerminal(
  socketPath: string,
  ca: string,
  cert: string,
  key: string,
  runId: string
): Promise<string> {
  let state = 'dispatched'
  let cursor = 0
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !['settled', 'failed', 'cancelled'].includes(state)) {
    const watched = await call(socketPath, ca, cert, key, {
      op: 'watch',
      runId,
      cursor,
      outputCursor: 0,
      waitMs: 5_000
    })
    state = watched.watch.state
    cursor = watched.watch.poll.cursor
  }
  return state
}

function saveOnEnv() {
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

describe('W9 Blocker 1 + Must-Fix 6: compaction past 8,192 events across daemon restart and bounded replayable legacy mirror', () => {
  it('handles >8,192 ledger events through real daemon createLedgerStore, compacts cleanly, and restarts accepting new runs', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const workspace = join(root, 'ws-compact')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // Pre-seed 2,048 settled runs x 4 events = 8,192 events (right at SessionLedger's MAX_EVENTS cap)
    // directly into the daemon's real H1 ledger file BEFORE starting host1.
    // On the old code (without compaction), the very first live submit on host1 threw `ledger_capacity_exceeded`!
    const seedLines: string[] = []
    let seq = 0
    const baseAt = Date.now() - 60_000
    for (let i = 0; i < 2_048; i += 1) {
      const runId = randomUUID()
      const intentId = randomUUID()
      seedLines.push(JSON.stringify({ seq: ++seq, at: baseAt + i, kind: 'intent_recorded', runId, intentId, detail: '{}' }))
      seedLines.push(JSON.stringify({ seq: ++seq, at: baseAt + i, kind: 'run_dispatched', runId }))
      seedLines.push(JSON.stringify({ seq: ++seq, at: baseAt + i, kind: 'run_progress', runId, detail: '{"event":"ping"}' }))
      seedLines.push(JSON.stringify({ seq: ++seq, at: baseAt + i, kind: 'run_settled', runId }))
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${seedLines.join('\n')}\n`, { mode: 0o600 })

    const restore = saveOnEnv()
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host1 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })

      // Live submit on real host1 crosses 8,192 events inside the daemon's real SessionLedger,
      // triggering compaction through createLedgerStore + LegacyMirrorWorker without jamming.
      const device = await enrollLocal(host1.service)
      const sub1 = await call(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'crosses 8192 cap' })
      })
      expect(await waitRunTerminal(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')

      // Flush mirror & gracefully dispose host1; verify compacted snapshot landed on disk.
      await host1.dispose()
      host1 = undefined
      expect(existsSync(join(ledgerDir, 'session-ledger.snapshot.json'))).toBe(true)

      // Restart real daemon host2 over the compacted >8,192-event ledger + orchestration.db,
      // and verify another live submit succeeds and settles cleanly.
      host2 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const sub2 = await call(host2.channel.socketPath, host2.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'after compact restart' })
      })
      expect(await waitRunTerminal(host2.channel.socketPath, host2.service.caCertificatePEM, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
    } finally {
      await host1?.dispose()
      await host2?.dispose()
      restore()
    }
  }, 30_000)

  it('keeps LegacyMirrorWorker off pre-first-token path, bounded under cap, and resilient to head-of-line failures', async () => {
    const root = tempDir()
    const sink = EventSink.open({ userDataDir: root, checkpointIntervalMs: 0 })
    let appendCalls = 0
    let compactCalls = 0
    let failWrites = true
    const errors: string[] = []
    const fakeStore: LedgerStore = {
      assertAvailable: () => undefined,
      loadAll: () => [],
      append: () => {
        appendCalls += 1
        if (failWrites) throw new Error('ENOSPC simulated')
      },
      compact: (_snap: LedgerSnapshot) => {
        compactCalls += 1
      }
    }
    const mirror = new LegacyMirrorWorker({
      sink,
      ledgerStore: fakeStore,
      idleDelayMs: 120,
      maxPendingEvents: 32,
      maxRetries: 2,
      retryDelayMs: 5,
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err))
    })
    try {
      const runId = SessionLedger.newRunId()
      const evt: LedgerEvent = { seq: 1, at: Date.now(), runId, kind: 'intent_recorded', intentId: SessionLedger.newIntentId(), detail: '{}' }
      mirror.enqueue(evt)
      // Must NOT run immediately on setImmediate (stays off pre-first-token critical path!)
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 15))
      expect(appendCalls).toBe(0)

      // Bounded queue: enqueuing 100 events under maxPendingEvents=32 must cap pending size
      for (let i = 2; i <= 100; i += 1) {
        mirror.enqueue({ seq: i, at: Date.now(), runId, kind: 'run_progress', detail: String(i) })
      }
      expect(mirror.pendingCount()).toBeLessThanOrEqual(32)

      // Head-of-line failure must not stall forever; after maxRetries it drops/advances and reports error
      await mirror.flush()
      expect(errors.length).toBeGreaterThan(0)
      expect(mirror.pendingCount()).toBe(0)

      // Compaction snapshot enqueue works cleanly when writes recover
      failWrites = false
      mirror.enqueueCompact({ version: 1, lastSeq: 100, runs: [], retainedEvents: [] })
      await mirror.flush()
      expect(compactCalls).toBe(1)
    } finally {
      await mirror.close()
      sink.close()
    }
  })
})
