import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConversationStore } from '../main/conversation-store'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/legacy-ledger-file.fixtures'
import { RunRegistry } from '../main/run-registry'
import { createDaemonRunSurface } from '../main/bootstrap/daemon-run-surface'
import { startDaemonRunEvents } from '../main/daemon-run-events'
import { DaemonRunRuntime } from '../main/daemon-run-runtime'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { attachDaemonOrchestrationAuthority } from './orchestration-authority'

afterEach(cleanupTempDirs)

it('resumes an interrupted legacy import without rewriting the source files', async () => {
  const userDataDir = tempDir()
  const ledgerDirectory = join(userDataDir, 'remote', 'ledger')
  mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
  const store = new SessionLedgerFileStore(ledgerDirectory)
  const ledger = new SessionLedger({ store })
  const runIds = [randomUUID(), randomUUID()]
  try {
    for (const runId of runIds) {
      ledger.recordIntent({ intentId: randomUUID(), runId, detail: JSON.stringify({ providerId: 'codex' }) })
      ledger.markDispatched(runId)
      ledger.markSettled(runId)
    }
  } finally {
    store.close()
  }
  const log = join(ledgerDirectory, 'session-ledger.log')
  const original = readFileSync(log)
  const open = (pauseDeferredImport?: Promise<void>) => {
    const conversationStore = new ConversationStore(userDataDir)
    return attachDaemonOrchestrationAuthority({
      userDataDir, env: {}, conversationStore: () => conversationStore,
      runs: new RunRegistry(), requestRunStop: () => false, log: () => undefined,
      deferredImportThreshold: 1, pauseDeferredImport
    })
  }

  let authority = await open(new Promise(() => {}))
  try {
    authority.startImport()
    expect(runIds.map((id) => authority.sink.getRun(id))).toEqual([undefined, undefined])
    await authority.close()
    authority = await open()
    authority.startImport()
    await authority.importComplete
    expect(runIds.map((id) => authority.sink.getRun(id)?.lifecycle)).toEqual(['settled', 'settled'])
    expect(readFileSync(log)).toEqual(original)
  } finally {
    await authority.close()
  }
})

it('persists run commands without creating the H1 mirror or reserving H1 sequences', async () => {
  const daemon = await startTestDaemon()
  try {
    const sink = daemon.host.orchestrationAuthority!.sink
    const intentId = randomUUID()
    const request = {
      op: 'submit', intentId,
      detail: JSON.stringify({ cwd: daemon.workspace, providerId: 'codex', prompt: 'durable v3 run' })
    }
    const first = await daemon.request(request)
    expect(first).toMatchObject({ status: 'recorded', runId: expect.any(String) })
    await expect.poll(() => sink.getRun(first.runId)?.lifecycle, { timeout: 10_000 }).toBe('settled')
    await expect(daemon.request(request)).resolves.toMatchObject({ status: 'duplicate', runId: first.runId })

    const ledger = join(daemon.userDataDir, 'remote', 'ledger')
    expect(existsSync(ledger)).toBe(false)
    expect(sink.getMeta('h1_seq_reserved_until')).toBeUndefined()
  } finally {
    await daemon.dispose()
  }
})

it('delivers host notices through subscribe with the old App event op retired', async () => {
  const daemon = await startTestDaemon()
  try {
    const request = { op: 'subscribe', views: ['activeRuns', 'sessions'], waitMs: 0 }
    const { subscribe: first } = await daemon.request(request)
    expect(first.mode).toBe('snapshot')
    const notice = daemon.host.hostAdmin.recordNotice({
      kind: 'device_approved_via_cli', deviceLabel: 'W18 test device', fingerprintPrefix: 'abcdef0123456789'
    })
    const reply = await daemon.request({
      ...request, known: { hostId: first.hostId, logId: first.logId, seq: first.seq }
    })
    expect(reply.subscribe.hints).toContainEqual({ kind: 'hostNotice', notice })
    await expect(daemon.request({ op: 'appEvents', cursor: 0, waitMs: 0 })).resolves.toEqual({ error: 'unknown_op' })
  } finally {
    await daemon.dispose()
  }
})

it('returns the original durable receipt after pruning and restart', async () => {
  let daemon = await startTestDaemon()
  try {
    const sink = daemon.host.orchestrationAuthority!.sink
    const request = {
      op: 'submit', intentId: randomUUID(),
      detail: JSON.stringify({ cwd: daemon.workspace, providerId: 'codex', prompt: 'recover same receipt' })
    }
    const first = await daemon.request(request)
    expect(first).toMatchObject({ status: 'recorded', runId: expect.any(String), seq: expect.any(Number) })
    await expect.poll(() => sink.getRun(first.runId)?.lifecycle, { timeout: 10_000 }).toBe('settled')
    expect(sink.pruneEvents({ olderThanAt: Date.now() + 1 }).deletedEvents).toBeGreaterThan(0)
    await daemon.dispose()

    daemon = await startTestDaemon({ root: daemon.root, device: daemon.device })
    const recovered = daemon.host.orchestrationAuthority!.sink
    await expect(daemon.request({ op: 'intentStatusAtLog', intentId: request.intentId }))
      .resolves.toEqual({ intent: { runId: first.runId, state: 'settled' } })
    await expect(daemon.request(request)).resolves.toMatchObject({
      status: 'duplicate', runId: first.runId, seq: first.seq
    })
    await expect(daemon.request({ ...request, detail: request.detail.replace('same receipt', 'conflicting receipt') }))
      .resolves.toEqual({ error: 'command_payload_conflict' })
    expect(recovered.handle.db.prepare('SELECT COUNT(*) AS count FROM orch_p_run').get()).toEqual({ count: 1 })
    expect(recovered.getRun(first.runId)?.lifecycle).toBe('settled')
  } finally {
    await daemon.dispose()
  }
})

it('returns the same canonical App start receipt to a cold window after daemon restart', async () => {
  let daemon = await startTestDaemon()
  const wire = (host: typeof daemon) => {
    const transport = new DaemonRunTransport((frame) => host.request(frame))
    const runtime = new DaemonRunRuntime({ transport, send: () => undefined, bindBudgetMs: 500 })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => host.workspace })
    return { transport, runtime, surface }
  }
  const request = { providerId: 'codex' as const, prompt: 'retain the App start receipt', commandId: randomUUID() }
  const initial = wire(daemon)
  const events = startDaemonRunEvents({ ...initial, send: () => undefined, waitMs: 250 })
  let reopened: ReturnType<typeof wire> | undefined
  try {
    const first = await initial.surface.start(request)
    expect(first).toMatchObject({ runId: /^remote-run-/, commandStatus: 'executed', commandSequence: expect.any(Number) })
    await expect.poll(() => initial.runtime.runView(first.runId)?.done, { timeout: 10_000 }).toBe(true)
    const sink = daemon.host.orchestrationAuthority!.sink
    expect(sink.pruneEvents({ olderThanAt: Date.now() + 1 }).deletedEvents).toBeGreaterThan(0)
    events.dispose()
    initial.runtime.dispose()
    await daemon.dispose()

    daemon = await startTestDaemon({ root: daemon.root, device: daemon.device })
    reopened = wire(daemon)
    const snapshot = await reopened.transport.subscribe({ views: ['activeRuns'], waitMs: 0 })
    expect(snapshot.mode).toBe('snapshot')
    if (snapshot.mode === 'snapshot') await reopened.runtime.applySubscribeSnapshot(snapshot.snapshot.activeRuns?.rows ?? [])
    await expect(reopened.surface.start(request)).resolves.toEqual({ ...first, commandStatus: 'duplicate' })
    expect(daemon.host.orchestrationAuthority!.sink.handle.db.prepare('SELECT COUNT(*) AS count FROM orch_p_run').get())
      .toEqual({ count: 1 })
  } finally {
    events.dispose()
    initial.runtime.dispose()
    reopened?.runtime.dispose()
    await daemon.dispose()
  }
})

it('still aborts a live run while SQLite commits are fenced', async () => {
  let fail = false
  const daemon = await startTestDaemon({ orchestrationBeforeCommitHook: () => {
    if (fail) throw new Error('SQLITE_IOERR disposable test fence')
  } })
  try {
    const request = { op: 'submit', intentId: randomUUID(), detail: JSON.stringify({
      cwd: daemon.workspace, providerId: 'codex', prompt: 'llm performance smoke'
    }) }
    const started = await daemon.request(request)
    const sink = daemon.host.orchestrationAuthority!.sink
    await expect.poll(async () => {
      const reply = await daemon.request({ op: 'subscribe', views: ['activeRuns'], trackedRunIds: [started.runId], waitMs: 0 })
      return reply.subscribe?.snapshot?.activeRuns?.rows?.[0]?.questions?.length ?? 0
    }, { timeout: 10_000 }).toBe(1)

    fail = true
    expect((await daemon.request({ ...request, intentId: randomUUID() })).error).toBeTruthy()
    expect(sink.isWriteIndeterminate()).toBe(true)
    await expect(daemon.request({ op: 'stop', runId: started.runId }))
      .resolves.toEqual({ stop: { status: 'requested' } })
    // The Provider actually exited its blocking question even though the durable store
    // cannot record a terminal transition. No success is synthesized in SQLite.
    await daemon.host.service.controller.idle()
    expect(sink.handle.db.prepare('SELECT lifecycle FROM orch_p_run WHERE run_id = ?').get(started.runId))
      .toEqual({ lifecycle: 'dispatched' })
  } finally {
    fail = false
    await daemon.dispose()
  }
})
