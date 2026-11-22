import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

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
    expect(existsSync(join(ledger, 'session-ledger.snapshot.json'))).toBe(false)
    expect(existsSync(join(ledger, 'session-ledger.log'))).toBe(false)
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
    await expect(daemon.request(request)).resolves.toMatchObject({
      status: 'duplicate', runId: first.runId, seq: first.seq
    })
    await expect(daemon.request({ ...request, detail: request.detail.replace('same receipt', 'conflicting receipt') }))
      .resolves.toEqual({ error: 'intent_id_conflict' })
    expect(recovered.handle.db.prepare('SELECT COUNT(*) AS count FROM orch_p_run').get()).toEqual({ count: 1 })
    expect(recovered.getRun(first.runId)?.lifecycle).toBe('settled')
  } finally {
    await daemon.dispose()
  }
})
