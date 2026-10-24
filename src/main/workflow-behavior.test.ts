import { describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowPlanPreview } from '../shared/workflow'
import { workflowProgressSnapshot, workflowSlotLimit } from '../shared/workflow'
import { MemoryWorkflowStore, type WorkflowStoreRecord } from './workflow-store'
import { WorkflowDispatch, WorkflowRunner, WorkflowSlots } from './workflow-runner'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'

const worker = { role: 'worker' as const, providerId: 'codex' as const }
const reviewer = { role: 'reviewer' as const, providerId: 'qoder' as const }
const call = (blockId: string, role: 'worker' | 'reviewer' = 'worker', inputRefs?: Array<{ nodeId: string }>): WorkflowBlock => ({ kind: 'call', blockId, role, prompt: blockId, inputRefs })
const returned = (nodeId: string): WorkflowBlock => ({ kind: 'return', blockId: 'return', ref: { nodeId } })
function plan(blocks: WorkflowBlock[], id = 'workflow-fixture'): WorkflowPlanPreview {
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'revision', userGoal: 'fixture', workspace: '/fixture', roles: [worker, reviewer], body: { kind: 'sequence', blockId: 'root', blocks } })
  const { programRevision: _revision, ...source } = program
  return makePlanPreview({ ...source, programRevision: workflowRevision(source) }, [], { ...worker, role: 'orchestrator' })
}
function begin(runner: WorkflowRunner, preview: WorkflowPlanPreview) {
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  runner.approve(preview, approval)
  return runner.start(preview, approval)
}

describe('workflow execution contracts (no real Provider)', () => {
  it('a second Provider consumes only declared committed outputs; the root return selects one report', async () => {
    const prompts: string[] = []
    const durable = new Set<string>()
    class ObservedStore extends MemoryWorkflowStore {
      override async save(record: WorkflowStoreRecord) {
        await super.save(record)
        for (const intent of record.intents) durable.add(intent.attemptId)
      }
    }
    const runner = new WorkflowRunner({ store: new ObservedStore(), execute: request => {
      expect(durable.has(request.attemptId)).toBe(true)
      prompts.push(request.prompt)
      return { result: Promise.resolve({ runId: request.attemptId, status: 'completed', output: request.role.role === 'worker' ? 'PRIVATE_SCAN_MARKER' : 'PUBLIC_REPORT', settled: true }), stop: () => true }
    } })
    const result = await begin(runner, plan([call('scan'), call('report', 'reviewer', [{ nodeId: 'scan' }]), returned('report')]))
    expect(prompts[1]).toContain('PRIVATE_SCAN_MARKER')
    expect(result.finalReport).toBe('PUBLIC_REPORT')
    expect(JSON.stringify(workflowProgressSnapshot(result))).not.toContain('PRIVATE_SCAN_MARKER')
  })
  it('a return never leaks an upstream output when a required sibling failed', async () => {
    const runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), execute: request => ({
      result: Promise.resolve({ runId: request.attemptId, status: request.role.role === 'worker' ? 'completed' : 'failed', output: 'PRIVATE_SCAN_MARKER', settled: true }), stop: () => true
    }) })
    const result = await begin(runner, plan([{ kind: 'parallel', blockId: 'both', blocks: [call('scan'), call('verify', 'reviewer')] }, returned('scan')]))
    expect(result.state).toBe('failed')
    expect(result.finalReportStatus).toBe('unavailable')
    expect(result.finalReport).toBeUndefined()
  })
  it('unknown physical scope is not converted to stopped just because the user clicked stop', async () => {
    let runner!: WorkflowRunner
    const preview = plan([call('scan'), returned('scan')])
    runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), slots: new WorkflowSlots(1), execute: () => {
      runner.stop(preview.workflowId)
      return { result: Promise.resolve({ runId: 'pending', status: 'unknown', settled: false }), stop: () => true }
    } })
    const result = await begin(runner, preview)
    expect(result.state).toBe('unknown')
  })
  it('accepts 4096 parallel descriptors, and rejects 4097 before any executor exists', () => {
    const parallel = (count: number): WorkflowBlock => ({ kind: 'parallel', blockId: 'batch', blocks: Array.from({ length: count }, (_, index) => call(`item-${index}`)) })
    expect(() => plan([parallel(4096), returned('item-0')])).not.toThrow()
    expect(() => plan([parallel(4097), returned('item-0')])).toThrow('4096')
  })
  it('rejects cross-sibling/future refs, undeclared roles and non-root returns', () => {
    expect(() => plan([{ kind: 'parallel', blockId: 'batch', blocks: [call('a'), call('b', 'worker', [{ nodeId: 'a' }])] }, returned('a')])).toThrow('前置')
    expect(() => plan([call('a', 'worker', [{ nodeId: 'b' }]), call('b'), returned('a')])).toThrow('前置')
    expect(() => plan([{ kind: 'call', blockId: 'bad', role: 'summarizer', prompt: 'bad' }, returned('bad')])).toThrow('未配置')
    expect(() => plan([{ kind: 'sequence', blockId: 'inner', blocks: [call('a'), returned('a')] }])).toThrow('根 sequence')
  })
  it('never sends the 1001st Agent attempt, never refunds completed attempts, and releases unused admission capacity', async () => {
    const slots = new WorkflowSlots(1)
    let dispatched = 0
    const runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), slots, execute: request => {
      dispatched++
      return { result: Promise.resolve({ runId: request.attemptId, status: 'completed', settled: true, output: 'fixture' }), stop: () => true }
    } })
    const preview = plan([...Array.from({ length: 1001 }, (_, index) => call(`node-${index}`)), returned('node-1000')])
    expect(preview.state).toBe('unavailable')
    // Deliberately bypass public preview admission to prove the execution kernel
    // independently enforces the hard cap if an authoring/admission bug regresses.
    const result = await begin(runner, { ...preview, state: 'ready', unavailableReasons: [] })
    expect(dispatched).toBe(1000)
    expect(result.dispatchAttempts).toBe(1000)
    expect(result.state).toBe('failed')
    expect(slots.active).toBe(0)
  })
  it('retains an uncertain dispatch slot if the first required outcome write fails', async () => {
    class FailingOutcomeStore extends MemoryWorkflowStore {
      private failed = false
      override async save(record: WorkflowStoreRecord) {
        if (!this.failed && record.outcomes.length) { this.failed = true; throw new Error('fixture outcome write failure') }
        await super.save(record)
      }
    }
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store: new FailingOutcomeStore(), slots, execute: () => { throw new Error('dispatch effect unknown') } })
    const preview = plan([call('report'), returned('report')])
    await expect(begin(runner, preview)).rejects.toThrow('fixture outcome write failure')
    expect(runner.snapshot(preview.workflowId)?.state).toBe('unknown')
    expect(slots.active).toBe(1)
  })
  it('commits a non-dispatch refusal before releasing capacity and fences delayed Provider entry', async () => {
    let entered!: () => void
    let release!: () => void
    const committing = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    class DelayedOutcomeStore extends MemoryWorkflowStore {
      override async save(record: WorkflowStoreRecord) {
        if (record.outcomes[0]?.providerDispatch === 'not_attempted') { entered(); await barrier }
        await super.save(record)
      }
    }
    const dispatch = new WorkflowDispatch()
    const nativeRun = vi.fn()
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store: new DelayedOutcomeStore(), slots, execute: () => ({
      result: Promise.reject(dispatch.rejected(new Error('admission refused'))), stop: () => true
    }) })
    const result = begin(runner, plan([call('report'), returned('report')]))
    await committing
    let nextStarted = false
    const next = slots.withSlot(async () => { nextStarted = true }, 'next-root')
    expect(slots.active).toBe(1)
    expect(nextStarted).toBe(false)
    expect(() => { dispatch.onProviderDispatchAttempt(); nativeRun() }).toThrow('admission refused')
    expect(nativeRun).not.toHaveBeenCalled()
    release()
    expect((await result).state).toBe('failed')
    await next
    expect(nextStarted).toBe(true)
    expect(slots.active).toBe(0)
  })
  it('does not release a proven non-dispatch slot when the outcome write fails', async () => {
    class FailingOutcomeStore extends MemoryWorkflowStore {
      override async save(record: WorkflowStoreRecord) {
        if (record.outcomes.length) throw new Error('refusal outcome fsync failed')
        await super.save(record)
      }
    }
    const dispatch = new WorkflowDispatch()
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store: new FailingOutcomeStore(), slots, execute: () => ({
      result: Promise.reject(dispatch.rejected(new Error('admission refused'))), stop: () => true
    }) })
    await expect(begin(runner, plan([call('report'), returned('report')]))).rejects.toThrow('refusal outcome fsync failed')
    expect(slots.active).toBe(1)
  })
  it('settles a proven pre-dispatch stop without refunding the attempt', async () => {
    const preview = plan([call('report'), returned('report')])
    const dispatch = new WorkflowDispatch()
    const slots = new WorkflowSlots(1)
    const runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), slots, execute: () => {
      runner.stop(preview.workflowId)
      return { result: Promise.reject(dispatch.rejected(new Error('admission stopped'))), stop: () => true }
    } })
    const progress = await begin(runner, preview)
    expect(progress.state).toBe('stopped')
    expect(progress.dispatchAttempts).toBe(1)
    expect(progress.attempts[0]).toMatchObject({ state: 'stopped', settled: true, providerDispatch: 'not_attempted' })
    expect(slots.active).toBe(0)
  })
  it('window delivery failure does not turn durable settled work into an unknown scope', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const slots = new WorkflowSlots(1)
      const runner = new WorkflowRunner({ store: new MemoryWorkflowStore(), slots,
        onProgress: () => { throw new Error('WebContents was destroyed') },
        execute: request => ({ result: Promise.resolve({ runId: request.attemptId, status: 'completed', settled: true, output: 'report' }), stop: () => true }) })
      expect((await begin(runner, plan([call('report'), returned('report')]))).state).toBe('completed')
      expect(slots.active).toBe(0)
      expect(warning).toHaveBeenCalled()
    } finally { warning.mockRestore() }
  })
  it('validates explicit slot limits without truncation, and requires verified CPUs for the default', () => {
    expect(workflowSlotLimit(4)).toBe(4)
    expect(workflowSlotLimit(32)).toBe(16)
    expect(workflowSlotLimit(4, 256)).toBe(256)
    for (const value of [0, 257, 1.5]) expect(() => workflowSlotLimit(4, value)).toThrow()
    expect(() => workflowSlotLimit(NaN)).toThrow()
  })
})
