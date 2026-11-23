import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)


function saveOnEnv() {
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

describe('large legacy import and live runs after restart', () => {
  it('imports 8,192 legacy events and accepts new runs after restart', async () => {
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
    // in the historical ledger file before starting the first daemon.
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
    const legacyLog = join(ledgerDir, 'session-ledger.log')
    const original = Buffer.from(`${seedLines.join('\n')}\n`)
    writeFileSync(legacyLog, original, { mode: 0o600 })

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

      // Live submission remains available while legacy history imports.
      const device = await enrollLocal(host1.service)
      const sub1 = await call(host1.channel.socketPath, host1.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'crosses 8192 cap' })
      })
      expect(sub1).toMatchObject({ status: 'recorded', runId: expect.any(String) })
      const authority1 = host1.orchestrationAuthority!
      await expect.poll(() => authority1.sink.getRun(sub1.runId)?.lifecycle, { timeout: 10_000 }).toBe('settled')

      await authority1.importComplete
      expect(authority1.sink.handle.db.prepare('SELECT COUNT(*) AS count FROM orch_p_run').get())
        .toEqual({ count: 2_049 })
      await host1.dispose()
      host1 = undefined
      expect(existsSync(join(ledgerDir, 'session-ledger.snapshot.json'))).toBe(false)
      expect(readFileSync(legacyLog)).toEqual(original)

      // The next daemon recovers the SQLite projection and accepts new work.
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
      expect(sub2).toMatchObject({ status: 'recorded', runId: expect.any(String) })
      const authority2 = host2.orchestrationAuthority!
      await expect.poll(() => authority2.sink.getRun(sub2.runId)?.lifecycle, { timeout: 10_000 }).toBe('settled')
    } finally {
      await host1?.dispose()
      await host2?.dispose()
      restore()
    }
  }, 30_000)


})
