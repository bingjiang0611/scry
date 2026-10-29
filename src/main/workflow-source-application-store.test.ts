import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowSourceApplicationStore } from './workflow-source-application-store'
import { WorkflowSourceApplicationController } from './workflow-source-application'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowSourceApplicationReceipt } from '../shared/workflow-source-application'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const receipt: WorkflowSourceApplicationReceipt = { operationId: '00000000-0000-4000-8000-000000000001',
  target: { workflowId: 'workflow-test', programRevision: 'f'.repeat(64), workflowRevision: 1, stepId: 'step-test', nodeId: 'check-test' }, requestFingerprint: 'a'.repeat(64), admissionFingerprint: 'b'.repeat(64),
  state: 'unknown', requestedAt: 1, baseHash: 'c'.repeat(64), candidateHash: 'd'.repeat(64), trustFingerprint: 'e'.repeat(64), reason: 'application in progress' }

describe('workflow source application receipt store', () => {
  it('keeps an unknown mutation intent terminal across a cold controller restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-source-receipts-')); roots.push(root)
    const store = new WorkflowSourceApplicationStore(root), apply = vi.fn(async () => { throw new Error('lost acknowledgement') })
    const dependencies = { authorize: async () => ({ trustFingerprint: receipt.trustFingerprint }), sourceState: async () => ({ hash: receipt.baseHash, trustFingerprint: receipt.trustFingerprint }),
      candidateState: async () => ({ hash: receipt.candidateHash }), check: async (): Promise<'passed'> => 'passed', apply }
    const frozen = { argv: ['node'], cwd: '.', timeoutMs: 1000, parser: 'exit_code', executable: '/node', executableHash: 'a'.repeat(64), interpreters: [], launch: { executable: '/node', args: [] },
      replicaRoot: '/candidate', replicaIdentity: { device: 1, inode: 2 }, workingDirectory: '/candidate', environmentHash: 'b'.repeat(64), repositoryCode: true } as WorkflowFrozenCheck
    const request = { operationId: receipt.operationId, target: receipt.target, admissionFingerprint: receipt.admissionFingerprint, workspace: '/source', candidateWorkspace: '/candidate',
      baseHash: receipt.baseHash, candidateHash: receipt.candidateHash, candidateCheck: frozen, sourceCheck: frozen, trustFingerprint: receipt.trustFingerprint }
    const first = await new WorkflowSourceApplicationController(store, dependencies).apply(request)
    expect(first.state).toBe('unknown')
    await expect(new WorkflowSourceApplicationController(store, dependencies).apply(request)).resolves.toEqual(first)
    expect(apply).toHaveBeenCalledOnce()
  })

  it('survives a cold read and fails closed on corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-source-receipts-')); roots.push(root)
    await new WorkflowSourceApplicationStore(root).save(receipt)
    expect(await new WorkflowSourceApplicationStore(root).load(receipt.operationId)).toEqual(receipt)
    expect(await new WorkflowSourceApplicationStore(root).list(receipt.target.workflowId, receipt.target.programRevision)).toEqual([receipt])
    await writeFile(join(root, 'workflow-source-applications-v1', `${receipt.operationId}.json`), '{')
    await expect(new WorkflowSourceApplicationStore(root).load(receipt.operationId)).rejects.toThrow()
  })
})
