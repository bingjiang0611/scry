import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID, webcrypto } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { parseSelfReport } from '../main/background-service-status'
import { SessionLedger, SessionLedgerError } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { importLegacyStateIncrementally } from '../host-runtime/orchestration/legacy-import'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitTerminal } from './host-process.fixtures'
import { createAuthorityLedgerStore } from './orchestration-authority-ledger'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function withOrchEnv(mode: 'on' | 'off' | undefined) {
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
  if (mode === undefined) process.env.SCRY_ORCHESTRATION = 'off'
  else process.env.SCRY_ORCHESTRATION = mode
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



function startHost(userDataDir: string, daemonStateDirectory: string, log?: (line: string) => void) {
  return createDaemonHostProcess({
    userDataDir,
    daemonStateDirectory,
    appPath: process.cwd(),
    resourcesPath: join(process.cwd(), 'resources'),
    appVersion: 'test',
    isPackaged: false,
    createOutputStore: () => new MemoryOutputStore(),
    log: log ?? (() => undefined)
  })
}

function seedH1Runs(ledgerDir: string, runCount: number, cwd: string): Array<{ runId: string; intentId: string }> {
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
  const lines: string[] = []
  const seeded: Array<{ runId: string; intentId: string }> = []
  let seq = 0
  const baseAt = Date.now() - 60_000
  for (let i = 0; i < runCount; i += 1) {
    const runId = randomUUID()
    const intentId = randomUUID()
    seeded.push({ runId, intentId })
    lines.push(
      JSON.stringify({
        seq: ++seq,
        at: baseAt + i,
        runId,
        kind: 'intent_recorded',
        intentId,
        detail: JSON.stringify({ cwd, providerId: 'codex', prompt: `seed ${i}` })
      }),
      JSON.stringify({ seq: ++seq, at: baseAt + i + 1, runId, kind: 'run_dispatched' }),
      JSON.stringify({ seq: ++seq, at: baseAt + i + 2, runId, kind: 'run_progress', detail: '{"event":"ping"}' }),
      JSON.stringify({ seq: ++seq, at: baseAt + i + 3, runId, kind: 'run_settled' })
    )
  }
  writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`, { mode: 0o600 })
  return seeded
}

describe('W9 Round-5 Blockers B1-B3 & Must-Fixes 1, 4, 5', () => {
  it('initializes an empty database and imports the legacy runs before admitting work', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-b1-zero')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const seeded = seedH1Runs(ledgerDir, 3, canonicalWs)

    const orchDir = join(userDataDir, 'orchestration')
    mkdirSync(orchDir, { recursive: true, mode: 0o700 })
    const dbPath = join(orchDir, 'orchestration.db')
    writeFileSync(dbPath, '', { mode: 0o600 })
    expect(statSync(dbPath).size).toBe(0)

    const restore = withOrchEnv(undefined)
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await startHost(userDataDir, daemonDir)
      expect(statSync(dbPath).size).toBeGreaterThan(0)
      const authority = host.orchestrationAuthority!
      for (const run of seeded) expect(authority.sink.getRun(run.runId)?.lifecycle).toBe('settled')
      expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

  it('B2a: routine compaction after H1 log exceeds 6 MiB keeps H1 loadable by SessionLedger without ledger_log_corrupt', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-b2a-6mb')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = withOrchEnv('on')
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await startHost(userDataDir, daemonDir)
      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM

      // 8 real runs with ~950 KB detail envelopes push session-ledger.log past COMPACT_AT_BYTES (6 MiB)
      // and trigger routine compaction during live emit().
      const pad = 'x'.repeat(950_000)
      const runIds: string[] = []
      for (let i = 0; i < 8; i += 1) {
        const sub = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: `b2a run ${i}`, pad })
        })
        expect(sub.error).toBeUndefined()
        runIds.push(sub.runId as string)
        expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, sub.runId)).toBe('settled')
        await host.orchestrationAuthority!.flushLegacyMirror()
      }
      await host.dispose()
      host = undefined

      // H1 on disk MUST load cleanly via SessionLedger (no ledger_log_corrupt!).
      const store = new SessionLedgerFileStore(ledgerDir)
      try {
        const ledger = new SessionLedger({ store })
        for (const runId of runIds) {
          expect(ledger.runState(runId)).toBe('settled')
        }
      } finally {
        store.close()
      }
    } finally {
      await host?.dispose()
      restore()
    }
  }, 45_000)

  it('B2b: routine compaction at 8,192 in-memory events keeps H1 loadable by SessionLedger without ledger_log_corrupt and without sync DB rebuild on emit', async () => {
    const root = tempDir()
    const ledgerDir = join(root, 'remote', 'ledger')
    const ws = join(root, 'ws-b2b-8192')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)

    const sink = EventSink.open({ userDataDir: root, fullfsync: false, checkpointIntervalMs: 0 })
    let handle: ReturnType<typeof createAuthorityLedgerStore> | undefined
    try {
      const { AuthorityEngine } = await import('../host-runtime/orchestration/authority-engine')
      const engine = new AuthorityEngine({ sink, leaseOwner: 'test-b2b', pendingTtlMs: 30_000 })
      const peerSha = 'a'.repeat(64)
      handle = createAuthorityLedgerStore({ ledgerDirectory: ledgerDir, sink, log: () => undefined })
      const ledger = new SessionLedger({ store: handle.store })

      // 1. Submit + dispatch run 1 in both orchestration.db and SessionLedger, then emit 8,190 progress
      // events so SessionLedger sits at 8,192 in-memory events (exact compaction threshold).
      const detail1 = JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'run 1' })
      const sub1 = engine.submitSync({
        peerCertSHA256: peerSha,
        grantScope: 'local',
        commandId: randomUUID(),
        detail: detail1
      })
      expect(sub1.kind).toBe('accepted')
      if (sub1.kind !== 'accepted') throw new Error('expected accepted')
      ledger.recordIntent({ intentId: randomUUID(), runId: sub1.runId, detail: detail1 }) // 1
      ledger.markDispatched(sub1.runId) // 2
      for (let i = 0; i < 8_190; i += 1) {
        ledger.markProgress(sub1.runId, `p${i}`) // 3..8192
      }
      expect(ledger.describe().lastSeq).toBe(8_192)

      // 2. Commit run 2 into orchestration.db FIRST (just like host-controller-submit.ts does), then
      // emit intent_recorded into SessionLedger -> crosses 8,192 and triggers store.compact() BEFORE append!
      const detail2 = JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'run 2 crosses 8192' })
      const intent2 = randomUUID()
      const sub2 = engine.submitSync({
        peerCertSHA256: peerSha,
        grantScope: 'local',
        commandId: intent2,
        detail: detail2
      })
      expect(sub2.kind).toBe('accepted')
      if (sub2.kind !== 'accepted') throw new Error('expected accepted')

      // Spy on orch_p_run queries during routine compact+emit: routine compaction MUST NOT call buildH1SnapshotFromDb!
      let dbRunQueriesDuringEmit = 0
      const origPrepare = sink.handle.db.prepare.bind(sink.handle.db)
      sink.handle.db.prepare = ((sql: string) => {
        if (sql.includes('FROM orch_p_run')) dbRunQueriesDuringEmit += 1
        return origPrepare(sql)
      }) as typeof sink.handle.db.prepare
      try {
        ledger.recordIntent({ intentId: intent2, runId: sub2.runId, detail: detail2 })
        ledger.markDispatched(sub2.runId)
        ledger.markSettled(sub2.runId)
      } finally {
        sink.handle.db.prepare = origPrepare
      }
      expect(dbRunQueriesDuringEmit).toBe(0)

      await handle.mirror.flush()
      await handle.close()
      handle = undefined

      // H1 on disk MUST load cleanly via SessionLedger (no ledger_log_corrupt!).
      const store = new SessionLedgerFileStore(ledgerDir)
      try {
        const reloaded = new SessionLedger({ store })
        expect(reloaded.runState(sub1.runId)).toBe('dispatched')
        expect(reloaded.runState(sub2.runId)).toBe('settled')
      } finally {
        store.close()
      }
    } finally {
      await handle?.close()
      sink.close()
    }
  }, 30_000)

  it('B3: fails closed (orchestration_write_indeterminate) and never emits seq 1025 when setMeta throws SQLITE_FULL at 1024->1025 boundary', async () => {
    const root = tempDir()
    const ledgerDir = join(root, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })

    const sink = EventSink.open({ userDataDir: root, fullfsync: false, checkpointIntervalMs: 0 })
    let handle: ReturnType<typeof createAuthorityLedgerStore> | undefined
    try {
      handle = createAuthorityLedgerStore({
        ledgerDirectory: ledgerDir,
        sink,
        log: () => undefined,
        seqReservationBlockSize: 1024
      })
      const ledger = new SessionLedger({ store: handle.store })
      expect(Number(sink.getMeta('h1_seq_reserved_until'))).toBe(1024)

      const runId = SessionLedger.newRunId()
      ledger.recordIntent({ intentId: SessionLedger.newIntentId(), runId, detail: '{}' }) // seq 1
      ledger.markDispatched(runId) // seq 2
      for (let s = 3; s <= 1024; s += 1) {
        ledger.markProgress(runId, `s${s}`)
      }
      expect(ledger.describe().lastSeq).toBe(1024)
      expect(Number(sink.getMeta('h1_seq_reserved_until'))).toBe(1024)

      // Inject SQLITE_FULL right on the 1024 -> 1025 block-reservation write!
      const origSetMeta = sink.setMeta.bind(sink)
      sink.setMeta = ((key: string, value: string) => {
        if (key === 'h1_seq_reserved_until') {
          throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
        }
        return origSetMeta(key, value)
      }) as typeof sink.setMeta

      let caught: unknown
      try {
        ledger.markProgress(runId, 'must-fail-at-1025')
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(SessionLedgerError)
      expect((caught as SessionLedgerError).code).toBe('orchestration_write_indeterminate')
      // Seq 1025 MUST NOT have been emitted; lastSeq & persisted ceiling stay at 1024!
      expect(ledger.describe().lastSeq).toBe(1024)
      expect(Number(sink.getMeta('h1_seq_reserved_until'))).toBe(1024)
    } finally {
      await handle?.close()
      sink.close()
    }
  }, 30_000)

  it('promotes a shadow database with more history than the truncated H1 mirror', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-mf1-gate')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // 1. Seed 20 runs (80 events) and import into shadow DB (orchestration_on_active is NOT set).
    const runs20 = seedH1Runs(ledgerDir, 20, canonicalWs)
    const sink = EventSink.open({ userDataDir, fullfsync: false, checkpointIntervalMs: 0 })
    importLegacyStateIncrementally({ sink, userDataDir, reconcileOpenRuns: false, shadowOnly: true })
    expect(sink.getMeta('orchestration_on_active')).toBeUndefined()
    expect(Number(sink.getMeta('legacy_ledger_seq'))).toBe(80)
    sink.close()

    // 2. Truncate H1 back to only the first 5 runs (20 events < DB's 80!).
    const logPath = join(ledgerDir, 'session-ledger.log')
    const first20Lines = readFileSync(logPath, 'utf8').trim().split('\n').slice(0, 20)
    writeFileSync(logPath, `${first20Lines.join('\n')}\n`, { mode: 0o600 })

    const restore = withOrchEnv(undefined)
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await startHost(userDataDir, daemonDir)
      const authority = host.orchestrationAuthority!
      for (const run of runs20) expect(authority.sink.getRun(run.runId)?.lifecycle).toBe('settled')
      expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM

      const sub = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'new run after truncated mirror' })
      })
      expect(sub.seq).toBeGreaterThan(80)
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, sub.runId)).toBe('settled')
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

  it('Must-Fix 4: on startup takes max(R, H1 lastSeq) inside try/catch so fail-open off residual never reuses seqs', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-mf4-max')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // Simulate orchestration_on_active=1 with R=1024, while a fail-open off session advanced H1 to lastSeq=2500.
    const sink = EventSink.open({ userDataDir, fullfsync: false, checkpointIntervalMs: 0 })
    sink.setMeta('orchestration_on_active', '1')
    sink.setMeta('h1_seq_reserved_until', '1024')
    sink.close()

    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const fsStore = new SessionLedgerFileStore(ledgerDir)
    fsStore.compact({ version: 1, lastSeq: 2500, runs: [], retainedEvents: [] })
    fsStore.close()

    const restore = withOrchEnv('on')
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await startHost(userDataDir, daemonDir)
      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM

      const sub = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'must start above 2500' })
      })
      expect(sub.seq).toBe(2501)
      expect(Number(host.orchestrationAuthority!.sink.getMeta('h1_seq_reserved_until'))).toBe(2500 + 1024)
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

  it('Must-Fix 5: parseSelfReport ignores unknown orchestration.mode without dropping the entire self-report', () => {
    const base = {
      version: '1.0.0',
      pid: 12345,
      startedAt: 1_700_000_000_000,
      devices: { state: 'remote-disabled' as const },
      activeRuns: 0
    }
    const parsedUnknown = parseSelfReport({
      ...base,
      orchestration: { mode: 'future-v3', extraField: true }
    })
    expect(parsedUnknown).toEqual(base)

    const parsedOn = parseSelfReport({
      ...base,
      orchestration: { mode: 'on', h1FallbackUnavailable: true, h1FallbackReason: 'ENOSPC' }
    })
    expect(parsedOn?.orchestration).toEqual({
      mode: 'on',
      h1FallbackUnavailable: true,
      h1FallbackReason: 'ENOSPC'
    })

    // Malformed known mode='on' still fails validation.
    const parsedBadOn = parseSelfReport({
      ...base,
      orchestration: { mode: 'on', h1FallbackUnavailable: 'yes' }
    })
    expect(parsedBadOn).toBeUndefined()
  })
})
