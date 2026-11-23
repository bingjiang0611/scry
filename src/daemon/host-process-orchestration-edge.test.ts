import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { openOrchestrationDatabase } from '../host-runtime/orchestration/db'
import { ORCHESTRATION_SCHEMA_VERSION } from '../host-runtime/orchestration/schema'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/legacy-ledger-file.fixtures'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitRunTerminal } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)


async function withSmokeEnv<T>(fn: () => Promise<T>): Promise<T> {
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
  try {
    return await fn()
  } finally {
    process.argv.length = saved.argvLen
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
  }
}

describe('Authoritative daemon startup and legacy import', () => {
  it('opens the authoritative database before serving a real run', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-on-refuse')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)
    const logs: string[] = []

    await withSmokeEnv(async () => {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: (line) => logs.push(line)
      })
      try {
        expect(host.orchestrationAuthority).toBeDefined()
        expect(existsSync(join(userDataDir, 'orchestration', 'orchestration.db'))).toBe(true)
        expect(logs.some((line) => line.includes('daemon.orchestration-on-ready'))).toBe(true)

        const device = await enrollLocal(host.service)
        const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'still works' })
        })
        expect(sub.error).toBeUndefined()
        const state = await waitRunTerminal(
          host.channel.socketPath,
          host.service.caCertificatePEM,
          device.certPEM,
          device.keyPEM,
          sub.runId
        )
        expect(state).toBe('settled')
      } finally {
        await host.dispose()
      }
    })
  })

  it.each(['newer_schema', 'corrupt_db', 'locked_db'] as const)(
    'refuses to open the App socket with an unusable orchestration database (%s)',
    async (failureKind) => {
      const root = tempDir()
      const userDataDir = join(root, 'userData')
      const daemonStateDirectory = join(userDataDir, 'daemon')
      const workspace = join(root, `ws-${failureKind}`)
      mkdirSync(workspace, { recursive: true, mode: 0o700 })
      const canonicalWs = realpathSync(workspace)
      createRecentFoldersStore(userDataDir).push(canonicalWs)

      let lockHolder: ReturnType<typeof openOrchestrationDatabase> | undefined
      if (failureKind === 'newer_schema') {
        const handle = openOrchestrationDatabase({ userDataDir })
        handle.db.pragma(`user_version = ${ORCHESTRATION_SCHEMA_VERSION + 7}`)
        handle.close()
      } else if (failureKind === 'corrupt_db') {
        const orchDir = join(userDataDir, 'orchestration')
        mkdirSync(orchDir, { recursive: true, mode: 0o700 })
        writeFileSync(join(orchDir, 'orchestration.db'), 'corrupt-bytes-not-sqlite', { mode: 0o600 })
      } else {
        lockHolder = openOrchestrationDatabase({ userDataDir })
      }

      try {
        await withSmokeEnv(async () => {
          await expect(createDaemonHostProcess({
            userDataDir,
            daemonStateDirectory,
            appPath: process.cwd(),
            resourcesPath: join(process.cwd(), 'resources'),
            appVersion: 'test',
            isPackaged: false,
            createOutputStore: () => new MemoryOutputStore(),
            log: () => undefined
          })).rejects.toThrow()
          expect(existsSync(join(daemonStateDirectory, 'local.sock'))).toBe(false)
        })
      } finally {
        lockHolder?.close()
      }
    }
  )

  it('keeps a 1.2 MB intent body across authoritative restarts and subsequent runs', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-roundtrip')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // Persist the large intent in the authoritative database.
    let run1Id = ''
    await withSmokeEnv(async () => {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      try {
        const device = await enrollLocal(host.service)
        // Build a ~1.05 MB valid intent with 120 KB prompt + 690 KiB UTF-8 text attachments (~940 KB base64)
        const bigPrompt = `large:${'P'.repeat(120_000)}`
        const attA = Buffer.from('A'.repeat(450 * 1024), 'utf8')
        const attB = Buffer.from('B'.repeat(240 * 1024), 'utf8')
        const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: canonicalWs,
            prompt: bigPrompt,
            attachments: [
              { kind: 'text', name: 'part-a.txt', mimeType: 'text/plain', dataBase64: attA.toString('base64'), size: attA.length },
              { kind: 'text', name: 'part-b.txt', mimeType: 'text/plain', dataBase64: attB.toString('base64'), size: attB.length }
            ]
          })
        })
        expect(sub.error).toBeUndefined()
        run1Id = sub.runId
        expect(
          await waitRunTerminal(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, run1Id)
        ).toBe('settled')

        const authority = host.orchestrationAuthority!
        const r1 = authority.sink.getRun(run1Id)
        expect(r1?.lifecycle).toBe('settled')
        expect(r1?.body?.storage).toBe('external')
        expect(r1?.body?.bytes).toBeGreaterThan(1_000_000)
        expect(authority.sink.bodyStore.hasExternalBody(r1!.body!.sha256)).toBe(true)
      } finally {
        await host.dispose()
      }
    })

    // Settle a second run after a restart while the former setting is absent.
    let run2Id = ''
    await withSmokeEnv(async () => {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      try {
        const device = await enrollLocal(host.service)
        const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'written during off' })
        })
        expect(sub.error).toBeUndefined()
        run2Id = sub.runId
        expect(
          await waitRunTerminal(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, run2Id)
        ).toBe('settled')
      } finally {
        await host.dispose()
      }
    })

    // Restart again and verify all three runs in the durable projection.
    await withSmokeEnv(async () => {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      try {
        const authority = host.orchestrationAuthority!
        expect(authority.sink.getRun(run1Id)?.lifecycle).toBe('settled')
        expect(authority.sink.getRun(run2Id)?.lifecycle).toBe('settled')

        const device = await enrollLocal(host.service)
        const sub3 = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'live after import' })
        })
        expect(sub3.error).toBeUndefined()
        expect(
          await waitRunTerminal(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, sub3.runId)
        ).toBe('settled')

        expect(authority.sink.getRun(sub3.runId)?.lifecycle).toBe('settled')
        const intents = authority.sink.listEvents().filter((e) => e.type === 'run.intent_recorded')
        expect(intents).toHaveLength(3)
        expect(new Set(intents.map((e) => e.runId)).size).toBe(3)
        expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        await host.dispose()
      }
    })
  })

  it('fails closed before opening the App socket when legacy import cannot commit', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-import-fence')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const seedStore = new SessionLedgerFileStore(ledgerDir)
    try {
      const ledger = new SessionLedger({ store: seedStore })
      const runId = randomUUID()
      ledger.recordIntent({
        intentId: randomUUID(),
        runId,
        detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'pre-existing' })
      })
      ledger.markDispatched(runId)
      ledger.markSettled(runId)
    } finally {
      seedStore.close()
    }

    await withSmokeEnv(async () => {
      await expect(createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined,
        orchestrationBeforeCommitHook: () => {
          throw Object.assign(new Error('SQLITE_IOERR_WRITE'), { code: 'SQLITE_IOERR_WRITE' })
        }
      })).rejects.toThrow()
      expect(existsSync(join(daemonStateDirectory, 'local.sock'))).toBe(false)
    })
  })

  it('defers >2,000 historical terminal runs until after openLocalChannel while keeping orphan recovery exact', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-deferred-import')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const t0 = 1_700_000_000_000
    const lines: string[] = []
    let seq = 0
    for (let i = 0; i < 2_050; i += 1) {
      const rId = randomUUID()
      lines.push(
        JSON.stringify({
          seq: ++seq,
          at: t0 + i * 10,
          runId: rId,
          kind: 'intent_recorded',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: `hist ${i}` })
        }),
        JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 1, runId: rId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 2, runId: rId, kind: 'run_settled' })
      )
    }
    const orphanId = randomUUID()
    lines.push(
      JSON.stringify({
        seq: ++seq,
        at: t0 + 50_000,
        runId: orphanId,
        kind: 'intent_recorded',
        intentId: randomUUID(),
        detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'orphan open run' })
      }),
      JSON.stringify({ seq: ++seq, at: t0 + 50_001, runId: orphanId, kind: 'run_dispatched' })
    )
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`, { mode: 0o600 })

    const logs: string[] = []
    await withSmokeEnv(async () => {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: (line) => logs.push(line)
      })
      try {
        const authority = host.orchestrationAuthority!
        // Orphan open run is recovered before the socket opens.
        expect(authority.sink.getRun(orphanId)?.lifecycle).toBe('interrupted')

        // Live run can execute immediately while deferred backfill yields in background
        const device = await enrollLocal(host.service)
        const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'live during backfill' })
        })
        expect(sub.error).toBeUndefined()
        expect(
          await waitRunTerminal(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, sub.runId)
        ).toBe('settled')

        await authority.importComplete
        expect(logs.some(line => line.includes('daemon.orchestration-on-import-done'))).toBe(true)
        expect(authority.sink.getRun(sub.runId)?.lifecycle).toBe('settled')
        const totalRuns = (authority.sink.handle.db.prepare('SELECT COUNT(*) AS c FROM orch_p_run').get() as { c: number }).c
        expect(totalRuns).toBe(2_052)
      } finally {
        await host.dispose()
      }
    })
  })
})
