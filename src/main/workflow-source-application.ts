import { createHash } from 'node:crypto'
import { workflowSourceSnapshot } from './source-control/apply-workflow-candidate'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowSourceApplicationReceipt, WorkflowSourceApplicationTarget } from '../shared/workflow-source-application'

export type WorkflowSourceApplicationRequest = Readonly<{
  operationId: string
  target: WorkflowSourceApplicationTarget
  admissionFingerprint: string
  workspace: string
  candidateWorkspace: string
  baseHash: string
  candidateHash: string
  candidateCheck: WorkflowFrozenCheck
  sourceCheck: WorkflowFrozenCheck
  trustFingerprint: string
}>
type SourceState = Readonly<{ hash: string; trustFingerprint: string }>
type CandidateState = Readonly<{ hash: string }>
type Persistence = { load: (operationId: string) => Promise<WorkflowSourceApplicationReceipt | undefined>; save: (receipt: WorkflowSourceApplicationReceipt) => Promise<void> }
type Dependencies = {
  authorize: (workspace: string) => Promise<{ trustFingerprint: string }>
  sourceState: (workspace: string) => Promise<SourceState>
  candidateState: (workspace: string) => Promise<CandidateState>
  check: (workspace: string, frozen: WorkflowFrozenCheck) => Promise<'passed' | 'failed' | 'unknown'>
  conflict?: (workspace: string, candidateWorkspace: string) => Promise<boolean>
  apply: (workspace: string, candidateWorkspace: string, expectedBaseHash: string, expectedCandidateHash: string, expectedTrustFingerprint: string) => Promise<{ state: 'applied' | 'partial' | 'rejected'; changedPaths: string[]; reason?: string }>
}

export async function sourceWorkspaceHash(root: string): Promise<string> {
  return (await workflowSourceSnapshot(root)).hash
}

function requestFingerprint(request: WorkflowSourceApplicationRequest): string {
  return createHash('sha256').update(JSON.stringify({ operationId: request.operationId, workspace: request.workspace, candidateWorkspace: request.candidateWorkspace,
    target: request.target, admissionFingerprint: request.admissionFingerprint, baseHash: request.baseHash, candidateHash: request.candidateHash,
    candidateCheck: request.candidateCheck, sourceCheck: request.sourceCheck, trustFingerprint: request.trustFingerprint })).digest('hex')
}

/** Main-owned source mutation. Unknown receipts are terminal: callers must not
 * replay because the process may have changed the workspace before its reply was lost. */
export class WorkflowSourceApplicationController {
  private readonly pending = new Map<string, { fingerprint: string; result: Promise<WorkflowSourceApplicationReceipt> }>()
  private readonly workspaceTails = new Map<string, Promise<void>>()
  constructor(private readonly persistence: Persistence, private readonly dependencies: Dependencies, private readonly now = Date.now) {}

  async apply(request: WorkflowSourceApplicationRequest): Promise<WorkflowSourceApplicationReceipt> {
    const fingerprint = requestFingerprint(request), active = this.pending.get(request.operationId)
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Error('source application operationId 已用于其他请求')
      return active.result
    }
    const result = this.serializeWorkspace(request.workspace, () => this.execute(request, fingerprint))
    this.pending.set(request.operationId, { fingerprint, result })
    try { return await result } finally { if (this.pending.get(request.operationId)?.result === result) this.pending.delete(request.operationId) }
  }

  private async serializeWorkspace<T>(workspace: string, task: () => Promise<T>): Promise<T> {
    const previous = this.workspaceTails.get(workspace) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), tail = previous.catch(() => {}).then(() => gate)
    this.workspaceTails.set(workspace, tail)
    await previous.catch(() => {})
    try { return await task() }
    finally { release(); if (this.workspaceTails.get(workspace) === tail) this.workspaceTails.delete(workspace) }
  }

  private async execute(request: WorkflowSourceApplicationRequest, fingerprint: string): Promise<WorkflowSourceApplicationReceipt> {
    const prior = await this.persistence.load(request.operationId)
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw new Error('source application operationId 已用于其他请求')
      return prior
    }
    const requestedAt = this.now()
    const authority = await this.dependencies.authorize(request.workspace)
    if (authority.trustFingerprint !== request.trustFingerprint) return this.reject(request, requestedAt, fingerprint, 'workspace authority changed')
    const before = await this.dependencies.sourceState(request.workspace)
    const candidate = await this.dependencies.candidateState(request.candidateWorkspace)
    if (before.trustFingerprint !== request.trustFingerprint) return this.reject(request, requestedAt, fingerprint, 'workspace authority changed')
    if (before.hash !== request.baseHash) return this.reject(request, requestedAt, fingerprint, 'source workspace drifted')
    if (candidate.hash !== request.candidateHash) return this.reject(request, requestedAt, fingerprint, 'candidate differs from frozen candidate')
    if (candidate.hash === request.baseHash) return this.reject(request, requestedAt, fingerprint, 'candidate has no changes')
    if (await this.dependencies.conflict?.(request.workspace, request.candidateWorkspace)) return this.reject(request, requestedAt, fingerprint, 'workspace conflict detected')
    const candidateCheck = await this.dependencies.check(request.candidateWorkspace, request.candidateCheck)
    if (candidateCheck !== 'passed') return this.reject(request, requestedAt, fingerprint, `candidate check ${candidateCheck}`)
    // Re-read the candidate immediately before mutation. The earlier check is
    // evidence for admission; it is not a lock on the candidate workspace.
    const candidateBeforeApply = await this.dependencies.candidateState(request.candidateWorkspace)
    const sourceBeforeApply = await this.dependencies.sourceState(request.workspace)
    if (candidateBeforeApply.hash !== request.candidateHash || candidateBeforeApply.hash !== candidate.hash) return this.reject(request, requestedAt, fingerprint, 'candidate changed before application')
    if (sourceBeforeApply.hash !== request.baseHash || sourceBeforeApply.trustFingerprint !== request.trustFingerprint) return this.reject(request, requestedAt, fingerprint, 'source changed before application')
    const intent: WorkflowSourceApplicationReceipt = { operationId: request.operationId, target: request.target, requestFingerprint: fingerprint, admissionFingerprint: request.admissionFingerprint, state: 'unknown', requestedAt, baseHash: request.baseHash, candidateHash: request.candidateHash, trustFingerprint: request.trustFingerprint, reason: 'application in progress' }
    await this.persistence.save(intent)
    try {
      const applied = await this.dependencies.apply(request.workspace, request.candidateWorkspace, request.baseHash, request.candidateHash, request.trustFingerprint)
      if (applied.state === 'rejected') return this.finish({ ...intent, state: 'rejected', changedPaths: applied.changedPaths, reason: applied.reason ?? 'source or candidate changed before mutation' })
      const after = await this.dependencies.sourceState(request.workspace)
      if (after.hash === request.baseHash) return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: 'application made no observed change' })
      if (after.hash !== intent.candidateHash) return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: 'applied source differs from the admitted candidate' })
      if (applied.state === 'partial') return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: applied.reason ?? 'candidate application was partial' })
      const finalCheck = await this.dependencies.check(request.workspace, request.sourceCheck)
      if (finalCheck !== 'passed') return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: `post-application check ${finalCheck}; rollback was not verified` })
      const afterCheck = await this.dependencies.sourceState(request.workspace)
      if (afterCheck.hash !== intent.candidateHash || afterCheck.trustFingerprint !== intent.trustFingerprint) return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: 'post-application check changed the admitted source state; rollback was not verified' })
      const receipt = { ...intent, state: 'applied' as const, changedPaths: applied.changedPaths }
      delete receipt.reason
      return this.finish(receipt)
    } catch (error) {
      return this.finish({ ...intent, state: 'unknown', reason: String(error) })
    }
  }

  private async reject(request: WorkflowSourceApplicationRequest, requestedAt: number, requestFingerprint: string, reason: string): Promise<WorkflowSourceApplicationReceipt> {
    return this.finish({ operationId: request.operationId, target: request.target, requestFingerprint, admissionFingerprint: request.admissionFingerprint, state: 'rejected', requestedAt, baseHash: request.baseHash, candidateHash: request.candidateHash, trustFingerprint: request.trustFingerprint, reason })
  }
  private async finish(receipt: WorkflowSourceApplicationReceipt): Promise<WorkflowSourceApplicationReceipt> {
    await this.persistence.save(receipt)
    return receipt
  }
}
