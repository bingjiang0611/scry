import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import type { LedgerEvent, LedgerStore } from '../main/remote/session-ledger'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { LegacyMirrorWorker } from '../host-runtime/orchestration/legacy-mirror'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function setOnEnv() {
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

async function waitRunTerminal(
  socketPath: string,
  ca: string,
  cert: string,
  key: string,
  runId: string
): Promise<string> {
  let state = 'recorded'
  let cursor = 0
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !['settled', 'failed', 'cancelled'].includes(state)) {
    const watched = await call(socketPath, ca, cert, key, {
      op: 'watch',
      runId,
      cursor,
      outputCursor: 0,
      waitMs: 500
    })
    state = watched.watch.state
    cursor = watched.watch.poll.cursor
  }
  return state
}

describe('W9 Blocker N1: zero-drop, chunk-yielding LegacyMirrorWorker survives ENOSPC and queue overflow across restart', () => {
  it('survives 5 consecutive ENOSPC mirror write failures through real daemon assembly and restarts cleanly without ledger_log_corrupt', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-enospc')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setOnEnv()
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let enospcRemaining = 5
    try {
      host1 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        orchestrationMirrorWriteHook: (op, seq) => {
          // Fail 5 consecutive writes on seq >= 2 with ENOSPC, then allow subsequent writes.
          // Old code dropped seq 2 after 5 retries and appended seq 3+, causing `ledger_log_corrupt` on restart!
          if (op === 'append' && seq >= 2 && enospcRemaining > 0) {
            enospcRemaining -= 1
            const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
            throw err
          }
        },
        log: () => undefined
      })

      const device = await enrollLocal(host1.service)
      const sub1 = await call(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'run during ENOSPC' })
      })
      expect(await waitRunTerminal(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      await host1.dispose()
      host1 = undefined

      // Restart real daemon host2: MUST NOT throw `ledger_log_corrupt`!
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
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'run after ENOSPC restart' })
      })
      expect(await waitRunTerminal(host2.channel.socketPath, host2.service.caCertificatePEM, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
    } finally {
      await host1?.dispose()
      await host2?.dispose()
      restore()
    }
  }, 25_000)

  it('survives mirror queue overflow without dropping seq gaps and restarts cleanly through real daemon assembly', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-overflow')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setOnEnv()
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      // Tiny queue cap (2 events) so a single live run (4+ events) overflows the pending mirror queue!
      // Old code spliced out oldest events (seq 1, 2) and wrote seq 3+, causing `ledger_log_corrupt` on restart!
      host1 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        orchestrationMirrorMaxPendingEvents: 2,
        log: () => undefined
      })

      const device = await enrollLocal(host1.service)
      const sub1 = await call(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'overflow run 1' })
      })
      expect(await waitRunTerminal(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      await host1.dispose()
      host1 = undefined

      // Restart real daemon host2: MUST boot cleanly with contiguous seq / valid snapshot!
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
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'after overflow restart' })
      })
      expect(await waitRunTerminal(host2.channel.socketPath, host2.service.caCertificatePEM, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
    } finally {
      await host1?.dispose()
      await host2?.dispose()
      restore()
    }
  }, 25_000)

  it('yields between #drain slices so draining large backlogs does not monopolize the event loop', async () => {
    const root = tempDir()
    const sink = EventSink.open({ userDataDir: root, checkpointIntervalMs: 0 })
    const written: number[] = []
    const store: LedgerStore = {
      assertAvailable: () => undefined,
      loadAll: () => [],
      append: (event: LedgerEvent) => {
        written.push(event.seq)
      }
    }
    try {
      const mirror = new LegacyMirrorWorker({
        sink,
        ledgerStore: store,
        idleDelayMs: 60_000,
        maxPendingEvents: 500
      })
      const runId = randomUUID()
      for (let seq = 1; seq <= 120; seq += 1) {
        mirror.enqueue({ seq, at: 1_000 + seq, kind: 'run_progress', runId, detail: '{}' })
      }
      // Track how many setImmediate ticks run concurrently with flush()
      let interleavedTicks = 0
      let flushing = true
      const tickProbe = (): void => {
        if (!flushing) return
        interleavedTicks += 1
        setImmediate(tickProbe)
      }
      setImmediate(tickProbe)
      await mirror.flush()
      flushing = false
      expect(written).toHaveLength(120)
      // Must have yielded across multiple slices (default slice <= 32 events => >= 3 yields for 120 events)
      expect(interleavedTicks).toBeGreaterThanOrEqual(2)
      await mirror.close()
    } finally {
      sink.close()
    }
  })
})
