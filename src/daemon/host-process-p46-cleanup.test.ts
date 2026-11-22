import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConversationStore } from '../main/conversation-store'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/legacy-ledger-file.fixtures'
import { RunRegistry } from '../main/run-registry'
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
