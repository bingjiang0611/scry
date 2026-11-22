import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { importLegacyStateIncrementally } from '../host-runtime/orchestration/legacy-import'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitTerminal, readH1Run } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function withOrchEnv(mode: 'on' | 'off' | 'shadow' | undefined) {
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

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}


function startHost(
  userDataDir: string,
  daemonStateDirectory: string,
  extra?: {
    mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
    mirrorRetryIntervalMs?: number
    log?: (line: string) => void
  }
) {
  return createDaemonHostProcess({
    userDataDir,
    daemonStateDirectory,
    appPath: process.cwd(),
    resourcesPath: join(process.cwd(), 'resources'),
    appVersion: 'test',
    isPackaged: false,
    createOutputStore: () => new MemoryOutputStore(),
    log: extra?.log ?? (() => undefined),
    ...(extra?.mirrorWriteHook ? { orchestrationMirrorWriteHook: extra.mirrorWriteHook } : {}),
    ...(extra?.mirrorRetryIntervalMs !== undefined
      ? { orchestrationMirrorRetryIntervalMs: extra.mirrorRetryIntervalMs }
      : {})
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

describe('Decision H: authority promotion, fail-closed startup, and compatibility mirror', () => {
  it('promotes a shadow database and imports every subsequent legacy run before accepting new sends', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-n1')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const first90 = seedH1Runs(ledgerDir, 90, canonicalWs)
    const sink = EventSink.open({ userDataDir, fullfsync: false, checkpointIntervalMs: 0 })
    importLegacyStateIncrementally({ sink, userDataDir, reconcileOpenRuns: false, shadowOnly: true })
    sink.close()

    const logPath = join(ledgerDir, 'session-ledger.log')
    const snapshotPath = join(ledgerDir, 'session-ledger.snapshot.json')
    const extraLines: string[] = []
    let seq = 360
    const extraRuns: Array<{ runId: string; intentId: string }> = []
    for (let i = 90; i < 120; i += 1) {
      const runId = randomUUID()
      const intentId = randomUUID()
      extraRuns.push({ runId, intentId })
      extraLines.push(
        JSON.stringify({
          seq: ++seq,
          at: Date.now() - 10_000 + i,
          runId,
          kind: 'intent_recorded',
          intentId,
          detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: `extra ${i}` })
        }),
        JSON.stringify({ seq: ++seq, at: Date.now() - 10_000 + i + 1, runId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: Date.now() - 10_000 + i + 2, runId, kind: 'run_progress', detail: '{"event":"ping"}' }),
        JSON.stringify({ seq: ++seq, at: Date.now() - 10_000 + i + 3, runId, kind: 'run_settled' })
      )
    }
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}${extraLines.join('\n')}\n`, { mode: 0o600 })
    expect(existsSync(snapshotPath)).toBe(false)

    const restore = withOrchEnv(undefined)
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await startHost(userDataDir, daemonDir)
      const authority = host.orchestrationAuthority!
      for (const run of [...first90, ...extraRuns]) {
        expect(authority.sink.getRun(run.runId)?.lifecycle).toBe('settled')
      }
      expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })

      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM
      const lastExtra = extraRuns[extraRuns.length - 1]!
      const watched = await readH1Run(host, device.certPEM, {
        runId: lastExtra.runId, cursor: 0, outputCursor: 0, waitMs: 1_000
      })
      expect(watched.watch.state).toBe('settled')

      const sub = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'run 121' })
      })
      expect(sub.seq).toBeGreaterThan(480)
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, sub.runId)).toBe('settled')
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

  it('rejects a corrupt authority before opening local.sock and preserves the legacy log byte for byte', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(root, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-n2')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    const seeded = seedH1Runs(ledgerDir, 5, canonicalWs)
    const logPath = join(ledgerDir, 'session-ledger.log')
    const logShaBefore = sha256File(logPath)

    const orchDir = join(userDataDir, 'orchestration')
    mkdirSync(orchDir, { recursive: true, mode: 0o700 })
    const db = join(orchDir, 'orchestration.db')
    writeFileSync(db, 'NOT A VALID SQLITE DATABASE CORRUPT BYTES!!!', { mode: 0o600 })
    const dbShaBefore = sha256File(db)

    const restore = withOrchEnv(undefined)
    try {
      await expect(startHost(userDataDir, daemonDir)).rejects.toThrow(/database|SQLITE_NOTADB/)
      expect(existsSync(join(daemonDir, 'local.sock'))).toBe(false)
      expect(sha256File(logPath)).toBe(logShaBefore)
      expect(sha256File(db)).toBe(dbShaBefore)
      const store = new SessionLedgerFileStore(ledgerDir)
      try {
        const ledger = new SessionLedger({ store })
        for (const run of seeded) expect(ledger.runState(run.runId)).toBe('settled')
      } finally {
        store.close()
      }
    } finally {
      restore()
    }
  }, 30_000)

  it('N3: fresh install first on-mode boot immediately writes a valid H1 snapshot even with 0 runs', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const snapshotPath = join(ledgerDir, 'session-ledger.snapshot.json')

    const restore = withOrchEnv('on')
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await startHost(userDataDir, daemonDir)
      expect(existsSync(snapshotPath)).toBe(true)
      expect(host.orchestrationAuthority!.sink.getMeta('h1_seq_floor')).toBeUndefined()
      expect(Number(host.orchestrationAuthority!.sink.getMeta('h1_seq_reserved_until'))).toBe(1024)
      await host.dispose()
      host = undefined

      const store = new SessionLedgerFileStore(ledgerDir)
      try {
        const ledger = new SessionLedger({ store })
        expect(ledger.describe()).toEqual({ runs: 0, events: 0, lastSeq: 0 })
      } finally {
        store.close()
      }
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

  it('h1_fallback_unavailable retries periodically, clears on recovery, and is readable from daemon status interface', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-retry')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = withOrchEnv('on')
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      let injectEnospc = true
      host = await startHost(userDataDir, daemonDir, {
        mirrorRetryIntervalMs: 50,
        mirrorWriteHook: () => {
          if (injectEnospc) throw Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' })
        }
      })
      const device = await enrollLocal(host.service)
      const ca = host.service.caCertificatePEM

      const status1 = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'localBackgroundService',
        method: 'status',
        args: []
      })
      expect(status1.error).toBeUndefined()
      expect(status1.result.orchestration).toMatchObject({ mode: 'on', h1FallbackUnavailable: true })
      expect(status1.result.orchestration.h1FallbackReason).toContain('ENOSPC')

      const sub1 = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'during enospc' })
      })
      expect(await waitTerminal(host.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')

      injectEnospc = false
      const deadline = Date.now() + 5_000
      let recovered = false
      while (Date.now() < deadline) {
        const st = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, {
          op: 'localBackgroundService',
          method: 'status',
          args: []
        })
        if (st.result?.orchestration?.h1FallbackUnavailable === false) {
          recovered = true
          expect(st.result.orchestration.h1FallbackReason).toBeUndefined()
          break
        }
        await new Promise((r) => setTimeout(r, 40))
      }
      expect(recovered).toBe(true)
      expect(host.orchestrationAuthority!.sink.getMeta('h1_fallback_unavailable')).toBe('0')
      await host.dispose()
      host = undefined

      const store = new SessionLedgerFileStore(ledgerDir)
      try {
        const ledger = new SessionLedger({ store })
        expect(ledger.runState(sub1.runId)).toBe('settled')
      } finally {
        store.close()
      }
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)
})
