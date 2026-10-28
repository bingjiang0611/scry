import { describe, expect, it, vi } from 'vitest'
import { WorkflowSourceApplicationController, type WorkflowSourceApplicationReceipt } from './workflow-source-application'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'

const frozen = { argv: ['node', 'check.js'], cwd: '.', timeoutMs: 1000, parser: 'exit_code', executable: '/usr/bin/node', executableHash: 'a'.repeat(64), interpreters: [], launch: { executable: '/usr/bin/node', args: [] }, replicaRoot: '/tmp/candidate', replicaIdentity: { device: 1, inode: 2 }, workingDirectory: '/tmp/candidate', environmentHash: 'b'.repeat(64), repositoryCode: true } as WorkflowFrozenCheck
const request = { operationId: 'apply-1', workspace: '/tmp/source', candidateWorkspace: '/tmp/candidate', baseHash: 'base', candidateHash: 'candidate', frozenCheck: frozen, trustFingerprint: 'trust' }

describe('source workspace application controller', () => {
  it('rejects drift before mutation and never invokes apply', async () => {
    const save = vi.fn(), apply = vi.fn()
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), state: async workspace => ({ hash: workspace === '/tmp/source' ? 'drift' : 'candidate', trustFingerprint: 'trust' }), check: async () => 'passed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'rejected', reason: 'source workspace drifted' })
    expect(apply).not.toHaveBeenCalled()
  })
  it('rejects operationId reuse with a different request fingerprint', async () => {
    const saved: WorkflowSourceApplicationReceipt = { operationId: 'apply-1', requestFingerprint: 'a'.repeat(64), state: 'unknown', requestedAt: 1, baseHash: 'base', candidateHash: 'candidate', trustFingerprint: 'trust' }
    const controller = new WorkflowSourceApplicationController({ load: async () => saved, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), state: async () => ({ hash: 'base', trustFingerprint: 'trust' }), check: async () => 'passed', apply: vi.fn()
    })
    await expect(controller.apply(request)).rejects.toThrow('operationId')
  })
  it('marks a failed post-application check partial because rollback is not verified', async () => {
    const apply = vi.fn(async () => ({ state: 'applied' as const, changedPaths: ['file.txt'] })), sourceStates = ['base', 'candidate']
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), state: async workspace => ({ hash: workspace === '/tmp/candidate' ? 'candidate' : sourceStates.shift() ?? 'changed', trustFingerprint: 'trust' }), check: async workspace => workspace === '/tmp/candidate' ? 'passed' : 'failed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'partial', reason: expect.stringContaining('rollback was not verified') })
    expect(apply).toHaveBeenCalledOnce()
  })
  it('rejects a candidate that differs from the frozen candidate before validation', async () => {
    const apply = vi.fn()
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), state: async workspace => ({ hash: workspace === '/tmp/source' ? 'base' : 'different', trustFingerprint: 'trust' }), check: async () => 'passed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'rejected', reason: 'candidate differs from frozen candidate' })
    expect(apply).not.toHaveBeenCalled()
  })
  it('rejects a candidate that changes after frozen validation', async () => {
    const apply = vi.fn(), values = ['candidate', 'changed']
    const controller = new WorkflowSourceApplicationController({ load: async () => undefined, save: vi.fn() }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), state: async workspace => ({ hash: workspace === '/tmp/source' ? 'base' : values.shift() ?? 'changed', trustFingerprint: 'trust' }), check: async () => 'passed', apply
    })
    await expect(controller.apply(request)).resolves.toMatchObject({ state: 'rejected', reason: 'candidate changed before application' })
    expect(apply).not.toHaveBeenCalled()
  })
  it('persists unknown and does not replay after an application error', async () => {
    let receipt: WorkflowSourceApplicationReceipt | undefined
    const save = vi.fn(async value => { receipt = value }), apply = vi.fn(async () => { throw new Error('lost acknowledgement') })
    const controller = new WorkflowSourceApplicationController({ load: async () => receipt, save }, {
      authorize: async () => ({ trustFingerprint: 'trust' }), state: async workspace => ({ hash: workspace === '/tmp/source' ? 'base' : 'candidate', trustFingerprint: 'trust' }), check: async () => 'passed', apply
    })
    const first = await controller.apply(request)
    expect(first.state).toBe('unknown')
    const second = await controller.apply(request)
    expect(second).toEqual(first)
    expect(apply).toHaveBeenCalledOnce()
  })
})
