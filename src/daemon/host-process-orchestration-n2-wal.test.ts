import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { loadLegacyLedgerPlanAsync, startDeferredLegacyImport } from '../host-runtime/orchestration/legacy-import'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, cleanupTempDirs, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function setOrchEnv(mode: 'on' | 'shadow') {
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
  process.env.SCRY_ORCHESTRATION = mode
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

function seedLedgerRuns(userDataDir: string, cwd: string, count: number): void {
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
  const lines: string[] = []
  let seq = 0
  const t0 = Date.now() - 120_000
  const prompt = 'x'.repeat(300)
  for (let i = 0; i < count; i += 1) {
    const runId = randomUUID()
    lines.push(
      JSON.stringify({
        seq: ++seq,
        at: t0 + i,
        runId,
        kind: 'intent_recorded',
        intentId: randomUUID(),
        detail: JSON.stringify({ providerId: 'codex', cwd, prompt: `run-${i} ${prompt}` })
      }),
      JSON.stringify({ seq: ++seq, at: t0 + i + 1, runId, kind: 'run_dispatched' }),
      JSON.stringify({ seq: ++seq, at: t0 + i + 2, runId, kind: 'run_settled' })
    )
  }
  writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`, { mode: 0o600 })
}

function walBytes(userDataDir: string): number {
  const walPath = join(userDataDir, 'orchestration', 'orchestration.db-wal')
  try {
    return existsSync(walPath) ? statSync(walPath).size : 0
  } catch {
    return 0
  }
}

describe('W9 Blocker N2: bounded WAL checkpoints during deferred backfill (no whole-backfill pause)', () => {
  it('runs WAL checkpoints between slices during real daemon deferred backfill in on mode and bounds WAL peak size', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-wal-on')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    seedLedgerRuns(userDataDir, canonicalWs, 2_500)

    const restore = setOrchEnv('on')
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

      let walPeak = 0
      const sampler = setInterval(() => {
        const size = walBytes(userDataDir)
        if (size > walPeak) walPeak = size
      }, 5)
      try {
        await host.orchestrationAuthority!.importComplete
      } finally {
        clearInterval(sampler)
      }
      const finalWal = walBytes(userDataDir)
      if (finalWal > walPeak) walPeak = finalWal

      const sink = host.orchestrationAuthority!.sink as unknown as {
        setIdleCheckpointPaused?: unknown
        checkpointCount?: () => number
      }
      expect(sink.setIdleCheckpointPaused).toBeUndefined()
      expect(typeof sink.checkpointCount).toBe('function')
      expect(sink.checkpointCount!()).toBeGreaterThan(0)
      expect(walPeak).toBeLessThanOrEqual(32 * 1024 * 1024)
    } finally {
      await host?.dispose()
      restore()
    }
  }, 30_000)

  it('caps WAL size via periodic PASSIVE + hard-cap TRUNCATE checkpoints in startDeferredLegacyImport', async () => {
    const root = tempDir()
    const workspace = join(root, 'ws-wal-unit')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    seedLedgerRuns(root, workspace, 1_500)

    const sink = EventSink.open({ userDataDir: root, fullfsync: false, checkpointFullfsync: true })
    try {
      const plan = await loadLegacyLedgerPlanAsync(sink, root)
      let walPeak = 0
      const sampler = setInterval(() => {
        const size = walBytes(root)
        if (size > walPeak) walPeak = size
      }, 5)
      let summary
      try {
        const deferred = startDeferredLegacyImport({
          sink,
          userDataDir: root,
          reconcileOpenRuns: false,
          shadowOnly: true,
          plan,
          walCheckpointBytes: 2 * 1024 * 1024,
          walHardCapBytes: 8 * 1024 * 1024
        } as Parameters<typeof startDeferredLegacyImport>[0])
        summary = await deferred.promise
      } finally {
        clearInterval(sampler)
      }
      expect(summary.importedRuns).toBe(1_500)
      const count = (sink as unknown as { checkpointCount?: () => number }).checkpointCount?.() ?? 0
      expect(count).toBeGreaterThan(0)
      expect(walPeak).toBeLessThanOrEqual(16 * 1024 * 1024)
    } finally {
      sink.close()
    }
  }, 20_000)
})
