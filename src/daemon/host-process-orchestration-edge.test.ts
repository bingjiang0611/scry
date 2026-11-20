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
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

async function waitRunTerminal(
  socketPath: string,
  ca: string,
  cert: string,
  key: string,
  ledgerRunId: string
): Promise<string> {
  let state = 'dispatched'
  let cursor = 0
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !['settled', 'failed', 'cancelled'].includes(state)) {
    const watched = await call(socketPath, ca, cert, key, {
      op: 'watch',
      runId: ledgerRunId,
      cursor,
      outputCursor: 0,
      waitMs: 5_000
    })
    state = watched.watch.state
    cursor = watched.watch.poll.cursor
  }
  return state
}

async function withSmokeEnv<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
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
  if (mode === undefined) delete process.env.SCRY_ORCHESTRATION
  else process.env.SCRY_ORCHESTRATION = mode
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
    if (saved.orch === undefined) delete process.env.SCRY_ORCHESTRATION
    else process.env.SCRY_ORCHESTRATION = saved.orch
  }
}

describe('P4-1 daemon orchestration negative & round-trip edge cases', () => {
  it('refuses SCRY_ORCHESTRATION=on in P4-1 without creating orchestration.db while keeping live runs working', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-on-refuse')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)
    const logs: string[] = []

    await withSmokeEnv('on', async () => {
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
        expect(host.orchestrationShadow).toBeUndefined()
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
    'survives unopenable orchestration.db (%s) and still settles live daemon runs',
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
        await withSmokeEnv('shadow', async () => {
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
            expect(host.orchestrationShadow).toBeDefined()
            expect(host.orchestrationShadow!.mirror.stats().failedOpen).toBe(true)
            expect(host.orchestrationShadow!.mirror.stats().failures).toBeGreaterThanOrEqual(1)

            const device = await enrollLocal(host.service)
            const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
              op: 'submit',
              intentId: randomUUID(),
              detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: `live under ${failureKind}` })
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
      } finally {
        lockHolder?.close()
      }
    }
  )

  it('handles 1.2 MB intent body and shadow -> off -> shadow mixed live+import round-trip cleanly', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-roundtrip')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // Phase 1: live shadow write with 1.2 MB prompt body
    let run1Id = ''
    await withSmokeEnv('shadow', async () => {
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

        const shadow = host.orchestrationShadow!
        const r1 = shadow.mirror.sink!.getRun(run1Id)
        expect(r1?.lifecycle).toBe('settled')
        expect(r1?.body?.storage).toBe('external')
        expect(r1?.body?.bytes).toBeGreaterThan(1_000_000)
        expect(shadow.mirror.sink!.bodyStore.hasExternalBody(r1!.body!.sha256)).toBe(true)
        expect(shadow.mirror.stats().deviations).toBe(0)
      } finally {
        await host.dispose()
      }
    })

    // Phase 2: daemon runs with SCRY_ORCHESTRATION=off and settles a 2nd run in H1 only
    let run2Id = ''
    await withSmokeEnv(undefined, async () => {
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
        expect(host.orchestrationShadow).toBeUndefined()
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

    // Phase 3: restart in shadow -> imports run2 incrementally, then mirrors live run3 with zero deviations
    await withSmokeEnv('shadow', async () => {
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
        const shadow = host.orchestrationShadow!
        expect(shadow.mirror.sink!.getRun(run1Id)?.lifecycle).toBe('settled')
        expect(shadow.mirror.sink!.getRun(run2Id)?.lifecycle).toBe('settled')

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

        expect(shadow.mirror.sink!.getRun(sub3.runId)?.lifecycle).toBe('settled')
        const intents = shadow.mirror.sink!.listEvents().filter((e) => e.type === 'run.intent_recorded')
        expect(intents).toHaveLength(3)
        expect(new Set(intents.map((e) => e.runId)).size).toBe(3)
        expect(shadow.mirror.stats().deviations).toBe(0)
        expect(shadow.mirror.sink!.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        await host.dispose()
      }
    })
  })

  it('trips failedOpen when startup legacy import hits a commit failure while keeping live runs working', async () => {
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

    await withSmokeEnv('shadow', async () => {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined,
        orchestrationShadowBeforeCommitHook: () => {
          throw Object.assign(new Error('SQLITE_IOERR_WRITE'), { code: 'SQLITE_IOERR_WRITE' })
        }
      })
      try {
        expect(host.orchestrationShadow).toBeDefined()
        expect(host.orchestrationShadow!.mirror.stats().failedOpen).toBe(true)
        expect(host.orchestrationShadow!.mirror.stats().failures).toBeGreaterThanOrEqual(1)

        const device = await enrollLocal(host.service)
        const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'live after import fence' })
        })
        expect(sub.error).toBeUndefined()
        expect(
          await waitRunTerminal(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, sub.runId)
        ).toBe('settled')
      } finally {
        await host.dispose()
      }
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
    await withSmokeEnv('shadow', async () => {
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
        expect(logs.some((l) => l.includes('daemon.orchestration-shadow-deferred-import'))).toBe(true)
        const shadow = host.orchestrationShadow!
        // Orphan open run was already imported synchronously before service.start() and settled as failed
        expect(shadow.mirror.sink!.getRun(orphanId)?.lifecycle).toBe('failed')

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

        await shadow.importComplete
        expect(shadow.mirror.sink!.getRun(sub.runId)?.lifecycle).toBe('settled')
        expect(shadow.mirror.stats().deviations).toBe(0)
        const totalRuns = (shadow.mirror.sink!.handle.db.prepare('SELECT COUNT(*) AS c FROM orch_p_run').get() as { c: number }).c
        expect(totalRuns).toBe(2_052)
      } finally {
        await host.dispose()
      }
    })
  })
})
