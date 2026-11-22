import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID, webcrypto } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitTerminal, readH1Page, readH1Run } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function withOrchEnv(mode: 'on' | 'off') {
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

describe('W9 Round-4 Decision H: single-snapshot reset (N5), block seq reservation, and on -> off -> on non-reuse', () => {
  it('N5 + block reservation: on restart delivers reset to mid-cursor device, preserves settled state, and avoids per-event h1_seq_floor commits', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-n5')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = withOrchEnv('on')
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host1 = await startHost(userDataDir, daemonDir)
      const device = await enrollLocal(host1.service)
      const ca = host1.service.caCertificatePEM

      const intent1 = randomUUID()
      const sub1 = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'n5 run 1' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      const poll1 = readH1Page(host1, device.certPEM, { cursor: 0 })
      expect(poll1.poll.cursor).toBeGreaterThanOrEqual(3)

      // Block reservation: no per-event h1_seq_floor key; reserved ceiling R = 1024.
      expect(host1.orchestrationAuthority!.sink.getMeta('h1_seq_floor')).toBeUndefined()
      const reservedR = Number(host1.orchestrationAuthority!.sink.getMeta('h1_seq_reserved_until'))
      expect(reservedR).toBe(1024)

      await host1.dispose()
      host1 = undefined

      // Restart in on mode: device holding mid-stream cursor = 2 receives reset to R (1024),
      // ZERO renumbered old events, and watch reports settled state.
      host2 = await startHost(userDataDir, daemonDir)
      const midPoll = readH1Page(host2, device.certPEM, { cursor: 2 })
      expect(midPoll.error).toBeUndefined()
      expect(midPoll.poll.events).toEqual([])
      expect(midPoll.poll.cursor).toBe(reservedR)
      expect(midPoll.poll.reset).toEqual({ requested: 2, availableFrom: reservedR })

      const midWatch = await readH1Run(host2, device.certPEM, {
        runId: sub1.runId,
        cursor: 2,
        outputCursor: 0,
        waitMs: 1_000
      })
      expect(midWatch.error).toBeUndefined()
      expect(midWatch.watch.state).toBe('settled')
      expect(midWatch.watch.poll.reset).toEqual({ requested: 2, availableFrom: reservedR })

      const sub2 = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'n5 run 2' })
      })
      expect(sub2.seq).toBe(reservedR + 1)
      expect(await waitTerminal(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
    } finally {
      await host2?.dispose()
      await host1?.dispose()
      restore()
    }
  }, 30_000)

  it('several authoritative restarts retain runs and avoid reusing H1 sequence numbers', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-on-off-on')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = withOrchEnv('on')
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
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'phase 1 on' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      const r1 = Number(host1.orchestrationAuthority!.sink.getMeta('h1_seq_reserved_until'))
      expect(r1).toBeGreaterThanOrEqual(1024)
      await host1.dispose()
      host1 = undefined

      process.env.SCRY_ORCHESTRATION = 'off'
      hostOff = await startHost(userDataDir, daemonDir)
      const intent2 = randomUUID()
      const sub2 = await call(hostOff.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent2,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'phase 2 off' })
      })
      expect(sub2.seq).toBeGreaterThan(r1)
      expect(await waitTerminal(hostOff.channel.socketPath, ca, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
      const offMaxSeq = (
        readH1Page(hostOff, device.certPEM, { cursor: r1 })
      ).poll.cursor as number
      expect(offMaxSeq).toBeGreaterThanOrEqual(sub2.seq)
      await hostOff.dispose()
      hostOff = undefined

      process.env.SCRY_ORCHESTRATION = 'on'
      host2 = await startHost(userDataDir, daemonDir)
      const intent3 = randomUUID()
      const sub3 = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent3,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'phase 3 on' })
      })
      expect(sub3.seq).toBeGreaterThan(offMaxSeq)
      expect(await waitTerminal(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, sub3.runId)).toBe('settled')

      for (const [intentId, runId] of [
        [intent1, sub1.runId],
        [intent2, sub2.runId],
        [intent3, sub3.runId]
      ] as const) {
        const w = await readH1Run(host2, device.certPEM, {
          runId,
          cursor: 0,
          outputCursor: 0,
          waitMs: 1_000
        })
        expect(w.error).toBeUndefined()
        expect(w.watch.state).toBe('settled')
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
