import { describe, expect, it, vi } from 'vitest'
import { WorkflowSourceApplicationController } from './workflow-source-application'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowSourceApplicationReceipt } from '../shared/workflow-source-application'

const frozen = { argv: ['node', 'check.js'], cwd: '.', timeoutMs: 1000, parser: 'exit_code', executable: '/usr/bin/node', executableHash: 'a'.repeat(64), interpreters: [], launch: { executable: '/usr/bin/node', args: [] }, replicaRoot: '/tmp/candidate', replicaIdentity: { device: 1, inode: 2 }, workingDirectory: '/tmp/candidate', environmentHash: 'b'.repeat(64), repositoryCode: true } as WorkflowFrozenCheck
const target = { workflowId: 'workflow-test', programRevision: 'a'.repeat(64), workflowRevision: 1, stepId: 'step-test', nodeId: 'check-test' }
const request = { operationId: 'apply-1', target, admissionFingerprint: 'admission', workspace: '/tmp/source', candidateWorkspace: '/tmp/candidate', baseHash: 'base', candidateHash: 'candidate', candidateCheck: frozen, sourceCheck: frozen, trustFingerprint: 'trust' }

describe('source workspace application controller', () => {
  it('rejects drift before mutation and never invokes apply', async () => {
    const save = vi.fn(), apply = vi.fn()
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: 'drift', trustFingerprint: 'trust' }), candidateState: async () => ({ hash: 'candidate' }), check: async () => 'passed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'rejected', candidateHash: 'candidate', reason: 'source workspace drifted' })
    expect(apply).not.toHaveBeenCalled()
  })
  it('rejects operationId reuse with a different request fingerprint', async () => {
    const saved: WorkflowSourceApplicationReceipt = { operationId: 'apply-1', target, requestFingerprint: 'a'.repeat(64), admissionFingerprint: 'b'.repeat(64), state: 'unknown', requestedAt: 1, baseHash: 'base', candidateHash: 'candidate', trustFingerprint: 'trust' }
    const controller = new WorkflowSourceApplicationController({ load: async () => saved, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: 'base', trustFingerprint: 'trust' }), candidateState: async () => ({ hash: 'candidate' }), check: async () => 'passed', apply: vi.fn()
    })
    await expect(controller.apply(request)).rejects.toThrow('operationId')
  })
  it('marks a failed post-application check partial because rollback is not verified', async () => {
    const apply = vi.fn(async () => ({ state: 'applied' as const, changedPaths: ['file.txt'] })), sourceStates = ['base', 'base', 'candidate']
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: sourceStates.shift() ?? 'changed', trustFingerprint: 'trust' }), candidateState: async () => ({ hash: 'candidate' }), check: async workspace => workspace === '/tmp/candidate' ? 'passed' : 'failed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'partial', reason: expect.stringContaining('rollback was not verified') })
    expect(apply).toHaveBeenCalledOnce()
  })
  it('marks a passing post-check partial when the check changes admitted source bytes', async () => {
    const states = ['base', 'base', 'candidate', 'check-output'], apply = vi.fn(async () => ({ state: 'applied' as const, changedPaths: ['file.txt'] }))
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: states.shift() ?? 'check-output', trustFingerprint: 'trust' }),
      candidateState: async () => ({ hash: 'candidate' }), check: async () => 'passed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'partial', reason: expect.stringContaining('post-application check changed') })
  })

  it('rejects a candidate that differs from the frozen candidate before validation', async () => {
    const apply = vi.fn()
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: 'base', trustFingerprint: 'trust' }), candidateState: async () => ({ hash: 'different' }), check: async () => 'passed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'rejected', reason: 'candidate differs from frozen candidate' })
    expect(apply).not.toHaveBeenCalled()
  })
  it('rejects a candidate that changes after frozen validation', async () => {
    const apply = vi.fn(), values = ['candidate', 'changed']
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: 'base', trustFingerprint: 'trust' }), candidateState: async () => ({ hash: values.shift() ?? 'changed' }), check: async () => 'passed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'rejected', reason: 'candidate changed before application' })
    expect(apply).not.toHaveBeenCalled()
  })
  it('coalesces concurrent redelivery and rejects a mismatched active operation', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve }), apply = vi.fn(async () => { await barrier; return { state: 'applied' as const, changedPaths: ['file.txt'] } })
    const sourceStates = ['base', 'base', 'candidate']
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: sourceStates.shift() ?? 'candidate', trustFingerprint: 'trust' }),
      candidateState: async () => ({ hash: 'candidate' }), check: async () => 'passed', apply
    })
    const first = controller.apply(request), duplicate = controller.apply(request)
    await expect(controller.apply({ ...request, candidateHash: 'other' })).rejects.toThrow('operationId')
    release()
    const receipt = await first
    expect(await duplicate).toEqual(receipt)
    expect(receipt).not.toHaveProperty('reason')
    expect(apply).toHaveBeenCalledOnce()
  })

  it('serializes distinct operations for the same source workspace', async () => {
    let release!: () => void, entered!: () => void, sourceHash = 'base'
    const barrier = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const apply = vi.fn(async () => { entered(); await barrier; sourceHash = 'candidate'; return { state: 'applied' as const, changedPaths: ['file.txt'] } })
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: sourceHash, trustFingerprint: 'trust' }),
      candidateState: async () => ({ hash: 'candidate' }), check: async () => 'passed', apply
    })
    const first = controller.apply(request)
    await started
    const second = controller.apply({ ...request, operationId: 'apply-2', admissionFingerprint: 'admission-2' })
    release()
    await expect(first).resolves.toMatchObject({ state: 'applied' })
    await expect(second).resolves.toMatchObject({ state: 'rejected', reason: 'source workspace drifted' })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('persists unknown and does not replay after an application error', async () => {
    let receipt: WorkflowSourceApplicationReceipt | undefined
    const save = vi.fn(async value => { receipt = value }), apply = vi.fn(async () => { expect(receipt?.state).toBe('unknown'); throw new Error('lost acknowledgement') })
    const controller = new WorkflowSourceApplicationController({ load: async () => receipt, save }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), sourceState: async () => ({ hash: 'base', trustFingerprint: 'trust' }), candidateState: async () => ({ hash: 'candidate' }), check: async () => 'passed', apply
    })
    const first = await controller.apply(request)
    expect(first.state).toBe('unknown')
    const second = await controller.apply(request)
    expect(second).toEqual(first)
    expect(apply).toHaveBeenCalledOnce()
  })
})
