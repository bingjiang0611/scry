import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, webcrypto } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitTerminal } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(() => {
  vi.unstubAllEnvs()
  cleanupTempDirs()
})

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


function startHost(userDataDir: string, daemonStateDirectory: string) {
  return createDaemonHostProcess({
    userDataDir,
    daemonStateDirectory,
    appPath: process.cwd(),
    resourcesPath: join(process.cwd(), 'resources'),
    appVersion: 'test',
    isPackaged: false,
    createOutputStore: () => new MemoryOutputStore(),
    log: () => undefined
  })
}

describe('durable v3 cursor and receipt recovery', () => {
  it('returns a snapshot for a pruned cursor after restart and preserves settled state', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-n5')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setSmokeEnv()
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host1 = await startHost(userDataDir, daemonDir)
      const device = await enrollLocal(host1.service)
      const ca = host1.service.caCertificatePEM

      const initial = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'subscribe', views: ['activeRuns'], waitMs: 0
      })
      const known = { hostId: initial.subscribe.hostId, logId: initial.subscribe.logId, seq: initial.subscribe.seq }
      const intent1 = randomUUID()
      const sub1 = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'n5 run 1' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      const sink = host1.orchestrationAuthority!.sink
      const pruned = sink.pruneEvents({ olderThanAt: Date.now() + 1 })
      expect(pruned.prunedThrough).toBeGreaterThan(known.seq)
      await host1.dispose()
      host1 = undefined

      host2 = await startHost(userDataDir, daemonDir)
      const reset = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'subscribe', views: ['activeRuns'], known, waitMs: 0
      })
      expect(reset.subscribe).toMatchObject({ mode: 'snapshot', logId: known.logId })
      expect(reset.subscribe.seq).toBeGreaterThanOrEqual(pruned.prunedThrough)
      const observed = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'subscribe', views: ['activeRuns'], trackedRunIds: [sub1.runId], waitMs: 0
      })
      expect(observed.subscribe.snapshot.activeRuns.rows).toContainEqual(
        expect.objectContaining({ runId: sub1.runId, lifecycle: 'settled' })
      )

      const sub2 = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'n5 run 2' })
      })
      expect(sub2.seq).toBeGreaterThan(reset.subscribe.seq)
      expect(await waitTerminal(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
    } finally {
      await host2?.dispose()
      await host1?.dispose()
      restore()
    }
  }, 30_000)

  it('retains runs and sequence numbers across a restart with the stale off value', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-restarts')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setSmokeEnv()
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let hostOff: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host1 = await startHost(userDataDir, daemonDir)
      const device = await enrollLocal(host1.service)
      const ca = host1.service.caCertificatePEM
      const intent1 = randomUUID()
      const sub1 = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'phase 1' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      const r1 = host1.orchestrationAuthority!.sink.listEvents().at(-1)!.seq
      expect(r1).toBeGreaterThanOrEqual(sub1.seq)
      await host1.dispose()
      host1 = undefined

      vi.stubEnv('SCRY_ORCHESTRATION', 'off')
      hostOff = await startHost(userDataDir, daemonDir)
      const intent2 = randomUUID()
      const sub2 = await call(hostOff.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent2,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'phase 2' })
      })
      expect(sub2.seq).toBeGreaterThan(r1)
      expect(await waitTerminal(hostOff.channel.socketPath, ca, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
      const offMaxSeq = hostOff.orchestrationAuthority!.sink.listEvents().at(-1)!.seq
      expect(offMaxSeq).toBeGreaterThanOrEqual(sub2.seq)
      await hostOff.dispose()
      hostOff = undefined

      vi.unstubAllEnvs()
      host2 = await startHost(userDataDir, daemonDir)
      const intent3 = randomUUID()
      const sub3 = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent3,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'phase 3' })
      })
      expect(sub3.seq).toBeGreaterThan(offMaxSeq)
      expect(await waitTerminal(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, sub3.runId)).toBe('settled')

      for (const [intentId, runId] of [
        [intent1, sub1.runId],
        [intent2, sub2.runId],
        [intent3, sub3.runId]
      ] as const) {
        const observed = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
          op: 'subscribe', views: ['activeRuns'], trackedRunIds: [runId], waitMs: 0
        })
        expect(observed.subscribe.snapshot.activeRuns.rows).toContainEqual(
          expect.objectContaining({ runId, lifecycle: 'settled' })
        )
        const r = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
          op: 'resolveIntent',
          intentId
        })
        expect(r.intent).toEqual({ runId, state: 'settled' })
      }
    } finally {
      await host2?.dispose()
      await hostOff?.dispose()
      await host1?.dispose()
      restore()
    }
  }, 30_000)
})
