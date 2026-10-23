import { randomUUID } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowApproval, WorkflowControlFrame } from '../shared/workflow'
import type { WorkflowRetryTarget } from '../shared/workflow-api'
import { WorkflowDispatch, WorkflowRunner, type WorkflowProviderExecutionRequest, type WorkflowProviderExecutor } from './workflow-runner'
import { MemoryWorkflowStore } from './workflow-store'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { assertWorkflowRecovery } from './workflow-recovery'
import { workflowRetryCopy as copy } from '../shared/constants/copy'

async function fixture(failures = 1, body?: WorkflowBlock, store = new MemoryWorkflowStore()) {
  const calls: string[] = []
  const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
  const call = (blockId: string): WorkflowBlock => ({ kind: 'call', blockId, role: 'worker', prompt: blockId })
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-' + randomUUID(), programRevision: 'pending', workspace: '/fixture', userGoal: 'retry', roles: [role], body: body ?? {
    kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'parallel', blockId: 'fan', blocks: [call('a'), call('b'), call('c')] },
      { kind: 'call', blockId: 'combine', role: 'worker', prompt: 'combine', inputRefs: [{ nodeId: 'a' }, { nodeId: 'b' }, { nodeId: 'c' }] },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'combine' } }
    ]
  } })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  const preview = makePlanPreview(program, [], role)
  const approval: WorkflowApproval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  let remaining = failures
  const execute = vi.fn<WorkflowProviderExecutor>((request: WorkflowProviderExecutionRequest) => {
    const node = request.taskId.split(':').at(-1)!
    calls.push(node)
    const refused = node === 'b' && remaining-- > 0
    return { result: refused ? Promise.reject(new WorkflowDispatch().rejected(new Error('fixture preflight refusal')))
      : Promise.resolve({ runId: randomUUID(), status: 'completed' as const, settled: true, output: node + '-result' }), stop: () => true }
  })
  const runner = new WorkflowRunner({ store, execute })
  const record = async () => (await store.load(preview.workflowId))!
  const target = async (): Promise<WorkflowRetryTarget> => {
    const current = await record(), failed = [...current.outcomes].reverse().find(outcome => outcome.nodeId === 'b')!
    return { taskId: failed.taskId, attemptId: failed.attemptId, expectedRevision: current.progress.revision! }
  }
  const start = async () => { runner.approve(preview, approval); return runner.start(preview, approval) }
  const retry = async (commandId: string, selected?: WorkflowRetryTarget) => {
    runner.approve(preview, approval)
    return runner.retry(preview, approval, selected ?? await target(), commandId)
  }
  return { store, preview, approval, execute, runner, calls, record, target, start, retry }
}

describe('explicit same-revision, proven pre-Provider retry', () => {
  it('appends one attempt, reuses successful siblings and starts the unstarted consumer', async () => {
    const f = await fixture()
    expect((await f.start()).state).toBe('failed')
    const before = await f.record(), selected = await f.target()
    const result = await f.retry('retry-b', selected), after = await f.record()
    expect(result).toMatchObject({ state: 'completed', dispatchAttempts: 5, finalReport: 'combine-result' })
    expect(f.calls.filter(node => node === 'a')).toHaveLength(1)
    expect(f.calls.filter(node => node === 'c')).toHaveLength(1)
    expect(f.calls.filter(node => node === 'b')).toHaveLength(2)
    expect(f.calls.filter(node => node === 'combine')).toHaveLength(1)
    expect(after.intents.slice(0, 3)).toEqual(before.intents)
    expect(after.outcomes.slice(0, 3)).toEqual(before.outcomes)
    const attempts = after.intents.filter(intent => intent.taskId === selected.taskId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({ previousAttemptId: selected.attemptId, retryCommandId: 'retry-b' })
    expect(attempts[1].attemptId).not.toBe(selected.attemptId)
    assertWorkflowRecovery(after, after.execution!.owner.instanceId)
    expect((await f.runner.retry(f.preview, f.approval, selected, 'retry-b')).state).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(5)
    const cold = new WorkflowRunner({ store: f.store, execute: f.execute })
    expect((await cold.retry(f.preview, f.approval, selected, 'retry-b')).dispatchAttempts).toBe(5)
    expect(f.execute).toHaveBeenCalledTimes(5)
  })

  it('continues an already-approved retry after a pre-intent frame failure instead of creating another retry', async () => {
    class CutEntryStore extends MemoryWorkflowStore {
      cut = false
      override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
        if (this.cut && frame.nodeId === 'b' && frame.generationId) throw new Error('fixture retry entry failure')
        return super.saveFrame(frame, revision)
      }
    }
    const store = new CutEntryStore(), f = await fixture(1, undefined, store)
    await f.start()
    store.cut = true
    await expect(f.retry('retry-before-intent')).rejects.toThrow('entry failure')
    expect((await f.record()).progress.dispatchAttempts).toBe(3)
    await expect(f.retry('another-retry')).rejects.toThrow(copy.pending)
    store.cut = false
    f.runner.approve(f.preview, f.approval)
    expect((await f.runner.resume(f.preview, f.approval, 'continue-approved-retry')).progress?.state).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(5)
    expect((await f.record()).intents.filter(intent => intent.taskId.endsWith(':b'))).toHaveLength(2)
  })

  it('admits only one of two competing retry commands against the same observed failure', async () => {
    const f = await fixture()
    await f.start()
    const selected = await f.target(), other = new WorkflowRunner({ store: f.store, execute: f.execute })
    f.runner.approve(f.preview, f.approval)
    other.approve(f.preview, f.approval)
    const results = await Promise.allSettled([f.runner.retry(f.preview, f.approval, selected, 'retry-one'), other.retry(f.preview, f.approval, selected, 'retry-two')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.execute).toHaveBeenCalledTimes(5)
    expect((await f.record()).intents.filter(intent => intent.taskId === selected.taskId)).toHaveLength(2)
  })

  it('does not turn plain continuation into another attempt', async () => {
    const f = await fixture()
    await f.start()
    f.runner.approve(f.preview, f.approval)
    const resumed = await f.runner.resume(f.preview, f.approval, 'continue-failure')
    expect(resumed.progress?.state).toBe('failed')
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect((await f.record()).progress.dispatchAttempts).toBe(3)
  })

  it('caps the same logical task at six admitted attempts without resetting the root budget', async () => {
    const f = await fixture(10)
    await f.start()
    for (let attempt = 2; attempt <= 6; attempt++) expect((await f.retry('retry-' + attempt)).state).toBe('failed')
    const before = await f.record()
    expect(before.intents.filter(intent => intent.role === 'worker' && intent.taskId.endsWith(':b'))).toHaveLength(6)
    expect(before.progress.dispatchAttempts).toBe(8)
    await expect(f.retry('retry-7')).rejects.toThrow(copy.limit)
    expect(await f.record()).toEqual(before)
    expect(f.execute).toHaveBeenCalledTimes(8)
  })

  it.each(['completed', 'stopped', 'unknown', 'no-proof', 'unsettled'] as const)('refuses %s without creating a segment or dispatch', async state => {
    const f = await fixture()
    await f.start()
    const current = await f.record(), selected = await f.target()
    const outcome = current.outcomes.find(value => value.attemptId === selected.attemptId)!
    if (state === 'no-proof') delete outcome.providerDispatch
    else if (state === 'unsettled') outcome.settled = false
    else outcome.state = state
    await f.store.save(current)
    const before = await f.record()
    await expect(f.retry('unsafe', selected)).rejects.toThrow()
    expect(await f.record()).toEqual(before)
    expect(f.execute).toHaveBeenCalledTimes(3)
  })

  it('does not turn a later physical settlement into safe replay evidence', async () => {
    const f = await fixture(), original = f.execute.getMockImplementation()!
    let close!: () => void
    const settled = new Promise<void>(resolve => { close = resolve })
    f.execute.mockImplementation(request => request.taskId.endsWith(':b') ? {
      result: Promise.resolve({ runId: 'native-failure', status: 'failed', settled: false }), settled, stop: () => true
    } : original(request))
    try {
      await f.start()
      await expect(f.retry('before-close')).rejects.toThrow()
      expect(f.runner.activeWorkflowIds()).toContain(f.preview.workflowId)
      close()
      // Advance the controlled fake's promise callbacks, not a timed retry.
      await nextTurn()
      expect(f.runner.activeWorkflowIds()).toEqual([])
      expect((await f.record()).outcomes.find(outcome => outcome.nodeId === 'b')?.settled).toBe(true)
      await expect(f.retry('after-close')).rejects.toThrow()
      expect((await f.record()).progress.dispatchAttempts).toBe(3)
      expect(f.execute).toHaveBeenCalledTimes(3)
    } finally { close(); await nextTurn() }
  })

  it('rejects stale versions, changed targets and command collisions', async () => {
    const f = await fixture()
    await f.start()
    const target = await f.target(), before = await f.record()
    await expect(f.retry('stale', { ...target, expectedRevision: target.expectedRevision - 1 })).rejects.toThrow(copy.stale)
    await expect(f.retry('wrong-attempt', { ...target, attemptId: 'other' })).rejects.toThrow(copy.stale)
    expect(await f.record()).toEqual(before)
    await f.retry('accepted', target)
    await expect(f.runner.retry(f.preview, f.approval, { ...target, expectedRevision: target.expectedRevision + 1 }, 'accepted')).rejects.toThrow(copy.command)
    await expect(f.runner.resume(f.preview, f.approval, 'accepted')).rejects.toThrow(copy.command)
    expect(f.execute).toHaveBeenCalledTimes(5)
  })

  it('rejects an append-only chain whose predecessor or replay proof was changed', async () => {
    const f = await fixture()
    await f.start()
    await f.retry('retry-b')
    const valid = await f.record()
    for (const damage of ['predecessor', 'proof', 'command'] as const) {
      const record = structuredClone(valid), successor = record.intents.find(intent => intent.previousAttemptId)!
      if (damage === 'predecessor') successor.previousAttemptId = 'other'
      if (damage === 'command') successor.retryCommandId = 'other'
      if (damage === 'proof') delete record.outcomes.find(outcome => outcome.attemptId === successor.previousAttemptId)!.providerDispatch
      expect(() => assertWorkflowRecovery(record, record.execution!.owner.instanceId)).toThrow()
    }
  })

  it('rejects dynamic programs rather than replaying cached map/loop/branch work', async () => {
    const f = await fixture(1, { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'branch', blockId: 'choice', when: { kind: 'literal', value: true }, then: { kind: 'call', blockId: 'b', role: 'worker', prompt: 'b' }, else: { kind: 'bind', blockId: 'unused', value: { kind: 'literal', value: 'unused' } }, unknown: 'blocked' },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'choice' } }
    ] })
    await f.start()
    const before = await f.record()
    await expect(f.retry('dynamic')).rejects.toThrow(copy.dynamic)
    expect(await f.record()).toEqual(before)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
})
