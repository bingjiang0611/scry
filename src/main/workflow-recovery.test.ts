import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowControlFrame } from '../shared/workflow'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowRunner, type WorkflowProviderExecutionRequest } from './workflow-runner'
import { validateWorkflowProgram, workflowRevision, makePlanPreview } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import { workflowRecordFingerprint } from './workflow-recovery'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
class CutParentStore extends FileWorkflowStore {
  override async saveFrame(frame: Omit<WorkflowControlFrame, 'revision'>, revision: number) {
    if (frame.nodeId === 'root' && frame.cursor === 1 && frame.phase === 'entered') throw new Error('fixture parent checkpoint failure')
    return super.saveFrame(frame, revision)
  }
}
async function setup(blocks?: WorkflowBlock[]) {
  const root = await mkdtemp(join(tmpdir(), 'scry-recovery-')); roots.push(root)
  const role = { role: 'worker' as const, providerId: 'claude' as const, runtimeIdentity: 'fixture' }
  const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: 'workflow-' + randomUUID(), programRevision: 'pending', userGoal: 'recovery fixture', workspace: root, roles: [role], body: { kind: 'sequence', blockId: 'root', blocks: blocks ?? [
    { kind: 'call', blockId: 'first', role: 'worker', prompt: 'first' },
    { kind: 'call', blockId: 'second', role: 'worker', prompt: 'second', inputRefs: [{ nodeId: 'first' }] },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'second' } }
  ] } })
  const { programRevision: _revision, ...snapshot } = program
  program.programRevision = workflowRevision(snapshot)
  const preview = makePlanPreview(program, [], role)
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  return { root, preview, approval }
}
const completed = (request: WorkflowProviderExecutionRequest) => ({ result: Promise.resolve({ runId: request.attemptId, status: 'completed' as const, settled: true, output: request.prompt.startsWith('first') ? 'first-result' : 'second-result' }), stop: () => true })

describe('explicit continuation and epoch fencing', () => {
  it('reuses a durable completed child and dispatches only the unstarted successor, without resetting budget or old frames', async () => {
    const f = await setup(), firstStore = new CutParentStore(f.root), firstEffects = vi.fn(completed)
    const original = new WorkflowRunner({ store: firstStore, execute: firstEffects })
    original.approve(f.preview, f.approval)
    await expect(original.start(f.preview, f.approval)).rejects.toThrow('checkpoint failure')
    expect(firstEffects).toHaveBeenCalledTimes(1)
    const oldRecord = (await firstStore.load(f.preview.workflowId))!
    const rootId = workflowFrameId('root', ['revision:' + f.preview.programRevision])
    const oldFrame = await firstStore.loadFrame(f.preview.workflowId, rootId)
    const store = new FileWorkflowStore(f.root), effects = vi.fn(completed), runner = new WorkflowRunner({ store, execute: effects })
    runner.approve(f.preview, f.approval)
    const resumed = await runner.resume(f.preview, f.approval, 'resume-1')
    expect(resumed.progress.state).toBe('completed')
    expect(resumed.progress.finalReport).toBe('second-result')
    expect(resumed.progress.dispatchAttempts).toBe(2)
    expect(effects).toHaveBeenCalledTimes(1)
    expect(effects.mock.calls[0][0].prompt).toContain('first-result')
    expect(await store.loadFrame(f.preview.workflowId, rootId)).toEqual(oldFrame)
    const saved = (await store.load(f.preview.workflowId))!
    expect(saved.execution?.segments).toHaveLength(2)
    expect(saved.intents).toHaveLength(2)
    await expect(store.save(oldRecord)).rejects.toThrow('旧控制器')
    expect((await runner.resume(f.preview, f.approval, 'resume-1')).state).toBe('continued')
    expect((await runner.resume(f.preview, f.approval, 'resume-done')).state).toBe('nothing_to_resume')
    expect(effects).toHaveBeenCalledTimes(1)
    expect((await store.load(f.preview.workflowId))?.execution?.segments).toHaveLength(2)
  })

  it('reuses a sealed map and its original result references before a new dependent call', async () => {
    const f = await setup([
      { kind: 'map', blockId: 'batch', items: { kind: 'literal', value: [{ key: 'one' }] }, item: 'item', key: ['key'], maxItems: 1, body: { kind: 'call', blockId: 'mapped', role: 'worker', prompt: 'mapped' } },
      { kind: 'collect', blockId: 'rows', items: { kind: 'ref', name: 'batch' } },
      { kind: 'call', blockId: 'summary', role: 'worker', prompt: 'summary', inputRefs: [{ nodeId: 'rows' }] },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'summary' } }
    ])
    const store = new CutParentStore(f.root), original = new WorkflowRunner({ store, execute: completed })
    original.approve(f.preview, f.approval)
    await expect(original.start(f.preview, f.approval)).rejects.toThrow('checkpoint failure')
    const mapId = workflowFrameId('batch', ['revision:' + f.preview.programRevision]), before = (await store.loadFrame(f.preview.workflowId, mapId))!
    const effects = vi.fn(completed), next = new FileWorkflowStore(f.root), runner = new WorkflowRunner({ store: next, execute: effects })
    runner.approve(f.preview, f.approval)
    expect((await runner.resume(f.preview, f.approval, 'map-resume')).progress.state).toBe('completed')
    expect(effects).toHaveBeenCalledTimes(1)
    expect(effects.mock.calls[0][0].prompt).toContain('second-result')
    const record = (await next.load(f.preview.workflowId))!, segment = record.execution!.segments.at(-1)!
    const after = await next.loadFrame(f.preview.workflowId, workflowFrameId('batch', ['revision:' + f.preview.programRevision], segment.generationId))
    expect(after?.resultRef).toEqual(before.resultRef)
  })

  it('does not retry a recorded failure that occurred before Native dispatch', async () => {
    const f = await setup(), store = new FileWorkflowStore(f.root), original = new WorkflowRunner({ store, execute: completed, beforeDispatch: async () => { throw new Error('fixture capability unavailable') } })
    original.approve(f.preview, f.approval)
    expect((await original.start(f.preview, f.approval)).state).toBe('failed')
    expect((await store.load(f.preview.workflowId))?.intents).toHaveLength(0)
    const effects = vi.fn(completed), runner = new WorkflowRunner({ store: new FileWorkflowStore(f.root), execute: effects })
    runner.approve(f.preview, f.approval)
    expect((await runner.resume(f.preview, f.approval, 'resume-no-retry')).progress.state).toBe('failed')
    expect(effects).not.toHaveBeenCalled()
    expect((await store.load(f.preview.workflowId))?.progress.dispatchAttempts).toBe(0)
  })

  it('refuses a changed permission snapshot even with the original revision label', async () => {
    const f = await setup(), store = new CutParentStore(f.root), original = new WorkflowRunner({ store, execute: completed })
    original.approve(f.preview, f.approval)
    await expect(original.start(f.preview, f.approval)).rejects.toThrow('checkpoint failure')
    const changed = structuredClone(f.preview)
    changed.program.roles[0].permissionMode = 'full_access'
    const effects = vi.fn(completed), runner = new WorkflowRunner({ store: new FileWorkflowStore(f.root), execute: effects })
    runner.approve(changed, f.approval)
    await expect(runner.resume(changed, f.approval, 'resume-changed')).rejects.toThrow()
    expect(effects).not.toHaveBeenCalled()
    expect((await store.load(f.preview.workflowId))?.execution?.segments).toHaveLength(1)
  })

  it('atomically admits one continuation and refuses budget reset or a competing claim', async () => {
    const f = await setup(), store = new CutParentStore(f.root), original = new WorkflowRunner({ store, execute: completed })
    original.approve(f.preview, f.approval)
    await expect(original.start(f.preview, f.approval)).rejects.toThrow('checkpoint failure')
    const saved = (await store.load(f.preview.workflowId))!, next = new FileWorkflowStore(f.root)
    const claim = (commandId: string) => {
      const record = structuredClone(saved), id = randomUUID()
      record.execution = { ...record.execution!, epoch: id, owner: { pid: process.pid, instanceId: randomUUID(), state: 'active' }, segments: [...record.execution!.segments, { id, generationId: id, commandId, createdAt: Date.now(), mode: 'continue' }] }
      return record
    }
    const reset = claim('reset')
    reset.progress.dispatchAttempts = 0; reset.intents = []; reset.outcomes = []
    await expect(next.claim(reset, workflowRecordFingerprint(saved))).rejects.toThrow('账本')
    const results = await Promise.allSettled([next.claim(claim('one'), workflowRecordFingerprint(saved)), next.claim(claim('two'), workflowRecordFingerprint(saved))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await next.load(f.preview.workflowId))?.progress.dispatchAttempts).toBe(1)
  })

  it('does not reuse a corrupted immutable output or dispatch another effect', async () => {
    const f = await setup(), store = new CutParentStore(f.root), original = new WorkflowRunner({ store, execute: completed })
    original.approve(f.preview, f.approval)
    await expect(original.start(f.preview, f.approval)).rejects.toThrow('checkpoint failure')
    const old = (await store.load(f.preview.workflowId))!
    await writeFile(join(f.root, 'workflows', old.outcomes[0].outputRef!), '{"output":"wrong"}')
    const effects = vi.fn(completed), runner = new WorkflowRunner({ store: new FileWorkflowStore(f.root), execute: effects })
    runner.approve(f.preview, f.approval)
    await expect(runner.resume(f.preview, f.approval, 'resume-corrupt')).rejects.toThrow('校验失败')
    expect(effects).not.toHaveBeenCalled()
  })

  it('refuses unknown effects even when physical scope closure was reported', async () => {
    const f = await setup(), store = new FileWorkflowStore(f.root), original = new WorkflowRunner({ store, execute: () => ({ result: Promise.resolve({ runId: 'unknown', status: 'unknown', settled: true }), stop: () => true }) })
    original.approve(f.preview, f.approval)
    expect((await original.start(f.preview, f.approval)).state).toBe('unknown')
    const effects = vi.fn(completed), runner = new WorkflowRunner({ store: new FileWorkflowStore(f.root), execute: effects })
    runner.approve(f.preview, f.approval)
    await expect(runner.resume(f.preview, f.approval, 'resume-unknown')).rejects.toThrow('仍未知')
    expect(effects).not.toHaveBeenCalled()
    expect((await store.load(f.preview.workflowId))?.progress.dispatchAttempts).toBe(1)
  })
})
