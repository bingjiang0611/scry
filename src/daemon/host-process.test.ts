import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, localSubscription, tempDir, waitForProjectedRun } from './host-process.fixtures'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/legacy-ledger-file.fixtures'
import { createRecentFoldersStore } from '../main/app-store'
import type { SubscribeEventItem, SubscribeHint } from '../shared/orchestration-subscribe'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

describe('daemon host process', () => {
  it('fails before serving when a packaged daemon has no private recorder CLI', async () => {
    const root = tempDir()
    await expect(createDaemonHostProcess({
      userDataDir: join(root, 'userData'),
      daemonStateDirectory: join(root, 'state'),
      appPath: join(root, 'resources', 'app.asar'),
      resourcesPath: join(root, 'resources'),
      appVersion: '9.8.7',
      isPackaged: true
    })).rejects.toThrow('daemon_recorder_cli_unavailable')
    expect(existsSync(join(root, 'state', 'local.sock'))).toBe(false)
  })

  it('assembles the run pipeline and host, serves only a unix socket, and disposes it', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const ledgerDirectory = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    const ledgerStore = new SessionLedgerFileStore(ledgerDirectory)
    const ledger = new SessionLedger({ store: ledgerStore })
    const orphan = randomUUID()
    ledger.recordIntent({
      intentId: randomUUID(),
      runId: orphan,
      detail: JSON.stringify({ cwd: root, providerId: 'claude', prompt: 'unknown outcome' })
    })
    ledger.markDispatched(orphan)
    ledgerStore.close()
    const originalLedger = readFileSync(join(ledgerDirectory, 'session-ledger.log'))

    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { mode: 0o700 })
    createRecentFoldersStore(userDataDir).push(realpathSync(workspace))
    const staleAtomicTemp = join(userDataDir, 'app-sessions.json.tmp')
    writeFileSync(staleAtomicTemp, 'stale', { mode: 0o600 })
    const oldRelay = process.env.SCRY_REMOTE_RELAY_ENABLED
    const oldSmoke = process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    const oldLogging = process.env.ELECTRON_ENABLE_LOGGING
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
    process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
    process.env.ELECTRON_ENABLE_LOGGING = '1'
    process.argv.push('--remote-debugging-port=0')
    try {
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
      expect(host.channel.socketPath).toBe(join(daemonStateDirectory, 'local.sock'))
      expect(existsSync(staleAtomicTemp)).toBe(false)
      expect(existsSync(host.channel.socketPath)).toBe(true)
      expect(host.service.relayConfigured).toBe(false)
      const sink = host.orchestrationAuthority!.sink
      expect(sink.getRun(orphan)?.lifecycle).toBe('interrupted')
      expect(sink.listEvents()).toContainEqual(expect.objectContaining({
        runId: orphan, type: 'run.interrupted', payload: expect.objectContaining({ reason: 'host_restarted' })
      }))
      expect(readFileSync(join(ledgerDirectory, 'session-ledger.log'))).toEqual(originalLedger)
      expect(existsSync(join(ledgerDirectory, 'session-ledger.snapshot.json'))).toBe(false)

      const device = await enrollLocal(host.service)
      const desktop = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'desktop', query: { kind: 'info' }
      })
      expect(desktop.desktop.sessionActions).toBe(true)
      expect(desktop.desktop.sessionFork).toBe(true)
      expect(desktop.desktop.sessionDelete).toBe(true)
      expect(desktop.desktop.workbenchOps).toEqual({ openPath: false, trashItem: false })
      const adopted = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'runControl', method: 'adopt', runId: 'run-not-here'
      })
      expect(adopted.error).toBeUndefined()
      const recent = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'projectStore', method: 'recentFolders', args: []
      })
      expect(recent.result).toContain(realpathSync(workspace))
      const health = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'sessionStore', method: 'catalogHealth', args: []
      })
      expect(health.error).toBeUndefined()
      expect(health.result).toBeTruthy()
      const descriptors = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'providerCatalog', method: 'providerDescriptors', args: []
      })
      expect((descriptors.result as Array<{ id: string }>).map((descriptor) => descriptor.id)).toContain('codex')
      const conversations = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'list', args: [workspace]
      })
      expect(conversations.error).toBeUndefined()
      expect(Array.isArray(conversations.result)).toBe(true)
      // The App begins with the current snapshot and then reads daemon changes.
      const handshake = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, localSubscription())
      expect(handshake.subscribe.hints).toEqual([{ kind: 'attention', snapshot: expect.objectContaining({ unreadSessionKeys: [] }) }])
      const create = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'create', args: [workspace]
      })
      expect(create.error).toBeUndefined()
      const created = create.result as { id: string; revision: number }
      const changed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, localSubscription(handshake.subscribe, 1_000))
      expect(changed.subscribe.hints).toContainEqual({ kind: 'data', event: { kind: 'conversation_changed', conversationId: created.id } })
      const listed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'list', args: [workspace]
      })
      expect((listed.result as Array<{ id: string }>).map((item) => item.id)).toContain(created.id)
      const renamed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'update', args: [created.id, created.revision, { kind: 'rename', title: 'from the App' }]
      })
      expect(renamed.error).toBeUndefined()
      const newSession = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'providerContext', method: 'newSession', args: [{ providerId: 'codex', cwd: workspace }]
      })
      expect(newSession).toEqual({ result: true })
      const refused = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'fork', args: [created.id]
      })
      expect(refused.error).toBe('统一对话请求格式或字段不受支持；仅支持普通文本和主进程派生的历史引用')
      const preview = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'preview', args: [created.id, { providerId: 'codex' }]
      })
      expect(preview.error).toBeUndefined()
      const sent = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'send', args: [{
          providerId: 'codex', conversationId: created.id, expectedRevision: preview.result.revision,
          expectedContinuationKey: preview.result.target.continuationKey, commandId: randomUUID(),
          prompt: 'from the conversation', selectedItems: [], confirmFresh: true
        }]
      })
      expect(sent.error).toBeUndefined()
      expect(sent.result).toMatchObject({ status: 'accepted', disposition: 'created', ledger: { runId: expect.any(String) } })
      const runAuthority = host.orchestrationAuthority!
      const conversationRunId = sent.result.runId as string
      let cursor = changed.subscribe
      const runEvents: SubscribeEventItem[] = []
      const hints: SubscribeHint[] = []
      await expect.poll(async () => {
        const next = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, localSubscription(cursor))
        expect(next.error).toBeUndefined()
        cursor = next.subscribe
        runEvents.push(...cursor.events ?? [])
        hints.push(...cursor.hints ?? [])
        return runEvents.some(event => event.runId === conversationRunId && event.type === 'run.settled') &&
          hints.some(hint => hint.kind === 'data' && hint.event.kind === 'turn_recorded' && hint.event.runId === conversationRunId)
      }, { timeout: 15_000 }).toBe(true)
      expect(runAuthority.subscribeHub.liveRunMeta(conversationRunId)?.scryRunId).toBe(conversationRunId)
      const receiptId = sent.result.ledger.runId as string
      const alias = runAuthority.sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')
        .get(receiptId) as { run_id: string } | undefined
      expect(alias?.run_id ?? receiptId).toBe(conversationRunId)
      const unnamed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'read', args: [created.id, null]
      })
      expect(unnamed.error).toContain('统一对话分页游标无效')
      const afterSend = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'read', args: [created.id, null], absent: [1]
      })
      expect(afterSend.error).toBeUndefined()
      const turn = afterSend.result.turns.find((candidate: { runId: string }) => candidate.runId === sent.result.runId)
      expect(turn.delivery.status).toBe('accepted')
      expect(runEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run.intent_recorded', runId: conversationRunId }),
        expect.objectContaining({ type: 'run.session_bound', runId: conversationRunId }),
        expect.objectContaining({ type: 'run.settled', runId: conversationRunId })
      ]))
      const fresh = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, localSubscription())
      const unread = fresh.subscribe.hints.find((item: { kind: string }) => item.kind === 'attention')?.snapshot.unreadSessionKeys as string[]
      expect(unread).toEqual([`conversation\u0000${created.id}`])
      for (const sessionKey of unread) {
        const viewed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'attentionViewed', sessionKey
        })
        expect(viewed).toEqual({ viewed: true })
      }
      const cleared = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, localSubscription(fresh.subscribe, 1_000))
      expect(cleared.subscribe.hints).toContainEqual({ kind: 'attention', snapshot: expect.objectContaining({ unreadSessionKeys: [] }) })
      expect(hints).toContainEqual({ kind: 'data', event: { kind: 'conversation_changed', conversationId: created.id } })
      const history = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'sessionHistory', method: 'loadSession', args: [{ providerId: 'codex', cwd: workspace, externalSessionId: 'not-in-catalog' }]
      })
      expect(history.error).toContain('会话不属于当前 Scry catalog')
      const providers = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'providers', detail: 'metadata'
      })
      expect(providers.providers.find((provider: { providerId?: string; id?: string }) =>
        (provider.providerId ?? provider.id) === 'codex')).not.toMatchObject({ forkSession: true })

      const intentId = randomUUID()
      const submitted = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit', intentId, detail: JSON.stringify({ cwd: workspace, providerId: 'codex', prompt: 'daemon parity' })
      })
      expect(submitted.status).toBe('recorded')
      const runId = submitted.runId as string
      const ca = host.service.caCertificatePEM
      expect(await waitForProjectedRun(host.channel.socketPath, ca, device.certPEM, device.keyPEM, runId)).toBe('settled')
      expect(host.orchestrationAuthority?.sink.listEvents())
        .toContainEqual(expect.objectContaining({ runId, type: 'run.settled' }))
      const output = await call(host.channel.socketPath, ca, device.certPEM, device.keyPEM, { op: 'output', runId, cursor: 0 })
      expect(output.output.chunks.length).toBeGreaterThan(0)
      await host.dispose()
      expect(existsSync(host.channel.socketPath)).toBe(false)
    } finally {
      process.argv.splice(process.argv.indexOf('--remote-debugging-port=0'), 1)
      if (oldRelay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
      else process.env.SCRY_REMOTE_RELAY_ENABLED = oldRelay
      if (oldSmoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
      else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = oldSmoke
      if (oldLogging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
      else process.env.ELECTRON_ENABLE_LOGGING = oldLogging
    }
  }, 30_000)
})
