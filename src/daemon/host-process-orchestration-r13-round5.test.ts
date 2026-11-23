import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID, webcrypto } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { parseSelfReport } from '../main/background-service-status'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { importLegacyStateIncrementally } from '../host-runtime/orchestration/legacy-import'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitTerminal } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function setSmokeEnv() {
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

describe('historical authority promotion and status parsing', () => {
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

    const restore = setSmokeEnv()
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

  it('promotes a shadow database with more history than the truncated H1 mirror', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    const ws = join(root, 'ws-mf1-gate')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const runs20 = seedH1Runs(ledgerDir, 20, canonicalWs)
    const sink = EventSink.open({ userDataDir, fullfsync: false, checkpointIntervalMs: 0 })
    importLegacyStateIncrementally({ sink, userDataDir, reconcileOpenRuns: false, shadowOnly: true })
    expect(sink.getMeta('orchestration_on_active')).toBeUndefined()
    expect(Number(sink.getMeta('legacy_ledger_seq'))).toBe(80)
    sink.close()

    const logPath = join(ledgerDir, 'session-ledger.log')
    const first20Lines = readFileSync(logPath, 'utf8').trim().split('\n').slice(0, 20)
    writeFileSync(logPath, `${first20Lines.join('\n')}\n`, { mode: 0o600 })

    const restore = setSmokeEnv()
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
      orchestration: { mode: 'on', writeIndeterminate: true }
    })
    expect(parsedOn?.orchestration).toEqual({
      mode: 'on',
      writeIndeterminate: true
    })

    const parsedBadOn = parseSelfReport({
      ...base,
      orchestration: { mode: 'on', writeIndeterminate: 'yes' }
    })
    expect(parsedBadOn).toBeUndefined()
  })
})
