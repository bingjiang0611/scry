import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { createRecentFoldersStore } from '../main/app-store'

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

    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { mode: 0o700 })
    // The picker stores canonical paths; on macOS tmpdir is /var → /private/var.
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
      const recovered = readFileSync(join(ledgerDirectory, 'session-ledger.log'), 'utf8')
      expect(recovered).toContain(`\"runId\":\"${orphan}\"`)
      expect(recovered).toContain('run_failed')
      expect(recovered).toContain('host_restarted')

      const device = await enrollLocal(host.service)
      const desktop = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'desktop', query: { kind: 'info' }
      })
      expect(desktop.desktop).not.toHaveProperty('sessionActions')
      expect(desktop.desktop).not.toHaveProperty('sessionFork')
      expect(desktop.desktop).not.toHaveProperty('sessionDelete')
      expect(desktop.desktop.workbenchOps).toEqual({ openPath: false, trashItem: false })
      // The App's run controls are served on the local endpoint only. The daemon used to
      // build them and then drop them before the host, so every steer, background-task stop
      // and adopt answered unsupported_op in a real daemon.
      const adopted = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'runControl', method: 'adopt', runId: 'run-not-here'
      })
      expect(adopted.error).toBeUndefined()
      // App channels the daemon answers for its App (B4-L4), over the same local socket and
      // grant; the answers come from the handlers main registers, run against daemon state.
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
      // Conversation ledger reads are served from the daemon's own store; a write that is
      // not migrated yet stays refused rather than answered from part of the table.
      const conversations = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'list', args: [workspace]
      })
      expect(conversations.error).toBeUndefined()
      expect(Array.isArray(conversations.result)).toBe(true)
      // Ledger writes the daemon can make on its own (B4-L4-2b): create, then read it back
      // and rename it, all against the daemon's store.
      // The App's event feed (P3f): a new client starts at the present, then hears of
      // the daemon's own data changes, which used to be dropped.
      const handshake = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'appEvents', cursor: 0, waitMs: 0
      })
      // It carries the current unread set as state (E1b); nothing is unread yet.
      expect(handshake.events.items).toEqual([{ kind: 'attention', snapshot: expect.objectContaining({ unreadSessionKeys: [] }) }])
      const create = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'create', args: [workspace]
      })
      expect(create.error).toBeUndefined()
      const created = create.result as { id: string; revision: number }
      const changed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'appEvents', epoch: handshake.events.epoch, cursor: handshake.events.cursor, waitMs: 1_000
      })
      expect(changed.events.items).toContainEqual({ kind: 'data', event: { kind: 'conversation_changed', conversationId: created.id } })
      const listed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'list', args: [workspace]
      })
      expect((listed.result as Array<{ id: string }>).map((item) => item.id)).toContain(created.id)
      const renamed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'conversation', method: 'update', args: [created.id, created.revision, { kind: 'rename', title: 'from the App' }]
      })
      expect(renamed.error).toBeUndefined()
      // Deletion needs the App's session deletion, fork the Provider fork: not yet served.
      for (const method of ['delete', 'fork']) {
        const refused = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'conversation', method, args: [created.id]
        })
        expect(refused.error).toBe('unsupported_op')
      }
      // A send runs through this daemon's ledger under the caller's grant, with the
      // conversation turn's own run id, so the App can follow it like its own runs.
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
      expect(sent.result).toMatchObject({ disposition: 'created', ledger: { runId: expect.any(String) } })
      const conversationEvents: Array<{ kind: string; detail?: string }> = []
      let conversationState = 'dispatched'
      let conversationCursor = 0
      // Bounded by time, not by replies: each progress marker wakes the watch, and under
      // a parallel suite the markers can spend any reply budget before the run settles.
      const conversationDeadline = Date.now() + 10_000
      while (Date.now() < conversationDeadline && !['settled', 'failed'].includes(conversationState)) {
        const watched = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'watch', runId: sent.result.ledger.runId, cursor: conversationCursor, outputCursor: 0, waitMs: 5_000
        })
        conversationState = watched.watch.state
        conversationCursor = watched.watch.poll.cursor
        conversationEvents.push(...watched.watch.poll.events)
      }
      expect(conversationState).toBe('settled')
      const bound = conversationEvents.map((event) => event.detail ?? '').find((detail) => detail.includes('"event":"bound"'))
      expect(JSON.parse(bound!)).toMatchObject({ ledgerRunId: sent.result.ledger.runId, scryRunId: sent.result.runId })
      // The renderer's read(id) leaves its cursor out; over JSON that arrives as null.
      // Named as absent, the daemon's handler sees what main's does; unnamed, the null
      // is refused, which is the page read that stalled the daemon-mode conversation view.
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
      const afterRun = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'appEvents', epoch: handshake.events.epoch, cursor: changed.events.cursor, waitMs: 0
      })
      // E2: the run that changed is named, under the ledger id the App follows.
      // E3: with where its evidence starts, so a window that never saw it can follow it.
      expect(afterRun.events.items).toContainEqual({ kind: 'run', runId: sent.result.ledger.runId, intentSeq: sent.result.ledger.seq })
      // W1: the pipeline's own window notices for this run, with the in-process payloads,
      // which the daemon's window sink used to drop: the turn ended, the session is known.
      const windowNotices = afterRun.events.items.filter((item: { kind: string }) => item.kind === 'window')
      expect(windowNotices).toContainEqual({ kind: 'window', channel: 'agent:turnDone', payload: expect.objectContaining({ runId: sent.result.runId, providerId: 'codex' }) })
      expect(windowNotices).toContainEqual({ kind: 'window', channel: 'agent:session', payload: expect.objectContaining({ runId: sent.result.runId }) })
      // The run pipeline's own notice, which the daemon's window sink used to drop.
      expect(afterRun.events.items).toContainEqual({ kind: 'data', event: { runId: sent.result.runId, kind: 'turn_recorded' } })
      // E1b: a finished run that nobody viewed is unread in the daemon. This daemon cannot
      // see the App's window, so the App says when the user viewed it, and the set clears.
      const fresh = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'appEvents', cursor: 0, waitMs: 0
      })
      const unread = fresh.events.items.find((item: { kind: string }) => item.kind === 'attention')?.snapshot.unreadSessionKeys as string[]
      // The conversation turn's native session; the directory part may be canonicalized.
      expect(unread).toHaveLength(1)
      expect(unread[0]!.startsWith('codex\u0000\u0000')).toBe(true)
      expect(unread[0]!.endsWith(`\u0000${turn.delivery.nativeSessionId}`)).toBe(true)
      for (const sessionKey of unread) {
        const viewed = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'attentionViewed', sessionKey
        })
        expect(viewed).toEqual({ viewed: true })
      }
      const cleared = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'appEvents', epoch: fresh.events.epoch, cursor: fresh.events.cursor, waitMs: 1_000
      })
      expect(cleared.events.items).toContainEqual({ kind: 'attention', snapshot: expect.objectContaining({ unreadSessionKeys: [] }) })
      // The rename above is announced by the daemon itself; the App no longer stands in.
      expect(afterRun.events.items).toContainEqual({ kind: 'data', event: { kind: 'conversation_changed', conversationId: created.id } })
      // History pages are loaded by the daemon against its own catalog: a session it does
      // not know is refused by the same check the App ran in process.
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
      let cursor = 0
      let outputCursor = 0
      const events: Array<{ kind: string }> = []
      const chunks: unknown[] = []
      let state = 'dispatched'
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && state === 'dispatched') {
        const watched = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'watch', runId, cursor, outputCursor, waitMs: 5_000
        })
        state = watched.watch.state
        cursor = watched.watch.poll.cursor
        outputCursor = watched.watch.output.cursor
        events.push(...watched.watch.poll.events)
        chunks.push(...watched.watch.output.chunks)
      }
      expect(state).toBe('settled')
      expect(events.some((event) => event.kind === 'run_settled')).toBe(true)
      expect(chunks.length).toBeGreaterThan(0)
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
