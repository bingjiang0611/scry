import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

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

async function waitTerminal(socketPath: string, ca: string, cert: string, key: string, runId: string): Promise<string> {
  let state = 'dispatched'
  let cursor = 0
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !['settled', 'failed', 'cancelled'].includes(state)) {
    const res = await call(socketPath, ca, cert, key, { op: 'watch', runId, cursor, outputCursor: 0, waitMs: 5_000 })
    if (res.error) throw new Error(`watch error: ${res.error}`)
    state = res.watch.state
    cursor = res.watch.poll.cursor
  }
  return state
}

function makeEnospc(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
}

function startHost(
  userDataDir: string,
  daemonStateDirectory: string,
  extra?: {
    mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
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
    ...(extra?.mirrorWriteHook ? { orchestrationMirrorWriteHook: extra.mirrorWriteHook } : {})
  })
}

describe('W9 Blockers B1-B3: DB-authoritative H1 rebuild, atomic mirror rewrite, and off-mode self-heal', () => {
  it('B1a: single fsync ENOSPC after write does not duplicate seq on retry; restart succeeds with monotonic seq, watch, and resolveIntent', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-b1a')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)
    const logPath = join(userDataDir, 'remote', 'ledger', 'session-ledger.log')

    const restore = withOrchEnv('on')
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      let tripped = false
      let compactCalls = 0
      const appendSeqs: number[] = []
      host1 = await startHost(userDataDir, daemonDir, {
        mirrorWriteHook: (op, seq) => {
          if (op === 'compact') {
            compactCalls += 1
            return
          }
          appendSeqs.push(seq)
          if (!tripped && seq === 2) {
            tripped = true
            appendFileSync(
              logPath,
              `${JSON.stringify({ seq: 2, at: Date.now(), runId: randomUUID(), kind: 'run_dispatched' })}\n`,
              { mode: 0o600 }
            )
            throw makeEnospc()
          }
        }
      })
      const device = await enrollLocal(host1.service)
      const ca = host1.service.caCertificatePEM

      const intent1 = randomUUID()
      const sub1 = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'b1a run 1' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      await host1.orchestrationAuthority!.flushLegacyMirror()

      expect(appendSeqs.filter((s) => s === 2)).toHaveLength(1)
      expect(compactCalls).toBeGreaterThanOrEqual(1)

      const beforePoll = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0 })
      const maxSeqBefore = beforePoll.poll.cursor as number
      await host1.dispose()
      host1 = undefined

      host2 = await startHost(userDataDir, daemonDir)
      const watched = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'watch', runId: sub1.runId, cursor: 0, outputCursor: 0, waitMs: 1_000
      })
      expect(watched.error).toBeUndefined()
      expect(watched.watch.state).toBe('settled')

      const resolved = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'resolveIntent', intentId: intent1
      })
      expect(resolved.intent).toEqual({ runId: sub1.runId, state: 'settled' })

      const sub2 = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'b1a run 2' })
      })
      expect(sub2.seq).toBeGreaterThan(maxSeqBefore)
      expect(await waitTerminal(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
    } finally {
      await host2?.dispose()
      await host1?.dispose()
      restore()
    }
  })

  it('B1b: short write followed by recovery rewrites H1 atomically; restart succeeds without ledger_file_corrupt', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-b1b')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)
    const logPath = join(userDataDir, 'remote', 'ledger', 'session-ledger.log')

    const restore = withOrchEnv('on')
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      let tripped = false
      host1 = await startHost(userDataDir, daemonDir, {
        mirrorWriteHook: (op, seq) => {
          if (op === 'append' && !tripped && seq === 2) {
            tripped = true
            appendFileSync(logPath, '{"seq":2,"kind":"run_disp', { mode: 0o600 })
            throw makeEnospc()
          }
        }
      })
      const device = await enrollLocal(host1.service)
      const ca = host1.service.caCertificatePEM

      const intent1 = randomUUID()
      const sub1 = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'b1b short write' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      await host1.orchestrationAuthority!.flushLegacyMirror()
      const maxSeqBefore = (await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0 })).poll.cursor as number
      await host1.dispose()
      host1 = undefined

      host2 = await startHost(userDataDir, daemonDir)
      const watched = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'watch', runId: sub1.runId, cursor: 0, outputCursor: 0, waitMs: 1_000
      })
      expect(watched.error).toBeUndefined()
      expect(watched.watch.state).toBe('settled')

      const resolved = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'resolveIntent', intentId: intent1
      })
      expect(resolved.intent).toEqual({ runId: sub1.runId, state: 'settled' })

      const sub2 = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'b1b after restart' })
      })
      expect(sub2.seq).toBeGreaterThan(maxSeqBefore)
    } finally {
      await host2?.dispose()
      await host1?.dispose()
      restore()
    }
  })

  it('B2 + off-mode self-heal: persistent ENOSPC degrades H1 fallback only, on mode continues, restart rebuilds from DB, and switching back to off regenerates H1 cleanly', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonDir = join(userDataDir, 'daemon')
    const ws = join(root, 'ws-b2')
    mkdirSync(ws, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(ws)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restoreOn = withOrchEnv('on')
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let hostOff: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    const logs: string[] = []
    try {
      host1 = await startHost(userDataDir, daemonDir, {
        log: (line) => logs.push(line),
        mirrorWriteHook: () => {
          throw makeEnospc()
        }
      })
      const device = await enrollLocal(host1.service)
      const ca = host1.service.caCertificatePEM

      const intent1 = randomUUID()
      const sub1 = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent1,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'b2 run 1' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub1.runId)).toBe('settled')
      await host1.orchestrationAuthority!.flushLegacyMirror()

      expect(logs.some((l) => l.includes('daemon.orchestration-h1-fallback-unavailable'))).toBe(true)
      expect(host1.orchestrationAuthority!.sink.getMeta('h1_fallback_unavailable')).toBe('1')

      const intent2 = randomUUID()
      const sub2 = await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: intent2,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'b2 run 2 during persistent enospc' })
      })
      expect(await waitTerminal(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, sub2.runId)).toBe('settled')
      const maxSeqBefore = (await call(host1.channel.socketPath, ca, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0 })).poll.cursor as number
      await host1.dispose()
      host1 = undefined

      const logPath = join(userDataDir, 'remote', 'ledger', 'session-ledger.log')
      mkdirSync(join(userDataDir, 'remote', 'ledger'), { recursive: true, mode: 0o700 })
      writeFileSync(logPath, '{corrupt truncated line', { mode: 0o600 })

      host2 = await startHost(userDataDir, daemonDir)
      for (const [intentId, runId] of [[intent1, sub1.runId], [intent2, sub2.runId]] as const) {
        const watched = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
          op: 'watch', runId, cursor: 0, outputCursor: 0, waitMs: 1_000
        })
        expect(watched.error).toBeUndefined()
        expect(watched.watch.state).toBe('settled')
        const resolved = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
          op: 'resolveIntent', intentId
        })
        expect(resolved.intent).toEqual({ runId, state: 'settled' })
      }
      const sub3 = await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'b2 run 3 after restart' })
      })
      expect(sub3.seq).toBeGreaterThan(maxSeqBefore)
      expect(await waitTerminal(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, sub3.runId)).toBe('settled')
      const maxSeqAfterOn = (await call(host2.channel.socketPath, ca, device.certPEM, device.keyPEM, { op: 'poll', cursor: 0 })).poll.cursor as number
      await host2.dispose()
      host2 = undefined

      writeFileSync(logPath, '{corrupt before off fallback', { mode: 0o600 })
      process.env.SCRY_ORCHESTRATION = 'off'
      hostOff = await startHost(userDataDir, daemonDir)
      expect(hostOff.orchestrationAuthority).toBeUndefined()
      const watchOff = await call(hostOff.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'watch', runId: sub2.runId, cursor: 0, outputCursor: 0, waitMs: 1_000
      })
      expect(watchOff.error).toBeUndefined()
      expect(watchOff.watch.state).toBe('settled')
      const resolveOff = await call(hostOff.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'resolveIntent', intentId: intent2
      })
      expect(resolveOff.intent).toEqual({ runId: sub2.runId, state: 'settled' })
      const subOff = await call(hostOff.channel.socketPath, ca, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'run in off mode' })
      })
      expect(subOff.seq).toBeGreaterThan(maxSeqAfterOn)
    } finally {
      await hostOff?.dispose()
      await host2?.dispose()
      await host1?.dispose()
      restoreOn()
    }
  })
})
