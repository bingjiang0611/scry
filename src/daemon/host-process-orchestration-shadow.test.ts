import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
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

describe('P4-1 daemon orchestration shadow integration', () => {
  it('mirrors send, conversation settle, stop, and recovery parity under shadow mode (including Chinese workspace)', async () => {
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

      expect(host.orchestrationShadow).toBeDefined()
      const shadow = host.orchestrationShadow!
      expect(shadow.mode).toEqual({ requested: 'shadow', effective: 'shadow' })
      expect(shadow.mirror.stats().failures).toBe(0)

      // Orphan run imported as interrupted with unavailable(host_restarted)
      const orphanShadow = shadow.mirror.sink!.getRun(orphanRunId)
      expect(orphanShadow?.lifecycle).toBe('interrupted')
      expect(orphanShadow?.settledAt).toBeNull()

      const device = await enrollLocal(host.service)

      // 1. Conversation send + H3 settle parity
      const created = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation',
        method: 'create',
        args: [canonicalWs]
      })
      const convId = (created.result as { id: string; revision: number }).id
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
            prompt: 'shadow parity check',
            selectedItems: [],
            confirmFresh: true
          }
        ]
      })
      expect(sent.error).toBeUndefined()
      const ledgerRunId = sent.result.ledger.runId as string
      const canonicalRunId = sent.result.runId as string

      const state = await waitRunTerminal(
        host.channel.socketPath,
        host.service.caCertificatePEM,
        device.certPEM,
        device.keyPEM,
        ledgerRunId
      )
      expect(state).toBe('settled')

      // Compare shadow projection against H1 ledger and H3 ConversationStore
      const shadowRun = shadow.mirror.sink!.getRun(canonicalRunId)
      expect(shadowRun?.lifecycle).toBe('settled')
      expect(shadowRun?.cwd).toBe(canonicalWs)
      expect(shadowRun?.provider).toBe('codex')
      expect(shadow.mirror.stats().preFirstTokenCommitsByRun.get(canonicalRunId)).toBe(2)

      const shadowTurn = shadow.mirror.sink!.getTurn(convId, 1)
      expect(shadowTurn?.delivery).toBe('accepted')
      expect(shadow.mirror.stats().failures).toBe(0)

      // 2. Stop path: start a paced run and request stop mid-flight
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
      expect(['cancelled', 'settled', 'failed']).toContain(stoppedState)
      expect(shadow.mirror.sink!.getRun(stopLedgerRunId)?.lifecycle).toBe(stoppedState)
      expect(shadow.mirror.stats().failures).toBe(0)
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

  it('fails open on injected shadow commit failure without affecting the live daemon run', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-failopen')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

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
        log: () => undefined,
        orchestrationShadowBeforeCommitHook: () => {
          throw Object.assign(new Error('SQLITE_IOERR_FSYNC'), { code: 'SQLITE_IOERR_FSYNC' })
        }
      })

      const device = await enrollLocal(host.service)
      const created = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation',
        method: 'create',
        args: [canonicalWs]
      })
      const convId = (created.result as { id: string }).id
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
            prompt: 'run must survive shadow failure',
            selectedItems: [],
            confirmFresh: true
          }
        ]
      })
      expect(sent.error).toBeUndefined()
      const state = await waitRunTerminal(
        host.channel.socketPath,
        host.service.caCertificatePEM,
        device.certPEM,
        device.keyPEM,
        sent.result.ledger.runId
      )
      expect(state).toBe('settled')
      expect(host.orchestrationShadow!.mirror.stats().failures).toBeGreaterThanOrEqual(1)
      expect(host.orchestrationShadow!.mirror.stats().failedOpen).toBe(true)
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

  it('does not create orchestration.db when SCRY_ORCHESTRATION is off', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const saved = {
      relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
      orch: process.env.SCRY_ORCHESTRATION
    }
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
    delete process.env.SCRY_ORCHESTRATION

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
      expect(host.orchestrationShadow).toBeUndefined()
      expect(existsSync(join(userDataDir, 'orchestration', 'orchestration.db'))).toBe(false)
    } finally {
      await host?.dispose()
      if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
      else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
      if (saved.orch === undefined) delete process.env.SCRY_ORCHESTRATION
      else process.env.SCRY_ORCHESTRATION = saved.orch
    }
  })
})
