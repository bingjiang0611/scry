import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitRunTerminal } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)


describe('authoritative daemon lifecycle parity', () => {
  it('preserves submit, conversation settlement, stop, and recovery in a Chinese workspace', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, '测试工作区-中文')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    // Pre-seed an orphaned dispatched H1 run before daemon startup to verify recovery + incremental import
    const ledgerDirectory = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    const orphanRunId = randomUUID()
    const seedStore = new SessionLedgerFileStore(ledgerDirectory)
    try {
      const seedLedger = new SessionLedger({ store: seedStore })
      seedLedger.recordIntent({
        intentId: randomUUID(),
        runId: orphanRunId,
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'orphan before restart' })
      })
      seedLedger.markDispatched(orphanRunId)
    } finally {
      seedStore.close()
    }

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
    process.env.SCRY_ORCHESTRATION = 'shadow'
    process.argv.push('--remote-debugging-port=0')

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

      const authority = host.orchestrationAuthority!
      expect(authority.fullfsync).toBe(true)
      expect(authority.checkpointFullfsync).toBe(true)
      expect(authority.sink.isWriteIndeterminate()).toBe(false)
      const device = await enrollLocal(host.service)

      // Recovery is committed before any App traffic reaches the socket.
      const orphan = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'runControl', method: 'probeLifecycle', runId: orphanRunId
      })
      expect(orphan.lifecycle).toBe('interrupted')
      expect(authority.sink.getRun(orphanRunId)?.lifecycle).toBe(orphan.lifecycle)

      // 1. Multi-turn conversation (3 turns) + H3 settle parity + peer actor / local origin
      const created = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation',
        method: 'create',
        args: [canonicalWs]
      })
      const convId = (created.result as { id: string; revision: number }).id
      const turnRunIds: string[] = []
      for (let turn = 1; turn <= 3; turn += 1) {
        const preview = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'conversation',
          method: 'preview',
          args: [convId, { providerId: 'codex' }]
        })
        const sent = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'conversation',
          method: 'send',
          args: [
            {
              providerId: 'codex',
              conversationId: convId,
              expectedRevision: preview.result.revision,
              expectedContinuationKey: preview.result.target.continuationKey,
              commandId: randomUUID(),
              prompt: `parity turn ${turn}`,
              selectedItems: [],
              confirmFresh: turn === 1
            }
          ]
        })
        expect(sent.error, `turn ${turn}`).toBeUndefined()
        const ledgerRunId = sent.result.ledger.runId as string
        const canonicalRunId = sent.result.runId as string
        turnRunIds.push(canonicalRunId)

        const state = await waitRunTerminal(
          host.channel.socketPath,
          host.service.caCertificatePEM,
          device.certPEM,
          device.keyPEM,
          ledgerRunId
        )
        expect(state, `turn ${turn}`).toBe('settled')

        const projectedRun = authority.sink.getRun(canonicalRunId)
        expect(projectedRun).toMatchObject({
          runId: canonicalRunId,
          sessionKey: convId,
          scope: 'local',
          origin: 'local',
          provider: 'codex',
          cwd: canonicalWs,
          lifecycle: state
        })
        expect(projectedRun?.ownerActor).toMatch(/^peer:[0-9a-f]{64}$/)

        const projectedTurn = authority.sink.getTurn(convId, turn)
        expect(projectedTurn?.runId).toBe(canonicalRunId)
        expect(projectedTurn?.delivery).toBe('accepted')
      }
      expect(turnRunIds).toHaveLength(3)

      // Real dispatch consumes the durable outbox rows.
      for (const row of authority.sink.listOutbox()) {
        expect(row.state).toBe('done')
        expect(row.payload.shadowOnly).not.toBe(true)
      }

      // 2. Stop a live run and compare its terminal state with the authoritative projection.
      const stopIntent = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: 'performance paced stream' })
      })
      expect(stopIntent.error).toBeUndefined()
      const stopLedgerRunId = stopIntent.runId as string
      await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'stop',
        runId: stopLedgerRunId
      })
      const stoppedState = await waitRunTerminal(
        host.channel.socketPath,
        host.service.caCertificatePEM,
        device.certPEM,
        device.keyPEM,
        stopLedgerRunId
      )
      expect(['cancelled', 'interrupted']).toContain(stoppedState)
      expect(authority.sink.getRun(stopLedgerRunId)?.lifecycle).toBe(stoppedState)
      expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
    } finally {
      await host?.dispose()
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
  })

})
